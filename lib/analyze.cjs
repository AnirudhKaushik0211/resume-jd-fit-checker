'use strict';

// Orchestrator: analyze(input, ctx, options) -> full, explainable result in UI order.

const fs = require('fs');
const { parseJd } = require('./jd.cjs');
const { extractKeywords, classifyKeyword, coverage, highlightSpans } = require('./keywords.cjs');
const { detectLevel, detectDirection, detectRedFlags, evaluateGates, findBlockers } = require('./rules.cjs');
const { rankBases, computeFit, decideTailor, decideVerdict, resolveThreshold, bandsFor } = require('./scoring.cjs');
const advice = require('./advice.cjs');
const { seenBefore, parseChecklist, formatLogEntry } = require('./checklist.cjs');
const history = require('./history.cjs');
const { loadResumes } = require('./resumes.cjs');
const { loadRepo, saveRepo, refreshRepo, repoSeenEntries } = require('./repo.cjs');
const { loadApplications, toChecklistEntries } = require('./applications.cjs');

// Log entries = the markdown checklist (if the profile has one) + data\applications.json (if any), both checklist-shaped.
function readLog(config, resumeNames, warnings) {
  let checklist = [];
  if (config.paths.checklist) {
    try {
      checklist = parseChecklist(fs.readFileSync(config.paths.checklist, 'utf8'), config.rules, resumeNames);
    } catch (error) {
      warnings.push(`Checklist could not be read: ${error.message}`);
    }
  }
  if (config.paths.applicationsFile) checklist = [...checklist, ...toChecklistEntries(loadApplications(config.paths.applicationsFile))];
  return checklist;
}

// Re-read the log after an application was recorded / a line appended (keeps the old list if reading fails).
function refreshLog(ctx) {
  const warnings = [];
  const next = readLog(ctx.config, ctx.resumes.map((r) => r.name), warnings);
  if (!warnings.length) ctx.checklist = next;
  return ctx.checklist;
}

function buildContext(config, options = {}) {
  const loaded = loadResumes(config);
  const warnings = [...loaded.warnings];
  const checklist = readLog(config, loaded.resumes.map((r) => r.name), warnings);
  let repo = { version: 1, records: {} };
  if (config.paths.repoFile) {
    repo = loadRepo(config.paths.repoFile);
    refreshRepo(repo, { resumes: loaded.resumes, checklist, baseMapRows: loaded.baseMapRows, config });
    if (options.persistRepo !== false) { try { saveRepo(config.paths.repoFile, repo); } catch (error) { warnings.push(`Repository could not be saved: ${error.message}`); } }
  }
  return { config, resumes: loaded.resumes, baseMapRows: loaded.baseMapRows, checklist, warnings, historyFile: config.paths.historyFile, repo };
}

function analyze(input, ctx, options = {}) {
  const { config } = ctx;
  const { rules, profile } = config;
  const text = String((input && input.jdText) || '').trim();
  if (text.length < 80) return { ok: false, code: 'EMPTY_JD', message: 'Paste the full job description (at least a few lines).' };
  const threshold = resolveThreshold(options.threshold ?? input.threshold, rules);
  const jd = parseJd({ text, company: input.company, title: input.title }, rules);
  const kws = extractKeywords(jd, config.keywords);
  const level = detectLevel(jd, rules, profile);
  const direction = detectDirection(jd, rules);
  const gates = evaluateGates(jd, profile, rules, level);
  const redFlags = detectRedFlags(jd, rules);
  // overrideResume: rescore against a specific (e.g. freshly generated) resume instead of the ranked nearest base.
  const resumePool = options.overrideResume ? [...ctx.resumes.filter((r) => r.name !== options.overrideResume.resume.name), options.overrideResume.resume] : ctx.resumes;
  const bases = options.overrideResume
    ? { ...rankBases(jd, kws, resumePool, rules, { repo: ctx.repo, evidence: profile.evidence }), recommended: options.overrideResume.resume.name }
    : rankBases(jd, kws, resumePool, rules, { repo: ctx.repo, evidence: profile.evidence });
  const baseResume = resumePool.find((r) => r.name === bases.recommended) || null;
  const baseText = baseResume ? baseResume.text : '';
  // The summary's closing sentence is an aspiration ("Keen to apply ... to WhatsApp and voice"), not evidence:
  // it counts for ATS coverage but not for the fit status of a keyword.
  const closing = baseResume && baseResume.base && baseResume.base.closingSentence;
  const evidenceText = closing ? baseText.split(closing).join(' ') : baseText;
  const withStatus = kws.map((k) => ({ ...k, status: classifyKeyword(k, evidenceText) }));
  const fitInput = { gates, keywords: withStatus, direction, level, redFlags, profile };
  const fit = computeFit(fitInput, rules);
  const blockers = findBlockers(direction, level, gates);
  const recompute = (ids) => computeFit({ ...fitInput, keywords: withStatus.map((k) => (ids.has(k.id) ? { ...k, status: 'matched' } : k)) }, rules).score;
  // Honest edit set built once, scored once (single pass; never searches for edits that would reach T).
  const built = advice.buildEdits({ resume: baseResume, direction, jd, keywords: withStatus }, config);
  const tailorDecision = decideTailor({ fit: fit.score, blockers, base: baseResume && baseResume.base, keywords: withStatus, direction, jd, recompute, threshold, edits: built.edits }, rules);
  const scored = built.edits.filter((e) => e.kind !== 'optional-domain');
  const reps = {
    replacements: tailorDecision.decision === 'tailor' ? scored.map(({ old, new: n }) => ({ old, new: n })) : [],
    optionalReplacements: (tailorDecision.decision === 'tailor' ? built.edits.filter((e) => e.kind === 'optional-domain') : built.edits).map(({ old, new: n }) => ({ old, new: n })),
    edits: built.edits,
    notes: built.notes
  };
  const suggestedTarget = advice.suggestTargetName(jd, direction, bases.recommended);
  const slugName = advice.runSlug(jd);
  const usesPs1 = (config.generator || (config.paths.tailorScript ? 'tailor-ps1' : 'builtin')) === 'tailor-ps1';
  const cmd = baseResume && usesPs1 ? advice.buildCommand({ config, baseName: baseResume.name, targetName: suggestedTarget, slugName }) : null;
  const tailor = {
    decision: tailorDecision.decision, outcome: tailorDecision.outcome, reason: tailorDecision.reason, baselineFit: tailorDecision.baselineFit, estimatedLift: tailorDecision.estimatedLift, projectedFit: tailorDecision.projectedFit, gapToThreshold: tailorDecision.gapToThreshold, threshold: tailorDecision.threshold, scoringCalls: tailorDecision.scoringCalls, addedKeywords: tailorDecision.additions, edits: reps.edits,
    fixesMustHave: tailorDecision.fixesMustHave, closingMismatch: tailorDecision.closingMismatch, domainMismatch: tailorDecision.domainMismatch,
    replacements: reps.replacements, optionalReplacements: reps.optionalReplacements, notes: reps.notes,
    suggestedTarget, slug: slugName,
    command: cmd && (reps.replacements.length || reps.optionalReplacements.length) ? cmd.command : null,
    jsonPath: cmd ? cmd.jsonPath : null, exitCodes: cmd ? cmd.exitCodes : null,
    note: 'Click Generate to create a NEW tailored resume file (the base is never edited), or copy the command and run it yourself.'
  };

  const seen = options.ignoreHistory
    ? { status: 'none', matches: [], note: 'Seen-before check skipped (ignoreHistory).' }
    : seenBefore({ company: jd.company, title: jd.title }, [...ctx.checklist, ...repoSeenEntries(ctx.repo || { records: {} })], rules, profile);
  // Same-company warning: the company already received a specific file; a different version shows different content.
  const received = new Map();
  for (const m of seen.matches || []) if (['applied', 'repeat'].includes(m.status) && m.resume && !received.has(m.resume)) received.set(m.resume, m);
  const sameCompanyWarnings = [...received.values()].filter((m) => m.resume !== bases.recommended)
    .map((m) => ({ resume: m.resume, date: m.date || null, message: `${jd.company} received ${m.resume}${m.date ? ` on ${m.date}` : ''}; using a different version (${bases.recommended}) means they will see different content.` }));
  const improvements = advice.buildImprovements(withStatus, config, jd);
  const gapReasons = advice.buildGapReasons({ gates, improvements, tailor: tailorDecision }, config);
  const verdict = decideVerdict({ seenBefore: seen, blockers, fit: fit.score, tailor: tailorDecision, base: bases.recommended, threshold, gapReasons }, rules);
  const whyRole = advice.buildWhyRole({ company: jd.company, title: jd.title, keywords: withStatus }, config);
  const interview = advice.buildProbes({ level, keywords: withStatus, gates }, config);

  const checked = [
    ...reps.replacements.map((r) => ({ source: 'replacement', text: r.new })),
    ...reps.optionalReplacements.map((r) => ({ source: 'optional replacement', text: r.new })),
    ...improvements.add.map((a) => ({ source: `add: ${a.keyword}`, text: a.suggestion })),
    { source: 'why this role', text: whyRole.text }
  ];
  const honestyFlags = [];
  for (const c of checked) for (const f of advice.honestyGuard(c.text, config, direction.id, { resumeText: baseText })) honestyFlags.push({ ...f, source: c.source });
  const honesty = {
    ok: honestyFlags.length === 0,
    flags: honestyFlags,
    checked: checked.length,
    doNotClaimInJd: improvements.doNotClaim.filter((d) => /Forbidden/.test(d.reason)).map((d) => d.keyword),
    why: honestyFlags.length ? `${honestyFlags.length} suggestion(s) would introduce a forbidden claim.` : `All ${checked.length} generated suggestions pass the forbidden-claims list.`
  };

  const gaps = [
    ...gates.filter((g) => g.status === 'not_met').map((g) => g.requirement),
    ...gates.filter((g) => g.status === 'partial' && g.category !== 'location').map((g) => g.requirement),
    ...improvements.doNotClaim.filter((d) => d.section === 'required' || d.mustHave).map((d) => d.keyword)
  ].map((s) => String(s).replace(/[;()]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50)).filter((v, i, a) => a.indexOf(v) === i).slice(0, 4);
  const logLine = formatLogEntry({ verdictLabel: verdict.label, company: jd.company, title: jd.title,
    resume: tailor.decision === 'tailor' ? `${suggestedTarget} from ${bases.recommended}` : bases.recommended, fit: fit.score, gaps });

  let repost = { isRepost: false, why: 'Repost check skipped (ignoreHistory).' };
  if (!options.ignoreHistory && ctx.historyFile) repost = history.detectRepost(text, history.loadHistory(ctx.historyFile), rules);
  if (options.saveHistory !== false && !options.ignoreHistory && ctx.historyFile) {
    history.saveCheck(ctx.historyFile, { company: jd.company, title: jd.title, verdict: verdict.key, fit: fit.score, projected: tailorDecision.projectedFit, threshold, gaps: verdict.gapReasons.map((g) => g.gap.replace(/^[a-z]+: /, '').slice(0, 60)), base: bases.recommended, source: input.source || 'text', text }, rules);
  }

  const best = baseResume ? coverage(kws, baseText) : { pct: 0, matched: [], missing: [] };
  const perResume = bases.ranked.map((r) => ({ name: r.name, kind: r.kind, label: r.label, pct: r.keywordPct }));
  const strip = (k) => ({ id: k.id, term: k.term, canonical: k.canonical, category: k.category, section: k.section, mustHave: k.mustHave, status: k.status, count: k.occurrences.length });

  return {
    ok: true,
    threshold: bandsFor(threshold, rules),
    input: { company: jd.company, title: jd.title, location: jd.location, source: input.source || 'text', url: input.url || null },
    seenBefore: { ...seen, sameCompanyWarnings },
    verdict,
    direction: { class: direction.class, id: direction.id, label: direction.label, action: direction.action, hits: direction.hits, why: direction.why, deepVertical: direction.deepVertical },
    level,
    gates,
    blockers,
    fit,
    keywords: {
      jd: withStatus.map(strip),
      coverage: { best: { base: bases.recommended, pct: best.pct, matched: best.matched, missing: best.missing }, perResume },
      highlights: highlightSpans(jd.text, withStatus, rules.redFlags),
      text: jd.text
    },
    bases: { recommended: bases.recommended, submittedTop: bases.submittedTop, ranked: bases.ranked.slice(0, 15), caveat: baseResume ? baseResume.caveat : null },
    tailor,
    improvements,
    honesty,
    interview,
    whyRole,
    logEntry: { line: logLine, checklistPath: (config.log || 'checklist') === 'checklist' ? config.paths.checklist || null : null },
    repost,
    redFlags
  };
}

module.exports = { analyze, buildContext, refreshLog };
