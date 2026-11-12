'use strict';

// Suggestions built only from the evidence bank, the honesty guard, interview probes, "why this role",
// and tailor-resume.ps1-compatible replacement JSON (never executed by this tool).

const fs = require('fs');
const path = require('path');
const { hasPhrase, slug } = require('./text.cjs');

const INFLATION_WORDS = ['manager', 'director', 'head', 'vp', 'chief'];
const METRIC_TOKEN_RE = /(?<![A-Za-z0-9])\$?\d[\d,.]*\s?(?:%|x\b|k\b|m\b|hrs?\b|\+)?/gi;
// Aspiration sentences ("Seeking a Product Manager role ...") name a target, not a held title.
const ASPIRATION_RE = /\b(seeking|keen to|looking for|aspir\w*|interested in|want the|want to)\b[^.]*\.?/gi;

// Generic guard for profiles with honestyMode "generic" (no hand-written forbidden list yet):
// a seniority/title word or a metric that the resume (and the evidence bank) does not already contain.
function genericFlags(s, config, resumeText) {
  const flags = [];
  const resume = String(resumeText || '');
  const claimText = s.replace(ASPIRATION_RE, ' ');
  const words = [...new Set([...((config.rules.level || {}).seniorTitleWords || []), ...INFLATION_WORDS])];
  for (const w of words) {
    const re = new RegExp(`(?<![A-Za-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i');
    const m = claimText.match(re);
    if (m && !re.test(resume)) {
      flags.push({ id: 'title-inflation', message: `"${m[0]}" is not a title or seniority word in your resume; do not inflate the title.`, match: m[0], excerpt: claimText.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).trim() });
      break;
    }
  }
  const evidenceText = (config.profile.evidence || []).map((e) => [e.claim, e.brief, e.skillLabel].filter(Boolean).join(' ')).join('\n');
  for (const raw of s.match(METRIC_TOKEN_RE) || []) {
    const tok = raw.trim().replace(/[.,]+$/, '');
    const digits = tok.replace(/\D/g, '');
    if (!/[%x$k+m]|hr/i.test(tok) && digits.length < 2) continue; // single bare digits are not metrics
    if (resume.includes(tok) || evidenceText.includes(tok)) continue;
    flags.push({ id: 'unverifiable-metric', message: `The metric "${tok}" is not in your resume or evidence bank; only use numbers you can back up.`, match: tok, excerpt: tok });
    break;
  }
  return flags;
}

// opts.resumeText: the resume the text would go into (used by the generic guard only).
function honestyGuard(text, config, directionId, { resumeText } = {}) {
  const flags = [];
  const s = String(text || '');
  const lower = s.toLowerCase();
  if (config.profile && config.profile.honestyMode === 'generic' && typeof resumeText === 'string') flags.push(...genericFlags(s, config, resumeText));
  for (const fc of config.forbidden) {
    if ((fc.allowWhenDirection || []).includes(directionId)) continue;
    fc.regex.lastIndex = 0;
    let m;
    while ((m = fc.regex.exec(s))) {
      if (m[0].length === 0) { fc.regex.lastIndex++; continue; }
      if (fc.exceptRegex && fc.exceptRegex.test(s.slice(m.index, m.index + 40))) continue;
      if (fc.near) {
        const win = fc.window || 120;
        const around = lower.slice(Math.max(0, m.index - win), m.index + m[0].length + win);
        if (!around.includes(fc.near.toLowerCase())) continue;
      }
      flags.push({ id: fc.id, message: fc.message, match: m[0], excerpt: s.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30) });
      break;
    }
  }
  return flags;
}

function evidenceById(config) {
  return new Map(config.profile.evidence.map((e) => [e.id, e]));
}

function buildImprovements(keywords, config, jd) {
  const ev = evidenceById(config);
  const forbiddenById = new Map(config.forbidden.map((f) => [f.id, f]));
  const bridges = config.profile.bridges || {};
  const order = { required: 0, responsibilities: 1, preferred: 2, other: 3 };
  const sorted = [...keywords].sort((a, b) => (b.mustHave - a.mustHave) || (order[a.section] - order[b.section]));
  const add = [];
  const doNotClaim = [];
  for (const k of sorted) {
    if (k.status === 'supportable') {
      const claims = (k.kw.evidence || []).map((id) => ev.get(id)).filter(Boolean).sort((a, b) => String(b.dateAdded || '').localeCompare(String(a.dateAdded || '')));
      add.push({ keyword: k.canonical, id: k.id, section: k.section, mustHave: k.mustHave, evidenceIds: claims.map((c) => c.id),
        suggestion: `Work "${k.canonical}" into the summary or skills line; supported by: ${claims.map((c) => c.claim).join(' / ')}` });
    } else if (k.status === 'unsupported' || (k.status === 'redflag' && k.kw.forbidden)) {
      const fc = k.kw.forbidden ? forbiddenById.get(k.kw.forbidden) : null;
      doNotClaim.push({ keyword: k.canonical, id: k.id, section: k.section, mustHave: k.mustHave,
        reason: fc ? `Forbidden claim: ${fc.message}` : 'No supporting evidence in the evidence bank.',
        bridge: bridges[k.id] || `Prep an honest talking point: what you know about ${k.canonical}, the closest thing you have done, and how you would ramp up.` });
    }
  }
  const ids = new Set(keywords.map((k) => k.id));
  const dir = config.paths.workSamplesDir;
  const workSamples = (config.profile.workSamples || [])
    .filter((w) => (w.tags || []).some((t) => ids.has(t)))
    .map((w) => ({ ...w, path: dir ? path.join(dir, w.file) : w.file, exists: dir ? fs.existsSync(path.join(dir, w.file)) : false, why: `Matches JD keywords: ${(w.tags || []).filter((t) => ids.has(t)).join(', ')}` }));
  return { add, doNotClaim, workSamples };
}

// Reasons the remaining gap to T cannot be honestly closed by resume edits, each with an interview-prep bridge.
function buildGapReasons({ gates, improvements }, config) {
  const bridges = config.profile.bridges || {};
  const out = [];
  for (const g of gates) {
    if (g.status === 'met' || g.status === 'unknown') continue;
    if (!g.required && g.status === 'partial') continue;
    const key = String(g.domainId || g.requirement || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    out.push({ gap: `${g.category}: ${g.requirement}`.slice(0, 140), status: g.status, why: g.evidence,
      bridge: bridges[key] || bridges[g.domainId] || (g.category === 'years' ? (config.profile.probes || []).find((p) => p.id === 'no-pm-title')?.bridge : null) || 'Not closable by editing the resume; prepare an honest answer about how you would ramp up.' });
  }
  for (const d of improvements.doNotClaim) {
    if (!(d.mustHave || d.section === 'required')) continue;
    if (out.some((o) => o.gap.toLowerCase().includes(d.keyword.toLowerCase()))) continue;
    out.push({ gap: `keyword: ${d.keyword}`, status: 'unsupported', why: d.reason, bridge: d.bridge });
  }
  return out.slice(0, 10);
}

function buildProbes({ level, keywords, gates }, config) {
  const ids = new Set(keywords.map((k) => k.id));
  const domainGap = gates.some((g) => g.category === 'domain' && g.status !== 'met');
  const picked = [];
  for (const p of config.profile.probes || []) {
    const [kind, arg] = String(p.when || 'always').split(':');
    let ok = false;
    if (kind === 'always') ok = false;
    else if (kind === 'level') ok = Boolean(level[arg]) && level.class !== 'ok';
    else if (kind === 'keyword') ok = ids.has(arg);
    else if (kind === 'gate') ok = arg === 'domain' ? domainGap : gates.some((g) => g.category === arg && g.status !== 'met');
    if (ok) picked.push({ question: p.question, bridge: p.bridge, why: `Triggered by ${p.when}` });
  }
  for (const p of config.profile.probes || []) {
    if (picked.length >= 3) break;
    if (String(p.when) === 'always') picked.push({ question: p.question, bridge: p.bridge, why: 'Common probe' });
  }
  return picked.slice(0, 5);
}

function buildWhyRole({ company, title, keywords }, config) {
  const ev = evidenceById(config);
  const used = [];
  for (const k of keywords) {
    if (k.status !== 'matched' && k.status !== 'supportable') continue;
    for (const id of k.kw.evidence || []) {
      if (!used.includes(id) && ev.get(id) && ev.get(id).brief) used.push(id);
    }
  }
  const top = used.slice(0, 3).map((id) => ev.get(id));
  const tpl = config.profile.whyRoleTemplates || {};
  const fill = (s) => String(s || '').replace(/\{company\}/g, company || 'your company').replace(/\{role\}/g, title || 'this').replace(/\{employer\}/g, config.profile.employer || 'my current employer');
  const parts = [fill(tpl.opening)];
  if (top.length) {
    const list = top.map((e) => e.brief);
    const joined = list.length > 1 ? `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}` : list[0];
    parts.push(fill(tpl.evidenceSentence).replace('{claim}', joined));
    const themes = [...new Set(top.map((e) => e.theme).filter(Boolean))];
    if (themes.length) parts.push(`Those are the skills this role leans on: ${themes.join(', ')}.`);
  }
  parts.push(fill(tpl.closing));
  const text = parts.filter(Boolean).join(' ');
  return { text, words: text.split(/\s+/).length, evidenceIds: top.map((e) => e.id) };
}

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) { n++; i = hay.indexOf(needle, i + needle.length); }
  return n;
}

// First configured domain phrase whose keyword appears in the JD (config order = priority).
function domainPhraseFor(keywords, rules) {
  const ids = new Set(keywords.map((k) => k.id));
  const hit = (rules.tailor.domainPhrases || []).find((d) => ids.has(d.id));
  return hit ? hit.phrase : '';
}

// Pick the first candidate within the allowed length delta (never longer for zero-spare-line bases).
function fitLength(candidates, old, maxDelta, neverLonger) {
  const ok = (c) => {
    const delta = c.length - old.length;
    return neverLonger ? delta <= 0 : Math.abs(delta) <= maxDelta;
  };
  const hit = candidates.find(ok);
  if (hit) return hit;
  const allowed = neverLonger ? candidates.filter((c) => c.length <= old.length) : candidates;
  if (!allowed.length) return null;
  return allowed.reduce((a, b) => (Math.abs(b.length - old.length) < Math.abs(a.length - old.length) ? b : a));
}

function buildClosing(base, direction, jd, keywords, rules, roleSwap, wantAll) {
  const t = rules.tailor;
  const labels = t.closingRoleLabels || {};
  const old = base.closingSentence;
  const domain = domainPhraseFor(keywords, rules);
  const cands = [];
  if (!roleSwap && /^Keen to apply/i.test(old)) {
    const theme = (t.closingThemes || []).find((th) => keywords.some((k) => k.id === th.id && k.status !== 'unsupported'));
    const lead = theme ? theme.phrase : 'agent building and evaluation';
    if (domain) cands.push(`Keen to apply ${lead} ${domain}.`);
  }
  const role = labels[direction.id] || 'product role';
  const article = /^[aeiou]/i.test(role) ? 'an' : 'a';
  if (domain) cands.push(`Seeking ${article} ${role} ${domain}.`);
  cands.push(`Seeking ${article} ${role}.`);
  if (wantAll) return cands.filter((c) => c.length <= old.length + t.maxClosingLengthDelta);
  return fitLength(cands, old, t.maxClosingLengthDelta, Boolean(base.zeroSpareLines));
}

// Builds the honest edit set ONCE: at most one skill swap (a supportable keyword the base lacks, into the base's
// configured swap slot) and one closing-sentence swap. Each edit must match exactly once in the base and pass the
// honesty guard. Nothing here searches for edits that would reach a threshold.
function buildEdits({ resume, direction, jd, keywords }, config) {
  const rules = config.rules;
  const { rolesCompatible } = require('./scoring.cjs');
  const base = resume && resume.base;
  const notes = [];
  const edits = [];
  if (!base) return { edits, notes: ['No base selected.'] };
  const text = resume.paragraphs.join('');
  const pushChecked = (rep, label) => {
    if (!rep.new) { notes.push(`Dropped ${label}: no length-neutral wording fits ${resume.name}.`); return; }
    const n = countOccurrences(text, rep.old);
    if (n !== 1) { notes.push(`Dropped ${label}: "old" text occurs ${n} times in ${resume.name} (tailor-resume.ps1 would exit 2).`); return; }
    const guardOpts = { resumeText: resume.text };
    const flags = honestyGuard(rep.new, config, direction.id, guardOpts);
    if (flags.length) { notes.push(`Dropped ${label}: honesty guard flagged ${flags.map((f) => f.id).join(', ')}.`); return; }
    // Shorter variants (pre-computed now, used only if tailor-resume.ps1 reports > 1 page) must pass the same guard.
    if (rep.variants) rep.variants = rep.variants.filter((v) => v !== rep.new && !honestyGuard(v, config, direction.id, guardOpts).length);
    edits.push(rep);
  };
  const fix = keywords.find((k) => k.mustHave && k.status === 'supportable' && k.category !== 'domain')
    || keywords.find((k) => k.section === 'required' && k.status === 'supportable' && k.category !== 'domain' && !k.kw.soft);
  if (fix && base.swapSlots && base.swapSlots.length) {
    const slot = base.swapSlots[0];
    // Recency priority: the newest evidence item with a skill label for this keyword wins.
    const evMap = new Map(config.profile.evidence.map((e) => [e.id, e]));
    const newest = (fix.kw.evidence || []).map((id) => evMap.get(id)).filter((e) => e && e.skillLabel).sort((a, b) => String(b.dateAdded || '').localeCompare(String(a.dateAdded || '')))[0];
    const label = (newest && newest.skillLabel) || fix.kw.resumeLabel || fix.canonical;
    pushChecked({ old: slot.old, new: slot.keep ? `${label} | ${slot.keep}` : label, kind: 'skill-swap', why: `adds "${fix.canonical}" (${fix.mustHave ? 'must-have' : 'required'}; evidence: ${(fix.kw.evidence || []).join(', ')})` }, 'skill swap');
  }
  const roleMismatch = base.closingRoleType && direction.class !== 'avoid' && direction.id && !rolesCompatible(base.closingRoleType, direction.id, rules);
  const domainMismatch = (base.closingDomainTerms || []).length && !base.closingDomainTerms.some((d) => hasPhrase(jd.text, d));
  if (roleMismatch && base.closingSentence) {
    pushChecked({ old: base.closingSentence, new: buildClosing(base, direction, jd, keywords, rules, true), variants: buildClosing(base, direction, jd, keywords, rules, true, true), kind: 'closing-role', why: `closing targets a ${base.closingRoleType} role; this JD is ${direction.label}` }, 'closing swap');
  } else if (domainMismatch && base.closingSentence) {
    pushChecked({ old: base.closingSentence, new: buildClosing(base, direction, jd, keywords, rules, false), kind: 'optional-domain', why: `closing names ${base.closingDomainTerms.join('/')}, not in this JD (optional; not scored)` }, 'optional closing swap');
  }
  return { edits, notes };
}

function suggestTargetName(jd, direction, base) {
  const prefixes = { po: 'PO', apm: 'APM', founders_office: 'FO', category_marketing: 'ACM' };
  const pre = prefixes[direction.id] || 'PM';
  const camel = (s) => String(s || '').replace(/[^A-Za-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  const company = camel(jd.company).slice(0, 20) || 'Company';
  const generic = /^(senior|sr|associate|product|manager|management|pm|apm|owner|lead|i|ii|iii|the|of|and|a|an|role|digital)$/i;
  const words = String(jd.title || '').replace(/[^A-Za-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !generic.test(w)).slice(0, 2);
  const theme = camel(words.join(' ')).slice(0, 24) || (base || 'Tailored');
  return `${pre}_${company}_${theme}`;
}

function buildCommand({ config, baseName, targetName, slugName }) {
  const p = config.paths;
  const json = path.join(p.tailorRunsDir, `${slugName}.json`);
  return {
    jsonPath: json,
    command: `powershell.exe -NoProfile -File "${p.tailorScript}" -Source ${p.resumeFilePrefix}${baseName}.docx -Target ${p.resumeFilePrefix}${targetName}.docx -Replacements "${json}"`,
    exitCodes: '0 ok | 2 old text not found/ambiguous | 3 protected token lost | 4 forbidden new claim | 5 more than 1 page | 6 file open in Word | 7 other'
  };
}

function runSlug(jd) {
  return slug(`${jd.company || 'jd'} ${jd.title || ''}`, 60);
}

module.exports = { honestyGuard, buildImprovements, buildGapReasons, buildProbes, buildWhyRole, buildEdits, suggestTargetName, buildCommand, runSlug, countOccurrences, hasPhrase };
