import json
import logging
import os
import threading
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException, Request as HttpRequest
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

CREDENTIALS_PATH = os.environ.get("CREDENTIALS_PATH", "/app/config/token.json")
CALENDAR_IDS_RAW = os.environ.get("CALENDAR_IDS", "")
CALENDAR_COLORS_RAW = os.environ.get("CALENDAR_COLORS", "{}")
CACHE_TTL_SECONDS = int(os.environ.get("CACHE_TTL_SECONDS", "300"))
LOOKAHEAD_DAYS = int(os.environ.get("LOOKAHEAD_DAYS", "90"))
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "365"))
TIMEZONE = os.environ.get("TIMEZONE", "America/New_York")
PORT = int(os.environ.get("PORT", "8000"))
INDEX_PATH = os.environ.get("INDEX_PATH", "/app/index.html")
# Stamped into /api/state so an already-open wallboard can detect a new build
# and reload itself. A long-running display tab otherwise keeps running the
# JavaScript it was loaded with, and new UI features look like they're missing.
APP_VERSION = "0.4.1"

CALENDAR_IDS = [c.strip() for c in CALENDAR_IDS_RAW.split(",") if c.strip()]
CALENDAR_COLORS = json.loads(CALENDAR_COLORS_RAW)

# Friendly names for attendees, e.g. {"someone@example.com": "Tina"}. Configured
# per-deployment so no personal addresses are baked into the app source.
ATTENDEE_ALIASES_RAW = os.environ.get("ATTENDEE_ALIASES", "{}")
try:
    ATTENDEE_ALIASES = {str(k).strip().lower(): str(v).strip()
                        for k, v in json.loads(ATTENDEE_ALIASES_RAW).items()}
except Exception:
    logger.warning("ATTENDEE_ALIASES is not valid JSON; ignoring it")
    ATTENDEE_ALIASES = {}

# Scopes that permit mutating calendars (moving events).
WRITE_SCOPES = (
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/calendar.events",
)
# Fallback palette for calendars without an explicit CALENDAR_COLORS entry.
PALETTE = ["#4285F4", "#EA4335", "#FBBC05", "#34A853", "#9C27B0", "#00BCD4", "#FF7043", "#7CB342"]

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("wallboard starting, credentials=%s", CREDENTIALS_PATH)
    try:
        sync()
    except Exception as e:
        logger.exception("startup discovery failed")
    threading.Thread(target=sync_loop, daemon=True).start()
    yield

app = FastAPI(title="wallboard", lifespan=lifespan)

# In-memory state, guarded by a lock
state = {
    "calendars": {},
    "calendar_list": [],
    "events": [],
    "timezone": TIMEZONE,
    "can_write": False,
    "last_sync": None,
    "sync_status": "never",
    "error": None,
}
_lock = threading.Lock()
_stop = threading.Event()


def load_credentials():
    if not os.path.exists(CREDENTIALS_PATH):
        raise FileNotFoundError(f"Credentials file not found: {CREDENTIALS_PATH}")
    # No scopes override: honour whatever the stored token actually grants so
    # the app adapts automatically after a re-auth widens the scopes.
    return Credentials.from_authorized_user_file(CREDENTIALS_PATH)


def token_scopes():
    try:
        with open(CREDENTIALS_PATH) as f:
            return json.load(f).get("scopes") or []
    except Exception:
        return []


def has_write_scope():
    return any(s in WRITE_SCOPES for s in token_scopes())


def get_calendar_service():
    creds = load_credentials()
    if not creds.valid:
        if creds.expired and creds.refresh_token:
            logger.info("refreshing expired credentials")
            creds.refresh(Request())
        else:
            raise ValueError("Invalid credentials and cannot refresh")
    return build("calendar", "v3", credentials=creds)


def format_event_start(start, tz):
    """Return a display-ready local timestamp for an event start.

    Timed events keep their full local ISO string (offset applied); all-day
    events collapse to 'YYYY-MM-DD' with all_day=True.
    """
    dt = start.get("dateTime")
    if dt:
        parsed = datetime.fromisoformat(dt)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=ZoneInfo("UTC"))
        local = parsed.astimezone(tz)
        return {"iso": dt, "local": local.isoformat(), "all_day": False}
    return {"iso": start.get("date", ""), "local": start.get("date", ""), "all_day": True}


def clean_text(text, limit=1000):
    if not text:
        return ""
    return " ".join(str(text).split())[:limit]


def format_attendees(item):
    out = []
    for a in item.get("attendees", []) or []:
        email = (a.get("email") or "").strip()
        out.append({
            "name": ATTENDEE_ALIASES.get(email.lower()) or a.get("displayName") or email,
            "email": email,
            "status": a.get("responseStatus", ""),
        })
    return out


def sync():
    """Fetch calendars + events and update state. Called at startup and on a timer."""
    try:
        service = get_calendar_service()
        cal_list = service.calendarList().list().execute()
        calendars = cal_list.get("items", [])

        tz = ZoneInfo(TIMEZONE)
        now = datetime.now(tz)
        time_min = (now - timedelta(days=LOOKBACK_DAYS)).isoformat()
        time_max = (now + timedelta(days=LOOKAHEAD_DAYS)).isoformat()

        cal_items = {c["id"]: c for c in calendars}
        ids = CALENDAR_IDS or list(cal_items.keys())
        display_map = {cid: cal_items.get(cid, {}).get("summary", cid) for cid in ids}
        calendar_list = []
        for i, cid in enumerate(ids):
            item = cal_items.get(cid, {})
            role = item.get("accessRole", "reader")
            calendar_list.append({
                "id": cid,
                "summary": item.get("summary", cid),
                "color": CALENDAR_COLORS.get(cid, PALETTE[i % len(PALETTE)]),
                "writable": role in ("writer", "owner"),
            })
        color_for = {c["id"]: c["color"] for c in calendar_list}
        events = []
        for cal_id in ids:
            try:
                result = service.events().list(
                    calendarId=cal_id,
                    timeMin=time_min,
                    timeMax=time_max,
                    singleEvents=True,
                    orderBy="startTime",
                    maxResults=2500,
                ).execute()
            except Exception as e:
                logger.warning("failed to fetch events for %s: %s", cal_id, e)
                continue
            for item in result.get("items", []):
                events.append({
                    "id": item.get("id"),
                    "summary": item.get("summary", "(no title)"),
                    "calendar_id": cal_id,
                    "calendar": display_map.get(cal_id, cal_id),
                    "color": color_for.get(cal_id, "#8888ff"),
                    "start": format_event_start(item.get("start", {}), tz),
                    "end": format_event_start(item.get("end", {}), tz),
                    "location": clean_text(item.get("location", ""), 300),
                    "description": clean_text(item.get("description", "")),
                    "attendees": format_attendees(item),
                    "link": item.get("htmlLink", ""),
                })

        events.sort(key=lambda e: e["start"]["local"] or e["start"]["iso"])
        with _lock:
            state["calendars"] = display_map
            state["calendar_list"] = calendar_list
            state["events"] = events
            state["can_write"] = has_write_scope()
            state["last_sync"] = datetime.now(timezone.utc).isoformat()
            state["sync_status"] = "ok"
            state["error"] = None
        logger.info("sync ok: %d events from %d calendars (can_write=%s)",
                    len(events), len(ids), state["can_write"])
    except Exception as e:
        logger.error("sync failed: %s", e)
        with _lock:
            state["sync_status"] = "error"
            state["error"] = str(e)


def sync_loop():
    while not _stop.wait(CACHE_TTL_SECONDS):
        sync()


@app.get("/")
async def index():
    return FileResponse(INDEX_PATH, media_type="text/html")


@app.get("/health")
@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


@app.get("/api/state")
async def api_state(request: HttpRequest):
    with _lock:
        payload = {
            "calendars": dict(state["calendars"]),
            "calendar_list": list(state["calendar_list"]),
            "events": list(state["events"]),
            "timezone": state["timezone"],
            "can_write": state["can_write"],
            "version": APP_VERSION,
            "last_sync": state["last_sync"],
            "sync_status": state["sync_status"],
            "error": state["error"],
        }
        # With a year of history the payload is a few hundred KB and the client
        # polls often, but the data only changes when a sync runs. Key the ETag on
        # last_sync so unchanged polls cost a 304 instead of the whole body.
        etag = f'"{payload["last_sync"]}"'
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers={"ETag": etag})
    return JSONResponse(payload, headers={"ETag": etag})


class MovePayload(BaseModel):
    event_id: str
    from_calendar: str
    to_calendar: str


@app.post("/api/events/move")
async def move_event(payload: MovePayload):
    """Move an event to another (displayed) calendar via events.move.

    Requires a write-scoped token; the UI only offers this when can_write.
    """
    with _lock:
        allowed = set(state["calendars"].keys())
        can_write = state["can_write"]
    if not can_write:
        raise HTTPException(
            status_code=403,
            detail="Calendar write access not granted. Re-authorize with the "
                   "calendar scope to enable moving events.",
        )
    if payload.from_calendar not in allowed or payload.to_calendar not in allowed:
        raise HTTPException(status_code=400, detail="Calendar is not displayed/known to this app.")
    if payload.from_calendar == payload.to_calendar:
        return {"status": "noop"}

    try:
        service = get_calendar_service()
        service.events().move(
            calendarId=payload.from_calendar,
            eventId=payload.event_id,
            destination=payload.to_calendar,
        ).execute()
    except HttpError as e:
        # Surface Google's own status so the UI can explain the failure
        # (404 = event gone, 403 = no write access to that calendar, etc).
        code = getattr(getattr(e, "resp", None), "status", 502)
        status = code if code in (400, 403, 404, 409) else 502
        logger.error("move failed for %s (google %s): %s", payload.event_id, code, e)
        raise HTTPException(status_code=status, detail=f"Move failed: {e}")
    except Exception as e:
        logger.error("move failed for %s: %s", payload.event_id, e)
        raise HTTPException(status_code=502, detail=f"Move failed: {e}")

    logger.info("moved event %s from %s to %s", payload.event_id,
                payload.from_calendar, payload.to_calendar)
    # Refresh in the background so the UI reflects the change promptly.
    threading.Thread(target=sync, daemon=True).start()
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)