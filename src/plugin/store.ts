import type { Snapshot } from "../core/types.js";

/** The persisted portion of plugin state (written to Obsidian data.json). */
export interface PersistedState {
  /** taskId -> OmniFocus primaryKey (the authoritative link table). */
  links: Record<string, string>;
  /** linkId (primaryKey) -> last-synced Snapshot. */
  snapshots: Record<string, Snapshot>;
}

interface SuppressionEntry {
  addedAt: number;
  ttlMs: number;
}

/**
 * In-memory sync state with (de)serialization. Suppression (loop-guard TTL) is EPHEMERAL and is
 * NOT persisted by toJSON(). `now` is injectable for deterministic TTL tests.
 */
export class SyncStore {
  private _links: Record<string, string>; // taskId -> primaryKey
  private _reverseLinks: Record<string, string>; // primaryKey -> taskId
  private _snapshots: Record<string, Snapshot>; // linkId (primaryKey) -> Snapshot
  private _suppression: Map<string, SuppressionEntry>; // linkId -> SuppressionEntry
  private _now: () => number;

  constructor(state?: Partial<PersistedState>, now?: () => number) {
    this._now = now ?? (() => Date.now());
    this._links = {};
    this._reverseLinks = {};
    this._snapshots = {};
    this._suppression = new Map();

    if (state) {
      if (state.links) {
        for (const [taskId, pk] of Object.entries(state.links)) {
          this._links[taskId] = pk;
          this._reverseLinks[pk] = taskId;
        }
      }
      if (state.snapshots) {
        for (const [linkId, snap] of Object.entries(state.snapshots)) {
          this._snapshots[linkId] = snap;
        }
      }
    }
  }

  getPrimaryKey(taskId: string): string | undefined {
    return this._links[taskId];
  }

  getTaskId(primaryKey: string): string | undefined {
    return this._reverseLinks[primaryKey];
  }

  setLink(taskId: string, primaryKey: string): void {
    // Remove old reverse mapping if this taskId already had a link
    const oldPk = this._links[taskId];
    if (oldPk !== undefined) {
      delete this._reverseLinks[oldPk];
    }
    // Remove old forward mapping if this primaryKey already had a link
    const oldTaskId = this._reverseLinks[primaryKey];
    if (oldTaskId !== undefined) {
      delete this._links[oldTaskId];
    }
    this._links[taskId] = primaryKey;
    this._reverseLinks[primaryKey] = taskId;
  }

  clearLinkByTaskId(taskId: string): void {
    const pk = this._links[taskId];
    if (pk !== undefined) {
      delete this._reverseLinks[pk];
    }
    delete this._links[taskId];
  }

  getSnapshot(linkId: string): Snapshot | undefined {
    return this._snapshots[linkId];
  }

  setSnapshot(snap: Snapshot): void {
    this._snapshots[snap.linkId] = snap;
  }

  deleteSnapshot(linkId: string): void {
    delete this._snapshots[linkId];
  }

  suppress(linkId: string, ttlMs: number): void {
    this._suppression.set(linkId, { addedAt: this._now(), ttlMs });
  }

  isSuppressed(linkId: string): boolean {
    const entry = this._suppression.get(linkId);
    if (!entry) return false;
    return this._now() < entry.addedAt + entry.ttlMs;
  }

  suppressedList(): string[] {
    const result: string[] = [];
    for (const [linkId, entry] of this._suppression) {
      if (this._now() < entry.addedAt + entry.ttlMs) {
        result.push(linkId);
      }
    }
    return result;
  }

  toJSON(): PersistedState {
    return {
      links: { ...this._links },
      snapshots: { ...this._snapshots },
    };
  }
}
