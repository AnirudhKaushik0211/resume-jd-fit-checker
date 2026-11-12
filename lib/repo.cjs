'use strict';

// Resume repository (data/resume-repo.json): one record per resume .docx with type, lineage, recency,
// applied-to history, text hash, keyword fingerprint and evidence presence. Refreshed incrementally.

const fs = require('fs');
const path = require('path');
const { sha256, tokenize, jaccard } = require('./text.cjs');
const { compileTaxonomy, textHasKeyword } = require('./keywords.cjs');
const { readJson, writeJson } = require('./store-io.cjs');

function loadRepo(file) {
  try {
    const d = readJson(file);
    return d && typeof d === 'object' && d.records ? d : { version: 1, records: {} };
  } catch (error) {
    if (error.code === 'PROFILE_LOCKED') throw error; // a locked (encrypted) file is never treated as empty
    return { version: 1, records: {} };
  }
}

function saveRepo(file, repo) {
  writeJson(file, repo, { space: 1 });
}

function evidencePresent(text, evidence) {
  return evidence.filter((e) => e.detect && new RegExp(e.detect, 'i').test(text)).map((e) => e.id);
}

// derivedFrom: "X -> Name", "swap from X", "built ... from X" in the checklist item / base-map caveat that names the resume.
function lineageFor(name, checklist, baseMapRows, knownNames) {
  const sources = [];
  for (const e of checklist) if (e.raw.includes(name)) sources.push(e.raw);
  for (const r of baseMapRows) if (r.base === name) sources.push(r.caveat);
  for (const s of sources) {
    const arrow = s.match(new RegExp(`([A-Za-z0-9_]+)\\s*->\\s*${name}\\b`));
    if (arrow && knownNames.includes(arrow[1])) return arrow[1];
    const from = s.match(/\bfrom\s+([A-Za-z0-9_]+)/i);
    if (from && knownNames.includes(from[1]) && from[1] !== name) return from[1];
  }
  return null;
}

function appliedFromChecklist(name, checklist) {
  return checklist.filter((e) => e.resume === name && (e.status === 'applied' || e.status === 'repeat'))
    .map((e) => ({ company: e.head.split(/[,(]/)[0].trim().slice(0, 80), role: e.head.slice(0, 120), date: e.date || null, source: 'checklist' }));
}

function refreshRepo(repo, { resumes, checklist = [], baseMapRows = [], config }) {
  const evidence = config.profile.evidence || [];
  const compiled = compileTaxonomy(config.keywords);
  const names = resumes.map((r) => r.name);
  const seen = new Set();
  let changed = 0;
  for (const r of resumes) {
    seen.add(r.fileName);
    let st;
    try { st = fs.statSync(r.file); } catch { continue; }
    const prev = repo.records[r.fileName];
    const stamp = `${st.size}:${st.mtimeMs}`;
    const rec = prev ? { ...prev } : { file: r.fileName, name: r.name, appliedTo: [], createdAt: (st.birthtime || st.mtime).toISOString() };
    if (!prev || prev.stamp !== stamp) {
      rec.stamp = stamp;
      rec.hash = sha256(r.text);
      rec.fingerprint = compiled.filter((c) => textHasKeyword(c, r.text)).map((c) => c.kw.id);
      rec.evidencePresent = evidencePresent(r.text, evidence);
      rec.paragraphs = r.paragraphs.length;
      changed++;
    }
    rec.modifiedAt = st.mtime.toISOString();
    rec.family = r.family || rec.family || null;
    const fromChecklist = appliedFromChecklist(r.name, checklist);
    const manual = (rec.appliedTo || []).filter((a) => a.source !== 'checklist');
    rec.appliedTo = [...fromChecklist, ...manual];
    if (r.kind === 'base') rec.type = 'base';
    else if (rec.type === 'variant') rec.type = 'variant';
    else if (rec.type === 'generated-pending' && !rec.appliedTo.some((a) => (a.status || 'applied') === 'applied')) rec.type = 'generated-pending';
    else rec.type = 'submitted copy';
    rec.derivedFrom = rec.derivedFrom || r.previousVersion || lineageFor(r.name, checklist, baseMapRows, names);
    repo.records[r.fileName] = rec;
  }
  for (const k of Object.keys(repo.records)) if (!seen.has(k)) { delete repo.records[k]; changed++; }
  // Near-duplicate: a non-base whose token set is >= nearDuplicate (0.95) Jaccard-similar to a base.
  const thr = ((config.rules.repo || {}).nearDuplicate) ?? 0.95;
  const tokSets = new Map(resumes.map((x) => [x.fileName, tokenize(x.text)]));
  const bases = resumes.filter((x) => x.kind === 'base');
  for (const x of resumes) {
    const rec = repo.records[x.fileName];
    if (!rec || x.kind === 'base') { if (rec) delete rec.nearDuplicateOf; continue; }
    let best = null;
    for (const b of bases) {
      const sim = jaccard(tokSets.get(x.fileName), tokSets.get(b.fileName));
      if (sim >= thr && (!best || sim > best.sim)) best = { name: b.name, sim };
    }
    if (best) { rec.nearDuplicateOf = best.name; rec.nearDuplicateSimilarity = Math.round(best.sim * 1000) / 1000; } else { delete rec.nearDuplicateOf; delete rec.nearDuplicateSimilarity; }
  }
  repo.refreshedAt = new Date().toISOString();
  return { repo, changed };
}

// Evidence items added after the resume was last modified and not present in it -> stale.
function staleness(rec, evidence, family) {
  if (!rec) return { stale: false, missing: [] };
  const missing = evidence.filter((e) => e.detect && e.dateAdded && new Date(e.dateAdded) > new Date(rec.modifiedAt)
    && !(rec.evidencePresent || []).includes(e.id)
    && (!(e.appliesTo || []).length || (family && e.appliesTo.some((f) => String(family).toLowerCase().includes(String(f).toLowerCase())))));
  return { stale: missing.length > 0, missing: missing.map((e) => e.id) };
}

function missingEvidence(rec, evidence) {
  return evidence.filter((e) => e.detect && !(rec.evidencePresent || []).includes(e.id)).map((e) => e.id);
}

// Repository entries as checklist-like items so seen-before catches repeats before the checklist is reread.
function repoSeenEntries(repo) {
  const out = [];
  for (const rec of Object.values(repo.records || {})) {
    for (const a of rec.appliedTo || []) {
      if (a.source === 'checklist') continue;
      out.push({ raw: `${a.company} ${a.role} (${rec.name}; repository)`, line: `repository: ${rec.file}`, lineNo: 0, date: a.date, label: 'Applied (repository)', status: a.status || 'applied', section: 'repository', head: `${a.company} ${a.role}`, details: '', resume: rec.name, fit: a.fit || null });
    }
  }
  return out;
}

function markApplication(repo, fileName, entry) {
  const rec = repo.records[fileName];
  if (!rec) return false;
  rec.appliedTo = [...(rec.appliedTo || []), { ...entry, source: 'tool' }];
  if (entry.status === 'applied') rec.type = 'submitted copy';
  return true;
}

module.exports = { loadRepo, saveRepo, refreshRepo, staleness, missingEvidence, repoSeenEntries, markApplication, lineageFor, evidencePresent };
