"""Throwaway verification for POST /api/events against the real Google API.

Boots the app on a local port, drives it over real HTTP, and deletes every event
it creates so the family calendar is left exactly as it was found.
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8899
BASE = f"http://127.0.0.1:{PORT}"

env = dict(os.environ)
env["CREDENTIALS_PATH"] = "token.json"
env["TIMEZONE"] = "America/New_York"
env["LOOKBACK_DAYS"] = "365"
# Short timer so the periodic sync actually runs inside the test. Deleting an
# event out-of-band leaves the app's in-memory state stale until the next sync,
# so a 300s cache would make the end-state assertion meaningless.
env["CACHE_TTL_SECONDS"] = "5"

failures = []


def check(name, ok, info=""):
    print(("PASS  " if ok else "FAIL  ") + name + (f"   ({info})" if info else ""))
    if not ok:
        failures.append(name)


def req(method, path, body=None):
    """Return (status, parsed_json_or_text)."""
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            raw = resp.read().decode()
            status = resp.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        status = e.code
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, raw


server = subprocess.Popen(
    [sys.executable, "-m", "uvicorn", "main:app", "--port", str(PORT), "--log-level", "warning"],
    cwd=REPO, env=env,
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
)

try:
    # Wait for the startup sync to land.
    st = None
    for _ in range(60):
        try:
            _, st = req("GET", "/api/state")
            if isinstance(st, dict) and st.get("sync_status") == "ok":
                break
        except Exception:
            pass
        time.sleep(1)
    check("app booted and synced", isinstance(st, dict) and st.get("sync_status") == "ok",
          (st or {}).get("error") if isinstance(st, dict) else st)
    if not isinstance(st, dict) or st.get("sync_status") != "ok":
        raise SystemExit("cannot continue without a synced state")

    check("can_write advertised", st.get("can_write") is True)
    writable = [x["id"] for x in st.get("calendar_list", []) if x.get("writable")]
    check("a writable calendar exists", bool(writable), f"{len(writable)} writable")
    cal = writable[0]
    print(f"      target calendar: {cal}")

    before = len(st.get("events") or [])
    timed_id = allday_id = None

    status, r = req("POST", "/api/events", {
        "title": "ZZ verify timed", "date": "2026-09-30",
        "start_time": "14:00", "end_time": "15:00", "calendar_id": cal,
    })
    check("timed event created", status == 200, f"HTTP {status} {str(r)[:140]}")
    if status == 200:
        timed_id = (r.get("event") or {}).get("id")

    status, r2 = req("POST", "/api/events", {
        "title": "ZZ verify all day", "date": "2026-10-01",
        "all_day": True, "calendar_id": cal,
    })
    check("all-day event created", status == 200, f"HTTP {status} {str(r2)[:140]}")
    if status == 200:
        allday_id = (r2.get("event") or {}).get("id")

    # Give the background sync a moment, then confirm it round-trips from Google.
    for _ in range(30):
        _, st2 = req("GET", "/api/state")
        titles = {e["summary"] for e in st2.get("events") or []}
        if {"ZZ verify timed", "ZZ verify all day"} <= titles:
            break
        time.sleep(1)

    titles = {e["summary"] for e in st2.get("events") or []}
    check("timed event present after sync", "ZZ verify timed" in titles)
    check("all-day event present after sync", "ZZ verify all day" in titles)

    ev = next((e for e in st2["events"] if e["summary"] == "ZZ verify timed"), None)
    check("timed event kept its time", bool(ev and len(ev["start"].get("local") or "") > 10),
          (ev or {}).get("start", {}).get("local", "(missing)"))
    ev2 = next((e for e in st2["events"] if e["summary"] == "ZZ verify all day"), None)
    check("all-day event flagged all_day", bool(ev2 and ev2["start"].get("all_day")),
          str((ev2 or {}).get("start", {})))

    # Validation must reject these, never write junk.
    for name, payload in [
        ("blank title", {"title": "   ", "date": "2026-09-30", "start_time": "10:00"}),
        ("bad date", {"title": "x", "date": "not-a-date", "start_time": "10:00"}),
        ("end before start", {"title": "x", "date": "2026-09-30", "start_time": "15:00", "end_time": "14:00"}),
        ("impossible time", {"title": "x", "date": "2026-09-30", "start_time": "99:99"}),
        ("unknown calendar", {"title": "x", "date": "2026-09-30", "start_time": "10:00", "calendar_id": "nope"}),
    ]:
        bs, _ = req("POST", "/api/events", payload)
        check(f"rejects {name}", bs == 400, f"HTTP {bs}")

    # Cleanup, always. These are real events on a real shared calendar.
    # main resolves its paths at import time, so the parent process needs the
    # same env the server got, not just the child's copy.
    os.environ["CREDENTIALS_PATH"] = "token.json"
    os.environ["TIMEZONE"] = "America/New_York"
    sys.path.insert(0, REPO)
    import main  # noqa: E402
    service = main.get_calendar_service()
    for eid, label in ((timed_id, "timed"), (allday_id, "all-day")):
        if not eid:
            print(f"WARN  no id returned for {label} event, cannot delete automatically")
            continue
        service.events().delete(calendarId=cal, eventId=eid).execute()
        check(f"{label} test event deleted", True, eid)

    # Belt and braces: sweep for any stragglers by summary prefix, not just ids.
    import datetime
    now = datetime.datetime.now(datetime.timezone.utc)
    listing = service.events().list(
        calendarId=cal, singleEvents=True,
        timeMin=(now - datetime.timedelta(days=3)).isoformat(),
        timeMax=(now + datetime.timedelta(days=60)).isoformat(),
        maxResults=2500,
    ).execute()
    stragglers = [e for e in listing.get("items", [])
                  if (e.get("summary") or "").startswith("ZZ verify")]
    for e in stragglers:
        service.events().delete(calendarId=cal, eventId=e["id"]).execute()
        print(f"      swept straggler {e['id']} ({e.get('summary')})")
    check("no ZZ verify events left on the calendar", not stragglers,
          f"had {len(stragglers)}")

    # The delete happened out-of-band, so wait for a timer sync to propagate it.
    # This proves the delete round-trips through the app's own sync path, which
    # is what actually matters for what the wallboard displays.
    left = []
    for _ in range(24):
        _, st3 = req("GET", "/api/state")
        left = [e["summary"] for e in st3.get("events") or []
                if e["summary"].startswith("ZZ verify")]
        if not left:
            break
        time.sleep(2)
    check("deleted events disappear from the wall", not left, f"left: {left}")
    print(f"      events before: {before}  after cleanup: {len(st3.get('events') or [])}")
finally:
    server.terminate()
    try:
        server.wait(timeout=10)
    except subprocess.TimeoutExpired:
        server.kill()

print()
if failures:
    print(f"{len(failures)} FAILED: {failures}")
    sys.exit(1)
print("all passed")
