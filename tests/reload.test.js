// Regression test for the self-update reload loop.
//
// Bug (shipped in 0.3.2 and 0.4.0): checkVersion() called location.reload()
// BEFORE writing the new version to localStorage, so the mismatch survived the
// reload and the page reloaded forever -- seen live at ~9 reloads/sec right
// after the v0.4.0 deploy.
//
// This reproduces that with a stale stored version, the way a tab that was
// open across a deploy sees it. jsdom reports location.reload() as a navigation
// it does not implement, so counting those errors counts reload attempts.
//
//   node tests/reload.test.js                    # fixture payload
//   node tests/reload.test.js <index> <api-url>  # a running server

const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");
const { buildPayload } = require("./fixture");

const INDEX = process.argv[2] || path.join(__dirname, "..", "index.html");
const API = process.argv[3] || "";
const STALE = "0.0.1-stale";

let pass = 0, fail = 0;
const check = (name, ok, info = "") => {
  if (ok) { pass++; console.log(`PASS  ${name}${info ? "   (" + info + ")" : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${info ? "   (" + info + ")" : ""}`); }
};

(async () => {
  const payload = API ? await (await fetch(API)).json() : buildPayload();
  const NEW = payload.version;
  const html = fs.readFileSync(INDEX, "utf8");
  console.log(`payload version = ${NEW}   seeded localStorage = ${STALE}\n`);

  let reloads = 0;
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => { if (/navigation/i.test(e.message)) reloads++; });

  const dom = new JSDOM(html, {
    url: "https://wallboard.test/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      w.localStorage.setItem("wallboard.version", STALE);
      // jsdom has no fetch and the page polls during parse, so the stub has to
      // exist before the page's scripts run.
      w.fetch = async () => ({ ok: true, status: 200, json: async () => payload });
    },
  });
  const w = dom.window;

  await new Promise((r) => setTimeout(r, 400));

  check("page rendered", w.document.getElementById("main") !== null);
  check("a version change reloads the page exactly once", reloads === 1, `reloads=${reloads}`);
  check("new version persisted on mismatch (the loop invariant)",
    w.localStorage.getItem("wallboard.version") === NEW,
    `stored=${w.localStorage.getItem("wallboard.version")}`);
  check("backstop marker records the version reloaded for",
    w.sessionStorage.getItem("wallboard.reloadedFor") === NEW,
    `marker=${w.sessionStorage.getItem("wallboard.reloadedFor")}`);

  // Everything after this models the loads that follow the reload. The bug made
  // each of these reload again, because the stale value was never overwritten.
  w.checkVersion(NEW);
  w.checkVersion(NEW);
  w.checkVersion(NEW);
  check("no further reloads on subsequent loads", reloads === 1, `reloads=${reloads}`);

  w.close();
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("test error:", e);
  process.exit(2);
});
