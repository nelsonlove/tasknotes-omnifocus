import { describe, it, expect } from "vitest";
import { reconcileProjectMeta } from "../src/core/reconcileProject.js";
import type { OmniFocusTask, ReconcileConfig, Snapshot, TaskNote } from "../src/core/types.js";

const cfg: ReconcileConfig = {
  optInTag: "omnifocus/sync",
  conflict: "vault-canonical",
  bodyPolicy: "create-only",
  desurface: "delete",
  priorityTags: { enabled: true, map: { low: "priority:low", normal: "priority:normal", high: "priority:high" } },
  doneStatus: "done",
  reopenStatus: "open",
};

const PK = "proj-pk";

const node = (o: Partial<TaskNote> = {}): TaskNote => ({
  id: "n.md",
  title: "Node",
  body: null,
  isCompleted: false,
  status: "open",
  due: null,
  scheduled: null,
  deferred: null,
  timeEstimate: null,
  priority: "none",
  flagged: false,
  tags: [],
  contexts: [],
  projects: [],
  omnifocusUrl: null,
  inScope: true,
  ...o,
});

const meta = (o: Partial<OmniFocusTask> = {}): OmniFocusTask => ({
  primaryKey: PK,
  name: "Node",
  note: null,
  completed: false,
  dueDate: null,
  deferDate: null,
  plannedDate: null,
  estimatedMinutes: null,
  flagged: false,
  tags: [],
  ...o,
});

const snap = (o: Partial<Snapshot> = {}): Snapshot => ({
  linkId: PK,
  title: "Node",
  body: null,
  isCompleted: false,
  due: null,
  scheduled: null,
  deferred: null,
  timeEstimate: null,
  priority: "none",
  flagged: false,
  tags: [],
  ...o,
});

describe("reconcileProjectMeta — scalars", () => {
  it("push: writes the node's due/defer/flag onto the project", () => {
    const r = reconcileProjectMeta(
      node({ due: "2026-08-01T00:00:00.000Z", scheduled: "2026-07-20T00:00:00.000Z", priority: "high" }),
      meta(),
      undefined,
      "push",
      cfg,
    );
    expect(r.projectFields.dueDate).toBe("2026-08-01T00:00:00.000Z");
    expect(r.projectFields.deferDate).toBe("2026-07-20T00:00:00.000Z");
    expect(r.projectFields.flagged).toBe(true);
  });

  it("never writes name or tags to the project", () => {
    const r = reconcileProjectMeta(node({ title: "Different", tags: ["x"], due: "2026-08-01T00:00:00.000Z" }), meta(), undefined, "push", cfg);
    expect(r.projectFields.name).toBeUndefined();
    expect(r.projectFields.tags).toBeUndefined();
  });

  it("pull: writes an OF project due change back to the vault", () => {
    const r = reconcileProjectMeta(
      node({ due: "2026-01-01T00:00:00.000Z" }),
      meta({ dueDate: "2026-09-09T00:00:00.000Z" }),
      snap({ due: "2026-01-01T00:00:00.000Z" }),
      "pull",
      cfg,
    );
    expect(r.vaultFields.due).toBe("2026-09-09T00:00:00.000Z");
    expect(r.projectFields.dueDate).toBeUndefined();
  });

  it("sync conflict resolves vault-canonical and logs it", () => {
    const r = reconcileProjectMeta(
      node({ due: "2026-08-01T00:00:00.000Z" }),
      meta({ dueDate: "2026-09-09T00:00:00.000Z" }),
      snap({ due: "2026-01-01T00:00:00.000Z" }),
      "sync",
      cfg,
    );
    expect(r.projectFields.dueDate).toBe("2026-08-01T00:00:00.000Z");
    expect(r.conflicts).toEqual([
      { linkId: PK, field: "due", vaultValue: "2026-08-01T00:00:00.000Z", ofValue: "2026-09-09T00:00:00.000Z", resolution: "vault" },
    ]);
  });

  it("push: maps high priority to the project flag", () => {
    const r = reconcileProjectMeta(node({ priority: "high" }), meta({ flagged: false }), snap({ priority: "high" }), "push", cfg);
    expect(r.projectFields.flagged).toBe(true);
  });

  it("NEVER writes priority back to the vault (OF flag can't represent low/normal) — no clobber", () => {
    // low-priority node, OF flag off, snapshot low: the naive bidirectional path would write "none".
    const r = reconcileProjectMeta(
      node({ priority: "low" }),
      meta({ flagged: false }),
      snap({ priority: "low" }),
      "sync",
      cfg,
    );
    expect(r.vaultFields.priority).toBeUndefined();
    // and it must not spuriously flip the flag (low !== high, flag already false)
    expect(r.projectFields.flagged).toBeUndefined();
  });

  it("pull: does not touch vault priority from the OF flag", () => {
    const r = reconcileProjectMeta(node({ priority: "normal" }), meta({ flagged: false }), snap({ priority: "normal" }), "pull", cfg);
    expect(r.vaultFields.priority).toBeUndefined();
  });

  it("sync conflict with flag-and-hold writes neither side", () => {
    const r = reconcileProjectMeta(
      node({ due: "2026-08-01T00:00:00.000Z" }),
      meta({ dueDate: "2026-09-09T00:00:00.000Z" }),
      snap({ due: "2026-01-01T00:00:00.000Z" }),
      "sync",
      { ...cfg, conflict: "flag-and-hold" },
    );
    expect(r.projectFields.dueDate).toBeUndefined();
    expect(r.vaultFields.due).toBeUndefined();
    expect(r.conflicts[0].resolution).toBe("held");
  });
});

describe("reconcileProjectMeta — completion", () => {
  it("push: completing the vault node completes the OF project", () => {
    const r = reconcileProjectMeta(node({ isCompleted: true, status: "done" }), meta({ completed: false }), snap(), "sync", cfg);
    expect(r.projectFields.completed).toBe(true);
    expect(r.setStatus).toBeNull(); // node already done
  });

  it("pull: completing the OF project marks the vault node done", () => {
    const r = reconcileProjectMeta(node({ isCompleted: false }), meta({ completed: true }), snap({ isCompleted: false }), "sync", cfg);
    expect(r.setStatus).toBe("done");
    expect(r.projectFields.completed).toBeUndefined(); // OF already done
  });

  it("reopens the vault node when the OF project is reactivated", () => {
    const r = reconcileProjectMeta(
      node({ isCompleted: true, status: "done" }),
      meta({ completed: false }),
      snap({ isCompleted: true }),
      "sync",
      cfg,
    );
    expect(r.setStatus).toBe("open");
  });
});

describe("reconcileProjectMeta — note (create-only)", () => {
  it("sets the project note from the node body on first enrich (no snapshot)", () => {
    const r = reconcileProjectMeta(node({ body: "the plan" }), meta(), undefined, "sync", cfg);
    expect(r.projectFields.note).toBe("the plan");
  });

  it("does not touch the note once a snapshot exists", () => {
    const r = reconcileProjectMeta(node({ body: "changed" }), meta({ note: "old" }), snap(), "sync", cfg);
    expect(r.projectFields.note).toBeUndefined();
  });
});
