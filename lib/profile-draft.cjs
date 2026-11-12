'use strict';

// Onboarding: a first DRAFT of profile facts, extracted from the user's uploaded resume text (read-only).
// Everything here is a suggestion the user confirms or edits before it is saved; nothing is inferred beyond the text.
//   draftProfile(resumes, keywords, { rules, now }) -> { totalYears, titles, education, certifications, tools, domains,
//                                                       skills, metrics, employer, currentRole, sources }

const { hasPhrase, slug } = require('./text.cjs');
const { compileTaxonomy, textHasKeyword } = require('./keywords.cjs');

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const MON = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const POINT = `(?:(${MON})\\s+(\\d{4})|(\\d{1,2})[/.-](\\d{4})|(\\d{4}))`;
const END = `(?:${POINT}|(present|current|now|till date|to date|ongoing))`;
const RANGE_RE = new RegExp(`${POINT}\\s*(?:-|–|—|to|until)\\s*${END}`, 'gi');

const EDU_LINE_RE = /\b(universit|college|institute|school of|academy|polytechnic)/i;
const DEGREE_RE = /\b(MBA|PGDM|Ph\.?\s?D\.?|M\.?\s?Sc\.?|B\.?\s?Sc\.?|M\.?\s?Tech\.?|B\.?\s?Tech\.?|B\.\s?E\.?|M\.\s?S\.?|B\.\s?S\.?|B\.\s?A\.?|M\.\s?A\.?|BBA|B\.?\s?Com\.?|Bachelor(?:'s)?(?: of [A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)?)?|Master(?:'s)?(?: of [A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)?)?)(?![A-Za-z])/;
const TITLE_RE = /\b(product manager|product owner|program manager|project manager|manager|analyst|engineer|developer|designer|consultant|associate|specialist|lead|director|scientist|architect|intern|coordinator|executive|officer|administrator|founder|head of [a-z]+)\b/i;
const CERT_RE = /\b(certified|certification|certificate|specialist|accredited)\b/i;
const CERT_HEAD_RE = /^(certifications?|licen[cs]es? (and|&) certifications?)\s*[:|]?\s*/i;
const METRIC_TOKEN_RE = /(?<![A-Za-z0-9])\$?\d[\d,.]*\s?(?:%|x\b|k\b|m\b|hrs?\b|\+)?/gi;
const SEP_RE = /\s*(?:\||,|;|\t|\s[-–—]\s|\s+at\s+|\s+@\s+)\s*/;

function monthIndex(name) { return MONTHS[String(name || '').slice(0, 3).toLowerCase()]; }

// One match of RANGE_RE -> [startMonth, endMonthExclusive] counted as year*12+month.
function rangeFromMatch(m, now) {
  const start = m[2] ? Number(m[2]) * 12 + monthIndex(m[1]) : m[4] ? Number(m[4]) * 12 + (Number(m[3]) - 1) : Number(m[5]) * 12;
  let end;
  if (m[11]) end = now.getFullYear() * 12 + now.getMonth() + 1;
  else if (m[7]) end = Number(m[7]) * 12 + monthIndex(m[6]) + 1;
  else if (m[9]) end = Number(m[9]) * 12 + Number(m[8]);
  else end = Number(m[10]) * 12 + 12;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  if (start < 1950 * 12 || end > (now.getFullYear() + 1) * 12) return null;
  return [start, end];
}

function dateRanges(line, now) {
  const out = [];
  RANGE_RE.lastIndex = 0;
  let m;
  while ((m = RANGE_RE.exec(line))) {
    const r = rangeFromMatch(m, now);
    if (r) out.push({ range: r, text: m[0] });
  }
  return out;
}

// Merged (overlap-free) month count of the given ranges.
function mergedMonths(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur = null;
  for (const r of sorted) {
    if (!cur || r[0] > cur[1]) { if (cur) total += cur[1] - cur[0]; cur = [...r]; } else cur[1] = Math.max(cur[1], r[1]);
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').replace(/^[\s,.;:|–—-]+|[\s,.;:|–—-]+$/g, '').trim();
const uniqBy = (arr, key) => { const seen = new Set(); return arr.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; }); };

function parseEducation(line) {
  const parts = line.split(SEP_RE).map(clean).filter(Boolean);
  const degPart = parts.find((p) => DEGREE_RE.test(p));
  if (!degPart) return null;
  const degree = clean(degPart.match(DEGREE_RE)[0]);
  const field = clean(degPart.slice(degPart.indexOf(degree.split(' ')[0]) + degree.length).replace(/^\s*(in|of)\s+/i, '').replace(/\(?\b(19|20)\d{2}\b\)?/g, ''));
  const school = parts.find((p) => p !== degPart && EDU_LINE_RE.test(p)) || '';
  return { id: slug(degree, 20) || 'degree', degree, ...(field && !EDU_LINE_RE.test(field) ? { field } : {}), school: clean(school.replace(/\(?\b(19|20)\d{2}\b\)?/g, '')) };
}

function phraseHit(text, gate) {
  return (gate.phrases || []).some((p) => (gate.caseSensitive ? new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text) : hasPhrase(text, p)));
}

function draftProfile(resumes, keywords = [], { rules = null, now = new Date() } = {}) {
  const list = (resumes || []).filter((r) => r && Array.isArray(r.paragraphs));
  const lines = uniqBy(list.flatMap((r) => r.paragraphs.flatMap((p) => String(p).split('\n'))).map((l) => l.trim()).filter(Boolean), (l) => l);
  const text = lines.join('\n');

  // Experience date ranges (education lines excluded) -> total years, titles, employer.
  const ranges = [];
  const jobs = [];
  for (const line of lines) {
    const found = dateRanges(line, now);
    if (!found.length) continue;
    if (EDU_LINE_RE.test(line) || DEGREE_RE.test(line)) continue;
    for (const f of found) ranges.push(f.range);
    const rest = found.reduce((s, f) => s.replace(f.text, ' | '), line);
    const parts = rest.split(SEP_RE).map(clean).filter(Boolean);
    const ti = parts.findIndex((p) => TITLE_RE.test(p) && p.length <= 80);
    if (ti < 0) continue;
    const employer = parts.find((p, i) => i !== ti && !/\d{4}/.test(p) && p.length <= 80) || '';
    jobs.push({ title: parts[ti], employer, end: Math.max(...found.map((f) => f.range[1])), line });
  }
  const totalYears = Math.round((mergedMonths(ranges) / 12) * 10) / 10;
  jobs.sort((a, b) => b.end - a.end);
  const titles = uniqBy(jobs.map((j) => j.title), (t) => t.toLowerCase());

  const education = uniqBy(lines.filter((l) => DEGREE_RE.test(l) && (EDU_LINE_RE.test(l) || DEGREE_RE.exec(l).index === 0)).map(parseEducation).filter(Boolean), (e) => `${e.degree}|${e.school}`.toLowerCase());

  const certNames = [];
  for (const l of lines) {
    if (CERT_HEAD_RE.test(l) && l.replace(CERT_HEAD_RE, '').trim()) certNames.push(...l.replace(CERT_HEAD_RE, '').split(/\s*[,;|]\s*/));
    else if (CERT_RE.test(l) && l.length <= 120 && !dateRanges(l, now).length && !TITLE_RE.test(l.replace(/specialist/gi, ''))) certNames.push(l);
  }
  const certifications = uniqBy(certNames.map(clean).filter((n) => n && n.length <= 120), (n) => n.toLowerCase())
    .map((name) => ({ id: slug(name, 40) || 'cert', name, aliases: [name.toLowerCase()] }));

  const tools = {};
  const domains = {};
  if (rules) {
    for (const g of rules.toolGates || []) if (phraseHit(text, g)) tools[g.id] = 'met';
    // Domains mentioned in a resume are only "partial" until the user confirms direct experience.
    for (const g of rules.domainGates || []) if (phraseHit(text, g)) domains[g.id] = 'partial';
  }
  const skills = [];
  for (const entry of compileTaxonomy(keywords || [])) {
    if (textHasKeyword(entry, text)) skills.push({ id: entry.kw.id, canonical: entry.kw.canonical, category: entry.kw.category || null });
  }

  const metrics = [];
  for (const l of lines) {
    if (dateRanges(l, now).length) continue;
    const toks = (l.match(METRIC_TOKEN_RE) || []).map((t) => t.trim()).filter((t) => /[%x$k+m]|hrs?$/i.test(t) || (t.replace(/\D/g, '').length >= 2 && !/^(19|20)\d{2}$/.test(t)));
    for (const t of toks) metrics.push({ metric: t, text: l.slice(0, 200) });
  }

  const current = jobs[0] || null;
  return {
    totalYears,
    titles,
    currentRole: current ? current.title : '',
    employer: current ? current.employer : '',
    hasPmTitle: titles.some((t) => /product (manager|owner)|\bapm\b/i.test(t)),
    education,
    certifications,
    tools,
    domains,
    skills,
    metrics: uniqBy(metrics, (m) => `${m.metric}|${m.text}`).slice(0, 25),
    sources: list.map((r) => r.name)
  };
}

// ---------------------------------------------------------------- confirm (user-edited draft -> profile.json + rules.json)
function badInput(message) {
  const e = new Error(message);
  e.statusCode = 400;
  e.code = 'BAD_ONBOARDING';
  return e;
}
const str = (v, max = 160) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const STATUS = new Set(['met', 'partial', 'not_met']);

function statusMap(v, label) {
  const out = {};
  if (v === undefined || v === null) return out;
  if (Array.isArray(v)) { for (const k of v) if (str(k, 60)) out[str(k, 60).toLowerCase()] = 'met'; return out; }
  if (typeof v !== 'object') throw badInput(`${label} must be an object of {id: met|partial|not_met}.`);
  for (const [k, s] of Object.entries(v)) {
    if (!STATUS.has(s)) throw badInput(`${label}.${k} must be met, partial or not_met.`);
    if (str(k, 60)) out[str(k, 60).toLowerCase()] = s;
  }
  return out;
}

// existing = the profile's current profile.json; input = the edited draft. Facts only come from the user's input.
function buildProfile(existing, input = {}) {
  const years = Number(input.totalYears);
  if (!Number.isFinite(years) || years < 0 || years > 60) throw badInput('totalYears must be a number between 0 and 60.');
  const list = (v, max = 30) => (Array.isArray(v) ? v.slice(0, max) : []);
  const education = list(input.education).map((e) => (typeof e === 'string' ? { degree: str(e, 80) } : { degree: str(e && e.degree, 80), ...(str(e && e.field, 80) ? { field: str(e.field, 80) } : {}), school: str(e && e.school, 120) }))
    .filter((e) => e.degree).map((e, i) => ({ id: slug(e.degree, 20) ? `${slug(e.degree, 20)}${i ? `-${i + 1}` : ''}` : `degree-${i + 1}`, ...e }));
  const certifications = uniqBy(list(input.certifications).map((c) => str(typeof c === 'string' ? c : c && c.name, 120)).filter(Boolean), (n) => n.toLowerCase())
    .map((name, i) => ({ id: `${slug(name, 40) || 'cert'}-${i + 1}`, name, aliases: [name.toLowerCase()] }));
  const phrases = uniqBy(list(input.forbiddenPhrases, 50).map((p) => str(p, 120)).filter(Boolean), (p) => p.toLowerCase());
  const userClaims = phrases.map((p, i) => ({ id: `user-${slug(p, 30) || i + 1}`, pattern: escapeRe(p), message: `Not claimed: "${p}" (you said you cannot back this up).` }));
  const kept = (existing.forbiddenClaims || []).filter((f) => !String(f.id).startsWith('user-'));
  const currentRole = str(input.currentRole, 120);
  const titles = list(input.titles).map((t) => str(t, 120)).filter(Boolean);
  return {
    ...existing,
    name: str(input.name, 80) || existing.name || '',
    totalYears: Math.round(years * 10) / 10,
    hasPmTitle: [currentRole, ...titles].some((t) => /product (manager|owner)|\bapm\b/i.test(t)),
    employer: str(input.employer, 120),
    currentRole,
    education,
    certifications,
    tools: statusMap(input.tools, 'tools'),
    domains: statusMap(input.domains, 'domains'),
    forbiddenClaims: [...kept, ...uniqBy(userClaims, (c) => c.id)],
    honestyMode: 'generic'
  };
}

// Rules override from the default catalog: choices = { <directionId>: 'target'|'neutral'|'avoid' } (missing = catalog class).
function buildRulesOverride(defaults, input = {}) {
  const thr = defaults.threshold || {};
  const tMin = thr.min ?? 40;
  const tMax = thr.max ?? 95;
  const T = input.applyThreshold === undefined || input.applyThreshold === null || input.applyThreshold === '' ? 75 : Number(input.applyThreshold);
  if (!(Number.isFinite(T) && T >= tMin && T <= tMax)) throw badInput(`applyThreshold must be a number between ${tMin} and ${tMax}.`);
  const band = input.tailorBand === undefined || input.tailorBand === null || input.tailorBand === '' ? 20 : Number(input.tailorBand);
  if (!(Number.isInteger(band) && band >= 0 && band <= tMax - tMin)) throw badInput(`tailorBand must be a whole number between 0 and ${tMax - tMin}.`);
  const ceiling = input.ceiling === undefined || input.ceiling === null || input.ceiling === '' ? defaults.level.okMaxMinYears : Number(input.ceiling);
  if (!(Number.isInteger(ceiling) && ceiling >= 0 && ceiling <= 40)) throw badInput('Seniority ceiling must be a whole number of years between 0 and 40.');
  const choices = input.directions && typeof input.directions === 'object' ? input.directions : {};
  const d = defaults.directions;
  const target = [];
  const avoid = [];
  const pick = (id, cls) => {
    const c = choices[id];
    if (c !== undefined && !['target', 'neutral', 'avoid'].includes(c)) throw badInput(`Direction "${id}" must be target, neutral or avoid.`);
    return c || cls;
  };
  for (const t of d.target || []) {
    const c = pick(t.id, 'target');
    if (c === 'target') target.push(structuredClone(t));
    else if (c === 'avoid') avoid.push({ id: t.id, label: t.label, action: 'skip', titlePhrases: [...(t.titlePhrases || [])], phrases: [...(t.bodyPhrases || [])], minHits: 2 });
  }
  for (const a of d.avoid || []) {
    const c = pick(a.id, 'avoid');
    if (c === 'avoid') avoid.push(structuredClone(a));
    else if (c === 'target' && a.id !== 'deep_vertical') target.push({ id: a.id, label: a.label, titlePhrases: [...(a.titlePhrases || [])], bodyPhrases: [...(a.phrases || [])] });
  }
  const known = new Set([...(d.target || []), ...(d.avoid || [])].map((x) => x.id));
  for (const id of Object.keys(choices)) if (!known.has(id)) throw badInput(`Unknown direction "${id}".`);
  return {
    _comment: 'Written by onboarding. Deep-merged over the tool defaults (objects merge, arrays replace).',
    applyThreshold: T,
    threshold: { tailorBand: band },
    level: { okMaxMinYears: ceiling, tooSeniorMinYears: ceiling + 1 },
    directions: { target, avoid }
  };
}

module.exports = { draftProfile, buildProfile, buildRulesOverride, dateRanges, mergedMonths };
