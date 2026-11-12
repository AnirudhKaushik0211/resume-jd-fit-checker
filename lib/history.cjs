'use strict';

// Local history of past checks (data/history.json) and repost detection.

const { sha256, tokenize, jaccard } = require('./text.cjs');
const { readJson, writeJson } = require('./store-io.cjs');

const MAX_ENTRIES = 500;

function loadHistory(file) {
  if (!file) return [];
  try {
    const data = readJson(file);
    return Array.isArray(data) ? data : [];
  } catch (error) {
    if (error.code === 'PROFILE_LOCKED') throw error; // a locked (encrypted) file is never treated as empty
    return [];
  }
}

function shingles(text, size) {
  const toks = tokenize(text);
  const out = new Set();
  for (let i = 0; i + size <= toks.length; i++) out.add(toks.slice(i, i + size).join(' '));
  if (!out.size && toks.length) out.add(toks.join(' '));
  return [...out];
}

function detectRepost(text, history, rules) {
  const cfg = rules.repost || { similarity: 0.8, shingleSize: 5 };
  const hash = sha256(String(text || '').trim());
  const sh = shingles(text, cfg.shingleSize);
  let best = null;
  for (const h of history) {
    let sim = h.hash === hash ? 1 : 0;
    if (!sim && h.shingles) sim = jaccard(sh, h.shingles);
    if (sim >= cfg.similarity && (!best || sim > best.similarity)) best = { similarity: Math.round(sim * 100) / 100, date: h.date, company: h.company, title: h.title, verdict: h.verdict, fit: h.fit, id: h.id };
  }
  return best
    ? { isRepost: true, previous: best, why: `${Math.round(best.similarity * 100)}% text overlap with a check on ${best.date} (${best.company || '?'}, ${best.title || '?'}): likely a repost.` }
    : { isRepost: false, why: 'No similar JD in local history.' };
}

function saveCheck(file, entry, rules) {
  const cfg = rules.repost || { shingleSize: 5 };
  const history = loadHistory(file);
  const rec = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    date: new Date().toISOString(),
    company: entry.company, title: entry.title, verdict: entry.verdict, fit: entry.fit, projected: entry.projected, threshold: entry.threshold, gaps: (entry.gaps || []).slice(0, 8), base: entry.base,
    source: entry.source, hash: sha256(String(entry.text || '').trim()), shingles: shingles(entry.text, cfg.shingleSize).slice(0, 800)
  };
  history.push(rec);
  const trimmed = history.slice(-MAX_ENTRIES);
  writeJson(file, trimmed, { space: 1 });
  return rec;
}

function publicHistory(file, limit = 100) {
  return loadHistory(file).slice(-limit).reverse().map(({ shingles: _s, hash: _h, ...rest }) => rest);
}

module.exports = { loadHistory, detectRepost, saveCheck, publicHistory, shingles };
