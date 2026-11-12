'use strict';

// Generic text helpers (no candidate-specific content).

const crypto = require('crypto');

const STOPWORDS = new Set(('a an and or the of to in on for with by at from as is are be been being this that these those ' +
  'it its we you your our their they he she his her them us i me my will would can could should may might must ' +
  'not no yes into over under about across within without per via than then so such also more most other any all ' +
  'each every both either neither who whom which what when where why how do does did done have has had role team ' +
  'job position work working opportunity company').split(/\s+/));

const ENTITY_MAP = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', bull: '•', middot: '·', trade: '™', reg: '®', copy: '©' };

function decodeEntities(s) {
  return String(s == null ? '' : s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    const v = ENTITY_MAP[body.toLowerCase()];
    return v === undefined ? m : v;
  });
}

// Reverse common UTF-8-read-as-cp1252 double encodings ("â€”" -> "—").
const CP1252_REVERSE = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f };
function cp1252Byte(ch) {
  const c = ch.codePointAt(0);
  if (c < 0x100) return c;
  return CP1252_REVERSE[ch];
}
function fixMojibake(s) {
  const str = String(s == null ? '' : s);
  if (!/[ÃÂâð]/.test(str)) return str;
  // Sequences starting with a UTF-8 lead byte rendered as cp1252 (Ã, Â, â, ð ...) followed by continuation chars.
  return str.replace(/[\u00c2-\u00f4][\u0080-\u00bf\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2013\u2014\u2018-\u201e\u2020-\u2022\u2026\u2030\u2039\u203a\u20ac\u2122\u00a0-\u00bf]{1,3}/g, (seq) => {
    const bytes = [];
    for (const ch of seq) {
      const b = cp1252Byte(ch);
      if (b === undefined) return seq;
      bytes.push(b);
    }
    const decoded = Buffer.from(bytes).toString('utf8');
    return decoded.includes('\ufffd') ? seq : decoded;
  });
}

function normalize(s) {
  return fixMojibake(String(s == null ? '' : s))
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/'s\b/g, 's')
    .replace(/'/g, '')
    .replace(/[^a-z0-9+#&/.\- ]+/g, ' ')
    .replace(/(^|\s)[./\-]+|[./\-]+(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(s, { keepStop = false } = {}) {
  const toks = normalize(s).split(/[\s/]+/).map((t) => t.replace(/^[.\-]+|[.\-]+$/g, '')).filter(Boolean);
  return keepStop ? toks : toks.filter((t) => !STOPWORDS.has(t));
}

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size && !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// Share of tokens in `a` that appear in `b`.
function containment(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / A.size;
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function slug(s, max = 60) {
  return normalize(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '') || 'jd';
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Case-insensitive phrase regex with word boundaries that also work for terms like "c++", "a/b", "p&l".
function phraseRegex(phrase, flags = 'gi') {
  const body = escapeRegex(String(phrase).trim()).replace(/\s+/g, '[\\s\\-]+');
  return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, flags);
}

function hasPhrase(text, phrase) {
  return phraseRegex(phrase, 'i').test(text);
}

module.exports = { STOPWORDS, decodeEntities, fixMojibake, normalize, tokenize, jaccard, containment, sha256, slug, escapeRegex, phraseRegex, hasPhrase };
