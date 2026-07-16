# TaskNotes ⇄ OmniFocus

An Obsidian plugin that bidirectionally syncs [TaskNotes](https://github.com/callumalpass/tasknotes) tasks with [OmniFocus](https://www.omnigroup.com/omnifocus), so tasks you author in Obsidian appear in OmniFocus (and on your iPhone via OmniFocus sync), and checking off / editing in OmniFocus flows back into your vault.

> **Status: alpha.** The sync engine is covered by an extensive test suite and validated end‑to‑end against live OmniFocus + TaskNotes, but this is early software. Try it on a scratch project first. Desktop‑only (it shells OmniAutomation via `osascript`).

## What it does

- A TaskNotes **project** ⇄ an OmniFocus **project** of the same name (auto‑created if missing); the project's tasks ⇄ the tasks inside that OmniFocus project.
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

In the plugin's settings:

- **Synced projects** — the TaskNotes project notes to sync (one per line). Each maps to an OmniFocus project of the same name.
- **Ignore tag** (default `omnifocus/ignore`) — a per‑task opt‑out.
- **Conflict policy** — `vault-canonical` (default) or `of-canonical`; completion always round‑trips regardless.
- **Body policy** — `create-only` (default: set the OmniFocus note on create, never overwrite).
- **De‑surface policy** — `delete` (default) or `complete`: what happens to the OmniFocus mirror when a task leaves scope.

Then run a command from the palette: **push**, **pull**, **sync**, or **dry‑run** (prints the plan without applying).

## How it works

The sync is a pure `reconcile(taskNotes, omnifocusTasks, snapshot, config) → Plan` core surrounded by two thin adapters (TaskNotes REST, OmniFocus OmniJS‑over‑`osascript`) and an executor. Because OmniFocus exposes no per‑task modification date, change detection uses a per‑link **snapshot** of the last‑synced field values stored in the plugin's `data.json`; conflicts (both sides changed the same field) resolve by policy, with completion always bidirectional.

## Caveats

- **No pull‑create yet** — a task typed directly into the OmniFocus Inbox (or any non‑synced project) does not create a TaskNote. Sync is anchored on the vault side.
- Runs only while Obsidian is open; there is no background daemon (a poller/watcher is planned).
- One osascript round trip per project per sync (batched — cost is per‑spawn, not per‑task).

## Roadmap

- Auto‑discover the project hierarchy (nested projects → folders/projects) with a blacklist instead of an explicit list.
- Interval poller + push‑on‑save watcher (and TaskNotes webhooks for change‑driven sync).
- Pull‑create, recurrence, dependencies.

## License

MIT
