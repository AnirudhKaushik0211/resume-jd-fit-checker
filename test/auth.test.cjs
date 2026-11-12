'use strict';

// Password protection: scrypt hashing, sessions, rate limit, AES-256-GCM encryption at rest, password change and
// reset, and the HTTP guard (423 on every profile-scoped route of a locked profile). Temp JDFC_HOME only; the real
// owner profile is never read or written.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { tempHome, minimalDocx } = require('./helpers.cjs');

const env = tempHome();
const auth = require('../lib/auth.cjs');
const storeIo = require('../lib/store-io.cjs');
const profiles = require('../lib/profiles.cjs');
const { loadConfig } = require('../lib/config.cjs');
const { terms } = require('../lib/denylist.cjs');

const MARKER = 'ZQX-MARKER-7731';
const DENY = terms()[1]; // a deny-list term planted at runtime (never as a literal in this file)
const PASSWORD = 'correct horse battery staple \u2713 pw-1';
const NEW_PASSWORD = 'second pw \u00e9 2';

// Logs captured for the "no plaintext password in server logs" check.
const logs = [];
for (const k of ['log', 'error', 'warn']) {
  const orig = console[k];
  console[k] = (...a) => { logs.push(a.map(String).join(' ')); orig.apply(console, a); };
}

// Seeds a template profile with marker data (compact JSON so the plaintext is full of '{"' fragments).
function seed(id) {
  const root = env.install(id, { name: `Synthetic ${id}` });
  const pf = path.join(root, 'config', 'profile.json');
  const prof = JSON.parse(fs.readFileSync(pf, 'utf8'));
  prof.employer = `${MARKER} ${DENY}`;
  prof.name = `${MARKER} Person`;
  fs.writeFileSync(pf, JSON.stringify(prof));
  fs.writeFileSync(path.join(root, 'data', 'applications.json'), JSON.stringify([{ date: '2026-01-02', company: `${MARKER} Corp`, role: 'Product Manager', status: 'applied' }]));
  fs.writeFileSync(path.join(root, 'fixtures', 'jds', 'x.json'), JSON.stringify({ id: 'x', company: MARKER, title: 'Product Manager', logged: 'synthetic', expected: { historicalVerdict: 'skip', historicalFit: 40, verdictAtT55: ['skip'], flags: {} }, lines: ['Product Manager', `Company: ${MARKER}`, 'Requirements', '- 2+ years of product management.'] }));
  fs.writeFileSync(path.join(root, 'resumes', 'Synthetic_Base.docx'), minimalDocx(['Synthetic Person', 'Core Skills: SQL | Roadmapping', 'Built dashboards for 20 teams.']));
  return root;
}

// JSON fragments of the plaintext ('{"' + the next 6 chars): none may survive in the ciphertext.
function jsonFragments(buf) {
  const s = buf.toString('utf8');
  const out = new Set();
  for (let i = s.indexOf('{"'); i >= 0; i = s.indexOf('{"', i + 1)) out.add(s.slice(i, i + 8));
  return [...out].filter((f) => f.length === 8);
}

function assertEncrypted(root, plainByFile) {
  const files = profiles.toolOwnedFiles(root);
  assert.ok(files.length >= 8, `tool-owned files: ${files.length}`);
  for (const f of files) {
    const buf = fs.readFileSync(f);
    const rel = path.relative(root, f);
    assert.ok(buf.subarray(0, 8).equals(Buffer.from('JDFCENC1')), `${rel} starts with JDFCENC1`);
    assert.ok(!buf.subarray(0, 64).includes('{"'), `${rel} has no '{"' at the start`);
    for (const frag of plainByFile[f] || []) assert.ok(!buf.includes(frag), `${rel} leaks ${frag}`);
    assert.ok(!buf.includes(MARKER), `${rel} leaks the marker`);
    assert.ok(!buf.toString('latin1').toLowerCase().includes(DENY.toLowerCase()), `${rel} leaks a deny-list term`);
  }
}

function walk(dir, out = []) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) walk(full, out); else if (d.isFile()) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------- unit: hashing, sessions, rate limit

test('scrypt parameters: N=32768 r=8 p=1, 64-byte hash, 16-byte salt; verify uses the stored params', () => {
  const a = auth.hashPassword(PASSWORD);
  assert.equal(a.alg, 'scrypt');
  assert.deepEqual([a.N, a.r, a.p, a.keylen], [32768, 8, 1, 64]);
  assert.match(a.salt, /^[0-9a-f]{32}$/);
  assert.match(a.hash, /^[0-9a-f]{128}$/);
  assert.equal(auth.MAXMEM, 64 * 1024 * 1024);
  assert.ok(!JSON.stringify(a).includes(PASSWORD));
  assert.equal(auth.verifyPassword(PASSWORD, a), true);
  assert.equal(auth.verifyPassword('wrong', a), false);
  assert.equal(auth.verifyPassword('', a), false);
  const expected = crypto.scryptSync(PASSWORD, Buffer.from(a.salt, 'hex'), 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  assert.equal(expected.toString('hex'), a.hash);
  const k1 = auth.deriveKey(PASSWORD, auth.newSalt());
  assert.equal(k1.length, 32);
  assert.notDeepEqual(k1, auth.deriveKey(PASSWORD, auth.newSalt()));
});

test('password rule: non-empty and at most 1024 characters, nothing else', () => {
  assert.throws(() => auth.validatePassword(''), { code: 'BAD_PASSWORD' });
  assert.throws(() => auth.validatePassword(undefined), { code: 'BAD_PASSWORD' });
  assert.throws(() => auth.validatePassword('x'.repeat(1025)), { code: 'BAD_PASSWORD' });
  assert.equal(auth.validatePassword('x'.repeat(1024)).length, 1024);
  assert.equal(auth.validatePassword('a'), 'a');
});

test('rate limit: 5 failures -> 60 s lockout, doubling per further lockout, capped at 15 min; success resets', () => {
  let t = 1_000_000;
  auth._setNow(() => t);
  try {
    for (let i = 0; i < 4; i++) assert.equal(auth.recordFailure('rl').limited, false);
    let r = auth.recordFailure('rl');
    assert.deepEqual(r, { limited: true, retryAfter: 60 });
    t += 59_000; assert.equal(auth.checkRateLimit('rl').limited, true);
    t += 1_000; assert.equal(auth.checkRateLimit('rl').limited, false);
    const seen = [];
    for (let lockout = 0; lockout < 6; lockout++) {
      for (let i = 0; i < 5; i++) r = auth.recordFailure('rl');
      seen.push(r.retryAfter);
      t += r.retryAfter * 1000;
    }
    assert.deepEqual(seen, [120, 240, 480, 900, 900, 900]);
    assert.equal(auth.checkRateLimit('other').limited, false, 'per profile');
    for (let i = 0; i < 5; i++) auth.recordFailure('rl');
    auth.resetFailures('rl');
    assert.equal(auth.checkRateLimit('rl').limited, false);
  } finally { auth._setNow(null); auth._reset(); }
});

test('cookie flags and sessions: HttpOnly, SameSite=Strict, Path=/; sliding idle expiry via JDFC_IDLE_MS', () => {
  const c = auth.cookieHeader('p1', 'ab');
  assert.equal(c, 'jdfc_p1=ab; HttpOnly; SameSite=Strict; Path=/');
  assert.ok(!/Max-Age|Secure|Expires/i.test(c));
  assert.match(auth.clearCookieHeader('p1'), /^jdfc_p1=; HttpOnly; SameSite=Strict; Path=\/; Max-Age=0$/);

  let t = 5_000_000;
  auth._setNow(() => t);
  const prevIdle = process.env.JDFC_IDLE_MS;
  process.env.JDFC_IDLE_MS = '1000';
  const expired = [];
  auth.onExpire((id) => { if (id === 'p1') expired.push(id); });
  try {
    const token = auth.createSession('p1');
    assert.match(token, /^[0-9a-f]{64}$/);
    const req = { headers: { cookie: `other=1; jdfc_p1=${token}` } };
    assert.ok(auth.sessionFor(req, 'p1'));
    assert.equal(auth.sessionFor(req, 'p2'), null, 'cookie of p1 does not open p2');
    assert.equal(auth.sessionFor({ headers: { cookie: 'jdfc_p1=' + 'f'.repeat(64) } }, 'p1'), null);
    t += 999; assert.ok(auth.sessionFor(req, 'p1'), 'sliding');
    t += 999; assert.ok(auth.sessionFor(req, 'p1'), 'sliding again');
    t += 1000; assert.equal(auth.sessionFor(req, 'p1'), null, 'idle -> expired');
    assert.deepEqual(expired, ['p1']);
    assert.equal(auth.sessionFor(req, 'p1'), null, 'stays expired');
    const t2 = auth.createSession('p1');
    t += 5000; auth.sweep();
    assert.equal(auth.sessionFor({ headers: { cookie: `jdfc_p1=${t2}` } }, 'p1'), null, 'sweep drops idle sessions');
  } finally {
    if (prevIdle === undefined) delete process.env.JDFC_IDLE_MS; else process.env.JDFC_IDLE_MS = prevIdle;
    auth._setNow(null); auth._reset();
  }
});

// ---------------------------------------------------------------- storage: encryption at rest, change, reset

test('setPassword encrypts every tool-owned file; locked reads/writes throw PROFILE_LOCKED; wrong key fails', () => {
  const root = seed('vault');
  const plain = {};
  for (const f of profiles.toolOwnedFiles(root)) plain[f] = jsonFragments(fs.readFileSync(f));
  assert.ok(Object.values(plain).some((x) => x.length), 'the plaintext has JSON fragments to look for');
  const r = profiles.setPassword('vault', { next: PASSWORD });
  assert.equal(r.files, profiles.toolOwnedFiles(root).length);
  assertEncrypted(root, plain);
  const meta = profiles.readMeta('vault');
  assert.equal(meta.protected, true);
  assert.ok(meta.auth.hash && meta.enc.salt && meta.enc.salt !== meta.auth.salt);
  assert.ok(!fs.readFileSync(path.join(root, 'profile.meta.json'), 'utf8').includes(PASSWORD));
  assert.ok(!profiles.toolOwnedFiles(root).some((f) => f.endsWith('profile.meta.json')));

  // The setter stays unlocked in-process: the config loads and decrypts.
  assert.equal(loadConfig({ profile: 'vault' }).profile.employer, `${MARKER} ${DENY}`);
  const appsFile = path.join(root, 'data', 'applications.json');
  storeIo.writeJson(appsFile, [{ company: `${MARKER} Two` }]);
  assert.ok(fs.readFileSync(appsFile).subarray(0, 8).equals(storeIo.MAGIC), 'writes stay encrypted');
  assert.equal(storeIo.readJson(appsFile)[0].company, `${MARKER} Two`);

  profiles.lock('vault');
  assert.throws(() => storeIo.readJson(appsFile), { code: 'PROFILE_LOCKED' });
  assert.throws(() => storeIo.writeJson(appsFile, []), { code: 'PROFILE_LOCKED' });
  assert.throws(() => loadConfig({ profile: 'vault' }), { code: 'PROFILE_LOCKED' });

  storeIo.setKey(root, crypto.randomBytes(32));
  assert.throws(() => storeIo.readJson(appsFile), { code: 'DECRYPT_FAILED' });
  storeIo.clearKey(root);
  // A file moved to another path does not authenticate (AAD binds profile id + relative path).
  assert.equal(profiles.unlock('vault', 'nope'), false);
  assert.equal(profiles.unlock('vault', PASSWORD), true);
  const moved = path.join(root, 'data', 'moved.json');
  fs.copyFileSync(appsFile, moved);
  assert.throws(() => storeIo.readJson(moved), { code: 'DECRYPT_FAILED' });
  fs.rmSync(moved);
  profiles.lock('vault');
});

test('password change re-encrypts with a new salt: bytes differ, old password fails, new works', () => {
  const root = profiles.profileRoot('vault');
  assert.throws(() => profiles.setPassword('vault', { current: 'wrong', next: NEW_PASSWORD }), { code: 'WRONG_PASSWORD', statusCode: 401 });
  const before = Object.fromEntries(profiles.toolOwnedFiles(root).map((f) => [f, fs.readFileSync(f)]));
  const saltBefore = profiles.readMeta('vault').enc.salt;
  profiles.setPassword('vault', { current: PASSWORD, next: NEW_PASSWORD });
  profiles.lock('vault');
  assert.notEqual(profiles.readMeta('vault').enc.salt, saltBefore);
  for (const [f, b] of Object.entries(before)) {
    const now = fs.readFileSync(f);
    assert.ok(now.subarray(0, 8).equals(storeIo.MAGIC));
    assert.ok(!now.equals(b), `${path.basename(f)} re-encrypted`);
  }
  assert.equal(fs.readdirSync(path.join(root, 'data')).filter((n) => n.endsWith('.tmp')).length, 0, 'no temp files left');
  assert.equal(profiles.unlock('vault', PASSWORD), false);
  assert.equal(profiles.unlock('vault', NEW_PASSWORD), true);
  assert.equal(loadConfig({ profile: 'vault' }).profile.employer, `${MARKER} ${DENY}`);
  profiles.lock('vault');
});

test('reset wipes the encrypted files; the profile loads empty and unprotected; demo cannot be protected', () => {
  const root = profiles.profileRoot('vault');
  profiles.resetProfile('vault');
  const meta = profiles.readMeta('vault');
  assert.equal(meta.protected, false);
  assert.equal(meta.auth, undefined);
  assert.equal(meta.enc, undefined);
  for (const f of walk(root)) {
    const buf = fs.readFileSync(f);
    assert.ok(!buf.subarray(0, 8).equals(storeIo.MAGIC), `${path.relative(root, f)} not encrypted`);
    assert.ok(!buf.includes(MARKER), `${path.relative(root, f)} has no marker`);
  }
  const cfg = loadConfig({ profile: 'vault' });
  assert.equal(cfg.profile.employer, '');
  assert.deepEqual(cfg.profile.evidence, []);
  assert.ok(fs.existsSync(path.join(root, 'resumes', 'Synthetic_Base.docx')), 'resume files are left in place');

  env.install('demo', { seed: 'demo', kind: 'demo', name: 'Demo' });
  assert.throws(() => profiles.setPassword('demo', { next: PASSWORD }), { code: 'DEMO_UNPROTECTED' });
  assert.equal(profiles.readMeta('demo').protected, false);
});

test('reset of a profile with absolute links: linked files untouched, paths.json re-seeded, a kept copy restores the links', () => {
  const ext = path.join(env.home, 'linked-workspace');
  fs.mkdirSync(ext, { recursive: true });
  const docx = path.join(ext, 'Linked_Base.docx');
  const checklist = path.join(ext, 'checklist.md');
  fs.writeFileSync(docx, minimalDocx(['Linked Person', 'Core Skills: SQL']));
  fs.writeFileSync(checklist, '# Checklist\n');
  const before = [docx, checklist].map((f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'));
  const root = env.install('linked', { kind: 'owner', name: 'Linked owner' });
  const pathsFile = path.join(root, 'config', 'paths.json');
  const tailorScript = path.join(ext, 'tailor.ps1');
  fs.writeFileSync(tailorScript, '# synthetic\n');
  const linked = { ...JSON.parse(fs.readFileSync(pathsFile, 'utf8')), resumeDir: ext, checklist, tailorScript, generator: 'tailor-ps1', log: 'checklist' };
  fs.writeFileSync(pathsFile, JSON.stringify(linked, null, 2));
  const keptCopy = path.join(env.home, 'paths.keep.json');
  fs.copyFileSync(pathsFile, keptCopy); // the documented "keep a copy" step
  profiles.setPassword('linked', { next: PASSWORD });
  profiles.lock('linked');

  profiles.resetProfile('linked');
  assert.equal(profiles.readMeta('linked').kind, 'owner');
  const template = JSON.parse(fs.readFileSync(path.join(profiles.SEED_DIR, '_template', 'config', 'paths.json'), 'utf8'));
  assert.deepEqual(JSON.parse(fs.readFileSync(pathsFile, 'utf8')), template, 'paths.json is re-seeded from the template');
  assert.equal(path.resolve(loadConfig({ profile: 'linked' }).paths.resumeDir), path.join(root, 'resumes'));
  assert.deepEqual([docx, checklist].map((f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')), before, 'linked files untouched');

  fs.copyFileSync(keptCopy, pathsFile); // documented restore
  const restored = loadConfig({ profile: 'linked' });
  assert.equal(path.resolve(restored.paths.resumeDir), ext);
  assert.equal(path.resolve(restored.paths.checklist), checklist);
  assert.equal(restored.generator, 'tailor-ps1');
  assert.equal(restored.log, 'checklist');
});

// ---------------------------------------------------------------- HTTP: guard, unlock, lock, change, reset

const { createServer, setPort, ROUTES } = require('../server.cjs');
const profileRoutes = ROUTES.filter((r) => r.scope === 'profile');
let server;
let port;
let clock = Date.now();

function request(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...(data !== null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
        resolve({ status: res.statusCode, json, buf, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}
const fill = (pattern, id) => pattern.replace(':id', id).replace(':job', 'job-none').replace(':file', 'Synthetic_Base.docx');
const call = (r, id, headers) => request(r.method, fill(r.pattern, id), r.method === 'POST' ? {} : undefined, headers);
const cookieOf = (res) => String((res.headers['set-cookie'] || [])[0] || '').split(';')[0];
const unlockReq = (id, password) => request('POST', `/api/profiles/${id}/unlock`, { password });

test('HTTP: locked protected profile -> 423 on every profile route; listing shows only id/name/protected/locked', async () => {
  auth._setNow(() => clock);
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  setPort(port);

  seed('safe');
  profiles.setPassword('safe', { next: PASSWORD });
  profiles.lock('safe');

  const patterns = profileRoutes.map((r) => `${r.method} ${r.pattern}`);
  for (const must of ['GET /p/:id/download/:file', 'GET /api/p/:id/stats', 'GET /api/p/:id/history', 'GET /api/p/:id/repo', 'GET /api/p/:id/evidence', 'GET /api/p/:id/calibration', 'GET /api/p/:id/jobs/:job', 'POST /api/p/:id/generate', 'POST /api/p/:id/password']) {
    assert.ok(patterns.includes(must), must);
  }
  for (const r of profileRoutes) {
    const res = await call(r, 'safe');
    assert.equal(res.status, 423, `${r.method} ${r.pattern}`);
    assert.equal(res.json.code, 'PROFILE_LOCKED');
    assert.ok(!res.buf.includes(MARKER));
  }
  // Another profile's cookie name/value does not open it.
  const foreign = await request('GET', '/api/p/safe/health', undefined, { cookie: `jdfc_vault=${'a'.repeat(64)}; jdfc_safe=${'b'.repeat(64)}` });
  assert.equal(foreign.status, 423);

  const list = await request('GET', '/api/profiles');
  const entry = list.json.profiles.find((p) => p.id === 'safe');
  assert.deepEqual(Object.keys(entry).sort(), ['id', 'locked', 'name', 'protected']);
  assert.deepEqual(entry, { id: 'safe', name: 'Synthetic safe', protected: true, locked: true });
  const open = list.json.profiles.find((p) => p.id === 'vault');
  assert.equal(open.locked, false);
  assert.ok(!list.buf.includes(MARKER));
});

test('HTTP: wrong password 401, 6th attempt 429 with Retry-After; unlock sets the session cookie; routes answer', async () => {
  for (let i = 1; i <= 5; i++) {
    const r = await unlockReq('safe', `wrong-${i}`);
    assert.equal(r.status, 401, `attempt ${i}`);
    assert.equal(r.json.code, 'WRONG_PASSWORD');
  }
  const limited = await unlockReq('safe', PASSWORD);
  assert.equal(limited.status, 429, '6th attempt is rate limited even with the right password');
  assert.equal(limited.headers['retry-after'], '60');
  clock += 60_000;

  const ok = await unlockReq('safe', PASSWORD);
  assert.equal(ok.status, 200);
  const setCookie = ok.headers['set-cookie'][0];
  assert.match(setCookie, /^jdfc_safe=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/$/);
  const cookie = cookieOf(ok);

  for (const r of profileRoutes) {
    const res = await call(r, 'safe', { cookie });
    assert.notEqual(res.status, 423, `${r.method} ${r.pattern} unlocked`);
    assert.ok(res.status < 500, `${r.method} ${r.pattern} -> ${res.status} ${res.buf.toString().slice(0, 200)}`);
  }
  const health = await request('GET', '/api/p/safe/health', undefined, { cookie });
  assert.equal(health.status, 200);
  assert.equal(health.json.resumeCount, 1);
  assert.equal(health.json.checklistEntries, 1, 'decrypted application log');
  const dl = await request('GET', '/p/safe/download/Synthetic_Base.docx', undefined, { cookie });
  assert.equal(dl.status, 200);
  assert.equal(dl.buf.subarray(0, 2).toString(), 'PK');
  const hist = await request('GET', '/api/p/safe/history', undefined, { cookie });
  assert.equal(hist.status, 200);
  const listed = (await request('GET', '/api/profiles', undefined, { cookie })).json.profiles.find((p) => p.id === 'safe');
  assert.equal(listed.locked, false);
  // Everything written while unlocked stays encrypted.
  for (const f of profiles.toolOwnedFiles(profiles.profileRoot('safe'))) assert.ok(fs.readFileSync(f).subarray(0, 8).equals(storeIo.MAGIC), path.basename(f));

  // Idle expiry: the session, the key and the cached context are dropped.
  clock += auth.DEFAULT_IDLE_MS;
  const idle = await request('GET', '/api/p/safe/health', undefined, { cookie });
  assert.equal(idle.status, 423);
  assert.equal(storeIo.hasKey(profiles.profileRoot('safe')), false, 'key dropped on expiry');

  // Unlock again, then Lock -> 423 and the cookie is cleared.
  const again = await unlockReq('safe', PASSWORD);
  assert.equal(again.status, 200);
  const c2 = cookieOf(again);
  assert.equal((await request('GET', '/api/p/safe/stats', undefined, { cookie: c2 })).status, 200);
  const lock = await request('POST', '/api/profiles/safe/lock', {}, { cookie: c2 });
  assert.equal(lock.status, 200);
  assert.match(lock.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal((await request('GET', '/api/p/safe/stats', undefined, { cookie: c2 })).status, 423);
  assert.equal(storeIo.hasKey(profiles.profileRoot('safe')), false);
});

test('HTTP: password change (session required, current verified), first-time set, reset with typed confirmation', async () => {
  const noSession = await request('POST', '/api/p/safe/password', { current: PASSWORD, next: NEW_PASSWORD });
  assert.equal(noSession.status, 423);
  const cookie = cookieOf(await unlockReq('safe', PASSWORD));
  const wrong = await request('POST', '/api/p/safe/password', { current: 'nope', next: NEW_PASSWORD }, { cookie });
  assert.equal(wrong.status, 401);
  const empty = await request('POST', '/api/p/safe/password', { current: PASSWORD, next: '' }, { cookie });
  assert.equal(empty.status, 400);
  const changed = await request('POST', '/api/p/safe/password', { current: PASSWORD, next: NEW_PASSWORD }, { cookie });
  assert.equal(changed.status, 200);
  const c2 = cookieOf(changed);
  assert.equal((await request('GET', '/api/p/safe/health', undefined, { cookie: c2 })).status, 200);
  assert.equal((await request('GET', '/api/p/safe/health', undefined, { cookie })).status, 423, 'old session ended by the change');
  await request('POST', '/api/profiles/safe/lock', {}, { cookie: c2 });
  assert.equal((await unlockReq('safe', PASSWORD)).status, 401);
  assert.equal((await unlockReq('safe', NEW_PASSWORD)).status, 200);

  // First-time set over HTTP on an unprotected profile keeps the caller unlocked; others get 423.
  seed('fresh');
  const set = await request('POST', '/api/p/fresh/password', { next: PASSWORD });
  assert.equal(set.status, 200);
  assert.equal((await request('GET', '/api/p/fresh/health', undefined, { cookie: cookieOf(set) })).status, 200);
  assert.equal((await request('GET', '/api/p/fresh/health')).status, 423);
  assert.equal((await request('POST', '/api/p/demo/password', { next: PASSWORD })).status, 409, 'demo stays unprotected');

  // Reset (forgotten password): typed confirmation; no session needed; profile loads empty and unprotected.
  assert.equal((await request('POST', '/api/profiles/fresh/reset', { confirm: 'nope' })).status, 400);
  const reset = await request('POST', '/api/profiles/fresh/reset', { confirm: 'fresh' });
  assert.equal(reset.status, 200);
  const h = await request('GET', '/api/p/fresh/health');
  assert.equal(h.status, 200);
  assert.equal(h.json.checklistEntries, 0);
  assert.equal((await request('GET', '/api/p/fresh/history')).json.entries.length, 0);
  assert.equal(profiles.readMeta('fresh').protected, false);
  assert.equal((await request('POST', '/api/profiles/demo/reset', { confirm: 'demo' })).status, 409);
});

test('no plaintext password anywhere in the temp store or in the logs', async () => {
  await new Promise((resolve) => server.close(resolve));
  auth._setNow(null);
  for (const pw of [PASSWORD, NEW_PASSWORD]) {
    const needles = [Buffer.from(pw, 'utf8'), Buffer.from(pw, 'utf16le')];
    for (const f of walk(env.home)) {
      const buf = fs.readFileSync(f);
      for (const n of needles) assert.ok(!buf.includes(n), `${path.relative(env.home, f)} contains a password`);
    }
    assert.ok(!logs.some((l) => l.includes(pw)), 'logs contain a password');
  }
  env.cleanup();
});
