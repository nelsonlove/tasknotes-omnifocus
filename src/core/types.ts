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
  /** ISO datetime or null (maps to OmniFocus defer date). */
  scheduled: string | null;
  /** Minutes, or null. */
  timeEstimate: number | null;
  priority: TaskNotePriority;
  tags: string[];
  contexts: string[];
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
  timeEstimate: number | null;
  priority: TaskNotePriority;
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
  /** Conflict winner when both sides changed the same field in a `sync`. */
  conflict: "vault-canonical" | "of-canonical";
  bodyPolicy: "create-only" | "of-canonical" | "bidirectional";
  /** What to do to the OmniFocus mirror when a task leaves scope. */
  desurface: "delete" | "complete";
  priorityTags: PriorityTagConfig;
  /** Status value written when marking a TaskNote done, e.g. "done". */
  doneStatus: string;
  /** Status value written when reopening a completed TaskNote, e.g. "open". */
  reopenStatus: string;
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
  keptValue: unknown;
  discardedValue: unknown;
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
