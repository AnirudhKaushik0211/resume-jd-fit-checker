'use strict';

// Lists resume .docx files (top level only, so _backup_* subfolders are skipped), extracts text read-only,
// and classifies each as a base or a "submitted copy - do not edit".

const fs = require('fs');
const path = require('path');
const { docxParagraphs } = require('./docx.cjs');
const { loadBaseMap } = require('./basemap.cjs');
const { readJson } = require('./store-io.cjs');
const { autoBase } = require('./autobase.cjs');

const cache = new Map(); // path -> { mtimeMs, paragraphs }

function listResumeFiles(dir, prefix) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.startsWith(prefix) && /\.docx$/i.test(d.name) && !d.name.startsWith('~$'))
    .map((d) => path.join(dir, d.name))
    .sort();
}

function readParagraphsCached(file) {
  const st = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.paragraphs;
  const paragraphs = docxParagraphs(file);
  cache.set(file, { mtimeMs: st.mtimeMs, paragraphs });
  return paragraphs;
}

// Uploaded resumes (uploads.json: [{file, family, version, uploadedAt, ...}]): per family the newest version is the base,
// older versions are kept for lineage. Returns Map(name -> {family, isBase, previous}).
function uploadClasses(config) {
  const out = new Map();
  const file = config.paths.uploadsFile;
  if (!file) return out;
  let list = [];
  try { list = readJson(file); } catch (error) { if (error.code === 'PROFILE_LOCKED') throw error; return out; }
  if (!Array.isArray(list)) return out;
  const prefix = config.paths.resumeFilePrefix || '';
  const byFamily = new Map();
  for (const u of list) {
    if (!u || !u.file) continue;
    const fam = String(u.family || 'general');
    byFamily.set(fam, [...(byFamily.get(fam) || []), u]);
  }
  for (const [fam, items] of byFamily) {
    const sorted = [...items].sort((a, b) => (Number(a.version) || 0) - (Number(b.version) || 0) || String(a.uploadedAt || '').localeCompare(String(b.uploadedAt || '')));
    sorted.forEach((u, i) => {
      const name = path.basename(u.file, path.extname(u.file)).slice(prefix.length);
      const prev = i > 0 ? path.basename(sorted[i - 1].file, path.extname(sorted[i - 1].file)).slice(prefix.length) : null;
      out.set(name, { family: fam, isBase: i === sorted.length - 1, previous: prev });
    });
  }
  return out;
}

function loadResumes(config) {
  const { resumeDir, resumeFilePrefix, baseMap } = config.paths;
  const warnings = [];
  let mapRows = [];
  if (baseMap) {
    try {
      mapRows = loadBaseMap(baseMap);
    } catch (error) {
      warnings.push(`Base map could not be read: ${error.message}`);
    }
  }
  const uploads = uploadClasses(config);
  const baseCfg = new Map(config.bases.map((b) => [b.name, b]));
  const mapByName = new Map(mapRows.map((r) => [r.base, r]));
  const baseNames = new Set([...baseCfg.keys(), ...mapByName.keys()]);
  for (const name of mapByName.keys()) {
    if (!baseCfg.has(name)) warnings.push(`Base "${name}" is in the base map but not in bases.json (ranked with no family keywords).`);
  }

  const resumes = [];
  for (const file of listResumeFiles(resumeDir, resumeFilePrefix)) {
    const name = path.basename(file, path.extname(file)).slice(resumeFilePrefix.length);
    let paragraphs;
    try {
      paragraphs = readParagraphsCached(file);
    } catch (error) {
      warnings.push(`Could not read ${path.basename(file)}: ${error.message}`);
      continue;
    }
    const up = uploads.get(name);
    const isBase = baseNames.has(name) || Boolean(up && up.isBase);
    const cfg = baseCfg.get(name) || {};
    const row = mapByName.get(name) || {};
    resumes.push({
      name,
      file,
      fileName: path.basename(file),
      kind: isBase ? 'base' : 'submitted',
      label: isBase ? 'base' : up ? 'older version - kept for lineage' : 'submitted copy - do not edit',
      family: cfg.family || row.family || (up && up.family) || null,
      ...(up && up.previous ? { previousVersion: up.previous } : {}),
      caveat: row.caveat || null,
      // Uploaded bases without a bases.json entry get an auto-derived swap slot (the Skills/Tools line).
      base: isBase ? (up && !baseCfg.has(name) ? autoBase(paragraphs) : { familyKeywords: [], closingSentence: null, closingRoleType: null, closingDomainTerms: [], swapSlots: [], ...cfg }) : null,
      paragraphs,
      text: paragraphs.join('\n')
    });
  }
  for (const name of baseNames) {
    if (!resumes.some((r) => r.name === name)) warnings.push(`Base "${name}" has no file ${resumeFilePrefix}${name}.docx in the resume folder.`);
  }
  return { resumes, baseMapRows: mapRows, warnings };
}

module.exports = { listResumeFiles, loadResumes, readParagraphsCached };
