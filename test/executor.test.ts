import { describe, it, expect, vi } from "vitest";
import { executePlan, translateToOFOps, type ExecDeps } from "../src/plugin/executor.js";
import { SyncStore } from "../src/plugin/store.js";
import type { Plan } from "../src/core/types.js";
import type { BatchResult } from "../src/adapters/omnifocus.js";
import type { OFWriteFields } from "../src/core/types.js";

const wf = (o: Partial<OFWriteFields> = {}): OFWriteFields => ({
  name: "T",
  note: null,
  dueDate: null,
  deferDate: null,
  estimatedMinutes: null,
  flagged: false,
  tags: [],
  completed: false,
  ...o,
});

const emptyBatch = (): BatchResult => ({ created: {}, updated: [], deleted: [], errors: [] });

function deps(over: { batch?: BatchResult; store?: SyncStore } = {}) {
  const applyBatch = vi.fn(async (_ops) => over.batch ?? emptyBatch());
  const update = vi.fn(async () => {});
  const setStatus = vi.fn(async () => {});
  const store = over.store ?? new SyncStore(undefined, () => 0);
  const d: ExecDeps = { omnifocus: { applyBatch }, tasknotes: { update, setStatus }, store, project: "P" };
  return { d, applyBatch, update, setStatus, store };
}

describe("translateToOFOps", () => {
  it("maps OF-side mutations to a single op list and ignores vault/link mutations", () => {
    const plan: Plan = {
      mutations: [
        { kind: "createOFTask", taskId: "t1", project: "P", fields: wf({ name: "New" }) },
        { kind: "updateOFTask", primaryKey: "pk2", fields: { completed: true } },
        { kind: "deleteOFTask", primaryKey: "pk3" },
        { kind: "updateTask", taskId: "t9", fields: { title: "x" } },
        { kind: "setStatus", taskId: "t9", status: "done" },
        { kind: "clearLink", taskId: "t9" },
      ],
      conflicts: [],
    };
    const ops = translateToOFOps(plan, "P");
    expect(ops).toHaveLength(3);
    expect(ops[0]).toMatchObject({ op: "create", ref: "t1", project: "P" });
    expect(ops[1]).toMatchObject({ op: "update", primaryKey: "pk2" });
    expect(ops[2]).toMatchObject({ op: "delete", primaryKey: "pk3" });
  });
});

describe("executePlan — creates", () => {
  it("stamps the link from BatchResult.created", async () => {
    const { d, store, applyBatch } = deps({ batch: { created: { t1: "pkNEW" }, updated: [], deleted: [], errors: [] } });
    const plan: Plan = { mutations: [{ kind: "createOFTask", taskId: "t1", project: "P", fields: wf() }], conflicts: [] };
    const res = await executePlan(plan, d);
    expect(applyBatch).toHaveBeenCalledOnce();
    expect(store.getPrimaryKey("t1")).toBe("pkNEW");
    expect(res.created.t1).toBe("pkNEW");
  });

  it("records an error when a create returns no primaryKey", async () => {
    const { d, store } = deps({ batch: { created: {}, updated: [], deleted: [], errors: [{ ref: "t1", message: "boom" }] } });
    const plan: Plan = { mutations: [{ kind: "createOFTask", taskId: "t1", project: "P", fields: wf() }], conflicts: [] };
    const res = await executePlan(plan, d);
    expect(store.getPrimaryKey("t1")).toBeUndefined();
    expect(res.errors.length).toBeGreaterThan(0);
  });
});

describe("executePlan — delete gating", () => {
  it("clears the link when the paired delete succeeded", async () => {
    const store = new SyncStore(undefined, () => 0);
    store.setLink("t1", "pkA");
    const { d } = deps({ store, batch: { created: {}, updated: [], deleted: ["pkA"], errors: [] } });
    const plan: Plan = {
      mutations: [{ kind: "deleteOFTask", primaryKey: "pkA" }, { kind: "clearLink", taskId: "t1" }],
      conflicts: [],
    };
    await executePlan(plan, d);
    expect(store.getPrimaryKey("t1")).toBeUndefined();
  });

  it("keeps the link (and errors) when the paired delete failed", async () => {
    const store = new SyncStore(undefined, () => 0);
    store.setLink("t1", "pkA");
    const { d } = deps({ store, batch: { created: {}, updated: [], deleted: [], errors: [{ primaryKey: "pkA", message: "locked" }] } });
    const plan: Plan = {
      mutations: [{ kind: "deleteOFTask", primaryKey: "pkA" }, { kind: "clearLink", taskId: "t1" }],
      conflicts: [],
    };
    const res = await executePlan(plan, d);
    expect(store.getPrimaryKey("t1")).toBe("pkA");
    expect(res.errors.length).toBeGreaterThan(0);
  });

  it("clears an unpaired (missing-mirror) clearLink unconditionally and spawns no batch", async () => {
    const store = new SyncStore(undefined, () => 0);
    store.setLink("t1", "pkA");
    const { d, applyBatch } = deps({ store });
    const plan: Plan = { mutations: [{ kind: "clearLink", taskId: "t1" }], conflicts: [] };
    await executePlan(plan, d);
    expect(applyBatch).not.toHaveBeenCalled();
    expect(store.getPrimaryKey("t1")).toBeUndefined();
  });
});

describe("executePlan — vault writes + batching", () => {
  it("routes updateTask and setStatus to the TaskNotes adapter", async () => {
    const { d, update, setStatus, applyBatch } = deps();
    const plan: Plan = {
      mutations: [
        { kind: "updateTask", taskId: "t1", fields: { title: "X" } },
        { kind: "setStatus", taskId: "t1", status: "done" },
      ],
      conflicts: [],
    };
    await executePlan(plan, d);
    expect(update).toHaveBeenCalledWith("t1", { title: "X" });
    expect(setStatus).toHaveBeenCalledWith("t1", "done");
    expect(applyBatch).not.toHaveBeenCalled();
  });

  it("issues exactly one applyBatch for all OF ops", async () => {
    const { d, applyBatch } = deps({ batch: { created: { t1: "pkNEW" }, updated: ["pk2"], deleted: ["pk3"], errors: [] } });
    const plan: Plan = {
      mutations: [
        { kind: "createOFTask", taskId: "t1", project: "P", fields: wf() },
        { kind: "updateOFTask", primaryKey: "pk2", fields: { name: "Y" } },
        { kind: "deleteOFTask", primaryKey: "pk3" },
      ],
      conflicts: [],
    };
    await executePlan(plan, d);
    expect(applyBatch).toHaveBeenCalledOnce();
    expect(applyBatch.mock.calls[0][0]).toHaveLength(3);
  });

  it("does nothing (no batch, no tn calls) for an empty plan", async () => {
    const { d, applyBatch, update, setStatus } = deps();
    const res = await executePlan({ mutations: [], conflicts: [] }, d);
    expect(applyBatch).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
    expect(res.applied).toBe(0);
  });
});
