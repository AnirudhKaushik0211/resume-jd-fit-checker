'use strict';

// ATS-style keyword extraction against a configurable taxonomy, coverage per resume, and highlight spans.

const { phraseRegex, escapeRegex } = require('./text.cjs');

const SECTION_RANK = { required: 4, responsibilities: 3, preferred: 2, title: 3, other: 1 };

function compileTaxonomy(taxonomy) {
  if (taxonomy._compiled) return taxonomy._compiled;
  const compiled = taxonomy.map((kw) => {
    const matchers = [];
    for (const s of kw.synonyms || []) matchers.push({ term: s, re: phraseRegex(s, 'gi') });
    for (const s of kw.caseSensitive || []) {
      const body = escapeRegex(s).replace(/\s+/g, '[\\s\\-]+');
      matchers.push({ term: s, re: new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, 'g') });
    }
    matchers.sort((a, b) => b.term.length - a.term.length);
    return { kw, matchers };
  });
  Object.defineProperty(taxonomy, '_compiled', { value: compiled, enumerable: false });
  return compiled;
}

function findAll(re, text) {
  re.lastIndex = 0;
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

function textHasKeyword(entry, text) {
  return entry.matchers.some((mt) => { mt.re.lastIndex = 0; return mt.re.test(text); });
}

// Returns [{id, canonical, category, section, mustHave, sections[], occurrences[{start,end,text}], kw}]
function extractKeywords(jd, taxonomy) {
  const compiled = compileTaxonomy(taxonomy);
  const claimed = []; // non-overlapping spans across all keywords (longest first)
  const candidates = [];
  for (const line of jd.lines) {
    if (line.heading && line.section !== 'title') {
      // headings still carry keywords (e.g. "Trust, governance & data quality") but count as their section
    }
    for (const entry of compiled) {
      for (const mt of entry.matchers) {
        for (const occ of findAll(mt.re, line.text)) {
          candidates.push({ entry, line, start: line.start + occ.start, end: line.start + occ.end, text: occ.text });
        }
      }
    }
  }
  candidates.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const byId = new Map();
  for (const c of candidates) {
    if (claimed.some((s) => c.start < s.end && s.start < c.end)) continue;
    claimed.push({ start: c.start, end: c.end });
    const id = c.entry.kw.id;
    if (!byId.has(id)) byId.set(id, { id, canonical: c.entry.kw.canonical, category: c.entry.kw.category, kw: c.entry.kw, entry: c.entry, sections: new Set(), mustHave: false, occurrences: [] });
    const rec = byId.get(id);
    rec.sections.add(c.line.section);
    if (c.line.mustHave) rec.mustHave = true;
    rec.occurrences.push({ start: c.start, end: c.end, text: c.text });
  }
  const out = [];
  for (const rec of byId.values()) {
    const sections = [...rec.sections];
    sections.sort((a, b) => (SECTION_RANK[b] || 0) - (SECTION_RANK[a] || 0));
    rec.section = sections[0] === 'title' ? 'responsibilities' : sections[0];
    rec.sections = sections;
    rec.occurrences.sort((a, b) => a.start - b.start);
    rec.term = rec.occurrences[0].text;
    out.push(rec);
  }
  out.sort((a, b) => a.occurrences[0].start - b.occurrences[0].start);
  return out;
}

function classifyKeyword(rec, resumeText) {
  const kw = rec.kw;
  if (kw.redflag) return 'redflag';
  if (textHasKeyword(rec.entry, resumeText)) return 'matched';
  if ((kw.evidence || []).length && !kw.forbidden) return 'supportable';
  return 'unsupported';
}

function coverage(jdKeywords, resumeText) {
  const scored = jdKeywords.filter((k) => !k.kw.redflag);
  const matched = [];
  const missing = [];
  for (const k of scored) (textHasKeyword(k.entry, resumeText) ? matched : missing).push(k.canonical);
  return { pct: scored.length ? Math.round((100 * matched.length) / scored.length) : 0, matched, missing, total: scored.length };
}

// Extra red-flag phrase spans from rules.redFlags (highlighted even when not in the taxonomy).
function redFlagSpans(text, redFlags) {
  const spans = [];
  for (const rf of redFlags || []) {
    for (const p of rf.phrases) for (const occ of findAll(phraseRegex(p, 'gi'), text)) spans.push({ start: occ.start, end: occ.end, status: 'redflag', term: occ.text, label: rf.label });
  }
  return spans;
}

function highlightSpans(text, keywordsWithStatus, redFlags) {
  const raw = [];
  for (const k of keywordsWithStatus) for (const o of k.occurrences) raw.push({ start: o.start, end: o.end, status: k.status, term: o.text, canonical: k.canonical });
  raw.push(...redFlagSpans(text, redFlags));
  raw.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const out = [];
  let lastEnd = -1;
  for (const s of raw) {
    if (s.start < lastEnd) {
      // red flags win over an overlapping keyword span
      const prev = out[out.length - 1];
      if (s.status === 'redflag' && prev && prev.status !== 'redflag' && s.start === prev.start) out[out.length - 1] = s, lastEnd = s.end;
      continue;
    }
    if (s.start < 0 || s.end > text.length || s.end <= s.start) continue;
    out.push(s);
    lastEnd = s.end;
  }
  return out;
}

module.exports = { compileTaxonomy, extractKeywords, classifyKeyword, coverage, highlightSpans, textHasKeyword };
