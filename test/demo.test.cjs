'use strict';

// Synthetic demo profile: seed install, calibration, builtin generation (new file, _v2 naming), propagation
// (bases in place with backup, submitted copies promoted once to <name>_v2.docx), Reset demo. Temp JDFC_HOME only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { tempHome } = require('./helpers.cjs');
const profiles = require('../lib/profiles.cjs');
const { loadConfig } = require('../lib/config.cjs');
const { buildContext } = require('../lib/analyze.cjs');
const { runCalibration, checkRankOrder, loadFixtures } = require('../lib/calibration.cjs');
const actions = require('../lib/actions.cjs');
const { docxParagraphs } = require('../lib/docx.cjs');

const env = tempHome();
test.after(() => env.cleanup());
const root = profiles.ensureDemo(env.home);
env.use('demo');
const SEED = path.join(profiles.SEED_DIR, 'demo');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const ctxFresh = () => buildContext(loadConfig({ profile: 'demo' }));
const fixture = (id) => loadFixtures(path.join(root, 'fixtures', 'jds')).find((f) => f.id === id);

test('ensureDemo installs the seed once (kind demo, builtin generator, applications log) and it loads with 0 warnings', () => {
  assert.equal(root, path.join(env.home, 'profiles', 'demo'));
  assert.equal(profiles.ensureDemo(env.home), null, 'second call is a no-op');
  assert.deepEqual(profiles.listProfiles().find((p) => p.id === 'demo'), { id: 'demo', name: 'Demo (fictional candidate)', kind: 'demo', protected: false });
  const ctx = buildContext(loadConfig({ profile: 'demo' }), { persistRepo: false });
  assert.deepEqual(ctx.warnings, []);
  assert.equal(ctx.config.generator, 'builtin');
  assert.equal(ctx.config.log, 'applications');
  assert.equal(ctx.config.profile.honestyMode, 'generic');
  assert.equal(ctx.resumes.length, 7);
  assert.deepEqual(ctx.resumes.filter((r) => r.kind === 'base').map((r) => r.name).sort(), ['Ops_BASE_Analytics', 'PM_BASE_General', 'PM_Fintech_Payments']);
  assert.ok(ctx.checklist.length >= 15, 'applications.json feeds the log');
  const rec = (n) => ctx.repo.records[`Demo_${n}.docx`];
  assert.equal(rec('PM_Fintech_Payments').derivedFrom, 'PM_BASE_General');
  assert.equal(rec('PM_Acme_Payments').type, 'submitted copy');
  assert.equal(rec('PM_Acme_Payments').derivedFrom, 'PM_Fintech_Payments');
  assert.ok(rec('PM_Acme_Payments').appliedTo.some((a) => a.company === 'Acme Payments'));
  assert.equal(rec('PM_Acme_Payments_v2').type, 'variant');
  assert.equal(rec('Ops_Globex_Supply').derivedFrom, 'Ops_BASE_Analytics');
  assert.equal(rec('PM_Initech_Growth').type, 'generated-pending');
  // Every evidence item is dated; the newest one (Figma) is in no resume yet.
  assert.ok(ctx.config.profile.evidence.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.dateAdded) && e.detect));
  assert.ok(ctx.resumes.every((r) => !/Figma/.test(r.text)));
});

test('calibration: every demo fixture passes and rank order is preserved', () => {
  const ctx = buildContext(loadConfig({ profile: 'demo' }), { persistRepo: false });
  ctx.historyFile = null;
  const rows = runCalibration(ctx);
  assert.equal(rows.length, 6);
  for (const r of rows) assert.ok(r.pass, `${r.fixture}: ${JSON.stringify(r.checks)} ${r.flagFails.join('; ')}`);
  assert.equal(checkRankOrder(rows).ok, true);
});

test('builtin generateForJd creates a NEW file (base untouched), and a rerun gets _v2 naming', async () => {
  const ctx = ctxFresh();
  ctx.historyFile = null;
  const fx = fixture('northwind-growth');
  const baseFile = path.join(root, 'resumes', 'Demo_PM_BASE_General.docx');
  const before = sha(baseFile);
  const body = { jdText: fx.text, company: fx.company, title: fx.title };
  const r1 = await actions.generateForJd(ctx, body);
  assert.equal(r1.ok, true, `${r1.status}: ${r1.message} ${JSON.stringify((r1.attempts || []).map((a) => a.stdoutTail))}`);
  assert.equal(r1.targetName, 'Demo_PM_NorthwindTraders_Growth.docx');
  assert.equal(r1.download, '/download/Demo_PM_NorthwindTraders_Growth.docx');
  assert.ok(docxParagraphs(r1.targetPath).some((p) => p.includes('Figma prototyping | Confluence')));
  assert.ok(r1.finalFit >= r1.baselineFit, 'the generated file is rescored');
  assert.match(fs.readFileSync(path.join(root, 'reports', 'Demo_PM_NorthwindTraders_Growth.md'), 'utf8'), /Pages: 1 \(estimate\)/);
  assert.equal(ctx.repo.records[r1.targetName].type, 'generated-pending');
  assert.equal(ctx.repo.records[r1.targetName].derivedFrom, 'PM_BASE_General');
  const r2 = await actions.generateForJd(ctxFresh(), body);
  assert.equal(r2.ok, true);
  assert.equal(r2.targetName, 'Demo_PM_NorthwindTraders_Growth_v2.docx');
  assert.equal(sha(baseFile), before, 'base never edited by generation');
});

test('propagation: a base is updated in place with a backup; a submitted copy is promoted once to <name>_v2.docx and refused the second time', async () => {
  const ctx = ctxFresh();
  const sub = 'Demo_Ops_Globex_Supply.docx';
  const subBefore = sha(path.join(root, 'resumes', sub));
  const cands = actions.propagationCandidates(ctx, 'figma-prototyping');
  const row = cands.rows.find((r) => r.file === sub);
  assert.ok(row && !row.isBase && /promote once/.test(row.action), JSON.stringify(row));
  const plan = { evidenceId: 'figma-prototyping', files: ['Demo_PM_BASE_General.docx', sub], includeSubmitted: true };
  const p1 = actions.preparePropagation(ctx, plan);
  const p2 = actions.preparePropagation(ctx, plan);
  assert.equal(p1.plan.length, 2);
  const res1 = await actions.runPropagation(ctx, { confirmToken: p1.confirmToken });
  assert.equal(res1.ok, true, JSON.stringify(res1.results));
  const base = res1.results.find((r) => r.kind === 'base');
  assert.equal(base.status, 'updated');
  const dir = path.join(root, 'resumes');
  assert.ok(fs.readdirSync(dir).some((d) => /^_backup_\d{8}_\d{6}_Demo_PM_BASE_General$/.test(d)), 'in-place edit backed up first');
  assert.ok(docxParagraphs(path.join(dir, 'Demo_PM_BASE_General.docx')).some((p) => p.includes('Figma prototyping | Confluence')));
  const promoted = res1.results.find((r) => r.kind === 'submitted copy');
  assert.equal(promoted.newFile, 'Demo_Ops_Globex_Supply_v2.docx');
  assert.ok(fs.existsSync(path.join(dir, 'Demo_Ops_Globex_Supply_v2.docx')));
  assert.equal(sha(path.join(dir, sub)), subBefore, 'submitted copy never edited');
  assert.equal(ctx.repo.records['Demo_Ops_Globex_Supply_v2.docx'].type, 'variant');
  const res2 = await actions.runPropagation(ctx, { confirmToken: p2.confirmToken });
  const again = res2.results.find((r) => r.kind === 'submitted copy');
  assert.equal(again.ok, false);
  assert.match(again.message, /already exists/);
  assert.equal(sha(path.join(dir, sub)), subBefore);
});

test('Reset demo restores the seed (generated files gone, history/log/repo back to the seed)', () => {
  const ctx = ctxFresh();
  actions.recordApplication(ctx, { confirm: true, answer: 'applied', company: 'Litware', title: 'Product Manager, Checkout', resume: 'PM_BASE_General' });
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'data', 'applications.json'), 'utf8')).length > 15);
  fs.writeFileSync(path.join(root, 'data', 'history.json'), '[]');
  profiles.resetDemo(env.home);
  const seedFiles = fs.readdirSync(path.join(SEED, 'resumes')).sort();
  assert.deepEqual(fs.readdirSync(path.join(root, 'resumes')).sort(), seedFiles);
  for (const f of seedFiles) assert.equal(sha(path.join(root, 'resumes', f)), sha(path.join(SEED, 'resumes', f)), f);
  for (const f of ['data/history.json', 'data/applications.json', 'data/resume-repo.json', 'config/profile.json']) {
    assert.equal(fs.readFileSync(path.join(root, f), 'utf8'), fs.readFileSync(path.join(SEED, f), 'utf8'), f);
  }
  assert.equal(profiles.readMeta('demo').kind, 'demo');
  assert.ok(!fs.existsSync(path.join(root, 'reports')), 'transient run files removed');
});

test('resetDemo refuses a profile named demo that is not kind demo', () => {
  const env2 = tempHome();
  try {
    env2.install('demo', { kind: 'user' });
    assert.throws(() => profiles.resetDemo(env2.home), /not the demo profile/);
    assert.ok(fs.existsSync(path.join(env2.home, 'profiles', 'demo', 'profile.meta.json')));
  } finally {
    env2.cleanup();
    process.env.JDFC_HOME = env.home; // env2.cleanup restores the previous value; keep ours explicit
    process.env.JDFC_PROFILE = 'demo';
  }
});

test('POST /api/demo/reset needs confirm: true and returns the reloaded demo health', async () => {
  const { createServer, setPort } = require('../server.cjs');
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  setPort(port);
  const post = (body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/demo/reset', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(data);
  });
  try {
    fs.writeFileSync(path.join(root, 'data', 'history.json'), '[]');
    assert.equal((await post({})).status, 400);
    assert.equal(fs.readFileSync(path.join(root, 'data', 'history.json'), 'utf8'), '[]', 'nothing reset without confirm');
    const ok = await post({ confirm: true });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.profile.kind, 'demo');
    assert.equal(ok.json.resumeCount, 7);
    assert.equal(fs.readFileSync(path.join(root, 'data', 'history.json'), 'utf8'), fs.readFileSync(path.join(SEED, 'data', 'history.json'), 'utf8'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
