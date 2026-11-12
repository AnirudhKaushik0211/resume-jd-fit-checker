'use strict';

// Public package: build it into a temp --out, check it scans clean (allow-list, deny-list, owner-store hashes,
// forward-slash zip), then start the PACKAGED server on an empty temp JDFC_HOME and smoke-test the demo and the
// onboarding flow over HTTP. Everything runs in temp folders that are removed afterwards.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { tmpDir } = require('./helpers.cjs');
const { packagePublic } = require('../scripts/package-public.cjs');
const { listZipEntries } = require('../lib/docx.cjs');
const { scanTree } = require('../lib/denylist.cjs');
const { buildDocx } = require('../lib/docx-write.cjs');

function request(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...(data !== null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

function startServer(serverFile, port, home) {
  const env = { ...process.env, PORT: String(port), JDFC_HOME: home };
  delete env.NODE_TEST_CONTEXT;
  delete env.JDFC_PROFILE;
  const child = spawn(process.execPath, [serverFile], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${log}`)), 15000);
    child.stdout.on('data', (c) => { log += c; if (/running at/.test(log)) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', (c) => { log += c; });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${log}`)); });
  });
  return { child, ready, log: () => log };
}

test('packaged copy scans clean and its server serves the demo and onboarding on an empty home', async () => {
  const work = tmpDir('jdfc-pkg-');
  const home = tmpDir('jdfc-pkg-home-');
  const out = path.join(work, 'jd-fit-checker-public');
  let srv;
  try {
    const r = packagePublic({ out });
    assert.equal(r.ok, true, JSON.stringify({ problems: r.problems, deny: r.denyHits.length, hash: r.hashHits }));
    assert.deepEqual(r.problems, []);
    assert.equal(r.denyHits.length, 0);
    assert.deepEqual(r.hashHits, []);
    assert.equal(scanTree(out).length, 0);
    for (const f of ['server.cjs', 'index.html', 'README.md', 'lib/profiles.cjs', 'defaults/rules.json', 'profiles-seed/demo/profile.meta.json', 'profiles-seed/_template/profile.meta.json', 'scripts/package-public.cjs']) {
      assert.ok(fs.existsSync(path.join(out, f)), `${f} shipped`);
    }
    for (const f of ['scripts/migrate-owner.cjs', 'scripts/e2e-generate.cjs', 'scripts/templates', 'config', 'data', 'dist']) {
      assert.equal(fs.existsSync(path.join(out, f)), false, `${f} not shipped`);
    }
    const entries = listZipEntries(fs.readFileSync(`${out}.zip`)).map((e) => e.name);
    assert.equal(entries.length, r.files.length);
    assert.ok(entries.every((n) => !n.includes('\\') && n.startsWith('jd-fit-checker-public/')));

    const port = 4390 + Math.floor(Math.random() * 500);
    srv = startServer(path.join(out, 'server.cjs'), port, home);
    await srv.ready;

    const list = await request(port, 'GET', '/api/profiles');
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.profiles.map((p) => p.id), ['demo'], 'an empty home gets only the demo');

    const fx = JSON.parse(fs.readFileSync(path.join(out, 'profiles-seed', 'demo', 'fixtures', 'jds', '01-litware-checkout.json'), 'utf8'));
    const a = await request(port, 'POST', '/api/p/demo/analyze', { jdText: fx.lines.join('\n'), company: fx.company, title: fx.title, options: { saveHistory: false } });
    assert.equal(a.status, 200, a.text);
    assert.equal(a.json.verdict.key, 'apply_as_is');
    assert.equal(a.json.bases.recommended, 'PM_BASE_General');

    const c = await request(port, 'POST', '/api/profiles', { id: 'newcomer', name: 'New Comer' });
    assert.equal(c.status, 201, c.text);
    const lines = ['Sam Placeholder', 'Product Manager, Contoso Labs | Jan 2021 - Present', 'Core Skills: SQL | Roadmapping | Jira', 'Grew activation by 15% in 2 quarters.', 'MBA, Riverton School of Management, 2020'];
    const up = await request(port, 'POST', '/api/p/newcomer/resumes', { fileName: 'Sam_Resume.docx', family: 'pm', dataBase64: buildDocx(lines).toString('base64') });
    assert.equal(up.status, 201, up.text);
    assert.deepEqual(up.json.resumes.map((x) => x.name), ['Sam_Resume']);
    const d = await request(port, 'GET', '/api/p/newcomer/onboarding/draft');
    assert.equal(d.status, 200, d.text);
    assert.ok(d.json.draft.totalYears > 0);
    assert.ok(d.json.draft.titles.some((t) => /Product Manager/.test(t)));
    assert.ok(fs.existsSync(path.join(home, 'profiles', 'newcomer', 'resumes', 'Sam_Resume.docx')), 'data lands in the temp home, not the package');
    assert.equal(fs.existsSync(path.join(out, 'profiles')), false);
  } finally {
    if (srv) {
      const exited = new Promise((resolve) => { if (srv.child.exitCode !== null) resolve(); else srv.child.once('exit', resolve); });
      srv.child.kill();
      await exited;
    }
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(work), false);
  assert.equal(fs.existsSync(home), false);
});
