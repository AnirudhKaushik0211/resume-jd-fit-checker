'use strict';

// analyze() on the synthetic demo profile: result shape and card order, threshold bands, seen-before from
// data\applications.json, repost detection against a temp copy of the history. Temp JDFC_HOME only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempHome, tmpDir } = require('./helpers.cjs');
const profiles = require('../lib/profiles.cjs');
const { loadConfig } = require('../lib/config.cjs');
const { buildContext, analyze } = require('../lib/analyze.cjs');
const { loadFixtures } = require('../lib/calibration.cjs');

const env = tempHome();
const root = profiles.ensureDemo(env.home);
env.use('demo');
const ctx = buildContext(loadConfig({ profile: 'demo' }), { persistRepo: false });
ctx.historyFile = null;
const scratch = tmpDir('jdfc-hist-');
test.after(() => { fs.rmSync(scratch, { recursive: true, force: true }); env.cleanup(); });
const fixtures = loadFixtures(path.join(root, 'fixtures', 'jds'));
const fx = (id) => fixtures.find((f) => f.id === id);
const run = (id, options = {}) => { const f = fx(id); return analyze({ jdText: f.text, company: f.company, title: f.title }, ctx, { ignoreHistory: true, saveHistory: false, ...options }); };

test('result shape and card order (UI renders in this order)', () => {
  const r = run('litware-checkout');
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r), ['ok', 'threshold', 'input', 'seenBefore', 'verdict', 'direction', 'level', 'gates', 'blockers', 'fit', 'keywords', 'bases', 'tailor', 'improvements', 'honesty', 'interview', 'whyRole', 'logEntry', 'repost', 'redFlags']);
  assert.equal(r.input.company, 'Litware');
  assert.equal(r.verdict.key, 'apply_as_is');
  assert.equal(r.bases.recommended, 'PM_BASE_General');
  assert.ok(r.bases.ranked.every((b) => b.name && typeof b.score === 'number'));
  assert.equal(r.fit.breakdown.length, 5);
  assert.equal(r.tailor.command, null, 'builtin generator: no PowerShell command is offered');
  assert.equal(r.logEntry.checklistPath, null, 'applications log: no checklist path');
  assert.equal(r.honesty.ok, true);
  assert.ok(r.whyRole.text.includes('Litware'));
  assert.equal(analyze({ jdText: 'too short' }, ctx).code, 'EMPTY_JD');
});

test('threshold bands: the salvage fixture is Tailor (salvage) at T=75 and Tailor (light) at T=55', () => {
  const t75 = run('northwind-growth', { threshold: 75 });
  const t55 = run('northwind-growth', { threshold: 55 });
  assert.equal(t75.threshold.threshold, 75);
  assert.equal(t75.threshold.tailorFloor, 55);
  assert.equal(t55.threshold.tailorFloor, 35);
  assert.equal(t75.verdict.key, 'tailor_salvage');
  assert.equal(t75.verdict.needsUserDecision, true);
  assert.equal(t55.verdict.key, 'tailor_light');
  assert.equal(t75.fit.score, t55.fit.score, 'the threshold never changes the score');
  assert.ok(t75.tailor.projectedFit > t75.fit.score && t75.tailor.projectedFit < 75);
  const swap = t75.tailor.edits.find((e) => e.kind === 'skill-swap');
  assert.equal(swap.new, 'Figma prototyping | Confluence', 'newest evidence skill label (recency)');
  assert.equal(run('wingtip-sap', { threshold: 40 }).verdict.key, 'skip', 'a hard gate skips at any threshold');
});

test('seen-before: a logged application in applications.json makes the repeat fixture Skip (repeat)', () => {
  const r = run('acme-payments-repeat', { ignoreHistory: false });
  assert.equal(r.seenBefore.status, 'repeat');
  assert.equal(r.verdict.key, 'skip_repeat');
  assert.match(r.verdict.reason, /PM_Acme_Payments/);
  const fresh = run('litware-checkout', { ignoreHistory: false });
  assert.notEqual(fresh.seenBefore.status, 'repeat');
  assert.notEqual(fresh.verdict.key, 'skip_repeat');
});

test('repost detection against a temp copy of the demo history (seed history unchanged)', () => {
  const src = path.join(root, 'data', 'history.json');
  const before = fs.readFileSync(src, 'utf8');
  const copy = path.join(scratch, 'history.json');
  fs.copyFileSync(src, copy);
  const c2 = { ...ctx, historyFile: copy };
  const f = fx('fabrikam-analyst');
  const r = analyze({ jdText: f.text, company: f.company, title: f.title }, c2, { saveHistory: true });
  assert.equal(r.repost.isRepost, true);
  assert.equal(r.repost.previous.company, 'Fabrikam');
  const g = fx('northwind-growth');
  assert.equal(analyze({ jdText: g.text, company: g.company, title: g.title }, c2, { saveHistory: false }).repost.isRepost, false);
  assert.equal(JSON.parse(fs.readFileSync(copy, 'utf8')).length, JSON.parse(before).length + 1, 'the check was saved to the copy');
  assert.equal(fs.readFileSync(src, 'utf8'), before);
});
