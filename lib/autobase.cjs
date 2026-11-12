'use strict';

// Base config for uploaded resumes (no hand-written bases.json entry): the swap slot is the remainder of the first
// "Skills:" / "Tools:" style line (old = keep = that remainder, so a skill swap prepends "<label> | "). No closing sentence.

const LABEL_RE = /^\s*((?:core |technical |key )?(?:skills|tools)\s*[:|])\s*/i;

function autoBase(paragraphs) {
  const base = { familyKeywords: [], closingSentence: null, closingRoleType: null, closingDomainTerms: [], swapSlots: [], auto: true };
  const paras = (paragraphs || []).map(String);
  const joined = paras.join('');
  for (const p of paras) {
    const m = p.match(LABEL_RE);
    if (!m) continue;
    const rest = p.slice(m[0].length).trim();
    if (rest && joined.split(rest).length - 1 === 1) base.swapSlots.push({ old: rest, keep: rest });
    break;
  }
  return base;
}

module.exports = { autoBase, LABEL_RE };
