'use strict';

// ============================================================================
// JD Fit Checker - local prototype server (localhost only, zero npm dependencies)
// Start: node jd-fit-checker\server.cjs   ->   http://127.0.0.1:4317
// Multi-profile: every data route is scoped to one profile (/api/p/<id>/..., /p/<id>/download/...). Profile data
// lives outside the tool folder (<JDFC_HOME or %USERPROFILE%\.jd-fit-checker>\profiles\<id>\).
// The only outbound request is a GET to a job-posting URL the user pastes (/api/fetch).
// Existing resumes and the base map are never edited by analysis. On explicit user clicks the server can:
//  - generate a NEW tailored .docx (max 2 attempts),
//  - log an application (checklist append after a timestamped .bak copy, or data\applications.json),
//  - propagate a new evidence item into BASES ONLY (-InPlace; the script makes its own backup), after confirm.
// ============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { loadConfig } = require('./lib/config.cjs');
const { analyze, buildContext, refreshLog } = require('./lib/analyze.cjs');
const { fetchJob } = require('./lib/fetch-jd.cjs');
const { publicHistory, loadHistory } = require('./lib/history.cjs');
const { appendToChecklist } = require('./lib/checklist.cjs');
const { runCalibration, checkRankOrder } = require('./lib/calibration.cjs');
const { thresholdSettings, resolveThreshold } = require('./lib/scoring.cjs');
const { extractKeywords } = require('./lib/keywords.cjs');
const gen = require('./lib/generate.cjs');
const actions = require('./lib/actions.cjs');
const { staleness, missingEvidence } = require('./lib/repo.cjs');
const { computeStats } = require('./lib/stats.cjs');
const profiles = require('./lib/profiles.cjs');
const auth = require('./lib/auth.cjs');
const apps = require('./lib/applications.cjs');
const { draftProfile, buildProfile, buildRulesOverride } = require('./lib/profile-draft.cjs');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4317);
const SERVICE_VERSION = '2026-11-jdfc-v2';
const ROOT = __dirname;
const UI_FILE = path.join(ROOT, 'index.html');
const MAX_BODY = 1024 * 1024;
const MAX_UPLOAD_BODY = 8 * 1024 * 1024; // resume upload route only (base64 of a .docx up to 5 MB)

let currentPort = PORT;
let ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
let ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
function setPort(port) {
  currentPort = port;
  ALLOWED_HOSTS = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
}

function httpError(message, statusCode = 500, code = 'JDFC_ERROR') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-service-version': SERVICE_VERSION,
    ...extraHeaders
  });
  response.end(body);
}

function serveUi(response) {
  fs.readFile(UI_FILE, (error, content) => {
    if (error) { sendJson(response, 500, { error: 'index.html could not be read.' }); return; }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': content.length,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
      'x-service-version': SERVICE_VERSION
    });
    response.end(content);
  });
}

function readJsonBody(request, maxBody = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const type = String(request.headers['content-type'] || '');
    if (!type.toLowerCase().startsWith('application/json')) { reject(httpError('Content-Type must be application/json.', 415, 'BAD_CONTENT_TYPE')); return; }
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    request.on('data', (c) => {
      if (tooLarge) return; // drain without buffering so the 413 response still reaches the client
      size += c.length;
      if (size > maxBody) { tooLarge = true; chunks.length = 0; reject(httpError(`Request body is larger than ${Math.round(maxBody / (1024 * 1024))} MB.`, 413, 'TOO_LARGE')); return; }
      chunks.push(c);
    });
    request.on('end', () => {
      if (tooLarge) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(httpError('Body is not valid JSON.', 400, 'BAD_JSON')); }
    });
    request.on('error', reject);
  });
}

// ---------------------------------------------------------------- per-profile state
const cache = new Map(); // id -> { config, ctx }

function reloadProfile(id) {
  const config = loadConfig({ profile: id });
  const ctx = buildContext(config);
  ctx.urlBase = `/p/${id}`;
  const entry = { config, ctx };
  cache.set(id, entry);
  return entry;
}

function getProfileCtx(id) {
  if (!profiles.validId(id) || !profiles.profileExists(id)) throw httpError('Unknown profile.', 404, 'UNKNOWN_PROFILE');
  return cache.get(id) || reloadProfile(id);
}

function dropProfile(id) { cache.delete(id); }

// ---------------------------------------------------------------- password protection
// A protected profile needs a valid session cookie for every profile-scoped route (else 423). Lock or session
// expiry forgets the key and the cached (decrypted) context.
profiles.onLock(dropProfile);
auth.onExpire((id) => { try { profiles.lock(id); } catch { /* invalid id: nothing to drop */ } });

function isProtected(id) {
  try { return profiles.readMeta(id).protected === true; } catch { return false; }
}
function requireKnownProfile(id) {
  if (!profiles.validId(id) || !profiles.profileExists(id)) throw httpError('Unknown profile.', 404, 'UNKNOWN_PROFILE');
}
// A protected profile is open only with a valid session AND the key in memory.
function isOpen(req, id) {
  if (!isProtected(id)) return true;
  return Boolean(auth.sessionFor(req, id)) && profiles.isUnlocked(id);
}
function lockedHttpError() { return httpError('This profile is locked. Unlock it with its password first.', 423, 'PROFILE_LOCKED'); }

function profileListing(req) {
  return profiles.listProfiles().map((p) => (p.protected && !isOpen(req, p.id)
    ? { id: p.id, name: p.name, protected: true, locked: true }
    : { ...p, locked: false }));
}

function profileHealth(id, { config, ctx }) {
  return {
    ok: true, version: SERVICE_VERSION, port: currentPort,
    profile: { id, name: config.meta.name || id, kind: config.meta.kind || 'user' }, log: config.log, generator: config.generator,
    resumeCount: ctx.resumes.length, baseCount: ctx.resumes.filter((r) => r.kind === 'base').length,
    checklistEntries: ctx.checklist.length, warnings: ctx.warnings,
    threshold: thresholdSettings(config.rules)
  };
}

function directionCatalog() {
  const { readJson } = require('./lib/store-io.cjs');
  const rules = readJson(path.join(ROOT, 'defaults', 'rules.json'));
  const d = rules.directions || {};
  return [...(d.target || []).map((x) => ({ id: x.id, label: x.label, class: 'target' })), ...(d.avoid || []).map((x) => ({ id: x.id, label: x.label, class: 'avoid' }))];
}

const SLUG_RE = /^[a-z0-9-]{1,60}$/;

function resumeSummary(ctx) {
  return ctx.resumes.map((r) => ({ name: r.name, fileName: r.fileName, kind: r.kind, label: r.label, family: r.family, previousVersion: r.previousVersion || null }));
}

// ---------------------------------------------------------------- route handlers
// Profile handlers get (req, res, { url, params, body, id, config, ctx, reload }).
const H = {
  ui: (req, res) => serveUi(res),
  health: (req, res) => sendJson(res, 200, { ok: true, version: SERVICE_VERSION, port: currentPort, profiles: profiles.listProfiles().length }),
  profiles: (req, res) => sendJson(res, 200, { ok: true, profiles: profileListing(req) }),
  // 429 + Retry-After while rate limited, 401 wrong password, 200 + session cookie on success.
  unlock: (req, res, { params, body }) => {
    const id = params.id;
    requireKnownProfile(id);
    if (!isProtected(id)) return sendJson(res, 200, { ok: true, id, protected: false, locked: false });
    const rl = auth.checkRateLimit(id);
    if (rl.limited) return sendJson(res, 429, { ok: false, code: 'RATE_LIMITED', error: `Too many wrong passwords. Try again in ${rl.retryAfter} s.`, retryAfter: rl.retryAfter }, { 'retry-after': String(rl.retryAfter) });
    if (!profiles.unlock(id, typeof body.password === 'string' ? body.password : '')) {
      auth.recordFailure(id);
      return sendJson(res, 401, { ok: false, code: 'WRONG_PASSWORD', error: 'Wrong password.' });
    }
    auth.resetFailures(id);
    const token = auth.createSession(id);
    dropProfile(id);
    reloadProfile(id);
    return sendJson(res, 200, { ok: true, id, protected: true, locked: false }, { 'set-cookie': auth.cookieHeader(id, token) });
  },
  lock: (req, res, { params }) => {
    const id = params.id;
    requireKnownProfile(id);
    auth.destroySessions(id);
    profiles.lock(id);
    return sendJson(res, 200, { ok: true, id, protected: isProtected(id), locked: isProtected(id) }, { 'set-cookie': auth.clearCookieHeader(id) });
  },
  // Forgotten password: wipes the encrypted files (typed confirmation = the profile id). No session needed.
  reset: (req, res, { params, body }) => {
    const id = params.id;
    requireKnownProfile(id);
    if (body.confirm !== id) throw httpError(`Type the profile id ("${id}") to confirm the reset.`, 400, 'CONFIRM_REQUIRED');
    auth.destroySessions(id);
    auth.resetFailures(id);
    profiles.resetProfile(id);
    dropProfile(id);
    return sendJson(res, 200, { ok: true, id, protected: false, locked: false }, { 'set-cookie': auth.clearCookieHeader(id) });
  },
  directions: (req, res) => sendJson(res, 200, { ok: true, directions: directionCatalog() }),
  fetch: async (req, res, { body }) => sendJson(res, 200, await fetchJob(String(body.url || ''))),
  // Restores the synthetic demo profile from profiles-seed\demo (only a kind "demo" profile is ever reset).
  demoReset: (req, res, { body }) => {
    if (body.confirm !== true) throw httpError('Explicit confirmation is required (confirm: true).', 400, 'CONFIRM_REQUIRED');
    profiles.resetDemo();
    dropProfile(profiles.DEMO_ID);
    const entry = reloadProfile(profiles.DEMO_ID);
    return sendJson(res, 200, profileHealth(profiles.DEMO_ID, entry));
  },

  pHealth: (req, res, p) => sendJson(res, 200, profileHealth(p.id, p)),
  settings: (req, res, { config }) => sendJson(res, 200, { threshold: thresholdSettings(config.rules), log: config.log, generator: config.generator }),
  history: (req, res, { config }) => sendJson(res, 200, { ok: true, entries: publicHistory(config.paths.historyFile, 100) }),
  resumes: (req, res, { ctx }) => sendJson(res, 200, { ok: true, resumes: ctx.resumes.map((r) => ({ name: r.name, kind: r.kind, label: r.label, family: r.family, caveat: r.caveat, paragraphs: r.paragraphs.length })) }),
  download: (req, res, { config, params }) => {
    let name;
    try { name = decodeURIComponent(params.file); } catch { throw httpError('File not found.', 404, 'NOT_FOUND'); }
    const file = gen.safeDownloadPath(config.paths.resumeDir, name);
    if (!file) throw httpError('File not found.', 404, 'NOT_FOUND');
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'content-length': data.length,
      'content-disposition': `attachment; filename="${path.basename(file)}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(data);
  },
  job: (req, res, { params, id }) => {
    const job = gen.getJob(params.job, id);
    if (!job) throw httpError('Unknown job.', 404, 'NOT_FOUND');
    return sendJson(res, 200, job);
  },
  stats: (req, res, { url, config, ctx }) => {
    const range = ['7d', '30d', 'all'].includes(url.searchParams.get('range')) ? url.searchParams.get('range') : 'all';
    const t = resolveThreshold(url.searchParams.get('threshold'), config.rules);
    return sendJson(res, 200, { ok: true, ...computeStats({ checklist: ctx.checklist, history: loadHistory(config.paths.historyFile), repo: ctx.repo, threshold: t, evidence: config.profile.evidence, range }) });
  },
  candidates: (req, res, { url, ctx }) => sendJson(res, 200, { ok: true, ...actions.propagationCandidates(ctx, url.searchParams.get('id'), { showAll: url.searchParams.get('showAll') === '1' }) }),
  pending: (req, res, { ctx }) => sendJson(res, 200, { ok: true, pending: actions.pendingApplications(ctx.repo) }),
  repo: (req, res, { config, ctx }) => {
    const ev = config.profile.evidence;
    const recs = Object.values(ctx.repo.records).map((r) => ({ ...r, stale: staleness(r, ev, r.family).missing, missingEvidence: missingEvidence(r, ev) }))
      .sort((a, b) => (a.type === b.type ? String(b.modifiedAt).localeCompare(String(a.modifiedAt)) : a.type.localeCompare(b.type)));
    return sendJson(res, 200, { ok: true, refreshedAt: ctx.repo.refreshedAt, records: recs });
  },
  evidence: (req, res, { config, ctx }) => sendJson(res, 200, { ok: true, evidence: config.profile.evidence.map((e) => ({ ...e, staleBases: actions.staleBasesFor(ctx, e.id) })) }),
  calibration: (req, res, { url, config, ctx }) => {
    const t = resolveThreshold(url.searchParams.get('threshold'), config.rules);
    const rows = runCalibration({ ...ctx, historyFile: null }, { threshold: t });
    return sendJson(res, 200, { ok: true, threshold: t, rows, rank: checkRankOrder(rows) });
  },

  reload: (req, res, p) => sendJson(res, 200, profileHealth(p.id, p.reload())),
  analyze: async (req, res, { body, ctx }) => {
    const opts = body.options || {};
    let input = { jdText: body.jdText, company: body.company, title: body.title, source: 'text', threshold: body.threshold };
    if (!String(body.jdText || '').trim() && body.url) {
      const f = await fetchJob(String(body.url));
      if (!f.ok) return sendJson(res, 200, f);
      input = { jdText: f.text, company: body.company || f.company, title: body.title || f.title, source: f.source, url: f.finalUrl, threshold: body.threshold };
    }
    return sendJson(res, 200, analyze(input, ctx, { ignoreHistory: Boolean(opts.ignoreHistory), saveHistory: opts.saveHistory !== false, threshold: body.threshold }));
  },
  compare: (req, res, { body, ctx }) => {
    const a = body.a || {};
    const b = body.b || {};
    const ra = analyze({ jdText: a.jdText, company: a.company, title: a.title, source: 'compare' }, ctx, { saveHistory: false, threshold: body.threshold });
    const rb = analyze({ jdText: b.jdText, company: b.company, title: b.title, source: 'compare' }, ctx, { saveHistory: false, threshold: body.threshold });
    const ka = new Set(ra.ok ? ra.keywords.jd.map((k) => k.canonical) : []);
    const kb = new Set(rb.ok ? rb.keywords.jd.map((k) => k.canonical) : []);
    return sendJson(res, 200, { ok: ra.ok && rb.ok, a: ra, b: rb, overlap: { sharedKeywords: [...ka].filter((k) => kb.has(k)), onlyA: [...ka].filter((k) => !kb.has(k)), onlyB: [...kb].filter((k) => !ka.has(k)) } });
  },
  tailorJson: (req, res, { body, config }) => {
    const slugName = String(body.slug || '');
    if (!SLUG_RE.test(slugName)) throw httpError('slug must match [a-z0-9-]{1,60}.', 400, 'BAD_SLUG');
    const reps = body.replacements;
    if (!Array.isArray(reps) || !reps.length || reps.length > 10 || !reps.every((r) => r && typeof r.old === 'string' && typeof r.new === 'string' && r.old && r.old.length <= 600 && r.new.length <= 600)) {
      throw httpError('replacements must be 1-10 {old,new} string pairs.', 400, 'BAD_REPLACEMENTS');
    }
    fs.mkdirSync(config.paths.tailorRunsDir, { recursive: true });
    const file = path.join(config.paths.tailorRunsDir, `${slugName}.json`);
    fs.writeFileSync(file, JSON.stringify(reps.map((r) => ({ old: r.old, new: r.new })), null, 4), 'utf8');
    return sendJson(res, 200, { ok: true, path: file, note: 'Saved. This tool does not run the generator for this file; copy the command and run it yourself.' });
  },
  generate: (req, res, { body, ctx, id, reload }) => {
    const job = gen.startJob(() => actions.generateForJd(ctx, body, { reload }), { profileId: id });
    return sendJson(res, 202, { ok: true, jobId: job.id, status: job.status });
  },
  application: (req, res, { body, ctx }) => {
    const r = actions.recordApplication(ctx, body);
    refreshLog(ctx);
    return sendJson(res, 200, r);
  },
  addEvidence: (req, res, { body, config, reload }) => {
    const item = actions.addEvidence(config, body.item);
    const { ctx } = reload();
    return sendJson(res, 200, { ok: true, item, staleBases: actions.staleBasesFor(ctx, item.id) });
  },
  propagatePreview: (req, res, { body, ctx }) => sendJson(res, 200, actions.preparePropagation(ctx, body)),
  propagate: (req, res, { body, ctx, id, reload }) => {
    // Requires the token from /preview (issued after the user saw exactly what will change), for this profile.
    if (!actions.hasPlan(body.confirmToken, id)) throw httpError('A confirmation token from /evidence/propagate/preview is required.', 400, 'CONFIRM_REQUIRED');
    const job = gen.startJob(() => actions.runPropagation(ctx, body, { reload }), { profileId: id });
    return sendJson(res, 202, { ok: true, jobId: job.id });
  },
  checklistAppend: (req, res, { body, config, ctx }) => {
    if (config.log !== 'checklist' || !config.paths.checklist) throw httpError('This profile has no markdown checklist.', 400, 'NO_CHECKLIST');
    if (body.confirm !== true) throw httpError('Explicit confirmation is required (confirm: true).', 400, 'CONFIRM_REQUIRED');
    const r = appendToChecklist(config.paths.checklist, String(body.line || ''));
    refreshLog(ctx);
    return sendJson(res, 200, r);
  },
  // Set (first time) or change the password. The route guard already required a session when protected.
  password: (req, res, { body, id }) => {
    const rl = auth.checkRateLimit(id);
    if (rl.limited) return sendJson(res, 429, { ok: false, code: 'RATE_LIMITED', error: `Too many wrong passwords. Try again in ${rl.retryAfter} s.`, retryAfter: rl.retryAfter }, { 'retry-after': String(rl.retryAfter) });
    try {
      profiles.setPassword(id, { current: typeof body.current === 'string' ? body.current : undefined, next: body.next });
    } catch (error) {
      if (error.code === 'WRONG_PASSWORD') auth.recordFailure(id);
      throw error;
    }
    auth.resetFailures(id);
    auth.destroySessions(id);
    const token = auth.createSession(id);
    dropProfile(id);
    reloadProfile(id);
    return sendJson(res, 200, { ok: true, id, protected: true, locked: false }, { 'set-cookie': auth.cookieHeader(id, token) });
  },
  // ---------------- onboarding
  // New (kind user) profile from the empty template. With a password: encrypted from the start and the caller
  // gets an unlocked session cookie.
  createProfile: (req, res, { body }) => {
    const id = profiles.assertId(typeof body.id === 'string' ? body.id.trim() : body.id);
    const name = String(body.name || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80) || id;
    const hasPw = body.password !== undefined && body.password !== null && body.password !== '';
    if (hasPw) auth.validatePassword(body.password);
    profiles.createProfile({ id, name, kind: 'user' });
    const headers = {};
    if (hasPw) {
      profiles.setPassword(id, { next: body.password });
      headers['set-cookie'] = auth.cookieHeader(id, auth.createSession(id));
    }
    dropProfile(id);
    return sendJson(res, 201, { ok: true, profile: { id, name, kind: 'user', protected: hasPw, locked: false } }, headers);
  },
  uploadResume: (req, res, { body, config, reload }) => {
    const upload = profiles.saveUpload(config, { fileName: body.fileName, family: body.family, dataBase64: body.dataBase64, text: body.text });
    const { ctx } = reload();
    return sendJson(res, 201, { ok: true, upload, resumes: resumeSummary(ctx) });
  },
  draft: (req, res, { config, ctx }) => {
    const draft = draftProfile(ctx.resumes, config.keywords, { rules: config.rules });
    return sendJson(res, 200, {
      ok: true, draft, resumes: resumeSummary(ctx), directions: directionCatalog(),
      defaults: { applyThreshold: 75, tailorBand: 20, ceiling: Math.max(1, Math.round(draft.totalYears)) }
    });
  },
  // Writes profile.json (honestyMode generic) and the rules.json override; restores both if the result does not load.
  confirm: (req, res, { body, id, config, reload }) => {
    if ((config.meta.kind || 'user') !== 'user') throw httpError('Onboarding only edits new (user) profiles.', 409, 'NOT_USER_PROFILE');
    const { readJson, writeJson } = require('./lib/store-io.cjs');
    const profileFile = path.join(config.configDir, 'profile.json');
    const rulesFile = path.join(config.configDir, 'rules.json');
    const existing = readJson(profileFile);
    const nextProfile = buildProfile(existing, body.profile || {});
    const nextRules = buildRulesOverride(readJson(path.join(ROOT, 'defaults', 'rules.json')), body.rules || {});
    const prevRules = fs.existsSync(rulesFile) ? readJson(rulesFile) : null;
    writeJson(profileFile, nextProfile, { space: 2, trailingNewline: true });
    writeJson(rulesFile, nextRules, { space: 2, trailingNewline: true });
    let entry;
    try {
      entry = reload();
    } catch (error) {
      writeJson(profileFile, existing, { space: 2, trailingNewline: true });
      if (prevRules) writeJson(rulesFile, prevRules, { space: 2, trailingNewline: true }); else fs.rmSync(rulesFile, { force: true });
      reload();
      throw httpError(`Not saved: ${error.message}`, 400, 'BAD_ONBOARDING');
    }
    return sendJson(res, 200, { ...profileHealth(id, entry), saved: { profile: 'config/profile.json', rules: 'config/rules.json' } });
  },
  importLog: (req, res, { body, config, ctx }) => {
    if (!config.paths.applicationsFile) throw httpError('This profile has no applications log.', 400, 'NO_APPLICATIONS_LOG');
    const text = String(body.text || '');
    if (!text.trim()) throw httpError('Paste the log text to import.', 400, 'EMPTY_TEXT');
    let entries;
    if (body.format === 'csv') {
      try { entries = apps.parseCsvLog(text); } catch (error) { throw httpError(error.message, 400, 'BAD_CSV'); }
    } else if (body.format === 'markdown') {
      entries = apps.importMarkdown(text, config.rules, ctx.resumes.map((r) => r.name));
    } else throw httpError('format must be "markdown" or "csv".', 400, 'BAD_FORMAT');
    const result = apps.importApplications(config.paths.applicationsFile, entries);
    refreshLog(ctx);
    return sendJson(res, 200, { ok: true, parsed: entries.length, ...result });
  },
  keywords: (req, res, { body, config }) => {
    const { parseJd } = require('./lib/jd.cjs');
    const jd = parseJd({ text: body.jdText }, config.rules);
    return sendJson(res, 200, { ok: true, keywords: extractKeywords(jd, config.keywords).map((k) => ({ id: k.id, canonical: k.canonical, section: k.section })) });
  }
};

// Exported so tests can enumerate every route. scope 'profile' = needs a valid :id and gets that profile's context.
const ROUTES = [
  { method: 'GET', pattern: '/', scope: 'global', handler: H.ui },
  { method: 'GET', pattern: '/index.html', scope: 'global', handler: H.ui },
  { method: 'GET', pattern: '/api/health', scope: 'global', handler: H.health },
  { method: 'GET', pattern: '/api/profiles', scope: 'global', handler: H.profiles },
  { method: 'GET', pattern: '/api/directions', scope: 'global', handler: H.directions },
  { method: 'POST', pattern: '/api/fetch', scope: 'global', handler: H.fetch },
  { method: 'POST', pattern: '/api/demo/reset', scope: 'global', handler: H.demoReset },
  { method: 'POST', pattern: '/api/profiles/:id/unlock', scope: 'global', handler: H.unlock },
  { method: 'POST', pattern: '/api/profiles/:id/lock', scope: 'global', handler: H.lock },
  { method: 'POST', pattern: '/api/profiles/:id/reset', scope: 'global', handler: H.reset },

  { method: 'GET', pattern: '/api/p/:id/health', scope: 'profile', handler: H.pHealth },
  { method: 'GET', pattern: '/api/p/:id/settings', scope: 'profile', handler: H.settings },
  { method: 'GET', pattern: '/api/p/:id/history', scope: 'profile', handler: H.history },
  { method: 'GET', pattern: '/api/p/:id/resumes', scope: 'profile', handler: H.resumes },
  { method: 'GET', pattern: '/p/:id/download/:file', scope: 'profile', handler: H.download },
  { method: 'GET', pattern: '/api/p/:id/jobs/:job', scope: 'profile', handler: H.job },
  { method: 'GET', pattern: '/api/p/:id/stats', scope: 'profile', handler: H.stats },
  { method: 'GET', pattern: '/api/p/:id/evidence/candidates', scope: 'profile', handler: H.candidates },
  { method: 'GET', pattern: '/api/p/:id/pending', scope: 'profile', handler: H.pending },
  { method: 'GET', pattern: '/api/p/:id/repo', scope: 'profile', handler: H.repo },
  { method: 'GET', pattern: '/api/p/:id/evidence', scope: 'profile', handler: H.evidence },
  { method: 'GET', pattern: '/api/p/:id/calibration', scope: 'profile', handler: H.calibration },
  { method: 'POST', pattern: '/api/p/:id/reload', scope: 'profile', handler: H.reload },
  { method: 'POST', pattern: '/api/p/:id/analyze', scope: 'profile', handler: H.analyze },
  { method: 'POST', pattern: '/api/p/:id/compare', scope: 'profile', handler: H.compare },
  { method: 'POST', pattern: '/api/p/:id/tailor-json', scope: 'profile', handler: H.tailorJson },
  { method: 'POST', pattern: '/api/p/:id/generate', scope: 'profile', handler: H.generate },
  { method: 'POST', pattern: '/api/p/:id/application', scope: 'profile', handler: H.application },
  { method: 'POST', pattern: '/api/p/:id/evidence', scope: 'profile', handler: H.addEvidence },
  { method: 'POST', pattern: '/api/p/:id/evidence/propagate/preview', scope: 'profile', handler: H.propagatePreview },
  { method: 'POST', pattern: '/api/p/:id/evidence/propagate', scope: 'profile', handler: H.propagate },
  { method: 'POST', pattern: '/api/p/:id/checklist/append', scope: 'profile', handler: H.checklistAppend },
  { method: 'POST', pattern: '/api/p/:id/keywords', scope: 'profile', handler: H.keywords },
  { method: 'POST', pattern: '/api/p/:id/password', scope: 'profile', handler: H.password },
  { method: 'POST', pattern: '/api/profiles', scope: 'global', handler: H.createProfile },
  { method: 'POST', pattern: '/api/p/:id/resumes', scope: 'profile', handler: H.uploadResume, maxBody: MAX_UPLOAD_BODY },
  { method: 'GET', pattern: '/api/p/:id/onboarding/draft', scope: 'profile', handler: H.draft },
  { method: 'POST', pattern: '/api/p/:id/onboarding/confirm', scope: 'profile', handler: H.confirm },
  { method: 'POST', pattern: '/api/p/:id/import-log', scope: 'profile', handler: H.importLog }
];

for (const r of ROUTES) {
  const names = [];
  const src = r.pattern.split('/').map((seg) => {
    if (!seg.startsWith(':')) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    names.push(seg.slice(1));
    return '([^/]+)';
  }).join('/');
  r.regex = new RegExp(`^${src}$`);
  r.params = names;
}

function matchRoute(method, pathname) {
  let pathMatched = false;
  for (const r of ROUTES) {
    const m = r.regex.exec(pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== method) continue;
    const params = {};
    r.params.forEach((n, i) => { params[n] = m[i + 1]; });
    return { route: r, params };
  }
  return { route: null, pathMatched };
}

async function route(request, response, url) {
  const { route: r, params } = matchRoute(request.method, url.pathname);
  if (!r) throw httpError('Not found.', 404, 'NOT_FOUND');
  let body = {};
  if (r.method === 'POST') {
    // CSRF guard: a browser Origin header must be this server.
    const origin = request.headers.origin;
    if (origin && !ALLOWED_ORIGINS.has(String(origin).toLowerCase())) throw httpError('Cross-origin request rejected.', 403, 'BAD_ORIGIN');
  }
  // Auth guard: every profile-scoped route of a protected profile needs a valid session (checked before the body).
  if (r.scope === 'profile') {
    requireKnownProfile(params.id);
    if (!isOpen(request, params.id)) throw lockedHttpError();
  }
  if (r.method === 'POST') body = await readJsonBody(request, r.maxBody || MAX_BODY);
  if (r.scope === 'global') return r.handler(request, response, { url, params, body });
  const id = params.id;
  const entry = getProfileCtx(id);
  return r.handler(request, response, { url, params, body, id, config: entry.config, ctx: entry.ctx, reload: () => reloadProfile(id) });
}

function createServer() {
  // Idle sessions also expire without a request (drops the key and the decrypted context).
  setInterval(auth.sweep, Math.min(60 * 1000, auth.idleMs())).unref();
  return http.createServer((request, response) => {
    if (!ALLOWED_HOSTS.has(String(request.headers.host || '').toLowerCase())) {
      sendJson(response, 403, { ok: false, error: 'Host not allowed.' });
      return;
    }
    const url = new URL(request.url, `http://${request.headers.host}`);
    Promise.resolve().then(() => route(request, response, url)).catch((error) => {
      if (response.headersSent) { response.end(); return; }
      sendJson(response, error.statusCode || 500, { ok: false, code: error.code || 'JDFC_ERROR', error: error.message });
    });
  });
}

if (require.main === module) {
  try { if (profiles.ensureDemo()) console.log('Installed the demo profile (synthetic data).'); } catch (error) { console.log(`Demo profile not installed: ${error.message}`); }
  const server = createServer();
  server.listen(PORT, HOST, () => {
    const list = profiles.listProfiles();
    console.log(`JD Fit Checker running at http://${HOST}:${PORT}  (profile store: ${profiles.jdfcHome()})`);
    console.log(`  profiles: ${list.length ? list.map((p) => `${p.id}${p.protected ? ' (protected)' : ''}`).join(', ') : 'none yet'}`);
  });
}

module.exports = { createServer, setPort, reloadProfile, dropProfile, ROUTES, HOST, PORT };
