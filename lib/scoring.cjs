'use strict';

// Deterministic, explainable scoring: base ranking, % fit with breakdown, tailor decision, verdict.

const { hasPhrase, normalize } = require('./text.cjs');
const { coverage } = require('./keywords.cjs');
const { staleness } = require('./repo.cjs');

const GENERIC_NAME_TOKENS = new Set(['pm', 'pm1', 'apm', 'po', 'fo', 'acm', 'base', 'general', 'sr', 'associate']);

function nameSegments(name) {
  return name.split('_').filter((s) => s && !GENERIC_NAME_TOKENS.has(s.toLowerCase())).map((seg) => ({
    whole: seg.toLowerCase(),
    parts: seg.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(' ').filter(Boolean)
  }));
}

// Family score for a base = weighted share of its familyKeywords present in the JD (title hits count double).
// Submitted copies have no family keywords; their name tokens (company, theme) are matched instead.
function familyScore(resume, jd, rules) {
  const br = rules.baseRanking;
  const bodyText = jd.text;
  const titleText = `${jd.title} ${jd.company}`;
  if (resume.kind === 'base') {
    const fk = (resume.base && resume.base.familyKeywords) || [];
    if (!fk.length) return { score: 0, hits: [] };
    let pts = 0;
    const hits = [];
    for (const k of fk) {
      if (hasPhrase(titleText, k)) { pts += br.titleHitWeight; hits.push(`${k} (title)`); } else if (hasPhrase(bodyText, k)) { pts += 1; hits.push(k); }
    }
    return { score: Math.min(1, pts / br.familyHitsForFull), hits };
  }
  const segs = nameSegments(resume.name);
  if (!segs.length) return { score: 0, hits: [] };
  const norm = ` ${normalize(`${titleText} ${bodyText}`).replace(/[^a-z0-9]+/g, ' ')} `;
  const compact = norm.replace(/ /g, '');
  const hits = segs.filter((s) => compact.includes(s.whole) || s.parts.every((p) => norm.includes(` ${p} `))).map((s) => s.whole);
  return { score: hits.length / segs.length, hits };
}

function rankBases(jd, jdKeywords, resumes, rules, opts = {}) {
  const br = rules.baseRanking;
  const ranked = resumes.map((r) => {
    const fam = familyScore(r, jd, rules);
    const cov = coverage(jdKeywords, r.text);
    const score = Math.round(100 * (br.familyWeight * fam.score + br.keywordWeight * (cov.pct / 100)));
    return {
      name: r.name, kind: r.kind, label: r.label, family: r.family, fileName: r.fileName,
      score, keywordPct: cov.pct, familyScore: Math.round(fam.score * 100),
      why: `${Math.round(br.familyWeight * 100)}% family match ${Math.round(fam.score * 100)}%${fam.hits.length ? ` (${fam.hits.slice(0, 5).join(', ')})` : ''} + ${Math.round(br.keywordWeight * 100)}% keyword coverage ${cov.pct}%`
    };
  });
  // Repository: stale bases (missing evidence added after their last edit) lose a few points; recency breaks near-ties.
  const rp = rules.repo || {};
  if (opts.repo) {
    for (const r of ranked) {
      const rec = opts.repo.records[r.fileName];
      if (!rec) continue;
      r.modifiedAt = rec.modifiedAt;
      r.repoType = rec.type;
      const st = staleness(rec, opts.evidence || [], r.family);
      r.stale = st.stale;
      r.staleMissing = st.missing;
      if (st.stale && r.kind === 'base') { r.score -= rp.stalePenalty ?? 3; r.why += `; stale (missing newer evidence: ${st.missing.join(', ')}) -${rp.stalePenalty ?? 3}`; }
    }
  }
  ranked.sort((a, b) => b.score - a.score || b.keywordPct - a.keywordPct || a.name.localeCompare(b.name));
  let recommended = ranked.find((r) => r.kind === 'base') || null;
  if (recommended && opts.repo) {
    const near = ranked.filter((r) => r.kind === 'base' && recommended.score - r.score <= (rp.tieWindow ?? 5) && r.modifiedAt);
    const newest = near.reduce((a, b) => (new Date(b.modifiedAt) > new Date(a.modifiedAt || 0) ? b : a), recommended);
    if (newest !== recommended) {
      newest.why += `; chosen over ${recommended.name} (${recommended.score}) on recency: within ${rp.tieWindow ?? 5} pts and modified ${newest.modifiedAt.slice(0, 10)}`;
      recommended = newest;
    } else if (near.length > 1) {
      recommended.why += `; most recent of ${near.length} bases within ${rp.tieWindow ?? 5} pts`;
    }
  }
  const submittedTop = ranked.find((r) => r.kind === 'submitted') || null;
  return { recommended: recommended ? recommended.name : null, ranked, submittedTop: submittedTop ? submittedTop.name : null, submittedTopInfo: submittedTop };
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function computeFit({ gates, keywords, direction, level, redFlags, profile }, rules) {
  const s = rules.scoring;
  const w = s.weights;
  // Gates
  let gNum = 0;
  let gDen = 0;
  const counts = { met: 0, partial: 0, not_met: 0, unknown: 0 };
  for (const g of gates) {
    const wt = g.required ? s.requiredGateWeight : s.preferredGateWeight;
    gNum += wt * (s.gateValues[g.status] ?? s.gateValues.unknown);
    gDen += wt;
    counts[g.status] = (counts[g.status] || 0) + 1;
  }
  const G = gDen ? gNum / gDen : s.noGatesDefault;
  const notMet = gates.filter((g) => g.status === 'not_met').map((g) => g.requirement);
  // Red-flag keywords stay in (value 0): a required "own the P&L" is a capability gap, not just a flag.
  const scoredKw = keywords;
  const reqKw = scoredKw.filter((k) => k.section === 'required' || k.section === 'responsibilities');
  const prefKw = scoredKw.filter((k) => k.section === 'preferred');
  const kv = (k) => s.keywordValues[k.status] ?? 0;
  // Domain/tool keywords weigh more than generic methods; soft skills weigh least.
  const kwWeight = (k) => (k.kw && k.kw.soft ? (s.softKeywordWeight ?? 0.5) : ((s.keywordCategoryWeights || {})[k.category] ?? 1));
  const wmean = (arr) => {
    const den = arr.reduce((a, k) => a + kwWeight(k), 0);
    return den ? arr.reduce((a, k) => a + kwWeight(k) * kv(k), 0) / den : null;
  };
  const R = reqKw.length ? wmean(reqKw) : s.noPreferredDefault;
  const N = prefKw.length ? wmean(prefKw) : s.noPreferredDefault;
  const D = s.directionValues[direction.class] ?? s.directionValues.neutral;
  const L = s.levelValues[level.class] ?? s.levelValues.unknown;
  const cnt = (arr, st) => arr.filter((k) => k.status === st).length;
  const breakdown = [
    { component: 'Must-haves / gates', weight: w.gates, score01: G, why: gates.length ? `${counts.met} met, ${counts.partial} partial, ${counts.unknown} unknown, ${counts.not_met} not met${notMet.length ? `: ${notMet.slice(0, 4).join('; ')}` : ''} (required gates count x${s.requiredGateWeight})` : `No explicit gates detected; default ${s.noGatesDefault}` },
    { component: 'Responsibilities & required keywords', weight: w.responsibilities, score01: R, why: reqKw.length ? `${cnt(reqKw, 'matched')} matched, ${cnt(reqKw, 'supportable')} supportable (x${s.keywordValues.supportable}), ${cnt(reqKw, 'unsupported')} unsupported of ${reqKw.length}; weighted domain x${(s.keywordCategoryWeights || {}).domain ?? 1}, tool x${(s.keywordCategoryWeights || {}).tool ?? 1}, soft skills x${s.softKeywordWeight ?? 0.5}${cnt(reqKw, 'unsupported') ? `; missing: ${reqKw.filter((k) => k.status === 'unsupported').slice(0, 4).map((k) => k.canonical).join(', ')}` : ''}` : 'No required/responsibility keywords found' },
    { component: 'Nice-to-haves', weight: w.niceToHave, score01: N, why: prefKw.length ? `${cnt(prefKw, 'matched')} matched, ${cnt(prefKw, 'supportable')} supportable, ${cnt(prefKw, 'unsupported')} unsupported of ${prefKw.length}` : `No keywords that appear only in a nice-to-have section; default ${s.noPreferredDefault}` },
    { component: 'Direction', weight: w.direction, score01: D, why: `${direction.class}: ${direction.label}` },
    { component: 'Level', weight: w.level, score01: L, why: `${level.class}: ${level.why}` }
  ].map((b) => ({ ...b, score01: Math.round(b.score01 * 100) / 100, points: Math.round(1000 * b.weight * b.score01) / 10 }));
  const penalties = [];
  const rfCount = (redFlags || []).length;
  if (rfCount) penalties.push({ reason: `Red flags: ${redFlags.map((r) => r.label).join(', ')}`, points: -Math.min(s.redFlagPenaltyCap, s.redFlagPenalty * rfCount) });
  if (direction.deepVertical && direction.deepVertical.preferred.length) penalties.push({ reason: `Deep-vertical domain preferred: ${direction.deepVertical.preferred.join(', ')}`, points: -s.deepVerticalPreferredPenalty });
  const componentSum = breakdown.reduce((a, b) => a + b.points, 0);
  // Transfer discount: when the candidate does not hold the target title, recruiters discount transferable evidence.
  if (s.transferDiscount && profile && !profile.hasPmTitle) {
    penalties.unshift({ reason: `Title-transfer discount ${Math.round(s.transferDiscount * 100)}% (current title is not the target role title; all evidence is transferable, not same-title)`, points: -Math.round(10 * componentSum * s.transferDiscount) / 10 });
  }
  const raw = componentSum + penalties.reduce((a, p) => a + p.points, 0);
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  return { score, breakdown, penalties, formula: `round(100 x (${w.gates}G + ${w.responsibilities}R + ${w.niceToHave}N + ${w.direction}D + ${w.level}L)) - penalties` };
}

// ---------------------------------------------------------------- strictness threshold
// The apply threshold T (default rules.applyThreshold = 75, user-adjustable 40-95) drives the verdict bands.
// Honest edits are computed ONCE (single pass, no search toward T) and scored once:
//   fit >= T, no fix needed                         -> Apply as-is
//   projected fit (after honest edits) >= T         -> Tailor (light) - reaches threshold
//   projected < T, lift >= minLift, or a must-have gate fixed inside the band -> Tailor (salvage) - below threshold (user decides)
//   otherwise (incl. framing-only / zero-lift edits): fit >= T - band -> Hold / long shot; below -> Skip (user options still shown)
//   hard gate (checked before any band logic) / repeat -> Skip / Skip (repeat)
function thresholdSettings(rules) {
  const t = rules.threshold || {};
  return { def: rules.applyThreshold ?? 75, min: t.min ?? 40, max: t.max ?? 95, step: t.step ?? 5, tailorBand: t.tailorBand ?? 20, salvageMinLift: t.salvageMinLift ?? 10 };
}

function resolveThreshold(value, rules) {
  const s = thresholdSettings(rules);
  if (value === undefined || value === null || value === '') return s.def;
  const n = Number(value);
  if (!Number.isFinite(n)) return s.def;
  return Math.min(s.max, Math.max(s.min, Math.round(n)));
}

function bandsFor(T, rules) {
  const s = thresholdSettings(rules);
  const low = Math.max(0, T - s.tailorBand);
  return {
    threshold: T, tailorBand: s.tailorBand, salvageMinLift: s.salvageMinLift, tailorFloor: low, min: s.min, max: s.max, step: s.step, default: s.def,
    apply: `>= ${T}%`,
    tailor: `honest edits project >= ${T}% -> Tailor (reaches threshold); lift >= ${s.salvageMinLift} pts, or fixes a must-have gate while >= ${low}%, but < ${T}% -> Tailor (salvage)`,
    hold: `${low}-${T - 1}% with no worthwhile edit -> Hold / long shot`,
    skip: `< ${low}% with no worthwhile edit, or a hard gate -> Skip`
  };
}

function rolesCompatible(a, b, rules) {
  if (!a || !b) return true;
  if (a === b) return true;
  return (rules.directions.closingCompatible || []).some((grp) => grp.includes(a) && grp.includes(b));
}

// Which supportable JD keywords the proposed edit texts actually add (literal synonym match in the new text).
function keywordsAddedBy(edits, keywords) {
  const { textHasKeyword } = require('./keywords.cjs');
  const newText = edits.map((e) => e.new).join('\n');
  return keywords.filter((k) => k.status === 'supportable' && textHasKeyword(k.entry, newText));
}

// Single pass: the edit set is given (built once from the evidence bank + base swap slots, honesty-checked),
// scored once with recompute(), then classified. No iteration toward T.
function decideTailor({ fit, blockers, base, keywords, direction, jd, recompute, threshold, edits = [] }, rules) {
  const T = resolveThreshold(threshold, rules);
  const s = thresholdSettings(rules);
  const out = { decision: 'reuse', outcome: 'none', reason: '', baselineFit: fit, estimatedLift: 0, projectedFit: fit, gapToThreshold: Math.max(0, T - fit),
    fixesMustHave: [], fixesGate: [], closingMismatch: null, domainMismatch: null, additions: [], threshold: T, scoringCalls: 0 };
  const swapCapable = base && (base.swapSlots || []).length > 0;
  out.fixesMustHave = swapCapable ? keywords.filter((k) => k.mustHave && k.status === 'supportable' && k.category !== 'domain').map((k) => k.canonical) : [];
  if (base && base.closingRoleType && direction.class !== 'avoid' && direction.id && !rolesCompatible(base.closingRoleType, direction.id, rules)) {
    out.closingMismatch = { base: base.closingRoleType, jd: direction.id };
  }
  if (base && (base.closingDomainTerms || []).length && !base.closingDomainTerms.some((d) => hasPhrase(jd.text, d))) {
    out.domainMismatch = { terms: base.closingDomainTerms };
  }
  if (blockers.length) { out.reason = `Not tailoring: hard gate (${blockers[0].reason}).`; out.outcome = 'blocked'; return out; }
  const usable = edits.filter((e) => e.kind !== 'optional-domain');
  const added = keywordsAddedBy(usable, keywords);
  out.additions = added.map((k) => k.id);
  if (usable.length && recompute) {
    out.projectedFit = recompute(new Set(out.additions));
    out.scoringCalls = 1;
  }
  out.estimatedLift = Math.max(0, out.projectedFit - fit);
  out.projectedFit = fit + out.estimatedLift;
  out.gapToThreshold = Math.max(0, T - out.projectedFit);
  const fixesSomething = usable.length > 0 && (out.fixesMustHave.length > 0 || Boolean(out.closingMismatch));
  const what = [];
  if (out.fixesMustHave.length && usable.some((e) => e.kind === 'skill-swap')) what.push(`fixes a must-have (${out.fixesMustHave.join(', ')}) with a length-neutral skill swap`);
  if (out.closingMismatch && usable.some((e) => e.kind === 'closing-role')) what.push(`reframes the closing sentence from a ${out.closingMismatch.base} role to ${direction.label}`);
  const scoreLine = `baseline ${fit}% -> projected ${out.projectedFit}% vs T ${T}%`;
  if (fit >= T && !fixesSomething) { out.outcome = 'apply'; out.reason = `Reuse as-is: ${fit}% >= T ${T}% and no must-have or role framing to fix${out.domainMismatch ? ' (optional domain swap of the closing offered)' : ''}.`; return out; }
  if (usable.length && out.projectedFit >= T && (fixesSomething || out.estimatedLift > 0)) {
    out.decision = 'tailor'; out.outcome = 'reaches';
    out.reason = `Tailor (light), reaches threshold: ${what.join('; ') || `adds ${added.map((k) => k.canonical).join(', ')}`} (${scoreLine}).`;
    return out;
  }
  // Salvage needs a real benefit: a lift >= salvageMinLift, or an edit that actually adds a keyword from an explicit
  // must-have line (the must-have goes from unmet to met on the resume) while still inside the tailor band.
  // Framing-only fixes (closing role reframe) with little or no lift fall through to Hold / Skip.
  const gateFix = added.filter((k) => k.mustHave && k.category !== 'domain');
  out.fixesGate = gateFix.map((k) => k.canonical);
  if (usable.length && (out.estimatedLift >= s.salvageMinLift || (gateFix.length > 0 && out.projectedFit >= T - s.tailorBand))) {
    out.decision = 'tailor'; out.outcome = 'salvage';
    out.reason = `Tailor (salvage), below threshold: ${what.join('; ') || `adds ${added.map((k) => k.canonical).join(', ')}`} (${scoreLine}; ${out.gapToThreshold} pts still missing).`;
    return out;
  }
  out.outcome = 'none';
  out.reason = usable.length
    ? (gateFix.length
      ? `Honest edits ${what.join('; ') || 'fix a must-have'} but add only ${out.estimatedLift} pts and the projected ${out.projectedFit}% stays below the tailor band (${T - s.tailorBand}%) (${scoreLine}).`
      : `Honest edits ${what.length ? `${what.join('; ')} but ` : ''}add only ${out.estimatedLift} pts (< ${s.salvageMinLift}) and fix no must-have gate (${scoreLine}).`)
    : `No supportable edit exists for this JD (${scoreLine}).`;
  return out;
}

const VERDICT_LABELS = { apply_as_is: 'Apply as-is', tailor_light: 'Tailor (light) - reaches threshold', tailor_salvage: 'Tailor (salvage) - below threshold', skip: 'Skip', skip_repeat: 'Skip (repeat)', hold: 'Hold / long shot' };

function decideVerdict({ seenBefore, blockers, fit, tailor, base, threshold, gapReasons = [] }, rules) {
  const T = resolveThreshold(threshold, rules);
  const bands = bandsFor(T, rules);
  const notes = [];
  if (seenBefore) {
    if (seenBefore.status === 'pending') notes.push('seen before: pending in the checklist');
    if (seenBefore.status === 'held') notes.push('seen before: held in the checklist');
    if (seenBefore.status === 'previously_skipped') notes.push('seen before: skipped earlier');
    if (seenBefore.status === 'same_company_new_role') notes.push('same company, new role');
  }
  const tail = notes.length ? ` (${notes.join('; ')})` : '';
  const score = { baseline: fit, projected: tailor.projectedFit ?? fit, threshold: T, gapToThreshold: Math.max(0, T - (tailor.projectedFit ?? fit)) };
  const mk = (key, reason, band, extra = {}) => ({ key, label: VERDICT_LABELS[key], reason: reason + tail, threshold: T, band, bands, score, needsUserDecision: false, userOptions: [], gapReasons: [], ...extra });
  const handBack = (applyLabel) => ({ needsUserDecision: true, userOptions: [applyLabel, 'Skip', 'Hold'], gapReasons });
  if (seenBefore && seenBefore.status === 'repeat') {
    return mk('skip_repeat', `Already applied${seenBefore.resumeUsed ? ` with ${seenBefore.resumeUsed}` : ''}: send a recruiter/LinkedIn follow-up instead of reapplying`, 'repeat');
  }
  const skip = blockers.find((b) => b.action === 'skip');
  if (skip) return mk('skip', `Skip on ${skip.reason}`, 'hard gate', { gapReasons });
  const hold = blockers.find((b) => b.action === 'hold');
  if (hold) return mk('hold', `Hold: ${hold.reason}`, 'direction hold', handBack(`Apply with ${base} as-is`));
  if (tailor.outcome === 'apply') return mk('apply_as_is', `Apply with ${base} as-is: fit ${fit}% >= T ${T}%`, 'apply');
  if (tailor.outcome === 'reaches') return mk('tailor_light', tailor.reason.replace(/^Tailor \(light\), reaches threshold: /, `Tailor from ${base}: `).replace(/\.$/, ''), 'apply');
  if (tailor.outcome === 'salvage') return mk('tailor_salvage', tailor.reason.replace(/^Tailor \(salvage\), below threshold: /, `Salvage from ${base}: `).replace(/\.$/, '') + '. Your call', 'salvage', handBack('Apply with salvaged resume'));
  if (fit >= bands.tailorFloor) return mk('hold', `Hold / long shot: fit ${fit}% < T ${T}%. ${tailor.reason.replace(/\.$/, '')}`, 'hold', handBack(`Apply with ${base} as-is (long shot)`));
  return mk('skip', `Skip: fit ${fit}% is below ${bands.tailorFloor}% (T-${bands.tailorBand}). ${tailor.reason.replace(/\.$/, '')}`, 'skip', handBack(`Apply with ${base} as-is (long shot)`));
}

module.exports = { familyScore, rankBases, computeFit, decideTailor, decideVerdict, rolesCompatible, resolveThreshold, bandsFor, thresholdSettings, keywordsAddedBy, VERDICT_LABELS };
