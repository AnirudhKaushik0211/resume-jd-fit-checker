'use strict';

// Runs a profile's own test suite (<profile>\tests\*.test.cjs) against this tool folder.
// Usage: node scripts\test-profile.cjs <id>
// Env passed to the suite: JDFC_PROFILE=<id>, JDFC_TOOL_DIR=<tool folder> (and JDFC_HOME / JDFC_PASSWORD if set).

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const profiles = require('../lib/profiles.cjs');

function runProfileSuite(id, { stdio = 'pipe' } = {}) {
  const root = profiles.profileRoot(id);
  const testsDir = path.join(root, 'tests');
  if (!fs.existsSync(testsDir)) return { skipped: true, reason: `profile "${id}" has no tests folder` };
  const files = fs.readdirSync(testsDir).filter((f) => f.endsWith('.test.cjs')).sort().map((f) => path.join(testsDir, f));
  const env = { ...process.env, JDFC_PROFILE: id, JDFC_TOOL_DIR: profiles.TOOL_DIR };
  delete env.NODE_TEST_CONTEXT; // a nested `node --test` inside a test run must not report into the parent runner
  // Protected profile: every test process unlocks it from JDFC_PASSWORD (scripts\unlock-env.cjs).
  const preload = env.JDFC_PASSWORD ? ['--require', path.join(__dirname, 'unlock-env.cjs')] : [];
  const r = spawnSync(process.execPath, [...preload, '--test', '--test-reporter=tap', ...files], { cwd: testsDir, env, encoding: 'utf8', stdio, maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60 * 1000 });
  const out = `${r.stdout || ''}`;
  const num = (k) => { const m = out.match(new RegExp(`^# ${k} (\\d+)`, 'm')); return m ? Number(m[1]) : null; };
  return { skipped: false, code: r.status, tests: num('tests'), pass: num('pass'), fail: num('fail'), cancelled: num('cancelled'), skippedTests: num('skipped'), stdout: out, stderr: `${r.stderr || ''}` };
}

if (require.main === module) {
  const id = process.argv[2];
  if (!id) { console.error('Usage: node scripts\\test-profile.cjs <profile-id>'); process.exit(2); }
  profiles.assertId(id);
  const r = runProfileSuite(id);
  if (r.skipped) { console.log(`Skipped: ${r.reason}.`); process.exit(0); }
  const failing = (r.stdout.match(/^not ok .+$/gm) || []);
  for (const f of failing) console.log(f);
  if (r.fail) console.log(r.stdout.split(/\r?\n/).filter((l) => /^\s+(error|expected|actual|message):/.test(l)).slice(0, 40).join('\n'));
  console.log(`Profile "${id}" suite: ${r.tests} tests, ${r.pass} pass, ${r.fail} fail (exit ${r.code}).`);
  process.exitCode = r.code === 0 && r.fail === 0 ? 0 : 1;
}

module.exports = { runProfileSuite };
