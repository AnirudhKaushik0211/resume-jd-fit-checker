'use strict';

// Screening-checklist parser, "seen before" matcher, log-entry formatter and the confirmed append.

const fs = require('fs');
const { fixMojibake, normalize } = require('./text.cjs');

// Split on separators only at parenthesis depth 0.
function splitTopLevel(text, { semicolon = true, sentence = true, comma = false } = {}) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[') depth++;
    else if ((ch === ')' || ch === ']') && depth > 0) depth--;
    if (depth === 0) {
      if (semicolon && ch === ';') { out.push(cur); cur = ''; continue; }
      if (comma && ch === ',' && text[i + 1] === ' ') { out.push(cur); cur = ''; continue; }
      if (sentence && ch === '.' && text[i + 1] === ' ' && /[A-Z]/.test(text[i + 2] || '')) { out.push(cur); cur = ''; continue; }
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim().replace(/\.$/, '').trim()).filter(Boolean);
}

function labelToStatus(label, rules) {
  const l = label.toLowerCase();
  const cl = rules.checklist;
  if (cl.ignoreLabels.some((ig) => l.includes(ig))) return null;
  for (const [needle, status] of cl.labelStatus) if (l.includes(needle)) return status;
  return null;
}

function firstResumeIn(text, names) {
  let best = null;
  let bestIdx = Infinity;
  for (const name of names) {
    const re = new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`);
    const m = re.exec(text);
    if (m && (m.index < bestIdx || (m.index === bestIdx && name.length > best.length))) { best = name; bestIdx = m.index; }
  }
  return best;
}

// Resume used: the target of "base -> target" if present, else the first resume name inside the details,
// else the first underscore-style resume name anywhere (plain-word names like "Marketing" only count in details).
function extractResume(raw, resumeNames) {
  const arrow = raw.match(/->\s*([A-Za-z0-9_]+)/);
  if (arrow && resumeNames.includes(arrow[1])) return arrow[1];
  const parenIdx = raw.indexOf('(');
  const details = parenIdx >= 0 ? raw.slice(parenIdx) : '';
  const resumeLabel = raw.match(/resumes?:\s*(.+)$/i);
  return firstResumeIn(details, resumeNames)
    || (resumeLabel && firstResumeIn(resumeLabel[1], resumeNames))
    || firstResumeIn(raw, resumeNames.filter((n) => n.includes('_')));
}

function extractFit(raw) {
  const m = raw.match(/~\s*(\d{1,3})(?:\s*-\s*(\d{1,3}))?\s*%/);
  if (!m) return null;
  return m[2] ? Math.round((Number(m[1]) + Number(m[2])) / 2) : Number(m[1]);
}

function parseChecklist(text, rules, resumeNames = []) {
  const lines = fixMojibake(String(text || '').replace(/^\uFEFF/, '')).split(/\r?\n/);
  const entries = [];
  let section = '';
  lines.forEach((line, idx) => {
    if (/^#{1,6}\s/.test(line)) { section = line.replace(/^#+\s*/, '').toLowerCase(); return; }
    let body = line.trim();
    const isBullet = body.startsWith('- ');
    const isLabelLine = /^\*\*[^*]+:\*\*/.test(body);
    if (!isBullet && !isLabelLine) return;
    if (isBullet) body = body.slice(2);
    let date = null;
    const segRe = /\*\*([^*]+?):\*\*/g;
    const marks = [];
    let m;
    while ((m = segRe.exec(body))) marks.push({ label: m[1].trim(), start: m.index, end: segRe.lastIndex });
    if (!marks.length) return;
    const commaSplit = (rules.checklist.commaSplitSections || []).some((s) => section.includes(s));
    marks.forEach((mk, i) => {
      let label = mk.label;
      const dm = label.match(/^(\d{4}-\d{2}-\d{2})\s*-\s*(.+)$/);
      if (dm) { date = dm[1]; label = dm[2]; }
      const status = labelToStatus(label, rules);
      if (!status) return;
      const segText = body.slice(mk.end, i + 1 < marks.length ? marks[i + 1].start : body.length).trim();
      const isDated = Boolean(dm);
      const parts = splitTopLevel(segText, { semicolon: true, sentence: !isDated, comma: commaSplit });
      const items = [];
      for (const p of parts) {
        if (/^(resume|resumes)\s*:/i.test(p) && items.length) { items[items.length - 1] += `. ${p}`; continue; }
        items.push(p);
      }
      for (const raw of items) {
        const parenIdx = raw.indexOf('(');
        let head = (parenIdx >= 0 ? raw.slice(0, parenIdx) : raw);
        if (isDated) head = head.split(/\.\s+(?=[A-Z])/)[0];
        head = head.trim();
        let itemStatus = status;
        const inline = head.match(/:\s*(skipped|skip)\b/i);
        if (inline) { itemStatus = 'skipped'; head = head.slice(0, inline.index).trim(); }
        entries.push({
          raw, line: line.trim(), lineNo: idx + 1, date, label, status: itemStatus, section,
          head, details: parenIdx >= 0 ? raw.slice(parenIdx) : '',
          resume: extractResume(raw, resumeNames), fit: extractFit(raw)
        });
      }
    });
  });
  return entries;
}

function roleTokens(s, rules) {
  const cl = rules.checklist;
  const stop = new Set(cl.roleStopWords || []);
  const abbr = cl.abbreviations || {};
  const out = [];
  for (const t of normalize(s).replace(/[/,&:]+/g, ' ').split(/\s+/)) {
    const tok = t.replace(/^[.\-]+|[.\-]+$/g, '');
    if (!tok || stop.has(tok)) continue;
    if (abbr[tok]) out.push(...abbr[tok].split(' '));
    else out.push(tok);
  }
  return out;
}

function containsSeq(hay, needle) {
  if (!needle.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((t, j) => hay[i + j] === t)) return true;
  }
  return false;
}

function roleScore(titleToks, itemToks, rules) {
  const generic = new Set(rules.checklist.genericRoleWords || []);
  const itemSet = new Set(itemToks);
  const share = (arr) => (arr.length ? arr.filter((t) => itemSet.has(t)).length / arr.length : 0);
  const all = share(titleToks);
  const distinct = titleToks.filter((t) => !generic.has(t));
  const dist = distinct.length ? share(distinct) : all;
  return 0.4 * all + 0.6 * dist;
}

function seenBefore({ company, title }, entries, rules, profile = {}) {
  const companyToks = roleTokens(company || '', rules);
  if (!companyToks.length) return { status: 'none', matches: [], note: 'No company detected; seen-before check skipped.' };
  const titleToks = roleTokens(title || '', rules).filter((t) => !companyToks.includes(t));
  const matches = [];
  for (const e of entries) {
    const headToks = roleTokens(e.head, rules);
    if (!containsSeq(headToks, companyToks)) continue;
    const itemToks = headToks.filter((t) => !companyToks.includes(t));
    const score = titleToks.length ? roleScore(titleToks, itemToks, rules) : 0;
    matches.push({ line: e.raw, fullLine: e.line, lineNo: e.lineNo, label: e.label, status: e.status, resume: e.resume, fit: e.fit, date: e.date, score: Math.round(score * 100) / 100, sameRole: score >= rules.checklist.sameRoleMinScore });
  }
  const priority = { repeat: 5, applied: 4, pending: 3, held: 2, skipped: 1 };
  matches.sort((a, b) => (b.sameRole - a.sameRole) || (b.score - a.score) || ((priority[b.status] || 0) - (priority[a.status] || 0)));
  const same = matches.filter((m) => m.sameRole);
  let status = 'none';
  if (same.length) {
    const statuses = new Set(same.map((m) => m.status));
    if (statuses.has('repeat') || statuses.has('applied')) status = 'repeat';
    else if (statuses.has('pending')) status = 'pending';
    else if (statuses.has('held')) status = 'held';
    else status = 'previously_skipped';
  } else if (matches.length) {
    status = 'same_company_new_role';
  }
  const result = { status, matches: matches.slice(0, 8) };
  const prior = same.find((m) => m.resume) || same[0];
  if (prior) result.resumeUsed = prior.resume || null;
  if (status === 'repeat') {
    const hookTpl = profile.followUpTemplate || 'Hi {name}, I applied for {role} at {company} earlier and remain interested: {hook}.';
    result.followUp = hookTpl
      .replace('{name}', '<recruiter name>')
      .replace('{role}', title || 'the role')
      .replace('{company}', company)
      .replace('{hook}', 'my recent work on evaluated AI tools maps to the role');
    result.followUpNote = 'Do not reapply. Message the recruiter or hiring manager on LinkedIn instead.';
  }
  if (status === 'same_company_new_role') result.note = `Same company, new role: ${matches.length} earlier ${company} entr${matches.length === 1 ? 'y' : 'ies'} in the checklist.`;
  return result;
}

function formatLogEntry({ date, verdictLabel, company, title, resume, fit, gaps }) {
  const d = date || new Date().toISOString().slice(0, 10);
  const g = (gaps && gaps.length ? gaps : ['none noted']).join(', ').replace(/[\r\n]+/g, ' ');
  const clean = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();
  return `- **${d} - ${clean(verdictLabel)}:** ${clean(company) || 'Unknown company'}, ${clean(title) || 'Unknown role'} (${clean(resume) || 'no resume'}, ~${Math.round(Number(fit) || 0)}%; gaps: ${g}).`;
}

// Application-confirmation entries (Did you apply?) in the checklist's dated format.
const ANSWER_LABELS = { applied: 'Applied (confirmed)', pending: 'Tailored, pending application', skip: 'Skipped (user decision)' };
function formatApplicationEntry({ date, answer, company, title, resume, fit, baseline, threshold, gaps, reason }) {
  const label = ANSWER_LABELS[answer];
  if (!label) throw new Error('answer must be applied, pending or skip');
  const d = date || new Date().toISOString().slice(0, 10);
  const clean = (s) => String(s || '').replace(/[\r\n]+/g, ' ').replace(/\*\*/g, '').trim();
  const score = `strict fit ~${Math.round(Number(fit) || 0)}%${baseline !== undefined && baseline !== null && Number(baseline) !== Number(fit) ? ` (baseline ~${Math.round(Number(baseline))}%)` : ''}, threshold ${Math.round(Number(threshold) || 0)}`;
  const tail = answer === 'skip' ? `reason: ${clean(reason) || 'user decision'}` : `gaps: ${(gaps && gaps.length ? gaps.map(clean) : ['none noted']).join(', ')}`;
  return `- **${d} - ${label}:** ${clean(company) || 'Unknown company'} ${clean(title) || 'Unknown role'} (${clean(resume) || 'no resume'}, ${score}; ${tail}).`;
}

function validateLogLine(line) {
  if (typeof line !== 'string') return 'Line must be a string.';
  if (/[\r\n]/.test(line)) return 'Line must be a single line.';
  if (!line.startsWith('- ')) return 'Line must start with "- ".';
  if (line.length > 1200) return 'Line is longer than 1200 characters.';
  return null;
}

function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function appendToChecklist(file, line) {
  const err = validateLogLine(line);
  if (err) { const e = new Error(err); e.statusCode = 400; throw e; }
  const original = fs.readFileSync(file);
  let backupPath = `${file}.bak-${timestamp()}`;
  let n = 1;
  while (fs.existsSync(backupPath)) backupPath = `${file}.bak-${timestamp()}-${n++}`;
  fs.copyFileSync(file, backupPath, fs.constants.COPYFILE_EXCL);
  const endsWithNewline = original.length === 0 || original[original.length - 1] === 0x0a;
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  fs.appendFileSync(file, `${endsWithNewline ? '' : eol}${line}${eol}`, 'utf8');
  return { ok: true, backupPath };
}

module.exports = { splitTopLevel, parseChecklist, seenBefore, formatLogEntry, formatApplicationEntry, ANSWER_LABELS, validateLogLine, appendToChecklist, roleTokens };
