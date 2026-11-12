'use strict';

// Builtin Node generator (same CLI contract and exit codes as tailor-resume.ps1) on a synthetic split-run .docx.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tmpDir } = require('./helpers.cjs');
const { buildDocx, writeZip } = require('../lib/docx-write.cjs');
const { docxParagraphs, readZipEntry } = require('../lib/docx.cjs');
const edit = require('../lib/docx-edit.cjs');
const gen = require('../lib/generate.cjs');
const { autoBase } = require('../lib/autobase.cjs');

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const work = tmpDir('jdfc-edit-');
test.after(() => fs.rmSync(work, { recursive: true, force: true }));

const PROFILE = { employer: 'Examplecorp', certifications: [{ name: 'Google Analytics certification' }], education: [{ degree: 'B.Sc.', school: 'Sample State University' }] };
function makeConfig(over = {}) {
  return {
    paths: { tailorReportDir: path.join(work, 'reports') },
    profile: { ...PROFILE, ...(over.profile || {}) },
    forbidden: [{ id: 'people-mgmt', message: 'No people management.', regex: /managed a team|direct reports/gi, exceptRegex: null }]
  };
}
const PARAS = [
  { style: 'Title', runs: [{ text: 'Sample Person' }] },
  'Analyst at Examplecorp. Cut report time 15% across 3 teams.',
  { runs: [{ text: 'Skills: ', bold: true }, { text: 'SQL, Ex' }, { text: 'cel | Tools: Tri' }, { text: 'llo' }] },
  'B.Sc., Sample State University',
  'Certifications: Google Analytics certification',
  'SQL reporting for finance'
];
let n = 0;
function fresh(paras = PARAS) {
  const dir = path.join(work, `case${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'Base.docx');
  fs.writeFileSync(src, buildDocx(paras));
  return { dir, src, tgt: path.join(dir, 'Target.docx') };
}
function reps(dir, list) {
  const f = path.join(dir, `reps-${++n}.json`);
  fs.writeFileSync(f, JSON.stringify(list));
  return f;
}
const run = (config, args) => edit.makeBuiltinRunner(config)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'builtin', ...args], { timeoutMs: 1000 });

test('split-run replacement works and keeps the first run formatting; report parses with gen.parseReport', async () => {
  const { dir, src, tgt } = fresh();
  const before = sha(src);
  const r = await run(makeConfig(), ['-Source', src, '-Target', tgt, '-Replacements', reps(dir, [{ old: 'Tools: Trillo', new: 'Tools: Figma' }])]);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(sha(src), before, 'source untouched');
  const paras = docxParagraphs(tgt);
  assert.equal(paras[2], 'Skills: SQL, Excel | Tools: Figma');
  const xml = readZipEntry(fs.readFileSync(tgt), 'word/document.xml').toString('utf8');
  const p = xml.split('</w:p>').find((x) => x.includes('Tools: Figma'));
  assert.equal((p.match(/<w:r>/g) || []).length, 1, 'paragraph rebuilt as one run');
  assert.match(p, /<w:r><w:rPr><w:b\/><\/w:rPr>/, 'first run formatting kept');
  const rep = gen.parseReport(fs.readFileSync(path.join(work, 'reports', 'Target.md'), 'utf8'));
  assert.equal(rep.exitCode, '0');
  assert.equal(rep.replacementsApplied, 1);
  assert.match(rep.protectedTokens, /checked, 0 lost/);
  assert.equal(rep.forbiddenScan, '0');
  assert.match(rep.pages, /^1 \(estimate\), lines: \d+ \(line-count heuristic/);
  assert.equal(rep.ok, true);
});

test('protected tokens: derived from the source (metrics, cert, school, employer); losing one -> exit 3, nothing written', async () => {
  const text = docxParagraphs(fresh().src).join('\n');
  const toks = edit.protectedTokens(text, PROFILE);
  for (const t of ['15%', '3', 'Google Analytics certification', 'Sample State University', 'Examplecorp', 'B.Sc.']) assert.ok(toks.includes(t), `${t} in ${toks.join(' | ')}`);
  assert.ok(!toks.includes('Unused University'));
  const { dir, src, tgt } = fresh();
  const r = await run(makeConfig(), ['-Source', src, '-Target', tgt, '-Replacements', reps(dir, [{ old: 'Cut report time 15% across 3 teams.', new: 'Cut report time across teams.' }])]);
  assert.equal(r.code, 3);
  assert.ok(!fs.existsSync(tgt));
  const rep = gen.parseReport(r.stdout);
  assert.ok(rep.lost.includes('15%') && rep.lost.includes('3'), rep.lost.join(','));
});

test('forbidden new claim -> exit 4 with a parseable NEW line; nothing written', async () => {
  const { dir, src, tgt } = fresh();
  const r = await run(makeConfig(), ['-Source', src, '-Target', tgt, '-Replacements', reps(dir, [{ old: 'Tools: Trillo', new: 'Tools: Trillo; managed a team' }])]);
  assert.equal(r.code, 4);
  assert.ok(!fs.existsSync(tgt));
  const rep = gen.parseReport(r.stdout);
  assert.equal(rep.newForbidden.length, 1);
  assert.match(rep.newForbidden[0], /^NEW: P3: 'managed a team' \(0 -> 1\)$/);
  assert.deepEqual(gen.offendingEdits(4, rep, [{ old: 'x', new: 'Tools: Trillo; managed a team' }]), [0]);
});

test('ambiguous or missing old text -> exit 2 naming the replacement number', async () => {
  const { dir, src, tgt } = fresh();
  const r = await run(makeConfig(), ['-Source', src, '-Target', tgt, '-Replacements', reps(dir, [{ old: 'Tools: Trillo', new: 'Tools: X' }, { old: 'SQL', new: 'Structured Query Language' }, { old: 'not in the file', new: 'y' }])]);
  assert.equal(r.code, 2);
  assert.ok(!fs.existsSync(tgt));
  const rep = gen.parseReport(r.stdout);
  assert.equal(rep.notFound.length, 2);
  assert.match(rep.notFound[0], /^NOT FOUND\/AMBIGUOUS #2: 'SQL' occurs 2 times/);
  assert.match(rep.notFound[1], /#3/);
  assert.deepEqual(gen.offendingEdits(2, rep, [{}, {}, {}]).sort(), [1, 2]);
});

test('existing target without -Force -> exit 7 and the target is unchanged; target = source refused', async () => {
  const { dir, src, tgt } = fresh();
  fs.writeFileSync(tgt, 'existing');
  const r = await run(makeConfig(), ['-Source', src, '-Target', tgt, '-Replacements', reps(dir, [{ old: 'Tools: Trillo', new: 'Tools: X' }])]);
  assert.equal(r.code, 7);
  assert.match(r.stdout, /refusing to overwrite/);
  assert.equal(fs.readFileSync(tgt, 'utf8'), 'existing');
  const same = await run(makeConfig(), ['-Source', src, '-Target', src, '-Replacements', reps(dir, [{ old: 'Tools: Trillo', new: 'Tools: X' }])]);
  assert.equal(same.code, 7);
});

test('-InPlace backs up to _backup_<yyyyMMdd_HHmmss>_<stem>\\ first, then edits the file', async () => {
  const { dir, src } = fresh();
  const original = fs.readFileSync(src);
  const r = await run(makeConfig(), ['-Source', src, '-InPlace', '-Replacements', reps(dir, [{ old: 'Tools: Trillo', new: 'Tools: Figma' }])]);
  assert.equal(r.code, 0, r.stdout);
  const backups = fs.readdirSync(dir).filter((d) => /^_backup_\d{8}_\d{6}_Base$/.test(d));
  assert.equal(backups.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(dir, backups[0], 'Base.docx')), original);
  assert.ok(docxParagraphs(src).includes('Skills: SQL, Excel | Tools: Figma'));
  const again = await run(makeConfig(), ['-Source', src, '-InPlace', '-Replacements', reps(dir, [{ old: 'Tools: Figma', new: 'Tools: Trillo' }])]);
  assert.equal(again.code, 0);
  assert.equal(fs.readdirSync(dir).filter((d) => d.startsWith('_backup_')).length, 2, 'a second backup in the same second gets its own folder');
});

test('page estimate: over the limit and longer than the source -> exit 5 with the target written; -SkipPageCheck -> 0', async () => {
  const { dir, src, tgt } = fresh();
  const long = `Tools: ${'Figma, '.repeat(60)}Miro`;
  const cfg = makeConfig({ profile: { generator: { maxLines: 6 } } });
  const r = await run(cfg, ['-Source', src, '-Target', tgt, '-Replacements', reps(dir, [{ old: 'Tools: Trillo', new: long }])]);
  assert.equal(r.code, 5);
  assert.ok(fs.existsSync(tgt), 'target written on exit 5');
  assert.match(gen.parseReport(r.stdout).pages, /^2 \(estimate\)/);
  const r2 = await run(cfg, ['-Source', src, '-Target', tgt, '-Replacements', reps(dir, [{ old: 'Tools: Trillo', new: long }]), '-Force', '-SkipPageCheck']);
  assert.equal(r2.code, 0, r2.stdout);
  assert.equal(edit.estimateLines(['a'.repeat(190), '', 'b']), 3);
});

test('a paragraph with a hyperlink or field is refused (exit 7)', async () => {
  const dir = path.join(work, 'hyper');
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'Base.docx');
  const doc = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="r"><w:body>'
    + '<w:p><w:r><w:t>Portfolio: </w:t></w:r><w:hyperlink r:id="rId9"><w:r><w:t>example.com</w:t></w:r></w:hyperlink></w:p></w:body></w:document>';
  fs.writeFileSync(src, writeZip([{ name: '[Content_Types].xml', data: '<Types/>' }, { name: 'word/document.xml', data: doc }]));
  const r = await run(makeConfig(), ['-Source', src, '-Target', path.join(dir, 'T.docx'), '-Replacements', reps(dir, [{ old: 'Portfolio', new: 'Work' }])]);
  assert.equal(r.code, 7);
  assert.match(r.stdout, /hyperlink, field or text box/);
});

test('generateResume with the builtin runner creates a NEW file and never touches the source', async () => {
  const { dir, src } = fresh();
  const before = sha(src);
  const res = await gen.generateResume({ scriptPath: 'builtin', resumeDir: dir, sourceFile: 'Base.docx', targetName: 'Base_Tailored.docx', edits: [{ old: 'Tools: Trillo', new: 'Tools: Figma', kind: 'skill-swap' }],
    runsDir: path.join(dir, 'runs'), reportDir: path.join(work, 'reports'), runner: edit.makeBuiltinRunner(makeConfig()) });
  assert.equal(res.ok, true, JSON.stringify(res.attempts.map((a) => a.stdoutTail)));
  assert.equal(res.status, 'generated');
  assert.equal(res.attempts.length, 1);
  assert.equal(sha(src), before);
  assert.ok(docxParagraphs(path.join(dir, 'Base_Tailored.docx')).includes('Skills: SQL, Excel | Tools: Figma'));
  // exit 2 on attempt 1 -> the offending edit is dropped and attempt 2 succeeds (bounded state machine reused).
  const res2 = await gen.generateResume({ scriptPath: 'builtin', resumeDir: dir, sourceFile: 'Base.docx', targetName: 'Base_T2.docx', edits: [{ old: 'Tools: Trillo', new: 'Tools: Figma' }, { old: 'missing text', new: 'x' }],
    runsDir: path.join(dir, 'runs'), reportDir: path.join(work, 'reports'), runner: edit.makeBuiltinRunner(makeConfig()) });
  assert.equal(res2.ok, true);
  assert.deepEqual(res2.attempts.map((a) => a.code), [2, 0]);
  assert.equal(res2.dropped.length, 1);
  assert.equal(sha(src), before);
});

test('autoBase: swap slot = remainder after the Skills/Tools label (must occur once)', () => {
  assert.deepEqual(autoBase(['Name', 'Core Skills: SQL, Excel, Jira', 'x']).swapSlots, [{ old: 'SQL, Excel, Jira', keep: 'SQL, Excel, Jira' }]);
  assert.deepEqual(autoBase(['Tools | Figma, Miro']).swapSlots, [{ old: 'Figma, Miro', keep: 'Figma, Miro' }]);
  assert.deepEqual(autoBase(['Skills: SQL', 'SQL']).swapSlots, [], 'ambiguous remainder -> no slot');
  assert.deepEqual(autoBase(['No label here']).swapSlots, []);
  assert.equal(autoBase([]).closingSentence, null);
});
