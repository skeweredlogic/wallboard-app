// Drives the real index.html in jsdom and asserts the interactive bits work:
// filter chips, click-to-open modal, day stepping, calendar filtering, view
// switching, and the responsive stylesheet.
//
//   node tests/ui.test.js                     # against the generated fixture
//   node tests/ui.test.js <index> <api-url>   # against a running server
//
// This used to live outside the repo, which is how a reload loop reached
// production: version coverage only ever ran with empty localStorage and never
// entered the branch that mattered. Keep it here and keep it in CI.

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { buildPayload, todayKey } = require("./fixture");

/** Whole days from b to a, for YYYY-MM-DD keys. */
function daysBetween(a, b) {
  return Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
}

const INDEX = process.argv[2] || path.join(__dirname, "..", "index.html");
const API = process.argv[3] || "";

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra: extra === undefined ? "" : String(extra) });
}

async function loadPayload() {
  if (API) return (await fetch(API)).json();
  return buildPayload();
}

(async () => {
  const payload = await loadPayload();
  const html = fs.readFileSync(INDEX, "utf8");
  const cals = payload.calendar_list;

  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    url: "https://wallboard.test/",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = async () => ({ ok: true, status: 200, json: async () => payload });
      window.setInterval = () => 0; // don't keep the loop alive
    },
  });

  const { window } = dom;
  await new Promise((r) => setTimeout(r, 500));
  const doc = window.document;
  const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
// `state` is a top-level const in the page script, so it is not a window
// property and cannot be read from here directly. Evaluating in the page's own
// global scope reaches the real binding rather than a guess at what it holds.
const page = (expr) => window.eval(expr);
  const blocks = () => doc.querySelectorAll("#main [data-id]").length;
  const tab = (v) => doc.querySelector(`.tab[data-view="${v}"]`);
  const next = () => click(doc.getElementById("next"));

  // --- filter chips -------------------------------------------------------
  const chips = [...doc.querySelectorAll("#filters .chip")];
  check("filter chips rendered", chips.length === cals.length, `${chips.length} chips / ${cals.length} calendars`);
  check("chips are colour-coded", chips.every((c) => /#[0-9a-f]{6}/i.test(c.getAttribute("style") || "")),
    chips.map((c) => c.getAttribute("style")).join(" | "));
  const wantNames = cals.map((c) => c.summary).join(",");
  check("chips show calendar names", chips.map((c) => c.textContent.trim()).join(",") === wantNames,
    `${chips.map((c) => c.textContent.trim()).join(",")} want=${wantNames}`);

  // --- agenda is a single selected day, navigable by day -------------------
  const range = () => doc.getElementById("range").textContent;
  const dayBlocks = doc.querySelectorAll("#main .agenda-day").length;
  check("agenda shows at most one day group", dayBlocks <= 1, `${dayBlocks} day group(s)`);
  check("agenda range label is a date or relative day",
    /^[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}$/.test(range()) || /^(Yesterday|Tomorrow)$/.test(range()), range());
  check("agenda nav buttons ENABLED", !doc.getElementById("prev").disabled && !doc.getElementById("next").disabled,
    `prev=${doc.getElementById("prev").disabled} next=${doc.getElementById("next").disabled}`);

  // --- prev/next arrow steps back one day ---------------------------------
  const todayLabel = range();
  click(doc.getElementById("prev"));
  check("prev steps back a day", range() === "Yesterday", `${todayLabel} -> ${range()}`);
  click(doc.getElementById("prev"));
  check("prev again keeps stepping", range() !== "Yesterday" && range() !== todayLabel, range());
  click(doc.getElementById("next"));
  check("next steps forward a day", range() === "Yesterday", `-> ${range()}`);

  // --- walk back to a day that actually has events ------------------------
  // The fixture deliberately has nothing today, so this walk is real.
  let steps = 0;
  for (; steps < 14 && blocks() === 0; steps++) click(doc.getElementById("prev"));
  check("past events reachable by stepping back", blocks() > 0, `${blocks()} events on "${range()}" after ${steps + 1} click(s)`);
  const dayWithEvents = range();

  // --- click an event -> modal opens -------------------------------------
  const target = doc.querySelector("#main [data-id]");
  check("events carry a data-id", !!target && !!target.dataset.id);
  click(target);
  const modal = doc.getElementById("modal");
  const card = doc.getElementById("modal-card");
  check("modal opens on click", modal.hidden === false, `hidden=${modal.hidden}`);
  const title = card.querySelector("h2");
  check("modal shows the event title", !!title && title.textContent.trim().length > 0,
    title ? title.textContent.trim() : "(no h2)");
  const labels = [...card.querySelectorAll("dt")].map((d) => d.textContent.trim());
  check("modal has detail rows", labels.includes("When") && labels.includes("Duration"), labels.join(","));
  check("modal shows duration", /(\d+m|\d+h|all day|\d+ days)/.test(card.textContent));
  check("modal links to Google Calendar", !!card.querySelector("a.gcal[href]"),
    card.querySelector("a.gcal") ? "href present" : "(none)");

  // --- the location / notes / attendees rows render when present ---------
  // Navigate to that event's own day first, so this works against a live
  // payload too (where the located event may be months back) instead of only
  // against a fixture where it happens to be yesterday.
  const rich = payload.events.find((e) => e.location && e.attendees && e.attendees.length);
  if (rich) {
    const richKey = rich.start.local.slice(0, 10);
    click(doc.getElementById("today")); // deltas are measured from today
    const delta = daysBetween(richKey, todayKey());
    const stepper = delta < 0 ? doc.getElementById("prev") : doc.getElementById("next");
    for (let i = 0; i < Math.abs(delta); i++) click(stepper);
    const richEl = doc.querySelector(`#main [data-id="${rich.id}"]`);
    check(`event with location+attendees reachable on its day (${richKey})`, !!richEl, rich.id);
    if (richEl) {
      click(richEl);
      const text = doc.getElementById("modal-card").textContent;
      check("modal shows the event location", text.includes(rich.location), rich.location);
      check("modal shows every attendee", rich.attendees.every((a) => text.includes(a.name)),
        rich.attendees.map((a) => a.name).join(","));
      if (rich.description) {
        check("modal shows the description", text.includes(rich.description), rich.description);
      }
      doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      check("modal closed before continuing", doc.getElementById("modal").hidden === true);
    }
  } else {
    check("payload has an event with a location to exercise the Where row", false, "(none found)");
  }

  // --- move control gating ------------------------------------------------
  const sel = card.querySelector("#move-cal");
  check("move control gated on can_write",
    payload.can_write ? !!sel : !sel, `can_write=${payload.can_write} select=${!!sel}`);
  if (sel) {
    const opts = [...sel.querySelectorAll("option")].map((o) => o.value);
    check("move select lists displayed calendars", opts.length === cals.length, `${opts.length} options`);
  }

  // --- close via Escape ---------------------------------------------------
  doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  check("Escape closes the modal", modal.hidden === true, `hidden=${modal.hidden}`);

  // --- colour-coded filtering hides events --------------------------------
  // NB: the click handler re-renders #filters via innerHTML, so chip nodes are
  // replaced on every render and must be re-queried, not held onto.
  const chipFor = (id) => doc.querySelector(`#filters .chip[data-cal="${id}"]`);
  const before = blocks();
  click(chipFor(cals[1].id));
  const after = blocks();
  check("clicking a chip hides that calendar's events", after < before, `${before} -> ${after}`);
  check("chip reflects off state", chipFor(cals[1].id).className.includes("off"), chipFor(cals[1].id).className);
  click(chipFor(cals[1].id));
  check("clicking again restores events", blocks() === before, `${after} -> ${blocks()}`);

  // --- Today button jumps back -------------------------------------------
  click(doc.getElementById("today"));
  check("Today button returns to today", range() === todayLabel, `${dayWithEvents} -> ${range()}`);

  // --- week / month views -------------------------------------------------
  click(tab("week"));
  let n = blocks();
  for (let i = 0; i < 8 && n === 0; i++) { next(); n = blocks(); }
  check("week view renders events", n > 0, `${n} clickable blocks`);
  click(tab("month"));
  let m = blocks();
  for (let i = 0; i < 4 && m === 0; i++) { next(); m = blocks(); }
  check("month view renders events", m > 0, `${m} clickable chips`);

  // --- responsive rules present in the stylesheet ------------------------
  const small = html.match(/@media\s*\(max-width:\s*820px\)\s*\{/);
  check("responsive breakpoint present", !!small);
  const block = small ? html.slice(small.index) : "";
  check("touch-sized nav buttons in small-screen rules",
    /\.nav button\s*\{[^}]*width:\s*4[4-9]px[^}]*height:\s*4[4-9]px/.test(block),
    (block.match(/\.nav button\s*\{[^}]*\}/) || ["(not found)"])[0].replace(/\s+/g, " "));
  check("small-screen rules restyle event titles", /\.event \.title\s*\{[^}]*font-size:\s*1\.\d+rem/.test(block));
  check("week view scrolls sideways on small screens", /\.wk-head, \.wk-allday, \.wk-body\s*\{[^}]*min-width/.test(block));

  // --- Tasks panel --------------------------------------------------------
  // A dedicated tab must render, label and colour-code tasks independently of
  // the calendar views, and must not let the date stepper walk it off a date.
  const taskRows = () => doc.querySelectorAll("#main .task-row").length;
  check("Tasks tab exists", !!tab("tasks"));

  click(tab("tasks"));
  // Compare against the payload rather than "> 0". A live list is legitimately
  // empty, and an assertion that only passes when tasks exist is a test that
  // cannot tell "renders correctly" apart from "has data".
  check("tasks view rendered rows", taskRows() === (payload.tasks || []).length,
    `${taskRows()} rows / ${(payload.tasks || []).length} in payload`);
  check("tasks rows are not calendar event blocks",
    doc.querySelectorAll("#main [data-id]").length === 0,
    "no [data-id] elements in the tasks view");

  // Derive the expectations from whatever payload we were given rather than from
  // fixture ids, so this block is meaningful against live data too. Hardcoding
  // ids made every one of these assertions silently vacuous on a real server.
  const tasks = payload.tasks || [];
  const wallToday = payload.__todayKey || null;
  const rowFor = (id) => doc.querySelector(`#main [data-task-id="${id}"]`);
  const dueText = (id) => rowFor(id)?.querySelector(".task-due")?.textContent || "";
  const todayK = todayKey();
  const pick = (pred) => tasks.find(pred);
  const pastT = pick((t) => t.due && t.due < todayK);
  const todayT = pick((t) => t.due === todayK);
  const futureT = pick((t) => t.due && t.due > todayK);
  const noDueT = pick((t) => !t.due);

  check("payload carried tasks to render", tasks.length === taskRows(),
    `${tasks.length} in payload / ${taskRows()} rows`);

  if (pastT) {
    check("overdue task is marked overdue", !!rowFor(pastT.id)?.classList.contains("overdue"),
      `${pastT.due} ${pastT.title}`);
    check("overdue label names a real past date", /\w+ \d+/.test(dueText(pastT.id)), dueText(pastT.id));
  }
  if (todayT) {
    check("task due today is flagged", !!rowFor(todayT.id)?.classList.contains("due-today"),
      `${todayT.due} ${todayT.title}`);
    check("due-today label reads Today", dueText(todayT.id) === "Today", dueText(todayT.id));
  }
  if (futureT) {
    check("future task is not flagged as a problem",
      !rowFor(futureT.id)?.classList.contains("overdue") &&
      !rowFor(futureT.id)?.classList.contains("due-today"),
      `${futureT.due} ${futureT.title}`);
  }
  if (noDueT) {
    check("undated task is not flagged as overdue", !rowFor(noDueT.id)?.classList.contains("overdue"));
    check("undated task says so", dueText(noDueT.id) === "no due date", dueText(noDueT.id));
  }
  // Tomorrow is the one future label we can assert without controlling the data.
  const tmr = futureT && futureT.due === new Date(Date.parse(todayK) + 86400000).toISOString().slice(0, 10);
  if (tmr) check("tomorrow label is relative", dueText(futureT.id) === "Tomorrow", dueText(futureT.id));

  // Notes and subtask markers are optional per task, so only assert on tasks
  // that actually carry them in this payload.
  const noted = tasks.find((t) => t.notes);
  if (noted) check("task notes are rendered",
    (rowFor(noted.id)?.textContent || "").includes(noted.notes.slice(0, 20)), noted.notes.slice(0, 20));
  const subbed = tasks.find((t) => t.has_subtasks);
  if (subbed) check("subtask marker shown",
    (rowFor(subbed.id)?.textContent || "").includes("has subtasks"), subbed.title);

  check("open task count shown", /\d+ open/.test(doc.querySelector(".tasks-count")?.textContent || ""),
    doc.querySelector(".tasks-count")?.textContent || "(missing)");

  // --- create-task dialog -------------------------------------------------
  // Deliberately never clicks confirm with a real title: this suite also runs
  // against the live server, and a test must not put tasks in the household
  // list. Validation and dismissal are the safe things to assert.
  const createBtn = doc.getElementById("task-create-btn");
  check("create task button present", !!createBtn, createBtn?.textContent || "(missing)");
  check("create task button is labelled", /\+\s*create task/i.test(createBtn?.textContent || ""));
  check("no inline task input on the list",
    !doc.getElementById("task-add-input"), "field moved into the dialog");

  check("dialog hidden before opening", doc.getElementById("modal").hidden === true);
  click(createBtn);
  check("create button opens the dialog", doc.getElementById("modal").hidden === false);
  check("dialog has a title field", !!doc.getElementById("task-new-title"));
  check("dialog has a confirm control", !!doc.getElementById("task-confirm"));
  check("dialog has a cancel control", !!doc.getElementById("task-cancel"));
  check("dialog title field takes focus", doc.activeElement?.id === "task-new-title",
    doc.activeElement?.id || "(none)");

  // Submitting nothing must refuse without reaching the API.
  click(doc.getElementById("task-confirm"));
  await new Promise((r) => setTimeout(r, 50));
  check("empty submit is refused", /title first/i.test(doc.getElementById("task-form-msg")?.textContent || ""),
    doc.getElementById("task-form-msg")?.textContent || "(no message)");
  check("refused submit keeps the dialog open", doc.getElementById("modal").hidden === false);

  click(doc.getElementById("task-cancel"));
  check("cancel closes the dialog", doc.getElementById("modal").hidden === true);
  check("list still rendered after the dialog", taskRows() === (payload.tasks || []).length,
    `${taskRows()} rows`);

  // Chrome that does not apply to a task list must be hidden.
  check("calendar filters hidden on tasks view", doc.getElementById("filters").hidden === true);
  check("date stepper hidden on tasks view", doc.querySelector(".nav").hidden === true);
  check("filters restored on calendar view", (click(tab("agenda"), doc.getElementById("filters").hidden === false),
    doc.getElementById("filters").hidden === false));
  check("stepper restored on calendar view", doc.querySelector(".nav").hidden === false);

  // --- create-event dialog --------------------------------------------------
  // Same discipline as the task dialog: never confirm with a real title, since
  // this suite also runs against the live server and an event lands on the real
  // family calendar. Assert structure, validation and dismissal only.
  const addEv = doc.getElementById("add-event-btn");
  check("calendar add button present", !!addEv, addEv?.textContent || "(missing)");
  check("calendar add button is labelled", /\+\s*new event/i.test(addEv?.textContent || ""));
  // Assert this while actually parked on the tasks view.
  click(tab("tasks"));
  check("calendar add button hidden on tasks view", addEv?.hidden === true,
    `hidden=${addEv?.hidden}`);
  click(tab("agenda"));
  check("calendar add button shown on agenda view", addEv?.hidden === false,
    `hidden=${addEv?.hidden}`);

  click(addEv);
  check("add button opens the event dialog", doc.getElementById("modal").hidden === false);
  check("dialog heading says event", /new event/i.test(doc.querySelector("#modal-card h2")?.textContent || ""));
  for (const id of ["ev-title", "ev-date", "ev-start", "ev-end", "ev-cal", "ev-desc",
                    "ev-confirm", "ev-cancel", "ev-allday"]) {
    check(`event dialog has ${id}`, !!doc.getElementById(id));
  }
  check("event title field takes focus", doc.activeElement?.id === "ev-title",
    doc.activeElement?.id || "(none)");
  check("event date defaults to the viewed day",
    doc.getElementById("ev-date")?.value === page("state.cursor"),
    `${doc.getElementById("ev-date")?.value} vs ${page("state.cursor")}`);
  check("event defaults to a timed hour",
    /^\d{2}:\d{2}$/.test(doc.getElementById("ev-start")?.value || "") &&
    /^\d{2}:\d{2}$/.test(doc.getElementById("ev-end")?.value || ""),
    `${doc.getElementById("ev-start")?.value} -> ${doc.getElementById("ev-end")?.value}`);

  // The calendar picker must only ever offer writable calendars: offering a
  // read-only one would let the dialog build a request the API rejects.
  const offered = [...doc.querySelectorAll("#ev-cal option")].map((o) => o.value);
  const writableIds = (payload.calendar_list || []).filter((c) => c.writable).map((c) => c.id);
  check("calendar picker offers only writable calendars",
    offered.length > 0 && offered.every((id) => writableIds.includes(id)),
    `${offered.length} offered`);

  // Ticking all-day must hide the times rather than send values the API drops.
  check("times visible by default", doc.getElementById("ev-time-row").hidden === false);
  const cb = doc.getElementById("ev-allday");
  cb.checked = true; cb.onchange();
  check("all-day hides the time row", doc.getElementById("ev-time-row").hidden === true);
  cb.checked = false; cb.onchange();
  check("unticking all-day restores the time row", doc.getElementById("ev-time-row").hidden === false);

  // Submitting nothing must refuse without reaching the API.
  click(doc.getElementById("ev-confirm"));
  await new Promise((r) => setTimeout(r, 50));
  check("empty event submit is refused", /title first/i.test(doc.getElementById("ev-msg")?.textContent || ""),
    doc.getElementById("ev-msg")?.textContent || "(no message)");
  check("refused event submit keeps the dialog open", doc.getElementById("modal").hidden === false);

  // An end before the start is a typo, not a request worth sending.
  doc.getElementById("ev-title").value = "ZZ never sent";
  doc.getElementById("ev-start").value = "15:00";
  doc.getElementById("ev-end").value = "14:00";
  click(doc.getElementById("ev-confirm"));
  await new Promise((r) => setTimeout(r, 50));
  check("end-before-start is refused", /after the start/i.test(doc.getElementById("ev-msg")?.textContent || ""),
    doc.getElementById("ev-msg")?.textContent || "(no message)");

  click(doc.getElementById("ev-cancel"));
  check("event cancel closes the dialog", doc.getElementById("modal").hidden === true);
  // Whatever the view was rendering must survive the dialog closing. A day with
  // no events renders an .empty placeholder rather than .agenda, so assert on
  // #main having content instead of a specific view class.
  check("view still rendered after the event dialog",
    (doc.getElementById("main").children.length || 0) > 0,
    `${doc.getElementById("main").children.length} child node(s)`);

  // --- version stamp ------------------------------------------------------
  check("api/state carries a version", typeof payload.version === "string" && payload.version.length > 0,
    payload.version || "(missing)");
  const stored = window.localStorage.getItem("wallboard.version");
  check("page stored version for self-update", stored === payload.version, `stored=${stored}`);

  // --- lookback means there is history to browse --------------------------
  const past = payload.events.filter((e) => new Date(e.start.iso) < new Date());
  check("past events are present in the payload", past.length > 0, `${past.length} past events`);

  console.log("");
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.extra ? `   (${r.extra})` : ""}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("harness error:", e);
  process.exit(2);
});
