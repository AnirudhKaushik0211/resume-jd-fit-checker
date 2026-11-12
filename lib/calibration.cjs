'use strict';

// Runs the JD fixtures through analyze() and compares against the logged (historical) judgments.
// Per the strictness addendum, the strict score is NOT expected to match the historical hand estimate.
// Checks: best base, submitted copy, direction/level/gate flags, verdict at T=55 ~ historical, rank order (across rows).

const fs = require('fs');
const path = require('path');
const { analyze } = require('./analyze.cjs');
const { readJson } = require('./store-io.cjs');

const HISTORICAL_T = 55;

// Default fixture folder: fixturesDir of the profile named by JDFC_PROFILE (calibration fixtures are profile data).
function defaultFixtureDir() {
  if (!process.env.JDFC_PROFILE) return null;
  const { loadConfig } = require('./config.cjs');
  return loadConfig({ profile: process.env.JDFC_PROFILE }).paths.fixturesDir || null;
}

function loadFixtures(dir) {
  const d = dir || defaultFixtureDir();
  if (!d || !fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const fx = readJson(path.join(d, f));
    fx.text = fx.text || (fx.lines || []).join('\n');
    return fx;
  });
}

function checkFlags(flags = {}, r) {
  const fails = [];
  const notMet = r.gates.filter((g) => g.status === 'not_met').map((g) => g.requirement);
  if (flags.directionClass && r.direction.class !== flags.directionClass) fails.push(`direction class ${r.direction.class} != ${flags.directionClass}`);
  if (flags.directionId && r.direction.id !== flags.directionId) fails.push(`direction id ${r.direction.id} != ${flags.directionId}`);
  if (flags.level && r.level.class !== flags.level) fails.push(`level ${r.level.class} != ${flags.level}`);
  if (flags.levelSeniorWord && !r.level.titleSeniorWord) fails.push('no seniority word detected in title');
  for (const g of flags.gatesNotMet || []) if (!notMet.includes(g)) fails.push(`gate "${g}" not flagged not_met`);
  for (const c of flags.gatesPartial || []) if (!r.gates.some((g) => g.category === c && g.status === 'partial')) fails.push(`no partial ${c} gate`);
  for (const id of flags.unsupported || []) if (!r.keywords.jd.some((k) => k.id === id && k.status === 'unsupported')) fails.push(`keyword ${id} not unsupported`);
  for (const id of flags.mustHaveSupportable || []) if (!r.keywords.jd.some((k) => k.id === id && k.mustHave && k.status === 'supportable')) fails.push(`must-have ${id} not supportable`);
  if (flags.penaltyIncludes && !r.fit.penalties.some((p) => p.reason.includes(flags.penaltyIncludes))) fails.push(`no "${flags.penaltyIncludes}" penalty`);
  return fails;
}

function runCalibration(ctx, { dir, threshold } = {}) {
  return loadFixtures(dir || (ctx.config && ctx.config.paths.fixturesDir) || undefined).map((fx) => {
    const input = { jdText: fx.text, company: fx.company, title: fx.title, source: 'fixture' };
    const strict = analyze(input, ctx, { ignoreHistory: true, saveHistory: false, threshold });
    const hist = analyze(input, ctx, { ignoreHistory: true, saveHistory: false, threshold: HISTORICAL_T });
    const e = fx.expected;
    const flagFails = checkFlags(e.flags, strict);
    if (e.flags && e.flags.alwaysSkip && strict.verdict.key !== 'skip') flagFails.push(`verdict at T=${strict.threshold.threshold} is ${strict.verdict.key}, expected skip`);
    const checks = {
      base: !e.base || strict.bases.recommended === e.base,
      submittedTop: !e.submittedTop || strict.bases.submittedTop === e.submittedTop,
      flags: flagFails.length === 0,
      verdictAtT55: !e.verdictAtT55 || e.verdictAtT55.includes(hist.verdict.key),
      reason: !e.reasonIncludes || hist.verdict.reason.toLowerCase().includes(e.reasonIncludes.toLowerCase())
    };
    return {
      fixture: fx.id, company: fx.company, title: fx.title, logged: fx.logged || '', expected: e, rankGroup: e.rankGroup ?? null,
      strict: { threshold: strict.threshold.threshold, fit: strict.fit.score, projected: strict.tailor.projectedFit, verdict: strict.verdict.key, base: strict.bases.recommended, submittedTop: strict.bases.submittedTop, reason: strict.verdict.reason },
      atT55: { verdict: hist.verdict.key, reason: hist.verdict.reason },
      flagFails, checks, pass: Object.values(checks).every(Boolean)
    };
  });
}

// Rank order: every fixture in group g must score strictly above every fixture in group g+1.
function checkRankOrder(rows) {
  const groups = new Map();
  for (const r of rows) if (r.rankGroup) groups.set(r.rankGroup, [...(groups.get(r.rankGroup) || []), r]);
  const keys = [...groups.keys()].sort((a, b) => a - b);
  const violations = [];
  for (let i = 0; i + 1 < keys.length; i++) {
    const hi = groups.get(keys[i]);
    const lo = groups.get(keys[i + 1]);
    const minHi = hi.reduce((a, b) => (b.strict.fit < a.strict.fit ? b : a));
    const maxLo = lo.reduce((a, b) => (b.strict.fit > a.strict.fit ? b : a));
    if (!(minHi.strict.fit > maxLo.strict.fit)) violations.push(`${minHi.fixture} (${minHi.strict.fit}) should rank above ${maxLo.fixture} (${maxLo.strict.fit})`);
  }
  return { ok: violations.length === 0, violations, groups: keys.map((k) => ({ group: k, fixtures: groups.get(k).map((r) => `${r.fixture} ${r.strict.fit}`) })) };
}

function formatTable(rows) {
  const t = rows[0] ? rows[0].strict.threshold : '';
  const head = `| Fixture | Historical estimate | Strict score | Projected after honest edits | Historical verdict | Verdict @T=${t} | Verdict @T=55 | Expected base | Actual base | Rank group | Pass |`;
  const sep = '|---|---|---|---|---|---|---|---|---|---|---|';
  const body = rows.map((r) => `| ${r.fixture} | ~${r.expected.historicalFit}% | ${r.strict.fit}% | ${r.strict.projected}% | ${r.expected.historicalVerdict} | ${r.strict.verdict} | ${r.atT55.verdict} | ${r.expected.base || '(not asserted)'} | ${r.strict.base} | ${r.rankGroup ?? '-'} | ${r.pass ? 'yes' : 'NO'} |`);
  return [head, sep, ...body].join('\n');
}

module.exports = { loadFixtures, runCalibration, checkRankOrder, checkFlags, formatTable, HISTORICAL_T };
