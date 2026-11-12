# JD Fit Checker (local prototype)

A localhost tool that screens a job description against your resumes using a deterministic, explainable
methodology: seen-before, verdict, direction, level, gates, % fit, ATS keyword match, nearest base resume,
honest tailoring (with an optional generated .docx), improvements, honesty guard, interview prep and a log entry.
No LLM calls, no API keys, zero npm dependencies (Node built-ins only).

## Run

```powershell
node jd-fit-checker\server.cjs
```

Open http://127.0.0.1:4317 (Edge, Chrome or Firefox). The server binds to 127.0.0.1 only and rejects other Host/Origin headers.
On the first visit in a browser (and for a new profile with no history yet) the page opens on the **Help** tab: a
walkthrough with "Go there" buttons, how to read the results, a verdict table at your current threshold, and
troubleshooting. All other tabs stay available; "Show Help on start" in Help and "New here? Start the walkthrough" in
the sidebar bring it back.

Timeouts: Analyze gives up after 60 s and Fetch JD after 30 s, re-enable the button and say so under it ("Analyze timed
out after 60 s. The server may be busy or stopped; check the server window, then try again."). Generate keeps polling
its background job as before.
Set `$env:PORT` to use another port, `$env:JDFC_HOME` to use another profile store (default `%USERPROFILE%\.jd-fit-checker`).
Pick the profile in the sidebar (Profile select). The demo profile is installed from `profiles-seed\demo\` on the first start.

All data routes are profile-scoped: `/api/p/<id>/<route>` (health, analyze, history, stats, resumes, generate, evidence,
...) and downloads `/p/<id>/download/<file>`. Global routes hold no profile data: `/api/health`, `/api/profiles`
(create, unlock, lock, reset), `/api/fetch`, `/api/directions`, `/api/demo/reset`.

## Getting started for new users

You start with an empty store: nothing from anyone else's resumes, history or log is in the tool folder.

1. Run the server and open the page. Only the Demo profile (a fictional candidate) exists; try it to see the full flow.
   "Reset demo" restores it to the shipped state.
2. Click "Create profile": choose an id (lowercase letters, digits, dashes) and a name, and optionally a password.
3. Upload your resumes (.docx only, max 5 MB each; PDF is refused, export it to .docx or paste the text instead).
   Give each a family (for example `pm`); uploading the same family again makes the newest file the base and keeps the
   older one as lineage.
4. Review the draft profile the tool extracted (years, titles, education, certifications, tools, skills, metrics) and
   correct anything wrong. Add phrases you must never claim.
5. Choose target / neutral / avoid per direction, a seniority ceiling, the apply threshold (75) and the tailor band (20).
6. Optionally import an existing application log (markdown checklist or CSV with a `company` column; duplicates by
   company + role + date are skipped). Finish switches to your profile; ATS matching now runs only against your uploads.

Later versions: Profile settings -> "Upload new version".

## Profiles and where data lives

The tool folder holds code, `defaults\` (generic rules and keyword taxonomy) and `profiles-seed\` (the empty
`_template` and the synthetic `demo`). Every candidate's data lives in the profile store:

```
%USERPROFILE%\.jd-fit-checker\profiles\<id>\     (or $env:JDFC_HOME\profiles\<id>\)
  profile.meta.json            id, name, kind (owner | demo | user), protected flag, password hash + salts (never the password)
  config\profile.json          years, education, certs, tools/domains, evidence bank, forbidden claims, templates
  config\rules.json            optional override, deep-merged over defaults\rules.json (arrays replace)
  config\keywords-overrides.json  evidence links onto the default taxonomy + extra keywords
  config\bases.json            optional base resumes (closing sentence, swap slots; exact text from the .docx)
  config\evidence-added.json   evidence added from the My evidence page
  config\paths.json            resume folder, prefix, optional links (base map, checklist, tailor script), generator, log
  data\history.json, resume-repo.json, applications.json, uploads.json
  fixtures\jds\                optional calibration fixtures
  resumes\                     uploaded .docx files (user and demo profiles)
  tailor-runs\, reports\       transient generator files
```

`paths.json` entries resolve relative to the profile folder unless absolute, so a profile can link to resume files
elsewhere (the owner profile links to the workspace `Resume\` folder, checklist, base map and `tailor-resume.ps1`;
those files stay where they are). `generator` is `tailor-ps1` (the PowerShell script) or `builtin` (a Node generator
with the same contract); `log` is `checklist` (append to a markdown checklist) or `applications` (`data\applications.json`).

## Password protection

A profile can have a local password. Set or change it:

- CLI: `node scripts\set-password.cjs <profile>` (hidden prompt; asks the current password first when one is set).
  Restart the server afterwards so it picks up the new state.
- UI: Profile settings -> "Set / change password" (takes effect immediately), or set one in "Create profile".

When protected, every tool-owned JSON file of the profile (config, data, fixtures) is encrypted with AES-256-GCM using a
key derived from the password (scrypt). Every data route answers 423 until you unlock; "Unlock" starts a session
(HttpOnly cookie, ends after 30 idle minutes or a server restart); "Lock" ends it. 5 wrong passwords lock unlocking for
60 s, doubling per further lockout up to 15 min. The demo cannot be protected.

## Security model and limits

- Not everything is encrypted: files linked from outside the store (for the owner profile: the `Resume\` .docx files,
  the checklist and the base map), the transient `tailor-runs\` and `reports\` files, and uploaded `.docx` resumes in
  `resumes\` are NOT encrypted. Neither are the owner's relocated `tests\` and `_pre_profiles_backup\` (copies of the
  original config and data); delete `_pre_profiles_backup\` once you are satisfied with the migration.
- A local password does not protect against someone with admin access to the same machine (they can read the
  unencrypted files above or the server's memory while unlocked). The real protection against someone who downloads the
  tool is that personal data is never in the tool folder: it lives only in your profile store, and the public package
  is checked for that before it is built.
- A forgotten password cannot be recovered and neither can the encrypted data. "Reset profile" (Profile settings, typed
  confirmation) wipes the encrypted files and the password and re-seeds an empty profile; linked workspace files
  outside the store are left untouched.
- Reset also re-seeds `config\paths.json` from the empty template, so a profile with absolute links (the owner
  profile's `Resume\` folder, checklist, base map and `tailor-resume.ps1`, plus `generator`/`log`) loses those links;
  the files themselves stay where they are. Before you set a password on such a profile, keep a copy of its
  `config\paths.json` outside the store (it holds paths only and stays unencrypted there); after a reset, copy it back
  over `config\paths.json`. The `paths.json` in `_pre_profiles_backup\` is the pre-migration file (paths relative to
  the tool folder), not a drop-in replacement.

## Tests and checks

From `jd-fit-checker\`:

```powershell
node --test "test/*.test.cjs"                    # generic suite (temp profile stores) + owner-suite wrapper
node scripts\calibrate.cjs --profile demo --verbose   # calibration table for a profile's fixtures
node scripts\test-profile.cjs <id>               # a profile's own test suite (<store>\profiles\<id>\tests\)
node scripts\explain.cjs [<fixture-id>] --profile <id>   # score breakdown for a profile's fixture(s)
node scripts\smoke.cjs --profile <id> [--expect-base <name>] <public-job-url> <linkedin-job-url>   # HTTP smoke test
node scripts\hash-inputs.cjs --profile <id>      # SHA-256 of resumes, base map, checklist (run before/after)
node scripts\e2e-generate.cjs --profile <id> --fixture <fixture-id>   # ONE real generator run to a temp file, then cleans up
node scripts\package-public.cjs [--out <dir>]    # public copy + zip (see below)
```

Scripts take `--profile <id>` (else `$env:JDFC_PROFILE`, else `demo`). The owner suite runs only when a profile with a
`tests\` folder exists (a protected one needs `$env:JDFC_PASSWORD`); otherwise it is skipped. For a protected
profile, `test-profile.cjs`, `calibrate.cjs`, `explain.cjs`, `hash-inputs.cjs`, `smoke.cjs` and `e2e-generate.cjs`
unlock it from `$env:JDFC_PASSWORD` and stop with a message when it is missing or wrong (the server ignores it and
still needs an unlocked session). Fresh-machine check
(empty store, owner suite skipped, everything else passes):

```powershell
$h = Join-Path $env:TEMP "jdfc-fresh-$(Get-Random)"; New-Item -ItemType Directory $h | Out-Null
$env:JDFC_HOME = $h; node --test "test/*.test.cjs"; Remove-Item Env:JDFC_HOME; Remove-Item -Recurse -Force $h
```

Optional real-browser UI check (Node 22+, Node built-ins only). It runs the same scenarios in headless Microsoft Edge
(DevTools protocol) and headless Firefox (WebDriver BiDi), each with a fresh temporary browser profile (no
extensions). A browser that is not installed is skipped with a message. It starts its own server on port 4319 with a
temporary profile store, so your profiles are never touched, and real-clicks Analyze for: the demo profile, a locked
password-protected profile, a profile locked after the page loaded, a fresh profile with one uploaded resume, a profile
with no resumes, empty input, switching tabs and back, a short JD, a widget that fails to initialise, foreign elements
with generic ids (`id="company"`, `id="title"`, ...) injected before the page scripts (the extension-collision bug),
and storage that throws (as in some private windows). It also checks the Help tab (headings, every "Go there" button,
the verdict table following the threshold, first-visit and new-profile auto-open) and the request timeouts against a
hanging route (real 60 s and 30 s waits; `--skip-timeouts` skips them). It reports console errors, `elementFromPoint`
at the button, `disabled`, `pointer-events`, whether the click sent `POST /api/p/<id>/analyze`, and a per-browser
table. Browser processes, temp profiles and the 4319 server are always cleaned up:

```powershell
node scripts\ui-smoke.cjs [--browser edge|firefox|all] [--port 4319] [--cdp-port 9333] [--bidi-port 9334]
                          [--edge <msedge.exe>] [--firefox <firefox.exe>] [--skip-timeouts] [--keep]
node scripts\ui-smoke.cjs --attach http://127.0.0.1:4317   # read-only probe of a running server (empty-input clicks only)
```

## Packaging for another machine

`node scripts\package-public.cjs` writes `dist\jd-fit-checker-public\` and `dist\jd-fit-checker-public.zip` (forward-slash
entry names). It copies an allow-list only (server.cjs, index.html, README.md, lib, defaults, profiles-seed, test,
scripts\*.cjs without the owner-only migrate-owner.cjs and e2e-generate.cjs) and refuses (exit 1, output removed) on any
deny-list hit, any file identical to a file in a non-demo profile store, or a `config`, `data`, `dist`, `tests` or
`_pre_profiles_backup` path. Copy the zip, unzip, run `node server.cjs`. To move your own profile, copy your
`<store>\profiles\<id>\` folder separately (and fix absolute links in its `paths.json`).

## How the verdict works

- Apply threshold T (strictness) defaults to `applyThreshold` in the profile's rules (75). The sidebar slider (40-95, step 5,
  "Reset to 75") re-scores the current JD instantly; the value is kept in the browser's localStorage.
- Honest edits (one skill swap from the evidence bank into the base's swap slot, one closing-sentence swap) are built once
  and scored once. Projected fit >= T -> Tailor (light, reaches threshold). Still < T but the edits give a real benefit
  (lift >= `threshold.salvageMinLift` = 10 pts, or they add a keyword from an explicit must-have line while fit is inside
  the band) -> Tailor (salvage): the tool shows baseline vs projected vs T, the gap it cannot honestly close, and hands the
  decision back (Apply with salvaged resume / Skip / Hold). Framing-only or low-lift edits do not count as salvage.
  Otherwise Hold (T-band..T-1) or Skip (< T-band), where band = `threshold.tailorBand` (20; at T=75: Hold 55-74, Skip < 55).
- Hard gates are checked before any band logic and force Skip at every T: too senior, wrong direction, a required
  specialist platform/framework not held (SAP, Workday, ServiceNow, SAFe, ...), a required certification not held
  (CSPO, PMP, ...), a tool or domain on an explicit must-have line that is not held, or a required deep vertical.
  Already-applied roles are Skip (repeat).
- Every score row shows its "why" (the breakdown on the % fit card); the Calibration tab shows how the scoring ranks the demo fixtures.

## What it writes (only on your click)

| Action | Writes | Safety |
|---|---|---|
Paths are inside the active profile (see "Profiles and where data lives").

| Action | Writes | Safety |
|---|---|---|
| Analyze | `data\history.json` (last 500 checks) | local only |
| Generate resume | a NEW `<resumeDir>\<prefix><Role>_<Company>_<Short>.docx` via the profile's generator | never overwrites (adds `_v2`), never edits the base or a submitted copy, max 2 attempts |
| Did you apply? | one dated line in the linked checklist (`log: checklist`, timestamped `.bak` first) or an entry in `data\applications.json` | confirm dialog |
| My evidence -> Add | `config\evidence-added.json` | honesty guard must pass, `.bak` first |
| My evidence -> Update selected | bases in place (`-InPlace`, backed up first), submitted copies promoted once to `<name>_v2.docx` | preview + confirm token; submitted originals never edited; toggle off by default |
| Upload / onboarding | `resumes\<name>.docx` (`_v<n>` when taken), `data\uploads.json`, `config\profile.json`, `config\rules.json` | never overwrites a resume |
| Repository | `data\resume-repo.json` | index only |

Analysis never modifies resumes, a base map or the checklist.

## Privacy

- The only outbound request is an HTTPS GET to a job URL you paste (`/api/fetch`): http/https only, no credentials,
  standard ports, DNS-resolved and pinned, private/loopback/link-local addresses rejected, 15 s timeout, 2 MB cap,
  max 3 re-validated redirects. Nothing from resumes or config is sent.
- LinkedIn and other login-walled sites return "paste the JD text instead".
- Your history, repository and log live in your profile store, never in the tool folder; do not publish the store.
