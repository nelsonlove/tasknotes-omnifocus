// Data model + contract for the pure reconcile core.
// Authored by Opus; tests and the Sonnet implementation both depend on these shapes.

export type TaskNotePriority = "none" | "low" | "normal" | "high";

export type Direction = "push" | "pull" | "sync";

/** A TaskNote as the reconcile core sees it (normalized subset). */
export interface TaskNote {
  /** Stable TaskNotes identifier (path or uid). */
  id: string;
  title: string;
  /** Markdown body below frontmatter, or null. */
  body: string | null;
  /** True when the task's status is any completed status. */
  isCompleted: boolean;
  /** Raw status value, e.g. "open" | "in-progress" | "done" | "someday". */
  status: string;
  /** ISO datetime or null. */
  due: string | null;
  /** ISO datetime or null (maps to OmniFocus planned date). */
  scheduled: string | null;
  /** ISO datetime or null (maps to OmniFocus defer date). TaskNotes userField. */
  deferred: string | null;
  /** Minutes, or null. */
  timeEstimate: number | null;
  priority: TaskNotePriority;
  /** Whether the task is flagged. Maps to the OmniFocus flag. TaskNotes userField. */
  flagged: boolean;
  tags: string[];
  contexts: string[];
  /**
   * Raw `projects` frontmatter links (e.g. "[[Parent]]") — the task's parent project-notes.
   * The reconcile core ignores this; the plugin's discovery uses it to build the project tree.
   */
  projects: string[];
  /**
   * Frontmatter `description` (one-line summary), or null. Not exposed by the TaskNotes API — the
   * plugin populates it from the metadata cache. Push-only: written into the OmniFocus note.
   */
  description?: string | null;
  /** `omnifocus:///task/<primaryKey>` when linked, else null. */
  omnifocusUrl: string | null;
  /** Whether the task currently satisfies its binding's filter. Computed by the caller. */
  inScope: boolean;
}

/** An OmniFocus task as read by the adapter. */
export interface OmniFocusTask {
  primaryKey: string;
  name: string;
  note: string | null;
  completed: boolean;
  /** ISO datetime or null. */
  dueDate: string | null;
  /** ISO datetime or null. */
  deferDate: string | null;
  /** ISO datetime or null. */
  plannedDate: string | null;
  estimatedMinutes: number | null;
  flagged: boolean;
  tags: string[];
}

/** Fields written when creating/updating an OmniFocus task. */
export interface OFWriteFields {
  name: string;
  note: string | null;
  dueDate: string | null;
  deferDate: string | null;
  plannedDate: string | null;
  estimatedMinutes: number | null;
  flagged: boolean;
  tags: string[];
  completed: boolean;
}

/** Fields written back to a TaskNote (scalar, non-status). */
export interface TaskWriteFields {
  title: string;
  due: string | null;
  scheduled: string | null;
  deferred: string | null;
  timeEstimate: number | null;
  priority: TaskNotePriority;
  flagged: boolean;
  tags: string[];
}

/** The last-synced canonical values for one link, keyed by primaryKey. */
export interface Snapshot {
  linkId: string;
  title: string;
  body: string | null;
  isCompleted: boolean;
  due: string | null;
  scheduled: string | null;
  deferred: string | null;
  timeEstimate: number | null;
  priority: TaskNotePriority;
  flagged: boolean;
  /** The OmniFocus-facing merged tag set last synced. */
  tags: string[];
}

export interface PriorityTagConfig {
  enabled: boolean;
  /** priority level -> OmniFocus tag name */
  map: Record<Exclude<TaskNotePriority, "none">, string>;
}

export interface ReconcileConfig {
  /** Opt-in tag, e.g. "omnifocus/sync". Excluded from the OmniFocus-facing tag set. */
  optInTag: string;
  /**
   * Tags never pushed to OmniFocus (in addition to optInTag) — e.g. the TaskNotes marker tag "task"
   * that every task carries, which would otherwise tag every OmniFocus item. Case-sensitive exact match.
   */
  excludeTags?: string[];
  /**
   * How to resolve when both sides changed the same field in a `sync`:
   *   - "vault-canonical": the vault value wins (default).
   *   - "of-canonical": the OmniFocus value wins.
   *   - "flag-and-hold": neither is written; the field is left untouched on both sides and
   *     reported as a held conflict for manual resolution (re-flagged every sync until resolved).
   */
  conflict: "vault-canonical" | "of-canonical" | "flag-and-hold";
  bodyPolicy: "create-only" | "of-canonical" | "bidirectional";
  /** What to do to the OmniFocus mirror when a task leaves scope. */
  desurface: "delete" | "complete";
  priorityTags: PriorityTagConfig;
  /** Status value written when marking a TaskNote done, e.g. "done". */
  doneStatus: string;
  /** Status value written when reopening a completed TaskNote, e.g. "open". */
  reopenStatus: string;
  /**
   * Obsidian vault name for the back-link written into the OmniFocus note (an `obsidian://open` URI).
   * null/undefined disables the back-link. Set by the plugin from `app.vault.getName()`.
   */
  obsidianVault?: string | null;
  /**
   * Whether the `deferred` ⇄ OmniFocus defer-date mapping is active. false disables it entirely (the
   * field is neither read from the vault nor reconciled to/from OmniFocus). Defaults to enabled when
   * absent. Set by the plugin from whether `deferField` is configured. (#10)
   */
  syncDefer?: boolean;
  /**
   * Whether the `flagged` ⇄ OmniFocus flag mapping is active. false disables it entirely. Defaults to
   * enabled when absent. Set by the plugin from whether `flagField` is configured. (#10)
   */
  syncFlag?: boolean;
}

export interface ReconcileInput {
  direction: Direction;
  /** Opted-in tasks (already filtered to those carrying `optInTag`). */
  tasks: TaskNote[];
  /** Existing OmniFocus mirrors keyed by primaryKey. A linked task absent here was deleted in OF. */
  ofTasks: Record<string, OmniFocusTask>;
  /** Last-synced snapshots keyed by linkId (primaryKey). */
  snapshots: Record<string, Snapshot>;
  config: ReconcileConfig;
  binding: { omnifocusProject: string };
  /** linkIds to skip this run (loop-guard TTL). */
  suppressed?: string[];
}

export type Mutation =
  | { kind: "createOFTask"; taskId: string; project: string; fields: OFWriteFields }
  | { kind: "updateOFTask"; primaryKey: string; fields: Partial<OFWriteFields> }
  | { kind: "deleteOFTask"; primaryKey: string }
  | { kind: "updateTask"; taskId: string; fields: Partial<TaskWriteFields> }
  | { kind: "setStatus"; taskId: string; status: string }
  | { kind: "clearLink"; taskId: string };

export interface ConflictLog {
  linkId: string;
  field: string;
  /** The vault's value at conflict time. */
  vaultValue: unknown;
  /** The OmniFocus value at conflict time. */
  ofValue: unknown;
  /**
   * How this conflict was resolved:
   *   - "vault": the vault value was written to OmniFocus.
   *   - "of": the OmniFocus value was written to the vault.
   *   - "held": neither was written; the field is untouched, awaiting manual resolution.
   */
  resolution: "vault" | "of" | "held";
}

export interface Plan {
  mutations: Mutation[];
  conflicts: ConflictLog[];
}

/** Parse the primaryKey out of an `omnifocus:///task/<primaryKey>` URL. Returns null if malformed. */
export function parsePrimaryKey(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/^omnifocus:\/\/\/task\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
