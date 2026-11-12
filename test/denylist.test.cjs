'use strict';

// The tool folder must contain no owner-identifying strings (personal data lives only in the profile store).
// Terms come from lib\denylist.cjs at runtime, so this file holds no literal deny-listed text.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, minimalDocx, storedZip } = require('./helpers.cjs');
const { terms, scanTree } = require('../lib/denylist.cjs');

const TOOL = path.resolve(__dirname, '..');

test('tool folder has zero deny-list hits and no _pre_profiles_backup folder', () => {
  const hits = scanTree(TOOL);
  assert.deepEqual(hits, [], `deny-list hits:\n${hits.map((h) => `${h.file}:${h.line} [${h.term.length} chars]`).join('\n')}`);
  const backups = [];
  const walk = (dir) => { for (const d of fs.readdirSync(dir, { withFileTypes: true })) { if (!d.isDirectory()) continue; if (d.name === '_pre_profiles_backup') backups.push(path.join(dir, d.name)); else walk(path.join(dir, d.name)); } };
  walk(TOOL);
  assert.deepEqual(backups, []);
  for (const legacy of ['config', 'data']) assert.equal(fs.existsSync(path.join(TOOL, legacy)), false, `${legacy} folder must not exist in the tool`);
});

test('planted terms are found in .txt, .json, inside a .docx and inside a .zip; separators between words match', () => {
  const dir = tmpDir('jdfc-deny-');
  try {
    const list = terms();
    const single = list.find((t) => !/\s/.test(t));
    const multi = list.find((t) => /\s/.test(t));
    fs.writeFileSync(path.join(dir, 'a.txt'), `hello\nwritten by ${single.toUpperCase()} today\n`);
    fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ note: multi.replace(/\s+/g, '-').toLowerCase() }));
    fs.writeFileSync(path.join(dir, 'c.docx'), minimalDocx(['Summary', `Worked on ${multi.replace(/\s+/g, '_')}`]));
    fs.writeFileSync(path.join(dir, 'd.zip'), storedZip([{ name: 'inner/readme.txt', data: `x ${single} y` }]));
    fs.writeFileSync(path.join(dir, 'clean.txt'), `prefix${single}suffix is not a word-boundary hit`);
    const hits = scanTree(dir);
    const files = new Set(hits.map((h) => h.file.split(' ')[0].split('!')[0]));
    for (const f of ['a.txt', 'b.json', 'c.docx', 'd.zip']) assert.ok(files.has(f), `${f} not flagged: ${JSON.stringify(hits)}`);
    assert.ok(!files.has('clean.txt'), 'embedded inside a longer word is not a hit');
    assert.ok(hits.some((h) => h.file.startsWith('c.docx (text)')), 'docx text extraction used');
    assert.equal(hits.find((h) => h.file === 'a.txt').line, 2);
    process.env.JDFC_DENY_EXTRA = 'zzplanted';
    fs.writeFileSync(path.join(dir, 'e.txt'), 'ZZPlanted');
    assert.ok(scanTree(dir).some((h) => h.file === 'e.txt'));
    delete process.env.JDFC_DENY_EXTRA;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
