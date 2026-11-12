'use strict';
// Optional real-browser UI check (Node built-ins only, no npm dependencies). Runs the same scenarios in
//   - Microsoft Edge, headless, via the Chrome DevTools Protocol (CDP), and
//   - Mozilla Firefox, headless, via WebDriver BiDi (firefox --remote-debugging-port, ws://127.0.0.1:<port>/session).
// It starts its own server on a spare port with a TEMPORARY profile store (JDFC_HOME), so no real profile is touched,
// and fresh temporary browser profiles (no extensions). Everything is cleaned up at the end (browser process trees,
// temp profiles, the server).
//
// Usage (from jd-fit-checker):
//   node scripts\ui-smoke.cjs [--browser edge|firefox|all] [--port 4319] [--cdp-port 9333] [--bidi-port 9334]
//                             [--edge <msedge.exe>] [--firefox <firefox.exe>] [--skip-timeouts] [--keep]
//   node scripts\ui-smoke.cjs --attach http://127.0.0.1:4317 [--browser ...]
//     Read-only probe of an already running server: loads the page per profile and clicks Analyze with EMPTY input
//     only (the UI sends no request for empty input), so nothing is written to any profile.
// --browser defaults to all; a browser that is not installed is skipped with a message.
// --skip-timeouts skips the two timeout scenarios (they wait the real 60 s and 30 s).
// Exit code: 0 = every scenario passed in every browser that ran, 1 = a failure, 2 = no browser could run.
// Requires Node 22+ (global WebSocket).
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const PORT = Number(arg('--port', 4319));
const CDP_PORT = Number(arg('--cdp-port', 9333));
const BIDI_PORT = Number(arg('--bidi-port', 9334));
const KEEP = process.argv.includes('--keep');
const SKIP_TIMEOUTS = process.argv.includes('--skip-timeouts');
const BROWSER = String(arg('--browser', 'all')).toLowerCase();
const TOOL = path.resolve(__dirname, '..');
const ORIGIN = `http://127.0.0.1:${PORT}`;
const EXES = {
  edge: [arg('--edge'), process.env.EDGE_PATH, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
  firefox: [arg('--firefox'), process.env.FIREFOX_PATH, 'C:\\Program Files\\Mozilla Firefox\\firefox.exe', 'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe']
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (typeof WebSocket !== 'function') { console.error('Node 22+ is required (global WebSocket).'); process.exit(2); }
if (!['edge', 'firefox', 'all'].includes(BROWSER)) { console.error('--browser must be edge, firefox or all.'); process.exit(2); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jdfc-ui-smoke-'));
const home = path.join(tmp, 'home');
fs.mkdirSync(home);
const children = [];

function request(method, p, body, origin = ORIGIN) {
  const u = new URL(origin);
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: u.hostname, port: u.port, method, path: p, timeout: 30000,
      headers: { host: u.host, origin, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, json, text, headers: res.headers }); });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}
function getJson(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', timeout: 5000 }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout'))); req.end();
  });
}
async function waitFor(fn, ms, step = 150) {
  const end = Date.now() + ms;
  for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() > end) return null; await sleep(step); }
}
// Kill a process and its whole tree (browsers start helper processes). Only our own PIDs are ever targeted.
function killTree(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { proc.kill('SIGKILL'); } catch { /* gone */ } }
}

// ---------------------------------------------------------------- WebSocket JSON-RPC clients (CDP and BiDi)
class Rpc {
  constructor(url, label) { this.url = url; this.label = label; this.id = 0; this.pending = new Map(); this.handlers = []; }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error(`${this.label} socket error ${e.message || ''}`));
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: ok, reject: no, method } = this.pending.get(msg.id); this.pending.delete(msg.id);
          // CDP: { id, result } | { id, error: { message } }; BiDi: { type: 'success', id, result } | { type: 'error', id, error, message }
          if (msg.error) no(new Error(`${method}: ${typeof msg.error === 'string' ? `${msg.error} ${msg.message || ''}` : msg.error.message}`)); else ok(msg.result);
        } else if (msg.method) for (const h of [...this.handlers]) h(msg.method, msg.params);
      };
    });
  }
  send(method, params = {}, ms = 20000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${this.label} timeout: ${method}`)); } }, ms);
    });
  }
  on(fn) { this.handlers.push(fn); }
  waitEvent(name, ms) {
    return new Promise((resolve, reject) => {
      const fn = (m, p) => { if (m === name) { clearTimeout(t); this.handlers = this.handlers.filter((x) => x !== fn); resolve(p); } };
      const t = setTimeout(() => { this.handlers = this.handlers.filter((x) => x !== fn); reject(new Error(`${this.label}: no ${name} within ${ms} ms`)); }, ms);
      this.handlers.push(fn);
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

// POSTs to the tool (127.0.0.1 / localhost) are tracked by path; POSTs the browser makes on its own to other hosts
// (for example Firefox background services) are listed separately and do not count as page requests.
function notePost(d, url) {
  let u; try { u = new URL(url); } catch { return; }
  if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') d.posts.push(u.pathname); else d.external.push(`${u.host}${u.pathname}`);
}

// Every driver exposes: name, errors[], posts[], external[], evaluate(expr), click(x, y), goto(url), reload(),
// addPreload(src) -> handle, removePreload(handle), setCookie(origin, name, value), close().
// errors collects uncaught exceptions and console errors; posts collects the paths of POST requests.

// ---------------------------------------------------------------- Edge (CDP)
async function openEdge(exe) {
  const dir = path.join(tmp, 'edge'); fs.mkdirSync(dir, { recursive: true });
  const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
  children.push({ name: 'edge', proc });
  const targets = await waitFor(async () => { const t = await getJson(CDP_PORT, '/json/list'); return t.find((x) => x.type === 'page') ? t : null; }, 20000);
  if (!targets) throw new Error('Edge DevTools endpoint did not come up');
  const cdp = new Rpc(targets.find((x) => x.type === 'page').webSocketDebuggerUrl, 'CDP');
  await cdp.open();
  const d = { name: 'edge', label: 'Edge (CDP)', errors: [], posts: [], external: [], proc };
  cdp.on((method, p) => {
    if (method === 'Runtime.exceptionThrown') d.errors.push(`exception: ${(p.exceptionDetails.exception && p.exceptionDetails.exception.description) || p.exceptionDetails.text}`.split('\n')[0]);
    if (method === 'Runtime.consoleAPICalled' && p.type === 'error') d.errors.push(`console.error: ${p.args.map((a) => a.value ?? a.description ?? '').join(' ')}`.split('\n')[0]);
    // Ignored: the expected 423 of a locked profile and the browser's automatic /favicon.ico request (no icon is served).
    if (method === 'Log.entryAdded' && p.entry.level === 'error' && !/status of 423/.test(p.entry.text) && !/favicon\.ico$/.test(p.entry.url || '')) d.errors.push(`log: ${p.entry.text} ${p.entry.url || ''}`);
    if (method === 'Network.requestWillBeSent' && p.request.method === 'POST') notePost(d, p.request.url);
  });
  for (const m of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await cdp.send(m);
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  d.evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text}`);
    return r.result.value;
  };
  d.click = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  d.goto = async (url) => { const loaded = cdp.waitEvent('Page.loadEventFired', 15000); await cdp.send('Page.navigate', { url }); await loaded; };
  d.reload = async () => { const loaded = cdp.waitEvent('Page.loadEventFired', 15000); await cdp.send('Page.reload', { ignoreCache: true }); await loaded; };
  d.addPreload = async (source) => (await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source })).identifier;
  d.removePreload = (identifier) => cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => {});
  d.setCookie = (origin, name, value) => cdp.send('Network.setCookie', { url: origin, name, value });
  d.close = async () => { try { await cdp.send('Browser.close', {}, 5000); } catch { /* killed below */ } cdp.close(); };
  return d;
}

// ---------------------------------------------------------------- Firefox (WebDriver BiDi)
// BiDi serialises results as RemoteValues; turn them back into plain JSON values.
function fromRemote(v) {
  if (!v || typeof v !== 'object') return v;
  switch (v.type) {
    case 'undefined': return undefined;
    case 'null': return null;
    case 'string': case 'boolean': return v.value;
    case 'number': return typeof v.value === 'number' ? v.value : Number(v.value === '-0' ? -0 : v.value);
    case 'bigint': return Number(v.value);
    case 'array': return (v.value || []).map(fromRemote);
    case 'object': return Object.fromEntries((v.value || []).map(([k, x]) => [typeof k === 'string' ? k : String(fromRemote(k)), fromRemote(x)]));
    default: return `[${v.type}]`;
  }
}
const FIREFOX_PREFS = {
  'remote.active-protocols': 1, // WebDriver BiDi only
  'browser.shell.checkDefaultBrowser': false, 'browser.startup.homepage_override.mstone': 'ignore', 'browser.aboutwelcome.enabled': false,
  'datareporting.policy.dataSubmissionEnabled': false, 'toolkit.telemetry.reportingpolicy.firstRun': false, 'app.update.disabledForTesting': true,
  'browser.cache.disk.enable': false, 'browser.cache.memory.enable': false, 'extensions.update.enabled': false,
  'browser.safebrowsing.malware.enabled': false, 'browser.safebrowsing.phishing.enabled': false,
  'network.captive-portal-service.enabled': false, 'network.connectivity-service.enabled': false
};
async function openFirefox(exe) {
  const dir = path.join(tmp, 'firefox'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'user.js'), Object.entries(FIREFOX_PREFS).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n') + '\n');
  // --wait-for-browser keeps the Windows launcher process alive as the root of the process tree (clean kill).
  const proc = spawn(exe, ['--headless', '--no-remote', '--new-instance', '--wait-for-browser', '--profile', dir, '--remote-debugging-port', String(BIDI_PORT)],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MOZ_CRASHREPORTER_DISABLE: '1' } });
  children.push({ name: 'firefox', proc });
  let out = '';
  proc.stdout.on('data', (c) => { out += c; }); proc.stderr.on('data', (c) => { out += c; });
  // The "WebDriver BiDi listening" banner is not always forwarded to our stderr, so poll the socket instead.
  const bidi = await waitFor(async () => { const r = new Rpc(`ws://127.0.0.1:${BIDI_PORT}/session`, 'BiDi'); await r.open(); return r; }, 40000, 500);
  if (!bidi) throw new Error(`Firefox remote agent did not answer on ws://127.0.0.1:${BIDI_PORT}/session: ${out.slice(-300)}`);
  const session = await bidi.send('session.new', { capabilities: { alwaysMatch: { acceptInsecureCerts: true } } });
  const tree = await bidi.send('browsingContext.getTree', {});
  const context = (tree.contexts[0] && tree.contexts[0].context) || (await bidi.send('browsingContext.create', { type: 'tab' })).context;
  await bidi.send('browsingContext.setViewport', { context, viewport: { width: 1400, height: 1000 } });
  const d = { name: 'firefox', label: `Firefox ${session.capabilities.browserVersion} (BiDi)`, errors: [], posts: [], external: [], proc };
  bidi.on((method, p) => {
    if (method === 'log.entryAdded' && p.level === 'error' && !/favicon\.ico/.test(p.text || '')) d.errors.push(`${p.type}: ${p.text}`.split('\n')[0]);
    if (method === 'network.beforeRequestSent' && p.request.method === 'POST') notePost(d, p.request.url);
  });
  await bidi.send('session.subscribe', { events: ['log.entryAdded', 'network.beforeRequestSent'] });
  d.evaluate = async (expression) => {
    const r = await bidi.send('script.evaluate', { expression, target: { context }, awaitPromise: true, resultOwnership: 'none', serializationOptions: { maxObjectDepth: 20, maxDomDepth: 0 } });
    if (r.type === 'exception') throw new Error(`evaluate failed: ${r.exceptionDetails.text}`);
    return fromRemote(r.result);
  };
  // A real pointer click (trusted events, hit-tested like a user's click).
  d.click = (x, y) => bidi.send('input.performActions', { context, actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
    actions: [{ type: 'pointerMove', x: Math.round(x), y: Math.round(y) }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] }] });
  d.goto = (url) => bidi.send('browsingContext.navigate', { context, url, wait: 'complete' });
  // ignoreCache is not supported by Firefox's BiDi yet; the HTTP cache is disabled through the profile prefs instead.
  d.reload = () => bidi.send('browsingContext.reload', { context, wait: 'complete' });
  d.addPreload = async (src) => (await bidi.send('script.addPreloadScript', { functionDeclaration: `() => { ${src} }` })).script;
  d.removePreload = (script) => bidi.send('script.removePreloadScript', { script }).catch(() => {});
  d.setCookie = (origin, name, value) => bidi.send('storage.setCookie', { cookie: { name, value: { type: 'string', value }, domain: new URL(origin).hostname, path: '/' } });
  d.close = async () => { try { await bidi.send('browser.close', {}, 5000); } catch { /* killed below */ } bidi.close(); };
  return d;
}

// ---------------------------------------------------------------- page probes (shared by both browsers)
const centreExpr = (elExpr) => `(() => { const el = ${elExpr}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`;
const byId = (id) => `document.getElementById(${JSON.stringify(id)})`;
async function clickEl(d, elExpr) {
  const c = await d.evaluate(centreExpr(elExpr));
  if (!c || !c.w) throw new Error(`element not visible: ${elExpr}`);
  await d.click(c.x, c.y);
}
const PROBE = `(() => {
  const b = document.getElementById('analyzeBtn');
  if (!b) return { exists: false };
  b.scrollIntoView({ block: 'center' });
  const r = b.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const top = document.elementFromPoint(x, y);
  const desc = (el) => el ? el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '') : null;
  let inert = null; for (let el = b; el; el = el.parentElement) if (el.inert || el.getAttribute('aria-hidden') === 'true') { inert = desc(el); break; }
  return { exists: true, disabled: b.disabled, pointerEvents: getComputedStyle(b).pointerEvents, visible: r.width > 0 && r.height > 0,
    elementFromPoint: desc(top), hitsButton: top === b || b.contains(top), inertAncestor: inert,
    openDialog: Boolean(document.querySelector('dialog[open]')) };
})()`;
const PAGE_STATE = `(() => {
  const g = (id) => document.getElementById(id);
  const vis = (id) => Boolean(g(id) && !g(id).classList.contains('hidden'));
  const sel = document.querySelector('[role=tab][aria-selected=true]');
  return {
    results: (g('jdfcResults') || {}).innerText || '',
    analyzeMsg: (g('analyzeMsg') || {}).innerText || '',
    fetchMsg: (g('fetchMsg') || {}).innerText || '',
    status: (g('jdfcStatus') || {}).textContent || '',
    initBanner: vis('initErr') ? g('initErr').innerText : '',
    fitCard: [...document.querySelectorAll('#jdfcResults section.card h2')].map((h) => h.textContent).find((t) => /% fit/.test(t)) || '',
    shortWarn: Boolean([...document.querySelectorAll('#jdfcResults section.card')].find((c) => /JD too short to score reliably/.test(c.innerText))),
    disabled: g('analyzeBtn').disabled, fetchDisabled: g('fetchBtn').disabled,
    selectedTab: sel ? sel.id : null, helpVisible: vis('jdfcPanel-help'), onboardVisible: vis('jdfcPanel-onboard'), checkVisible: vis('jdfcPanel-check'),
    active: document.activeElement ? document.activeElement.id || document.activeElement.tagName.toLowerCase() : null,
    helpOnStart: Boolean(g('jdfcHelpOnStart') && g('jdfcHelpOnStart').checked),
    profile: (g('jdfcProfileSwitch') || {}).value || ''
  };
})()`;
const state = (d) => d.evaluate(PAGE_STATE);

// Injected before page scripts: foreign elements with generic ids, as an extension or another script might add.
// "company" and "title" are the ids whose collision broke Analyze in the field; the rest were the page's own
// generic ids before they were renamed. They are prepended to <html>, so getElementById finds them first.
const FOREIGN_IDS = ['company', 'title', 'url', 'jd', 'status', 'results', 'main', 'history', 'settings', 'search', 'message', 'error', 'login', 'password', 'name', 'email', 'profile', 'menu', 'header', 'content', 'app', 'form', 'submit', 'file', 'upload'];
const COLLIDE = `(() => { const ids = ${JSON.stringify(FOREIGN_IDS)};
  const add = () => { for (const id of ids) { const el = document.createElement('div'); el.id = id; el.dataset.foreign = '1'; el.hidden = true; document.documentElement.prepend(el); } };
  if (document.documentElement) add(); else new MutationObserver((m, o) => { if (document.documentElement) { o.disconnect(); add(); } }).observe(document, { childList: true }); })();`;
// Injected before page scripts: requests whose URL matches never answer (like a hung server) until the page aborts them.
const HANG = (reSource) => `(() => { const re = new RegExp(${JSON.stringify(reSource)}); const orig = window.fetch; window.__jdfcHung = 0;
  window.fetch = function (input, init) {
    const u = String((input && input.url) || input);
    if (!re.test(u)) return orig.apply(this, arguments);
    window.__jdfcHung++;
    return new Promise((resolve, reject) => { const s = init && init.signal; if (s) s.addEventListener('abort', () => reject(s.reason instanceof Error ? s.reason : new DOMException('The operation was aborted.', 'AbortError'))); });
  }; })();`;
// Injected before page scripts: storage that throws (as in some private windows / strict privacy settings).
const STORAGE_FAIL = `(() => { const fail = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
  try { Object.defineProperty(window, 'localStorage', { configurable: true, get: fail }); } catch (e) { /* ignore */ }
  try { for (const m of ['getItem', 'setItem', 'removeItem', 'clear', 'key']) Storage.prototype[m] = fail; } catch (e) { /* ignore */ } })();`;

const ANALYZE_TIMEOUT_MSG = 'Analyze timed out after 60 s. The server may be busy or stopped; check the server window, then try again.';
const HELP_HEADINGS = ['What this tool does', 'Quick start for a new user', 'Reading the results', 'Verdicts and the threshold', 'Tabs', 'Profiles, passwords and privacy', 'Troubleshooting', 'FAQ'];

// ---------------------------------------------------------------- scenario suite (one browser)
async function runSuite(d, fixtures) {
  const results = [];
  const { jd } = fixtures;
  // Session for "expire-test" in this browser (unlock answers 200 + session cookie).
  const un = await request('POST', '/api/profiles/expire-test/unlock', { password: 'smoke-only-password-2' });
  const [cookieName, ...cookieRest] = String([].concat(un.headers['set-cookie'] || [])[0] || '').split(';')[0].split('=');
  if (un.status !== 200 || !cookieName) throw new Error(`expire-test unlock failed: ${un.status} ${un.text}`);
  await d.setCookie(ORIGIN, cookieName, cookieRest.join('='));

  // seen: true = both Help flags set (lands on Check a JD), 'global' = only the browser-wide flag, false = none.
  async function load(profile, { inject, seen = true, expectProfile = true } = {}) {
    await d.goto(`${ORIGIN}/`);
    // Let this first page finish its own requests: reloading over in-flight fetches makes Firefox log
    // "NetworkError when attempting to fetch resource" for the aborted ones, which is not a page error.
    await waitFor(() => d.evaluate(`!/Loading/.test(document.getElementById('healthBox').textContent) && !/Loading/.test(document.getElementById('pendingList').textContent)`), 10000);
    await sleep(300);
    const flags = seen === true ? `localStorage.setItem('jdfc.helpSeen', '1'); localStorage.setItem('jdfc.helpSeen.' + P, '1');` : seen === 'global' ? `localStorage.setItem('jdfc.helpSeen', '1');` : '';
    await d.evaluate(`(() => { const P = ${JSON.stringify(profile)}; localStorage.clear(); localStorage.setItem('jdfc.profile', P); ${flags} return true; })()`);
    d.errors.length = 0; d.posts.length = 0;
    const handle = inject ? await d.addPreload(inject) : null;
    try {
      await d.reload();
      const ok = await waitFor(() => d.evaluate(`document.readyState === "complete" && ${expectProfile ? `document.getElementById('jdfcProfileSwitch').value === ${JSON.stringify(profile)} &&` : ''} !/Loading/.test(document.getElementById('healthBox').textContent)`), 10000);
      if (!ok) throw new Error('page did not finish loading');
      await sleep(400);
    } finally { if (handle) await d.removePreload(handle); }
  }
  const setInputs = (text, url = '') => d.evaluate(`(() => { document.getElementById('jdText').value = ${JSON.stringify(text)}; document.getElementById('jdUrl').value = ${JSON.stringify(url)}; return true; })()`);
  const baseProblems = (s) => {
    const out = [];
    if (s.probe) {
      if (!s.probe.hitsButton) out.push(`elementFromPoint is ${s.probe.elementFromPoint}, not the button`);
      if (s.probe.disabled) out.push('button disabled before click');
      if (s.probe.pointerEvents === 'none') out.push('pointer-events: none');
    }
    if (s.errors && s.errors.length) out.push(`console errors: ${s.errors.join(' | ')}`);
    return out;
  };
  async function record(name, fn) {
    const s = { name, notes: [] };
    const t0 = Date.now();
    try { const problems = await fn(s); s.problems = [...baseProblems(s), ...(problems || [])]; } catch (e) { s.problems = [e.message]; }
    s.seconds = Math.round((Date.now() - t0) / 100) / 10;
    s.pass = s.problems.length === 0;
    results.push(s);
    console.log(`${s.pass ? 'PASS' : 'FAIL'}  [${d.name}] ${name} (${s.seconds} s)`);
    if (s.probe) console.log(`      probe: ${JSON.stringify(s.probe)}`);
    if (s.after) console.log(`      after: fit=${JSON.stringify(s.after.fitCard)} msg=${JSON.stringify(s.after.analyzeMsg)} status=${JSON.stringify(s.after.status)} banner=${JSON.stringify(s.after.initBanner)} tab=${s.after.selectedTab} results=${JSON.stringify(s.after.results.slice(0, 70))}`);
    for (const n of s.notes) console.log(`      ${n}`);
    for (const p of s.problems) console.log(`      problem: ${p}`);
  }
  // Standard Analyze scenario: load, set input, probe, real click, wait for the answer.
  async function analyzeScenario(name, profile, { text = jd, before, expect, inject, allowErrors, loadOpts = {} }) {
    await record(name, async (s) => {
      await load(profile, { inject, ...loadOpts });
      if (before) await before(s);
      await setInputs(text);
      s.probe = await d.evaluate(PROBE);
      s.loadErrors = [...d.errors];
      const postsBefore = d.posts.length;
      await clickEl(d, byId('analyzeBtn'));
      await waitFor(async () => { const st = await state(d); return !st.disabled && (st.results || st.analyzeMsg) && st.analyzeMsg !== 'Analyzing…' ? st : null; }, 20000);
      await sleep(200);
      s.after = await state(d);
      s.analyzePost = d.posts.slice(postsBefore).some((p) => /^\/api\/p\/[^/]+\/analyze$/.test(p));
      s.errors = d.errors.filter((e) => !(allowErrors && allowErrors.test(e)));
      s.notes.push(`load errors: ${JSON.stringify(s.loadErrors)}; analyze POST sent: ${s.analyzePost}`);
      return expect(s);
    });
  }
  const resultsShown = (s) => {
    const out = [];
    if (!s.analyzePost) out.push('no POST /analyze was sent');
    if (!/^6\. % fit: \d+%$/.test(s.after.fitCard)) out.push('fit card not rendered');
    return out;
  };
  const lockedShown = (s) => (/Profile is locked — unlock it in the sidebar/.test(s.after.analyzeMsg) ? [] : [`locked message not shown (msg=${JSON.stringify(s.after.analyzeMsg)})`]);

  await analyzeScenario('demo profile: click Analyze renders result cards', 'demo', { expect: resultsShown });
  await analyzeScenario('locked protected profile: click shows the locked message', 'locked-test', { expect: lockedShown });
  await analyzeScenario('protected profile locked after the page loaded (server answers 423)', 'expire-test', {
    before: async () => {
      const l = await request('POST', '/api/profiles/expire-test/lock', {});
      if (l.status !== 200) throw new Error(`lock failed: ${l.status}`);
    },
    expect: (s) => [...(s.analyzePost ? [] : ['no POST /analyze was sent']), ...lockedShown(s)]
  });
  await analyzeScenario('fresh profile with one uploaded resume', 'fresh-test', { expect: resultsShown });
  await analyzeScenario('new profile with no resumes yet: click gives a visible answer', 'empty-test', {
    expect: (s) => [...(s.analyzePost ? [] : ['no POST /analyze was sent']), ...(s.after.results.trim() || s.after.analyzeMsg.trim() ? [] : ['nothing visible after the click'])]
  });
  await analyzeScenario('empty input shows a message', 'demo', {
    text: '',
    expect: (s) => [...(/Paste a JD or a posting URL/.test(s.after.analyzeMsg) ? [] : [`empty-input message not shown (msg=${JSON.stringify(s.after.analyzeMsg)})`]), ...(s.analyzePost ? ['a POST was sent for empty input'] : [])]
  });
  await analyzeScenario('after switching tabs and back', 'demo', {
    before: async () => { for (const id of ['jdfcTab-history', 'jdfcTab-stats', 'jdfcTab-check']) { await clickEl(d, byId(id)); await sleep(300); } },
    expect: resultsShown
  });
  await analyzeScenario('short JD shows the "too short" warning on the Fit card', 'demo', {
    text: jd.split('\n').slice(0, 9).join('\n'), // about 60 words: accepted by the server, below the 80-word warning
    expect: (s) => [...resultsShown(s), ...(s.after.shortWarn ? [] : ['short-JD warning not shown'])]
  });
  // Defensive init: make one widget's element "missing" during page init; the banner must appear and Analyze must still work.
  await analyzeScenario('one widget fails to initialise: banner shown, Analyze still works', 'demo', {
    inject: `(() => { const orig = Document.prototype.getElementById; let hit = false;
      Document.prototype.getElementById = function (id) { if (id === 'histBtn' && !hit) { hit = true; return null; } return orig.call(this, id); }; })();`,
    allowErrors: /failed to initialise/,
    expect: (s) => [...resultsShown(s), ...(/Part of the page failed to load/.test(s.after.initBanner) ? [] : ['init-error banner not shown'])]
  });
  // Regression for the field bug: foreign elements id="company" / id="title" (and other generic ids) exist before
  // the page's own elements. Analyze must still work, with no TypeError.
  await analyzeScenario('collision regression: foreign id="company"/"title" (and other generic ids) injected first', 'demo', {
    inject: COLLIDE,
    before: async (s) => {
      s.foreign = await d.evaluate(`(() => ({ company: document.getElementById('company') && document.getElementById('company').dataset.foreign, title: document.getElementById('title') && document.getElementById('title').dataset.foreign, count: document.querySelectorAll('[data-foreign]').length, firstChild: document.documentElement.firstElementChild.id }))()`);
      s.notes.push(`foreign elements: ${JSON.stringify(s.foreign)}`);
    },
    expect: (s) => [...resultsShown(s),
      ...(s.foreign.company === '1' && s.foreign.title === '1' && s.foreign.count === FOREIGN_IDS.length ? [] : ['foreign elements were not injected first']),
      ...(/^Verdict: /.test(s.after.analyzeMsg) ? [] : [`no verdict message (msg=${JSON.stringify(s.after.analyzeMsg)})`]),
      ...(/^Verdict: /.test(s.after.status) ? [] : ['the page status live region did not get the verdict']),
      ...(d.errors.some((e) => /TypeError/.test(e)) ? ['a TypeError was logged'] : [])]
  });

  // ---------------- timeouts (real waits: 60 s Analyze, 30 s Fetch JD) against a hanging /analyze or /fetch route
  if (SKIP_TIMEOUTS) console.log(`SKIP  [${d.name}] timeout scenarios (--skip-timeouts)`);
  else {
    await record('Analyze timeout: hanging /analyze -> visible message after 60 s, button re-enabled', async (s) => {
      await load('demo', { inject: HANG('/analyze$') });
      await setInputs(jd);
      const t0 = Date.now();
      await clickEl(d, byId('analyzeBtn'));
      await sleep(1500);
      const during = await state(d);
      const done = await waitFor(async () => { const st = await state(d); return !st.disabled ? st : null; }, 80000, 250);
      const secs = (Date.now() - t0) / 1000;
      s.after = done || await state(d);
      s.errors = [...d.errors];
      const hung = await d.evaluate('window.__jdfcHung');
      s.notes.push(`during (1.5 s): disabled=${during.disabled} msg=${JSON.stringify(during.analyzeMsg)}; re-enabled after ${secs.toFixed(1)} s; hung requests=${hung}; visible msg=${JSON.stringify(s.after.analyzeMsg)}; live region=${JSON.stringify(s.after.status)}`);
      return [...(during.disabled && during.analyzeMsg === 'Analyzing…' ? [] : ['button not disabled / not "Analyzing…" while waiting']),
        ...(done ? [] : ['button never re-enabled']),
        ...(secs >= 59 && secs <= 66 ? [] : [`re-enabled after ${secs.toFixed(1)} s, expected about 60 s`]),
        ...(s.after.analyzeMsg === ANALYZE_TIMEOUT_MSG ? [] : [`timeout message not shown (msg=${JSON.stringify(s.after.analyzeMsg)})`]),
        ...(s.after.status === ANALYZE_TIMEOUT_MSG ? [] : ['timeout message not in the status live region']),
        ...(hung === 1 ? [] : [`expected 1 hung request, got ${hung}`])];
    });
    await record('Fetch JD timeout: hanging /fetch -> visible message after 30 s, button re-enabled', async (s) => {
      await load('demo', { inject: HANG('/api/fetch$') });
      await setInputs('', 'https://example.com/jobs/123');
      const t0 = Date.now();
      await clickEl(d, byId('fetchBtn'));
      await sleep(1500);
      const during = await state(d);
      const done = await waitFor(async () => { const st = await state(d); return !st.fetchDisabled ? st : null; }, 50000, 250);
      const secs = (Date.now() - t0) / 1000;
      const after = done || await state(d);
      s.errors = [...d.errors];
      s.notes.push(`during (1.5 s): disabled=${during.fetchDisabled} msg=${JSON.stringify(during.fetchMsg)}; re-enabled after ${secs.toFixed(1)} s; visible msg=${JSON.stringify(after.fetchMsg)}`);
      return [...(during.fetchDisabled && during.fetchMsg === 'Fetching…' ? [] : ['Fetch button not disabled / not "Fetching…" while waiting']),
        ...(done ? [] : ['Fetch button never re-enabled']),
        ...(secs >= 29 && secs <= 36 ? [] : [`re-enabled after ${secs.toFixed(1)} s, expected about 30 s`]),
        ...(/^Fetch timed out after 30 s\./.test(after.fetchMsg) ? [] : [`fetch timeout message not shown (msg=${JSON.stringify(after.fetchMsg)})`])];
    });
  }

  // ---------------- Help tab
  await record('Help tab: headings, every "Go there" button, live verdict table, sidebar walkthrough link', async (s) => {
    await load('demo');
    await clickEl(d, byId('jdfcTab-help'));
    await sleep(200);
    const help = await d.evaluate(`(() => ({ visible: !document.getElementById('jdfcPanel-help').classList.contains('hidden'),
      headings: [...document.querySelectorAll('#jdfcPanel-help h2')].map((h) => h.textContent.trim()),
      caption: document.getElementById('jdfcHelpBandsCap').textContent, rows: [...document.querySelectorAll('#jdfcHelpBandsBody tr')].map((r) => r.innerText.replace(/\\s+/g, ' ')),
      buttons: [...document.querySelectorAll('#jdfcPanel-help .jdfc-goto')].map((b) => ({ tab: b.dataset.jdfcTab, focus: b.dataset.jdfcFocus, fallback: b.dataset.jdfcFallback || null, label: b.getAttribute('aria-label') })) }))()`);
    const problems = [];
    if (!help.visible) problems.push('Help panel not shown after clicking the Help tab');
    const missing = HELP_HEADINGS.filter((x) => !help.headings.includes(x));
    if (missing.length) problems.push(`missing headings: ${missing.join(', ')}`);
    if (!/T = 75%/.test(help.caption) || help.rows.length !== 6 || !help.rows.some((r) => /≥ 75%/.test(r))) problems.push(`verdict table not at T=75: ${help.caption} | ${help.rows.join(' | ')}`);
    if (help.buttons.length !== 8) problems.push(`expected 8 "Go there" buttons, found ${help.buttons.length}`);
    const goto = [];
    for (let i = 0; i < help.buttons.length; i++) {
      const b = help.buttons[i];
      await clickEl(d, byId('jdfcTab-help')); await sleep(150);
      await clickEl(d, `document.querySelectorAll('#jdfcPanel-help .jdfc-goto')[${i}]`); await sleep(250);
      const st = await state(d);
      const tabOk = b.tab === 'onboard' ? st.onboardVisible && !st.helpVisible : st.selectedTab === `jdfcTab-${b.tab}` && !st.helpVisible;
      const focusOk = st.active === b.focus || (b.fallback && st.active === b.fallback);
      goto.push(`${i + 1}:${b.tab}->${st.active}${tabOk && focusOk ? '' : ' (WRONG)'}`);
      if (!tabOk || !focusOk) problems.push(`step ${i + 1} "Go there" (${b.label}): tab=${st.selectedTab} onboard=${st.onboardVisible} focus=${st.active}, expected ${b.tab}/${b.focus}${b.fallback ? ` or ${b.fallback}` : ''}`);
    }
    s.notes.push(`headings: ${help.headings.join(' / ')}`);
    s.notes.push(`go there: ${goto.join(', ')}`);
    s.notes.push(`table at load: ${help.caption}`);
    // Move the threshold to 60 (as the slider does), reopen Help: the table must follow.
    await d.evaluate(`(() => { const n = document.getElementById('thrNum'); n.value = '60'; n.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await clickEl(d, byId('jdfcTab-help')); await sleep(200);
    const after = await d.evaluate(`(() => ({ caption: document.getElementById('jdfcHelpBandsCap').textContent, rows: [...document.querySelectorAll('#jdfcHelpBandsBody tr')].map((r) => r.innerText.replace(/\\s+/g, ' ')) }))()`);
    s.notes.push(`table after threshold 60: ${after.caption} | ${after.rows.find((r) => /^Hold/.test(r))}`);
    if (!/T = 60%/.test(after.caption) || !after.rows.some((r) => /≥ 60%/.test(r)) || !after.rows.some((r) => /Fit 40-59%/.test(r))) problems.push(`verdict table did not follow the threshold: ${after.caption} | ${after.rows.join(' | ')}`);
    await clickEl(d, byId('jdfcTab-check')); await sleep(150);
    await clickEl(d, byId('jdfcHelpStart')); await sleep(250);
    const side = await state(d);
    s.notes.push(`sidebar "New here?" link: help visible=${side.helpVisible} focus=${side.active}`);
    if (!side.helpVisible || side.active !== 'jdfcHelpWalkH') problems.push(`sidebar walkthrough link: help=${side.helpVisible} focus=${side.active}`);
    s.errors = [...d.errors];
    return problems;
  });
  await record('first visit in a browser lands on Help; after "Go there" a reload lands on Check a JD', async (s) => {
    await load('demo', { seen: false });
    const first = await state(d);
    await clickEl(d, `document.querySelectorAll('#jdfcPanel-help .jdfc-goto')[5]`); await sleep(250);
    const went = await state(d);
    const flags = await d.evaluate(`({ global: localStorage.getItem('jdfc.helpSeen'), demo: localStorage.getItem('jdfc.helpSeen.demo') })`);
    d.errors.length = 0;
    await d.reload();
    await waitFor(() => d.evaluate(`document.readyState === "complete" && !/Loading/.test(document.getElementById('healthBox').textContent)`), 10000);
    await sleep(500);
    const again = await state(d);
    s.errors = [...d.errors];
    s.notes.push(`first load: tab=${first.selectedTab} focus=${first.active} showOnStart=${first.helpOnStart}; after Go there: tab=${went.selectedTab} focus=${went.active}; flags=${JSON.stringify(flags)}; reload: tab=${again.selectedTab} help=${again.helpVisible}`);
    return [...(first.helpVisible && first.selectedTab === 'jdfcTab-help' && first.active === 'jdfcHelpH' ? [] : ['first visit did not land on Help with focus on its heading']),
      ...(first.helpOnStart ? [] : ['"Show Help on start" not checked while unseen']),
      ...(went.selectedTab === 'jdfcTab-check' && went.active === 'jdText' ? [] : ['"Go there" (step 6) did not reach the JD box']),
      ...(flags.global === '1' && flags.demo === '1' ? [] : ['seen flags not stored']),
      ...(again.selectedTab === 'jdfcTab-check' && !again.helpVisible ? [] : ['reload after leaving Help did not land on Check a JD'])];
  });
  await record('a new profile (no history, no applications) lands on Help once', async (s) => {
    const id = `help-new-${d.name}`;
    const c = await request('POST', '/api/profiles', { id, name: `Help new ${d.name}` });
    if (c.status >= 300) throw new Error(`create ${id} failed: ${c.status} ${c.text}`);
    await load(id, { seen: 'global' });
    await waitFor(async () => (await state(d)).helpVisible, 3000);
    const first = await state(d);
    s.notes.push(`flags at first open: ${JSON.stringify(await d.evaluate(`({ global: localStorage.getItem('jdfc.helpSeen'), profile: localStorage.getItem('jdfc.helpSeen.' + ${JSON.stringify(id)}), onStart: localStorage.getItem('jdfc.helpOnStart') })`))}`);
    await clickEl(d, byId('jdfcTab-check')); await sleep(200);
    d.errors.length = 0;
    await d.reload();
    await waitFor(() => d.evaluate(`document.readyState === "complete" && !/Loading/.test(document.getElementById('healthBox').textContent)`), 10000);
    await sleep(500);
    const again = await state(d);
    s.errors = [...d.errors];
    s.notes.push(`first open: profile=${first.profile} tab=${first.selectedTab}; after leaving Help + reload: tab=${again.selectedTab}`);
    return [...(first.profile === id && first.helpVisible ? [] : ['new profile did not land on Help']),
      ...(again.selectedTab === 'jdfcTab-check' && !again.helpVisible ? [] : ['Help opened again after it was seen for this profile'])];
  });
  await record('storage that throws (private-window-like): page loads, Analyze works', async (s) => {
    await load('demo', { inject: STORAGE_FAIL, expectProfile: false });
    const storageThrows = await d.evaluate(`(() => { try { localStorage.getItem('x'); return false; } catch (e) { return true; } })()`);
    const first = await state(d);
    // Pick the demo profile through the switcher (storage cannot remember a choice here).
    await d.evaluate(`(() => { const s = document.getElementById('jdfcProfileSwitch'); s.value = 'demo'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await waitFor(() => d.evaluate(`/resumes/.test(document.getElementById('healthBox').textContent)`), 10000);
    await setInputs(jd);
    s.probe = await d.evaluate(PROBE);
    const postsBefore = d.posts.length;
    await clickEl(d, byId('analyzeBtn'));
    await waitFor(async () => { const st = await state(d); return !st.disabled && st.fitCard ? st : null; }, 20000);
    s.after = await state(d);
    s.analyzePost = d.posts.slice(postsBefore).some((p) => /\/analyze$/.test(p));
    s.errors = [...d.errors];
    s.notes.push(`storage throws in page: ${storageThrows}; first load: profile=${first.profile} tab=${first.selectedTab} banner=${JSON.stringify(first.initBanner)}`);
    return [...(storageThrows ? [] : ['storage stub not active']), ...(first.initBanner ? [`init banner shown: ${first.initBanner}`] : []), ...resultsShown(s)];
  });
  return results;
}

// ---------------------------------------------------------------- browsers
function pickBrowsers() {
  const wanted = BROWSER === 'all' ? ['edge', 'firefox'] : [BROWSER];
  const out = [];
  for (const b of wanted) {
    const exe = EXES[b].filter(Boolean).find((p) => fs.existsSync(p));
    if (!exe) console.log(`SKIP  ${b}: not installed (looked in ${EXES[b].filter(Boolean).join('; ')}); pass --${b} <path> to use another location.`);
    else out.push({ name: b, exe });
  }
  return out;
}
const openers = { edge: openEdge, firefox: openFirefox };

// --attach: read-only probe of an already running server (for example the user's own on 4317).
async function attachMain(origin, browsers) {
  const table = [];
  for (const b of browsers) {
    let d;
    try { d = await openers[b.name](b.exe); } catch (e) { console.log(`FAIL  ${b.name}: could not start (${e.message})`); table.push({ browser: b.name, pass: false }); continue; }
    await d.goto(`${origin}/`);
    const ids = await d.evaluate('fetch("/api/profiles").then((r) => r.json()).then((j) => j.profiles.map((p) => p.id))');
    for (const id of [null, ...ids]) {
      await d.evaluate(`(() => { localStorage.clear(); localStorage.setItem('jdfc.helpSeen', '1'); ${id ? `localStorage.setItem('jdfc.profile', ${JSON.stringify(id)}); localStorage.setItem('jdfc.helpSeen.' + ${JSON.stringify(id)}, '1');` : ''} return true; })()`);
      d.errors.length = 0; d.posts.length = 0; d.external.length = 0;
      await d.reload();
      await waitFor(() => d.evaluate(`document.readyState === "complete" && !/Loading/.test(document.getElementById('healthBox').textContent)`), 10000);
      await sleep(800);
      await d.evaluate(`(() => { document.getElementById('jdText').value = ''; document.getElementById('jdUrl').value = ''; return true; })()`);
      const probe = await d.evaluate(PROBE);
      const selected = await d.evaluate(`document.getElementById('jdfcProfileSwitch').value`);
      await clickEl(d, byId('analyzeBtn'));
      await sleep(500);
      const after = await state(d);
      const errors = d.errors.filter((e) => !/status of 423/.test(e));
      const pass = probe.hitsButton && !probe.disabled && !errors.length && !d.posts.length && /Paste a JD or a posting URL|Profile is locked/.test(after.analyzeMsg);
      table.push({ browser: b.name, profile: id || '(no saved choice)', pass });
      console.log(`${pass ? 'PASS' : 'FAIL'}  [${b.name}] profile ${id || '(no saved choice)'} -> selected ${selected}`);
      console.log(`      probe: ${JSON.stringify(probe)}`);
      console.log(`      errors: ${JSON.stringify(errors)}; POSTs to the tool: ${JSON.stringify(d.posts)}${d.external.length ? `; browser background POSTs to other hosts (not the page): ${JSON.stringify(d.external)}` : ''}`);
      console.log(`      empty click: visible msg=${JSON.stringify(after.analyzeMsg)} sr-only status=${JSON.stringify(after.status)} results=${JSON.stringify(after.results.slice(0, 60))}`);
    }
    await d.close();
  }
  const failed = table.filter((r) => !r.pass).length;
  console.log(`\nattach ${origin}: ${table.length - failed}/${table.length} checks passed (${browsers.map((b) => b.name).join(', ')}; read-only: GET requests and empty-input clicks only)`);
  return failed ? 1 : 0;
}

async function main() {
  const browsers = pickBrowsers();
  if (!browsers.length) { console.error('No browser to run.'); return 2; }
  const attach = arg('--attach');
  if (attach) return attachMain(attach.replace(/\/$/, ''), browsers);

  // ---------------- server with a temp profile store
  const server = spawn(process.execPath, [path.join(TOOL, 'server.cjs')], { cwd: TOOL, env: { ...process.env, PORT: String(PORT), JDFC_HOME: home, JDFC_PASSWORD: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push({ name: 'server', proc: server });
  let serverLog = '';
  server.stdout.on('data', (c) => { serverLog += c; }); server.stderr.on('data', (c) => { serverLog += c; });
  if (!(await waitFor(async () => (await request('GET', '/api/health')).status === 200, 15000))) throw new Error(`server did not start:\n${serverLog}`);

  // Locked protected profile: created with a password by this script; the browser has no session cookie, so to it the profile is locked.
  const c1 = await request('POST', '/api/profiles', { id: 'locked-test', name: 'Locked test', password: 'smoke-only-password-1' });
  const c2 = await request('POST', '/api/profiles', { id: 'fresh-test', name: 'Fresh test' });
  const resumeText = ['Sam Example', 'Product Manager', 'Product Manager, Example Retail Co (2021-2024)',
    '- Owned the checkout roadmap and wrote PRDs with acceptance criteria.', '- Ran A/B tests that improved conversion by 4%.',
    '- Built SQL dashboards in Tableau to track funnel metrics.', '- Prioritized the Jira backlog with engineering and design.',
    'Skills: SQL, Tableau, A/B testing, Jira, product discovery, stakeholder communication', 'Education: B.Tech, Computer Science'].join('\n');
  const c3 = await request('POST', '/api/profiles', { id: 'empty-test', name: 'No resumes yet' });
  const c4 = await request('POST', '/api/profiles', { id: 'expire-test', name: 'Expires test', password: 'smoke-only-password-2' });
  const up = await request('POST', '/api/p/fresh-test/resumes', { family: 'pm', text: resumeText, fileName: 'Fresh_PM_General' });
  for (const [n, r] of [['locked-test', c1], ['fresh-test', c2], ['empty-test', c3], ['expire-test', c4], ['upload', up]]) if (r.status >= 300) throw new Error(`setup ${n} failed: ${r.status} ${r.text}`);
  const profilesList = (await request('GET', '/api/profiles')).json.profiles.map((p) => `${p.id}${p.protected ? ' (protected)' : ''}`);
  const jd = JSON.parse(fs.readFileSync(path.join(TOOL, 'profiles-seed', 'demo', 'fixtures', 'jds', '01-litware-checkout.json'), 'utf8')).lines.join('\n');

  const runs = [];
  for (const b of browsers) {
    console.log(`\n==== ${b.name}: ${b.exe}`);
    let d;
    try { d = await openers[b.name](b.exe); } catch (e) {
      console.log(`FAIL  ${b.name}: could not start or connect (${e.message})`);
      runs.push({ browser: b.name, label: b.name, results: [{ name: 'browser start', pass: false, problems: [e.message] }] });
      continue;
    }
    console.log(`     driver: ${d.label}`);
    let results;
    try { results = await runSuite(d, { jd }); } catch (e) { results = [{ name: 'suite setup', pass: false, problems: [e.message] }]; console.log(`FAIL  ${b.name}: ${e.message}`); }
    runs.push({ browser: b.name, label: d.label, results });
    await d.close();
    killTree(d.proc);
  }

  // ---------------- per-browser table
  const names = [...new Set(runs.flatMap((r) => r.results.map((x) => x.name)))];
  console.log(`\nPer-browser results (server ${ORIGIN}, temp JDFC_HOME ${home}; profiles: ${profilesList.join(', ')})`);
  console.log(`| Scenario | ${runs.map((r) => r.label).join(' | ')} |`);
  console.log(`|---|${runs.map(() => '---').join('|')}|`);
  for (const n of names) console.log(`| ${n} | ${runs.map((r) => { const x = r.results.find((y) => y.name === n); return x ? `${x.pass ? 'PASS' : 'FAIL'}${x.seconds !== undefined ? ` (${x.seconds} s)` : ''}` : '-'; }).join(' | ')} |`);
  let failed = 0;
  for (const r of runs) { const f = r.results.filter((x) => !x.pass).length; failed += f; console.log(`${r.label}: ${r.results.length - f}/${r.results.length} passed`); }
  return failed ? 1 : 0;
}

// Windows: also kill any process still using our temp dir (for example a browser child that outlived its launcher).
// The temp dir name is unique to this run, so only this run's processes can match.
function killByTempDir() {
  if (process.platform !== 'win32') return;
  spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${path.basename(tmp)}') -and $_.ProcessId -ne ${process.pid} -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' });
}
function cleanup() {
  for (const c of children) killTree(c.proc);
  killByTempDir();
  let removed = KEEP ? 'kept (--keep)' : 'no';
  if (!KEEP) {
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); removed = fs.existsSync(tmp) ? 'no' : 'yes'; } catch (e) { removed = `no (${e.code || e.message})`; }
  }
  let leftovers = 'n/a';
  if (process.platform === 'win32') {
    const q = spawnSync('powershell', ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${path.basename(tmp)}') -and $_.ProcessId -ne ${process.pid} -and $_.ProcessId -ne $PID }).Count`], { encoding: 'utf8' });
    leftovers = String(q.stdout || '').trim() || '?';
  }
  console.log(`cleanup: killed ${children.map((c) => c.name).join(', ') || 'nothing'}; temp dir ${tmp} removed: ${removed}; leftover processes using it: ${leftovers}`);
}
const hardStop = setTimeout(() => { console.error('ui-smoke: overall timeout (15 min)'); cleanup(); process.exit(1); }, 15 * 60 * 1000);
main().then((code) => { clearTimeout(hardStop); cleanup(); process.exit(code); },
  (e) => { clearTimeout(hardStop); console.error(`ui-smoke error: ${e.message}`); cleanup(); process.exit(1); });
