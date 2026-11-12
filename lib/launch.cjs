'use strict';

// Double-click launcher support. server.cjs uses this only when JDFC_LAUNCHER=1 (set by "Start JD Fit Checker.cmd",
// "Start JD Fit Checker.command" and start.sh). Without that flag the server behaves exactly as before.
//  - listenWithFallback: try PORT, then the next ports (4317 -> 4318 .. 4330 by default). A busy port that answers
//    /api/health as this tool means "already running" (nothing new is started).
//  - browserCommand / openBrowser: open the URL in the default browser with an args array (no shell string).

const http = require('http');
const { spawn } = require('child_process');

const PORT_TRIES = 14; // 4317 .. 4330
const URL_RE = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}\/?$/;

// Command + args that open a local URL in the default browser. Only local tool URLs are accepted.
function browserCommand(url, platform = process.platform) {
  if (!URL_RE.test(String(url))) throw new Error(`Refusing to open a non-local URL: ${url}`);
  // cmd's built-in "start": the empty first argument is the window title, so the URL is never taken as the title.
  if (platform === 'win32') return { cmd: 'cmd.exe', args: ['/d', '/c', 'start', '', url] };
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  return { cmd: 'xdg-open', args: [url] };
}

// Fire-and-forget: the browser must not keep the server window busy, and a failure only prints a hint.
function openBrowser(url, { platform = process.platform, spawnImpl = spawn, log = console.log } = {}) {
  const { cmd, args } = browserCommand(url, platform);
  const hint = () => log(`Could not open the browser automatically. Open ${url} in your browser.`);
  try {
    const child = spawnImpl(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    if (child && typeof child.on === 'function') child.on('error', hint);
    if (child && typeof child.unref === 'function') child.unref();
  } catch {
    hint();
  }
  return { cmd, args };
}

// true when http://host:port/api/health answers like this tool (x-service-version / version contains "jdfc").
function probeTool(port, host = '127.0.0.1', timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/api/health', headers: { host: `${host}:${port}` }, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let version = String(res.headers['x-service-version'] || '');
        try { version += ` ${JSON.parse(Buffer.concat(chunks).toString('utf8')).version || ''}`; } catch { /* not json */ }
        resolve(res.statusCode === 200 && /jdfc/i.test(version));
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

function tryListen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.removeListener('listening', onListening); reject(error); };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

// Resolves { port, alreadyRunning, skipped } where skipped = busy ports used by other programs.
async function listenWithFallback(server, { port, host = '127.0.0.1', tries = PORT_TRIES, probe = probeTool, beforeListen = () => {} } = {}) {
  const skipped = [];
  for (let p = port; p < port + tries && p <= 65535; p += 1) {
    beforeListen(p);
    try {
      await tryListen(server, p, host);
      return { port: p, alreadyRunning: false, skipped };
    } catch (error) {
      if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') throw error;
      if (await probe(p, host)) return { port: p, alreadyRunning: true, skipped };
      skipped.push(p);
    }
  }
  const error = new Error(`Ports ${port}-${port + tries - 1} are all in use by other programs. Close one of them, or set PORT to another number.`);
  error.code = 'NO_FREE_PORT';
  throw error;
}

module.exports = { PORT_TRIES, browserCommand, openBrowser, probeTool, listenWithFallback };
