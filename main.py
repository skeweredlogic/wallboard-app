import json
import logging
import os
import threading
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException, Request as HttpRequest
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field
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
APP_VERSION = "0.5.4"

CALENDAR_IDS = [c.strip() for c in CALENDAR_IDS_RAW.split(",") if c.strip()]
CALENDAR_COLORS = json.loads(CALENDAR_COLORS_RAW)

# --- Google Tasks panel -----------------------------------------------------
# The task list the wallboard displays. Named rather than pinned to an id so a
# recreated list (or a fresh account) keeps working without a redeploy.
TASKS_LIST_NAME = os.environ.get("TASKS_LIST_NAME", "Wallboard")
# Only incomplete tasks are shown; a wallboard is a "what's outstanding" surface.
TASKS_MAX_ITEMS = int(os.environ.get("TASKS_MAX_ITEMS", "50"))
TASKS_SCOPE = "https://www.googleapis.com/auth/tasks"

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
    "tasks": [],
    "tasks_list": TASKS_LIST_NAME,
    # "ok" | "unavailable" (token lacks the scope) | "missing" (no such list)
    # | "error". Only "ok" guarantees tasks is populated; the panel degrades to
    # an explanatory state rather than a blank screen.
    "tasks_status": "never",
    "tasks_error": None,
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


def get_valid_credentials():
    creds = load_credentials()
    if not creds.valid:
        if creds.expired and creds.refresh_token:
            logger.info("refreshing expired credentials")
            creds.refresh(Request())
        else:
            raise ValueError("Invalid credentials and cannot refresh")
    return creds


def get_calendar_service():
    return build("calendar", "v3", credentials=get_valid_credentials())


def has_tasks_scope():
    return TASKS_SCOPE in token_scopes()


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


def _tasks_request(method, path, body=None, params=None):
    """Make a raw HTTP request to the Google Tasks API.

    Tasks has no service-account support, so we reuse the same user OAuth
    token that the wallboard already has for Calendar. Query arguments go in
    the URL via `params`; a JSON body is only ever attached to a write method.
    Returns the parsed JSON on success; on HTTP error raises RuntimeError.
    """
    import urllib.error
    import urllib.parse
    import urllib.request

    creds = get_valid_credentials()
    url = f"https://tasks.googleapis.com/tasks/v1/{path.lstrip('/')}"
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    data = None
    headers = {
        "Authorization": f"Bearer {creds.token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if body is not None:
        # The Tasks API rejects a GET that carries a body with a bare "400"
        # and an empty message, which is miserable to debug from a wall display.
        # Fail loudly here instead, naming the real mistake.
        if method.upper() not in ("POST", "PATCH", "PUT"):
            raise ValueError(f"{method} takes no body; pass query args as params=")
        data = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        try:
            err = json.load(e).get("error", {})
            msg = err.get("message", "") or err.get("errors", [{}])[0].get("message", "")
        except Exception:
            msg = e.read().decode()[:200]
        raise RuntimeError(f"tasks api {e.code}: {msg}") from e


def fetch_tasks():
    """Return (tasks, status, error) for the configured task list.

    Never raises: a missing scope or list must not take down the calendar half of
    the wallboard, so failures are reported as a status the UI can explain.
    """
    if not has_tasks_scope():
        return [], "unavailable", (
            f"token is missing the {TASKS_SCOPE} scope; re-run "
            "scripts/generate_token.py --force to add it"
        )

    try:
        lists_body = _tasks_request("GET", "users/@me/lists", params={"maxResults": 100})
    except Exception as e:
        return [], "error", str(e)

    match = next((l for l in lists_body.get("items", [])
                  if (l.get("title") or "").strip().lower() == TASKS_LIST_NAME.strip().lower()), None)
    if not match:
        return [], "missing", f'no task list named "{TASKS_LIST_NAME}"'

    try:
        body = _tasks_request("GET", f"lists/{match['id']}/tasks", params={
            "maxResults": TASKS_MAX_ITEMS,
            "showCompleted": "false",
            "showHidden": "false",
        })
    except Exception as e:
        return [], "error", str(e)

    tasks = []
    for item in body.get("items", []):
        if item.get("status") == "completed":
            continue
        tasks.append({
            "id": item.get("id"),
            "title": clean_text(item.get("title", "") or "(no title)", 300),
            "notes": clean_text(item.get("notes", ""), 1000),
            "due": item.get("due", "")[:10] or None,  # RFC3339 date-only for tasks
            "has_subtasks": bool(item.get("subtasks")),
            "parent": item.get("parent"),
            "position": item.get("position", ""),
            "link": item.get("selfLink", ""),
        })

    # Undated tasks first (nothing to sort by), then soonest due, then Google's
    # own ordering string so the display is stable between syncs.
    def sort_key(t):
        return (t["due"] is not None, t["due"] or "9999-12-31", t["position"])

    tasks.sort(key=sort_key)
    return tasks, "ok", None


def create_task(title):
    """Create an incomplete task in the configured list.

    Returns the created task dict on success; on failure raises RuntimeError.
    """
    if not has_tasks_scope():
        raise RuntimeError(f"missing {TASKS_SCOPE} scope")
    lists_body = _tasks_request("GET", "users/@me/lists", params={"maxResults": 100})
    match = next((l for l in lists_body.get("items", [])
                  if (l.get("title") or "").strip().lower() == TASKS_LIST_NAME.strip().lower()), None)
    if not match:
        raise RuntimeError(f'task list "{TASKS_LIST_NAME}" not found')
    task_body = _tasks_request(
        "POST",
        f"lists/{match['id']}/tasks",
        {"title": title}
    )
    return {
        "id": task_body.get("id"),
        "title": clean_text(task_body.get("title", ""), 300),
        "notes": clean_text(task_body.get("notes", ""), 1000),
        "due": task_body.get("due", "")[:10] or None,
        "has_subtasks": bool(task_body.get("subtasks")),
        "parent": task_body.get("parent"),
        "position": task_body.get("position", ""),
        "link": task_body.get("selfLink", ""),
    }


def update_task_status(task_id, status):
    """Set a task's status (completed or needsAction) in the configured list.

    Returns the updated task dict on success; on failure raises RuntimeError.
    """
    if not has_tasks_scope():
        raise RuntimeError(f"missing {TASKS_SCOPE} scope")
    # First we need to know which list the task belongs to (for the URL).
    # Tasks don't expose their parent list directly, so we look it up.
    lists_body = _tasks_request("GET", "users/@me/lists", params={"maxResults": 100})
    match = next((l for l in lists_body.get("items", [])
                  if (l.get("title") or "").strip().lower() == TASKS_LIST_NAME.strip().lower()), None)
    if not match:
        raise RuntimeError(f'task list "{TASKS_LIST_NAME}" not found')
    updated = _tasks_request(
        "PATCH",
        f"lists/{match['id']}/tasks/{task_id}",
        {"status": status}
    )
    return {
        "id": updated.get("id"),
        "title": clean_text(updated.get("title", ""), 300),
        "notes": clean_text(updated.get("notes", ""), 1000),
        "due": updated.get("due", "")[:10] or None,
        "has_subtasks": bool(updated.get("subtasks")),
        "parent": updated.get("parent"),
        "position": updated.get("position", ""),
        "link": updated.get("selfLink", ""),
    }


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

        # Tasks are fetched separately and independently: a Tasks failure must
        # never discard a good calendar payload.
        tasks, tasks_status, tasks_error = fetch_tasks()

        with _lock:
            state["calendars"] = display_map
            state["calendar_list"] = calendar_list
            state["events"] = events
            state["tasks"] = tasks
            state["tasks_status"] = tasks_status
            state["tasks_error"] = tasks_error
            state["can_write"] = has_write_scope()
            state["last_sync"] = datetime.now(timezone.utc).isoformat()
            state["sync_status"] = "ok"
            state["error"] = None
        logger.info("sync ok: %d events from %d calendars (can_write=%s), "
                    "%d tasks (tasks_status=%s)",
                    len(events), len(ids), state["can_write"],
                    len(tasks), tasks_status)
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
            "tasks": list(state["tasks"]),
            "tasks_list": state["tasks_list"],
            "tasks_status": state["tasks_status"],
            "tasks_error": state["tasks_error"],
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


# --- Google Calendar create ---------------------------------------------------
# Creates a real event on a real shared calendar, so this is the endpoint where a
# bug is visible to the whole household rather than just to this display. Every
# input is validated here rather than trusted from the form.
class CreateEventPayload(BaseModel):
    title: str
    date: str                                   # YYYY-MM-DD, wall-local
    start_time: Optional[str] = None            # HH:MM, wall-local
    end_time: Optional[str] = None              # HH:MM, wall-local
    all_day: bool = False
    description: Optional[str] = None
    calendar_id: Optional[str] = None


def _hhmm(value, field):
    """Validate an HH:MM string and return it zero-padded, or raise 400."""
    if value is None or not str(value).strip():
        raise HTTPException(status_code=400, detail=f"{field} is required.")
    v = str(value).strip()
    try:
        hh, mm = v.split(":")
        hh, mm = int(hh), int(mm)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{field} must look like 14:30.")
    if not (0 <= hh <= 23 and 0 <= mm <= 59):
        raise HTTPException(status_code=400, detail=f"{field} must be a real time of day.")
    return f"{hh:02d}:{mm:02d}"


@app.post("/api/events")
async def create_event(payload: CreateEventPayload):
    """Create an event on a displayed, writable calendar.

    The wall becomes a capture surface for the calendar, not just a viewer.
    """
    with _lock:
        can_write = state["can_write"]
        allowed = set(state["calendars"].keys())
        writable = {c["id"] for c in state["calendar_list"] if c.get("writable")}

    if not can_write:
        raise HTTPException(
            status_code=403,
            detail="Calendar write access not granted. Re-authorize the wallboard "
                   "token with a write calendar scope to enable creating events.",
        )

    title = (payload.title or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="Give the event a title.")
    if len(title) > 300:
        title = title[:300]

    try:
        datetime.strptime(payload.date, "%Y-%m-%d")
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="date must look like 2026-09-30.")
    date = payload.date

    if payload.all_day:
        start = {"date": date}
        end = {"date": date}
    else:
        start_t = _hhmm(payload.start_time, "start_time")
        # Default to an hour, the least surprising duration for a capture surface.
        end_t = _hhmm(payload.end_time, "end_time") if payload.end_time else None
        if end_t is None:
            eh, em = int(start_t[:2]), int(start_t[3:])
            total = eh * 60 + em + 60
            end_t = f"{total // 60:02d}:{total % 60:02d}"
        if end_t <= start_t:
            raise HTTPException(
                status_code=400,
                detail="end_time must be after start_time.",
            )
        # Send a naive local dateTime plus timeZone and let Google anchor it, so
        # we never have to reason about UTC offsets or DST transitions here.
        start = {"dateTime": f"{date}T{start_t}:00", "timeZone": TIMEZONE}
        end = {"dateTime": f"{date}T{end_t}:00", "timeZone": TIMEZONE}

    # Default to the first writable calendar rather than assuming a fixed one.
    if not writable:
        raise HTTPException(status_code=400, detail="No writable calendar is available.")
    cal_id = payload.calendar_id or sorted(writable)[0]
    if cal_id not in allowed:
        raise HTTPException(status_code=400, detail="Calendar is not displayed/known to this app.")
    if cal_id not in writable:
        raise HTTPException(status_code=403, detail="That calendar is read-only.")

    body = {"summary": title, "start": start, "end": end}
    desc = (payload.description or "").strip()
    if desc:
        body["description"] = desc[:1000]

    try:
        service = get_calendar_service()
        created = service.events().insert(calendarId=cal_id, body=body).execute()
    except HttpError as e:
        # Same pass-through as /move: surface Google's real status so the UI can
        # explain the failure instead of claiming a generic gateway error.
        code = getattr(getattr(e, "resp", None), "status", 502)
        status = code if code in (400, 403, 404, 409) else 502
        logger.error("create failed on %s (google %s): %s", cal_id, code, e)
        raise HTTPException(status_code=status, detail=f"Could not create event: {e}")
    except Exception as e:
        logger.error("create failed on %s: %s", cal_id, e)
        raise HTTPException(status_code=502, detail=f"Could not create event: {e}")

    logger.info("created event %s on %s (%s)", created.get("id"), cal_id, title)
    threading.Thread(target=sync, daemon=True).start()
    return {"status": "ok", "event": {"id": created.get("id"), "summary": title,
                                      "calendar_id": cal_id}}


# --- Google Tasks write endpoints ------------------------------------------
# The Tasks API's scopes are coarse: auth/tasks is full read+write, and there
# is no narrower "create" or "complete" scope, so we gate on the presence of
# the scope rather than on a separate flag. The UI only offers these actions
# when the panel is actually connected (tasks_status == "ok").
class CreateTaskPayload(BaseModel):
    title: str
    due: Optional[str] = None


@app.post("/api/tasks")
async def api_create_task(payload: CreateTaskPayload):
    """Add a task to the configured list. The wall becomes a capture surface."""
    with _lock:
        connected = state["tasks_status"] == "ok"
    if not connected:
        raise HTTPException(
            status_code=403,
            detail="Tasks panel is not connected. Create tasks from the Google "
                   "Tasks app until the wallboard token carries the tasks scope."
        )
    title = clean_text(payload.title, 300)
    if not title:
        raise HTTPException(status_code=400, detail="Task title is required.")
    try:
        task = create_task(title)
    except RuntimeError as e:
        logger.error("task create failed: %s", e)
        raise HTTPException(status_code=502, detail=f"Create failed: {e}")
    except Exception as e:
        logger.error("task create failed: %s", e)
        raise HTTPException(status_code=502, detail=f"Create failed: {e}")
    # Sync in the background so the new task shows up on the wall promptly.
    threading.Thread(target=sync, daemon=True).start()
    return {"status": "ok", "task": task}


@app.post("/api/tasks/{task_id}/complete")
async def api_complete_task(task_id: str):
    """Mark a task complete. The wall becomes a done surface."""
    with _lock:
        connected = state["tasks_status"] == "ok"
    if not connected:
        raise HTTPException(
            status_code=403,
            detail="Tasks panel is not connected.")
    try:
        update_task_status(task_id, "completed")
    except RuntimeError as e:
        logger.error("task complete failed: %s", e)
        raise HTTPException(status_code=502, detail=f"Complete failed: {e}")
    except Exception as e:
        logger.error("task complete failed: %s", e)
        raise HTTPException(status_code=502, detail=f"Complete failed: {e}")
    threading.Thread(target=sync, daemon=True).start()
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)