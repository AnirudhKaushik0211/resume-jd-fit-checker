'use strict';

// Generates a NEW tailored .docx by running the existing scripts\tailor-resume.ps1 (execFile with an args
// array, never a shell string). Sources (bases or submitted copies) are never edited in place here.
// Bounded state machine: at most 2 attempts (exit 5 -> shortest variants; exit 2/3/4 -> drop the offending edit).

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const MAX_ATTEMPTS = 2;
const EXIT_MEANING = { 0: 'ok', 2: 'old text not found / ambiguous', 3: 'protected token lost', 4: 'forbidden new claim', 5: 'more than 1 page', 6: 'file open in Word', 7: 'other error' };

function sanitizePart(s, max = 24) {
  return String(s || '').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1)).join('').slice(0, max);
}

// pattern e.g. "{prefix}{roleCode}_{company}_{short}" (config: rules.generation.targetPattern)
function buildTargetName({ pattern, prefix, roleCode, company, short }, exists) {
  const parts = { prefix: prefix || '', roleCode: sanitizePart(roleCode, 8) || 'PM', company: sanitizePart(company, 24) || 'Company', short: sanitizePart(short, 24) || 'Role' };
  let stem = String(pattern || '{prefix}{roleCode}_{company}_{short}').replace(/\{(\w+)\}/g, (m, k) => parts[k] ?? '');
  stem = stem.replace(/[^A-Za-z0-9_]/g, '').replace(/_+/g, '_').replace(/^_|_$/g, '');
  let name = `${stem}.docx`;
  for (let v = 2; exists(name); v++) name = `${stem}_v${v}.docx`;
  return name;
}

function defaultRunner(file, args, opts) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: opts.timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 7) : 0;
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function parseReport(text) {
  const t = String(text || '');
  const pick = (re) => { const m = t.match(re); return m ? m[1].trim() : null; };
  return {
    exitCode: pick(/- Exit code:\s*(\d+)/),
    replacementsApplied: (t.match(/^Replacement #\d+:/gm) || []).length,
    protectedTokens: pick(/^Protected tokens:\s*(.+)$/m),
    forbiddenScan: pick(/^Forbidden-claim scan[^:]*:\s*(.+)$/m),
    pages: pick(/^Pages:\s*(.+)$/m),
    notFound: (t.match(/^NOT FOUND\/AMBIGUOUS .+$/gm) || []),
    // Only the forbidden-scan hits ("  NEW: P5: 'GenAI' (0 -> 1)"), not the paragraph diff's "  NEW: <text>" lines.
    newForbidden: (t.match(/^\s+NEW: P\d+: .+$/gm) || []).map((s) => s.trim()),
    lost: (t.match(/^\s+LOST: .+$/gm) || []).map((s) => s.replace(/^\s*LOST:\s*/, '').trim()),
    ok: /^OK: /m.test(t)
  };
}

// Which edit indexes caused exit 2/3/4 (from the tool's report/stdout).
function offendingEdits(code, report, edits) {
  const bad = new Set();
  if (code === 2) for (const line of report.notFound) { const m = line.match(/#(\d+)/); if (m) bad.add(Number(m[1]) - 1); }
  if (code === 3) report.lost.forEach((tok) => edits.forEach((e, i) => { if (e.old.includes(tok) && !e.new.includes(tok)) bad.add(i); }));
  if (code === 4) report.newForbidden.forEach((line) => { const m = line.match(/'([^']+)'/); if (m) edits.forEach((e, i) => { if (e.new.toLowerCase().includes(m[1].toLowerCase())) bad.add(i); }); });
  if (!bad.size && edits.length) bad.add(edits.length - 1); // unidentifiable -> drop the last edit (one regeneration only)
  return [...bad];
}

function shortestVariant(e) {
  const all = [e.new, ...(e.variants || [])].filter(Boolean);
  return { ...e, new: all.reduce((a, b) => (b.length < a.length ? b : a)) };
}

async function generateResume(opts) {
  const { scriptPath, resumeDir, sourceFile, targetName, runsDir, reportDir, timeoutSeconds = 180, runner = defaultRunner, extraArgs = [] } = opts;
  let edits = (opts.edits || []).map((e) => ({ ...e }));
  const attempts = [];
  const dropped = [];
  if (!edits.length) return { ok: false, status: 'no_edits', message: 'No honest edits: use the base file as-is.', attempts, dropped };
  const sourcePath = path.join(resumeDir, sourceFile);
  const targetPath = path.join(resumeDir, targetName);
  if (path.resolve(sourcePath) === path.resolve(targetPath)) return { ok: false, status: 'refused', message: 'Target equals source; sources are never edited in place.', attempts, dropped };
  fs.mkdirSync(runsDir, { recursive: true });
  let force = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const jsonPath = path.join(runsDir, `${path.basename(targetName, '.docx')}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(edits.map((e) => ({ old: e.old, new: e.new })), null, 4), 'utf8');
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Source', sourcePath, '-Target', targetPath, '-Replacements', jsonPath, '-TimeoutSeconds', String(timeoutSeconds), ...(force ? ['-Force'] : []), ...extraArgs];
    const r = await runner('powershell.exe', args, { timeoutMs: (timeoutSeconds + 60) * 1000 });
    const reportPath = path.join(reportDir, `${path.basename(targetName, '.docx')}.md`);
    let reportText = '';
    try { reportText = fs.readFileSync(reportPath, 'utf8'); } catch { reportText = r.stdout; }
    const report = parseReport(reportText || r.stdout);
    attempts.push({ attempt, code: r.code, meaning: EXIT_MEANING[r.code] || 'unknown', edits: edits.map((e) => ({ old: e.old, new: e.new, kind: e.kind })), report, reportPath, stdoutTail: r.stdout.slice(-1500) });
    if (r.code === 0) return { ok: true, status: 'generated', targetName, targetPath, attempts, dropped, report };
    if (r.code === 6) return { ok: false, status: 'word_open', message: 'The file is open in Word. Close Word and try again.', attempts, dropped };
    if (r.code === 7) return { ok: false, status: 'error', message: 'tailor-resume.ps1 reported an error (exit 7). See the run report.', attempts, dropped, report };
    if (attempt === MAX_ATTEMPTS) break;
    if (r.code === 5) {
      edits = edits.map(shortestVariant);
      force = true; // exit 5 writes the target; overwrite it (the tool backs it up first)
      continue;
    }
    if ([2, 3, 4].includes(r.code)) {
      const bad = offendingEdits(r.code, report, edits);
      bad.sort((a, b) => b - a).forEach((i) => dropped.push({ ...edits[i], reason: EXIT_MEANING[r.code] }));
      edits = edits.filter((_, i) => !bad.includes(i));
      if (!edits.length) return { ok: false, status: 'all_dropped', message: 'Every edit was rejected by tailor-resume.ps1; use the base as-is.', attempts, dropped };
      continue;
    }
    return { ok: false, status: 'error', message: `Unexpected exit code ${r.code}.`, attempts, dropped };
  }
  const last = attempts[attempts.length - 1];
  const written = last.code === 5 && fs.existsSync(targetPath);
  return { ok: false, status: written ? 'over_one_page' : 'gave_up', targetName: written ? targetName : null, targetPath: written ? targetPath : null,
    message: `Stopped after ${MAX_ATTEMPTS} attempts (last exit ${last.code}: ${last.meaning}).${written ? ' The file exists but is over 1 page; trim it in Word.' : ''}`, attempts, dropped };
}

// Evidence propagation: -InPlace on a BASE only (tailor-resume.ps1 backs it up first). One attempt per base.
async function propagateToBase({ scriptPath, resumeDir, baseFile, isBase, edits, runsDir, timeoutSeconds = 180, runner = defaultRunner }) {
  if (!isBase) return { ok: false, status: 'refused', message: `${baseFile} is not a base; submitted copies are never edited.` };
  if (!edits.length) return { ok: false, status: 'no_edits', message: 'No swap slot for this base.' };
  fs.mkdirSync(runsDir, { recursive: true });
  const jsonPath = path.join(runsDir, `propagate-${path.basename(baseFile, '.docx')}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(edits.map((e) => ({ old: e.old, new: e.new })), null, 4), 'utf8');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Source', path.join(resumeDir, baseFile), '-InPlace', '-Replacements', jsonPath, '-TimeoutSeconds', String(timeoutSeconds)];
  const r = await runner('powershell.exe', args, { timeoutMs: (timeoutSeconds + 60) * 1000 });
  return { ok: r.code === 0, status: r.code === 0 ? 'updated' : 'failed', code: r.code, meaning: EXIT_MEANING[r.code] || 'unknown', stdoutTail: r.stdout.slice(-1500) };
}

// ---------------------------------------------------------------- background jobs (in memory)
const jobs = new Map();
// profileId: the profile that started the job; getJob(id, profileId) never returns another profile's job.
function startJob(fn, { profileId = null } = {}) {
  const id = `job-${Date.now().toString(36)}-${require('crypto').randomBytes(6).toString('hex')}`;
  const job = { id, profileId, status: 'running', startedAt: new Date().toISOString(), result: null };
  jobs.set(id, job);
  Promise.resolve().then(fn).then((result) => { job.status = 'done'; job.result = result; job.finishedAt = new Date().toISOString(); })
    .catch((error) => { job.status = 'failed'; job.result = { ok: false, status: 'error', message: error.message }; job.finishedAt = new Date().toISOString(); });
  if (jobs.size > 50) jobs.delete(jobs.keys().next().value);
  return job;
}
function getJob(id, profileId) {
  const job = jobs.get(id) || null;
  if (!job || (profileId !== undefined && job.profileId !== profileId)) return null;
  return job;
}

// Path-traversal-safe resolution for GET /download/<file>: plain .docx file names inside dir only.
function safeDownloadPath(dir, name) {
  const n = String(name || '');
  if (!/^[A-Za-z0-9_.-]{1,120}\.docx$/i.test(n) || n.includes('..')) return null;
  const full = path.resolve(dir, n);
  if (path.dirname(full) !== path.resolve(dir)) return null;
  try { if (!fs.statSync(full).isFile()) return null; } catch { return null; }
  return full;
}

module.exports = { buildTargetName, generateResume, propagateToBase, parseReport, offendingEdits, shortestVariant, startJob, getJob, safeDownloadPath, sanitizePart, MAX_ATTEMPTS, EXIT_MEANING };
