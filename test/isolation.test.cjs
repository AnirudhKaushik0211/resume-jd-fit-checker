'use strict';

// Cross-profile isolation (temp JDFC_HOME): the demo, a synthetic "owner-like" profile carrying a marker string, and a
// brand-new user created over HTTP. The new user's ATS matching, seen-before, repost, history, stats, repository,
// evidence and log only ever see its own data; other profiles' downloads, job ids and propagation tokens are refused.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { tempHome, minimalDocx } = require('./helpers.cjs');
const { buildDocx } = require('../lib/docx-write.cjs');
const profiles = require('../lib/profiles.cjs');

const MARKER = 'Zebraquokka';
const env = tempHome();
profiles.ensureDemo(env.home);
const markerRoot = env.install('marker', { name: `${MARKER} Owner` });
fs.writeFileSync(path.join(markerRoot, 'resumes', `${MARKER}_Base.docx`), minimalDocx([`${MARKER} Person`, 'Product Manager, Acme Payments | Jan 2020 - Present', 'Core Skills: SQL | Payments']));
const pf = path.join(markerRoot, 'config', 'profile.json');
fs.writeFileSync(pf, JSON.stringify({ ...JSON.parse(fs.readFileSync(pf, 'utf8')), name: `${MARKER} Person`, employer: `${MARKER} Corp`,
  evidence: [{ id: 'ev-marker', claim: `Ran ${MARKER} payments`, brief: MARKER, detect: MARKER, skillLabel: MARKER, dateAdded: '2026-01-01' }] }));
fs.writeFileSync(path.join(markerRoot, 'data', 'applications.json'), JSON.stringify([{ id: 'm1', date: '2026-06-01', company: 'Acme Payments', role: 'Product Manager, Payments', status: 'applied', resume: `${MARKER}_Base`, fit: 90, gaps: [], source: 'tool', recordedAt: '2026-06-01T00:00:00Z' }]));

const { createServer, setPort } = require('../server.cjs');
let server;
let port;
const jobs = [];

test.before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  setPort(port);
});
test.after(async () => {
  for (const [id, job] of jobs) await waitJob(id, job); // let background generation finish before the temp home goes
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
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
        resolve({ status: res.statusCode, json, buf });
      });
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}
async function waitJob(profile, id) {
  for (let i = 0; i < 300; i++) {
    const j = await request('GET', `/api/p/${profile}/jobs/${id}`);
    if (j.status !== 200 || j.json.status !== 'running') return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

const fixture = JSON.parse(fs.readFileSync(path.join(env.home, 'profiles', 'demo', 'fixtures', 'jds', '06-acme-payments-repeat.json'), 'utf8'));
const JD = { jdText: fixture.lines.join('\n'), company: fixture.company, title: fixture.title };
// Strings that only exist in the other profiles (demo candidate, demo resumes, marker profile).
const FOREIGN = [MARKER, 'Casey Sample', 'Brightwater', 'Demo_', 'PM_BASE_General', 'PM_Fintech_Payments', 'Ops_BASE_Analytics', 'Coho Winery', 'figma-prototyping'];
const assertClean = (label, payload) => {
  const s = JSON.stringify(payload);
  for (const f of FOREIGN) assert.ok(!s.includes(f), `${label} leaks "${f}"`);
};

test('the other profiles have data for the same JD (seen-before / repost / history)', async () => {
  for (const id of ['demo', 'marker']) {
    const a = await request('POST', `/api/p/${id}/analyze`, { ...JD, options: { saveHistory: true } });
    assert.equal(a.json.ok, true);
    assert.equal(a.json.seenBefore.status, 'repeat', `${id} logged this role`);
  }
  const again = await request('POST', '/api/p/marker/analyze', { ...JD, options: { saveHistory: false } });
  assert.equal(again.json.repost.isRepost, true, 'marker history now holds this JD');
});

test('a new user created over HTTP sees only its own upload, log and history', async () => {
  assert.equal((await request('POST', '/api/profiles', { id: 'fresh', name: 'Fresh Start' })).status, 201);
  const up = await request('POST', '/api/p/fresh/resumes', { fileName: 'My Resume.docx', family: 'pm', dataBase64: buildDocx(['Sam Newcomer', 'Product Manager, Lakeview Apps | Jan 2021 - Present', 'Core Skills: SQL | Payments | Roadmapping', 'Grew payments conversion by 9%.']).toString('base64') });
  assert.equal(up.status, 201, JSON.stringify(up.json));

  const a = await request('POST', '/api/p/fresh/analyze', { ...JD, options: { saveHistory: false } });
  assert.equal(a.json.ok, true);
  assert.deepEqual(a.json.bases.ranked.map((x) => x.name), ['My_Resume']);
  assert.equal(a.json.bases.recommended, 'My_Resume');
  assert.equal(a.json.seenBefore.status, 'none');
  assert.deepEqual(a.json.seenBefore.matches, []);
  assert.equal(a.json.repost.isRepost, false);
  assertClean('analyze', a.json);

  const views = {
    history: await request('GET', '/api/p/fresh/history'),
    stats: await request('GET', '/api/p/fresh/stats'),
    repo: await request('GET', '/api/p/fresh/repo'),
    evidence: await request('GET', '/api/p/fresh/evidence'),
    pending: await request('GET', '/api/p/fresh/pending'),
    resumes: await request('GET', '/api/p/fresh/resumes'),
    health: await request('GET', '/api/p/fresh/health'),
    draft: await request('GET', '/api/p/fresh/onboarding/draft'),
    candidates: await request('GET', '/api/p/fresh/evidence/candidates?id=figma-prototyping')
  };
  for (const [k, v] of Object.entries(views)) { assert.ok(v.status < 500, k); assertClean(k, v.json); }
  assert.deepEqual(views.history.json.entries, []);
  assert.equal(views.stats.json.totals.screened, 0);
  assert.deepEqual(views.repo.json.records.map((r) => r.name), ['My_Resume']);
  assert.deepEqual(views.evidence.json.evidence, []);
  assert.deepEqual(views.resumes.json.resumes.map((r) => r.name), ['My_Resume']);
  assert.equal(views.health.json.checklistEntries, 0);
  const apps = JSON.parse(fs.readFileSync(path.join(env.home, 'profiles', 'fresh', 'data', 'applications.json'), 'utf8'));
  assert.deepEqual(apps, []);
});

test('cross-profile downloads 404; other profiles\' job ids and propagation tokens are rejected', async () => {
  assert.equal((await request('GET', '/p/demo/download/Demo_PM_BASE_General.docx')).status, 200, 'sanity: the file exists in the demo');
  for (const f of ['Demo_PM_BASE_General.docx', `${MARKER}_Base.docx`, '..%2Fdemo%2Fresumes%2FDemo_PM_BASE_General.docx', '..%2F..%2Fdemo%2Fresumes%2FDemo_PM_BASE_General.docx']) {
    assert.equal((await request('GET', `/p/fresh/download/${f}`)).status, 404, f);
  }
  assert.equal((await request('GET', '/p/fresh/download/My_Resume.docx')).status, 200);

  const g = await request('POST', '/api/p/demo/generate', { ...JD });
  assert.equal(g.status, 202);
  jobs.push(['demo', g.json.jobId]);
  assert.equal((await request('GET', `/api/p/fresh/jobs/${g.json.jobId}`)).status, 404);
  assert.equal((await request('GET', `/api/p/marker/jobs/${g.json.jobId}`)).status, 404);

  const pv = await request('POST', '/api/p/demo/evidence/propagate/preview', { evidenceId: 'figma-prototyping', selectAll: true });
  assert.equal(pv.status, 200, JSON.stringify(pv.json));
  assert.ok(pv.json.confirmToken);
  for (const id of ['fresh', 'marker']) {
    const r = await request('POST', `/api/p/${id}/evidence/propagate`, { confirmToken: pv.json.confirmToken, evidenceId: 'figma-prototyping' });
    assert.equal(r.status, 400, id);
    assert.equal(r.json.code, 'CONFIRM_REQUIRED');
  }
  const done = await waitJob('demo', g.json.jobId);
  assert.equal(done.json.profileId, 'demo');
});
