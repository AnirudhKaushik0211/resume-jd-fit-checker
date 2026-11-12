'use strict';

// Optional per-profile password protection: scrypt password hash, scrypt-derived encryption key (separate salt),
// in-memory sessions (HttpOnly cookie, sliding idle timeout, lost on restart) and a per-profile login rate limit.
// Plaintext passwords are never logged or persisted; only the scrypt hash and salts go into profile.meta.json.

const crypto = require('crypto');

const SCRYPT = { N: 32768, r: 8, p: 1 };
const HASH_LEN = 64;
const KEY_LEN = 32;
const SALT_LEN = 16;
const MAXMEM = 64 * 1024 * 1024; // 128 * N * r = 32 MiB hits Node's default 32 MiB limit
const MAX_PASSWORD = 1024;
const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const MAX_FAILURES = 5;
const BASE_LOCKOUT_MS = 60 * 1000;
const MAX_LOCKOUT_MS = 15 * 60 * 1000;

let now = () => Date.now();
function _setNow(fn) { now = typeof fn === 'function' ? fn : () => Date.now(); }

function authError(message, statusCode, code) {
  const e = new Error(message);
  e.statusCode = statusCode;
  e.code = code;
  return e;
}

// The only password rule: non-empty, at most 1024 characters.
function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length === 0) throw authError('Password must not be empty.', 400, 'BAD_PASSWORD');
  if (pw.length > MAX_PASSWORD) throw authError(`Password must be at most ${MAX_PASSWORD} characters.`, 400, 'BAD_PASSWORD');
  return pw;
}

function scrypt(password, salt, keylen, params = SCRYPT) {
  return crypto.scryptSync(String(password), salt, keylen, { N: params.N, r: params.r, p: params.p, maxmem: MAXMEM });
}

function newSalt() { return crypto.randomBytes(SALT_LEN).toString('hex'); }

// -> { alg, N, r, p, keylen, salt, hash } (hex), stored in profile.meta.json "auth".
function hashPassword(password) {
  validatePassword(password);
  const salt = newSalt();
  const hash = scrypt(password, Buffer.from(salt, 'hex'), HASH_LEN);
  return { alg: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keylen: HASH_LEN, salt, hash: hash.toString('hex') };
}

function verifyPassword(password, auth) {
  if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD) return false;
  if (!auth || !auth.salt || !auth.hash) return false;
  const expected = Buffer.from(String(auth.hash), 'hex');
  const params = { N: auth.N || SCRYPT.N, r: auth.r || SCRYPT.r, p: auth.p || SCRYPT.p };
  const got = scrypt(password, Buffer.from(String(auth.salt), 'hex'), expected.length || HASH_LEN, params);
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

// AES-256 key from the password and the separate encryption salt (meta "enc.salt").
function deriveKey(password, encSalt, params = SCRYPT) {
  return scrypt(password, Buffer.isBuffer(encSalt) ? encSalt : Buffer.from(String(encSalt), 'hex'), KEY_LEN, params);
}

// ---------------------------------------------------------------- sessions
const sessions = new Map(); // sha256(token) hex -> { profileId, lastSeen }
const expireListeners = [];

function idleMs() {
  const v = Number(process.env.JDFC_IDLE_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_IDLE_MS;
}
const digest = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const cookieName = (profileId) => `jdfc_${profileId}`;

function onExpire(fn) { expireListeners.push(fn); }

function hasActiveSession(profileId) {
  for (const s of sessions.values()) if (s.profileId === profileId && now() - s.lastSeen < idleMs()) return true;
  return false;
}

function expire(hash) {
  const s = sessions.get(hash);
  sessions.delete(hash);
  if (s && !hasActiveSession(s.profileId)) for (const fn of expireListeners) { try { fn(s.profileId); } catch { /* listener errors never break a request */ } }
}

// Drops every idle session; a profile whose last session expired fires the expiry listeners (key + ctx dropped).
function sweep() {
  for (const [hash, s] of [...sessions]) if (now() - s.lastSeen >= idleMs()) expire(hash);
}

function createSession(profileId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(digest(token), { profileId, lastSeen: now() });
  return token;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

// Valid session for this profile from the request cookie (sliding: touches lastSeen), else null.
function sessionFor(req, profileId) {
  const token = parseCookies(req && req.headers && req.headers.cookie)[cookieName(profileId)];
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const hash = digest(token);
  const s = sessions.get(hash);
  if (!s || s.profileId !== profileId) return null;
  if (now() - s.lastSeen >= idleMs()) { expire(hash); return null; }
  s.lastSeen = now();
  return s;
}

function destroySessions(profileId) {
  for (const [hash, s] of [...sessions]) if (s.profileId === profileId) sessions.delete(hash);
}

// No Max-Age (session cookie) and no Secure (plain-http localhost).
function cookieHeader(profileId, token) { return `${cookieName(profileId)}=${token}; HttpOnly; SameSite=Strict; Path=/`; }
function clearCookieHeader(profileId) { return `${cookieName(profileId)}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`; }

// ---------------------------------------------------------------- rate limit (per profile)
// 5 failures -> 60 s lockout; each further lockout doubles it (cap 15 min); a success resets everything.
const failures = new Map(); // profileId -> { count, lockouts, lockedUntil }

function checkRateLimit(profileId) {
  const f = failures.get(profileId);
  if (!f || f.lockedUntil <= now()) return { limited: false, retryAfter: 0 };
  return { limited: true, retryAfter: Math.ceil((f.lockedUntil - now()) / 1000) };
}

function recordFailure(profileId) {
  const f = failures.get(profileId) || { count: 0, lockouts: 0, lockedUntil: 0 };
  f.count += 1;
  if (f.count >= MAX_FAILURES) {
    f.lockouts += 1;
    f.count = 0;
    f.lockedUntil = now() + Math.min(BASE_LOCKOUT_MS * 2 ** (f.lockouts - 1), MAX_LOCKOUT_MS);
  }
  failures.set(profileId, f);
  return checkRateLimit(profileId);
}

function resetFailures(profileId) { failures.delete(profileId); }

// Test helper: forget all sessions and failures.
function _reset() { sessions.clear(); failures.clear(); }

module.exports = {
  validatePassword, hashPassword, verifyPassword, deriveKey, newSalt,
  createSession, sessionFor, destroySessions, hasActiveSession, sweep, onExpire, parseCookies, cookieName, cookieHeader, clearCookieHeader, idleMs,
  checkRateLimit, recordFailure, resetFailures, _setNow, _reset,
  SCRYPT, HASH_LEN, KEY_LEN, SALT_LEN, MAXMEM, MAX_PASSWORD, DEFAULT_IDLE_MS, MAX_FAILURES, BASE_LOCKOUT_MS, MAX_LOCKOUT_MS
};
