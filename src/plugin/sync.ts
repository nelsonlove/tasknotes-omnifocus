import type {
  Direction,
  OmniFocusTask,
  ReconcileConfig,
  ReconcileInput,
  Snapshot,
  TaskNote,
} from "../core/types.js";
import type { SyncStore } from "./store.js";

export interface BuildInputArgs {
  direction: Direction;
  /** Tasks returned by the scope-filter query (inScope forced true). */
  inScopeTasks: TaskNote[];
  /** Linked tasks that fell OUT of scope, needing de-surface (inScope forced false). */
  desurfaceTasks: TaskNote[];
  ofTasks: OmniFocusTask[];
  store: SyncStore;
  config: ReconcileConfig;
  binding: { omnifocusProject: string };
}

/**
 * Assemble a ReconcileInput from gathered state. Implement to satisfy test/sync.test.ts:
 *  - For every task (in-scope and de-surface), set `omnifocusUrl` from the store link table:
 *      pk = store.getPrimaryKey(task.id); omnifocusUrl = pk ? `omnifocus:///task/${pk}` : null.
 *  - Force inScope = true on inScopeTasks, false on desurfaceTasks.
 *  - tasks = [...inScopeTasks, ...desurfaceTasks].
 *  - ofTasks -> Record keyed by primaryKey.
 *  - snapshots -> Record of store.getSnapshot(pk) for every linked task that has one.
 *  - suppressed -> store.suppressedList().
 */
export function buildReconcileInput(args: BuildInputArgs): ReconcileInput {
  const { direction, inScopeTasks, desurfaceTasks, ofTasks, store, config, binding } = args;

  // Build snapshots record — keyed by primaryKey for every linked task that has a snapshot
  const snapshots: Record<string, Snapshot> = {};

  // Process inScopeTasks — force inScope=true, set omnifocusUrl from store
  const mappedInScope: TaskNote[] = inScopeTasks.map((task) => {
    const pk = store.getPrimaryKey(task.id);
    const omnifocusUrl = pk ? `omnifocus:///task/${pk}` : null;
    if (pk) {
      const snap = store.getSnapshot(pk);
      if (snap) {
        snapshots[pk] = snap;
      }
    }
    return { ...task, omnifocusUrl, inScope: true };
  });

  // Process desurfaceTasks — force inScope=false, set omnifocusUrl from store
  const mappedDesurface: TaskNote[] = desurfaceTasks.map((task) => {
    const pk = store.getPrimaryKey(task.id);
    const omnifocusUrl = pk ? `omnifocus:///task/${pk}` : null;
    if (pk) {
      const snap = store.getSnapshot(pk);
      if (snap) {
        snapshots[pk] = snap;
      }
    }
    return { ...task, omnifocusUrl, inScope: false };
  });

  // Build ofTasks record keyed by primaryKey
  const ofTasksRecord: Record<string, OmniFocusTask> = {};
  for (const ofTask of ofTasks) {
    ofTasksRecord[ofTask.primaryKey] = ofTask;
  }

  return {
    direction,
    tasks: [...mappedInScope, ...mappedDesurface],
    ofTasks: ofTasksRecord,
    snapshots,
    config,
    binding,
    suppressed: store.suppressedList(),
  };
}

/**
 * Derive the post-sync Snapshot for a converged (task, ofTask) pair. Vault side is authoritative
 * for scalars/completion; OmniFocus side is authoritative for the OF-facing flag + tag set.
 *  linkId: ofTask.primaryKey
 *  title/body/isCompleted/due/scheduled/timeEstimate/priority <- task.*
 *  flagged <- ofTask.flagged
 *  tags <- ofTask.tags
 */
export function deriveSnapshot(task: TaskNote, ofTask: OmniFocusTask, _config: ReconcileConfig): Snapshot {
  return {
    linkId: ofTask.primaryKey,
    title: task.title,
    body: task.body,
    isCompleted: task.isCompleted,
    due: task.due,
    scheduled: task.scheduled,
    timeEstimate: task.timeEstimate,
    priority: task.priority,
    flagged: ofTask.flagged,
    tags: ofTask.tags,
  };
}
