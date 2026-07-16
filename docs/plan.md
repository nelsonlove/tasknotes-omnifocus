# tasknotes-omnifocus — implementation plan

Spec: `~/obsidian/00-09 System/04 Obsidian tooling/04.16 tasknotes-omnifocus/Requirements & design for tasknotes-omnifocus.md`

## Working method — multi-model TDD loop

Each cycle:

1. **Opus** — write/extend the type contract (`src/core/types.ts`) and the failing tests.
2. **Sonnet** — implement to pass the tests (no test edits).
3. **Run** `pnpm test` (+ `pnpm typecheck`).
4. **Fable** — evaluate the implementation against the spec; revise spec/plan where reality diverges; list follow-ups.
5. → back to Opus for the next cycle.

The type contract is authored by Opus (not Sonnet) because tests and implementation must agree on it.

## Phases

### Phase 0 — scaffold ✅
Repo, TS + esbuild + Vitest, Obsidian `manifest.json`, deps installed.

### Phase 1 — reconcile core (cycle 1) ← START HERE
Pure, no I/O. The heart of the plugin; fully test-pinnable.

- `src/core/types.ts` — data model + `reconcile(input): Plan` signature (Opus).
- `test/reconcile.test.ts` — exhaustive matrix (Opus):
  - **push**: create (tagged, in-scope, unlinked, not done) → `createOFTask`; field update; done→`completeOFTask` (in scope) vs de-surface (out of scope) → `deleteOFTask`.
  - **pull**: OF field edit → `updateTask`; OF completed → `setStatus done`; OF incomplete + vault done → `setStatus open`; OF incomplete + vault not-done → no status change (preserve in-progress/someday); OF mirror missing (deleted in OF) handling.
  - **sync/conflict**: both sides changed same field → vault-canonical wins + `ConflictLog`; completion always bidirectional; loop-guard `suppressed` skip.
  - **field mapping**: title, body(create-only), due⇄dueDate, scheduled⇄deferDate, timeEstimate⇄estimatedMinutes, priority⇄flagged(+priority tag), contexts+tags⇄OF tags (opt-in/scope tags excluded).
  - **idempotency**: no diff vs snapshot → empty plan.
- `src/core/reconcile.ts` — implementation (Sonnet).

### Phase 2 — omnifocus adapter (cycle 2)
**BATCHED transport (decided 2026-07-16, re: osascript spawn cost).** osascript is slow *per spawn* (~100–300ms), not per task, and it is the only supported write path (URL scheme is fire-and-forget; direct DB writes corrupt sync). So the adapter does at most **two spawns per sync**, independent of task count:
- `readProject(project): Promise<OmniFocusTask[]>` — ONE `evaluateJavascript` call returns every task in the bound project as a JSON array.
- `applyBatch(ops): Promise<BatchResult>` — ONE call takes ALL OmniFocus-side mutations (creates/updates/deletes) as a JSON payload, loops inside OmniJS, and returns results incl. new `primaryKey`s for creates.
- Transport is an injected `runOmniJS(source: string) => Promise<string>` so unit tests use a fake runner (no live OF in CI). Default runner writes the OmniJS to a temp file and invokes it via a tiny osascript/JXA wrapper (temp-file avoids all string-escaping of the script body; only a controlled path is embedded).
- All dates normalized through `src/core/dates.ts::canonicalDate` on the way out of the adapter (resolves the [HIGH] date-drift finding). Empty → `null`, never `""`.
- Tests (Opus): `canonicalDate` matrix; pure OmniJS builder emits a single evaluable source with a JSON payload that round-trips via `JSON.parse` (injection-safe for names with quotes/newlines/backslashes); `readProject` normalizes raw→`OmniFocusTask[]`; `applyBatch` maps ops→script and parses results (incl. create→primaryKey); runner rejection → wrapped error.
- v1.5 optimization (not now): a persistent JXA stdin/stdout helper to amortize even the 2 spawns across syncs.

### Phase 3 — tasknotes adapter (cycle 3)
**Grounded in the live OpenAPI (2026-07-16).** Real Task fields: `id`(=path), `title`, `status`(string), `priority`(string), `due`, `scheduled`, `timeEstimate`(int min), `tags[]`, `contexts[]`, `projects[]`(`[[wikilinks]]`), `details`(=body), `archived`, `dateModified`. No `isCompleted` boolean → derive from the completed-status set (`GET /api/filter-options` / status config, fetched once by the plugin). Endpoints: `POST /api/tasks/query`, `GET/PUT/DELETE /api/tasks/:id`, `POST /api/tasks/:id/toggle-status`. Responses wrapped `{success, data}`.
- **LINK STORAGE DECISION:** the OpenAPI Task schema does NOT expose arbitrary custom frontmatter, so the authoritative TaskNote↔OF link lives in the **plugin `data.json` link table** (`taskId ↔ primaryKey`), NOT in task frontmatter. The plugin populates `task.omnifocusUrl` from this table before calling `reconcile`; `stampLink`/`clearLink` mutate the table. Writing `omnifocus_url` frontmatter for click-through is optional/cosmetic (best-effort via PUT).
- **No create** in the adapter (no pull-create in v1). Only `query`, `getById`, `update`, `setStatus`.
- `src/adapters/tasknotes.ts` — typed REST client over an injected `fetch`. `normalizeTNTask` maps the real shape → core `TaskNote` (`details`→body, dates via `canonicalDate`, `isCompleted` from completed-status set, priority mapped).
- Tests (Opus): normalize mapping + date canonicalization + isCompleted derivation + priority map; `query` (POST) → normalized; `update`/`setStatus` (PUT) build correct URL+body; `{success:false}`/`!ok` → throw; fetch mocked.

### Phase 4 — plugin shell (cycle 4)
- `src/plugin/snapshot.ts` — snapshot store over `data.json`; loop-guard TTL set.
- `src/plugin/settings.ts` — bindings + policy settings tab.
- `src/plugin/executor.ts` — applies a `Plan`: runs mutations independently, stamps `omnifocus_url` after create, recomputes snapshots, collects per-item pass/fail.
- `src/plugin/main.ts` — registers `push`/`pull`/`sync`/`dry-run` commands; wires adapters → core → executor.
- Tests: executor plan-application (adapters mocked), snapshot round-trip.

### Phase 5 (v1.5) — poller + watcher
Interval `sync`; native `metadataCache.on('changed')` push-on-save; de-surface policy options; priority-tag toggle.

## Executor contract (keeps the core pure)

The core emits semantic mutations only. Snapshot bookkeeping and link-stamping are the **executor's** job:
- `createOFTask` → executor creates in OF, gets `primaryKey`, stamps `omnifocus:///task/<primaryKey>` into the task's `omnifocus_url`, then records the snapshot.
- After any applied mutation, the executor recomputes the converged per-link snapshot from post-apply state.
- The core never emits snapshot/stamp mutations — it only *reads* snapshots to detect per-field change and resolve conflicts.

## Definition of done (v1)
- reconcile core: green matrix, `pnpm typecheck` clean.
- both adapters: contract tests green.
- plugin builds (`pnpm build`), loads in Obsidian, `dry-run` prints a sane plan against a scratch OF + TaskNotes project, `sync` converges and is idempotent on a second run.

## Known gaps / cycle-1 evaluation (2026-07-16)

Evaluation of the green reconcile core. Ranked by threat to v1 correctness.

- **[HIGH] `tags` is not a first-class reconciled field.** It is only written as a side effect of a *priority* change (`reconcile.ts` scalar-field defs). Vault-only tag/context edits do not sync; OF-only tag edits do not pull back. The spec promises `contexts + tags ⇄ OF tags`. **Fix: add `tags` to the reconciled scalar/collection fields (cycle 1.5).** Canonical vault value = `ofTagsFor(task)`; canonical OF value = `of.tags`; compare as sets; on pull write `of.tags` minus mapped priority tags to `vault.tags`. Decoupling tags from priority also removes the collateral-tag-overwrite bug.
- **[HIGH] Date/null normalization is an adapter contract.** The core compares raw strings with `!==`. The **omnifocus** and **tasknotes** adapters MUST normalize dates to one canonical string form (recommend full ISO-8601 UTC, e.g. `2026-07-20T13:00:00.000Z`) and use `null` (never `""`/`undefined`) for empty, BEFORE values reach the core. Otherwise every `sync` spuriously diffs. Pin in cycle 2/3; add a normalization unit test per adapter.
- **[MED-HIGH] Resurrection of OF-deleted tasks.** Missing mirror → `clearLink` → next run recreates (unlinked + in-scope). Intended v1 behavior: the vault is the source of truth; to remove a surfaced task, complete it or drop `omnifocus/sync` in the vault, not by deleting in OF. Document in spec open-questions.
- **[MED] Executor must gate `clearLink` on `deleteOFTask` success.** Applying `clearLink` after a *failed* OF delete orphans the OF task and lets the vault recreate a duplicate. The executor applies `deleteOFTask` first and only clears the link on success. Pin for cycle 4.
- **[MED] No-snapshot freshly-linked task → vault silently wins.** With `snap === undefined`, `vaultChanged` is forced true and `ofChanged` false, so `sync` overwrites OF from the vault and discards any pre-snapshot OF edits. Acceptable default; the executor must persist a snapshot immediately after every create/apply so this window is one run at most.
- **[MED] Duplicate `primaryKey` across two TaskNotes** (copy/paste of a linked note) produces conflicting mutations against the same OF task with no dedupe. Consider a guard (skip + warn on duplicate linkId) in a later cycle.
- **[LOW] `done-wins` sync branch is unreachable** (`vc && oc` implies both equal `!snapDone`, so they agree). Harmless dead code; leave or simplify.

> Note: this evaluation was authored by the orchestrator (Opus) because the Fable evaluator model was returning 529/Overloaded at the time. Re-run a Fable pass over the core when capacity returns to cross-check these findings.

## Known gaps / cycle-2 evaluation (2026-07-16)

- **[HIGH, blocks live use] The embedded OmniJS in `omnifocus.ts` is a JXA/OmniJS hybrid.** `buildReadScript`/`buildBatchScript` mix JXA (`Application('OmniFocus')`, `.whose({...})`, `doc.defaultDocument`, `.flattenedProjects`) with OmniJS (`Task.byIdentifier`, `task.id.primaryKey()`, `of.Task({...})`). Unit tests pass because they only assert the script is a string containing the encoded payload + `JSON.stringify`; they do NOT execute it. Before the live convergence test the script body must be rewritten as **pure OmniJS** (run via `evaluateJavascript`): globals like `flattenedProjects`, `projectNamed`/iterate-by-name, `new Task(name, project)`, `Task.byIdentifier(id)`, `deleteObject(t)`, `flattenedTags`/`new Tag(name)`, `task.addTag/removeTag`, dates as JS `Date`, completion via `task.markComplete()/markIncomplete()`. This is the cycle-4b live-hardening task; catch it with a real run against a scratch OmniFocus project.
- The `defaultRunOmniJS` transport (temp-file + `osascript ... evaluateJavascript`) is untested by unit tests; verify it live and confirm it returns the script's JSON string on stdout.

## Live integration validation (2026-07-16) — v1 PASS

Ran against real OmniFocus 4 Pro + real TaskNotes REST API. Both harnesses in `a temp dir` (throwaway).

**RESOLVED [was HIGH] — OmniJS dialect.** `buildReadScript`/`buildBatchScript` rewritten as **pure OmniJS** (`flattenedProjects.find`, `task.id.primaryKey`, `task.taskStatus === Task.Status.Completed`, `new Task(name, proj.ending)`, `Task.byIdentifier`, `deleteObject`, `task.markComplete/markIncomplete`, `task.clearTags/addTag`). **RESOLVED — runner.** `defaultRunOmniJS` fixed: JXA can't `require('fs')`; now reads the temp file via the ObjC/Foundation bridge (`$.NSString.stringWithContentsOfFileEncodingError`) then `Application('OmniFocus').evaluateJavascript(src)`. Live OmniFocus test PASS: create (name/note/due/defer/estimate/flag/tags), read-back with canonical dates, complete, delete.

**FIXED [live-discovered bug] — TaskNotes id URL-encoding.** Task ids are vault paths with spaces (e.g. `My Task.md`). The adapter's `${baseUrl}/api/tasks/${id}` sent raw spaces → invalid URL. Fixed with per-segment `encodeURIComponent` (`encodeId`), which preserves the frozen test (`dir/a.md` encodes unchanged).

**Finding — `POST /api/tasks` (create) hangs / times out** (HTTP 000) while `GET`, `POST /query`, and `PUT` are instant. Not on the adapter's path (no pull-create in v1), so it doesn't affect v1. If pull-create is added later, create via MCP (`tasknotes_create_task`) or Advanced URI instead of REST POST. NOTE: the hung REST creates actually succeeded server-side (produced orphan notes) — another reason to avoid REST POST.

**Convergence test PASS** (both adapters + reconcile core + executor + sync glue, end-to-end): getById → push creates OF mirror (correct name/flag/due/priority tag) → check off in OmniFocus → sync marks the vault task done → second sync is an empty plan (idempotent). All scratch data cleaned up.

**Minor observation (not a bug):** the vault `task` tag mirrors into OmniFocus (only `omnifocus/sync` is stripped). If unwanted, add an ignore-tags setting later.

## Scoping model revision (2026-07-16) — filter-bindings → project hierarchy

**Decision:** drop the abstract `{ filter → omnifocusProject }` binding layer. Scope follows the project hierarchy both apps already have: a TaskNotes **project note** ⇄ an OmniFocus **project** of the same name; its member tasks (those whose `projects:` links to it) ⇄ tasks in that OF project. Opt-in is **project-level** (tag the project note `omnifocus/sync`, or list it in settings), with an optional per-task `omnifocus/ignore` escape hatch. "Today" surfacing is delegated to OmniFocus's native Forecast/Today perspective (fed by synced defer/due/flag) — no filter logic in the plugin. See the spec's rewritten "Scope model — project hierarchy" section.

**APPLIED 2026-07-16** (commits `3c20d56`, `98f6a25`): `src/plugin/projects.ts` (gather helpers, 7 tests), `settings.ts` (`syncedProjects` + `ignoreTag`), `main.ts` (project-membership gather + global de-surface pass), OmniJS project auto-create. Also fixed a live-discovered bug: the TaskNotes adapter must encode the **whole** id as one path segment (slash → `%2F`) — `/api/tasks/:id` captures one segment, so per-segment encoding 404s on folder-pathed ids. **Live hierarchy convergence test PASS**: synced project → members queried → OF project auto-created → push → check-off in OmniFocus round-trips to vault done (with a folder-pathed id) → idempotent. Original code delta that was applied:

**Code delta (was NOT yet applied — now done):**
- UNCHANGED: reconcile core, both adapters, executor, `store.ts`, `sync.ts::deriveSnapshot`. `buildReconcileInput` already takes `binding: { omnifocusProject }` and an explicit task set — its shape is fine; only the *caller* changes.
- CHANGE `main.ts` gather: instead of `tasknotes.query(binding.filter)`, enumerate synced projects → for each, query member tasks (`projects` contains the project note) into the matching OF project (by name; create if missing); compute de-surface candidates as linked tasks that lost membership.
- CHANGE `settings.ts`: replace the bindings-JSON textarea with a synced-projects list (+ read `omnifocus/sync`-tagged project notes); add `ignoreTag`.
- Multi-project membership: sync into the first synced project a task lists (v1 rule).
This is a gather/config-layer change only; the 85 tests stand. Estimate: one Opus (settings/gather test) + Sonnet (impl) cycle.
