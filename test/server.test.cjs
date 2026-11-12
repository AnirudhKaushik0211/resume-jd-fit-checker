'use strict';

// Profile-scoped HTTP routes: isolation between profiles, unknown profiles, old unscoped routes, Host / Origin guards.
// Temp JDFC_HOME with two template profiles; server on an ephemeral port (listen(0) + setPort).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { tempHome, minimalDocx } = require('./helpers.cjs');

const env = tempHome();
const rootA = env.install('alpha', { name: 'Alpha' });
env.install('beta', { name: 'Beta' });
fs.writeFileSync(path.join(rootA, 'resumes', 'Alpha_Base.docx'), minimalDocx(['Alpha Person', 'Core Skills: SQL | Roadmapping', 'Built dashboards for 20 teams.']));
const pfA = path.join(rootA, 'config', 'profile.json');
const profA = JSON.parse(fs.readFileSync(pfA, 'utf8'));
profA.evidence = [{ id: 'ev-dash', claim: 'Built dashboards', brief: 'Dashboards', detect: 'ZZ never present', skillLabel: 'Dashboards' }];
fs.writeFileSync(pfA, JSON.stringify(profA));

const { createServer, setPort, ROUTES } = require('../server.cjs');
let server;
let port;

test.before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  setPort(port);
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  env.cleanup();
});

function request(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...(data !== null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary / html */ }
        resolve({ status: res.statusCode, json, buf, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

const fill = (pattern, id) => pattern.replace(':id', id).replace(':job', 'job-none').replace(':file', 'Missing.docx');
const profileRoutes = ROUTES.filter((r) => r.scope === 'profile');

test('ROUTES table is exported and every data route is profile-scoped', () => {
  assert.ok(profileRoutes.length >= 23);
  for (const r of ROUTES) assert.ok(['global', 'profile'].includes(r.scope));
  for (const r of profileRoutes) assert.ok(r.pattern.startsWith('/api/p/:id/') || r.pattern.startsWith('/p/:id/'), r.pattern);
  const globals = ROUTES.filter((r) => r.scope === 'global').map((r) => `${r.method} ${r.pattern}`);
  assert.deepEqual(globals.sort(), ['GET /', 'GET /api/directions', 'GET /api/health', 'GET /api/profiles', 'GET /index.html', 'POST /api/demo/reset', 'POST /api/fetch', 'POST /api/profiles', 'POST /api/profiles/:id/lock', 'POST /api/profiles/:id/reset', 'POST /api/profiles/:id/unlock'].sort());
});

test('every profile route answers for its own profile and 404s for an unknown or invalid profile', async () => {
  for (const r of profileRoutes) {
    const own = await request(r.method, fill(r.pattern, 'alpha'), r.method === 'POST' ? {} : undefined);
    assert.notEqual(own.json && own.json.code, 'UNKNOWN_PROFILE', `${r.method} ${r.pattern} own profile`);
    assert.ok(own.status < 500, `${r.method} ${r.pattern} own profile -> ${own.status} ${own.buf.toString().slice(0, 200)}`);
    for (const ghost of ['ghost', 'BAD!ID', 'x']) {
      const g = await request(r.method, fill(r.pattern, encodeURIComponent(ghost)), r.method === 'POST' ? {} : undefined);
      assert.equal(g.status, 404, `${r.method} ${r.pattern} via ${ghost}`);
    }
  }
});

test('global routes: /api/health carries no profile data, /api/profiles lists both, /api/directions catalog', async () => {
  const h = await request('GET', '/api/health');
  assert.equal(h.status, 200);
  assert.deepEqual(Object.keys(h.json).sort(), ['ok', 'port', 'profiles', 'version']);
  assert.equal(h.json.profiles, 2);
  const p = await request('GET', '/api/profiles');
  assert.deepEqual(p.json.profiles.map((x) => x.id), ['alpha', 'beta']);
  const d = await request('GET', '/api/directions');
  assert.ok(d.json.directions.length > 3 && d.json.directions.every((x) => x.id && x.label && ['target', 'avoid'].includes(x.class)));
  const ph = await request('GET', '/api/p/alpha/health');
  assert.equal(ph.json.resumeCount, 1);
  assert.equal(ph.json.profile.id, 'alpha');
  assert.equal(ph.json.log, 'applications');
});

test('downloads are confined to the profile: A file via A ok, via B 404, traversal 404', async () => {
  const ok = await request('GET', '/p/alpha/download/Alpha_Base.docx');
  assert.equal(ok.status, 200);
  assert.equal(ok.buf.subarray(0, 2).toString(), 'PK');
  assert.equal((await request('GET', '/p/beta/download/Alpha_Base.docx')).status, 404);
  assert.equal((await request('GET', '/p/alpha/download/..%2Fconfig%2Fprofile.json')).status, 404);
  assert.equal((await request('GET', '/p/alpha/download/%E0%A4%A')).status, 404);
});

test('old unscoped data routes are gone (404)', async () => {
  for (const [m, p] of [['GET', '/api/history'], ['GET', '/api/settings'], ['GET', '/api/stats'], ['GET', '/download/Alpha_Base.docx'], ['POST', '/api/analyze'], ['POST', '/api/application']]) {
    const r = await request(m, p, m === 'POST' ? {} : undefined);
    assert.equal(r.status, 404, `${m} ${p}`);
  }
});

test('foreign Host -> 403; cross-origin POST -> 403; non-JSON POST -> 415', async () => {
  assert.equal((await request('GET', '/api/profiles', undefined, { host: `evil.example:${port}` })).status, 403);
  assert.equal((await request('POST', '/api/p/alpha/analyze', {}, { origin: 'https://evil.example' })).status, 403);
  const same = await request('POST', '/api/p/alpha/analyze', {}, { origin: `http://127.0.0.1:${port}` });
  assert.equal(same.status, 200);
  const bad = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/p/alpha/analyze', headers: { host: `127.0.0.1:${port}`, 'content-type': 'text/plain' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end('x');
  });
  assert.equal(bad, 415);
});

test('a job started in profile A is not visible via profile B', async () => {
  const st = await request('POST', '/api/p/alpha/generate', { jdText: '' });
  assert.equal(st.status, 202);
  const id = st.json.jobId;
  assert.equal((await request('GET', `/api/p/beta/jobs/${id}`)).status, 404);
  let job;
  for (let i = 0; i < 50; i++) {
    job = await request('GET', `/api/p/alpha/jobs/${id}`);
    if (job.json.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(job.status, 200);
  assert.equal(job.json.profileId, 'alpha');
});

test('a propagation token issued in profile A is rejected under profile B', async () => {
  const pv = await request('POST', '/api/p/alpha/evidence/propagate/preview', { evidenceId: 'ev-dash', selectAll: true });
  assert.equal(pv.status, 200, JSON.stringify(pv.json));
  assert.ok(pv.json.confirmToken);
  const b = await request('POST', '/api/p/beta/evidence/propagate', { confirmToken: pv.json.confirmToken });
  assert.equal(b.status, 400);
  assert.equal(b.json.code, 'CONFIRM_REQUIRED');
});

test('analyze in a fresh profile sees only its own resumes and log', async () => {
  const jdText = ['Product Manager', 'Acme Corp', 'We need a product manager with SQL and roadmapping.', 'Own the roadmap with engineering and design.', 'Requirements: 2+ years product experience.'].join('\n');
  const a = await request('POST', '/api/p/alpha/analyze', { jdText, company: 'Acme Corp', title: 'Product Manager', options: { saveHistory: false } });
  assert.equal(a.json.ok, true);
  assert.deepEqual(a.json.bases.ranked.map((x) => x.name), ['Alpha_Base']);
  assert.equal(a.json.seenBefore.status, 'none');
  const b = await request('POST', '/api/p/beta/analyze', { jdText, company: 'Acme Corp', title: 'Product Manager', options: { saveHistory: false } });
  assert.equal(b.json.ok, true);
  assert.equal(b.json.bases.ranked.length, 0);
  assert.equal(b.json.bases.recommended, null);
});
