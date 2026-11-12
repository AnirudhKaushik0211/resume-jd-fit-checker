'use strict';

// Shared helpers for the generic suite (not a test file). Every test works in a TEMP profile store
// (JDFC_HOME = a fresh os.tmpdir() folder) seeded from profiles-seed\, so no real profile is read or written.

const fs = require('fs');
const os = require('os');
const path = require('path');
const profiles = require('../lib/profiles.cjs');

function tmpDir(prefix = 'jdfc-test-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// Creates a temp home, points JDFC_HOME at it and returns { home, install, use, cleanup }.
function tempHome() {
  const prev = { home: process.env.JDFC_HOME, profile: process.env.JDFC_PROFILE };
  const home = tmpDir('jdfc-home-');
  process.env.JDFC_HOME = home;
  const install = (id, { seed = '_template', name, kind = 'user' } = {}) => profiles.createProfile({ id, name: name || id, kind }, { home, seed });
  const use = (id) => { process.env.JDFC_PROFILE = id; return id; };
  const cleanup = () => {
    if (prev.home === undefined) delete process.env.JDFC_HOME; else process.env.JDFC_HOME = prev.home;
    if (prev.profile === undefined) delete process.env.JDFC_PROFILE; else process.env.JDFC_PROFILE = prev.profile;
    fs.rmSync(home, { recursive: true, force: true });
  };
  return { home, install, use, cleanup };
}

// Minimal stored (uncompressed) zip, enough for lib\docx.cjs to read. entries: [{ name, data }].
function storedZip(entries) {
  const zlib = require('zlib');
  const locals = [];
  const cens = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const crc = zlib.crc32(data) >>> 0;
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt32LE(crc, 14); loc.writeUInt32LE(data.length, 18); loc.writeUInt32LE(data.length, 22); loc.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
    locals.push(loc, name, data);
    cens.push(cen, name);
    offset += 30 + name.length + data.length;
  }
  const cenBuf = Buffer.concat(cens);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cenBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cenBuf, eocd]);
}

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// A .docx whose word/document.xml holds one paragraph per line.
function minimalDocx(lines) {
  const body = lines.map((l) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(l)}</w:t></w:r></w:p>`).join('');
  return storedZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>' },
    { name: 'word/document.xml', data: `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>` }
  ]);
}

module.exports = { tmpDir, tempHome, storedZip, minimalDocx };
