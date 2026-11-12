'use strict';

// Application log for profiles without a markdown checklist (log: "applications"): <profile>\data\applications.json.
// Entries: { id, date: YYYY-MM-DD, company, role, status: applied|pending|skipped|held|repeat, resume, fit, gaps, reason, source, recordedAt }.
// toChecklistEntries() turns them into checklist-shaped items so seen-before, stats and lineage treat both logs alike.

const { readJson, writeJson } = require('./store-io.cjs');
const { parseChecklist } = require('./checklist.cjs');

const STATUSES = new Set(['applied', 'pending', 'skipped', 'held', 'repeat']);
const LABELS = { applied: 'Applied (confirmed)', pending: 'Tailored, pending application', skipped: 'Skipped', held: 'Held', repeat: 'Repeat' };

function loadApplications(file) {
  if (!file) return [];
  try {
    const d = readJson(file);
    return Array.isArray(d) ? d : [];
  } catch (error) {
    if (error.code === 'PROFILE_LOCKED') throw error; // a locked (encrypted) file is never treated as empty
    return [];
  }
}

const clean = (s, max = 200) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);

function normalizeEntry(e) {
  const status = STATUSES.has(e.status) ? e.status : 'applied';
  const fit = e.fit === null || e.fit === undefined || e.fit === '' || !Number.isFinite(Number(e.fit)) ? null : Math.round(Number(e.fit));
  return {
    id: e.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(e.date || '')) ? e.date : null,
    company: clean(e.company, 120), role: clean(e.role || e.title, 160), status,
    resume: e.resume ? clean(e.resume, 120) : null, fit,
    gaps: Array.isArray(e.gaps) ? e.gaps.map((g) => clean(g, 80)).slice(0, 8) : [],
    reason: e.reason ? clean(e.reason) : undefined,
    source: e.source || 'tool', recordedAt: e.recordedAt || new Date().toISOString()
  };
}

function appendApplication(file, entry) {
  const apps = loadApplications(file);
  const rec = normalizeEntry({ date: new Date().toISOString().slice(0, 10), ...entry });
  apps.push(rec);
  writeJson(file, apps, { space: 2, trailingNewline: true });
  return rec;
}

function formatLine(a) {
  const tail = a.status === 'skipped' ? `reason: ${a.reason || 'user decision'}` : `gaps: ${(a.gaps && a.gaps.length ? a.gaps : ['none noted']).join(', ')}`;
  return `- **${a.date || 'undated'} - ${LABELS[a.status] || a.status}:** ${a.company || 'Unknown company'}, ${a.role || 'Unknown role'} (${a.resume || 'no resume'}${a.fit !== null && a.fit !== undefined ? `, ~${a.fit}%` : ''}; ${tail}).`;
}

function toChecklistEntries(apps) {
  return (apps || []).map((a) => {
    const details = `(${a.resume || 'no resume'}${a.fit !== null && a.fit !== undefined ? `, ~${a.fit}%` : ''}${a.reason ? `; reason: ${a.reason}` : ''})`;
    const head = `${a.company || ''}, ${a.role || ''}`.replace(/^, |, $/g, '').trim();
    return { raw: `${head} ${details}`, line: formatLine(a), lineNo: 0, date: a.date || null, label: LABELS[a.status] || a.status, status: a.status, section: 'applications', head, details, resume: a.resume || null, fit: a.fit ?? null };
  });
}

// Minimal RFC-4180 style CSV: quoted fields, "" escapes, header row (date, company, role|title, status, resume, fit, reason).
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  const s = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

function statusFrom(v) {
  const l = String(v || '').toLowerCase();
  if (/repeat/.test(l)) return 'repeat';
  if (/skip/.test(l)) return 'skipped';
  if (/hold|held/.test(l)) return 'held';
  if (/pend|tailored|not yet/.test(l)) return 'pending';
  return 'applied';
}

function parseCsvLog(text) {
  const rows = parseCsvRows(text);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const idx = { date: col('date'), company: col('company'), role: col('role', 'title', 'position'), status: col('status'), resume: col('resume'), fit: col('fit'), reason: col('reason') };
  if (idx.company < 0) throw new Error('CSV needs a header row with at least a "company" column.');
  return rows.slice(1).map((r) => normalizeEntry({
    date: idx.date >= 0 ? r[idx.date].trim() : null, company: r[idx.company], role: idx.role >= 0 ? r[idx.role] : '',
    status: statusFrom(idx.status >= 0 ? r[idx.status] : 'applied'), resume: idx.resume >= 0 ? r[idx.resume].trim() || null : null,
    fit: idx.fit >= 0 ? String(r[idx.fit]).replace(/[~%\s]/g, '') : null, reason: idx.reason >= 0 ? r[idx.reason] : undefined, source: 'import-csv'
  })).filter((e) => e.company);
}

// Markdown checklist (same format the owner's checklist uses) -> application entries.
function importMarkdown(text, rules, resumeNames = []) {
  return parseChecklist(text, rules, resumeNames).map((e) => {
    const h = String(e.head || '');
    const comma = h.indexOf(',');
    return normalizeEntry({ date: e.date, company: comma >= 0 ? h.slice(0, comma) : h, role: comma >= 0 ? h.slice(comma + 1) : '', status: e.status, resume: e.resume, fit: e.fit, source: 'import-markdown' });
  }).filter((e) => e.company);
}

// Onboarding import: appends parsed entries, skipping duplicates (same company + role + date, case-insensitive)
// against the existing log and within the batch. Returns { added, duplicates, total }.
const dedupeKey = (e) => [e.company, e.role, e.date || ''].map((s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')).join('|');
function importApplications(file, entries) {
  const apps = loadApplications(file);
  const seen = new Set(apps.map(dedupeKey));
  let added = 0;
  let duplicates = 0;
  for (const e of entries || []) {
    const rec = normalizeEntry(e);
    const k = dedupeKey(rec);
    if (seen.has(k)) { duplicates++; continue; }
    seen.add(k);
    apps.push(rec);
    added++;
  }
  if (added) writeJson(file, apps, { space: 2, trailingNewline: true });
  return { added, duplicates, total: apps.length };
}

module.exports = { importApplications, loadApplications, appendApplication, normalizeEntry, toChecklistEntries, parseCsvLog, importMarkdown, formatLine, STATUSES };
