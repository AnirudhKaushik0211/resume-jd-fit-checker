'use strict';

// JD parsing: company / title / location heuristics and section tagging per line.

const { fixMojibake, hasPhrase } = require('./text.cjs');

// Heading patterns are anchored at the start so short body lines ("SQL is a plus") are not mistaken for headings.
const HEADING_RE = {
  required: /^(requirements|must[- ]haves?|what you('|’)?ll bring|what you bring|(basic|minimum|required|key|mandatory) (qualifications|requirements|skills)|qualifications|who you are|you have|you bring|what we('|’)?re looking for|what we look for|skills|eligibility|about you|your profile|experience)/i,
  preferred: /^(preferred|nice[- ]to[- ]haves?|bonus|good[- ]to[- ]haves?|desired|pluses|plus points|additional)|(preferred|desired) (qualifications|skills|experience)/i,
  responsibilities: /^(responsibilit|key responsibilit|what you('|’)?ll (do|own)|what you will|the role|you will|your impact|day[- ]to[- ]day|what the job involves|job description|role overview|in this role|your role|about the role)/i,
  other: /^(about (us|the company|[A-Z][\w&.\- ]{1,40})$|benefits|perks|why join|know more|life at|culture|equal opportunity|our commitment|compensation|how to apply|location)/i,
  mustHeading: /must[- ]haves?\s*:?$|^must[- ]haves?\b|\(must[- ]have\)/i
};
const MUST_RE = /\b(must|required|mandatory|non-negotiable|must[- ]have)\b/i;
const PREF_RE = /\b(nice[- ]to[- ]have|preferred|a plus|is a plus|bonus|good[- ]to[- ]have|desirable|advantageous)\b/i;

function looksLikeHeading(line) {
  const t = line.trim();
  if (!t || t.length > 80) return false;
  if (/[.;]$/.test(t)) return false;
  if (/^[-*•·]/.test(t)) return false;
  const words = t.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
  return words <= 7 || (/:$/.test(t) && words <= 12);
}

function classifyHeading(line) {
  const t = line.trim().replace(/:$/, '');
  const mustHave = HEADING_RE.mustHeading.test(t);
  if (HEADING_RE.preferred.test(t) && !mustHave) return { section: 'preferred', mustHave: false };
  if (/^about the role$/i.test(t)) return { section: 'responsibilities', mustHave: false };
  if (HEADING_RE.other.test(t)) return { section: 'other', mustHave: false };
  if (mustHave) return { section: 'required', mustHave: true };
  if (HEADING_RE.required.test(t)) return { section: 'required', mustHave: /\b(minimum|basic)\b/i.test(t) };
  if (HEADING_RE.responsibilities.test(t)) return { section: 'responsibilities', mustHave: false };
  return null;
}

function detectCompany(lines) {
  for (const l of lines.slice(0, 12)) {
    let m = l.match(/^@\s*(.+)$/);
    if (m) return m[1].trim();
    m = l.match(/^(?:company|organization|organisation|employer|hiring company)\s*[:\-–]\s*(.+)$/i);
    if (m) return m[1].trim();
  }
  if (lines[1]) {
    const m = lines[1].match(/^at\s+([A-Z][\w&.'\- ]{1,50})$/);
    if (m) return m[1].trim();
  }
  if (lines[0]) {
    const m = lines[0].match(/^(.{3,80}?)\s+(?:@|at)\s+([A-Z][\w&.'\- ]{1,50})$/);
    if (m) return m[2].trim();
  }
  for (const l of lines.slice(0, 40)) {
    const m = l.match(/^about\s+([A-Z][\w&.'\- ]{1,40})$/);
    if (m && !/^(the|us|our|you|this)\b/i.test(m[1])) return m[1].trim();
  }
  return '';
}

function detectTitle(lines) {
  const first = lines.find((l) => l.trim());
  if (!first) return '';
  const t = first.trim();
  const m = t.match(/^(.{3,80}?)\s+(?:@|at)\s+[A-Z][\w&.'\- ]{1,50}$/);
  if (m) return m[1].trim();
  return t.length <= 100 ? t : '';
}

function detectLocation(text, rules) {
  const m = text.match(/^(?:location|based in|work location)\s*[:\-–]\s*(.+)$/im);
  if (m) return m[1].trim().slice(0, 80);
  const cities = (rules && rules.locations && rules.locations.cities) || [];
  const found = cities.filter((c) => hasPhrase(text, c));
  return found.length ? found.map((c) => c.replace(/\b\w/g, (x) => x.toUpperCase())).join(' / ') : '';
}

function parseJd({ text, company, title } = {}, rules) {
  const clean = fixMojibake(String(text || '').replace(/\r\n?/g, '\n'));
  const rawLines = clean.split('\n');
  const nonEmpty = rawLines.map((l) => l.trim()).filter(Boolean);
  const outTitle = String(title || '').trim() || detectTitle(nonEmpty);
  const outCompany = String(company || '').trim() || detectCompany(nonEmpty);
  const lines = [];
  let offset = 0;
  let section = 'responsibilities';
  let sectionMust = false;
  let sawHeading = false;
  rawLines.forEach((raw, i) => {
    const start = offset;
    offset += raw.length + 1;
    const t = raw.trim();
    if (!t) return;
    const isFirst = !lines.length && t === nonEmpty[0];
    const heading = !isFirst && looksLikeHeading(t) ? classifyHeading(t) : null;
    if (heading) {
      section = heading.section;
      sectionMust = heading.mustHave;
      sawHeading = true;
      lines.push({ text: t, section, mustHave: sectionMust, heading: true, start: start + raw.indexOf(t), end: start + raw.indexOf(t) + t.length, index: i });
      return;
    }
    let lineSection = section;
    let mustHave = sectionMust;
    if (PREF_RE.test(t)) { lineSection = 'preferred'; mustHave = false; }
    else if (MUST_RE.test(t)) { lineSection = section === 'other' ? 'other' : 'required'; mustHave = section !== 'other'; }
    if (isFirst || (outCompany && /^@/.test(t))) lineSection = 'title';
    lines.push({ text: t, section: lineSection, mustHave, heading: false, start: start + raw.indexOf(t), end: start + raw.indexOf(t) + t.length, index: i });
  });
  return { company: outCompany, title: outTitle, location: detectLocation(clean, rules), text: clean, lines, sawHeading };
}

module.exports = { parseJd, classifyHeading, looksLikeHeading };
