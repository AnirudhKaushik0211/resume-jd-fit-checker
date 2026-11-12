'use strict';

// Builtin Node .docx generator: the same CLI contract and exit codes as scripts\tailor-resume.ps1, so
// generate.cjs (2-attempt state machine, promote-once _v2) and propagation are reused unchanged.
//   args: -Source <docx> (-Target <docx> | -InPlace) -Replacements <json> [-Force] [-SkipPageCheck]
//   exit: 0 ok | 2 old text not found / ambiguous | 3 protected token lost | 4 forbidden new claim
//         5 over the page estimate (target written) | 7 other / refused (incl. existing target without -Force)
// Nothing is written on 2/3/4/7. -InPlace backs the file up to <dir>\_backup_<yyyyMMdd_HHmmss>_<stem>\ first.
// The page count is a line-count ESTIMATE (no layout engine); the report says so.

const fs = require('fs');
const path = require('path');
const { listZipEntries, readZipEntry } = require('./docx.cjs');
const { writeZip, runContent } = require('./docx-write.cjs');
const { decodeEntities } = require('./text.cjs');

const PARA_RE = /<w:p\b(?![A-Za-z])[^>]*?(?:\/>|>[\s\S]*?<\/w:p>)/g;
const COMPLEX_RE = /<w:hyperlink\b|<w:fldSimple\b|<w:fldChar\b|<w:txbxContent\b/;
const METRIC_RE = /(?<![A-Za-z0-9])\$?\d[\d,.]*\s?(?:%|x\b|k\b|m\b|hrs?\b|\+)?/gi;

function paragraphText(chunk) {
  let out = '';
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g;
  let m;
  while ((m = re.exec(chunk))) {
    if (m[0] === '<w:tab/>') out += '\t';
    else if (m[0] === '<w:br/>') out += '\n';
    else out += m[1];
  }
  return decodeEntities(out);
}

// [{ start, end, xml, text }] for every <w:p> in document.xml (in order).
function splitParagraphs(xml) {
  const out = [];
  let m;
  PARA_RE.lastIndex = 0;
  while ((m = PARA_RE.exec(xml))) out.push({ start: m.index, end: m.index + m[0].length, xml: m[0], text: paragraphText(m[0]) });
  return out;
}

function countOf(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

// Rebuild one paragraph as a single run carrying the FIRST run's <w:rPr> (pPr kept).
function rebuildParagraph(chunk, newText) {
  const open = (chunk.match(/^<w:p\b[^>]*>/) || ['<w:p>'])[0];
  const ppr = (chunk.match(/<w:pPr>[\s\S]*?<\/w:pPr>|<w:pPr\/>/) || [''])[0];
  const firstRun = chunk.match(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/);
  const rpr = firstRun ? (firstRun[1].match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0] : '';
  return `${open}${ppr}<w:r>${rpr}${runContent(newText)}</w:r></w:p>`;
}

// reps: [{ old, new }]. Applied in order; each "old" must occur exactly once in the joined paragraph text
// AND inside one paragraph. Returns { xml, applied: [{ index, paragraph, before, after }], notFound: [{ index, message }], refused }.
function applyReplacements(xml, reps) {
  let cur = String(xml);
  const applied = [];
  const notFound = [];
  let refused = null;
  reps.forEach((rep, i) => {
    if (refused) return;
    const paras = splitParagraphs(cur);
    const joined = paras.map((p) => p.text).join('');
    const n = countOf(joined, rep.old);
    if (n !== 1) { notFound.push({ index: i + 1, message: `'${rep.old}' occurs ${n} times` }); return; }
    const pi = paras.findIndex((p) => p.text.includes(rep.old));
    if (pi < 0) { notFound.push({ index: i + 1, message: `'${rep.old}' spans more than one paragraph` }); return; }
    const p = paras[pi];
    if (COMPLEX_RE.test(p.xml)) { refused = `Replacement #${i + 1}: paragraph P${pi + 1} contains a hyperlink, field or text box; refusing to rebuild it.`; return; }
    const after = p.text.replace(rep.old, () => rep.new);
    cur = cur.slice(0, p.start) + rebuildParagraph(p.xml, after) + cur.slice(p.end);
    applied.push({ index: i + 1, paragraph: pi + 1, before: p.text, after, old: rep.old, new: rep.new });
  });
  return { xml: cur, applied, notFound, refused };
}

// Tokens that must survive an edit: metrics/numbers, certification names, degree/school, employer (only those in the source).
function protectedTokens(sourceText, profile = {}) {
  const src = String(sourceText || '');
  const lower = src.toLowerCase();
  const out = [];
  const add = (t) => { const s = String(t || '').trim(); if (s && !out.includes(s)) out.push(s); };
  for (const m of src.match(METRIC_RE) || []) add(m.replace(/[.,]+$/, ''));
  const names = [
    ...(profile.certifications || []).map((c) => c.name),
    ...(profile.education || []).flatMap((e) => [e.degree, e.school]),
    profile.employer
  ].filter((x) => x && String(x).trim().length > 1);
  for (const n of names) {
    const i = lower.indexOf(String(n).toLowerCase());
    if (i >= 0) add(src.slice(i, i + String(n).length));
  }
  return out;
}

function tokenPresent(text, tok) {
  return /\d/.test(tok) && !/[A-Za-z]{3}/.test(tok) ? text.includes(tok) : text.toLowerCase().includes(tok.toLowerCase());
}

// Page estimate: wrapped line count at ~95 chars per line (no layout engine).
function estimateLines(paragraphs, { charsPerLine = 95 } = {}) {
  let n = 0;
  for (const p of paragraphs) for (const line of String(p).split('\n')) if (line.trim()) n += Math.max(1, Math.ceil(line.length / charsPerLine));
  return n;
}

function stamp(d) {
  const z = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

// <dir>\_backup_<yyyyMMdd_HHmmss>_<stem>\<file>; a taken second moves forward so names stay unique and sortable.
function backupFile(file, now = new Date()) {
  const dir = path.dirname(file);
  const stem = path.basename(file, path.extname(file));
  let t = now.getTime();
  let target;
  for (;;) {
    target = path.join(dir, `_backup_${stamp(new Date(t))}_${stem}`);
    if (!fs.existsSync(target)) break;
    t += 1000;
  }
  fs.mkdirSync(target, { recursive: true });
  const dst = path.join(target, path.basename(file));
  fs.copyFileSync(file, dst);
  return dst;
}

function parseArgs(args) {
  const o = { inPlace: false, force: false, skipPageCheck: false };
  const valued = { '-source': 'source', '-target': 'target', '-replacements': 'replacements', '-timeoutseconds': 'timeoutSeconds', '-file': 'file', '-executionpolicy': 'executionPolicy' };
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]).toLowerCase();
    if (valued[a]) { o[valued[a]] = args[i + 1]; i++; }
    else if (a === '-inplace') o.inPlace = true;
    else if (a === '-force') o.force = true;
    else if (a === '-skippagecheck') o.skipPageCheck = true;
  }
  return o;
}

function writeAtomic(file, buf) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

function countForbidden(fc, text) {
  const re = new RegExp(fc.regex.source, 'gi');
  let n = 0;
  let first = null;
  let m;
  while ((m = re.exec(text))) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    if (fc.exceptRegex && fc.exceptRegex.test(text.slice(m.index, m.index + 40))) continue;
    n++;
    if (!first) first = m[0];
  }
  return { n, first };
}

function runBuiltin(config, args, { now = () => new Date() } = {}) {
  const o = parseArgs(args);
  const lines = [];
  const reportDir = config.paths && config.paths.tailorReportDir;
  const targetPath = o.inPlace ? o.source : o.target;
  const stem = path.basename(String(targetPath || o.source || 'tailor-run'), '.docx');
  const finish = (code, tail = []) => {
    const text = [`# Tailor report (builtin Node generator): ${stem}`, '', `- Source: ${o.source || ''}`, `- Target: ${o.inPlace ? `${o.source} (in place)` : o.target || ''}`, `- Exit code: ${code}`, '', ...lines, ...tail, ''].join('\n');
    if (reportDir) { try { fs.mkdirSync(reportDir, { recursive: true }); fs.writeFileSync(path.join(reportDir, `${stem}.md`), text, 'utf8'); } catch { /* report is also on stdout */ } }
    return { code, stdout: text, stderr: code ? `exit ${code}` : '' };
  };
  if (!o.source || !fs.existsSync(o.source)) return finish(7, [`ERROR: source not found: ${o.source || '(none)'}`]);
  if (!o.inPlace && !o.target) return finish(7, ['ERROR: -Target or -InPlace is required.']);
  if (!o.inPlace && path.resolve(o.source) === path.resolve(o.target)) return finish(7, ['ERROR: target equals source; use -InPlace for in-place edits.']);
  if (!o.inPlace && fs.existsSync(o.target) && !o.force) return finish(7, [`ERROR: target exists, refusing to overwrite (pass -Force): ${o.target}`]);
  let reps;
  try { reps = JSON.parse(fs.readFileSync(o.replacements, 'utf8').replace(/^\uFEFF/, '')); } catch (error) { return finish(7, [`ERROR: replacements JSON could not be read: ${error.message}`]); }
  if (!Array.isArray(reps) || !reps.length || !reps.every((r) => r && typeof r.old === 'string' && r.old && typeof r.new === 'string')) return finish(7, ['ERROR: replacements must be a non-empty array of {old, new} strings.']);

  const buf = fs.readFileSync(o.source);
  let entries;
  let docXml;
  try {
    entries = listZipEntries(buf).map((e) => ({ name: e.name, data: readZipEntry(buf, e.name) }));
    const doc = entries.find((e) => e.name === 'word/document.xml');
    if (!doc) throw new Error('word/document.xml missing');
    docXml = doc.data.toString('utf8');
  } catch (error) { return finish(7, [`ERROR: not a readable .docx: ${error.message}`]); }

  const srcParas = splitParagraphs(docXml).map((p) => p.text);
  const r = applyReplacements(docXml, reps);
  if (r.refused) return finish(7, [`ERROR: ${r.refused}`]);
  if (r.notFound.length) return finish(2, r.notFound.map((x) => `NOT FOUND/AMBIGUOUS #${x.index}: ${x.message}`));

  const newParas = splitParagraphs(r.xml).map((p) => p.text);
  const srcText = srcParas.join('\n');
  const newText = newParas.join('\n');
  const tokens = protectedTokens(srcText, config.profile || {});
  const lost = tokens.filter((t) => !tokenPresent(newText, t));
  r.applied.forEach((a) => lines.push(`Replacement #${a.index}: P${a.paragraph}`, `  BEFORE: ${a.before}`, `  AFTER: ${a.after}`));
  lines.push(`Protected tokens: ${tokens.length} checked, ${lost.length} lost`);
  if (lost.length) return finish(3, lost.map((t) => `  LOST: ${t}`));

  const hits = [];
  for (const a of r.applied) {
    for (const fc of config.forbidden || []) {
      const before = countForbidden(fc, a.before);
      const after = countForbidden(fc, a.after);
      if (after.n > before.n) hits.push(`  NEW: P${a.paragraph}: '${after.first}' (${before.n} -> ${after.n})`);
    }
  }
  lines.push(`Forbidden-claim scan (new hits only): ${hits.length}`, ...hits);
  if (hits.length) return finish(4);

  const maxLines = Number(((config.profile || {}).generator || {}).maxLines) || 52;
  const srcLines = estimateLines(srcParas);
  const newLines = estimateLines(newParas);
  const over = !o.skipPageCheck && newLines > maxLines && newLines > srcLines;
  const outEntries = entries.map((e) => (e.name === 'word/document.xml' ? { name: e.name, data: Buffer.from(r.xml, 'utf8') } : e));
  const out = writeZip(outEntries, { date: now() });
  let backup = null;
  if (o.inPlace) backup = backupFile(o.source, now());
  else if (fs.existsSync(o.target)) backup = backupFile(o.target, now()); // -Force: keep the previous target
  writeAtomic(targetPath, out);
  lines.push(`Pages: ${over ? 2 : 1} (estimate), lines: ${newLines} (line-count heuristic; source ${srcLines}, limit ${maxLines}${o.skipPageCheck ? ', page check skipped' : ''})`);
  if (backup) lines.push(`Backup: ${backup}`);
  if (over) return finish(5, [`OVER ONE PAGE (estimate): wrote ${targetPath}; trim it in Word.`]);
  return finish(0, [`OK: wrote ${targetPath}`]);
}

// Runner with the generate.cjs signature (file, args, opts) -> Promise<{ code, stdout, stderr }>. `file` is ignored.
function makeBuiltinRunner(config, opts = {}) {
  return async function builtinRunner(file, args) {
    try { return runBuiltin(config, args || [], opts); } catch (error) { return { code: 7, stdout: `ERROR: ${error.message}`, stderr: error.message }; }
  };
}

module.exports = { makeBuiltinRunner, runBuiltin, applyReplacements, splitParagraphs, paragraphText, protectedTokens, estimateLines, backupFile, parseArgs, METRIC_RE };
