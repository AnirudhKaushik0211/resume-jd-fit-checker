'use strict';

// Prints the calibration table (strict score vs historical estimate, verdicts at T and at T=55). Read-only.
// Usage (from jd-fit-checker): node scripts\calibrate.cjs [--profile <id>] [--threshold 75] [--verbose]
// Profile: --profile, else JDFC_PROFILE, else demo. Fixtures come from the profile's fixturesDir.

const { loadConfig } = require('../lib/config.cjs');
const { buildContext } = require('../lib/analyze.cjs');
const { runCalibration, checkRankOrder, formatTable } = require('../lib/calibration.cjs');
const { profileFromArgv, ensureDemo, DEMO_ID } = require('../lib/profiles.cjs');

const profile = profileFromArgv();
if (profile === DEMO_ID) ensureDemo(); // the demo is installed from the seed when missing (as at server start)
const ti = process.argv.indexOf('--threshold');
const threshold = ti > 0 ? Number(process.argv[ti + 1]) : undefined;
const ctx = buildContext(loadConfig({ profile }), { persistRepo: false });
ctx.historyFile = null;
const rows = runCalibration(ctx, { threshold });
console.log(formatTable(rows));
const rank = checkRankOrder(rows);
console.log(`\nRank order: ${rank.ok ? 'preserved' : 'VIOLATED'} ${rank.groups.map((g) => `[G${g.group}: ${g.fixtures.join(', ')}]`).join(' > ')}`);
for (const v of rank.violations) console.log(`  ${v}`);
if (process.argv.includes('--verbose')) {
  for (const r of rows) console.log(`\n${r.fixture}: @T=${r.strict.threshold} ${r.strict.reason}\n  @T=55 ${r.atT55.reason}\n  checks ${JSON.stringify(r.checks)} ${r.flagFails.join('; ')}`);
}
const failed = rows.filter((r) => !r.pass).length;
console.log(`\n${rows.length - failed}/${rows.length} fixtures pass the per-fixture checks.`);
process.exitCode = failed || !rank.ok || !rows.length ? 1 : 0;
