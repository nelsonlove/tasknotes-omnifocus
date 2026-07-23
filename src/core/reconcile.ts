import type {
  ConflictLog,
  Mutation,
  OFWriteFields,
  OmniFocusTask,
  Plan,
  ReconcileConfig,
  ReconcileInput,
  Snapshot,
  TaskNote,
  TaskNotePriority,
  TaskWriteFields,
} from "./types.js";
import { parsePrimaryKey } from "./types.js";
import { composeOFNote, obsidianUri } from "./obsidian.js";
import { resolveCompletion, resolveScalarField } from "./reconcileScalar.js";

/**
 * Pure reconcile core — computes the mutation Plan for one binding.
 *
 * ALGORITHM (implement to satisfy test/reconcile.test.ts):
 *
 * For each task in input.tasks (already filtered to opted-in tasks):
 *   linkId = parsePrimaryKey(task.omnifocusUrl)
 *   if linkId and input.suppressed includes linkId -> skip entirely (loop guard).
 *
 *   A. UNLINKED (linkId == null):
 *      - If direction is "push" or "sync" AND task.inScope AND NOT task.isCompleted:
 *          emit createOFTask { taskId: task.id, project: binding.omnifocusProject,
 *                              fields: ofWriteFieldsFor(task, config) }
 *          (completed set to false on create; a done task is never created.)
 *      - Otherwise: no-op. (pull-only, out of scope, or already done.)
 *
 *   B. LINKED (linkId != null):
 *      of = input.ofTasks[linkId]; snap = input.snapshots[linkId]
 *
 *      B1. Mirror MISSING (of === undefined):
 *          The OmniFocus task was deleted in OF. v1 policy: emit clearLink { taskId }.
 *          Do NOT recreate in this run. No vault status change.
 *
 *      B2. Mirror PRESENT:
 *          - DE-SURFACE: if NOT task.inScope AND direction is "push" or "sync":
 *              config.desurface === "delete"  -> emit deleteOFTask { primaryKey: linkId } AND clearLink { taskId }
 *              config.desurface === "complete"-> emit updateOFTask { primaryKey: linkId, fields: { completed: true } }
 *              then STOP (no field reconciliation for this task).
 *            (pull-only + out of scope -> no-op; push owns de-surfacing.)
 *          - IN SCOPE: reconcile completion + scalar fields (below). Accumulate all OF field
 *            changes into ONE updateOFTask, and all vault scalar changes into ONE updateTask.
 *
 * COMPLETION (special, always bidirectional — never a ConflictLog):
 *   vaultDone = task.isCompleted; ofDone = of.completed; snapDone = snap?.isCompleted ?? false
 *   Resolve target completion:
 *     - direction "push": target = vaultDone
 *     - direction "pull": target = ofDone
 *     - direction "sync":
 *         vc = vaultDone !== snapDone; oc = ofDone !== snapDone
 *         if vc && oc     -> target = vaultDone || ofDone   (done wins - checking off sticks)
 *         else if vc      -> target = vaultDone
 *         else if oc      -> target = ofDone
 *         else            -> target = vaultDone (== ofDone == snapDone)
 *   If of.completed !== target -> add { completed: target } to the OF update.
 *   If vaultDone !== target:
 *       target === true  -> emit setStatus { taskId, status: config.doneStatus }
 *       target === false -> emit setStatus { taskId, status: config.reopenStatus }
 *   NOTE pull semantics required by tests: OF incomplete + vault done + only OF changed -> reopen to reopenStatus;
 *        OF incomplete + vault NOT done -> leave status untouched (preserves in-progress/someday).
 *
 * SCALAR FIELDS - reconcile each of: title, due, scheduled, deferred, flagged, timeEstimate, priority.
 *   (body is governed by bodyPolicy: for "create-only" it is written only on create and NEVER reconciled here.)
 *   For a field F with canonical vault value V, canonical OF value O, snapshot value S (snap?.[F]):
 *     vaultChanged = snap ? V !== S : true    // no snapshot -> treat vault as authoritative source
 *     ofChanged    = snap ? O !== S : false
 *     - direction "push": if V !== O -> write V to OF.
 *     - direction "pull": if O !== V AND (ofChanged || !snap) -> write O to vault.
 *     - direction "sync":
 *         if vaultChanged && ofChanged && V !== O:
 *             conflict. Three policies (ConflictLog always has vaultValue:V, ofValue:O):
 *               "vault-canonical" -> write V to OF,    push ConflictLog { ..., resolution: "vault" }
 *               "of-canonical"    -> write O to vault, push ConflictLog { ..., resolution: "of"   }
 *               "flag-and-hold"   -> write NOTHING to either side,
 *                                    push ConflictLog { ..., resolution: "held" }
 *         else if vaultChanged && V !== O -> write V to OF
 *         else if ofChanged && O !== V   -> write O to vault
 *         else no-op
 *   Canonical mappings:
 *     title       V=task.title            O=of.name
 *     due         V=task.due              O=of.dueDate
 *     scheduled   V=task.scheduled        O=of.plannedDate
 *     deferred    V=task.deferred         O=of.deferDate
 *     flagged     V=task.flagged          O=of.flagged
 *     timeEstimate V=task.timeEstimate    O=of.estimatedMinutes
 *     priority    V=task.priority         O=deriveOFPriority(of, config)   (snapshot field: snap.priority)
 *   "write V to OF" for a field maps to the OFWriteFields key:
 *     title->name, due->dueDate, scheduled->plannedDate, deferred->deferDate, flagged->flagged,
 *     timeEstimate->estimatedMinutes, priority-> (if priorityTags.enabled) the tag set only (see tags).
 *   "write O to vault" maps to TaskWriteFields key: name->title, dueDate->due, plannedDate->scheduled,
 *     deferDate->deferred, flagged->flagged, estimatedMinutes->timeEstimate, and priority->priority.
 *
 * PRIORITY / FLAGGED / TAGS:
 *   deriveOFPriority(of, config): if priorityTags.enabled and of.tags contains a mapped priority tag,
 *     return that level; else return of.flagged ? "high" : "none".
 *   ofTagsFor(task, config): unique list of [...task.contexts, ...task.tags]
 *     minus config.optInTag, minus every value in config.priorityTags.map,
 *     plus (priorityTags.enabled && task.priority !== "none" ? [map[task.priority]] : []).
 *   On create, OFWriteFields.tags = ofTagsFor(task, config), flagged = task.flagged (independent field).
 *   When priority changes and is written to OF, recompute (if enabled) the tag set. Priority no longer
 *   drives the flag — `flagged` is its own bidirectional scalar field (V=task.flagged, O=of.flagged).
 *   TAGS are VAULT-AUTHORITATIVE (vault -> OF only): ofTagsFor merges vault contexts + tags into one
 *   flat OF tag set, so writing that back to vault `tags` would demote contexts into tags and lose the
 *   split. The vault tag set is therefore never overwritten from OmniFocus (pull/sync never write vault
 *   tags). On sync, tags NEVER produce a ConflictLog: an OF-side tag edit is not a real conflict because
 *   the vault always wins on the next push — if the vault tag set changed vs snapshot it is pushed to OF,
 *   otherwise nothing happens. (Logging a two-sided tag change as a held/of conflict would never converge
 *   under of-canonical, re-logging the same conflict every run.) Priority is still pulled back to vault
 *   `priority` on its own (from the OF flag/tags), independent of the tag set.
 *
 * The core NEVER emits snapshot or stamp-link mutations; the executor owns snapshots and stamping
 * the omnifocus_url after a create. clearLink is the one link-related mutation the core emits.
 */
export function reconcile(input: ReconcileInput): Plan {
  const mutations: Mutation[] = [];
  const conflicts: ConflictLog[] = [];
  const { direction, tasks, ofTasks, snapshots, config, binding, suppressed = [] } = input;

  for (const task of tasks) {
    const linkId = parsePrimaryKey(task.omnifocusUrl);

    // Loop guard: skip suppressed links
    if (linkId && suppressed.includes(linkId)) {
      continue;
    }

    // A. UNLINKED
    if (linkId === null) {
      if ((direction === "push" || direction === "sync") && task.inScope && !task.isCompleted) {
        mutations.push({
          kind: "createOFTask",
          taskId: task.id,
          project: binding.omnifocusProject,
          fields: ofWriteFieldsFor(task, config),
        });
      }
      continue;
    }

    // B. LINKED
    const ofTask = ofTasks[linkId];
    const snap = snapshots[linkId];

    // B1. Mirror MISSING
    if (ofTask === undefined) {
      mutations.push({ kind: "clearLink", taskId: task.id });
      continue;
    }

    // B2. Mirror PRESENT
    // DE-SURFACE check
    if (!task.inScope && (direction === "push" || direction === "sync")) {
      if (config.desurface === "delete") {
        mutations.push({ kind: "deleteOFTask", primaryKey: linkId });
        mutations.push({ kind: "clearLink", taskId: task.id });
      } else {
        // "complete"
        mutations.push({ kind: "updateOFTask", primaryKey: linkId, fields: { completed: true } });
      }
      continue;
    }

    // Pull: out-of-scope -> no-op
    if (!task.inScope && direction === "pull") {
      continue;
    }

    // IN SCOPE: reconcile completion + scalar fields
    const ofFields: Partial<OFWriteFields> = {};
    const vaultFields: Partial<TaskWriteFields> = {};

    // --- COMPLETION ---
    reconcileCompletion(task, ofTask, snap, direction, config, ofFields, mutations);

    // --- SCALAR FIELDS ---
    reconcileScalarFields(task, ofTask, snap, direction, config, ofFields, vaultFields, conflicts, linkId);

    // Emit accumulated mutations (never emit empty update mutations)
    if (Object.keys(ofFields).length > 0) {
      mutations.push({ kind: "updateOFTask", primaryKey: linkId, fields: ofFields });
    }
    if (Object.keys(vaultFields).length > 0) {
      mutations.push({ kind: "updateTask", taskId: task.id, fields: vaultFields });
    }
  }

  return { mutations, conflicts };
}

/**
 * Compute the full OFWriteFields for a task (used on create). Exported so the plugin's structure
 * (nested-create) pass can build identical create fields — note = back-link + description + body.
 */
export function ofWriteFieldsFor(task: TaskNote, config: ReconcileConfig): OFWriteFields {
  const uri = config.obsidianVault ? obsidianUri(task.id, config.obsidianVault) : null;
  return {
    name: task.title,
    note: composeOFNote(task.body, uri, task.description),
    dueDate: task.due,
    plannedDate: task.scheduled,
    deferDate: task.deferred,
    estimatedMinutes: task.timeEstimate,
    flagged: task.flagged,
    tags: ofTagsFor(task, config),
    completed: false,
  };
}

/**
 * Derive the OmniFocus-facing tag set for a task.
 */
function ofTagsFor(task: TaskNote, config: ReconcileConfig): string[] {
  const allPriorityTagValues = Object.values(config.priorityTags.map);
  const excluded = new Set(config.excludeTags ?? []);
  const base = [...task.contexts, ...task.tags].filter(
    (t) => t !== config.optInTag && !allPriorityTagValues.includes(t) && !excluded.has(t),
  );
  // Deduplicate
  const unique = [...new Set(base)];
  if (config.priorityTags.enabled && task.priority !== "none") {
    unique.push(config.priorityTags.map[task.priority]);
  }
  return unique;
}

/**
 * Derive the TaskNotePriority from an OmniFocus task.
 */
function deriveOFPriority(ofTask: OmniFocusTask, config: ReconcileConfig): TaskNotePriority {
  if (config.priorityTags.enabled) {
    const map = config.priorityTags.map;
    for (const [level, tag] of Object.entries(map) as [Exclude<TaskNotePriority, "none">, string][]) {
      if (ofTask.tags.includes(tag)) {
        return level;
      }
    }
  }
  return ofTask.flagged ? "high" : "none";
}

/**
 * Reconcile completion state between vault, OF, and snapshot.
 */
function reconcileCompletion(
  task: TaskNote,
  ofTask: OmniFocusTask,
  snap: Snapshot | undefined,
  direction: "push" | "pull" | "sync",
  config: ReconcileConfig,
  ofFields: Partial<OFWriteFields>,
  mutations: Mutation[],
): void {
  const vaultDone = task.isCompleted;
  const ofDone = ofTask.completed;
  const snapDone = snap?.isCompleted ?? false;

  const target = resolveCompletion(vaultDone, ofDone, snapDone, direction);

  if (ofTask.completed !== target) {
    ofFields.completed = target;
  }

  if (vaultDone !== target) {
    if (target === true) {
      mutations.push({ kind: "setStatus", taskId: task.id, status: config.doneStatus });
    } else {
      mutations.push({ kind: "setStatus", taskId: task.id, status: config.reopenStatus });
    }
  }
}

/**
 * Set equality for tag arrays: same members regardless of order or duplicates.
 */
function setsEqual(a: string[], b: string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const v of sa) {
    if (!sb.has(v)) return false;
  }
  return true;
}

/**
 * Reconcile scalar fields: title, due, scheduled, deferred, flagged, timeEstimate, priority, tags.
 */
function reconcileScalarFields(
  task: TaskNote,
  ofTask: OmniFocusTask,
  snap: Snapshot | undefined,
  direction: "push" | "pull" | "sync",
  config: ReconcileConfig,
  ofFields: Partial<OFWriteFields>,
  vaultFields: Partial<TaskWriteFields>,
  conflicts: ConflictLog[],
  linkId: string,
): void {
  const ofPriority = deriveOFPriority(ofTask, config);
  const snapPriority: TaskNotePriority = snap?.priority ?? "none";

  // --- Scalar (non-set) fields ---
  type ScalarFieldDef = {
    field: string;
    V: unknown;
    O: unknown;
    S: unknown;
    writeToOF: (v: unknown) => void;
    writeToVault: (o: unknown) => void;
  };

  const scalarFieldDefs: ScalarFieldDef[] = [
    {
      field: "title",
      V: task.title,
      O: ofTask.name,
      S: snap?.title ?? task.title,
      writeToOF: (v) => { ofFields.name = v as string; },
      writeToVault: (o) => { vaultFields.title = o as string; },
    },
    {
      field: "due",
      V: task.due,
      O: ofTask.dueDate,
      S: snap?.due ?? null,
      writeToOF: (v) => { ofFields.dueDate = v as string | null; },
      writeToVault: (o) => { vaultFields.due = o as string | null; },
    },
    {
      field: "scheduled",
      V: task.scheduled,
      O: ofTask.plannedDate,
      S: snap?.scheduled ?? null,
      writeToOF: (v) => { ofFields.plannedDate = v as string | null; },
      writeToVault: (o) => { vaultFields.scheduled = o as string | null; },
    },
    {
      field: "deferred",
      V: task.deferred,
      O: ofTask.deferDate,
      S: snap?.deferred ?? null,
      writeToOF: (v) => { ofFields.deferDate = v as string | null; },
      writeToVault: (o) => { vaultFields.deferred = o as string | null; },
    },
    {
      field: "flagged",
      V: task.flagged,
      O: ofTask.flagged,
      S: snap?.flagged ?? false,
      writeToOF: (v) => { ofFields.flagged = v as boolean; },
      writeToVault: (o) => { vaultFields.flagged = o as boolean; },
    },
    {
      field: "timeEstimate",
      V: task.timeEstimate,
      O: ofTask.estimatedMinutes,
      S: snap?.timeEstimate ?? null,
      writeToOF: (v) => { ofFields.estimatedMinutes = v as number | null; },
      writeToVault: (o) => { vaultFields.timeEstimate = o as number | null; },
    },
    {
      field: "priority",
      V: task.priority,
      O: ofPriority,
      S: snapPriority,
      writeToOF: (v) => {
        // Priority drives OF priority TAGS only (handled by the tags field); it no longer
        // touches the flag — `flagged` is now an independent bidirectional field.
        void v;
      },
      writeToVault: (o) => {
        const p = o as TaskNotePriority;
        // Only write priority here; tags field handles vault tags independently.
        vaultFields.priority = p;
      },
    },
  ];

  // #10: a disabled userField mapping (blank deferField/flagField) drops that scalar entirely — never
  // read, never written either way — so a null vault value can't push a spurious clear to OmniFocus.
  const activeFieldDefs = scalarFieldDefs.filter((d) => {
    if (d.field === "deferred") return config.syncDefer !== false;
    if (d.field === "flagged") return config.syncFlag !== false;
    return true;
  });

  for (const { field, V, O, S, writeToOF, writeToVault } of activeFieldDefs) {
    const res = resolveScalarField({ V, O, S, hasSnap: !!snap, direction, config, field, linkId });
    if ("writeProject" in res) writeToOF(res.writeProject);
    if ("writeVault" in res) writeToVault(res.writeVault);
    if (res.conflict) conflicts.push(res.conflict);
  }

  // --- TAGS (set field, order-independent equality) — VAULT-AUTHORITATIVE (vault -> OmniFocus) ---
  // V = ofTagsFor(task, config) — canonical vault value (contexts + tags [+ priority tag if enabled])
  // O = ofTask.tags — current OmniFocus tag set
  // S = snap?.tags ?? [] — last-synced tag set
  //
  // Tags flow vault -> OmniFocus ONLY, never back. ofTagsFor MERGES the vault's `contexts` and `tags`
  // (plus the priority tag) into one flat OmniFocus tag set; writing that merged set back to vault
  // `tags` would demote every `context` into `tags` and permanently lose the contexts/tags split. So —
  // like priority/flag on a project node — the vault tag set is never overwritten from OmniFocus.
  //
  // Because the vault always wins, an OF-side tag change is NOT a real conflict: reconcile NEVER emits a
  // ConflictLog for tags. On sync we simply push the vault tag set to OF when it changed vs snapshot; an
  // OF-only edit is left alone (the next vault change overwrites it). Logging a two-sided tag change as a
  // held/of conflict would never converge — under of-canonical it re-logged the same conflict every run.
  const V_tags = ofTagsFor(task, config);
  const O_tags = ofTask.tags;
  const S_tags: string[] = snap?.tags ?? [];

  const vaultTagsChanged = snap ? !setsEqual(V_tags, S_tags) : true;

  const writeTagsToOF = () => { ofFields.tags = ofTagsFor(task, config); };

  if (direction === "push") {
    if (!setsEqual(V_tags, O_tags)) {
      writeTagsToOF();
    }
  } else if (direction === "pull") {
    // Vault-authoritative: vault `tags`/`contexts` are never overwritten from OmniFocus.
  } else {
    // sync — tags are vault-authoritative: push the vault tag set to OF if it changed vs snapshot;
    // never write the vault and never log a conflict (an OF-side edit is not a real conflict).
    if (vaultTagsChanged && !setsEqual(V_tags, O_tags)) {
      writeTagsToOF();
    }
  }
}
