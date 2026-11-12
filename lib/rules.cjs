'use strict';

// Rules engine: level / years, direction, gates, red flags, blockers. Every result carries a "why".

const { hasPhrase, phraseRegex, normalize } = require('./text.cjs');

const YEARS_RE = /(\d{1,2})(?:\.\d)?\s*(\+|plus)?\s*(?:(?:-|–|—|to)\s*(\d{1,2}))?\s*\+?\s*(?:years|yrs|year)\b/gi;

function countPhrases(text, phrases) {
  return (phrases || []).filter((p) => hasPhrase(text, p));
}

function titleHasSeniorWord(title, rules) {
  const words = rules.level.seniorTitleWords || [];
  const hit = words.find((w) => phraseRegex(w, 'i').test(title || ''));
  return hit || null;
}

// ---------------------------------------------------------------- level
function detectLevel(jd, rules, profile) {
  const lv = rules.level;
  const body = jd.lines.filter((l) => l.section !== 'title').map((l) => l.text).join('\n');
  const pmRe = new RegExp(lv.pmSpecificPattern, 'i');
  const phrases = [];
  let m;
  YEARS_RE.lastIndex = 0;
  while ((m = YEARS_RE.exec(body))) {
    const min = Number(m[1]);
    const max = m[3] ? Number(m[3]) : null;
    if (min > 30 || (max !== null && max < min)) continue;
    const after = body.slice(m.index + m[0].length, m.index + m[0].length + 70);
    const before = body.slice(Math.max(0, m.index - 30), m.index);
    if (/\b(old|ago|history|founded|anniversary)\b/i.test(after.slice(0, 20))) continue;
    const pmSpecific = pmRe.test(after.split(/[.;(]/)[0]) || /product manag(er|ement)\s*$/i.test(before);
    phrases.push({ text: m[0].trim(), min, max, plus: Boolean(m[2]) || /\+/.test(m[0]), pmSpecific, context: (m[0] + after).split(/[.;\n]/)[0].trim() });
  }
  const mbaRe = new RegExp(lv.mbaPathPattern, 'i');
  const mbaPath = mbaRe.test(body);
  const senior = titleHasSeniorWord(jd.title, rules);
  const bodySenior = new RegExp(lv.bodySeniorPattern, 'i').test(body);
  const notes = [];
  let minYears = null;
  let pmSpecific = false;
  if (phrases.length) {
    const best = phrases.reduce((a, b) => (b.min < a.min ? b : a));
    minYears = best.min;
    pmSpecific = best.pmSpecific;
  }
  let cls;
  let why;
  const cand = profile.totalYears;
  if (mbaPath) {
    cls = 'ok';
    why = `MBA path lowers the bar ("${(body.match(mbaRe) || [''])[0].trim()}"); candidate has an MBA.`;
  } else if (senior && (minYears === null || minYears >= lv.tooSeniorMinYears)) {
    cls = 'too_senior';
    why = `Title says "${senior}"${minYears === null ? ' and no years are stated' : ` and asks for ${minYears}+ years`}; candidate has ~${cand} yrs.`;
  } else if (senior) {
    cls = 'stretch';
    why = `Title says "${senior}" but the body asks for ${minYears}+ years: stretch.`;
    notes.push(`Mismatch: "${senior}" title vs ${minYears}+ years in the body.`);
  } else if (minYears === null) {
    cls = 'ok';
    why = 'No years gate stated.';
  } else if (minYears >= lv.tooSeniorMinYears) {
    cls = 'too_senior';
    why = `Asks for ${minYears}+ years; candidate has ~${cand} yrs.`;
  } else if (pmSpecific && minYears >= 1 && !profile.hasPmTitle) {
    // Recruiter view: PM-specific years with no PM title are a stretch even when the band is low.
    cls = 'stretch';
    why = `Asks for ${minYears}+ years of PM-specific experience; candidate has ~${cand} yrs total but no PM title.`;
  } else if (minYears > cand) {
    cls = 'stretch';
    why = `Band starts at ${minYears} years, above the candidate's ~${cand} yrs: stretch.`;
  } else {
    cls = 'ok';
    why = `Asks for ${minYears}${phrases.find((p) => p.min === minYears && p.max) ? `-${phrases.find((p) => p.min === minYears && p.max).max}` : '+'} years; candidate has ~${cand} yrs.`;
  }
  if (!senior && bodySenior) notes.push(`Mismatch: the title has no seniority word but the body says "${(body.match(new RegExp(lv.bodySeniorPattern, 'i')) || [''])[0]}".`);
  return { class: cls, minYears, pmSpecific, phrases, titleSeniorWord: senior, mbaPath, mismatch: notes.length > 0, notes, why };
}

// ---------------------------------------------------------------- direction
function detectDirection(jd, rules) {
  const d = rules.directions;
  const title = jd.title || '';
  const lines = jd.lines.filter((l) => l.section !== 'title');
  const body = lines.map((l) => l.text).join('\n');
  const requiredText = lines.filter((l) => l.section === 'required' || l.mustHave).map((l) => l.text).join('\n');
  const preferredText = lines.filter((l) => l.section === 'preferred').map((l) => l.text).join('\n');

  const targets = d.target.map((t, order) => {
    const titleHits = countPhrases(title, t.titlePhrases);
    const bodyHits = countPhrases(body, t.bodyPhrases);
    return { ...t, order, titleHits, bodyHits, score: (titleHits.length ? d.titleWeight : 0) + bodyHits.length };
  });
  targets.sort((a, b) => b.score - a.score || (b.titleHits.length - a.titleHits.length) || a.order - b.order);
  const bestTarget = targets[0] && targets[0].score > 0 ? targets[0] : null;
  const targetBody = bestTarget ? bestTarget.bodyHits.length : 0;

  const avoidHits = [];
  let winner = null;
  const deepVertical = { required: [], preferred: [] };
  for (const a of d.avoid) {
    if (a.id === 'deep_vertical') {
      deepVertical.required = countPhrases(requiredText, a.phrases);
      deepVertical.preferred = countPhrases(preferredText, a.phrases).filter((p) => !deepVertical.required.includes(p));
      continue;
    }
    const titleHits = countPhrases(title, a.titlePhrases);
    const bodyHits = countPhrases(body, a.phrases);
    if (!titleHits.length && !bodyHits.length) continue;
    const minHits = a.minHits || d.avoidMinScore;
    const wins = titleHits.length > 0 || (bodyHits.length >= minHits && (a.override || bodyHits.length > targetBody));
    avoidHits.push({ id: a.id, label: a.label, action: a.action, titleHits, bodyHits, wins });
    if (wins && (!winner || titleHits.length > winner.titleHits.length || bodyHits.length > winner.bodyHits.length)) winner = avoidHits[avoidHits.length - 1];
  }
  if (winner) {
    const ev = [...winner.titleHits.map((h) => `title: "${h}"`), ...winner.bodyHits.map((h) => `"${h}"`)];
    return { class: 'avoid', id: winner.id, label: winner.label, action: winner.action, hits: ev, avoidHits, deepVertical, target: bestTarget ? bestTarget.id : null,
      why: `Avoid direction (${winner.label}): ${ev.join(', ')}${bestTarget ? `; outweighs the ${bestTarget.label} signals` : ''}.` };
  }
  if (!bestTarget) return { class: 'neutral', id: null, label: 'No clear target direction', action: null, hits: [], avoidHits, deepVertical, why: 'No target-direction phrases in the title or body.' };
  const ev = [...bestTarget.titleHits.map((h) => `title: "${h}"`), ...bestTarget.bodyHits.map((h) => `"${h}"`)];
  return { class: bestTarget.secondary ? 'secondary' : 'target', id: bestTarget.id, label: bestTarget.label, action: null, hits: ev, avoidHits, deepVertical,
    why: `${bestTarget.secondary ? 'Secondary' : 'Target'} direction ${bestTarget.label}: ${ev.join(', ')}.${avoidHits.length ? ` Minor avoid signals: ${avoidHits.map((a) => a.bodyHits.join('/')).join('; ')}.` : ''}` };
}

// ---------------------------------------------------------------- red flags
function detectRedFlags(jd, rules) {
  const body = jd.lines.map((l) => l.text).join('\n');
  return (rules.redFlags || []).map((rf) => ({ id: rf.id, label: rf.label, hits: countPhrases(body, rf.phrases) })).filter((r) => r.hits.length);
}

// ---------------------------------------------------------------- gates
function lineIsRequired(l) { return l.section === 'required' || l.mustHave; }

function toolRegex(tg, phrase) {
  if (tg.caseSensitive) return new RegExp(`(?<![A-Za-z0-9])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`);
  return phraseRegex(phrase, 'i');
}

function evaluateGates(jd, profile, rules, level) {
  const gates = [];
  const lines = jd.lines.filter((l) => l.section !== 'title' && !l.heading);
  const gateLines = lines.filter((l) => l.section !== 'other');
  const add = (g) => { if (!gates.some((x) => x.category === g.category && x.requirement === g.requirement)) gates.push(g); };

  // years
  if (level && (level.minYears !== null || level.titleSeniorWord)) {
    const st = { ok: 'met', stretch: 'partial', too_senior: 'not_met' }[level.class] || 'unknown';
    const req = level.minYears !== null ? (level.phrases.find((p) => p.min === level.minYears) || {}).context || `${level.minYears}+ years` : `Seniority: "${level.titleSeniorWord}" title`;
    add({ category: 'years', requirement: req, required: true, status: st, evidence: level.why });
  }

  // education
  const ed = rules.education || {};
  const tierRe = ed.tierListPattern ? new RegExp(ed.tierListPattern, 'i') : null;
  const mbaRe = new RegExp(ed.mbaPattern || '\\bmba\\b', 'i');
  const bachRe = new RegExp(ed.bachelorPattern || 'bachelor', 'i');
  const csRe = ed.csDegreePattern ? new RegExp(ed.csDegreePattern, 'i') : null;
  const gpaRe = ed.gpaPattern ? new RegExp(ed.gpaPattern, 'i') : null;
  const mba = (profile.education || []).find((e) => /mba/i.test(e.degree));
  const gpa = profile.gpa || null;
  for (const l of gateLines) {
    const t = l.text;
    const required = lineIsRequired(l);
    if (tierRe && tierRe.test(t)) {
      const eq = /or equivalent/i.test(t);
      add({ category: 'education', requirement: t.slice(0, 160), required, status: 'partial', risk: true,
        evidence: `${mba ? `${mba.degree}, ${mba.school} (${mba.notes})` : 'Candidate degree'} is not on the listed tier; ${eq ? 'JD says "or equivalent": argue equivalence (Gold Medalist, top CGPA).' : 'argue equivalence with Gold Medal and CGPA.'}` });
      continue;
    }
    if (gpaRe && /\b(c?gpa)\b/i.test(t) && gpa) {
      const gm = t.match(gpaRe);
      const val = gm ? Number(gm[1] || gm[3]) : NaN;
      if (Number.isFinite(val)) {
        const scale = gm[2] ? Number(gm[2]) : (val <= 4 ? 4 : 10);
        const cand = (gpa.value / gpa.scale) * scale;
        add({ category: 'education', requirement: t.slice(0, 160), required, status: cand >= val ? 'met' : 'not_met', evidence: `Candidate CGPA ${gpa.value}/${gpa.scale} (~${cand.toFixed(2)}/${scale}) vs floor ${val}.` });
        continue;
      }
    }
    if (mbaRe.test(t)) {
      add({ category: 'education', requirement: t.slice(0, 160), required, status: mba ? 'met' : 'not_met', evidence: mba ? `${mba.degree}, ${mba.school} (${mba.notes}).` : 'No MBA in profile.' });
      continue;
    }
    if (csRe && csRe.test(t) && /degree|bachelor|b\.?tech|graduate/i.test(t)) {
      const bt = (profile.education || []).find((e) => /b\.?tech|b\.?e/i.test(e.degree));
      add({ category: 'education', requirement: t.slice(0, 160), required, status: /or (equivalent|related)|engineering|technical/i.test(t) ? 'partial' : 'not_met', evidence: bt ? `${bt.degree} ${bt.field} (not Computer Science).` : 'No CS degree.' });
      continue;
    }
    if (bachRe.test(t) && /degree|bachelor|graduate/i.test(t)) {
      add({ category: 'education', requirement: t.slice(0, 160), required, status: 'met', evidence: (profile.education || []).map((e) => `${e.degree}${e.field ? ` ${e.field}` : ''}`).join('; ') });
    }
  }

  // certifications
  for (const l of gateLines) {
    const t = l.text;
    let handled = false;
    for (const cp of rules.certPatterns || []) {
      if (new RegExp(cp.pattern, 'i').test(t)) {
        add({ category: 'certifications', requirement: t.slice(0, 160), required: lineIsRequired(l), status: cp.status, forbidden: true, evidence: `${cp.label}: not held (and must not be claimed).` });
        handled = true;
      }
    }
    // Only lines that actually ask for a credential ("certification in X", "X certified", "certifications:").
    const asksForCert = /\b(certification|certified|certificate)s?\s+(in|on|as|such as|like|required|preferred|is|are)\b|\bcertifications?\s*:|\b(aws|google|azure|gcp|pmp|itil|scrum|safe|cspo|csm|psm|hubspot|salesforce|six sigma|cloud)\b[^.]{0,30}\bcertif|\bcertif\w*\b[^.]{0,30}\b(aws|google|azure|gcp|pmp|itil|scrum|safe|agile|product owner|hubspot|salesforce|six sigma)\b/i;
    if (handled || !asksForCert.test(t)) continue;
    const held = (profile.certifications || []).find((c) => [c.name, ...(c.aliases || [])].some((a) => hasPhrase(t, a)));
    add({ category: 'certifications', requirement: t.slice(0, 160), required: lineIsRequired(l), status: held ? 'met' : 'unknown', evidence: held ? `Holds ${held.name}.` : 'Certification named is not in the profile; check the exact cert.' });
  }

  // tools
  const hard = new Set((rules.hardPlatforms || []).map((h) => h.toLowerCase()));
  for (const tg of rules.toolGates || []) {
    const hitLines = gateLines.filter((l) => tg.phrases.some((p) => toolRegex(tg, p).test(l.text)));
    if (!hitLines.length) continue;
    const reqLine = hitLines.find(lineIsRequired);
    const prefOnly = hitLines.every((l) => l.section === 'preferred');
    const status = (profile.tools || {})[tg.id] || 'unknown';
    const required = Boolean(reqLine);
    const mustHave = Boolean(reqLine && reqLine.mustHave);
    // Hard gate: a required specialist platform not held, or any tool on an explicit must-have line that is not held.
    const isHard = required && ((hard.has(tg.id) && status !== 'met') || (mustHave && status === 'not_met'));
    add({ category: 'tools', requirement: tg.label, required, preferred: prefOnly, mustHave, status, hard: isHard, specialist: hard.has(tg.id),
      evidence: `${status === 'met' ? 'Hands-on' : status === 'partial' ? 'Some exposure (coursework / light use)' : status === 'not_met' ? 'No hands-on experience' : 'Not in profile'}. JD: "${(reqLine || hitLines[0]).text.slice(0, 120)}"${isHard ? (hard.has(tg.id) && status !== 'met' ? ' (required specialist platform: hard gate)' : ' (must-have tool not held: hard gate)') : ''}` });
  }

  // domain
  for (const dg of rules.domainGates || []) {
    const reqHit = gateLines.filter(lineIsRequired).find((l) => dg.phrases.some((p) => hasPhrase(l.text, p)));
    const prefHit = gateLines.filter((l) => l.section === 'preferred').find((l) => dg.phrases.some((p) => hasPhrase(l.text, p)));
    if (!reqHit && !prefHit) continue;
    const status = (profile.domains || {})[dg.id] || 'unknown';
    const mustHave = Boolean(reqHit && reqHit.mustHave);
    // Hard gate only when the domain sits on an explicit must-have line and is not held.
    add({ category: 'domain', requirement: dg.label, required: Boolean(reqHit), mustHave, status, domainId: dg.id, hard: mustHave && status === 'not_met',
      evidence: `${status === 'met' ? 'Direct experience' : status === 'partial' ? 'Adjacent / learnable' : status === 'not_met' ? 'No experience in this domain' : 'Unknown'}. JD: "${(reqHit || prefHit).text.slice(0, 120)}"` });
  }
  const deepAvoid = (rules.directions.avoid || []).find((a) => a.id === 'deep_vertical');
  if (deepAvoid) {
    for (const l of gateLines) {
      const hits = countPhrases(l.text, deepAvoid.phrases);
      if (!hits.length) continue;
      // Required -> hard gate. Preferred-only is a fit penalty (see scoring) plus the domain gate above, not a blocker.
      if (lineIsRequired(l)) add({ category: 'domain', requirement: `Deep vertical: ${hits.join(', ')}`, required: true, status: 'not_met', hard: true, evidence: `Required regulated / deep-vertical domain. JD: "${l.text.slice(0, 120)}"` });
    }
  }

  // location / shift
  const loc = rules.locations || {};
  const all = lines.map((l) => l.text).join('\n');
  const aliases = (profile.locationAliases || [profile.location || '']).map((a) => a.toLowerCase());
  const cities = (loc.cities || []).filter((c) => hasPhrase(all, c));
  const remote = countPhrases(all, loc.remotePhrases);
  if (cities.length || remote.length) {
    const home = cities.some((c) => aliases.includes(c.toLowerCase()));
    add({ category: 'location', requirement: [...cities, ...remote].join(' / '), required: true, status: home || remote.length ? 'met' : 'partial',
      evidence: home ? `Candidate is in ${profile.location}.` : remote.length ? 'Remote option stated.' : `Candidate is in ${profile.location}; relocation needed.` });
  }
  const shifts = countPhrases(all, loc.shiftPhrases);
  if (shifts.length) add({ category: 'location', requirement: `Shift: ${shifts.join(', ')}`, required: true, status: 'partial', evidence: 'Shift / overlap-hours requirement: confirm you are willing.' });
  const onsite = countPhrases(all, [...(loc.onsitePhrases || []), ...(loc.relocationPhrases || [])]);
  if (onsite.length) add({ category: 'location', requirement: `Onsite: ${onsite.join(', ')}`, required: true, status: 'partial', evidence: 'Strict onsite / relocation requirement.' });

  // language
  const langs = (profile.languages || []).map((x) => x.toLowerCase());
  for (const l of gateLines) {
    for (const lang of rules.languages || []) {
      if (hasPhrase(l.text, lang) && /(fluen|proficien|speak|native|written|verbal|language)/i.test(l.text)) {
        const has = langs.includes(lang);
        add({ category: 'language', requirement: lang.replace(/^\w/, (c) => c.toUpperCase()), required: lineIsRequired(l) || l.section !== 'preferred', status: has ? 'met' : 'not_met', evidence: has ? `Speaks ${lang}.` : `${lang} is not in the profile languages (${profile.languages.join(', ')}).` });
      }
    }
  }
  return gates;
}

// ---------------------------------------------------------------- blockers
function findBlockers(direction, level, gates) {
  const out = [];
  if (direction.class === 'avoid' && direction.action === 'skip') out.push({ type: 'direction', action: 'skip', reason: `direction: ${direction.label}` });
  if (direction.class === 'avoid' && direction.action === 'hold') out.push({ type: 'direction', action: 'hold', reason: `direction: ${direction.label} (stepping-stone seat)` });
  if (level.class === 'too_senior') out.push({ type: 'level', action: 'skip', reason: `level: ${level.why}` });
  for (const g of gates) {
    if (g.hard && g.category === 'tools') out.push({ type: 'platform', action: 'skip', reason: !g.specialist ? `must-have tool not held: ${g.requirement}` : `required specialist platform: ${g.requirement}` });
    if (g.hard && g.category === 'domain') out.push({ type: 'domain', action: 'skip', reason: /^Deep vertical: /.test(g.requirement) ? `required deep-vertical domain: ${g.requirement.replace(/^Deep vertical: /, '')}` : `must-have domain not held: ${g.requirement}` });
    if (g.category === 'certifications' && g.required && g.status === 'not_met') out.push({ type: 'certification', action: 'skip', reason: `required certification not held: ${g.requirement}` });
  }
  return out;
}

module.exports = { detectLevel, detectDirection, detectRedFlags, evaluateGates, findBlockers, titleHasSeniorWord, normalizeForRules: normalize };
