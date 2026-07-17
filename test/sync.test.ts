import { describe, it, expect } from "vitest";
import { buildReconcileInput, deriveSnapshot } from "../src/plugin/sync.js";
import { SyncStore } from "../src/plugin/store.js";
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

const task = (o: Partial<TaskNote> = {}): TaskNote => ({
  id: "t1",
  title: "T",
  body: null,
  isCompleted: false,
  status: "open",
  due: null,
  scheduled: null,
  timeEstimate: null,
  priority: "none",
  tags: [],
  contexts: [],
  projects: [],
  omnifocusUrl: null,
  inScope: true,
  ...o,
});

const of = (o: Partial<OmniFocusTask> = {}): OmniFocusTask => ({
  primaryKey: "pk1",
  name: "T",
  note: null,
  completed: false,
  dueDate: null,
  deferDate: null,
  estimatedMinutes: null,
  flagged: false,
  tags: [],
  ...o,
});

const snap = (o: Partial<Snapshot> = {}): Snapshot => ({
  linkId: "pk1",
  title: "T",
  body: null,
  isCompleted: false,
  due: null,
  scheduled: null,
  timeEstimate: null,
  priority: "none",
  flagged: false,
  tags: [],
  ...o,
});

describe("buildReconcileInput", () => {
  it("populates omnifocusUrl from the link table and forces inScope", () => {
    const store = new SyncStore(undefined, () => 0);
    store.setLink("t1", "pkA");
    const input = buildReconcileInput({
      direction: "sync",
      inScopeTasks: [task({ id: "t1", inScope: false /* should be forced true */ })],
      desurfaceTasks: [task({ id: "t2", inScope: true /* should be forced false */ })],
      ofTasks: [of({ primaryKey: "pkA" })],
      store,
      config: cfg,
      binding: { omnifocusProject: "P" },
    });
    const t1 = input.tasks.find((t) => t.id === "t1")!;
    const t2 = input.tasks.find((t) => t.id === "t2")!;
    expect(t1.omnifocusUrl).toBe("omnifocus:///task/pkA");
    expect(t1.inScope).toBe(true);
    expect(t2.omnifocusUrl).toBeNull();
    expect(t2.inScope).toBe(false);
  });

  it("keys ofTasks by primaryKey and pulls snapshots + suppression from the store", () => {
    const store = new SyncStore(undefined, () => 0);
    store.setLink("t1", "pkA");
    store.setSnapshot(snap({ linkId: "pkA", title: "prev" }));
    store.suppress("pkA", 1000);
    const input = buildReconcileInput({
      direction: "sync",
      inScopeTasks: [task({ id: "t1" })],
      desurfaceTasks: [],
      ofTasks: [of({ primaryKey: "pkA" })],
      store,
      config: cfg,
      binding: { omnifocusProject: "P" },
    });
    expect(input.ofTasks["pkA"].primaryKey).toBe("pkA");
    expect(input.snapshots["pkA"].title).toBe("prev");
    expect(input.suppressed).toContain("pkA");
    expect(input.binding.omnifocusProject).toBe("P");
    expect(input.direction).toBe("sync");
  });
});

describe("deriveSnapshot", () => {
  it("takes scalars/completion from the vault and flag/tags from OmniFocus", () => {
    const s = deriveSnapshot(
      task({ title: "V", isCompleted: true, due: "2026-07-20T09:00:00.000Z", priority: "high", tags: ["ignored"] }),
      of({ primaryKey: "pkZ", flagged: true, tags: ["a", "priority:high"] }),
      cfg,
    );
    expect(s).toEqual({
      linkId: "pkZ",
      title: "V",
      body: null,
      isCompleted: true,
      due: "2026-07-20T09:00:00.000Z",
      scheduled: null,
      timeEstimate: null,
      priority: "high",
      flagged: true,
      tags: ["a", "priority:high"],
    });
  });
});
