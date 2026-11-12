'use strict';

// Double-click launcher support (lib\launch.cjs + server.cjs with JDFC_LAUNCHER=1): browser command built as an args
// array, port fallback past a busy non-tool port, "already running" detection, and unchanged behaviour without the
// flag. Servers run on random high ports with a temp JDFC_HOME; the browser is never opened (JDFC_NO_BROWSER=1).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { tmpDir } = require('./helpers.cjs');
const launch = require('../lib/launch.cjs');

const SERVER = path.join(__dirname, '..', 'server.cjs');

// A listener that is NOT this tool (plain text health) or one that looks like it (jdfc version), on 127.0.0.1.
function dummy({ tool = false } = {}) {
  const s = http.createServer((req, res) => {
    if (tool && req.url === '/api/health') { res.writeHead(200, { 'content-type': 'application/json', 'x-service-version': 'test-jdfc' }); res.end(JSON.stringify({ ok: true, version: 'test-jdfc' })); return; }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('something else');
  });
  // A random port in 20000-39999, below the OS ephemeral range, so the ports right after it are not taken by the
  // listen(0) tool servers of test files running in parallel (those would count as "already running").
  const attempt = (left) => new Promise((resolve, reject) => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    s.once('error', (e) => (left > 0 ? attempt(left - 1).then(resolve, reject) : reject(e)));
    s.listen(port, '127.0.0.1', () => { s.removeAllListeners('error'); resolve(s); });
  });
  return attempt(20);
}
const close = (s) => new Promise((resolve) => s.close(resolve));

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

function runServer(port, home, extraEnv = {}) {
  const env = { ...process.env, PORT: String(port), JDFC_HOME: home, JDFC_NO_BROWSER: '1', ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  delete env.JDFC_PROFILE;
  if (!('JDFC_LAUNCHER' in extraEnv)) delete env.JDFC_LAUNCHER;
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (c) => { log += c; });
  child.stderr.on('data', (c) => { log += c; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const waitFor = (re, ms = 15000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (re.test(log)) return resolve(log);
      if (child.exitCode !== null) return reject(new Error(`server exited (${child.exitCode}):\n${log}`));
      if (Date.now() - t0 > ms) return reject(new Error(`timeout waiting for ${re}:\n${log}`));
      setTimeout(tick, 50);
    };
    tick();
  });
  const stop = async () => { if (child.exitCode === null) { child.kill(); await exited; } };
  return { child, exited, waitFor, stop, log: () => log };
}

test('browserCommand passes the URL as its own argument on every platform and refuses non-local URLs', () => {
  const url = 'http://127.0.0.1:4318/';
  assert.deepEqual(launch.browserCommand(url, 'win32'), { cmd: 'cmd.exe', args: ['/d', '/c', 'start', '', url] });
  assert.deepEqual(launch.browserCommand(url, 'darwin'), { cmd: 'open', args: [url] });
  assert.deepEqual(launch.browserCommand(url, 'linux'), { cmd: 'xdg-open', args: [url] });
  for (const bad of ['https://example.com/', 'http://127.0.0.1:4317/&calc', 'http://127.0.0.1:4317/ & x', 'file:///c:/x']) {
    assert.throws(() => launch.browserCommand(bad, 'win32'), /non-local/);
  }
});

test('openBrowser spawns detached with an args array and only prints a hint when spawning fails', () => {
  const calls = [];
  const fake = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { on() {}, unref() { calls.push('unref'); } }; };
  const r = launch.openBrowser('http://127.0.0.1:4317/', { platform: 'darwin', spawnImpl: fake, log: () => {} });
  assert.deepEqual(r, { cmd: 'open', args: ['http://127.0.0.1:4317/'] });
  assert.equal(calls[0].cmd, 'open');
  assert.ok(Array.isArray(calls[0].args));
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.stdio, 'ignore');
  assert.equal(calls[1], 'unref');
  const logs = [];
  launch.openBrowser('http://127.0.0.1:4317/', { platform: 'linux', spawnImpl: () => { throw new Error('ENOENT'); }, log: (m) => logs.push(m) });
  assert.match(logs[0], /Open http:\/\/127\.0\.0\.1:4317\/ in your browser/);
});

test('listenWithFallback skips a port used by another program, and reports a running copy of the tool', async () => {
  const other = await dummy();
  const busy = other.address().port;
  const srv = http.createServer();
  let tool;
  try {
    assert.equal(await launch.probeTool(busy), false);
    const tried = [];
    // Neighbouring ports may be taken by other programs on this machine; every one skipped must be busy, not the tool.
    const r = await launch.listenWithFallback(srv, { port: busy, tries: launch.PORT_TRIES, beforeListen: (p) => tried.push(p) });
    assert.equal(r.alreadyRunning, false);
    assert.equal(r.skipped[0], busy);
    assert.deepEqual(r.skipped, tried.slice(0, -1));
    assert.equal(r.port, srv.address().port);
    assert.ok(r.port > busy && r.port < busy + launch.PORT_TRIES);
    assert.deepEqual(tried, Array.from({ length: r.port - busy + 1 }, (_, i) => busy + i));
    await close(srv);
    tool = await dummy({ tool: true });
    assert.equal(await launch.probeTool(tool.address().port), true);
    const again = await launch.listenWithFallback(http.createServer(), { port: tool.address().port, tries: 3 });
    assert.deepEqual(again, { port: tool.address().port, alreadyRunning: true, skipped: [] });
    await assert.rejects(launch.listenWithFallback(http.createServer(), { port: busy, tries: 1 }), { code: 'NO_FREE_PORT' });
  } finally {
    if (srv.listening) await close(srv);
    await close(other);
    if (tool) await close(tool);
  }
});

test('server.cjs with JDFC_LAUNCHER=1 falls back to the next port and says it is already running on a second start', async () => {
  const home = tmpDir('jdfc-launch-home-');
  const other = await dummy();
  const busy = other.address().port;
  let a;
  let b;
  try {
    a = runServer(busy, home, { JDFC_LAUNCHER: '1' });
    const log = await a.waitFor(/Keep this window open/);
    const m = /JD Fit Checker is running at http:\/\/127\.0\.0\.1:(\d+) \. Keep this window open while you use it\. Close this window \(or press Ctrl\+C\) to stop\./.exec(log);
    assert.ok(m, log);
    const port = Number(m[1]);
    assert.ok(port > busy && port < busy + launch.PORT_TRIES, log);
    assert.match(log, new RegExp(`Ports? ${busy}(, \\d+)* (is|are) used by another program, so port ${port} is used instead`));
    const h = await get(port, '/api/health');
    assert.equal(h.status, 200);
    assert.equal(JSON.parse(h.text).port, port, 'Host allow-list follows the port actually used');

    b = runServer(busy, home, { JDFC_LAUNCHER: '1' });
    assert.equal(await b.exited, 0, b.log());
    assert.match(b.log(), new RegExp(`already running at http://127\\.0\\.0\\.1:${port}/`));
    assert.equal((await get(port, '/api/health')).status, 200, 'the first copy keeps running');
  } finally {
    if (a) await a.stop();
    if (b) await b.stop();
    await close(other);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('without JDFC_LAUNCHER the server keeps its old behaviour: fixed port, old message, EADDRINUSE on a busy port', async () => {
  const home = tmpDir('jdfc-launch-home-');
  const other = await dummy();
  const busy = other.address().port;
  let s;
  let f;
  try {
    f = runServer(busy, home);
    assert.notEqual(await f.exited, 0);
    assert.match(f.log(), /EADDRINUSE/);
    assert.doesNotMatch(f.log(), /Keep this window open|already running/);

    await close(other);
    s = runServer(busy, home);
    const log = await s.waitFor(/running at/);
    assert.match(log, new RegExp(`JD Fit Checker running at http://127\\.0\\.0\\.1:${busy} {2}\\(profile store: `));
    assert.doesNotMatch(log, /Keep this window open/);
    assert.equal((await get(busy, '/api/health')).status, 200);
  } finally {
    if (s) await s.stop();
    if (f) await f.stop();
    if (other.listening) await close(other);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
