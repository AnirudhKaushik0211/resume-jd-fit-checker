'use strict';

// End-to-end smoke test against a real server process. Writes nothing to the resumes or the log.
// Usage (from jd-fit-checker): node scripts\smoke.cjs <public-job-url> <linkedin-job-url> [--profile <id>] [--expect-base <name>]
// Uses the profile's routes (/api/p/<id>/...) and its first calibration fixture. Owner-specific expectations
// (the recommended base) are asserted only when --expect-base is given.

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const { profileFromArgv } = require('../lib/profiles.cjs');
const { loadConfig } = require('../lib/config.cjs');
const { loadFixtures } = require('../lib/calibration.cjs');

const PORT = Number(process.env.SMOKE_PORT || 4317);
const PROFILE = profileFromArgv();
const P = `/api/p/${PROFILE}`;
const ebi = process.argv.indexOf('--expect-base');
const expectBase = ebi > 0 ? process.argv[ebi + 1] : null;
const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !['--profile', '--expect-base'].includes(all[i - 1]));
const [publicUrl, linkedinUrl] = positional;
const results = [];
const record = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`); };

function request(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: { host: `127.0.0.1:${PORT}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers }, timeout: 60000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* html */ }
        resolve({ status: res.statusCode, text, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.cjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  try {
    let health = null;
    for (let i = 0; i < 60 && !health; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try { const h = await request('GET', `${P}/health`); if (h.status === 200) health = h.json; } catch { /* not up yet */ }
    }
    record(`server starts on 127.0.0.1 and ${P}/health answers`, Boolean(health), health ? `${health.resumeCount} resumes, ${health.baseCount} bases, ${health.checklistEntries} log items, T=${health.threshold.def}` : log.slice(0, 300));
    if (!health) return;

    const page = await request('GET', '/');
    record('GET / serves the HTML UI', page.status === 200 && /<html/i.test(page.text), `${page.status}, ${page.text.length} bytes`);

    const badHost = await request('GET', '/api/health', null, { host: 'evil.example:4317' });
    record('foreign Host header is rejected (403)', badHost.status === 403);
    const badOrigin = await request('POST', `${P}/analyze`, { jdText: 'x' }, { origin: 'https://evil.example' });
    record('cross-origin POST is rejected (403)', badOrigin.status === 403);
    const oldRoute = await request('GET', '/api/history');
    record('old unscoped data route is gone (404)', oldRoute.status === 404);

    const fx = loadFixtures(loadConfig({ profile: PROFILE }).paths.fixturesDir)[0];
    if (!fx) { record('profile has a calibration fixture', false, 'no fixtures in the profile'); return; }
    const a = await request('POST', `${P}/analyze`, { jdText: fx.text, company: fx.company, title: fx.title, threshold: 55, options: { ignoreHistory: true, saveHistory: false } });
    const j = a.json || {};
    record(`POST ${P}/analyze (${fx.id}, T=55) returns verdict/fit/base`, a.status === 200 && j.ok && j.verdict && typeof j.fit.score === 'number' && (!expectBase || j.bases.recommended === expectBase),
      `verdict ${j.verdict && j.verdict.key}, fit ${j.fit && j.fit.score}%, base ${j.bases && j.bases.recommended}${expectBase ? ` (expected ${expectBase})` : ''}, T ${j.threshold && j.threshold.threshold}`);
    const a75 = await request('POST', `${P}/analyze`, { jdText: fx.text, company: fx.company, title: fx.title, options: { ignoreHistory: true, saveHistory: false } });
    record('default threshold 75 applies when none is sent', a75.json && a75.json.threshold.threshold === 75, `verdict at 75: ${a75.json && a75.json.verdict.key}`);

    const file = await request('POST', '/api/fetch', { url: 'file:///C:/Windows/win.ini' });
    record('file:// URL rejected (INVALID_URL)', file.json && file.json.code === 'INVALID_URL', file.json && file.json.message);
    const local = await request('POST', '/api/fetch', { url: 'http://127.0.0.1:4317/api/health' });
    record('loopback URL rejected (SSRF guard)', local.json && !local.json.ok && ['INVALID_URL', 'BLOCKED_URL'].includes(local.json.code), local.json && local.json.message);

    if (publicUrl) {
      const f = await request('POST', '/api/fetch', { url: publicUrl });
      const fj = f.json || {};
      record(`public job URL fetch (${publicUrl})`, fj.ok === true && fj.text && fj.text.length > 400, fj.ok ? `source ${fj.source}, title "${fj.title}", company "${fj.company}", ${fj.text.length} chars` : `${fj.code}: ${fj.message}`);
    } else record('public job URL fetch', false, 'no URL given');
    if (linkedinUrl) {
      const l = await request('POST', '/api/fetch', { url: linkedinUrl });
      const lj = l.json || {};
      record(`LinkedIn URL -> graceful "paste instead" (${linkedinUrl})`, lj.ok === false && lj.code === 'PASTE_INSTEAD', `${lj.code}: ${lj.message}`);
    } else record('LinkedIn fallback', false, 'no URL given');

    const dl = await request('GET', `/p/${PROFILE}/download/..%2Fpackage.json`);
    record('download route rejects traversal (404)', dl.status === 404);
    const stats = await request('GET', `${P}/stats?range=all`);
    record(`GET ${P}/stats`, stats.json && stats.json.ok && stats.json.totals.screened > 0, stats.json && `screened ${stats.json.totals.screened}, applied ${stats.json.totals.applied}, undated ${stats.json.undated.screened}`);
    const cal = await request('GET', `${P}/calibration?threshold=75`);
    record(`GET ${P}/calibration`, cal.json && cal.json.rank.ok && cal.json.rows.every((r) => r.pass), cal.json && `${cal.json.rows.filter((r) => r.pass).length}/${cal.json.rows.length} pass, rank ${cal.json.rank.ok ? 'ok' : 'violated'}`);
    const noTok = await request('POST', `${P}/evidence/propagate`, { evidenceId: 'x' });
    record('propagation without a confirm token is rejected (400)', noTok.status === 400);
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 500));
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} smoke checks passed; server stopped.`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
