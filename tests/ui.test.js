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

  // --- view registry -------------------------------------------------------
  // Home control is meant to become a tab later, and the whole point of the
  // registry is that a tab is one entry. Assert the contract every entry has to
  // satisfy so a half-wired tab fails here rather than on the wall.
  const views = page("Object.keys(VIEWS)");
  check("every view in the registry has a tab",
    views.every((v) => !!tab(v)), views.join(", "));
  const bad = views.filter((v) => {
    const d = page(`(() => { const x = VIEWS[${JSON.stringify(v)}];
      return {label: typeof x.label === "string" && x.label.length > 0,
              chrome: ["calendar", "tasks", "none"].includes(x.chrome),
              step: typeof x.step === "function",
              render: typeof x.render === "function",
              // A view may opt out of the add control, but the opt-out has to be
              // an explicit boolean. A view with no fab key at all still gets
              // the menu, which is the right default for a new tab.
              fab: x.fab === undefined || typeof x.fab === "boolean",
              // The old per-view add:{label,run} entry is gone on purpose:
              // the button no longer infers event vs task from the tab.
              noPerViewAdd: x.add === undefined}; })()`);
    return !(d.label && d.chrome && d.step && d.render && d.fab && d.noPerViewAdd);
  });
  check("every view entry is fully wired", bad.length === 0,
    bad.length ? `incomplete: ${bad.join(", ")}` : `${views.length} views: ${views.join(", ")}`);

  // Every current view keeps the add menu, and its action list is not
  // view-dependent, so a future Home tab gets a working + with no new code.
  const fabless = views.filter((v) => page(`VIEWS[${JSON.stringify(v)}].fab === false`));
  check("every view offers the add control", fabless.length === 0,
    fabless.length ? `opted out: ${fabless.join(", ")}` : `${views.length} views`);
  check("the add menu is the same from every view",
    page(`Array.isArray(ADD_ACTIONS) && ADD_ACTIONS.length === 2`)
    && !/view\.add\b|\.add\.run\(/.test(html),
    "one action list, no per-view branch");

  // An unknown view must fall back rather than leaving the wall blank.
  page("state.view = 'nope'; render()");
  check("an unknown view falls back instead of blanking the wall",
    (doc.getElementById("main").children.length || 0) > 0,
    `${doc.getElementById("main").children.length} child node(s)`);
  page("state.view = 'agenda'; render()");

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

  // --- one add control, every view -----------------------------------------
  // A floating + in the bottom right, for the whole app. Regression guard: this
  // button used to carry a text label, and because it was right-anchored inside
  // a wrapper sized by its contents, a longer label on one view ("Create event")
  // than another ("Create task") shifted the button sideways. The invariant now
  // is that the button has a fixed size, is anchored directly, and contains
  // nothing but the glyph.
  const addBtn = doc.getElementById("add-btn");
  check("add button present", !!addBtn, addBtn?.textContent || "(missing)");
  check("add button is a plain plus glyph", (addBtn?.textContent || "").trim() === "+",
    JSON.stringify(addBtn?.textContent || "(missing)"));
  check("add button carries no visible label", !doc.getElementById("add-cap"),
    "label removed so label length cannot move the button");
  check("add button has no wrapper that could size it",
    addBtn?.parentElement?.tagName === "BODY", `parent=${addBtn?.parentElement?.tagName}`);
  check("add button is a floating control, not in the toolbar",
    !doc.querySelector(".toolbar #add-btn"), ".fab is outside .toolbar");
  check("fab is anchored bottom right",
    /\.fab\s*\{[^}]*position:\s*fixed/.test(html) && /\.fab\s*\{[^}]*right:/.test(html)
      && /\.fab\s*\{[^}]*bottom:/.test(html),
    (html.match(/\.fab\s*\{[^}]*\}/) || ["(not found)"])[0].replace(/\s+/g, " "));
  check("fab is round", /\.fab\s*\{[^}]*border-radius:\s*50%/.test(html));
  // A fixed width and height is what makes the position independent of content.
  check("fab has an explicit fixed size",
    /\.fab\s*\{[^}]*width:\s*[^;]+;/.test(html) && /\.fab\s*\{[^}]*height:\s*[^;]+;/.test(html));
  check("fab is large enough to hit on a wall display",
    /\.fab\s*\{[^}]*min-width:\s*\d{2,}px/.test(html) && /\.fab\s*\{[^}]*min-height:\s*\d{2,}px/.test(html));
  check("add button is on every view, not per-view",
    !doc.getElementById("task-create-btn") && !doc.getElementById("add-event-btn"),
    "single #add-btn");
  check("add button wording still reaches assistive tech",
    !!addBtn?.getAttribute("aria-label"), addBtn?.getAttribute("aria-label") || "(none)");
  check("no inline task input on the list",
    !doc.getElementById("task-add-input"), "field moved into the dialog");

  check("dialog hidden before opening", doc.getElementById("modal").hidden === true);
  click(addBtn);

  // --- the add menu ---------------------------------------------------------
  // The + opens a translucent panel docked above the button, NOT a modal. It
  // must not dim or cover the calendar, so the invariant to protect is that
  // #modal is never revealed by it.
  const menu = doc.getElementById("add-menu");
  check("add button opens something", !!menu && menu.hidden === false, `hidden=${menu?.hidden}`);
  check("add menu is not a modal", doc.getElementById("modal").hidden === true,
    "a modal would dim and cover the calendar");
  // Assert it lives outside the modal entirely, rather than asserting the modal
  // is empty: earlier in the suite may legitimately have left a dialog's markup
  // in there, and that has nothing to do with what the + button does.
  check("add menu is not inside the modal", !doc.getElementById("modal").contains(menu),
    `menu inside #modal=${doc.getElementById("modal").contains(menu)}`);
  check("add menu is a menu, not a listbox", menu?.getAttribute("role") === "menu",
    menu?.getAttribute("role") || "(no role)");
  check("add menu is anchored above the + button, bottom right",
    /\.add-menu\s*\{[^}]*position:\s*fixed/.test(html)
    && /\.add-menu\s*\{[^}]*right:\s*2\.4vmin/.test(html)
    && /\.add-menu\s*\{[^}]*bottom:\s*calc\(2\.4vmin \+ max\(52px, 7\.6vmin\)/.test(html),
    "bottom = FAB bottom + FAB height + one gap, so the gap cannot drift");
  check("add menu sits at the same right edge as the button",
    (html.match(/right:\s*2\.4vmin/g) || []).length >= 2, "button and menu share an inset");
  check("add menu is translucent so the wall reads through it",
    /\.add-menu\s*\{[^}]*background:\s*rgba\([^)]*0\.\d+\)/.test(html)
    && /backdrop-filter:\s*blur/.test(html),
    "translucent + blur instead of an opaque card");
  check("add menu cannot grow wider than a phone screen",
    /\.add-menu\s*\{[^}]*max-width:\s*min\(\s*86vw/.test(html));
  check("add menu is a sibling of the button, not nested in it",
    menu?.parentElement === addBtn?.parentElement
    && !addBtn?.contains(menu), `menu parent=${menu?.parentElement?.tagName}`);

  // The button does NOT infer event vs task from the tab. It offers both and lets
  // the user choose, because the same intent ("put that on the calendar") comes
  // from every view and a future Home tab has no calendar context to infer from.
  check("add menu offers both actions",
    !!doc.getElementById("add-event") && !!doc.getElementById("add-task"),
    "menu offers both actions");
  check("menu items are marked up as menu items",
    doc.getElementById("add-event")?.getAttribute("role") === "menuitem"
    && doc.getElementById("add-task")?.getAttribute("role") === "menuitem");
  check("menu has no task field yet", !doc.getElementById("task-new-title"),
    "the form comes after the pick");
  check("menu has no event field yet", !doc.getElementById("ev-title"),
    "the form comes after the pick");
  check("menu labels both actions",
    /new event/i.test(doc.getElementById("add-event")?.textContent || "")
    && /new task/i.test(doc.getElementById("add-task")?.textContent || ""));
  check("menu actions are enabled when both are possible",
    doc.getElementById("add-event")?.disabled === false
    && doc.getElementById("add-task")?.disabled === false);
  check("menu focuses its first action", doc.activeElement?.id === "add-event",
    doc.activeElement?.id || "(none)");
  check("button reports the menu as expanded",
    addBtn?.getAttribute("aria-expanded") === "true", addBtn?.getAttribute("aria-expanded") || "(none)");
  check("button advertises a menu, not a dialog",
    addBtn?.getAttribute("aria-haspopup") === "menu", addBtn?.getAttribute("aria-haspopup") || "(none)");
  check("button points at the menu it controls",
    addBtn?.getAttribute("aria-controls") === "add-menu", addBtn?.getAttribute("aria-controls") || "(none)");

  // An action that cannot run stays visible and says why, instead of silently
  // disappearing (which reads as "this app cannot make events") or opening a
  // form that is guaranteed to fail on submit. Flipped here by mutating the
  // fixture copy in memory only; no request is sent.
  page("state.data = Object.assign({}, state.data, {can_write: false}); openAddChooser()");
  check("event action is disabled when the calendar is read-only",
    doc.getElementById("add-event")?.disabled === true, `disabled=${doc.getElementById("add-event")?.disabled}`);
  check("disabled event action explains itself",
    /read-only/i.test(doc.getElementById("add-event")?.textContent || ""),
    (doc.getElementById("add-event")?.textContent || "").trim().replace(/\s+/g, " "));
  check("task action stays available when only the calendar is read-only",
    doc.getElementById("add-task")?.disabled === false);
  page("state.data = Object.assign({}, state.data, {tasks_status: 'unavailable'}); openAddChooser()");
  check("task action is disabled when tasks are not syncing",
    doc.getElementById("add-task")?.disabled === true);
  check("disabled task action explains itself",
    /not syncing/i.test(doc.getElementById("add-task")?.textContent || ""));
  page("state.data.can_write = " + JSON.stringify(!!payload.can_write)
    + "; state.data.tasks_status = " + JSON.stringify(payload.tasks_status)
    + "; openAddChooser()");
  check("menu re-enables once the cause clears",
    doc.getElementById("add-event")?.disabled === false
    && doc.getElementById("add-task")?.disabled === false);

  // No backdrop exists, so these three stand in for it.
  click(addBtn);
  check("pressing the button again puts the menu away", menu?.hidden === true, `hidden=${menu?.hidden}`);
  check("collapsed menu clears its contents",
    !(menu?.children.length), `${menu?.children.length} child node(s)`);
  check("button reports collapsed after the menu closes",
    addBtn?.getAttribute("aria-expanded") === "false");
  check("closing the menu still leaves no modal", doc.getElementById("modal").hidden === true);

  click(addBtn);
  doc.getElementById("main").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  check("clicking outside dismisses the menu", menu?.hidden === true, `hidden=${menu?.hidden}`);

  click(addBtn);
  doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  check("Escape dismisses the menu", menu?.hidden === true, `hidden=${menu?.hidden}`);
  check("Escape with the menu open does not also touch the modal",
    doc.getElementById("modal").hidden === true);

  click(addBtn);
  check("menu offers the same actions on a calendar view",
    !!doc.getElementById("add-event") && !!doc.getElementById("add-task"), "identical list");

  // Picking the task opens the task form.
  click(doc.getElementById("add-task"));
  check("choosing a task opens the task dialog", !!doc.getElementById("task-new-title"));
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

  // --- no zoom on focus ----------------------------------------------------
  // iOS Safari zooms the whole viewport when it focuses a text field whose
  // computed font-size is under 16px. Everything here is sized in vmin for a
  // wall panel, which on a phone is ~9px, so opening a dialog used to yank the
  // page into a magnified scrolling mess. The fix is a 16px floor on the form
  // controls. These assertions exist because the tempting one-line "fix" is to
  // set maximum-scale=1, which blocks pinch-zoom for everyone and is worse.
  const viewport = (html.match(/<meta name="viewport"[^>]*>/i) || ["(none)"])[0];
  check("viewport does not lock pinch-zoom",
    !/maximum-scale|user-scalable\s*=\s*no/i.test(viewport), viewport);
  check("viewport is still device-width", /width\s*=\s*device-width/.test(viewport), viewport);
  // Every control that can take focus and accept text needs the floor. A bare
  // vmin size here is the bug, so assert max(16px, ...) is present.
  for (const [what, sel] of [
    ["task textarea", /\.task-form textarea\s*\{[^}]*font-size:\s*max\(\s*16px/],
    ["text/date/time inputs", /\.task-form input\[type="(text|date|time)"\][\s\S]*?font-size:\s*max\(\s*16px/],
    ["calendar select", /\.modal-card select\s*\{[^}]*font-size:\s*max\(\s*16px/],
  ]) {
    check(`focusable field has a 16px floor: ${what}`, sel.test(html),
      "iOS zooms on focus below 16px");
  }
  // The vmin-based field sizes must not survive anywhere as a bare value.
  const bareFieldSize = /\.task-form (?:textarea|input)[^{]*\{[^}]*font-size:\s*\d*\.?\d+vmin/.test(html);
  check("no form field is sized below 16px in bare vmin", !bareFieldSize,
    "vmin alone collapses to ~9px on a phone");
  check("date and time fields share the text field rule",
    /input\[type="date"\][^\n]*,\s*\n\s*\.task-form input\[type="time"\]/.test(html),
    "one rule covers all three text-entry types");
  check("field labels stay legible on a phone", /\.ro\s*\{[^}]*font-size:\s*max\(/.test(html));
  check("form buttons have a finger-sized height",
    /\.task-form-actions button\s*\{[^}]*min-height:\s*\d{2,}px/.test(html));
  check("menu rows have a finger-sized height",
    /\.menu-item\s*\{[^}]*min-height:\s*max\(\s*\d{2,}px/.test(html));
  check("menu labels are legible on a phone",
    /\.mi-label\s*\{[^}]*font-size:\s*max\(\s*1[6-9]px/.test(html));
  check("text inflation is pinned so landscape does not drift",
    /-webkit-text-size-adjust:\s*100%/.test(html));

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
  // The event form is reached through the menu, not from a calendar tab.
  check("add button is still one control on the tasks view",
    doc.getElementById("add-btn") === addBtn, "same element across views");

  click(tab("agenda"));
  check("fab glyph is identical on a calendar view", (addBtn?.textContent || "").trim() === "+",
    JSON.stringify(addBtn?.textContent || "(missing)"));
  check("fab is the same element on every view", doc.getElementById("add-btn") === addBtn,
    "single #add-btn");
  check("fab stays visible on a calendar view", addBtn?.hidden === false,
    `hidden=${addBtn?.hidden}`);
  // Nothing about the button may differ between the two views except invisible
  // attributes, or it can move under the finger that is reaching for it.
  check("fab carries no label whose length could change between views",
    (addBtn?.textContent || "").length <= 1, JSON.stringify(addBtn?.textContent || ""));

  click(addBtn);
  click(doc.getElementById("add-event"));
  check("choosing an event opens the event dialog", !!doc.getElementById("ev-title"));
  check("menu is replaced by the form once a pick is made",
    !doc.getElementById("add-event"), "menu closes, form opens in the modal");
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
