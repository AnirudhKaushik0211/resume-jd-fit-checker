'use strict';

// Prints the fit breakdown, gates and keyword statuses for one fixture (debug aid). Read-only.
// Usage: node scripts\explain.cjs [<fixture-id>] [--profile <id>]   (default JDFC_PROFILE, else demo)

const { loadConfig } = require('../lib/config.cjs');
const { buildContext, analyze } = require('../lib/analyze.cjs');
const { loadFixtures } = require('../lib/calibration.cjs');
const { profileFromArgv } = require('../lib/profiles.cjs');

const profile = profileFromArgv();
const args = process.argv.slice(2).filter((a, i, all) => a !== '--profile' && all[i - 1] !== '--profile');
const id = args[0];
const config = loadConfig({ profile });
const ctx = buildContext(config, { persistRepo: false });
ctx.historyFile = null;
for (const fx of loadFixtures(config.paths.fixturesDir).filter((f) => !id || f.id === id)) {
  const r = analyze({ jdText: fx.text, company: fx.company, title: fx.title }, ctx, { ignoreHistory: true, saveHistory: false });
  console.log(`\n=== ${fx.id}: fit ${r.fit.score} (expected ${fx.expected.fit}) verdict ${r.verdict.key} base ${r.bases.recommended}`);
  for (const b of r.fit.breakdown) console.log(`  ${b.component.padEnd(38)} w=${b.weight} s=${b.score01} pts=${b.points}  ${b.why}`);
  for (const p of r.fit.penalties) console.log(`  penalty ${p.points}: ${p.reason}`);
  console.log(`  direction: ${r.direction.why}\n  level: ${r.level.class} ${r.level.why} ${r.level.notes.join(' ')}`);
  for (const g of r.gates) console.log(`  gate ${g.category}/${g.required ? 'req' : 'pref'} ${g.status}: ${g.requirement.slice(0, 70)}`);
  console.log('  keywords: ' + r.keywords.jd.map((k) => `${k.id}[${k.section[0]}${k.mustHave ? '!' : ''}]=${k.status[0]}`).join(' '));
  console.log('  tailor: ' + JSON.stringify(r.tailor.replacements) + ' opt: ' + JSON.stringify(r.tailor.optionalReplacements));
}
