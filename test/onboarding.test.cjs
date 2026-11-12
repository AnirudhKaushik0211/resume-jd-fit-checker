'use strict';

// Fresh-start onboarding over HTTP (temp JDFC_HOME, ephemeral port): create profile (with / without password),
// upload .docx versions (newest per family = base, older kept as lineage), paste text, PDF rejection, profile draft,
// confirm (profile.json + rules.json override), markdown / CSV log import feeding stats and seen-before.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { tempHome } = require('./helpers.cjs');
const { buildDocx, writeZip } = require('../lib/docx-write.cjs');
const { docxParagraphs } = require('../lib/docx.cjs');
const profiles = require('../lib/profiles.cjs');

const env = tempHome();
const { createServer, setPort } = require('../server.cjs');
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
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
        resolve({ status: res.statusCode, json, buf, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

const RESUME = [
  'Jordan Example',
  'Product Manager, Northwind Labs | Mar 2022 - Present',
  'Business Analyst, Contoso Retail | Jul 2019 - Feb 2022',
  'Core Skills: SQL | Roadmapping | A/B testing | Jira',
  'Grew checkout conversion by 12% across 3 markets.',
  'Cut reporting effort by 40 hrs per month with SQL dashboards.',
  'MBA, Riverton School of Management, 2019',
  'B.Sc. Statistics, Lakeside University, 2015',
  'Certifications: Google Analytics certification, Tableau Desktop Specialist'
];
const b64 = (lines) => buildDocx(lines).toString('base64');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const root = (id) => path.join(env.home, 'profiles', id);
const JD = ['Product Manager', 'Fabrikam', 'We are hiring a product manager to own the payments roadmap.', 'Work with engineering and design on checkout experiments.',
  'Requirements: 3+ years of product experience, SQL, A/B testing.', 'Nice to have: Jira, stakeholder management.'].join('\n');

test('create profile without a password: kind user from the template, listed, no cookie; duplicates and bad ids refused', async () => {
  const r = await request('POST', '/api/profiles', { id: 'newbie', name: 'New User' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual(r.json.profile, { id: 'newbie', name: 'New User', kind: 'user', protected: false, locked: false });
  assert.equal(r.headers['set-cookie'], undefined);
  const meta = profiles.readMeta('newbie');
  assert.equal(meta.kind, 'user');
  assert.equal(meta.protected, false);
  const list = (await request('GET', '/api/profiles')).json.profiles;
  assert.ok(list.some((p) => p.id === 'newbie' && p.name === 'New User'));
  const h = await request('GET', '/api/p/newbie/health');
  assert.equal(h.status, 200);
  assert.equal(h.json.resumeCount, 0);
  assert.equal((await request('POST', '/api/profiles', { id: 'newbie', name: 'Again' })).status, 409);
  for (const id of ['A', 'bad id', '../x', '']) assert.equal((await request('POST', '/api/profiles', { id })).status, 400, `id ${id}`);
  assert.equal((await request('POST', '/api/profiles', { id: 'cross' }, { origin: 'https://evil.example' })).status, 403);
});

test('create profile with a password: encrypted from the start, caller gets an unlocked session', async () => {
  const r = await request('POST', '/api/profiles', { id: 'secret-one', name: 'Secret', password: 'correct horse 42' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.profile.protected, true);
  const cookie = String(r.headers['set-cookie'][0]).split(';')[0];
  assert.match(String(r.headers['set-cookie'][0]), /HttpOnly; SameSite=Strict; Path=\//);
  assert.equal(profiles.readMeta('secret-one').protected, true);
  const pf = fs.readFileSync(path.join(root('secret-one'), 'config', 'profile.json'));
  assert.equal(pf.subarray(0, 8).toString(), 'JDFCENC1');
  assert.ok(!fs.readFileSync(path.join(root('secret-one'), 'profile.meta.json'), 'utf8').includes('correct horse'));
  assert.equal((await request('GET', '/api/p/secret-one/health')).status, 423);
  assert.equal((await request('GET', '/api/p/secret-one/health', undefined, { cookie })).status, 200);
  const up = await request('POST', '/api/p/secret-one/resumes', { fileName: 'Mine.docx', family: 'pm', dataBase64: b64(RESUME) }, { cookie });
  assert.equal(up.status, 201, JSON.stringify(up.json));
  assert.equal(fs.readFileSync(path.join(root('secret-one'), 'data', 'uploads.json')).subarray(0, 8).toString(), 'JDFCENC1');
  assert.equal((await request('POST', '/api/profiles', { id: 'empty-pw', password: 'x'.repeat(1025) })).status, 400);
  assert.equal(profiles.profileExists('empty-pw'), false, 'a refused password creates nothing');
});

test('upload: second version in a family becomes the base, older kept with lineage, never overwritten', async () => {
  const first = await request('POST', '/api/p/newbie/resumes', { fileName: 'Jordan Resume.docx', family: 'PM', dataBase64: b64(RESUME) });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.equal(first.json.upload.file, 'Jordan_Resume.docx');
  assert.equal(first.json.upload.family, 'pm');
  assert.equal(first.json.upload.version, 1);
  assert.equal(first.json.upload.source, 'docx');
  const v1 = path.join(root('newbie'), 'resumes', 'Jordan_Resume.docx');
  const v1sha = sha(v1);
  assert.deepEqual(first.json.resumes.map((r) => [r.name, r.kind]), [['Jordan_Resume', 'base']]);

  const updated = [...RESUME.slice(0, 3), 'Core Skills: SQL | Roadmapping | A/B testing | Jira | Figma', ...RESUME.slice(4)];
  const second = await request('POST', '/api/p/newbie/resumes', { fileName: 'Jordan Resume.docx', family: 'pm', dataBase64: b64(updated) });
  assert.equal(second.status, 201);
  assert.equal(second.json.upload.file, 'Jordan_Resume_v2.docx');
  assert.equal(second.json.upload.version, 2);
  assert.equal(sha(v1), v1sha, 'the first version is untouched');
  const byName = Object.fromEntries(second.json.resumes.map((r) => [r.name, r]));
  assert.equal(byName.Jordan_Resume_v2.kind, 'base');
  assert.equal(byName.Jordan_Resume_v2.previousVersion, 'Jordan_Resume');
  assert.equal(byName.Jordan_Resume.kind, 'submitted');
  assert.equal(byName.Jordan_Resume.label, 'older version - kept for lineage');

  const repo = await request('GET', '/api/p/newbie/repo');
  const rec = repo.json.records.find((r) => r.name === 'Jordan_Resume_v2');
  assert.equal(rec.derivedFrom, 'Jordan_Resume');
  const manifest = JSON.parse(fs.readFileSync(path.join(root('newbie'), 'data', 'uploads.json'), 'utf8'));
  assert.deepEqual(manifest.map((u) => [u.file, u.family, u.version, u.originalName]), [['Jordan_Resume.docx', 'pm', 1, 'Jordan Resume.docx'], ['Jordan_Resume_v2.docx', 'pm', 2, 'Jordan Resume.docx']]);

  const a = await request('POST', '/api/p/newbie/analyze', { jdText: JD, company: 'Fabrikam', title: 'Product Manager', options: { saveHistory: false } });
  assert.equal(a.json.ok, true);
  assert.equal(a.json.bases.recommended, 'Jordan_Resume_v2', 'newest version is the default base');
  assert.deepEqual(a.json.bases.ranked.map((x) => x.name).sort(), ['Jordan_Resume', 'Jordan_Resume_v2'], 'only this profile\'s uploads are ranked');
});

test('paste text builds a .docx; PDF is refused with 415 and the exact message; non-docx 400; 8 MB cap only on uploads', async () => {
  const p = await request('POST', '/api/p/newbie/resumes', { family: 'ops', fileName: 'Ops Paste', text: ['Jordan Example', 'Operations Analyst, Contoso Retail | Jul 2019 - Feb 2022', 'Core Skills: Excel | SQL', 'Built 5 weekly KPI reports.'].join('\r\n') });
  assert.equal(p.status, 201, JSON.stringify(p.json));
  assert.equal(p.json.upload.file, 'Ops_Paste.docx');
  assert.equal(p.json.upload.source, 'paste');
  assert.ok(p.json.resumes.some((r) => r.name === 'Ops_Paste' && r.kind === 'base' && r.family === 'ops'));
  assert.deepEqual(docxParagraphs(path.join(root('newbie'), 'resumes', 'Ops_Paste.docx'))[1], 'Operations Analyst, Contoso Retail | Jul 2019 - Feb 2022');
  const dl = await request('GET', '/p/newbie/download/Ops_Paste.docx');
  assert.equal(dl.status, 200);

  const msg = 'PDF not supported yet, export to .docx or paste text';
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n').toString('base64');
  for (const body of [{ fileName: 'cv.pdf', family: 'pm', dataBase64: pdf }, { fileName: 'cv.docx', family: 'pm', dataBase64: pdf }, { fileName: 'CV.PDF', family: 'pm', dataBase64: b64(RESUME) }]) {
    const r = await request('POST', '/api/p/newbie/resumes', body);
    assert.equal(r.status, 415, body.fileName);
    assert.equal(r.json.code, 'PDF_NOT_SUPPORTED');
    assert.equal(r.json.error, msg);
  }
  const notDocx = await request('POST', '/api/p/newbie/resumes', { fileName: 'x.docx', dataBase64: writeZip([{ name: 'hello.txt', data: 'hi' }]).toString('base64') });
  assert.equal(notDocx.status, 400);
  assert.equal(notDocx.json.code, 'NOT_DOCX');
  assert.equal((await request('POST', '/api/p/newbie/resumes', {})).status, 400);

  // ~2.7 MB body (random padding inside the zip) is fine on the upload route, refused (413) elsewhere.
  const big = writeZip([...['[Content_Types].xml', '_rels/.rels'].map((n) => ({ name: n, data: '<x/>' })),
    { name: 'word/document.xml', data: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Big Upload</w:t></w:r></w:p><w:p><w:r><w:t>Analyst, Contoso | 2020 - 2021</w:t></w:r></w:p></w:body></w:document>` },
    { name: 'word/media/pad.bin', data: crypto.randomBytes(2 * 1024 * 1024) }]).toString('base64');
  const okBig = await request('POST', '/api/p/newbie/resumes', { fileName: 'Big.docx', family: 'big', dataBase64: big });
  assert.equal(okBig.status, 201, JSON.stringify(okBig.json));
  assert.equal((await request('POST', '/api/p/newbie/analyze', { jdText: 'x'.repeat(1100 * 1024) })).status, 413);
  const tooBig = await request('POST', '/api/p/newbie/resumes', { fileName: 'Huge.docx', family: 'big', dataBase64: Buffer.alloc(Math.round(5.5 * 1024 * 1024), 80).toString('base64') });
  assert.equal(tooBig.status, 413, 'more than 5 MB decoded');
  assert.equal(fs.existsSync(path.join(root('newbie'), 'resumes', 'Huge.docx')), false);
});

test('draft extracts years, titles, employer, education, certifications, tools and metrics from the uploaded resume', async () => {
  const d = await request('GET', '/api/p/newbie/onboarding/draft');
  assert.equal(d.status, 200, JSON.stringify(d.json));
  const draft = d.json.draft;
  const now = new Date();
  const months = (now.getFullYear() * 12 + now.getMonth() + 1) - (2019 * 12 + 6);
  assert.equal(draft.totalYears, Math.round((months / 12) * 10) / 10, 'merged Jul 2019 - Present');
  assert.deepEqual(draft.titles.slice(0, 2), ['Product Manager', 'Business Analyst']);
  assert.equal(draft.currentRole, 'Product Manager');
  assert.equal(draft.employer, 'Northwind Labs');
  assert.equal(draft.hasPmTitle, true);
  assert.deepEqual(draft.education.map((e) => [e.degree, e.field || null, e.school]), [['MBA', null, 'Riverton School of Management'], ['B.Sc', 'Statistics', 'Lakeside University']]);
  assert.deepEqual(draft.certifications.map((c) => c.name), ['Google Analytics certification', 'Tableau Desktop Specialist']);
  assert.equal(draft.tools.sql, 'met');
  assert.equal(draft.tools.jira, 'met');
  assert.ok(draft.skills.length > 0);
  const metricTokens = draft.metrics.map((m) => m.metric);
  assert.ok(metricTokens.includes('12%') && metricTokens.includes('40 hrs'), metricTokens.join(', '));
  assert.ok(!metricTokens.includes('2019'), 'years are not metrics');
  assert.equal(d.json.defaults.applyThreshold, 75);
  assert.equal(d.json.defaults.tailorBand, 20);
  assert.ok(d.json.directions.some((x) => x.id === 'pm' && x.class === 'target'));
});

test('confirm writes profile.json (generic honesty, user forbidden phrases) and the rules override; bad input changes nothing', async () => {
  const draft = (await request('GET', '/api/p/newbie/onboarding/draft')).json.draft;
  const bad = await request('POST', '/api/p/newbie/onboarding/confirm', { profile: { ...draft }, rules: { applyThreshold: 99 } });
  assert.equal(bad.status, 400);
  assert.equal(fs.existsSync(path.join(root('newbie'), 'config', 'rules.json')), false);
  const body = {
    profile: { ...draft, name: 'Jordan Example', forbiddenPhrases: ['people management', 'P&L (owner)'] },
    rules: { applyThreshold: 70, tailorBand: 15, ceiling: 6, directions: { ops: 'target', pm: 'avoid', apm: 'neutral' } }
  };
  const r = await request('POST', '/api/p/newbie/onboarding/confirm', body);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.threshold.def, 70);
  assert.equal(r.json.threshold.tailorBand, 15);
  const rules = JSON.parse(fs.readFileSync(path.join(root('newbie'), 'config', 'rules.json'), 'utf8'));
  assert.equal(rules.applyThreshold, 70);
  assert.deepEqual(rules.threshold, { tailorBand: 15 });
  assert.deepEqual(rules.level, { okMaxMinYears: 6, tooSeniorMinYears: 7 });
  const tIds = rules.directions.target.map((x) => x.id);
  const aIds = rules.directions.avoid.map((x) => x.id);
  assert.ok(tIds.includes('ops') && !tIds.includes('pm') && !tIds.includes('apm'));
  assert.ok(aIds.includes('pm') && !aIds.includes('ops') && !aIds.includes('apm'));
  assert.equal(rules.directions.avoid.find((x) => x.id === 'pm').action, 'skip');
  const prof = JSON.parse(fs.readFileSync(path.join(root('newbie'), 'config', 'profile.json'), 'utf8'));
  assert.equal(prof.honestyMode, 'generic');
  assert.equal(prof.name, 'Jordan Example');
  assert.equal(prof.employer, 'Northwind Labs');
  assert.equal(prof.totalYears, draft.totalYears);
  assert.equal(prof.tools.sql, 'met');
  const fc = prof.forbiddenClaims.find((f) => f.id === 'user-p-l-owner');
  assert.ok(fc, JSON.stringify(prof.forbiddenClaims));
  assert.ok(new RegExp(fc.pattern, 'i').test('Owned the P&L (owner) end to end'));
  const s = await request('GET', '/api/p/newbie/settings');
  assert.equal(s.json.threshold.def, 70);
  // An analysis now uses the confirmed rules: a PM JD is an avoid direction for this user.
  const a = await request('POST', '/api/p/newbie/analyze', { jdText: JD, company: 'Fabrikam', title: 'Product Manager', options: { saveHistory: false } });
  assert.equal(a.json.direction.id, 'pm');
  assert.equal(a.json.direction.class, 'avoid');
  // The owner/demo kinds are never rewritten by onboarding.
  profiles.ensureDemo();
  assert.equal((await request('POST', '/api/p/demo/onboarding/confirm', body)).status, 409);
});

test('markdown and CSV log import (deduped) feed stats and seen-before', async () => {
  const md = ['## Applications',
    '- **2026-05-04 - Applied:** Fabrikam, Payments Product Manager (Jordan_Resume_v2, ~78%; gaps: none noted).',
    '- **2026-05-06 - Skipped:** Tailspin Toys, Senior Director Product (no resume; reason: too senior).'].join('\n');
  const m = await request('POST', '/api/p/newbie/import-log', { format: 'markdown', text: md });
  assert.equal(m.status, 200, JSON.stringify(m.json));
  assert.equal(m.json.added, 2);
  const again = await request('POST', '/api/p/newbie/import-log', { format: 'markdown', text: md });
  assert.equal(again.json.added, 0);
  assert.equal(again.json.duplicates, 2);
  const csv = 'date,company,role,status,resume,fit\n2026-05-10,Globex,"Product Analyst, Ops",applied,Ops_Paste,70\n2026-05-11,Initech,Growth PM,skipped,,\n2026-05-10,globex,Product Analyst  Ops,applied,,\n2026-05-10,Globex,"Product Analyst, Ops",applied,Ops_Paste,70\n';
  const c = await request('POST', '/api/p/newbie/import-log', { format: 'csv', text: csv });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.equal(c.json.parsed, 4);
  assert.equal(c.json.added, 3);
  assert.equal(c.json.duplicates, 1);
  assert.equal(c.json.total, 5);
  assert.equal((await request('POST', '/api/p/newbie/import-log', { format: 'csv', text: 'when,who\n1,2' })).status, 400);
  assert.equal((await request('POST', '/api/p/newbie/import-log', { format: 'xml', text: 'x' })).status, 400);

  const st = await request('GET', '/api/p/newbie/stats');
  assert.equal(st.json.totals.screened, 5);
  assert.equal(st.json.totals.applied, 3);
  assert.equal(st.json.totals.skipped, 2);
  const a = await request('POST', '/api/p/newbie/analyze', { jdText: JD, company: 'Fabrikam', title: 'Payments Product Manager', options: { saveHistory: false } });
  assert.equal(a.json.seenBefore.status, 'repeat', JSON.stringify(a.json.seenBefore));
  assert.equal(a.json.verdict.key, 'skip_repeat');
});
