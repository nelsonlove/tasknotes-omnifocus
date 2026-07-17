# TaskNotes ⇄ OmniFocus

An Obsidian plugin that bidirectionally syncs [TaskNotes](https://github.com/callumalpass/tasknotes) tasks with [OmniFocus](https://www.omnigroup.com/omnifocus), so tasks you author in Obsidian appear in OmniFocus (and on your iPhone via OmniFocus sync), and checking off / editing in OmniFocus flows back into your vault.

> **Status: alpha.** The sync engine is covered by an extensive test suite and validated end‑to‑end against live OmniFocus + TaskNotes, but this is early software. Try it on a scratch project first. Desktop‑only (it shells OmniAutomation via `osascript`).

## What it does

- **Mirrors your whole TaskNotes project hierarchy into OmniFocus, automatically.** TaskNotes' project structure is the inverse of the `projects` field (if task B lists task A as a project, A has subtask B). The plugin walks that tree and maps it to OmniFocus **folders and projects**: a project‑note with sub‑projects becomes a folder, a project‑note with tasks becomes a project holding them, and a project‑note with both becomes a folder plus a same‑named project for its loose tasks. Missing folders/projects are created on sync.
- **A task that itself has subtasks keeps its own fields.** Such a task becomes an OmniFocus project (containers can't be tasks), but its own due date, defer date, flag, note, and completion are carried onto that project and round‑trip — so a due date on a task-with-subtasks still shows up in OmniFocus's Forecast, and completing the project checks off the task (and vice‑versa).
- **Opt‑out, not opt‑in.** Everything is synced by default; add the ignore tag (`omnifocus/ignore`) to a project note to exclude it *and its entire subtree*, or to a single task to exclude just that task. Archived tasks are never synced.
- **Round‑trips** title, due (→ due date), scheduled (→ defer date), time estimate, priority (→ flag + optional `priority:*` tag), tags/contexts, and completion. Checking a task off in either app marks it done in the other.
- **"What's due today" is left to OmniFocus** — because due/defer/flag are synced, OmniFocus's own Forecast / Today / flagged perspectives surface your day. The plugin mirrors structure; OmniFocus does the surfacing.
- **Obsidian stays the source of truth.** All vault writes go through the TaskNotes API, and all OmniFocus writes go through OmniAutomation, so neither app's sync is fought.

## Requirements

- **OmniFocus 4 Pro** (OmniAutomation is a Pro feature), installed and running.
- **TaskNotes** with its HTTP API enabled (default `http://localhost:8080`).
- Desktop Obsidian (macOS).

## Install (via BRAT)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) community plugin.
2. BRAT → *Add beta plugin* → `nelsonlove/tasknotes-omnifocus`.
3. Enable **TaskNotes ⇄ OmniFocus** in *Settings → Community plugins*.

## Configure

The whole project hierarchy is discovered and synced automatically — there is no per‑project list to maintain. In the plugin's settings:

- **Ignore tag** (default `omnifocus/ignore`) — add it to a project note to exclude that note and its entire subtree, or to a single task to exclude just that task.
- **Conflict policy** — what happens when both sides changed the *same* field between syncs: `vault-canonical` (default, vault wins), `of-canonical` (OmniFocus wins), or `flag-and-hold` (leave both untouched and report the conflict, re‑flagged each sync until you resolve it by hand). Non‑overlapping edits merge automatically regardless, and completion always round‑trips.
- **Body policy** — `create-only` (default: set the OmniFocus note on create, never overwrite).
- **De‑surface policy** — `delete` (default) or `complete`: what happens to the OmniFocus mirror when a task leaves scope.

Then run a command from the palette: **push**, **pull**, **sync**, or **dry‑run** (prints the plan without applying).

## How it works

The sync is a pure `reconcile(taskNotes, omnifocusTasks, snapshot, config) → Plan` core surrounded by two thin adapters (TaskNotes REST, OmniFocus OmniJS‑over‑`osascript`) and an executor. Because OmniFocus exposes no per‑task modification date, change detection uses a per‑link **snapshot** of the last‑synced field values stored in the plugin's `data.json`; conflicts (both sides changed the same field) resolve by policy, with completion always bidirectional.

## Caveats

- **No pull‑create yet** — a task typed directly into the OmniFocus Inbox (or any non‑synced project) does not create a TaskNote. Sync is anchored on the vault side.
- Runs only while Obsidian is open; there is no background daemon (a poller/watcher is planned).
- Because the whole vault is in scope by default, the **first** sync can create a lot of structure. Use **dry‑run** first to preview, and the ignore tag to carve out anything you don't want mirrored.
- Structure is ensured in one osascript spawn; then one read spawn per project that has tasks (batched — cost is per‑spawn, not per‑task). A single read‑all pass is planned.
- Projects are matched by **name**; two project notes with the same title collide onto one OmniFocus project (id‑based matching is planned).

## Roadmap

- One read‑all pass instead of per‑project reads; id‑based project matching.
- Interval poller + push‑on‑save watcher (and TaskNotes webhooks for change‑driven sync).
- Pull‑create, recurrence, dependencies.

## License

MIT
