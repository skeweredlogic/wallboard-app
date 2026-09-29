// Synthetic /api/state payload for the UI tests.
//
// Two reasons this is generated rather than committed or fetched:
//   1. No real calendar data ends up in a public repo or in CI logs.
//   2. Dates are relative to "now", so the tests keep working as the wall clock
//      moves instead of silently rotting once the fixture dates go stale.
//
// The shape mirrors what main.py actually emits (see /api/state).

const TZ = "America/New_York";

const CALENDARS = [
  { id: "family-test@group.calendar.google.com", summary: "Family", color: "#4285F4", writable: true },
  { id: "eric-test@group.calendar.google.com", summary: "Eric", color: "#EA4335", writable: true },
];

/** YYYY-MM-DD for today in the display timezone, matching the UI's todayKey(). */
function todayKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const m = {};
  parts.forEach((p) => (m[p.type] = p.value));
  return `${m.year}-${m.month}-${m.day}`;
}

function shiftKey(key, days) {
  const [y, mo, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** A timed event, expressed the way main.py's format_event_start() does. */
function timed(key, hhmm, minutes) {
  const [h, mi] = hhmm.split(":").map(Number);
  const startUtc = new Date(`${key}T00:00:00Z`);
  startUtc.setUTCHours(h, mi, 0, 0);
  const endUtc = new Date(startUtc.getTime() + minutes * 60000);
  const endKey = endUtc.toISOString().slice(0, 10);
  const endHm = `${String(endUtc.getUTCHours()).padStart(2, "0")}:${String(endUtc.getUTCMinutes()).padStart(2, "0")}`;
  return {
    start: { iso: startUtc.toISOString(), local: `${key}T${hhmm}:00-05:00`, all_day: false },
    end: { iso: endUtc.toISOString(), local: `${endKey}T${endHm}:00-05:00`, all_day: false },
  };
}

function event(id, cal, summary, when, extra = {}) {
  const c = CALENDARS[cal];
  return {
    id,
    summary,
    calendar_id: c.id,
    calendar: c.summary,
    color: c.color,
    ...when,
    location: "",
    description: "",
    attendees: [],
    link: `https://calendar.google.com/calendar/event?eid=test-${id}`,
    ...extra,
  };
}

function buildPayload() {
  const today = todayKey();
  const events = [];

  // Past days, so back-navigation and the "history is reachable" assertions
  // are testing something real. Note: nothing on today, on purpose -- that
  // forces the test to actually walk back instead of trivially passing on the
  // events that happen to be showing right now.
  for (let d = 20; d >= 1; d--) {
    const key = shiftKey(today, -d);
    events.push(event(`past-${d}-a`, 0, `Past thing ${d}`, timed(key, "09:30", 60)));
    events.push(event(`past-${d}-b`, 1, `Errand ${d}`, timed(key, "14:00", 90)));
  }

  // Yesterday carries a location, a description and attendees, so the detail
  // modal's Where / Notes / Attendees rows are all exercised.
  const yKey = shiftKey(today, -1);
  events.push(event("rich-1", 0, "Dentist", timed(yKey, "10:00", 45), {
    location: "123 Example St, Suite 4, Hackettstown, NJ 07840",
    description: "Bring insurance card",
    attendees: [
      { name: "Tina", email: "tina@example.invalid", status: "accepted" },
      { name: "Ryan", email: "ryan@example.invalid", status: "needsAction" },
    ],
  }));

  // An all-day event and a multi-day one, for the duration code paths.
  const mKey = shiftKey(today, -3);
  events.push(event("allday-1", 1, "School holiday", {
    start: { iso: mKey, local: mKey, all_day: true },
    end: { iso: mKey, local: mKey, all_day: true },
  }));
  const sKey = shiftKey(today, -5);
  const eKey = shiftKey(today, -3);
  events.push(event("multiday-1", 0, "Trip", {
    start: { iso: sKey, local: sKey, all_day: true },
    end: { iso: eKey, local: eKey, all_day: true },
  }));

  // Future days, for the week and month views.
  for (let d = 1; d <= 14; d++) {
    const key = shiftKey(today, d);
    events.push(event(`future-${d}`, d % 2, `Upcoming ${d}`, timed(key, "11:00", 60)));
  }

  return {
    calendars: Object.fromEntries(CALENDARS.map((c) => [c.id, c.summary])),
    calendar_list: CALENDARS,
    events,
    tasks: buildTasks(today),
    tasks_list: "Wallboard",
    tasks_status: "ok",
    tasks_error: null,
    timezone: TZ,
    can_write: true,
    version: "0.0.0-fixture",
    last_sync: new Date().toISOString(),
    sync_status: "ok",
    error: null,
  };
}

// Mirrors the shape main.py's fetch_tasks() emits. Dates are relative to now so
// the overdue / today / future assertions keep working as the clock moves.
function buildTasks(today) {
  return [
    { id: "t-overdue", title: "Return library books", notes: "", due: shiftKey(today, -3),
      has_subtasks: false, parent: null, position: "a", link: "" },
    { id: "t-today", title: "Call the plumber", notes: "Before 5pm if possible", due: today,
      has_subtasks: false, parent: null, position: "b", link: "" },
    { id: "t-tomorrow", title: "Renew insurance", notes: "", due: shiftKey(today, 1),
      has_subtasks: true, parent: null, position: "c", link: "" },
    { id: "t-future", title: "Book dentist", notes: "", due: shiftKey(today, 9),
      has_subtasks: false, parent: null, position: "d", link: "" },
    { id: "t-nodue", title: "Declutter the garage", notes: "", due: null,
      has_subtasks: false, parent: null, position: "e", link: "" },
  ];
}

module.exports = { buildPayload, CALENDARS, todayKey, shiftKey, buildTasks };
