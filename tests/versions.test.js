// Guards the version numbers that the self-update mechanism depends on.
//
// The page reloads itself based on the version the API reports, so if
// APP_VERSION and the packaged version drift apart, every tab reloads
// forever after a rollout. Cheap to assert, annoying to debug in a browser.

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
let pass = 0, fail = 0;
const check = (name, ok, info = "") => {
  if (ok) { pass++; console.log(`PASS  ${name}${info ? "   (" + info + ")" : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${info ? "   (" + info + ")" : ""}`); }
};

const main = fs.readFileSync(path.join(root, "main.py"), "utf8");
const pyproject = fs.readFileSync(path.join(root, "pyproject.toml"), "utf8");

const appVersion = (main.match(/^APP_VERSION\s*=\s*"([^"]+)"/m) || [])[1];
const pkgVersion = (pyproject.match(/^version\s*=\s*"([^"]+)"/m) || [])[1];

check("main.py declares APP_VERSION", !!appVersion, appVersion || "(missing)");
check("pyproject.toml declares a version", !!pkgVersion, pkgVersion || "(missing)");
check("APP_VERSION matches the packaged version", appVersion && appVersion === pkgVersion,
  `main.py=${appVersion} pyproject=${pkgVersion}`);
check("version looks like a release, not a placeholder",
  !!appVersion && /^\d+\.\d+\.\d+$/.test(appVersion), appVersion || "(missing)");

const ignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
check("node_modules is gitignored", /^node_modules\/?$/m.test(ignore));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
