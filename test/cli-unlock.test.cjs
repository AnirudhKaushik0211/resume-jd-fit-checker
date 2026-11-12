'use strict';

// CLI scripts and a profile's own suite on a PROTECTED profile: they unlock from JDFC_PASSWORD and stop with a clear
// message (no stack trace) when it is missing or wrong. Temp JDFC_HOME only; the real owner profile is never touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempHome } = require('./helpers.cjs');

const env = tempHome();
const profiles = require('../lib/profiles.cjs');
const { runProfileSuite } = require('../scripts/test-profile.cjs');

const TOOL = profiles.TOOL_DIR;
const ID = 'locked-cli';
const PASSWORD = 'cli pw \u2713 one';

test.after(() => env.cleanup());

// Synthetic profile from the demo seed (fixtures + resumes) with a tiny suite: one file goes through the generated
// helpers, one calls loadConfig() directly (as some relocated owner tests do).
const root = env.install(ID, { seed: 'demo', name: 'CLI unlock' });
const testsDir = path.join(root, 'tests');
fs.mkdirSync(testsDir, { recursive: true });
fs.writeFileSync(path.join(testsDir, '_tool.cjs'), `'use strict';\nmodule.exports = process.env.JDFC_TOOL_DIR || ${JSON.stringify(TOOL)};\n`);
fs.copyFileSync(path.join(TOOL, 'scripts', 'templates', 'profile-test-helpers.cjs'), path.join(testsDir, 'helpers.cjs'));
fs.writeFileSync(path.join(testsDir, 'helpers-path.test.cjs'), [
  "'use strict';",
  "const test = require('node:test');",
  "const assert = require('node:assert/strict');",
  "const { getConfig, loadFixtures } = require('./helpers.cjs');",
  "test('config and fixtures load through the helpers', () => { assert.ok(getConfig().profile); assert.ok(loadFixtures().length > 0); });",
  ''
].join('\n'));
fs.writeFileSync(path.join(testsDir, 'direct.test.cjs'), [
  "'use strict';",
  "const test = require('node:test');",
  "const assert = require('node:assert/strict');",
  "const { loadConfig } = require(require('path').join(require('./_tool.cjs'), 'lib', 'config.cjs'));",
  "test('loadConfig() reads the profile directly', () => { assert.ok(loadConfig().rules); });",
  ''
].join('\n'));

function run(script, args, extraEnv = {}) {
  const e = { ...process.env, JDFC_HOME: env.home, ...extraEnv };
  delete e.NODE_TEST_CONTEXT;
  delete e.JDFC_PROFILE;
  for (const [k, v] of Object.entries(extraEnv)) if (v === undefined) delete e[k];
  return spawnSync(process.execPath, [path.join(TOOL, 'scripts', script), ...args], { cwd: TOOL, env: e, encoding: 'utf8', timeout: 120000 });
}

function suite(password) {
  const prev = process.env.JDFC_PASSWORD;
  if (password === undefined) delete process.env.JDFC_PASSWORD; else process.env.JDFC_PASSWORD = password;
  try { return runProfileSuite(ID); } finally { if (prev === undefined) delete process.env.JDFC_PASSWORD; else process.env.JDFC_PASSWORD = prev; }
}

const plain = {};

test('unprotected baseline: calibrate, hash-inputs and the profile suite run', () => {
  plain.calibrate = run('calibrate.cjs', ['--profile', ID], { JDFC_PASSWORD: undefined });
  plain.hashes = run('hash-inputs.cjs', ['--profile', ID], { JDFC_PASSWORD: undefined });
  assert.match(plain.calibrate.stdout, /fixtures pass the per-fixture checks/);
  assert.equal(plain.hashes.status, 0, plain.hashes.stderr);
  const r = suite(undefined);
  assert.equal(r.fail, 0, r.stdout);
  assert.equal(r.pass, 2);
});

test('protected + JDFC_PASSWORD: same calibration and hashes, suite passes (helpers and direct loadConfig)', () => {
  profiles.setPassword(ID, { next: PASSWORD });
  profiles.lock(ID);
  assert.equal(profiles.readMeta(ID).protected, true);
  const cal = run('calibrate.cjs', ['--profile', ID], { JDFC_PASSWORD: PASSWORD });
  assert.equal(cal.status, plain.calibrate.status, cal.stderr);
  assert.equal(cal.stdout, plain.calibrate.stdout);
  const hashes = run('hash-inputs.cjs', ['--profile', ID], { JDFC_PASSWORD: PASSWORD });
  assert.equal(hashes.status, 0, hashes.stderr);
  assert.equal(hashes.stdout, plain.hashes.stdout);
  const ex = run('explain.cjs', ['--profile', ID], { JDFC_PASSWORD: PASSWORD });
  assert.equal(ex.status, 0, ex.stderr);
  const r = suite(PASSWORD);
  assert.equal(r.fail, 0, r.stdout);
  assert.equal(r.pass, 2);
  assert.equal(r.code, 0, r.stderr);
});

test('protected without or with a wrong JDFC_PASSWORD: scripts stop with a clear message, suite fails cleanly', () => {
  for (const [pw, re] of [[undefined, /password protected: set JDFC_PASSWORD/], ['wrong password', /JDFC_PASSWORD is not the password/]]) {
    for (const script of ['calibrate.cjs', 'hash-inputs.cjs', 'explain.cjs']) {
      const r = run(script, ['--profile', ID], { JDFC_PASSWORD: pw });
      assert.equal(r.status, 1, `${script} exit code`);
      assert.match(r.stderr, re, `${script}: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /^\s+at /m, `${script} prints no stack trace`);
      assert.equal(r.stdout, '', `${script} prints no results`);
    }
    const s = suite(pw);
    assert.ok(s.fail > 0 || s.code !== 0, 'suite does not pass while locked');
    assert.ok(!s.pass, `no suite test passes while locked (pass ${s.pass})`);
    assert.match(s.stdout + s.stderr, re);
  }
  assert.equal(profiles.readMeta(ID).protected, true, 'still protected');
});
