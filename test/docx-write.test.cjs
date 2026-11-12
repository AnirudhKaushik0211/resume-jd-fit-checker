'use strict';

// Minimal zip/.docx writer: round trip through the reader, entry order and names, reproducible demo build.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tmpDir } = require('./helpers.cjs');
const { writeZip, buildDocx } = require('../lib/docx-write.cjs');
const { listZipEntries, readZipEntry, docxParagraphsFromBuffer } = require('../lib/docx.cjs');
const demo = require('../scripts/build-demo.cjs');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

test('buildDocx round-trips through docxParagraphs (runs joined, tabs, escaping)', () => {
  const buf = buildDocx([
    { style: 'Title', runs: [{ text: 'Sample Person' }] },
    { runs: [{ text: 'Skills: ', bold: true }, { text: 'SQL, A/B te' }, { text: 'sting & <more>' }] },
    'Plain line\twith a tab'
  ]);
  assert.deepEqual(docxParagraphsFromBuffer(buf), ['Sample Person', 'Skills: SQL, A/B testing & <more>', 'Plain line\twith a tab']);
  const xml = readZipEntry(buf, 'word/document.xml').toString('utf8');
  assert.match(xml, /<w:rPr><w:b\/><\/w:rPr>/);
  assert.match(xml, /&amp; &lt;more&gt;/);
});

test('[Content_Types].xml is entry 0, names use forward slashes, entries are deflated', () => {
  const entries = listZipEntries(buildDocx(['x']));
  assert.equal(entries[0].name, '[Content_Types].xml');
  assert.deepEqual(entries.map((e) => e.name), ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels']);
  assert.ok(entries.every((e) => !e.name.includes('\\')));
  assert.ok(entries.every((e) => e.method === 8));
  const z = writeZip([{ name: 'a\\b.txt', data: 'hi' }]);
  assert.equal(listZipEntries(z)[0].name, 'a/b.txt', 'backslashes are normalized');
  assert.equal(readZipEntry(z, 'a/b.txt').toString(), 'hi');
  assert.throws(() => writeZip([{ name: '../evil', data: '' }]), /Bad zip entry/);
  assert.throws(() => writeZip([{ name: 'a', data: '' }, { name: 'a', data: '' }]), /Duplicate/);
});

test('writeZip is deterministic (fixed DOS timestamp)', () => {
  const a = writeZip([{ name: 'x.txt', data: 'same' }]);
  const b = writeZip([{ name: 'x.txt', data: 'same' }]);
  assert.equal(sha(a), sha(b));
});

test('build-demo: two runs give identical sha256 per file, equal to the shipped seed resumes', () => {
  const d1 = tmpDir('jdfc-demo1-');
  const d2 = tmpDir('jdfc-demo2-');
  try {
    const f1 = demo.build(d1);
    const f2 = demo.build(d2);
    assert.equal(f1.length, 7);
    for (let i = 0; i < f1.length; i++) {
      const name = path.basename(f1[i]);
      const h1 = sha(fs.readFileSync(f1[i]));
      assert.equal(h1, sha(fs.readFileSync(f2[i])), name);
      assert.equal(h1, sha(fs.readFileSync(path.join(demo.OUT_DEFAULT, name))), `${name}: seed is stale, rerun node scripts\\build-demo.cjs`);
      const entries = listZipEntries(fs.readFileSync(f1[i]));
      assert.equal(entries[0].name, '[Content_Types].xml');
      assert.ok(entries.every((e) => !e.name.includes('\\')));
    }
  } finally {
    fs.rmSync(d1, { recursive: true, force: true });
    fs.rmSync(d2, { recursive: true, force: true });
  }
});

test('demo skills line is split across runs (label run + mid-word splits)', () => {
  const buf = fs.readFileSync(path.join(demo.OUT_DEFAULT, `${demo.PREFIX}PM_BASE_General.docx`));
  const xml = readZipEntry(buf, 'word/document.xml').toString('utf8');
  const para = xml.split('</w:p>').find((p) => p.includes('Skills: </w:t>'));
  assert.ok(para, 'skills paragraph found');
  assert.ok((para.match(/<w:r>/g) || []).length >= 4, 'several runs');
  assert.ok(para.includes('A/B te</w:t>') && para.includes('Conf</w:t>'), 'split mid-word');
  assert.ok(docxParagraphsFromBuffer(buf).includes('Skills: SQL, Excel, Python, A/B testing, Roadmapping | Tools: Trello, Confluence'));
});
