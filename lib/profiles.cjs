'use strict';

// Profile store: every candidate's data lives OUTSIDE the tool folder, in <home>\profiles\<id>\.
// home = JDFC_HOME (read at call time) or %USERPROFILE%\.jd-fit-checker. The tool ships only seeds.

const fs = require('fs');
const os = require('os');
const path = require('path');
const storeIo = require('./store-io.cjs');
const auth = require('./auth.cjs');

const { META_FILE } = storeIo;

const TOOL_DIR = path.resolve(__dirname, '..');
const SEED_DIR = path.join(TOOL_DIR, 'profiles-seed');
const ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const KINDS = new Set(['owner', 'demo', 'user']);

function jdfcHome() { return path.resolve(process.env.JDFC_HOME || path.join(os.homedir(), '.jd-fit-checker')); }
function profilesDir(home) { return path.join(home ? path.resolve(home) : jdfcHome(), 'profiles'); }

function validId(id) { return typeof id === 'string' && ID_RE.test(id); }
function assertId(id) {
  if (!validId(id)) {
    const e = new Error(`Invalid profile id "${String(id)}": use 2-32 chars of a-z, 0-9 and -, starting with a letter or digit.`);
    e.statusCode = 400;
    e.code = 'BAD_PROFILE_ID';
    throw e;
  }
  return id;
}
function profileRoot(id, home) { return path.join(profilesDir(home), assertId(id)); }
function profileExists(id, home) { return validId(id) && fs.existsSync(path.join(profileRoot(id, home), META_FILE)); }

function readMeta(idOrRoot, home) {
  const root = validId(idOrRoot) && !path.isAbsolute(idOrRoot) ? profileRoot(idOrRoot, home) : path.resolve(idOrRoot);
  return JSON.parse(fs.readFileSync(path.join(root, META_FILE), 'utf8').replace(/^\uFEFF/, ''));
}

// The meta file is always plaintext (it holds the auth/encryption parameters, never secrets).
function writeMeta(root, meta) {
  const file = path.join(root, META_FILE);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  fs.renameSync(`${file}.tmp`, file);
}

function listProfiles(home) {
  const dir = profilesDir(home);
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const d of entries) {
    if (!d.isDirectory() || !validId(d.name)) continue;
    try {
      const meta = readMeta(path.join(dir, d.name));
      out.push({ id: d.name, name: String(meta.name || d.name), kind: KINDS.has(meta.kind) ? meta.kind : 'user', protected: meta.protected === true });
    } catch { /* not a profile folder */ }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const d of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, d.name);
    const t = path.join(dst, d.name);
    if (d.isDirectory()) copyDir(s, t);
    else if (d.isFile()) fs.copyFileSync(s, t);
  }
}

// New profile from a seed folder (default: the empty template). Refuses to overwrite an existing profile.
function createProfile({ id, name, kind = 'user' }, { home, seed = '_template' } = {}) {
  assertId(id);
  if (!KINDS.has(kind)) throw new Error(`Unknown profile kind "${kind}".`);
  const root = profileRoot(id, home);
  if (fs.existsSync(root)) {
    const e = new Error(`Profile "${id}" already exists.`);
    e.statusCode = 409;
    e.code = 'PROFILE_EXISTS';
    throw e;
  }
  const seedDir = path.join(SEED_DIR, seed);
  if (!fs.existsSync(seedDir)) throw new Error(`Seed "${seed}" not found in ${SEED_DIR}.`);
  copyDir(seedDir, root);
  // Empty folders may be missing from the seed (e.g. git/web uploads drop .keep files), so create them explicitly.
  for (const d of ['resumes', path.join('fixtures', 'jds')]) fs.mkdirSync(path.join(root, d), { recursive: true });
  writeMeta(root, { id, name: String(name || id).slice(0, 80), kind, createdAt: new Date().toISOString(), protected: false });
  return root;
}

// Synthetic demo profile (seed profiles-seed\demo). Installed when missing (server start); reset restores the seed.
const DEMO_ID = 'demo';
function demoSeedName() {
  try { return readMeta(path.join(SEED_DIR, 'demo')).name || 'Demo'; } catch { return 'Demo'; }
}
function ensureDemo(home) {
  if (profileExists(DEMO_ID, home)) return null;
  if (fs.existsSync(profileRoot(DEMO_ID, home))) return null; // a folder without meta is not ours to touch
  return createProfile({ id: DEMO_ID, name: demoSeedName(), kind: 'demo' }, { home, seed: 'demo' });
}
function resetDemo(home) {
  const root = profileRoot(DEMO_ID, home);
  if (fs.existsSync(root)) {
    let meta = null;
    try { meta = readMeta(root); } catch { /* unreadable meta */ }
    if (!meta || meta.kind !== 'demo') {
      const e = new Error('Profile "demo" is not the demo profile; refusing to reset it.');
      e.statusCode = 409;
      e.code = 'NOT_DEMO';
      throw e;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
  return createProfile({ id: DEMO_ID, name: demoSeedName(), kind: 'demo' }, { home, seed: 'demo' });
}

// ---------------------------------------------------------------- password protection
// Tool-owned files = every *.json (plus *.json.bak copies) under config\, data\ and fixtures\ - never the meta file.
// Linked files outside the root, resumes\, tailor-runs\ and reports\ stay plaintext (see README "Security model").
const OWNED_DIRS = ['config', 'data', 'fixtures'];
const OWNED_RE = /\.json(\.bak)?$/i;
const PENDING_SUFFIX = '.jdfc-new.tmp';
const lockListeners = [];
function onLock(fn) { lockListeners.push(fn); }

function walkFiles(dir, pred, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of entries) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) walkFiles(full, pred, out);
    else if (d.isFile() && pred(d.name)) out.push(full);
  }
  return out;
}

function toolOwnedFiles(root) {
  const out = [];
  for (const d of OWNED_DIRS) walkFiles(path.join(root, d), (n) => OWNED_RE.test(n) && n !== META_FILE, out);
  return out.sort();
}

function pendingFiles(root) {
  const out = [];
  for (const d of OWNED_DIRS) walkFiles(path.join(root, d), (n) => n.endsWith(PENDING_SUFFIX), out);
  return out;
}

function profError(message, statusCode, code) {
  const e = new Error(message);
  e.statusCode = statusCode;
  e.code = code;
  return e;
}

// A crash between "meta written" and "renames done" leaves *.jdfc-new.tmp files encrypted with the NEW key:
// on unlock, finish the renames for files that decrypt with the current key and drop the rest (never ours).
function finishPending(root, key) {
  for (const tmp of pendingFiles(root)) {
    const file = tmp.slice(0, -PENDING_SUFFIX.length);
    let ok = false;
    try { storeIo.decryptBuffer(root, file, fs.readFileSync(tmp), key); ok = true; } catch { /* stale tmp from an aborted change */ }
    if (ok) fs.renameSync(tmp, file); else fs.rmSync(tmp, { force: true });
  }
}

// First time: encrypts every tool-owned file. Change: verifies `current`, decrypts with the old key and re-encrypts
// with a key from a NEW enc salt. Every new file goes to *.jdfc-new.tmp first, then the meta, then the renames.
// Registers the new key in this process (the caller stays unlocked). Never stores the plaintext password.
function setPassword(id, { current, next } = {}, { home } = {}) {
  const root = profileRoot(id, home);
  if (!profileExists(id, home)) throw profError('Unknown profile.', 404, 'UNKNOWN_PROFILE');
  const meta = readMeta(root);
  if (meta.kind === 'demo') throw profError('The demo profile cannot be password protected.', 409, 'DEMO_UNPROTECTED');
  auth.validatePassword(next);
  let oldKey = null;
  if (meta.protected === true) {
    if (!auth.verifyPassword(current, meta.auth)) throw profError('Current password is wrong.', 401, 'WRONG_PASSWORD');
    oldKey = auth.deriveKey(current, meta.enc.salt);
    finishPending(root, oldKey);
  }
  for (const stale of pendingFiles(root)) fs.rmSync(stale, { force: true });
  const newAuth = auth.hashPassword(next);
  const encSalt = auth.newSalt();
  const newKey = auth.deriveKey(next, encSalt);
  const files = toolOwnedFiles(root);
  for (const file of files) {
    const buf = fs.readFileSync(file);
    let plain = buf;
    if (storeIo.isEncrypted(buf)) {
      if (!oldKey) throw profError(`${path.basename(file)} is encrypted but the profile is not marked protected.`, 409, 'INCONSISTENT_PROFILE');
      plain = storeIo.decryptBuffer(root, file, buf, oldKey);
    }
    fs.writeFileSync(file + PENDING_SUFFIX, storeIo.encryptBuffer(root, file, plain, newKey));
  }
  writeMeta(root, { ...meta, protected: true, auth: newAuth, enc: { salt: encSalt } });
  for (const file of files) fs.renameSync(file + PENDING_SUFFIX, file);
  storeIo.setKey(root, newKey);
  return { root, files: files.length };
}

// true + key registered, or false for a wrong password. Unprotected profiles are always "unlocked".
function unlock(id, password, { home } = {}) {
  const root = profileRoot(id, home);
  const meta = readMeta(root);
  if (meta.protected !== true) return true;
  if (!auth.verifyPassword(password, meta.auth)) return false;
  const key = auth.deriveKey(password, meta.enc.salt);
  finishPending(root, key);
  storeIo.setKey(root, key);
  return true;
}

// CLI unlock (scripts and profile test suites only; the server never calls this and still requires a session).
// Unprotected or unknown profile: no-op. Protected: unlocks with JDFC_PASSWORD, or throws PROFILE_LOCKED when it is
// not set and WRONG_PASSWORD when it does not match.
function unlockFromEnv(id, { home, env = process.env } = {}) {
  if (!profileExists(id, home)) return false;
  if (readMeta(id, home).protected !== true) return true;
  if (storeIo.hasKey(profileRoot(id, home))) return true;
  const password = env.JDFC_PASSWORD;
  if (!password) throw profError(`Profile "${id}" is password protected: set JDFC_PASSWORD to use it from the command line.`, 423, 'PROFILE_LOCKED');
  if (!unlock(id, password, { home })) throw profError(`JDFC_PASSWORD is not the password of profile "${id}".`, 401, 'WRONG_PASSWORD');
  return true;
}

function isUnlocked(id, home) {
  const root = profileRoot(id, home);
  return !storeIo.isProtectedRoot(root) || storeIo.hasKey(root);
}

// Forgets the key in this process and tells listeners (the server drops its cached context).
function lock(id, { home } = {}) {
  storeIo.clearKey(profileRoot(id, home));
  for (const fn of lockListeners) { try { fn(id); } catch { /* listener errors never block a lock */ } }
}

// Forgotten password: deletes the tool-owned files, removes auth/enc from the meta and re-seeds config\ and data\
// from the empty template. Linked files outside the root (e.g. a workspace Resume folder) are never touched.
function resetProfile(id, { home } = {}) {
  const root = profileRoot(id, home);
  if (!profileExists(id, home)) throw profError('Unknown profile.', 404, 'UNKNOWN_PROFILE');
  const meta = readMeta(root);
  if (meta.kind === 'demo') throw profError('Use "Reset demo" for the demo profile.', 409, 'USE_DEMO_RESET');
  lock(id, { home });
  for (const file of [...toolOwnedFiles(root), ...pendingFiles(root)]) fs.rmSync(file, { force: true });
  for (const d of ['config', 'data']) copyDir(path.join(SEED_DIR, '_template', d), path.join(root, d));
  for (const d of ['resumes', path.join('fixtures', 'jds')]) fs.mkdirSync(path.join(root, d), { recursive: true });
  const { auth: _a, enc: _e, ...rest } = meta;
  writeMeta(root, { ...rest, protected: false, resetAt: new Date().toISOString() });
  return root;
}

// ---------------------------------------------------------------- onboarding uploads
// Saves an uploaded .docx (base64) or pasted text (built into a .docx) into the profile's resume folder as
// <stem>.docx, or <stem>_v<n>.docx when taken (never overwrites), and appends it to the uploads manifest.
// Per family the newest upload becomes the base; older versions stay as lineage (see lib\resumes.cjs).
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const PDF_MESSAGE = 'PDF not supported yet, export to .docx or paste text';

function sanitizeStem(name, fallback) {
  const base = path.basename(String(name || '')).replace(/\.(docx|doc|pdf|txt)$/i, '');
  const stem = base.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^[_-]+|[_-]+$/g, '').slice(0, 60);
  return stem || fallback;
}
function sanitizeFamily(f) {
  return String(f || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'general';
}

function saveUpload(config, { fileName, family, dataBase64, text } = {}, { now = new Date() } = {}) {
  const { buildDocx } = require('./docx-write.cjs');
  const { listZipEntries, docxParagraphsFromBuffer } = require('./docx.cjs');
  const fam = sanitizeFamily(family);
  let buf;
  let source;
  if (typeof dataBase64 === 'string' && dataBase64) {
    if (/\.pdf$/i.test(String(fileName || ''))) throw profError(PDF_MESSAGE, 415, 'PDF_NOT_SUPPORTED');
    buf = Buffer.from(dataBase64, 'base64');
    if (buf.subarray(0, 4).toString('latin1') === '%PDF') throw profError(PDF_MESSAGE, 415, 'PDF_NOT_SUPPORTED');
    if (buf.length > MAX_UPLOAD_BYTES) throw profError('The file is larger than 5 MB.', 413, 'TOO_LARGE');
    let ok = buf.subarray(0, 2).toString('latin1') === 'PK';
    try { ok = ok && listZipEntries(buf).some((e) => e.name === 'word/document.xml') && docxParagraphsFromBuffer(buf).length > 0; } catch { ok = false; }
    if (!ok) throw profError('Not a readable .docx file (Word document with text expected).', 400, 'NOT_DOCX');
    source = 'docx';
  } else if (typeof text === 'string' && text.trim()) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
    if (lines.length < 2) throw profError('Paste the full resume text (at least a few lines).', 400, 'EMPTY_TEXT');
    buf = buildDocx(lines);
    source = 'paste';
  } else {
    throw profError('Send either a .docx file (dataBase64) or pasted resume text.', 400, 'NO_RESUME');
  }
  const dir = config.paths.resumeDir;
  const uploadsFile = config.paths.uploadsFile;
  if (!dir || !uploadsFile) throw profError('This profile does not take uploads (no uploads manifest).', 400, 'NO_UPLOADS');
  fs.mkdirSync(dir, { recursive: true });
  const prefix = config.paths.resumeFilePrefix || '';
  let stem = sanitizeStem(fileName, `Resume_${fam}`);
  if (!stem.startsWith(prefix)) stem = `${prefix}${stem}`;
  let target = `${stem}.docx`;
  for (let n = 2; fs.existsSync(path.join(dir, target)); n++) target = `${stem}_v${n}.docx`;
  fs.writeFileSync(path.join(dir, target), buf, { flag: 'wx' }); // wx: never overwrite
  let list = [];
  try { list = storeIo.readJson(uploadsFile); } catch (error) { if (error.code === 'PROFILE_LOCKED') throw error; list = []; }
  if (!Array.isArray(list)) list = [];
  const version = list.filter((u) => u && sanitizeFamily(u.family) === fam).length + 1;
  const entry = { file: target, family: fam, version, uploadedAt: now.toISOString(), source, originalName: String(fileName || '').slice(0, 120) || null };
  list.push(entry);
  storeIo.writeJson(uploadsFile, list, { space: 2, trailingNewline: true });
  return entry;
}

// CLI helper: --profile <id>, else JDFC_PROFILE, else "demo". Also exports it as JDFC_PROFILE for child modules.
// A protected profile is unlocked from JDFC_PASSWORD; a missing or wrong password ends the script with a message.
function profileFromArgv(argv = process.argv) {
  const i = argv.indexOf('--profile');
  const id = i > 0 && argv[i + 1] ? argv[i + 1] : (process.env.JDFC_PROFILE || 'demo');
  assertId(id);
  process.env.JDFC_PROFILE = id;
  try {
    unlockFromEnv(id);
  } catch (error) {
    if (error.code !== 'PROFILE_LOCKED' && error.code !== 'WRONG_PASSWORD') throw error;
    console.error(error.message);
    process.exit(1);
  }
  return id;
}

module.exports = { saveUpload, sanitizeFamily, PDF_MESSAGE, MAX_UPLOAD_BYTES, toolOwnedFiles, setPassword, unlock, unlockFromEnv, lock, isUnlocked, resetProfile, onLock, ensureDemo, resetDemo, DEMO_ID, profileFromArgv, jdfcHome, profilesDir, profileRoot, profileExists, validId, assertId, readMeta, writeMeta, listProfiles, createProfile, copyDir, TOOL_DIR, SEED_DIR, ID_RE };
