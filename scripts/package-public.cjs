'use strict';

// Builds the public (shareable) copy of the tool: an allow-list copy plus a forward-slash .zip.
// Usage (from jd-fit-checker): node scripts\package-public.cjs [--out <dir>]
//   default <TOOL>\dist\jd-fit-checker-public\ and <TOOL>\dist\jd-fit-checker-public.zip (zip = <out>.zip)
// Ships: server.cjs, index.html, README.md, lib\**, defaults\**, profiles-seed\** (demo + _template), test\** (generic),
// scripts\*.cjs except migrate-owner.cjs and e2e-generate.cjs (owner workflow); never scripts\templates\**.
// Refuses (exit 1, output removed) on: any deny-list hit, any file byte-identical to a file in a non-demo profile store
// (under jdfcHome() and the default home), any path segment _pre_profiles_backup / config / data (outside
// profiles-seed) / dist / tests, or a zip entry name with a backslash. Exception: the few generic tool files listed in
// KNOWN_GENERIC, which the owner migration copied into the store on purpose. Personal data never leaves the profile store.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { scanTree } = require('../lib/denylist.cjs');
const { writeZip } = require('../lib/docx-write.cjs');
const { listZipEntries } = require('../lib/docx.cjs');
const { jdfcHome, TOOL_DIR, SEED_DIR } = require('../lib/profiles.cjs');

const ROOT_FILES = ['server.cjs', 'index.html', 'README.md'];
const TREES = ['lib', 'defaults', 'profiles-seed', 'test'];
const SCRIPT_EXCLUDE = new Set(['migrate-owner.cjs', 'e2e-generate.cjs']);
const BAD_SEGMENTS = ['_pre_profiles_backup', 'dist', 'tests'];
const SEED_ONLY_SEGMENTS = ['config', 'data'];

// Generic tool files that the owner migration copied INTO the store on purpose (rules.json = defaults verbatim by
// design; the generic url test and its html fixtures sit in the owner's backup/tests). A store match on exactly these
// paths is reported as allowed; a match on any other shipped file refuses the package.
const KNOWN_GENERIC = [/^defaults\/rules\.json$/, /^test\/url\.test\.cjs$/, /^test\/fixtures\/html\/[^/]+\.html$/];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function walkFiles(dir, base = dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...walkFiles(full, base));
    else if (d.isFile()) out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out;
}

// Relative (forward-slash) paths of everything the package ships, from the allow-list.
function allowList(tool = TOOL_DIR) {
  const files = ROOT_FILES.filter((f) => fs.existsSync(path.join(tool, f)));
  for (const t of TREES) files.push(...walkFiles(path.join(tool, t)).map((f) => `${t}/${f}`));
  const scripts = path.join(tool, 'scripts');
  if (fs.existsSync(scripts)) {
    for (const d of fs.readdirSync(scripts, { withFileTypes: true })) {
      if (d.isFile() && d.name.endsWith('.cjs') && !SCRIPT_EXCLUDE.has(d.name)) files.push(`scripts/${d.name}`);
    }
  }
  return files.sort();
}

function segmentProblems(rel) {
  const segs = rel.split('/');
  const problems = [];
  for (const s of BAD_SEGMENTS) if (segs.includes(s)) problems.push(`${rel}: path segment '${s}'`);
  if (segs[0] !== 'profiles-seed') for (const s of SEED_ONLY_SEGMENTS) if (segs.includes(s)) problems.push(`${rel}: path segment '${s}' outside profiles-seed`);
  if (segs[0] === 'scripts' && segs.length > 2) problems.push(`${rel}: nested scripts folder`);
  return problems;
}

// sha256 -> store file, for every file in every non-demo profile under the given homes. Files that are byte copies
// of the shipped empty template (profiles-seed\_template, e.g. "[]") are generic and not counted.
function storeHashes(homes) {
  const generic = new Set(walkFiles(path.join(SEED_DIR, '_template')).map((f) => sha256(fs.readFileSync(path.join(SEED_DIR, '_template', f)))));
  const map = new Map();
  const seen = new Set();
  for (const home of homes) {
    const dir = path.join(path.resolve(home), 'profiles');
    if (seen.has(dir) || !fs.existsSync(dir)) continue;
    seen.add(dir);
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const root = path.join(dir, d.name);
      let kind = null;
      try { kind = JSON.parse(fs.readFileSync(path.join(root, 'profile.meta.json'), 'utf8').replace(/^\uFEFF/, '')).kind; } catch { /* unreadable meta: treat as personal */ }
      if (kind === 'demo') continue;
      for (const rel of walkFiles(root)) {
        const h = sha256(fs.readFileSync(path.join(root, rel)));
        if (!generic.has(h) && !map.has(h)) map.set(h, `${d.name}/${rel}`);
      }
    }
  }
  return map;
}

function packagePublic({ out, tool = TOOL_DIR, homes } = {}) {
  out = path.resolve(out || path.join(tool, 'dist', 'jd-fit-checker-public'));
  const zipPath = `${out}.zip`;
  if (out === path.resolve(tool) || path.resolve(tool).startsWith(out + path.sep)) throw new Error(`--out must not contain the tool folder: ${out}`);
  if (fs.existsSync(out)) {
    // Only ever replace a previous package (recognised by its server.cjs + lib), never an arbitrary folder.
    const prev = fs.readdirSync(out);
    if (prev.length && !(prev.includes('server.cjs') && prev.includes('lib'))) throw new Error(`--out exists and is not a previous package: ${out}`);
    fs.rmSync(out, { recursive: true, force: true });
  }
  fs.rmSync(zipPath, { force: true });

  const files = allowList(tool);
  const problems = files.flatMap(segmentProblems);
  fs.mkdirSync(out, { recursive: true });
  for (const rel of files) {
    const dst = path.join(out, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(tool, ...rel.split('/')), dst);
  }

  const denyHits = scanTree(out);
  const homeList = homes || [jdfcHome(), path.join(os.homedir(), '.jd-fit-checker')];
  const store = storeHashes(homeList);
  const hashHits = [];
  const allowedMatches = [];
  for (const rel of files) {
    const h = sha256(fs.readFileSync(path.join(out, ...rel.split('/'))));
    if (!store.has(h)) continue;
    (KNOWN_GENERIC.some((re) => re.test(rel)) ? allowedMatches : hashHits).push(`${rel} == store ${store.get(h)}`);
  }

  let zipEntries = [];
  let zipHits = [];
  if (!problems.length && !denyHits.length && !hashHits.length) {
    const prefix = path.basename(out);
    const zip = writeZip(files.map((rel) => ({ name: `${prefix}/${rel}`, data: fs.readFileSync(path.join(out, ...rel.split('/'))) })));
    fs.writeFileSync(zipPath, zip);
    zipEntries = listZipEntries(fs.readFileSync(zipPath)).map((e) => e.name);
    for (const n of zipEntries) if (n.includes('\\')) problems.push(`zip entry with a backslash: ${n}`);
    if (zipEntries.length !== files.length) problems.push(`zip has ${zipEntries.length} entries, expected ${files.length}`);
    zipHits = scanTree(path.dirname(zipPath), { exclude: walkDirNames(path.dirname(zipPath), path.basename(zipPath)) });
  }

  const ok = !problems.length && !denyHits.length && !hashHits.length && !zipHits.length;
  if (!ok) { fs.rmSync(out, { recursive: true, force: true }); fs.rmSync(zipPath, { force: true }); }
  return { ok, out, zipPath: ok ? zipPath : null, files, zipEntries, problems, denyHits: [...denyHits, ...zipHits], hashHits, allowedMatches, storeFiles: store.size, homes: [...new Set(homeList.map((h) => path.resolve(h)))] };
}

// Every entry of dir except `keep` (so the zip is scanned on its own, not its siblings).
function walkDirNames(dir, keep) { return fs.readdirSync(dir).filter((n) => n !== keep); }

if (require.main === module) {
  const oi = process.argv.indexOf('--out');
  const out = oi > 0 ? process.argv[oi + 1] : undefined;
  try {
    const r = packagePublic({ out });
    console.log(`Allow-listed files: ${r.files.length}`);
    console.log(`Path-segment / zip problems: ${r.problems.length}`);
    for (const p of r.problems) console.log(`  ${p}`);
    // Never print the matched term itself (it is personal data); file + line + length is enough to find it.
    console.log(`Deny-list hits: ${r.denyHits.length}`);
    for (const h of r.denyHits) console.log(`  ${h.file}:${h.line} [${h.term.length} chars]`);
    console.log(`Owner-store hash matches: ${r.hashHits.length} (compared against ${r.storeFiles} store files under ${r.homes.join(', ')})`);
    for (const h of r.hashHits) console.log(`  ${h}`);
    if (r.allowedMatches.length) console.log(`Allowed generic matches (tool files deliberately copied into the store): ${r.allowedMatches.length}`);
    for (const h of r.allowedMatches) console.log(`  ${h}`);
    if (r.ok) {
      console.log(`Zip entries: ${r.zipEntries.length}, backslashes: 0`);
      console.log(`OK: ${r.out}`);
      console.log(`OK: ${r.zipPath}`);
    } else console.log('REFUSED: package removed.');
    process.exitCode = r.ok ? 0 : 1;
  } catch (error) {
    console.error(`REFUSED: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { packagePublic, allowList, segmentProblems, storeHashes };
