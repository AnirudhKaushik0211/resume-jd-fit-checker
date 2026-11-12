'use strict';

// Prints SHA-256 of every read-only input (resumes, base map, checklist). Run before/after to prove they are untouched.
// Usage: node scripts\hash-inputs.cjs [--profile <id>]   (default JDFC_PROFILE, else demo; null base map / checklist are skipped)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadConfig } = require('../lib/config.cjs');
const { listResumeFiles } = require('../lib/resumes.cjs');
const { profileFromArgv } = require('../lib/profiles.cjs');

const c = loadConfig({ profile: profileFromArgv() });
const files = [...listResumeFiles(c.paths.resumeDir, c.paths.resumeFilePrefix), c.paths.baseMap, c.paths.checklist].filter(Boolean);
for (const f of files) {
  const h = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  console.log(`${h}  ${path.basename(f)}`);
}
