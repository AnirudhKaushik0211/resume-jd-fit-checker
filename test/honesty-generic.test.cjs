'use strict';

// Generic honesty guard (profiles with honestyMode "generic"): title inflation and unverifiable metrics are flagged
// against the resume the text goes into; the profile's own forbidden claims still apply. Temp JDFC_HOME only.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tempHome } = require('./helpers.cjs');
const profiles = require('../lib/profiles.cjs');
const { loadConfig } = require('../lib/config.cjs');
const { buildContext, analyze } = require('../lib/analyze.cjs');
const { honestyGuard } = require('../lib/advice.cjs');
const { loadFixtures } = require('../lib/calibration.cjs');

const env = tempHome();
const root = profiles.ensureDemo(env.home);
env.use('demo');
test.after(() => env.cleanup());
const config = loadConfig({ profile: 'demo' });
const ctx = buildContext(config, { persistRepo: false });
ctx.historyFile = null;
const general = ctx.resumes.find((r) => r.name === 'PM_BASE_General').text;
const ids = (flags) => flags.map((f) => f.id);

test('title inflation: a seniority/title word the resume does not contain is flagged', () => {
  assert.deepEqual(ids(honestyGuard('Senior Product Manager who owned checkout', config, 'pm', { resumeText: general })), ['title-inflation']);
  assert.deepEqual(ids(honestyGuard('Head of Payments at Brightwater Commerce', config, 'pm', { resumeText: general })), ['title-inflation']);
  assert.deepEqual(ids(honestyGuard('Product Manager who owned the checkout roadmap', config, 'pm', { resumeText: general })), [], '"manager" is in the resume');
  assert.deepEqual(ids(honestyGuard('Seeking a Senior Product Manager role in payments.', config, 'pm', { resumeText: general })), [], 'an aspiration is not a claimed title');
});

test('unverifiable metric: a number in neither the resume nor the evidence bank is flagged', () => {
  assert.deepEqual(ids(honestyGuard('Grew revenue 40% in a quarter', config, 'pm', { resumeText: general })), ['unverifiable-metric']);
  assert.deepEqual(ids(honestyGuard('Ran 12 A/B tests, lifting conversion 6%', config, 'pm', { resumeText: general })), [], 'metrics from the resume');
  assert.deepEqual(ids(honestyGuard('Cut failed payments 8%', config, 'pm', { resumeText: general })), [], '8% is backed by an evidence claim');
  assert.deepEqual(ids(honestyGuard('Shipped 3 features', config, 'pm', { resumeText: general })), [], 'single bare digits are not treated as metrics');
});

test("the profile's own forbidden claims still apply; honest text passes", () => {
  assert.deepEqual(ids(honestyGuard('Managed a team of engineers', config, 'pm', { resumeText: general })), ['people-mgmt']);
  assert.deepEqual(ids(honestyGuard('Ran product discovery with 40 customer interviews and prioritized the backlog in Jira.', config, 'pm', { resumeText: general })), []);
});

test('generic checks run only with honestyMode generic and a resumeText (owner-style profiles are unchanged)', () => {
  const ownerLike = { ...config, profile: { ...config.profile } };
  delete ownerLike.profile.honestyMode;
  assert.deepEqual(ids(honestyGuard('Senior Product Manager, grew revenue 40%', ownerLike, 'pm', { resumeText: general })), []);
  assert.deepEqual(ids(honestyGuard('Senior Product Manager, grew revenue 40%', config, 'pm')), [], 'no resumeText -> forbidden list only');
});

test('buildEdits drops a skill swap whose label would inflate the title (analyze honesty stays clean)', () => {
  const fx = loadFixtures(path.join(root, 'fixtures', 'jds')).find((f) => f.id === 'northwind-growth');
  const inflated = { ...config, profile: { ...config.profile, evidence: config.profile.evidence.map((e) => (e.id === 'figma-prototyping' ? { ...e, skillLabel: 'Head of Figma design' } : e)) } };
  const r = analyze({ jdText: fx.text, company: fx.company, title: fx.title }, { ...ctx, config: inflated }, { ignoreHistory: true, saveHistory: false });
  assert.ok(!r.tailor.edits.some((e) => e.kind === 'skill-swap'), JSON.stringify(r.tailor.edits));
  assert.ok(r.tailor.notes.some((n) => /Dropped skill swap: honesty guard flagged title-inflation/.test(n)), r.tailor.notes.join(' | '));
  assert.equal(r.honesty.ok, true);
  const honest = analyze({ jdText: fx.text, company: fx.company, title: fx.title }, ctx, { ignoreHistory: true, saveHistory: false });
  assert.ok(honest.tailor.edits.some((e) => e.kind === 'skill-swap'));
  assert.equal(honest.honesty.ok, true);
});
