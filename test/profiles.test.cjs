'use strict';

// Profile store + profile-aware config loader + profile-path-driven modules. Temp JDFC_HOME only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempHome, minimalDocx } = require('./helpers.cjs');
const profiles = require('../lib/profiles.cjs');
const { loadConfig, deepMerge } = require('../lib/config.cjs');
const { buildContext, analyze, refreshLog } = require('../lib/analyze.cjs');
const { seenBefore } = require('../lib/checklist.cjs');
const apps = require('../lib/applications.cjs');
const actions = require('../lib/actions.cjs');
const storeIo = require('../lib/store-io.cjs');
const { loadHistory } = require('../lib/history.cjs');
const { loadRepo } = require('../lib/repo.cjs');

const env = tempHome();
test.after(() => env.cleanup());

const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('jdfcHome follows JDFC_HOME at call time; ids are validated', () => {
  assert.equal(profiles.jdfcHome(), path.resolve(env.home));
  for (const bad of ['', 'A', 'x', '-ab', 'ab_c', 'a'.repeat(33), '../x', 'ab/c']) assert.throws(() => profiles.profileRoot(bad), /Invalid profile id/, bad);
  assert.ok(profiles.validId('ab'));
  assert.ok(profiles.validId('demo-2'));
  assert.throws(() => loadConfig({ profile: 'Bad Id' }), /Invalid profile id/);
});

test('template profile is created, listed and loads with defaults (no personal data, builtin generator, applications log)', () => {
  const root = env.install('fresh', { name: 'Fresh User' });
  assert.equal(root, path.join(env.home, 'profiles', 'fresh'));
  assert.throws(() => env.install('fresh'), /already exists/);
  assert.deepEqual(profiles.listProfiles().find((p) => p.id === 'fresh'), { id: 'fresh', name: 'Fresh User', kind: 'user', protected: false });
  const c = loadConfig({ profile: 'fresh' });
  assert.equal(c.profileId, 'fresh');
  assert.equal(c.profileRoot, root);
  assert.equal(c.generator, 'builtin');
  assert.equal(c.log, 'applications');
  assert.equal(c.meta.kind, 'user');
  assert.equal(c.profile.honestyMode, 'generic');
  assert.equal(c.profile.evidence.length, 0);
  assert.equal(c.bases.length, 0);
  assert.ok(c.keywords.length > 80, 'default taxonomy loaded');
  assert.ok(c.keywords.every((k) => (k.evidence || []).length === 0 && k.forbidden === undefined), 'defaults carry no evidence links');
  const defaults = readJson(path.join(profiles.TOOL_DIR, 'defaults', 'rules.json'));
  assert.deepEqual(c.rules, defaults);
});

test('relative paths resolve under the profile root, null stays null; string arg = profile root; JDFC_PROFILE default', () => {
  const root = profiles.profileRoot('fresh');
  const c = loadConfig(root);
  assert.equal(c.paths.resumeDir, path.join(root, 'resumes'));
  assert.equal(c.paths.historyFile, path.join(root, 'data', 'history.json'));
  assert.equal(c.paths.fixturesDir, path.join(root, 'fixtures', 'jds'));
  assert.equal(c.paths.userEvidenceFile, path.join(root, 'config', 'evidence-added.json'));
  for (const k of ['baseMap', 'checklist', 'tailorScript', 'workSamplesDir']) assert.equal(c.paths[k], null, k);
  assert.equal(c.paths.resumeFilePrefix, '');
  env.use('fresh');
  assert.equal(loadConfig().profileId, 'fresh');
  delete process.env.JDFC_PROFILE;
  assert.throws(() => loadConfig(), /No profile selected/);
});

test('deepMerge: plain objects merge recursively, arrays and scalars replace, inputs untouched', () => {
  const base = { a: { x: 1, y: [1, 2], z: { k: 'v' } }, b: [1], c: 1 };
  const over = { a: { y: [9], z: { k2: 'w' } }, b: [2, 3], c: null };
  const m = deepMerge(base, over);
  assert.deepEqual(m, { a: { x: 1, y: [9], z: { k: 'v', k2: 'w' } }, b: [2, 3], c: null });
  assert.deepEqual(base, { a: { x: 1, y: [1, 2], z: { k: 'v' } }, b: [1], c: 1 });
});

test('profile rules.json deep-merges over defaults; bad threshold rejected', () => {
  const root = env.install('rules', {});
  const defaults = readJson(path.join(profiles.TOOL_DIR, 'defaults', 'rules.json'));
  writeJson(path.join(root, 'config', 'rules.json'), { applyThreshold: 60, level: { okMaxMinYears: 9 }, skipWords: ['zzz'] });
  const c = loadConfig({ profile: 'rules' });
  assert.equal(c.rules.applyThreshold, 60);
  assert.equal(c.rules.level.okMaxMinYears, 9);
  for (const k of Object.keys(defaults.level)) if (k !== 'okMaxMinYears') assert.deepEqual(c.rules.level[k], defaults.level[k], `level.${k} kept`);
  assert.deepEqual(c.rules.skipWords, ['zzz'], 'arrays replace');
  assert.deepEqual(c.rules.directions, defaults.directions);
  writeJson(path.join(root, 'config', 'rules.json'), { applyThreshold: 5 });
  assert.throws(() => loadConfig({ profile: 'rules' }), /applyThreshold/);
});

test('keywords-overrides links evidence / forbidden and adds keywords; unknown references rejected', () => {
  const root = env.install('links', {});
  const pf = path.join(root, 'config', 'profile.json');
  const profile = readJson(pf);
  profile.evidence = [{ id: 'ev-sql', claim: 'Wrote SQL reports', brief: 'SQL reports' }, { id: 'ev-kw', claim: 'Ran A/B tests', brief: 'A/B tests', keywords: ['zz_added'] }];
  profile.forbiddenClaims = [{ id: 'no-x', pattern: 'people manager', message: 'No people management.' }];
  writeJson(pf, profile);
  const kid = loadConfig({ profile: 'links' }).keywords[0].id;
  writeJson(path.join(root, 'config', 'keywords-overrides.json'), { links: { [kid]: { evidence: ['ev-sql'], forbidden: 'no-x' } }, add: [{ id: 'zz_added', canonical: 'ZZ Added', synonyms: ['zz added'], category: 'method', evidence: [] }] });
  const c = loadConfig({ profile: 'links' });
  const kw = c.keywords.find((k) => k.id === kid);
  assert.deepEqual(kw.evidence, ['ev-sql']);
  assert.equal(kw.forbidden, 'no-x');
  assert.deepEqual(c.keywords.find((k) => k.id === 'zz_added').evidence, ['ev-kw'], 'evidence.keywords linked into added keyword');
  writeJson(path.join(root, 'config', 'keywords-overrides.json'), { links: { [kid]: { evidence: ['nope'] } } });
  assert.throws(() => loadConfig({ profile: 'links' }), /unknown evidence id "nope"/);
  writeJson(path.join(root, 'config', 'keywords-overrides.json'), { links: { not_a_keyword: { evidence: [] } } });
  assert.throws(() => loadConfig({ profile: 'links' }), /unknown keyword id/);
});

test('template profile buildContext: no checklist, no base map -> no warnings; empty log', () => {
  const ctx = buildContext(loadConfig({ profile: 'fresh' }), { persistRepo: false });
  assert.deepEqual(ctx.warnings, []);
  assert.deepEqual(ctx.checklist, []);
  assert.equal(ctx.resumes.length, 0);
});

test('applications.json entries feed seen-before and are logged through the applications plugin', () => {
  const root = env.install('apps', {});
  const c = loadConfig({ profile: 'apps' });
  apps.appendApplication(c.paths.applicationsFile, { company: 'Northwind Traders', role: 'Product Manager, Payments', status: 'applied', resume: 'PM_Base', fit: 71 });
  const ctx = buildContext(loadConfig({ profile: 'apps' }), { persistRepo: false });
  assert.equal(ctx.checklist.length, 1);
  assert.equal(ctx.checklist[0].section, 'applications');
  const sb = seenBefore({ company: 'Northwind Traders', title: 'Product Manager, Payments' }, ctx.checklist, c.rules, c.profile);
  assert.equal(sb.status, 'repeat');
  // recordApplication with log "applications" appends to applications.json (no checklist involved)
  const r = actions.recordApplication(ctx, { confirm: true, answer: 'skip', company: 'Contoso', title: 'Growth PM', resume: 'PM_Base', fit: 40, threshold: 75, reason: 'too senior' });
  assert.equal(r.ok, true);
  assert.equal(r.backupPath, null);
  refreshLog(ctx);
  assert.equal(ctx.checklist.length, 2);
  const saved = readJson(path.join(root, 'data', 'applications.json'));
  assert.equal(saved[1].status, 'skipped');
  assert.equal(saved[1].reason, 'too senior');
});

test('CSV and markdown log import produce application entries', () => {
  const c = loadConfig({ profile: 'apps' });
  const csv = apps.parseCsvLog('date,company,role,status,resume,fit\n2026-01-05,"Acme, Inc",Product Owner,Applied,PM_Base,~65%\n2026-01-06,Globex,Analyst,skipped,,\n');
  assert.equal(csv.length, 2);
  assert.equal(csv[0].company, 'Acme, Inc');
  assert.equal(csv[0].fit, 65);
  assert.equal(csv[1].status, 'skipped');
  const md = apps.importMarkdown('- **2026-02-01 - Applied (confirmed):** Initech, Product Manager (PM_Base, ~60%).\n', c.rules, ['PM_Base']);
  assert.equal(md.length, 1);
  assert.equal(md[0].company, 'Initech');
  assert.equal(md[0].status, 'applied');
  assert.equal(md[0].resume, 'PM_Base');
});

test('uploads manifest: newest version per family is the base, older ones kept for lineage; analyze ranks only this profile', () => {
  const root = env.install('up', {});
  const lines = (v) => ['Jordan Example', 'Product Manager', `Core Skills: SQL | Roadmapping | Stakeholder management v${v}`, 'Experience', 'Built a reporting tool used by 40 analysts; cut prep time 30%.', 'Education: BSc Computer Science'];
  fs.writeFileSync(path.join(root, 'resumes', 'PM_General.docx'), minimalDocx(lines(1)));
  fs.writeFileSync(path.join(root, 'resumes', 'PM_General_v2.docx'), minimalDocx(lines(2)));
  writeJson(path.join(root, 'data', 'uploads.json'), [
    { file: 'PM_General.docx', family: 'pm', version: 1, uploadedAt: '2026-01-01T00:00:00Z', source: 'upload' },
    { file: 'PM_General_v2.docx', family: 'pm', version: 2, uploadedAt: '2026-02-01T00:00:00Z', source: 'upload' }
  ]);
  const ctx = buildContext(loadConfig({ profile: 'up' }));
  const byName = Object.fromEntries(ctx.resumes.map((r) => [r.name, r]));
  assert.equal(byName.PM_General_v2.kind, 'base');
  assert.equal(byName.PM_General.kind, 'submitted');
  assert.equal(byName.PM_General.label, 'older version - kept for lineage');
  assert.equal(ctx.repo.records['PM_General.docx'].derivedFrom === null || ctx.repo.records['PM_General.docx'].derivedFrom === undefined, true);
  assert.equal(ctx.repo.records['PM_General_v2.docx'].derivedFrom, 'PM_General');
  assert.ok(fs.existsSync(path.join(root, 'data', 'resume-repo.json')), 'repository persisted inside the profile');
  const jdText = ['Product Manager', 'Acme Corp', 'We need a product manager with SQL, roadmapping and stakeholder management.', 'You will own the roadmap and work with engineering and design.', 'Requirements: 2+ years of product experience; SQL.'].join('\n');
  const r = analyze({ jdText, company: 'Acme Corp', title: 'Product Manager' }, ctx, { ignoreHistory: true, saveHistory: false });
  assert.equal(r.ok, true);
  assert.equal(r.bases.recommended, 'PM_General_v2');
  assert.ok(r.bases.ranked.every((b) => ['PM_General', 'PM_General_v2'].includes(b.name)));
  assert.equal(r.tailor.command, null, 'no PowerShell command for the builtin generator');
  assert.equal(r.logEntry.checklistPath, null);
});

test('store-io: atomic JSON write, BOM strip; protected root without a key -> PROFILE_LOCKED and loaders rethrow', () => {
  const root = env.install('locked', {});
  const f = path.join(root, 'data', 'x.json');
  storeIo.writeJson(f, { a: 1 });
  assert.deepEqual(storeIo.readJson(f), { a: 1 });
  assert.ok(!fs.existsSync(`${f}.tmp`));
  fs.writeFileSync(f, '\uFEFF{"b":2}');
  assert.deepEqual(storeIo.readJson(f), { b: 2 });
  const meta = profiles.readMeta(root);
  profiles.writeMeta(root, { ...meta, protected: true });
  assert.throws(() => storeIo.writeJson(f, { c: 3 }), (e) => e.code === 'PROFILE_LOCKED');
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')), { b: 2 }, 'file untouched');
  const enc = path.join(root, 'data', 'history.json');
  fs.writeFileSync(enc, Buffer.concat([storeIo.MAGIC, Buffer.alloc(40)]));
  assert.throws(() => loadHistory(enc), (e) => e.code === 'PROFILE_LOCKED');
  fs.writeFileSync(path.join(root, 'data', 'resume-repo.json'), Buffer.concat([storeIo.MAGIC, Buffer.alloc(40)]));
  assert.throws(() => loadRepo(path.join(root, 'data', 'resume-repo.json')), (e) => e.code === 'PROFILE_LOCKED');
  assert.throws(() => apps.loadApplications(enc), (e) => e.code === 'PROFILE_LOCKED');
});
