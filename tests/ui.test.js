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
  check("tasks view rendered rows", taskRows() > 0, `${taskRows()} rows`);
  check("tasks rows are not calendar event blocks",
    doc.querySelectorAll("#main [data-id]").length === 0,
    "no [data-id] elements in the tasks view");

  const rowFor = (id) => doc.querySelector(`#main [data-task-id="${id}"]`);
  check("overdue task is marked overdue", !!rowFor("t-overdue")?.classList.contains("overdue"));
  check("task due today is flagged", !!rowFor("t-today")?.classList.contains("due-today"));
  check("future task is not flagged as a problem",
    !rowFor("t-future")?.classList.contains("overdue") &&
    !rowFor("t-future")?.classList.contains("due-today"));
  check("undated task is not flagged as overdue", !rowFor("t-nodue")?.classList.contains("overdue"));

  const dueText = (id) => rowFor(id)?.querySelector(".task-due")?.textContent || "";
  check("due-today label reads Today", dueText("t-today") === "Today", dueText("t-today"));
  check("tomorrow label is relative", dueText("t-tomorrow") === "Tomorrow", dueText("t-tomorrow"));
  check("undated task says so", dueText("t-nodue") === "no due date", dueText("t-nodue"));
  check("overdue label names a real past date", /\w+ \d+/.test(dueText("t-overdue")), dueText("t-overdue"));

  check("task notes are rendered", (rowFor("t-today")?.textContent || "").includes("Before 5pm"));
  check("subtask marker shown", (rowFor("t-tomorrow")?.textContent || "").includes("has subtasks"));
  check("open task count shown", /\d+ open/.test(doc.querySelector(".tasks-count")?.textContent || ""),
    doc.querySelector(".tasks-count")?.textContent || "(missing)");

  // Chrome that does not apply to a task list must be hidden.
  check("calendar filters hidden on tasks view", doc.getElementById("filters").hidden === true);
  check("date stepper hidden on tasks view", doc.querySelector(".nav").hidden === true);
  check("filters restored on calendar view", (click(tab("agenda"), doc.getElementById("filters").hidden === false),
    doc.getElementById("filters").hidden === false));
  check("stepper restored on calendar view", doc.querySelector(".nav").hidden === false);

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
