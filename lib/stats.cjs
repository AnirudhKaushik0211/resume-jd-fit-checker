'use strict';

// Read-only stats computed from the checklist entries, data/history.json and data/resume-repo.json.
// Older checklist entries are mostly undated: they go to an "undated" bucket instead of guessed dates.

const { staleness } = require('./repo.cjs');

const SKIP_REASONS = [
  ['too senior', /\b(senior|staff|principal|lead|head|director|vp|avp|dgm|gm)\b|\b([5-9]|1\d)\s*(\+|-|–)?\s*\d*\s*(yrs|years|yr)\b/i],
  ['direction', /direction|ops|operational|sales|quota|field|activation|analyst|support seat|paid|program manag|people (mgmt|management|leader)|team lead|delivery/i],
  ['gate', /sap|servicenow|successfactors|adp|erp|platform|domain|regulated|medical|pharma|banking|lending|required|german|hardware|automotive/i],
  ['long shot', /long shot|low-odds|low odds/i]
];

function skipReason(e) {
  if (e.status === 'repeat') return 'repeat';
  const text = `${e.label} ${e.raw}`;
  for (const [name, re] of SKIP_REASONS) if (re.test(text)) return name;
  return 'other';
}

function isoWeek(dateStr) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function companyOf(head) {
  const h = String(head || '').trim();
  if (h.includes(',')) return h.split(',')[0].trim();
  return h.split(/\s+/)[0] || '';
}

function computeStats({ checklist = [], history = [], repo = { records: {} }, threshold = 75, evidence = [], now = new Date(), range = 'all' } = {}) {
  const cutoff = range === '7d' ? new Date(now - 7 * 86400000) : range === '30d' ? new Date(now - 30 * 86400000) : null;
  const inRange = (date) => !cutoff || (date && new Date(date) >= cutoff);
  const entries = checklist.filter((e) => !cutoff || inRange(e.date));
  const hist = history.filter((h) => inRange(h.date));

  const by = (st) => entries.filter((e) => e.status === st).length;
  const skipped = entries.filter((e) => e.status === 'skipped' || e.status === 'repeat');
  const skipReasons = {};
  for (const e of skipped) { const r = skipReason(e); skipReasons[r] = (skipReasons[r] || 0) + 1; }
  const totals = {
    screened: entries.length, toolChecks: hist.length,
    applied: by('applied'), pending: by('pending'), held: by('held'), repeat: by('repeat'), skipped: by('skipped'),
    skippedByReason: skipReasons
  };

  // weekly trend (screened = checklist items + tool checks; applied = applied checklist items)
  const weeks = new Map();
  let undated = { screened: 0, applied: 0 };
  const bump = (date, field) => {
    const w = date ? isoWeek(date) : null;
    if (!w) { undated[field]++; return; }
    const row = weeks.get(w) || { week: w, screened: 0, applied: 0 };
    row[field]++;
    weeks.set(w, row);
  };
  for (const e of entries) { bump(e.date, 'screened'); if (e.status === 'applied') bump(e.date, 'applied'); }
  for (const h of hist) bump(h.date, 'screened');
  const trend = [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week));

  const repeatsTool = hist.filter((h) => h.verdict === 'skip_repeat').length;
  const repeatRate = {
    checklist: entries.length ? Math.round((1000 * by('repeat')) / entries.length) / 10 : 0,
    tool: hist.length ? Math.round((1000 * repeatsTool) / hist.length) / 10 : 0,
    why: 'Share of logged items marked Repeat, and of tool checks whose verdict was Skip (repeat).'
  };

  const fits = hist.map((h) => Number(h.fit)).filter(Number.isFinite);
  const histogram = Array.from({ length: 10 }, (_, i) => ({ bucket: `${i * 10}-${i * 10 + 9}`, count: fits.filter((f) => Math.min(9, Math.floor(f / 10)) === i).length }));
  const avg = (arr) => (arr.length ? Math.round((10 * arr.reduce((a, b) => a + b, 0)) / arr.length) / 10 : null);
  const projected = hist.map((h) => Number(h.projected ?? h.fit)).filter(Number.isFinite);
  const outcomes = { reachesThreshold: 0, salvage: 0, hold: 0, apply: 0, skip: 0 };
  for (const h of hist) {
    if (h.verdict === 'tailor_light') outcomes.reachesThreshold++;
    else if (h.verdict === 'tailor_salvage') outcomes.salvage++;
    else if (h.verdict === 'hold') outcomes.hold++;
    else if (h.verdict === 'apply_as_is') outcomes.apply++;
    else outcomes.skip++;
  }
  const fit = { histogram, averageBaseline: avg(fits), averageAfterEdits: avg(projected), outcomes, threshold };

  const gapCounts = {};
  for (const h of hist) for (const g of h.gaps || []) gapCounts[g] = (gapCounts[g] || 0) + 1;
  const evText = evidence.map((e) => `${e.id} ${e.claim} ${(e.keywords || []).join(' ')}`.toLowerCase()).join('\n');
  const topGaps = Object.entries(gapCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([gap, count]) => ({ gap, count, queuedAsEvidence: gap.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3).some((w) => evText.includes(w)) }));
  const topSkipReasons = Object.entries(skipReasons).sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count }));

  const usage = {};
  for (const e of checklist) if (e.status === 'applied' && e.resume) usage[e.resume] = (usage[e.resume] || 0) + 1;
  for (const r of Object.values(repo.records || {})) for (const a of r.appliedTo || []) if (a.source !== 'checklist' && (a.status || 'applied') === 'applied') usage[r.name] = (usage[r.name] || 0) + 1;
  const children = {};
  for (const r of Object.values(repo.records || {})) if (r.derivedFrom) children[r.derivedFrom] = (children[r.derivedFrom] || 0) + 1;
  const bases = Object.values(repo.records || {}).filter((r) => r.type === 'base');
  const staleBases = bases.filter((r) => staleness(r, evidence, r.family).stale).map((r) => r.name);
  const reuse = bases.map((b) => ({ name: b.name, uses: (usage[b.name] || 0) + (children[b.name] || 0) })).sort((a, b) => b.uses - a.uses);
  const resumeUsage = { applicationsPerResume: Object.entries(usage).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })), staleBases, staleCount: staleBases.length, mostReusedBase: reuse[0] && reuse[0].uses ? reuse[0] : null };

  const pending = [
    ...entries.filter((e) => e.status === 'pending').map((e) => ({ source: 'checklist', item: e.head, resume: e.resume, date: e.date })),
    ...Object.values(repo.records || {}).filter((r) => r.type === 'generated-pending').map((r) => ({ source: 'repository', item: r.file, resume: r.name, date: (r.createdAt || '').slice(0, 10) }))
  ];

  const companies = {};
  for (const e of checklist.filter((x) => x.status === 'applied' || x.status === 'repeat')) {
    const c = companyOf(e.head);
    if (!c) continue;
    const row = companies[c] || { company: c, count: 0, dates: [] };
    if (e.status === 'applied') row.count++;
    row.dates.push(e.date || 'undated');
    companies[c] = row;
  }
  const companiesApplied = Object.values(companies).filter((c) => c.count).sort((a, b) => b.count - a.count || a.company.localeCompare(b.company))
    .map((c) => ({ ...c, dates: [...new Set(c.dates)] }));

  return { range, generatedAt: now.toISOString(), totals, trend, undated, repeatRate, fit, topSkipReasons, topGaps, resumeUsage, pending, companiesApplied };
}

module.exports = { computeStats, isoWeek, skipReason, companyOf };
