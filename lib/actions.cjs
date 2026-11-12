'use strict';

// User-triggered actions: generate a new tailored resume, record "Did you apply?", add evidence, propagate evidence.
// All writes are explicit user actions from the UI. Runner is injectable so tests never call PowerShell unintentionally.

const fs = require('fs');
const path = require('path');
const { analyze } = require('./analyze.cjs');
const gen = require('./generate.cjs');
const { docxParagraphs } = require('./docx.cjs');
const { appendToChecklist, formatApplicationEntry } = require('./checklist.cjs');
const { saveRepo, markApplication, refreshRepo } = require('./repo.cjs');
const { honestyGuard } = require('./advice.cjs');
const { appendApplication } = require('./applications.cjs');
const { readJson, writeJson } = require('./store-io.cjs');
const { makeBuiltinRunner } = require('./docx-edit.cjs');

// Generator plugin: tailor-resume.ps1 (default runner) or the builtin Node generator (same CLI contract).
function pickRunner(config, runner) { return runner || (config.generator === 'builtin' ? makeBuiltinRunner(config) : undefined); }
function scriptFor(config) { return config.paths.tailorScript || 'builtin'; }

function shortTitle(title) {
  const generic = /^(senior|sr|associate|product|manager|management|pm|apm|owner|lead|i|ii|iii|the|of|and|a|an|role|digital|team|-)$/i;
  return String(title || '').replace(/[^A-Za-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !generic.test(w)).slice(0, 2).join(' ');
}

async function generateForJd(ctx, body, { runner, reload } = {}) {
  const { config } = ctx;
  const g = config.rules.generation || {};
  const input = { jdText: body.jdText, company: body.company, title: body.title, threshold: body.threshold };
  const a = analyze(input, ctx, { ignoreHistory: Boolean(body.ignoreHistory), saveHistory: false, threshold: body.threshold });
  if (!a.ok) return { ok: false, status: 'bad_input', message: a.message };
  const baseName = a.bases.recommended;
  const base = ctx.resumes.find((r) => r.name === baseName);
  const edits = a.tailor.edits.filter((e) => e.kind !== 'optional-domain' || body.includeOptional === true);
  const urlBase = ctx.urlBase || '';
  const offerBase = { file: base.fileName, download: `${urlBase}/download/${encodeURIComponent(base.fileName)}`, absPath: base.file };
  if (a.verdict.key === 'skip_repeat' || a.blockers.some((b) => b.action === 'skip')) return { ok: false, status: 'blocked', message: `Not generating: ${a.verdict.reason}`, base: offerBase };
  if (!edits.length) return { ok: false, status: 'no_edits', message: 'No honest edits for this JD: use the base as-is.', base: offerBase, baselineFit: a.fit.score, threshold: a.threshold.threshold };
  const dir = config.paths.resumeDir;
  const prefix = config.paths.resumeFilePrefix;
  const roleCode = (g.roleCodes || {})[a.direction.id] || 'PM';
  const targetName = body.targetName && /^[A-Za-z0-9_]{3,100}\.docx$/.test(body.targetName) && !fs.existsSync(path.join(dir, body.targetName))
    ? body.targetName
    : gen.buildTargetName({ pattern: g.targetPattern, prefix, roleCode, company: a.input.company, short: shortTitle(a.input.title) }, (n) => fs.existsSync(path.join(dir, n)));
  const result = await gen.generateResume({
    scriptPath: scriptFor(config), resumeDir: dir, sourceFile: base.fileName, targetName, edits,
    runsDir: config.paths.tailorRunsDir, reportDir: config.paths.tailorReportDir, timeoutSeconds: g.timeoutSeconds || 180, runner: pickRunner(config, runner), extraArgs: body.skipPageCheck ? ['-SkipPageCheck'] : []
  });
  const out = { ...result, sameCompanyWarnings: a.seenBefore.sameCompanyWarnings || [], base: offerBase, baselineFit: a.fit.score, projectedFit: a.tailor.projectedFit, threshold: a.threshold.threshold, company: a.input.company, title: a.input.title, gaps: a.verdict.gapReasons.map((x) => x.gap) };
  if (result.targetPath && fs.existsSync(result.targetPath)) {
    const paragraphs = docxParagraphs(result.targetPath);
    const appliedEdits = result.attempts[result.attempts.length - 1].edits;
    const closingEdit = appliedEdits.find((e) => e.kind === 'closing-role' || e.kind === 'optional-domain');
    const resume = { name: path.basename(targetName, '.docx').slice(prefix.length), file: result.targetPath, fileName: targetName, kind: 'base', label: 'generated', family: base.family,
      base: { ...base.base, closingSentence: closingEdit ? closingEdit.new : base.base.closingSentence }, paragraphs, text: paragraphs.join('\n') };
    const re = analyze(input, ctx, { ignoreHistory: true, saveHistory: false, threshold: body.threshold, overrideResume: { resume } });
    out.finalFit = re.fit.score;
    out.meetsThreshold = re.fit.score >= a.threshold.threshold;
    out.finalVerdictNote = `Actual fit of the generated file: ${re.fit.score}% vs T ${a.threshold.threshold}% (baseline ${a.fit.score}%, projected ${a.tailor.projectedFit}%).`;
    out.download = `${urlBase}/download/${encodeURIComponent(targetName)}`;
    out.absPath = result.targetPath;
    out.folder = dir;
    ctx.repo.records[targetName] = { ...(ctx.repo.records[targetName] || {}), file: targetName, name: resume.name, type: 'generated-pending', derivedFrom: baseName, appliedTo: [], createdAt: new Date().toISOString() };
    if (config.paths.repoFile && body.persistRepo !== false) saveRepo(config.paths.repoFile, ctx.repo);
    if (reload) reload();
  }
  return out;
}

function recordApplication(ctx, body, { checklistPath } = {}) {
  const { config } = ctx;
  if (body.confirm !== true) { const e = new Error('Explicit confirmation is required (confirm: true).'); e.statusCode = 400; throw e; }
  const answer = String(body.answer || '');
  const line = formatApplicationEntry({ answer, company: body.company, title: body.title, resume: body.resumeFile ? path.basename(String(body.resumeFile), '.docx').replace(config.paths.resumeFilePrefix, '') : body.resume,
    fit: body.fit, baseline: body.baseline, threshold: body.threshold, gaps: body.gaps, reason: body.reason });
  const fileName = body.resumeFile ? path.basename(String(body.resumeFile)) : null;
  const status = { applied: 'applied', pending: 'pending', skip: 'skipped' }[answer];
  // Log plugin: the owner's markdown checklist (append after a .bak copy) or data\applications.json.
  let r = { backupPath: null };
  if (checklistPath || (config.log || 'checklist') === 'checklist') r = appendToChecklist(checklistPath || config.paths.checklist, line);
  else {
    const resumeName = body.resumeFile ? path.basename(String(body.resumeFile), '.docx').replace(config.paths.resumeFilePrefix, '') : body.resume;
    appendApplication(config.paths.applicationsFile, { company: body.company, role: body.title, status, resume: resumeName, fit: body.fit, gaps: body.gaps, reason: body.reason });
  }
  if (fileName && ctx.repo && ctx.repo.records[fileName]) {
    markApplication(ctx.repo, fileName, { company: String(body.company || ''), role: String(body.title || ''), date: new Date().toISOString().slice(0, 10), status, fit: body.fit });
    if (config.paths.repoFile && body.persistRepo !== false) saveRepo(config.paths.repoFile, ctx.repo);
  }
  return { ok: true, line, backupPath: r.backupPath, status };
}

function pendingApplications(repo) {
  return Object.values(repo.records || {}).filter((r) => r.type === 'generated-pending').map((r) => ({ file: r.file, derivedFrom: r.derivedFrom, createdAt: r.createdAt, last: (r.appliedTo || []).slice(-1)[0] || null }));
}

const ID_RE = /^[a-z0-9-]{2,40}$/;
function validateEvidence(item, config) {
  const errs = [];
  if (!item || typeof item !== 'object') return ['Evidence item must be an object.'];
  if (!ID_RE.test(String(item.id || ''))) errs.push('id must be 2-40 chars of a-z, 0-9, -.');
  if (config.profile.evidence.some((e) => e.id === item.id)) errs.push(`id "${item.id}" already exists.`);
  if (!item.claim || String(item.claim).length > 400) errs.push('claim is required (max 400 chars).');
  if (item.detect) { try { new RegExp(item.detect, 'i'); } catch { errs.push('detect must be a valid regular expression.'); } }
  if (item.keywords && (!Array.isArray(item.keywords) || item.keywords.some((k) => !config.keywords.some((x) => x.id === k)))) errs.push('keywords must be existing keyword ids.');
  if (item.dateAdded && !/^\d{4}-\d{2}-\d{2}$/.test(item.dateAdded)) errs.push('dateAdded must be YYYY-MM-DD.');
  const flags = [item.claim, item.brief, item.skillLabel].filter(Boolean).flatMap((t) => honestyGuard(String(t), config, null));
  if (flags.length) errs.push(`Honesty guard: ${flags.map((f) => f.message).join(' ')}`);
  return errs;
}

function addEvidence(config, item) {
  const errs = validateEvidence(item, config);
  if (errs.length) { const e = new Error(errs.join(' ')); e.statusCode = 400; throw e; }
  const file = config.paths.userEvidenceFile;
  const data = fs.existsSync(file) ? readJson(file) : { evidence: [] };
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  const clean = { id: item.id, claim: String(item.claim), brief: String(item.brief || item.claim).slice(0, 160), theme: item.theme ? String(item.theme) : undefined,
    skillLabel: item.skillLabel ? String(item.skillLabel).slice(0, 80) : undefined, keywords: item.keywords || [], detect: item.detect || undefined,
    appliesTo: Array.isArray(item.appliesTo) ? item.appliesTo.map(String) : [], dateAdded: item.dateAdded || new Date().toISOString().slice(0, 10) };
  data.evidence = [...(data.evidence || []), clean];
  writeJson(file, data, { space: 2, trailingNewline: true });
  return clean;
}

// Bases lacking an evidence item (by its detect pattern) -> candidates for propagation.
function staleBasesFor(ctx, evidenceId) {
  const e = ctx.config.profile.evidence.find((x) => x.id === evidenceId);
  if (!e || !e.detect) return [];
  const re = new RegExp(e.detect, 'i');
  return ctx.resumes.filter((r) => r.kind === 'base' && !re.test(r.text)
    && (!(e.appliesTo || []).length || e.appliesTo.some((f) => String(r.family || '').toLowerCase().includes(String(f).toLowerCase()))))
    .map((r) => ({ name: r.name, file: r.fileName, family: r.family, swapSlot: (r.base.swapSlots || [])[0] || null }));
}

// ---------------------------------------------------------------- evidence propagation (pick-list + batch)
// Rows = every resume lacking the evidence item (by its detect pattern). Bases are updated in place (tool backups);
// submitted copies are never edited: selecting one (behind includeSubmitted) creates a NEW <name>_v2.docx instead.

function familyRelevant(item, family) {
  return !(item.appliesTo || []).length || item.appliesTo.some((f) => String(family || '').toLowerCase().includes(String(f).toLowerCase()));
}

// Swap slot for any resume: its own base config, else the first configured base slot whose text occurs exactly once.
function slotFor(ctx, r) {
  if (r.base && (r.base.swapSlots || []).length) return r.base.swapSlots[0];
  const text = r.paragraphs.join('');
  for (const b of ctx.config.bases) for (const s of b.swapSlots || []) if (text.split(s.old).length - 1 === 1) return s;
  return null;
}

function propagationCandidates(ctx, evidenceId, { showAll = false } = {}) {
  const item = ctx.config.profile.evidence.find((x) => x.id === evidenceId);
  if (!item) { const er = new Error('Unknown evidence id.'); er.statusCode = 400; throw er; }
  if (!item.detect) return { item, rows: [], note: 'This evidence item has no detect pattern, so missing resumes cannot be identified.' };
  const re = new RegExp(item.detect, 'i');
  const label = item.skillLabel || item.brief;
  const rows = [];
  const variantOf = new Map(Object.values((ctx.repo && ctx.repo.records) || {}).filter((x) => x.type === 'variant' && x.derivedFrom).map((x) => [x.derivedFrom, x.file]));
  for (const r of ctx.resumes) {
    if (re.test(r.text)) continue;
    const rec = (ctx.repo && ctx.repo.records[r.fileName]) || {};
    if (r.kind !== 'base' && rec.type !== 'variant' && variantOf.has(r.name)) continue; // promoted once: its _v2 row covers it
    const relevant = familyRelevant(item, r.family || rec.family);
    if (!relevant && !showAll) continue;
    const slot = slotFor(ctx, r);
    const proposed = slot ? { old: slot.old, new: slot.keep ? `${label} | ${slot.keep}` : label, location: 'Core Skills line (swap slot)', variants: [label] } : null;
    const delta = proposed ? proposed.new.length - proposed.old.length : null;
    const zero = r.base && r.base.zeroSpareLines;
    const pageRisk = proposed == null ? 'n/a' : delta <= 0 ? 'low' : (zero || delta > 15 ? 'high' : 'medium');
    const sent = (rec.appliedTo || []).find((a) => (a.status || 'applied') === 'applied');
    const type = r.kind === 'base' ? 'base' : (rec.type || 'submitted copy');
    const inPlace = r.kind === 'base' || type === 'variant';
    rows.push({ name: r.name, file: r.fileName, type, isBase: inPlace, isVariant: type === 'variant', nearDuplicateOf: rec.nearDuplicateOf || null, family: r.family || rec.family || null, modifiedAt: rec.modifiedAt || null, relevant,
      sentTo: inPlace ? null : (sent ? `sent to ${sent.company}${sent.date ? ` on ${sent.date}` : ''}` : 'submitted copy (recipient not logged)'),
      proposed, pageRisk, action: proposed ? (inPlace ? `update in place (backup first)${type === 'variant' ? '; variant, promoted earlier' : ''}` : `promote once to ${r.name}_v2.docx (original untouched)`) : 'no swap slot: cannot insert' });
  }
  rows.sort((a, b) => (b.isBase - a.isBase) || a.name.localeCompare(b.name));
  return { item, rows };
}

// Select all includes submitted copies only when includeSubmitted is on; individual picks are honoured as given,
// except submitted copies are still dropped when includeSubmitted is off.
function selectRows(rows, { all = false, files = [], includeSubmitted = false } = {}) {
  const picked = all ? rows : rows.filter((r) => files.includes(r.file));
  return picked.filter((r) => r.proposed && (r.isBase || includeSubmitted));
}

const pendingPlans = new Map();
function preparePropagation(ctx, body) {
  const { item, rows } = propagationCandidates(ctx, body.evidenceId, { showAll: Boolean(body.showAll) });
  const selected = selectRows(rows, { all: Boolean(body.selectAll), files: body.files || [], includeSubmitted: Boolean(body.includeSubmitted) });
  for (const r of selected) {
    if (honestyGuard(r.proposed.new, ctx.config, null).length) { const er = new Error(`Honesty guard rejected the edit for ${r.file}.`); er.statusCode = 400; throw er; }
  }
  const token = require('crypto').randomBytes(16).toString('hex');
  const plan = { profileId: ctx.config.profileId || null, evidenceId: item.id, selected: selected.map((r) => ({ file: r.file, name: r.name, isBase: r.isBase, proposed: r.proposed, action: r.action })), createdAt: Date.now() };
  pendingPlans.set(token, plan);
  for (const [k, v] of pendingPlans) if (Date.now() - v.createdAt > 10 * 60 * 1000) pendingPlans.delete(k);
  return { ok: true, confirmToken: token, expiresInSeconds: 600, plan: plan.selected, summary: `${plan.selected.filter((r) => r.isBase).length} base(s) updated in place, ${plan.selected.filter((r) => !r.isBase).length} new _v2 version(s) of submitted copies.` };
}

function latestBackup(resumeDir, fileName) {
  const stem = path.basename(fileName, '.docx');
  const dirs = fs.readdirSync(resumeDir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('_backup_') && d.name.endsWith(`_${stem}`)).map((d) => d.name).sort();
  const last = dirs[dirs.length - 1];
  return last ? path.join(resumeDir, last, fileName) : null;
}

async function runPropagation(ctx, { confirmToken }, { runner, reload } = {}) {
  const plan = confirmToken && pendingPlans.get(confirmToken);
  if (!plan) { const er = new Error('A valid confirmation token is required (preview the update first, then confirm).'); er.statusCode = 400; throw er; }
  pendingPlans.delete(confirmToken);
  const p = ctx.config.paths;
  const results = [];
  runner = pickRunner(ctx.config, runner);
  const script = scriptFor(ctx.config);
  for (const row of plan.selected) {
    if (row.isBase) {
      let res = await gen.propagateToBase({ scriptPath: script, resumeDir: p.resumeDir, baseFile: row.file, isBase: true, edits: [row.proposed], runsDir: p.tailorRunsDir, runner });
      if (res.code === 5) {
        // In place + exit 5 means the file was written at 2 pages: one retry with the shortest variant, replacing the text just inserted.
        const shortest = [row.proposed.new, ...(row.proposed.variants || [])].reduce((a, b) => (b.length < a.length ? b : a));
        const retry = await gen.propagateToBase({ scriptPath: script, resumeDir: p.resumeDir, baseFile: row.file, isBase: true, edits: [{ old: row.proposed.new, new: shortest }], runsDir: p.tailorRunsDir, runner });
        res = { ...retry, retried: true };
        if (retry.code === 5) {
          const bak = latestBackup(p.resumeDir, row.file);
          let restored = false;
          if (bak && fs.existsSync(bak)) {
            // restore the pre-edit original (the oldest backup from this batch is the original; first backup was made by attempt 1)
            const stem = path.basename(row.file, '.docx');
            const all = fs.readdirSync(p.resumeDir).filter((d) => d.startsWith('_backup_') && d.endsWith(`_${stem}`)).sort();
            const original = path.join(p.resumeDir, all[Math.max(0, all.length - 2)], row.file);
            fs.copyFileSync(fs.existsSync(original) ? original : bak, path.join(p.resumeDir, row.file));
            restored = true;
          }
          res = { ...res, ok: false, status: 'skipped', message: `skipped: 1-page spill after shortest variant${restored ? ' (restored from backup)' : ''}` };
        }
      }
      results.push({ file: row.file, kind: 'base', ...res, message: res.message || (res.ok ? 'ok' : `exit ${res.code} (${res.meaning})`) });
    } else {
      // Promote once: <name>_v2.docx. If it already exists the batch refuses (later updates edit the variant in place).
      const finalName = `${path.basename(row.file, '.docx')}_v2.docx`;
      if (fs.existsSync(path.join(p.resumeDir, finalName))) { results.push({ file: row.file, kind: 'submitted copy', ok: false, status: 'skipped', message: `skipped: ${finalName} already exists; update it in place instead` }); continue; }
      const res = await gen.generateResume({ scriptPath: script, resumeDir: p.resumeDir, sourceFile: row.file, targetName: finalName, edits: [row.proposed], runsDir: p.tailorRunsDir, reportDir: p.tailorReportDir, runner });
      if (res.ok && ctx.repo) ctx.repo.records[finalName] = { file: finalName, name: path.basename(finalName, '.docx').slice(p.resumeFilePrefix.length), type: 'variant', derivedFrom: row.name, appliedTo: [], createdAt: new Date().toISOString() };
      results.push({ file: row.file, kind: 'submitted copy', newFile: res.ok ? finalName : null, ok: res.ok, status: res.status, message: res.ok ? `ok: created ${finalName} (original untouched)` : res.message, attempts: (res.attempts || []).length });
    }
  }
  if (ctx.repo && p.repoFile) { try { saveRepo(p.repoFile, ctx.repo); } catch { /* reported by reload */ } }
  if (reload) reload();
  const okCount = results.filter((r) => r.ok).length;
  return { ok: okCount === results.length, results, summary: `${okCount}/${results.length} updated; ${results.length - okCount} skipped or failed.` };
}

// profileId given: the plan must belong to that profile (a token from another profile is not valid here).
function hasPlan(token, profileId) {
  const plan = token && pendingPlans.get(token);
  if (!plan) return false;
  return profileId === undefined || plan.profileId === profileId;
}

module.exports = { hasPlan, generateForJd, recordApplication, pendingApplications, validateEvidence, addEvidence, staleBasesFor, propagationCandidates, selectRows, preparePropagation, runPropagation, shortTitle };
