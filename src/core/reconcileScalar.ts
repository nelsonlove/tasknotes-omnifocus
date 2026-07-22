// Shared scalar/completion reconciliation mechanism.
//
// Both the task-level reconcile core (reconcile.ts) and the project-meta reconcile
// (reconcileProject.ts) need the SAME completion resolution and the SAME three-way scalar
// (vaultChanged/ofChanged + conflict/flag-and-hold) logic. This module is the single source of
// truth for that mechanism so the two call sites can't drift. It is behavior-preserving: the two
// former inline implementations were identical, and this reproduces them exactly.

import type { ConflictLog, Direction, ReconcileConfig } from "./types.js";

/**
 * Resolve the target completion state. Completion is always bidirectional and NEVER produces a
 * ConflictLog.
 *   push -> vaultDone;  pull -> ofDone;
 *   sync -> vc=(vaultDone!==snapDone), oc=(ofDone!==snapDone);
 *           vc&&oc -> vaultDone||ofDone (done-wins); vc -> vaultDone; oc -> ofDone; else vaultDone.
 */
export function resolveCompletion(
  vaultDone: boolean,
  ofDone: boolean,
  snapDone: boolean,
  direction: Direction,
): boolean {
  if (direction === "push") return vaultDone;
  if (direction === "pull") return ofDone;
  // sync
  const vc = vaultDone !== snapDone;
  const oc = ofDone !== snapDone;
  if (vc && oc) return vaultDone || ofDone; // done-wins
  if (vc) return vaultDone;
  if (oc) return ofDone;
  return vaultDone; // == ofDone == snapDone
}

export interface ScalarResolveArgs {
  /** Canonical vault value. */
  V: unknown;
  /** Canonical OmniFocus value. */
  O: unknown;
  /** Snapshot (last-synced) value. May legitimately be null even when a snapshot exists. */
  S: unknown;
  /** Whether a snapshot exists for this link — distinct from S being null. */
  hasSnap: boolean;
  direction: Direction;
  config: ReconcileConfig;
  field: string;
  linkId: string;
}

export interface ScalarResolution {
  /** Key present iff V should be written to the OmniFocus/project side; the value is V. */
  writeProject?: unknown;
  /** Key present iff O should be written to the vault side; the value is O. */
  writeVault?: unknown;
  /** A conflict to record (sync direction only). */
  conflict?: ConflictLog;
}

/**
 * The three-way scalar reconciliation shared by both reconcile paths. Given a field's vault value V,
 * OmniFocus value O, snapshot value S (and whether a snapshot exists), decide what to write and
 * whether to log a conflict.
 *
 *   vaultChanged = hasSnap ? V !== S : true    // no snapshot -> treat vault as authoritative
 *   ofChanged    = hasSnap ? O !== S : false
 *     push: if V !== O -> write V to project/OF.
 *     pull: if O !== V && (ofChanged || !hasSnap) -> write O to vault.
 *     sync: if vaultChanged && ofChanged && V !== O -> CONFLICT (resolve by config.conflict):
 *              "vault-canonical" -> write V to project/OF, resolution "vault";
 *              "of-canonical"    -> write O to vault,      resolution "of";
 *              "flag-and-hold"   -> write neither,          resolution "held".
 *           else if vaultChanged && V !== O -> write V to project/OF;
 *           else if ofChanged && O !== V   -> write O to vault.
 *
 * The caller owns the per-field mapping (which OFWriteFields / TaskWriteFields key to set) via the
 * `writeProject` / `writeVault` keys; only the decision + ConflictLog shape live here. Keys are set
 * (rather than the values returned unconditionally) so a legitimate null/false write is still detected
 * with `"writeProject" in result`.
 */
export function resolveScalarField(args: ScalarResolveArgs): ScalarResolution {
  const { V, O, S, hasSnap, direction, config, field, linkId } = args;
  const vaultChanged = hasSnap ? V !== S : true;
  const ofChanged = hasSnap ? O !== S : false;
  const result: ScalarResolution = {};

  if (direction === "push") {
    if (V !== O) result.writeProject = V;
  } else if (direction === "pull") {
    if (O !== V && (ofChanged || !hasSnap)) result.writeVault = O;
  } else {
    // sync
    if (vaultChanged && ofChanged && V !== O) {
      if (config.conflict === "vault-canonical") {
        result.writeProject = V;
        result.conflict = { linkId, field, vaultValue: V, ofValue: O, resolution: "vault" };
      } else if (config.conflict === "of-canonical") {
        result.writeVault = O;
        result.conflict = { linkId, field, vaultValue: V, ofValue: O, resolution: "of" };
      } else {
        // flag-and-hold: write nothing to either side
        result.conflict = { linkId, field, vaultValue: V, ofValue: O, resolution: "held" };
      }
    } else if (vaultChanged && V !== O) {
      result.writeProject = V;
    } else if (ofChanged && O !== V) {
      result.writeVault = O;
    }
  }

  return result;
}
