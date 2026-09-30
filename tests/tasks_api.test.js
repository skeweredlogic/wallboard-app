// Guards the Google Tasks request helper against the one mistake that is
// invisible in review and unreportable at runtime.
//
// _tasks_request(method, path, body, params) attaches `body` as a JSON payload.
// Passing query arguments positionally puts them in that payload, so a GET
// goes out with a request body. Google answers that with a bare "400" and an
// empty message: `tasks api 400: ` on the wall, with the calendar half of the
// board still perfectly healthy, which looks like a credentials problem and
// isn't. That is exactly how v0.5.1 shipped.
//
// These are source-level assertions on purpose. The CI gate for this repo is
// `npm test` and it runs no Python, so a pytest would never gate a release.

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
let pass = 0, fail = 0;
const check = (name, ok, info = "") => {
  if (ok) { pass++; console.log(`PASS  ${name}${info ? "   (" + info + ")" : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${info ? "   (" + info + ")" : ""}`); }
};

const main = fs.readFileSync(path.join(root, "main.py"), "utf8");

// Every _tasks_request call, with its arguments, so we can inspect how each
// one passes query arguments. Multi-line calls are flattened first.
const calls = [];
const callRe = /_tasks_request\(\s*("(?:GET|POST|PATCH|PUT|DELETE)")\s*,\s*(.*?)\)\s*(?=\n|$)/gs;
let m;
while ((m = callRe.exec(main)) !== null) {
  const method = m[1].slice(1, -1);
  const args = m[2].replace(/\s+/g, " ").trim();
  calls.push({ method, args });
}

check("found the _tasks_request call sites", calls.length >= 4, `${calls.length} calls`);

// A GET or DELETE must never be handed a positional body. Query arguments have
// to travel as params= so they end up in the query string.
const offenders = calls.filter(
  (c) => (c.method === "GET" || c.method === "DELETE") && !/params=/.test(c.args) && /\{/.test(c.args),
);
check("no GET/DELETE passes a dict as a positional body",
  offenders.length === 0,
  offenders.length ? offenders.map((c) => `${c.method} ${c.args}`).join(" | ") : "none");

// And the helper must actually accept params, or the call sites above would be
// passing an unexpected keyword argument.
check("_tasks_request accepts a params argument",
  /def _tasks_request\(\s*method,\s*path,\s*body=None,\s*params=None\s*\)/.test(main));

// Belt and braces: the helper should refuse a body on a read method so this
// fails at the call site with a readable message instead of a bare 400.
check("_tasks_request refuses a body on a read method",
  /if method\.upper\(\) not in \("POST", "PATCH", "PUT"\)/.test(main));

// The read path is the thing a wall actually shows, so it must not regress.
check("fetch_tasks reads the task list with params=",
  /_tasks_request\(\s*"GET",\s*f"lists\/\{match\['id'\]\}\/tasks",\s*params=\{/.test(main));

// Both write paths need the list id, and both used to carry the same bug, so
// assert the create and complete entry points are wired to the fixed helper.
check("create_task resolves the list with params=",
  /def create_task[\s\S]*?_tasks_request\(\s*"GET",\s*"users\/@me\/lists",\s*params=\{/.test(main));
check("update_task_status resolves the list with params=",
  /def update_task_status[\s\S]*?_tasks_request\(\s*"GET",\s*"users\/@me\/lists",\s*params=\{/.test(main));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
