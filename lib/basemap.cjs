'use strict';

// Parses the markdown tables of a "tailoring base map" file: | Role family | Base | Caveats |

const fs = require('fs');
const { fixMojibake } = require('./text.cjs');

function cleanCell(s) {
  return String(s || '').replace(/`/g, '').replace(/\(cleaned\)/gi, '').replace(/\s+/g, ' ').trim();
}

function parseBaseMap(markdown) {
  const rows = [];
  const lines = fixMojibake(String(markdown || '').replace(/^\uFEFF/, '')).split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('|') || !t.endsWith('|')) continue;
    const cells = t.slice(1, -1).split('|').map((c) => c.trim());
    if (cells.length < 2) continue;
    if (/^:?-{2,}:?$/.test(cells[0])) continue; // separator row
    if (/^role family$/i.test(cells[0]) || /^base$/i.test(cells[1])) continue; // header row
    const base = cleanCell(cells[1]);
    if (!/^[A-Za-z0-9_]+$/.test(base)) continue;
    rows.push({ family: cleanCell(cells[0]), base, caveat: cleanCell(cells.slice(2).join(' | ')) });
  }
  return rows;
}

function loadBaseMap(file) {
  return parseBaseMap(fs.readFileSync(file, 'utf8'));
}

module.exports = { parseBaseMap, loadBaseMap };
