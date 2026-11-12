'use strict';

// Minimal zip + .docx writer (Node built-ins only: zlib.deflateRawSync, zlib.crc32).
// Deterministic: fixed DOS timestamp, forward-slash entry names, entries written in the given order
// (buildDocx puts [Content_Types].xml first). Used by the builtin generator and scripts\build-demo.cjs.

const zlib = require('zlib');

// DOS date/time for 1980-01-01 00:00:00 unless a Date is given (2-second resolution).
function dosStamp(date) {
  if (!date) return { time: 0, day: (0 << 9) | (1 << 5) | 1 };
  const d = new Date(date);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    day: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

// entries: [{ name, data: Buffer|string }]. Returns the zip as a Buffer.
function writeZip(entries, { date } = {}) {
  const { time, day } = dosStamp(date);
  const locals = [];
  const cens = [];
  let offset = 0;
  const seen = new Set();
  for (const e of entries) {
    const nameStr = String(e.name).replace(/\\/g, '/');
    if (!nameStr || nameStr.startsWith('/') || nameStr.split('/').includes('..')) throw new Error(`Bad zip entry name: ${e.name}`);
    if (seen.has(nameStr)) throw new Error(`Duplicate zip entry: ${nameStr}`);
    seen.add(nameStr);
    const name = Buffer.from(nameStr, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8');
    const comp = zlib.deflateRawSync(raw, { level: 9 });
    const crc = zlib.crc32(raw) >>> 0;
    const flags = /[^\x00-\x7f]/.test(nameStr) ? 0x0800 : 0; // UTF-8 names flagged
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(flags, 6); loc.writeUInt16LE(8, 8);
    loc.writeUInt16LE(time, 10); loc.writeUInt16LE(day, 12); loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(comp.length, 18); loc.writeUInt32LE(raw.length, 22); loc.writeUInt16LE(name.length, 26); loc.writeUInt16LE(0, 28);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(flags, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(time, 12); cen.writeUInt16LE(day, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
    locals.push(loc, name, comp);
    cens.push(cen, name);
    offset += 30 + name.length + comp.length;
  }
  const cenBuf = Buffer.concat(cens);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cenBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cenBuf, eocd]);
}

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Text -> <w:t>/<w:tab/>/<w:br/> sequence (inside one run).
function runContent(text) {
  const out = [];
  for (const [i, line] of String(text).split('\n').entries()) {
    if (i) out.push('<w:br/>');
    for (const [j, part] of line.split('\t').entries()) {
      if (j) out.push('<w:tab/>');
      if (part) out.push(`<w:t xml:space="preserve">${xmlEscape(part)}</w:t>`);
    }
  }
  return out.join('');
}

function runXml(run) {
  const r = typeof run === 'string' ? { text: run } : run;
  const props = [r.bold ? '<w:b/>' : '', r.italic ? '<w:i/>' : ''].join('');
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${runContent(r.text || '')}</w:r>`;
}

// paragraph: string | { runs: [{ text, bold?, italic? }], style? }
function paragraphXml(p) {
  const para = typeof p === 'string' ? { runs: [{ text: p }] } : p;
  const ppr = para.style ? `<w:pPr><w:pStyle w:val="${xmlEscape(para.style)}"/></w:pPr>` : '';
  return `<w:p>${ppr}${(para.runs || []).map(runXml).join('')}</w:p>`;
}

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
  + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
  + '</Types>';
const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
  + '</Relationships>';
const DOC_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
  + '</Relationships>';
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="${W_NS}">`
  + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="21"/></w:rPr></w:rPrDefault>'
  + '<w:pPrDefault><w:pPr><w:spacing w:after="60" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>'
  + '</w:styles>';

function documentXml(paragraphs) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="${W_NS}"><w:body>${paragraphs.map(paragraphXml).join('')}`
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>';
}

// Parts in order: [Content_Types].xml, _rels/.rels, word/document.xml, word/styles.xml, word/_rels/document.xml.rels.
function buildDocx(paragraphs, opts = {}) {
  return writeZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: documentXml(paragraphs) },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'word/_rels/document.xml.rels', data: DOC_RELS }
  ], opts);
}

module.exports = { writeZip, buildDocx, documentXml, paragraphXml, runXml, runContent, xmlEscape, dosStamp };
