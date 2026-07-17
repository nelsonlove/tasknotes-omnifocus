// Enrich a project-node's OWN fields onto its OmniFocus project (and back).
//
// A TaskNotes task that has subtasks maps to an OmniFocus PROJECT (a container). This module
// reconciles the node's own actionable fields — due, scheduled(→defer), priority(→flag), completion,
// and note — against the project's own root-task fields, so a due date / flag / done-state on the
// parent surfaces in OmniFocus and round-trips. It mirrors the scalar+completion logic of the main
// reconcile core, restricted to the fields an OmniFocus project supports. NAME and TAGS are NOT
// written (the project name stays the note basename = the stable join key).

import type {
  ConflictLog,
  Direction,
  OFWriteFields,
  OmniFocusTask,
  ReconcileConfig,
  Snapshot,
  TaskNote,
  TaskWriteFields,
} from "./types.js";

export interface ProjectMetaResult {
  /** Fields to write onto the OmniFocus project (becomes an updateProject op). */
  projectFields: Partial<OFWriteFields>;
  /** Scalar fields to write back to the node's TaskNote. */
  vaultFields: Partial<TaskWriteFields>;
  /** Vault status change (config.doneStatus / config.reopenStatus), or null for none. */
  setStatus: string | null;
  conflicts: ConflictLog[];
}

/**
 * Reconcile a project-node's own fields against its OmniFocus project meta.
 *
 * Implement to satisfy test/reconcileProject.test.ts. Semantics mirror the main reconcile core:
 *
 * COMPLETION (special, always bidirectional — never a ConflictLog):
 *   vaultDone = node.isCompleted; ofDone = ofMeta.completed; snapDone = snap?.isCompleted ?? false.
 *   Resolve `target` exactly as the core does:
 *     push -> vaultDone;  pull -> ofDone;
 *     sync -> vc=(vaultDone!==snapDone), oc=(ofDone!==snapDone);
 *             vc&&oc -> vaultDone||ofDone (done-wins); else vc -> vaultDone; else oc -> ofDone; else vaultDone.
 *   If ofMeta.completed !== target -> projectFields.completed = target.
 *   If vaultDone !== target -> setStatus = (target ? config.doneStatus : config.reopenStatus).
 *
 * PRIORITY / FLAG (vault-authoritative, PUSH-ONLY): an OF project flag can only represent "high",
 *   so pulling it back would clobber a low/normal vault priority to "none". The vault drives the flag
 *   (projectFields.flagged = node.priority === "high", written when it differs) and the OF flag is
 *   NEVER written back to the vault. Skipped entirely for direction "pull".
 *
 * SCALAR FIELDS — due, scheduled. For field F with vault value V, OF value O, snapshot S:
 *   vaultChanged = snap ? V !== S : true;  ofChanged = snap ? O !== S : false.
 *     push: if V !== O -> write V to project.
 *     pull: if O !== V && (ofChanged || !snap) -> write O to vault.
 *     sync: if vaultChanged && ofChanged && V !== O -> CONFLICT, resolve by config.conflict:
 *              "vault-canonical" -> write V to project; "of-canonical" -> write O to vault;
 *              "flag-and-hold"   -> write neither.
 *            In all three push a ConflictLog { linkId: ofMeta.primaryKey, field, vaultValue:V, ofValue:O,
 *              resolution: "vault"|"of"|"held" }.
 *           else if vaultChanged && V !== O -> write V to project;
 *           else if ofChanged && O !== V -> write O to vault.
 *   Field mappings:
 *     due       V=node.due       O=ofMeta.dueDate    -> projectFields.dueDate     / vaultFields.due
 *     scheduled V=node.scheduled O=ofMeta.deferDate  -> projectFields.deferDate   / vaultFields.scheduled
 *   (priority is handled separately above — push-only; name and tags are never written.)
 *
 * NOTE (body): create-only, vault→project, one-directional. If snap === undefined (first enrich of
 *   this link) -> projectFields.note = node.body. Never overwrite thereafter; never written to vault
 *   (TaskNote bodies are not writable via the adapter).
 */
export function reconcileProjectMeta(
  node: TaskNote,
  ofMeta: OmniFocusTask,
  snap: Snapshot | undefined,
  direction: Direction,
  config: ReconcileConfig,
): ProjectMetaResult {
  const projectFields: Partial<OFWriteFields> = {};
  const vaultFields: Partial<TaskWriteFields> = {};
  let setStatus: string | null = null;
  const conflicts: ConflictLog[] = [];

  // --- COMPLETION ---
  const vaultDone = node.isCompleted;
  const ofDone = ofMeta.completed;
  const snapDone = snap?.isCompleted ?? false;

  let target: boolean;
  if (direction === "push") {
    target = vaultDone;
  } else if (direction === "pull") {
    target = ofDone;
  } else {
    // sync
    const vc = vaultDone !== snapDone;
    const oc = ofDone !== snapDone;
    if (vc && oc) {
      target = vaultDone || ofDone;
    } else if (vc) {
      target = vaultDone;
    } else if (oc) {
      target = ofDone;
    } else {
      target = vaultDone;
    }
  }

  if (ofMeta.completed !== target) {
    projectFields.completed = target;
  }
  if (vaultDone !== target) {
    setStatus = target ? config.doneStatus : config.reopenStatus;
  }

  // --- SCALAR FIELDS ---
  type FieldDef = {
    field: string;
    V: unknown;
    O: unknown;
    S: unknown;
    writeToProject: (v: unknown) => void;
    writeToVault: (o: unknown) => void;
  };

  const fieldDefs: FieldDef[] = [
    {
      field: "due",
      V: node.due,
      O: ofMeta.dueDate,
      S: snap?.due ?? null,
      writeToProject: (v) => { projectFields.dueDate = v as string | null; },
      writeToVault: (o) => { vaultFields.due = o as string | null; },
    },
    {
      field: "scheduled",
      V: node.scheduled,
      O: ofMeta.deferDate,
      S: snap?.scheduled ?? null,
      writeToProject: (v) => { projectFields.deferDate = v as string | null; },
      writeToVault: (o) => { vaultFields.scheduled = o as string | null; },
    },
  ];

  for (const { field, V, O, S, writeToProject, writeToVault } of fieldDefs) {
    const vaultChanged = snap ? V !== S : true;
    const ofChanged = snap ? O !== S : false;

    if (direction === "push") {
      if (V !== O) {
        writeToProject(V);
      }
    } else if (direction === "pull") {
      if (O !== V && (ofChanged || !snap)) {
        writeToVault(O);
      }
    } else {
      // sync
      if (vaultChanged && ofChanged && V !== O) {
        if (config.conflict === "vault-canonical") {
          writeToProject(V);
          conflicts.push({ linkId: ofMeta.primaryKey, field, vaultValue: V, ofValue: O, resolution: "vault" });
        } else if (config.conflict === "of-canonical") {
          writeToVault(O);
          conflicts.push({ linkId: ofMeta.primaryKey, field, vaultValue: V, ofValue: O, resolution: "of" });
        } else {
          // flag-and-hold: write neither
          conflicts.push({ linkId: ofMeta.primaryKey, field, vaultValue: V, ofValue: O, resolution: "held" });
        }
      } else if (vaultChanged && V !== O) {
        writeToProject(V);
      } else if (ofChanged && O !== V) {
        writeToVault(O);
      }
    }
  }

  // --- PRIORITY / FLAG (vault-authoritative, push-only) ---
  // An OmniFocus project's flag can only represent "high" — it cannot distinguish low/normal/none.
  // Pulling it back would clobber a low/normal vault priority to "none" every sync, so priority is
  // one-directional: the vault drives the flag, OF flag changes never write back to the vault.
  if (direction !== "pull") {
    const desiredFlag = node.priority === "high";
    if (ofMeta.flagged !== desiredFlag) {
      projectFields.flagged = desiredFlag;
    }
  }

  // --- NOTE (create-only, vault -> project, one-directional) ---
  if (snap === undefined) {
    projectFields.note = node.body;
  }

  return { projectFields, vaultFields, setStatus, conflicts };
}
