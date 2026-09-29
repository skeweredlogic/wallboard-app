// Measures the wallboard UI at a given viewport via the Chrome DevTools
// Protocol and prints real computed sizes. Verifies the responsive rules
// produce finger-sized tap targets on a phone without touching the wall layout.
const { spawn } = require("child_process");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const TARGET_URL = process.argv[2];
const SIZES = [
  { name: "phone  (390x844)", width: 390, height: 844, mobile: true },
  { name: "tablet (820x1180)", width: 820, height: 1180, mobile: true },
  { name: "wall   (1920x1080)", width: 1920, height: 1080, mobile: false },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Returns a JS expression string that measures the interesting elements.
const MEASURE = `(() => {
  const m = sel => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { w: +r.width.toFixed(1), h: +r.height.toFixed(1), font: cs.fontSize };
  };
  return JSON.stringify({
    viewport: { w: innerWidth, h: innerHeight },
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    scrollW: document.documentElement.scrollWidth,
    viewing: document.getElementById('range').textContent,
    navBtn: m('.nav button'),
    tab: m('.tab'),
    chip: m('.chip'),
    clock: m('#clock'),
    dayHead: m('.day-head'),
    strip: m('.day-strip'),
    title: m('.event .title'),
    time: m('.event .time'),
    range: m('.range-label'),
  });
})()`;

async function main() {
  const port = 9333;
  const proc = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${process.env.TEMP}\\wb-cdp-profile`,
    "about:blank",
  ], { stdio: "ignore" });

  let page = null;
  for (let i = 0; i < 50 && !page; i++) {
    await sleep(300);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = list.find(t => t.type === "page");
    } catch (e) { /* not up yet */ }
  }
  if (!page) { console.error("could not reach Chrome devtools"); proc.kill(); process.exit(2); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener("open", r));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise(res => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  const evalJs = async expr => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result.result.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");

  for (const s of SIZES) {
    await send("Emulation.setDeviceMetricsOverride", {
      width: s.width, height: s.height, deviceScaleFactor: 1, mobile: s.mobile,
    });
    await send("Page.navigate", { url: TARGET_URL });
    // Let the page fetch /api/state and render.
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const ready = await evalJs(`document.querySelectorAll('#main [data-id]').length > 0 || !!document.querySelector('#main .empty')`);
      if (ready) break;
    }
    // Step back to a day that has events so the event rows get measured too.
    await evalJs(`(() => {
      for (let i = 0; i < 14; i++) {
        if (document.querySelectorAll('#main [data-id]').length) break;
        document.getElementById('prev').click();
      }
      return true;
    })()`);
    await sleep(400);
    const data = JSON.parse(await evalJs(MEASURE));
    console.log(`\n=== ${s.name} ===`);
    console.log(`  viewing: ${data.viewing}`);
    console.log(`  horizontal overflow: ${data.overflowX} (scrollWidth ${data.scrollW})`);
    const rows = ["navBtn", "tab", "chip", "clock", "dayHead", "strip", "title", "time", "range"];
    for (const k of rows) {
      const v = data[k];
      console.log(`  ${k.padEnd(8)} ${v ? `${String(v.w).padStart(7)} x ${String(v.h).padEnd(6)} font ${v.font}` : "(absent)"}`);
    }
    // Tap-target assertion: nav arrows and tabs should be finger-sized.
    const tappable = ["navBtn", "tab", "chip"].filter(k => data[k] && (data[k].w >= 40 || data[k].h >= 40));
    const small = ["navBtn", "tab", "chip"].filter(k => data[k] && data[k].w < 40 && data[k].h < 40);
    console.log(`  tap targets >=40px: ${tappable.join(", ") || "(none)"}`);
    console.log(`  TOO SMALL:         ${small.join(", ") || "(none)"}`);
  }

  ws.close();
  proc.kill();
}
main().catch(e => { console.error("error:", e); process.exit(2); });
