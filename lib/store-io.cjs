'use strict';

// All tool-owned JSON reads/writes go through here (profile config, history, repository, applications).
// Atomic writes (tmp + rename), BOM strip, and a key registry per profile root. A file under a root whose
// profile.meta.json says protected: true must not be written without a registered key (PROFILE_LOCKED);
// otherwise a locked read followed by a save would overwrite ciphertext with plaintext.
// Protected roots are encrypted at rest with AES-256-GCM (envelope "JDFCENC1"); the key comes from lib\auth.cjs.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const META_FILE = 'profile.meta.json';
const MAGIC = Buffer.from('JDFCENC1', 'utf8');
const keys = new Map(); // resolved profile root -> key Buffer

function lockedError(root) {
  const e = new Error(`Profile is locked${root ? ` (${path.basename(root)})` : ''}: unlock it first.`);
  e.code = 'PROFILE_LOCKED';
  e.statusCode = 423;
  return e;
}

// Nearest ancestor folder holding profile.meta.json (the profile root), or null for files outside any profile.
function rootFor(file) {
  let dir = path.dirname(path.resolve(file));
  for (;;) {
    if (fs.existsSync(path.join(dir, META_FILE))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function isProtectedRoot(root) {
  if (!root) return false;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(root, META_FILE), 'utf8').replace(/^\uFEFF/, ''));
    return meta && meta.protected === true;
  } catch { return false; }
}

function setKey(root, key) { keys.set(path.resolve(root), key); }
function clearKey(root) { keys.delete(path.resolve(root)); }
function hasKey(root) { return keys.has(path.resolve(root)); }

function getKey(root) { return keys.get(path.resolve(root)); }

// ---------------------------------------------------------------- envelope
// "JDFCENC1" (8) + IV (12) + GCM tag (16) + ciphertext; AAD = "<profileId>:<path relative to the root, forward slashes>".
// A ".bak" copy (byte copy of an encrypted file) authenticates with its original's path, so the suffix is ignored.
const IV_LEN = 12;
const TAG_LEN = 16;

function isEncrypted(buf) { return buf.length >= MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC); }

function aadFor(root, file) {
  const rel = path.relative(path.resolve(root), path.resolve(file)).split(path.sep).join('/').replace(/\.bak$/i, '');
  return Buffer.from(`${path.basename(path.resolve(root))}:${rel}`, 'utf8');
}

function encryptBuffer(root, file, plain, key) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aadFor(root, file));
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ct]);
}

function decryptBuffer(root, file, buf, key) {
  if (!isEncrypted(buf) || buf.length < MAGIC.length + IV_LEN + TAG_LEN) throw new Error(`${file} is not an encrypted profile file.`);
  const iv = buf.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = buf.subarray(MAGIC.length + IV_LEN, MAGIC.length + IV_LEN + TAG_LEN);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aadFor(root, file));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(buf.subarray(MAGIC.length + IV_LEN + TAG_LEN)), decipher.final()]);
  } catch {
    const e = new Error(`${path.basename(file)} could not be decrypted (wrong key or modified file).`);
    e.code = 'DECRYPT_FAILED';
    throw e;
  }
}

function readJson(file) {
  let buf = fs.readFileSync(file);
  if (isEncrypted(buf)) {
    const root = rootFor(file);
    if (!root || !hasKey(root)) throw lockedError(root);
    buf = decryptBuffer(root, file, buf, getKey(root));
  }
  const raw = buf.toString('utf8').replace(/^\uFEFF/, '');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${file}: ${error.message}`);
  }
}

// space: JSON indent (default 2); trailingNewline: append "\n" (default false).
function writeJson(file, data, { space = 2, trailingNewline = false } = {}) {
  const root = rootFor(file);
  let out = Buffer.from(JSON.stringify(data, null, space) + (trailingNewline ? '\n' : ''), 'utf8');
  if (isProtectedRoot(root)) {
    if (!hasKey(root)) throw lockedError(root);
    out = encryptBuffer(root, file, out, getKey(root));
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, file);
}

module.exports = { readJson, writeJson, setKey, clearKey, hasKey, getKey, rootFor, isProtectedRoot, lockedError, isEncrypted, aadFor, encryptBuffer, decryptBuffer, MAGIC, META_FILE };
