'use strict';

// Loads and validates one profile's config. All candidate-specific data lives in the profile store
// (<home>\profiles\<id>\config\*.json); the tool ships only generic defaults (defaults\rules.json, defaults\keywords.json).
//   loadConfig()                  -> profile named by JDFC_PROFILE
//   loadConfig({ profile, home }) -> <home>\profiles\<profile>
//   loadConfig('<profile root>')  -> that folder

const fs = require('fs');
const path = require('path');
const { readJson } = require('./store-io.cjs');
const profiles = require('./profiles.cjs');

const TOOL_DIR = path.resolve(__dirname, '..');
const DEFAULTS_DIR = path.join(TOOL_DIR, 'defaults');
const GENERATORS = new Set(['tailor-ps1', 'builtin']);
const LOGS = new Set(['checklist', 'applications']);

function requireKeys(obj, keys, label) {
  for (const k of keys) {
    if (obj[k] === undefined) throw new Error(`Config ${label} is missing required key "${k}".`);
  }
}

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// Plain objects merge recursively; arrays and scalars from `over` replace `base`. Inputs are not mutated.
function deepMerge(base, over) {
  if (over === undefined) return structuredClone(base);
  if (!isPlainObject(base) || !isPlainObject(over)) return structuredClone(over);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? deepMerge(out[k], v) : structuredClone(v);
  return out;
}

function readOptional(file, fallback) {
  try {
    return readJson(file);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function compileForbidden(profile) {
  const employer = String(profile.employer || '').toLowerCase();
  return (profile.forbiddenClaims || []).map((fc) => {
    const src = String(fc.pattern).replace(/\{employer\}/g, employer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return {
      ...fc,
      message: String(fc.message || fc.id).replace(/\{employer\}/g, profile.employer || ''),
      regex: new RegExp(src, 'gi'),
      exceptRegex: fc.exceptPattern ? new RegExp(fc.exceptPattern, 'i') : null
    };
  });
}

function resolveRoot(arg) {
  if (typeof arg === 'string') return { root: path.resolve(arg) };
  const opts = arg || {};
  if (opts.root) return { root: path.resolve(opts.root) };
  const id = opts.profile || process.env.JDFC_PROFILE;
  if (!id) throw new Error('No profile selected: pass loadConfig({ profile }) or set JDFC_PROFILE.');
  return { root: profiles.profileRoot(id, opts.home), id };
}

// Default taxonomy + this profile's links (evidence / forbidden per keyword id) + extra keywords.
function buildKeywords(defaults, overrides) {
  const keywords = structuredClone(defaults.keywords);
  const byId = new Map(keywords.map((k) => [k.id, k]));
  for (const [kid, link] of Object.entries((overrides && overrides.links) || {})) {
    const kw = byId.get(kid);
    if (!kw) throw new Error(`keywords-overrides.json: link for unknown keyword id "${kid}".`);
    if (link.evidence !== undefined) kw.evidence = [...link.evidence];
    if (link.forbidden !== undefined) kw.forbidden = link.forbidden;
  }
  const add = (overrides && overrides.add) || [];
  if (!Array.isArray(add)) throw new Error('keywords-overrides.json: "add" must be an array.');
  for (const k of add) {
    if (!k || !k.id || byId.has(k.id)) throw new Error(`keywords-overrides.json: added keyword "${k && k.id}" is missing an id or duplicates an existing one.`);
    keywords.push(structuredClone(k));
    byId.set(k.id, k);
  }
  return keywords;
}

function loadConfig(arg) {
  const { root, id: givenId } = resolveRoot(arg);
  const configDir = path.join(root, 'config');
  let meta;
  try { meta = profiles.readMeta(root); } catch (error) { throw new Error(`Profile folder ${root} has no readable profile.meta.json (${error.message}).`); }
  const profileId = meta.id || givenId || path.basename(root);
  const pathsRaw = readJson(path.join(configDir, 'paths.json'));
  const profile = readJson(path.join(configDir, 'profile.json'));
  const rules = deepMerge(readJson(path.join(DEFAULTS_DIR, 'rules.json')), readOptional(path.join(configDir, 'rules.json'), undefined));
  const keywordDefaults = readJson(path.join(DEFAULTS_DIR, 'keywords.json'));
  const overrides = readOptional(path.join(configDir, 'keywords-overrides.json'), { links: {}, add: [] });
  const basesFile = readOptional(path.join(configDir, 'bases.json'), { bases: [] });

  requireKeys(pathsRaw, ['resumeDir', 'resumeFilePrefix', 'historyFile', 'repoFile', 'tailorRunsDir'], 'paths.json');
  requireKeys(profile, ['totalYears', 'employer', 'education', 'certifications', 'tools', 'domains', 'evidence', 'workSamples', 'forbiddenClaims'], 'profile.json');
  requireKeys(rules, ['directions', 'level', 'scoring', 'checklist', 'tailor'], 'rules.json');
  const thr = rules.threshold || {};
  const tMin = thr.min ?? 40;
  const tMax = thr.max ?? 95;
  if (rules.applyThreshold !== undefined && !(Number.isFinite(rules.applyThreshold) && rules.applyThreshold >= tMin && rules.applyThreshold <= tMax)) {
    throw new Error(`rules.json applyThreshold must be a number between ${tMin} and ${tMax}.`);
  }
  if (!Array.isArray(keywordDefaults.keywords)) throw new Error('defaults/keywords.json must contain a "keywords" array.');
  if (!Array.isArray(basesFile.bases)) throw new Error('bases.json must contain a "bases" array.');
  const keywords = buildKeywords(keywordDefaults, overrides);

  // Evidence added from the "My evidence" page lives in a separate config file and is merged here.
  if (profile.userEvidenceFile) {
    const extraPath = path.join(configDir, profile.userEvidenceFile);
    if (fs.existsSync(extraPath)) {
      const extra = readJson(extraPath).evidence || [];
      for (const e of extra) {
        if (profile.evidence.some((x) => x.id === e.id)) throw new Error(`${profile.userEvidenceFile}: duplicate evidence id "${e.id}".`);
        profile.evidence.push({ ...e, source: 'user' });
      }
    }
  }
  const evidenceIds = new Set(profile.evidence.map((e) => e.id));
  // Evidence declares which keyword ids it supports; link it into the taxonomy.
  for (const e of profile.evidence) {
    for (const kid of e.keywords || []) {
      const kw = keywords.find((k) => k.id === kid);
      if (kw && !(kw.evidence || []).includes(e.id)) kw.evidence = [...(kw.evidence || []), e.id];
    }
  }
  const forbiddenIds = new Set(profile.forbiddenClaims.map((f) => f.id));
  for (const kw of keywords) {
    for (const ev of kw.evidence || []) {
      if (!evidenceIds.has(ev)) throw new Error(`keywords: "${kw.id}" references unknown evidence id "${ev}".`);
    }
    if (kw.forbidden && !forbiddenIds.has(kw.forbidden)) throw new Error(`keywords: "${kw.id}" references unknown forbidden claim "${kw.forbidden}".`);
  }

  const generator = pathsRaw.generator || (pathsRaw.tailorScript ? 'tailor-ps1' : 'builtin');
  const log = pathsRaw.log || (pathsRaw.checklist ? 'checklist' : 'applications');
  if (!GENERATORS.has(generator)) throw new Error(`paths.json generator must be one of ${[...GENERATORS].join(', ')}.`);
  if (!LOGS.has(log)) throw new Error(`paths.json log must be one of ${[...LOGS].join(', ')}.`);
  if (generator === 'tailor-ps1' && !pathsRaw.tailorScript) throw new Error('paths.json: generator "tailor-ps1" needs tailorScript.');
  if (log === 'checklist' && !pathsRaw.checklist) throw new Error('paths.json: log "checklist" needs checklist.');

  const paths = {};
  for (const [k, v] of Object.entries(pathsRaw)) {
    if (k.startsWith('_') || k === 'generator' || k === 'log') continue;
    if (k === 'resumeFilePrefix') paths[k] = String(v || '');
    else paths[k] = v === null || v === undefined || v === '' ? null : path.resolve(root, v);
  }
  if (profile.userEvidenceFile) paths.userEvidenceFile = path.join(configDir, profile.userEvidenceFile);

  return {
    configDir,
    toolDir: TOOL_DIR,
    profileId,
    profileRoot: root,
    meta,
    generator,
    log,
    paths,
    profile,
    rules,
    keywords,
    bases: basesFile.bases,
    forbidden: compileForbidden(profile)
  };
}

module.exports = { loadConfig, readJson, deepMerge, buildKeywords, TOOL_DIR, DEFAULTS_DIR };
