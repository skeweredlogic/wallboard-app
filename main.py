import json
import logging
import os
import threading
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import FastAPI
from fastapi.responses import FileResponse
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

CREDENTIALS_PATH = os.environ.get("CREDENTIALS_PATH", "/app/config/token.json")
CALENDAR_IDS_RAW = os.environ.get("CALENDAR_IDS", "")
CALENDAR_COLORS_RAW = os.environ.get("CALENDAR_COLORS", "{}")
CACHE_TTL_SECONDS = int(os.environ.get("CACHE_TTL_SECONDS", "300"))
LOOKAHEAD_DAYS = int(os.environ.get("LOOKAHEAD_DAYS", "14"))
TIMEZONE = os.environ.get("TIMEZONE", "America/New_York")
PORT = int(os.environ.get("PORT", "8000"))
INDEX_PATH = os.environ.get("INDEX_PATH", "/app/index.html")

CALENDAR_IDS = [c.strip() for c in CALENDAR_IDS_RAW.split(",") if c.strip()]
CALENDAR_COLORS = json.loads(CALENDAR_COLORS_RAW)

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
    "events": [],
    "timezone": TIMEZONE,
    "last_sync": None,
    "sync_status": "never",
    "error": None,
}
_lock = threading.Lock()
_stop = threading.Event()


def load_credentials():
    if not os.path.exists(CREDENTIALS_PATH):
        raise FileNotFoundError(f"Credentials file not found: {CREDENTIALS_PATH}")
    return Credentials.from_authorized_user_file(
        CREDENTIALS_PATH,
        scopes=["https://www.googleapis.com/auth/calendar.readonly"],
    )


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


def sync():
    """Fetch calendars + events and update state. Called at startup and on a timer."""
    try:
        service = get_calendar_service()
        cal_list = service.calendarList().list().execute()
        calendars = cal_list.get("items", [])
        cal_map = {c["id"]: c.get("summary", "?") for c in calendars}

        tz = ZoneInfo(TIMEZONE)
        now = datetime.now(tz)
        time_min = now.isoformat()
        time_max = (now + timedelta(days=LOOKAHEAD_DAYS)).isoformat()

        ids = CALENDAR_IDS or list(cal_map.keys())
        events = []
        for cal_id in ids:
            try:
                result = service.events().list(
                    calendarId=cal_id,
                    timeMin=time_min,
                    timeMax=time_max,
                    singleEvents=True,
                    orderBy="startTime",
                    maxResults=100,
                ).execute()
            except Exception as e:
                logger.warning("failed to fetch events for %s: %s", cal_id, e)
                continue
            for item in result.get("items", []):
                events.append({
                    "id": item.get("id"),
                    "summary": item.get("summary", "(no title)"),
                    "calendar_id": cal_id,
                    "calendar": cal_map.get(cal_id, cal_id),
                    "color": CALENDAR_COLORS.get(cal_id, "#8888ff"),
                    "start": format_event_start(item.get("start", {}), tz),
                    "location": item.get("location", ""),
                    "link": item.get("htmlLink", ""),
                })

        events.sort(key=lambda e: e["start"]["local"] or e["start"]["iso"])
        with _lock:
            state["calendars"] = cal_map
            state["events"] = events
            state["last_sync"] = datetime.now(timezone.utc).isoformat()
            state["sync_status"] = "ok"
            state["error"] = None
        logger.info("sync ok: %d events from %d calendars", len(events), len(ids))
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
async def api_state():
    with _lock:
        return {
            "calendars": dict(state["calendars"]),
            "events": list(state["events"]),
            "timezone": state["timezone"],
            "last_sync": state["last_sync"],
            "sync_status": state["sync_status"],
            "error": state["error"],
        }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)