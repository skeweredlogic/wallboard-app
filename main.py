import os
import json
import logging
from fastapi import FastAPI
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

CREDENTIALS_PATH = os.environ.get("CREDENTIALS_PATH", "/app/config/token.json")
CALENDAR_IDS_RAW = os.environ.get("CALENDAR_IDS", "")
PORT = int(os.environ.get("PORT", "8000"))

app = FastAPI(title="wallboard")

# In-memory state
state = {
    "calendars": {},
    "last_sync": None,
    "sync_status": "never",
}

def load_credentials():
    if not os.path.exists(CREDENTIALS_PATH):
        raise FileNotFoundError(f"Credentials file not found: {CREDENTIALS_PATH}")
    return Credentials.from_authorized_user_file(CREDENTIALS_PATH, scopes=["https://www.googleapis.com/auth/calendar.readonly"])

def get_calendar_service():
    creds = load_credentials()
    # Auto-refresh if needed
    if not creds.valid:
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            raise ValueError("Invalid credentials and cannot refresh")
    return build("calendar", "v3", credentials=creds)

@app.on_event("startup")
async def startup():
    logger.info("wallboard starting, credentials=%s", CREDENTIALS_PATH)
    try:
        service = get_calendar_service()
        cal_list = service.calendarList().list().execute()
        calendars = cal_list.get("items", [])
        for cal in calendars:
            state["calendars"][cal["id"]] = cal.get("summary", "?")
        logger.info("discovered %d calendars", len(calendars))
        state["sync_status"] = "ok"
        state["last_sync"] = None
    except Exception as e:
        logger.error("startup calendar discovery failed: %s", e)
        state["sync_status"] = "error"

@app.get("/health")
@app.get("/healthz")
async def healthz():
    return {"status": "ok"}

@app.get("/api/state")
async def api_state():
    return state


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)