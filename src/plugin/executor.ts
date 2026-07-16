import type { Plan } from "../core/types.js";
import type { BatchResult, OFOp, OmniFocusAdapter } from "../adapters/omnifocus.js";
import type { TaskNotesAdapter } from "../adapters/tasknotes.js";
import type { SyncStore } from "./store.js";

export interface ExecDeps {
  omnifocus: Pick<OmniFocusAdapter, "applyBatch">;
  tasknotes: Pick<TaskNotesAdapter, "update" | "setStatus">;
  store: SyncStore;
  /** binding.omnifocusProject — used as the project for create ops. */
  project: string;
}

export interface ExecError {
  kind: string; // mutation kind
  id: string; // taskId or primaryKey
  message: string;
}

export interface ExecResult {
  applied: number;
  errors: ExecError[];
  /** taskId -> new primaryKey for created tasks (also written to store links). */
  created: Record<string, string>;
}

/**
 * Translate a reconcile Plan's OmniFocus-side mutations into a single OFOp[] batch.
 *  createOFTask -> { op:"create", ref: taskId, project, fields }
 *  updateOFTask -> { op:"update", primaryKey, fields }
 *  deleteOFTask -> { op:"delete", primaryKey }
 * (updateTask/setStatus/clearLink are NOT OmniFocus ops.)
 */
export function translateToOFOps(plan: Plan, project: string): OFOp[] {
  const ops: OFOp[] = [];
  for (const mut of plan.mutations) {
    if (mut.kind === "createOFTask") {
      ops.push({ op: "create", ref: mut.taskId, project: mut.project ?? project, fields: mut.fields });
    } else if (mut.kind === "updateOFTask") {
      ops.push({ op: "update", primaryKey: mut.primaryKey, fields: mut.fields });
    } else if (mut.kind === "deleteOFTask") {
      ops.push({ op: "delete", primaryKey: mut.primaryKey });
    }
    // updateTask / setStatus / clearLink are not OF ops
  }
  return ops;
}

/**
 * Apply a Plan. Implement to satisfy test/executor.test.ts:
 *  1. One omnifocus.applyBatch(ops) for ALL OF ops (skip the call entirely if ops is empty).
 *  2. For each create, read the new primaryKey from BatchResult.created[taskId]; on success
 *     store.setLink(taskId, pk) and add to result.created; if absent, record an error.
 *  3. clearLink handling (delete-gating):
 *       - if the plan ALSO has a deleteOFTask for that task's current primaryKey: clear the link
 *         ONLY if that primaryKey is in BatchResult.deleted (delete succeeded). If the delete
 *         errored, do NOT clear the link and record an error.
 *       - if there is NO paired delete (missing-mirror case): clear the link unconditionally.
 *  4. updateTask -> tasknotes.update(taskId, fields); setStatus -> tasknotes.setStatus(taskId, status).
 *     Each TN call is independent; collect failures into result.errors, never abort the whole plan.
 *  5. result.applied = count of successfully-applied mutations.
 */
export async function executePlan(plan: Plan, deps: ExecDeps): Promise<ExecResult> {
  const { omnifocus, tasknotes, store, project } = deps;
  const errors: ExecError[] = [];
  const created: Record<string, string> = {};
  let applied = 0;

  // Step 1: Translate all OF ops and call applyBatch once (if any)
  const ofOps = translateToOFOps(plan, project);
  let batchResult: BatchResult = { created: {}, updated: [], deleted: [], errors: [] };

  if (ofOps.length > 0) {
    batchResult = await omnifocus.applyBatch(ofOps);
  }

  // Build a set of paired deletes: for each clearLink, find the associated deleteOFTask
  // A clearLink is "paired" if there's a deleteOFTask mutation targeting the same primaryKey
  // (the primaryKey is the current store link for that taskId)
  const pairedDeletePks = new Set<string>();
  for (const mut of plan.mutations) {
    if (mut.kind === "clearLink") {
      const pk = store.getPrimaryKey(mut.taskId);
      if (pk !== undefined) {
        // Check if there is a deleteOFTask for this pk in the plan
        const hasPairedDelete = plan.mutations.some(
          (m) => m.kind === "deleteOFTask" && m.primaryKey === pk,
        );
        if (hasPairedDelete) {
          pairedDeletePks.add(pk);
        }
      }
    }
  }

  // Process each mutation
  for (const mut of plan.mutations) {
    if (mut.kind === "createOFTask") {
      const pk = batchResult.created[mut.taskId];
      if (pk) {
        store.setLink(mut.taskId, pk);
        created[mut.taskId] = pk;
        applied++;
      } else {
        // Check if there's a batch error for this ref
        const batchErr = batchResult.errors.find((e) => e.ref === mut.taskId);
        errors.push({
          kind: "createOFTask",
          id: mut.taskId,
          message: batchErr?.message ?? `Create returned no primaryKey for ${mut.taskId}`,
        });
      }
    } else if (mut.kind === "updateOFTask") {
      const wasUpdated = batchResult.updated.includes(mut.primaryKey);
      const batchErr = batchResult.errors.find((e) => e.primaryKey === mut.primaryKey);
      if (batchErr) {
        errors.push({ kind: "updateOFTask", id: mut.primaryKey, message: batchErr.message });
      } else {
        // Count as applied if no error (even if not in updated list, batch may not return it)
        applied++;
      }
      void wasUpdated; // suppress unused warning
    } else if (mut.kind === "deleteOFTask") {
      const batchErr = batchResult.errors.find((e) => e.primaryKey === mut.primaryKey);
      if (batchErr) {
        errors.push({ kind: "deleteOFTask", id: mut.primaryKey, message: batchErr.message });
      } else {
        applied++;
      }
    } else if (mut.kind === "clearLink") {
      const pk = store.getPrimaryKey(mut.taskId);
      if (pk !== undefined && pairedDeletePks.has(pk)) {
        // Paired delete — only clear if delete succeeded
        if (batchResult.deleted.includes(pk)) {
          store.clearLinkByTaskId(mut.taskId);
          applied++;
        } else {
          // Delete failed — keep the link and record an error
          const batchErr = batchResult.errors.find((e) => e.primaryKey === pk);
          errors.push({
            kind: "clearLink",
            id: mut.taskId,
            message: batchErr?.message ?? `Paired delete of ${pk} did not succeed`,
          });
        }
      } else {
        // Unpaired clearLink — clear unconditionally
        store.clearLinkByTaskId(mut.taskId);
        applied++;
      }
    } else if (mut.kind === "updateTask") {
      try {
        await tasknotes.update(mut.taskId, mut.fields);
        applied++;
      } catch (err) {
        errors.push({
          kind: "updateTask",
          id: mut.taskId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (mut.kind === "setStatus") {
      try {
        await tasknotes.setStatus(mut.taskId, mut.status);
        applied++;
      } catch (err) {
        errors.push({
          kind: "setStatus",
          id: mut.taskId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { applied, errors, created };
}

// keep types referenced for the implementer
export type { BatchResult };
