'use strict';

// Deny-list scanner: proves the tool folder (and any public package) contains no owner-identifying strings.
// Static terms are stored base64-encoded so this file does not flag itself; add more with JDFC_DENY_EXTRA
// (comma-separated). Matching is case-insensitive, on word boundaries, with [\s_-]* allowed between words
// (so "two words", "two_words" and "two-words" all match). .docx files are scanned by extracted text and raw
// bytes; .zip files entry by entry.

const fs = require('fs');
const path = require('path');
const { listZipEntries, readZipEntry, docxParagraphsFromBuffer } = require('./docx.cjs');

const STATIC_B64 = ['QW5pcnVkaA==', 'S2F1c2hpaw==', 'SUlNIEphbW11', 'VlMgQ29waWxvdA==', 'QW1hem9uIFF1aWNr', 'VmVuZG9yIFNwZWNpYWxpc3Q=', 'UkJT', 'MzJ4', 'YW5pa2F1cw=='];

function terms() {
  const extra = String(process.env.JDFC_DENY_EXTRA || '').split(',').map((s) => s.trim()).filter(Boolean);
  return [...STATIC_B64.map((b) => Buffer.from(b, 'base64').toString('utf8')), ...extra];
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function termRegex(term) {
  const words = String(term).trim().split(/[\s_-]+/).filter(Boolean).map(esc);
  return new RegExp(`(?<![A-Za-z0-9])${words.join('[\\s_-]*')}(?![A-Za-z0-9])`, 'i');
}

function scanText(text, label, compiled, hits) {
  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const { term, re } of compiled) if (re.test(line)) hits.push({ file: label, term, line: i + 1 });
  });
}

function scanBuffer(buf, name, label, compiled, hits) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.docx')) {
    try { scanText(docxParagraphsFromBuffer(buf).join('\n'), `${label} (text)`, compiled, hits); } catch { /* not a readable docx: raw scan below */ }
    scanText(buf.toString('latin1'), `${label} (raw)`, compiled, hits);
    return;
  }
  if (lower.endsWith('.zip')) {
    let entries = [];
    try { entries = listZipEntries(buf); } catch { scanText(buf.toString('latin1'), `${label} (raw)`, compiled, hits); return; }
    scanText(entries.map((e) => e.name).join('\n'), `${label} (entry names)`, compiled, hits);
    for (const e of entries) {
      if (e.name.endsWith('/')) continue;
      let data;
      try { data = readZipEntry(buf, e.name); } catch { continue; }
      scanBuffer(data, e.name, `${label}!${e.name}`, compiled, hits);
    }
    return;
  }
  scanText(buf.toString('utf8'), label, compiled, hits);
}

// exclude: relative paths (forward or back slashes) or bare folder/file names to skip.
function scanTree(root, { exclude = [], extraTerms = [] } = {}) {
  const compiled = [...terms(), ...extraTerms].map((term) => ({ term, re: termRegex(term) }));
  const ex = new Set(exclude.map((e) => e.replace(/\\/g, '/').replace(/\/$/, '')));
  const hits = [];
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, d.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (ex.has(rel) || ex.has(d.name)) continue;
      scanText(d.name, `${rel} (name)`, compiled, hits);
      if (d.isDirectory()) walk(full);
      else if (d.isFile()) scanBuffer(fs.readFileSync(full), d.name, rel, compiled, hits);
    }
  };
  walk(root);
  return hits;
}

module.exports = { terms, termRegex, scanTree, scanText };
