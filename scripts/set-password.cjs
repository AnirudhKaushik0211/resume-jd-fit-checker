'use strict';

// Sets or changes the password of one profile (encrypts its tool-owned JSON files at rest).
// Usage (from jd-fit-checker): node scripts\set-password.cjs <profile-id>
// Prompts are hidden (nothing is echoed). Asks the current password when the profile is already protected,
// then the new one twice. The password itself is never printed, logged or stored (only an scrypt hash).
// Restart a running server afterwards so it picks up the change.

const fs = require('fs');
const path = require('path');
const profiles = require('../lib/profiles.cjs');

// Piped stdin (automation): one password per line. TTY: raw mode, no echo.
let pipedLines = null;
async function readPiped() {
  if (pipedLines) return pipedLines;
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  pipedLines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  return pipedLines;
}

async function ask(question) {
  process.stdout.write(question);
  if (!process.stdin.isTTY) {
    const lines = await readPiped();
    process.stdout.write('\n');
    return lines.length ? lines.shift() : '';
  }
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let buf = '';
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    const done = (fn) => { stdin.removeListener('data', onData); stdin.setRawMode(false); stdin.pause(); process.stdout.write('\n'); fn(); };
    const onData = (s) => {
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') return done(() => resolve(buf));
        if (ch === '\u0003') return done(() => reject(Object.assign(new Error('Cancelled.'), { code: 'CANCELLED' })));
        if (ch === '\u007f' || ch === '\b') { buf = buf.slice(0, -1); continue; }
        buf += ch;
      }
      return undefined;
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const pi = args.indexOf('--profile');
  const id = pi >= 0 ? args[pi + 1] : args.find((a) => !a.startsWith('--'));
  if (!id) { console.error('Usage: node scripts\\set-password.cjs <profile-id>'); return 2; }
  profiles.assertId(id);
  if (!profiles.profileExists(id)) { console.error(`Profile "${id}" not found in ${profiles.profilesDir()}.`); return 2; }
  const meta = profiles.readMeta(id);
  if (meta.kind === 'demo') { console.error('The demo profile cannot be password protected.'); return 2; }

  console.log(`${meta.protected ? 'Changing' : 'Setting'} the password of profile "${id}" (${profiles.profileRoot(id)}).`);
  console.log('There is no recovery: a forgotten password means the encrypted data is lost ("Reset profile" wipes it).');
  const current = meta.protected ? await ask('Current password: ') : undefined;
  const next = await ask('New password: ');
  const confirm = await ask('Confirm new password: ');
  if (next !== confirm) { console.error('The two new passwords do not match. Nothing changed.'); return 1; }
  try {
    const r = profiles.setPassword(id, { current, next });
    console.log(`Done: ${r.files} file(s) under config\\, data\\ and fixtures\\ are encrypted.`);
  } catch (error) {
    console.error(`Not changed: ${error.message}`);
    return 1;
  }
  const root = profiles.profileRoot(id);
  const plain = ['_pre_profiles_backup', 'tests', 'resumes', 'tailor-runs', 'reports'].filter((d) => fs.existsSync(path.join(root, d)));
  if (plain.length) console.log(`Note: these folders in the profile are NOT encrypted: ${plain.join(', ')}. Linked files outside the profile (resume folder, checklist, base map) are not encrypted either.`);
  console.log('Restart the server if it is running, then unlock the profile in the UI.');
  return 0;
}

main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.code === 'CANCELLED' ? 'Cancelled. Nothing changed.' : `Error: ${error.message}`); process.exitCode = 1; });
