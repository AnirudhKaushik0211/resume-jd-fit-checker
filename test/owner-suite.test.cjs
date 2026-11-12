'use strict';

// Wrapper: runs the test suite stored inside each profile that has one (<profile>\tests\, e.g. the owner's
// relocated suite, which contains personal data and therefore never lives in the tool folder).
// No such profile on this machine (fresh install, empty JDFC_HOME) -> skipped.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const profiles = require('../lib/profiles.cjs');
const { runProfileSuite } = require('../scripts/test-profile.cjs');

const withSuites = profiles.listProfiles().filter((p) => fs.existsSync(path.join(profiles.profileRoot(p.id), 'tests')));

if (!withSuites.length) {
  test.skip('profile test suites (no profile with a tests folder on this machine)', () => {});
}

for (const p of withSuites) {
  if (p.protected && !process.env.JDFC_PASSWORD) {
    test.skip(`profile "${p.id}" suite (protected; set JDFC_PASSWORD to run it)`, () => {});
    continue;
  }
  test(`profile "${p.id}" suite passes`, { timeout: 10 * 60 * 1000 }, () => {
    const r = runProfileSuite(p.id);
    assert.equal(r.skipped, false);
    assert.equal(r.fail, 0, `${r.fail} failing test(s) in profile "${p.id}":\n${(r.stdout.match(/^not ok .+$/gm) || []).join('\n')}`);
    assert.equal(r.code, 0, r.stderr.slice(-2000));
    assert.ok(r.pass > 0, 'no tests ran');
  });
}
