'use strict';
// Regenerates the README screenshots (docs\*.png) from the synthetic Demo profile only (Node built-ins only).
// It starts its own server on a spare port with a TEMPORARY, empty profile store (JDFC_HOME), so the only profiles
// are the shipped demo and one throw-away protected profile created here for the lock screenshot. No real profile is
// ever opened. Headless Microsoft Edge is driven over the Chrome DevTools Protocol (Page.captureScreenshot) at a
// 1440x900 viewport, deviceScaleFactor 1. Headless capture has no URL bar or OS window chrome.
// Before saving, each view's visible text is checked against the deny-list terms (lib\denylist.cjs), the OS user
// name and the temp folder path; a hit refuses that screenshot (the matched term is never printed). Pixels cannot be
// scanned, so look at every image before you publish it.
//
// Usage (from jd-fit-checker):
//   node scripts\capture-screenshots.cjs [--out <dir>] [--port 4471] [--cdp-port 9471] [--edge <msedge.exe>] [--keep]
//   --out defaults to <tool>\docs. Exit code: 0 = every screenshot saved, 1 = a failure, 2 = Edge not found.
// Requires Node 22+ (global WebSocket).
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { terms } = require('../lib/denylist.cjs');

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const TOOL = path.resolve(__dirname, '..');
const OUT = path.resolve(arg('--out', path.join(TOOL, 'docs')));
const PORT = Number(arg('--port', 4471));
const CDP_PORT = Number(arg('--cdp-port', 9471));
const KEEP = process.argv.includes('--keep');
const ORIGIN = `http://127.0.0.1:${PORT}`;
const VIEW = { width: 1440, height: 900 };
const EDGE = [arg('--edge'), process.env.EDGE_PATH, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean).find((p) => fs.existsSync(p));
// Throw-away protected profile for the lock screenshot (exists only in the temp store).
const LOCKED = { id: 'sample-locked', name: 'Sample (locked)', password: 'capture-only-password' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (typeof WebSocket !== 'function') { console.error('Node 22+ is required (global WebSocket).'); process.exit(2); }
if (!EDGE) { console.error('Microsoft Edge not found; pass --edge <path to msedge.exe>.'); process.exit(2); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jdfc-capture-'));
const home = path.join(tmp, 'home');
fs.mkdirSync(home);
const children = [];

function request(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: p, timeout: 30000,
      headers: { host: `127.0.0.1:${PORT}`, origin: ORIGIN, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}
function getJson(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, timeout: 5000 }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout'))); req.end();
  });
}
async function waitFor(fn, ms, step = 150) {
  const end = Date.now() + ms;
  for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() > end) return null; await sleep(step); }
}
function killTree(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { proc.kill('SIGKILL'); } catch { /* gone */ } }
}

// Minimal CDP client (same shape as scripts\ui-smoke.cjs).
class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.handlers = []; }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error(`CDP socket error ${e.message || ''}`));
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: ok, reject: no, method } = this.pending.get(msg.id); this.pending.delete(msg.id);
          if (msg.error) no(new Error(`${method}: ${msg.error.message}`)); else ok(msg.result);
        } else if (msg.method) for (const h of [...this.handlers]) h(msg.method, msg.params);
      };
    });
  }
  send(method, params = {}, ms = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, ms);
    });
  }
  waitEvent(name, ms) {
    return new Promise((resolve, reject) => {
      const fn = (m, p) => { if (m === name) { clearTimeout(t); this.handlers = this.handlers.filter((x) => x !== fn); resolve(p); } };
      const t = setTimeout(() => { this.handlers = this.handlers.filter((x) => x !== fn); reject(new Error(`no ${name} within ${ms} ms`)); }, ms);
      this.handlers.push(fn);
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function openEdge() {
  const dir = path.join(tmp, 'edge'); fs.mkdirSync(dir, { recursive: true });
  const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars', `--window-size=${VIEW.width},${VIEW.height}`, '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });
  children.push({ name: 'edge', proc });
  const targets = await waitFor(async () => { const t = await getJson(CDP_PORT, '/json/list'); return t.find((x) => x.type === 'page') ? t : null; }, 20000);
  if (!targets) throw new Error('Edge DevTools endpoint did not come up');
  const cdp = new Cdp(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.open();
  for (const m of ['Runtime.enable', 'Page.enable']) await cdp.send(m);
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEW, deviceScaleFactor: 1, mobile: false });
  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text}`);
    return r.result.value;
  };
  const goto = async (url) => { const loaded = cdp.waitEvent('Page.loadEventFired', 15000); await cdp.send('Page.navigate', { url }); await loaded; };
  return { cdp, proc, evaluate, goto };
}

// Visible-text privacy check: deny-list terms (word-bounded, like lib\denylist.cjs), the OS user name and temp paths.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PRIVATE = [...terms(), os.userInfo().username, tmp, os.tmpdir(), os.homedir()].filter((t) => t && t.length >= 3)
  .map((t) => new RegExp(`(?<![A-Za-z0-9])${String(t).trim().split(/[\s_\\/-]+/).filter(Boolean).map(esc).join('[\\s_\\\\/-]*')}(?![A-Za-z0-9])`, 'i'));

async function main() {
  const server = spawn(process.execPath, [path.join(TOOL, 'server.cjs')], { cwd: TOOL, env: { ...process.env, PORT: String(PORT), JDFC_HOME: home, JDFC_PASSWORD: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push({ name: 'server', proc: server });
  let serverLog = '';
  server.stdout.on('data', (c) => { serverLog += c; }); server.stderr.on('data', (c) => { serverLog += c; });
  if (!(await waitFor(async () => (await request('GET', '/api/health')).status === 200, 15000))) throw new Error(`server did not start:\n${serverLog}`);
  const c = await request('POST', '/api/profiles', LOCKED);
  if (c.status >= 300) throw new Error(`could not create ${LOCKED.id}: ${c.status} ${c.text}`);
  // A realistic salvage case (baseline below T, honest edits help but a gap remains), not a near-perfect match.
  const jd = JSON.parse(fs.readFileSync(path.join(TOOL, 'profiles-seed', 'demo', 'fixtures', 'jds', '02-northwind-growth.json'), 'utf8')).lines.join('\n');

  const b = await openEdge();
  const { cdp, evaluate } = b;
  fs.mkdirSync(OUT, { recursive: true });
  const saved = [];

  // Fresh page on the Demo profile, Help marked as seen (it opens by itself on a first visit otherwise).
  const load = async () => {
    await b.goto(`${ORIGIN}/`);
    await evaluate(`(() => { localStorage.clear(); localStorage.setItem('jdfc.profile', 'demo'); localStorage.setItem('jdfc.helpSeen', '1'); localStorage.setItem('jdfc.helpSeen.demo', '1'); localStorage.setItem('jdfc.threshold', '75'); return true; })()`);
    await b.goto(`${ORIGIN}/`);
    if (!(await waitFor(() => evaluate(`document.getElementById('jdfcProfileSwitch').value === 'demo' && !/Loading/.test(document.getElementById('healthBox').textContent)`), 15000))) throw new Error('demo profile did not load');
    await sleep(400);
  };
  const tab = (name) => evaluate(`(() => { selectTab(document.getElementById('jdfcTab-${name}')); window.scrollTo(0, 0); return true; })()`);
  const settle = async (cond, ms = 15000) => { if (cond && !(await waitFor(() => evaluate(cond), ms))) throw new Error(`timed out waiting for: ${cond}`); await sleep(500); };

  // clip: null = the viewport as it is; otherwise a CSS selector list whose union (document coordinates) is captured.
  async function shot(name, { selectors = null, scrollTo = null, pad = 12, maxHeight = 2400 } = {}) {
    await evaluate(`document.activeElement && document.activeElement.blur && document.activeElement.blur(), true`);
    if (scrollTo) await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(scrollTo)}); window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 16); return true; })()`);
    await sleep(300);
    const visible = await evaluate(`(() => { const parts = [document.title]; const els = ${selectors ? `[...document.querySelectorAll(${JSON.stringify(selectors)})]` : '[document.body]'}; for (const el of els) parts.push(el.innerText); for (const el of document.querySelectorAll('input, textarea, select')) parts.push(el.value || ''); return parts.join('\\n'); })()`);
    const hits = PRIVATE.filter((re) => re.test(visible));
    if (hits.length) throw new Error(`${name}: visible text matched ${hits.length} private term(s); screenshot refused`);
    let params = { format: 'png' };
    if (selectors) {
      const r = await evaluate(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(selectors)})]; if (!els.length) return null;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const el of els) { const b = el.getBoundingClientRect(); x0 = Math.min(x0, b.left); y0 = Math.min(y0, b.top + window.scrollY); x1 = Math.max(x1, b.right); y1 = Math.max(y1, b.bottom + window.scrollY); }
        return { x0, y0, x1, y1 }; })()`);
      if (!r) throw new Error(`${name}: nothing matches ${selectors}`);
      const x = Math.max(0, Math.floor(r.x0 - pad)), y = Math.max(0, Math.floor(r.y0 - pad));
      params = { format: 'png', captureBeyondViewport: true, clip: { x, y, width: Math.ceil(r.x1 + pad) - x, height: Math.min(maxHeight, Math.ceil(r.y1 + pad) - y), scale: 1 } };
    }
    const { data } = await cdp.send('Page.captureScreenshot', params);
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    const buf = fs.readFileSync(file);
    saved.push({ file, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length });
    console.log(`saved ${path.basename(file)}: ${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}, ${buf.length} bytes`);
  }
  const resultCard = (n) => `#jdfcResults section.card[aria-label^="${n}."]`;

  // 1. Check a JD on the demo profile with a demo fixture JD analysed.
  await load();
  await evaluate(`(() => { document.getElementById('jdText').value = ${JSON.stringify(jd)}; return true; })()`);
  await evaluate(`document.getElementById('analyzeBtn').click(), true`);
  await settle(`document.querySelector('${resultCard(13)}') !== null`, 30000);
  await shot('screenshot', { scrollTo: '#jdfcResults' }); // hero: sidebar + Seen before + Verdict at the top of the results
  await shot('fit-breakdown', { selectors: `${resultCard(5)}, ${resultCard(6)}` });
  await shot('keyword-match', { selectors: resultCard(7) });

  // 2. Resume repository, My evidence, Stats.
  await tab('repo'); await evaluate(`document.getElementById('repoBtn').click(), true`);
  await settle(`document.getElementById('repoOut').innerText.trim().length > 40`);
  await shot('resume-repository');
  await tab('evidence'); await evaluate(`loadEvidence().then(() => true)`); // the tab's click handler loads it
  await settle(`document.getElementById('evOut').innerText.trim().length > 40`);
  await shot('my-evidence', { scrollTo: '#evOut' });
  await tab('stats'); await evaluate(`document.getElementById('statsBtn').click(), true`);
  await settle(`document.getElementById('statsOut').innerText.trim().length > 40`);
  await shot('stats');

  // 3. Help walkthrough.
  await evaluate(`openHelp(), window.scrollTo(0, 0), true`);
  await settle(`!document.getElementById('jdfcPanel-help').classList.contains('hidden')`);
  await shot('help-walkthrough');

  // 4. Create-profile onboarding, step 1 (sample values typed in, nothing submitted).
  await load();
  await evaluate(`document.getElementById('createProfileBtn').click(), true`);
  await settle(`!document.getElementById('jdfcPanel-onboard').classList.contains('hidden')`);
  await evaluate(`(() => { document.getElementById('obId').value = 'my-search'; document.getElementById('obName').value = 'Sample User'; window.scrollTo(0, 0); return true; })()`);
  await shot('onboarding');

  // 5. Profile lock: the throw-away protected profile with the Unlock dialog open (over the Check a JD tab).
  await load();
  await evaluate(`switchProfile(${JSON.stringify(LOCKED.id)}, { promptUnlock: true }).then(() => true)`);
  await settle(`document.getElementById('unlockDlg').open || (document.getElementById('unlockDlg').showModal(), true)`);
  await shot('profile-lock');

  try { await cdp.send('Browser.close', {}, 5000); } catch { /* killed below */ }
  cdp.close();
  return saved;
}

function cleanup() {
  for (const ch of children) killTree(ch.proc);
  if (process.platform === 'win32') {
    spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${path.basename(tmp)}') -and $_.ProcessId -ne ${process.pid} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' });
  }
  if (!KEEP) { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* reported below */ } }
  console.log(`cleanup: stopped ${children.map((ch) => ch.name).join(', ') || 'nothing'}; temp folder removed: ${KEEP ? 'kept (--keep)' : fs.existsSync(tmp) ? 'no' : 'yes'}`);
}

const hardStop = setTimeout(() => { console.error('capture-screenshots: overall timeout (5 min)'); cleanup(); process.exit(1); }, 5 * 60 * 1000);
main().then((saved) => { console.log(`OK: ${saved.length} screenshots in ${OUT}`); process.exitCode = 0; })
  .catch((e) => { console.error(`FAILED: ${e.message}`); process.exitCode = 1; })
  .finally(() => { clearTimeout(hardStop); cleanup(); });
