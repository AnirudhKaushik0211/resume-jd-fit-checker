'use strict';

// Minimal, read-only .docx text extractor (zip reader + word/document.xml).
// Uses only Node built-ins: fs + zlib.inflateRawSync. Never writes the file.

const fs = require('fs');
const zlib = require('zlib');
const { decodeEntities } = require('./text.cjs');

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function findEocd(buf) {
  const minPos = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('Not a zip file (end-of-central-directory record not found).');
}

function listZipEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('Not a zip file (too small).');
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CEN_SIG) throw new Error('Corrupt zip central directory.');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOffset = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, size, localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipEntry(buf, name) {
  const entry = listZipEntries(buf).find((e) => e.name === name);
  if (!entry) throw new Error(`Zip entry not found: ${name}`);
  const lo = entry.localOffset;
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== LOC_SIG) throw new Error('Corrupt zip local header.');
  const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
  const data = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`Unsupported zip compression method ${entry.method} for ${name}.`);
}

function documentXmlToParagraphs(xml) {
  return String(xml)
    .split(/<\/w:p>/)
    .map((chunk) => {
      let out = '';
      const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g;
      let m;
      while ((m = re.exec(chunk))) {
        if (m[0] === '<w:tab/>') out += '\t';
        else if (m[0] === '<w:br/>') out += '\n';
        else out += m[1];
      }
      return decodeEntities(out);
    })
    .filter((p) => p.trim().length > 0);
}

function docxParagraphsFromBuffer(buf) {
  return documentXmlToParagraphs(readZipEntry(buf, 'word/document.xml').toString('utf8'));
}

function docxParagraphs(filePath) {
  return docxParagraphsFromBuffer(fs.readFileSync(filePath));
}

module.exports = { listZipEntries, readZipEntry, documentXmlToParagraphs, docxParagraphsFromBuffer, docxParagraphs };
