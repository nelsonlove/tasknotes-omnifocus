import { describe, it, expect } from "vitest";
import { reconcile } from "../src/core/reconcile.js";
import type {
  Mutation,
  OmniFocusTask,
  Plan,
  ReconcileConfig,
  ReconcileInput,
  Snapshot,
  TaskNote,
} from "../src/core/types.js";

// ---------- fixtures ----------

const cfg: ReconcileConfig = {
  optInTag: "omnifocus/sync",
  conflict: "vault-canonical",
  bodyPolicy: "create-only",
  desurface: "delete",
  priorityTags: {
    enabled: true,
    map: { low: "priority:low", normal: "priority:normal", high: "priority:high" },
  },
  doneStatus: "done",
  reopenStatus: "open",
};

const PK = "pk1";
const OFURL = `omnifocus:///task/${PK}`;

function task(o: Partial<TaskNote> = {}): TaskNote {
  return {
    id: "t1",
    title: "T",
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
  };
}

function of(o: Partial<OmniFocusTask> = {}): OmniFocusTask {
  return {
    primaryKey: PK,
    name: "T",
    note: null,
    completed: false,
    dueDate: null,
    deferDate: null,
    plannedDate: null,
    estimatedMinutes: null,
    flagged: false,
    tags: [],
    ...o,
  };
}

function snap(o: Partial<Snapshot> = {}): Snapshot {
  return {
    linkId: PK,
    title: "T",
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
  };
}

function input(o: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    direction: "sync",
    tasks: [],
    ofTasks: {},
    snapshots: {},
    config: cfg,
    binding: { omnifocusProject: "P" },
    suppressed: [],
    ...o,
  };
}

// ---------- helpers ----------

function byKind<K extends Mutation["kind"]>(
  plan: Plan,
  kind: K,
): Extract<Mutation, { kind: K }>[] {
  return plan.mutations.filter((m): m is Extract<Mutation, { kind: K }> => m.kind === kind);
}
const sortedTags = (t: string[] | undefined) => [...(t ?? [])].sort();

// A linked, in-scope task whose OF mirror + snapshot all match (the converged baseline).
function converged(over: {
  t?: Partial<TaskNote>;
  o?: Partial<OmniFocusTask>;
  s?: Partial<Snapshot>;
} = {}) {
  const t = task({ omnifocusUrl: OFURL, ...over.t });
  const o = of({ ...over.o });
  const s = snap({ ...over.s });
  return input({ tasks: [t], ofTasks: { [PK]: o }, snapshots: { [PK]: s } });
}

// =====================================================================
describe("push — create", () => {
  it("creates an OF task for a tagged, in-scope, incomplete, unlinked task", () => {
    const plan = reconcile(input({ direction: "push", tasks: [task()] }));
    const creates = byKind(plan, "createOFTask");
    expect(creates).toHaveLength(1);
    expect(creates[0].project).toBe("P");
    expect(creates[0].taskId).toBe("t1");
    expect(creates[0].fields.name).toBe("T");
    expect(creates[0].fields.completed).toBe(false);
  });

  it("writes the body on create (create-only body policy)", () => {
    const plan = reconcile(input({ direction: "push", tasks: [task({ body: "hello" })] }));
    expect(byKind(plan, "createOFTask")[0].fields.note).toBe("hello");
  });

  it("prepends an Obsidian back-link to the note when obsidianVault is set", () => {
    const inp = input({ direction: "push", tasks: [task({ id: "Dir/My Task.md", body: "hello" })] });
    inp.config = { ...cfg, obsidianVault: "obsidian" };
    const note = byKind(reconcile(inp), "createOFTask")[0].fields.note;
    expect(note).toBe("obsidian://open?vault=obsidian&file=Dir%2FMy%20Task\n\nhello");
  });

  it("maps due→dueDate, scheduled→plannedDate, deferred→deferDate, timeEstimate→estimatedMinutes, flagged→flagged, priority high→tag", () => {
    const t = task({
      due: "2026-07-20T09:00:00",
      scheduled: "2026-07-18T09:00:00",
      deferred: "2026-07-17T09:00:00",
      timeEstimate: 30,
      priority: "high",
      flagged: true,
    });
    const f = reconcile(input({ direction: "push", tasks: [t] })).mutations[0];
    expect(f.kind).toBe("createOFTask");
    if (f.kind !== "createOFTask") throw new Error();
    expect(f.fields.dueDate).toBe("2026-07-20T09:00:00");
    expect(f.fields.plannedDate).toBe("2026-07-18T09:00:00");
    expect(f.fields.deferDate).toBe("2026-07-17T09:00:00");
    expect(f.fields.estimatedMinutes).toBe(30);
    expect(f.fields.flagged).toBe(true);
    expect(sortedTags(f.fields.tags)).toContain("priority:high");
  });

  it("does not flag an OF task on create just because priority is high (flag is decoupled)", () => {
    const t = task({ priority: "high", flagged: false });
    const f = reconcile(input({ direction: "push", tasks: [t] })).mutations[0];
    if (f.kind !== "createOFTask") throw new Error();
    expect(f.fields.flagged).toBe(false);
    expect(sortedTags(f.fields.tags)).toContain("priority:high");
  });

  it("excludes the opt-in tag and merges contexts into OF tags", () => {
    const t = task({ tags: ["a", "omnifocus/sync"], contexts: ["@home"] });
    const f = reconcile(input({ direction: "push", tasks: [t] })).mutations[0];
    if (f.kind !== "createOFTask") throw new Error();
    expect(sortedTags(f.fields.tags)).toEqual(["@home", "a"]);
  });

  it("drops excludeTags (e.g. the TaskNotes 'task' marker) from the OF tag set", () => {
    const inp = input({ direction: "push", tasks: [task({ tags: ["task", "keep"] })] });
    inp.config = { ...cfg, excludeTags: ["task"] };
    const f = reconcile(inp).mutations[0];
    if (f.kind !== "createOFTask") throw new Error();
    expect(sortedTags(f.fields.tags)).toEqual(["keep"]);
  });

  it("does not create for a completed unlinked task", () => {
    const plan = reconcile(input({ direction: "push", tasks: [task({ isCompleted: true, status: "done" })] }));
    expect(plan.mutations).toHaveLength(0);
  });

  it("does not create for an out-of-scope unlinked task", () => {
    const plan = reconcile(input({ direction: "push", tasks: [task({ inScope: false })] }));
    expect(plan.mutations).toHaveLength(0);
  });
});

describe("push — update is vault-authoritative", () => {
  it("overwrites OF when the vault value differs, ignoring OF-side changes", () => {
    const inp = converged({ t: { title: "T" }, o: { name: "X" }, s: { title: "T" } });
    inp.direction = "push";
    const ups = byKind(reconcile(inp), "updateOFTask");
    expect(ups).toHaveLength(1);
    expect(ups[0].fields.name).toBe("T");
  });

  it("batches multiple OF field changes into one updateOFTask", () => {
    const inp = converged({
      t: { title: "NEW", due: "2026-07-20T09:00:00" },
      o: { name: "T", dueDate: null },
      s: { title: "T", due: null },
    });
    inp.direction = "push";
    const ups = byKind(reconcile(inp), "updateOFTask");
    expect(ups).toHaveLength(1);
    expect(ups[0].fields.name).toBe("NEW");
    expect(ups[0].fields.dueDate).toBe("2026-07-20T09:00:00");
  });
});

// =====================================================================
describe("pull", () => {
  it("writes an OF field edit back to the vault", () => {
    const inp = converged({ t: { title: "T" }, o: { name: "X" }, s: { title: "T" } });
    inp.direction = "pull";
    const ups = byKind(reconcile(inp), "updateTask");
    expect(ups).toHaveLength(1);
    expect(ups[0].fields.title).toBe("X");
  });

  it("marks the TaskNote done when the OF task is completed", () => {
    const inp = converged({ t: { isCompleted: false }, o: { completed: true }, s: { isCompleted: false } });
    inp.direction = "pull";
    const ss = byKind(reconcile(inp), "setStatus");
    expect(ss).toHaveLength(1);
    expect(ss[0].status).toBe("done");
  });

  it("reopens a done TaskNote when the OF task is incomplete", () => {
    const inp = converged({
      t: { isCompleted: true, status: "done" },
      o: { completed: false },
      s: { isCompleted: false },
    });
    inp.direction = "pull";
    const ss = byKind(reconcile(inp), "setStatus");
    expect(ss).toHaveLength(1);
    expect(ss[0].status).toBe("open");
  });

  it("leaves a non-done status untouched when the OF task is incomplete (preserves in-progress)", () => {
    const inp = converged({
      t: { isCompleted: false, status: "in-progress" },
      o: { completed: false },
      s: { isCompleted: false },
    });
    inp.direction = "pull";
    expect(byKind(reconcile(inp), "setStatus")).toHaveLength(0);
  });

  it("does not revert a vault-only change (pull never writes OF, never overwrites vault)", () => {
    const inp = converged({ t: { title: "NEW" }, o: { name: "T" }, s: { title: "T" } });
    inp.direction = "pull";
    expect(reconcile(inp).mutations).toHaveLength(0);
  });

  it("derives priority from an OF flag", () => {
    const inp = converged({ t: { priority: "none" }, o: { flagged: true }, s: { priority: "none", flagged: false } });
    inp.direction = "pull";
    const ups = byKind(reconcile(inp), "updateTask");
    expect(ups).toHaveLength(1);
    expect(ups[0].fields.priority).toBe("high");
  });

  it("does not de-surface out-of-scope tasks on pull", () => {
    const inp = converged({ t: { inScope: false } });
    inp.direction = "pull";
    expect(reconcile(inp).mutations).toHaveLength(0);
  });
});

// =====================================================================
describe("sync — conflict resolution", () => {
  it("vault-canonical: both sides changed a field -> vault wins, conflict logged", () => {
    const inp = converged({ t: { title: "V" }, o: { name: "O" }, s: { title: "S" } });
    const plan = reconcile(inp);
    expect(byKind(plan, "updateOFTask")[0].fields.name).toBe("V");
    expect(byKind(plan, "updateTask")).toHaveLength(0);
    expect(plan.conflicts).toEqual([
      { linkId: PK, field: "title", vaultValue: "V", ofValue: "O", resolution: "vault" },
    ]);
  });

  it("of-canonical: both sides changed -> OF wins, conflict logged", () => {
    const inp = converged({ t: { title: "V" }, o: { name: "O" }, s: { title: "S" } });
    inp.config = { ...cfg, conflict: "of-canonical" };
    const plan = reconcile(inp);
    expect(byKind(plan, "updateTask")[0].fields.title).toBe("O");
    expect(byKind(plan, "updateOFTask")).toHaveLength(0);
    expect(plan.conflicts[0]).toMatchObject({ field: "title", vaultValue: "V", ofValue: "O", resolution: "of" });
  });

  it("flag-and-hold: both sides changed -> neither written, conflict held", () => {
    const inp = converged({ t: { title: "V" }, o: { name: "O" }, s: { title: "S" } });
    inp.config = { ...cfg, conflict: "flag-and-hold" };
    const plan = reconcile(inp);
    // Neither side is touched for the conflicted field.
    expect(byKind(plan, "updateOFTask")).toHaveLength(0);
    expect(byKind(plan, "updateTask")).toHaveLength(0);
    expect(plan.conflicts).toEqual([
      { linkId: PK, field: "title", vaultValue: "V", ofValue: "O", resolution: "held" },
    ]);
  });

  it("flag-and-hold: still applies a NON-conflicting field on the same task", () => {
    // title conflicts (both changed); due changed on the vault side only -> should still push.
    const inp = converged({
      t: { title: "V", due: "2026-08-01T00:00:00.000Z" },
      o: { name: "O", dueDate: "2026-01-01T00:00:00.000Z" },
      s: { title: "S", due: "2026-01-01T00:00:00.000Z" },
    });
    inp.config = { ...cfg, conflict: "flag-and-hold" };
    const plan = reconcile(inp);
    const ups = byKind(plan, "updateOFTask");
    expect(ups).toHaveLength(1);
    expect(ups[0].fields.dueDate).toBe("2026-08-01T00:00:00.000Z");
    expect(ups[0].fields.name).toBeUndefined(); // held title not written
    expect(plan.conflicts).toEqual([
      { linkId: PK, field: "title", vaultValue: "V", ofValue: "O", resolution: "held" },
    ]);
  });

  it("flag-and-hold: a two-sided tag change is NOT held — tags are vault-authoritative (push vault→OF, no conflict, no vault write)", () => {
    const inp = converged({ t: { tags: ["v"] }, o: { tags: ["o"] }, s: { tags: ["s"] } });
    inp.config = { ...cfg, conflict: "flag-and-hold" };
    const plan = reconcile(inp);
    const ups = byKind(plan, "updateOFTask");
    expect(ups).toHaveLength(1);
    expect(sortedTags(ups[0].fields.tags)).toEqual(["v"]);
    expect(byKind(plan, "updateTask")).toHaveLength(0);
    expect(plan.conflicts.some((c) => c.field === "tags")).toBe(false);
  });

  it("of-canonical: a two-sided tag change still pushes vault→OF (vault-authoritative), no conflict, no vault write", () => {
    // Regression: of-canonical previously logged a tags conflict every run while writing nothing to the
    // vault, so under of-canonical it never converged. Tags are vault-authoritative — vault wins, no log.
    const inp = converged({ t: { tags: ["v"] }, o: { tags: ["o"] }, s: { tags: ["s"] } });
    inp.config = { ...cfg, conflict: "of-canonical" };
    const plan = reconcile(inp);
    const ups = byKind(plan, "updateOFTask");
    expect(ups).toHaveLength(1);
    expect(sortedTags(ups[0].fields.tags)).toEqual(["v"]);
    expect(byKind(plan, "updateTask")).toHaveLength(0);
    expect(plan.conflicts.some((c) => c.field === "tags")).toBe(false);
  });

  it("only vault changed -> OF update, no conflict", () => {
    const inp = converged({ t: { title: "V" }, o: { name: "S" }, s: { title: "S" } });
    const plan = reconcile(inp);
    expect(byKind(plan, "updateOFTask")[0].fields.name).toBe("V");
    expect(plan.conflicts).toHaveLength(0);
  });

  it("only OF changed -> vault update, no conflict", () => {
    const inp = converged({ t: { title: "S" }, o: { name: "O" }, s: { title: "S" } });
    const plan = reconcile(inp);
    expect(byKind(plan, "updateTask")[0].fields.title).toBe("O");
    expect(plan.conflicts).toHaveLength(0);
  });

  it("completion changed in vault -> completes the OF task, no conflict", () => {
    const inp = converged({ t: { isCompleted: true, status: "done" }, o: { completed: false }, s: { isCompleted: false } });
    const plan = reconcile(inp);
    expect(byKind(plan, "updateOFTask")[0].fields.completed).toBe(true);
    expect(byKind(plan, "setStatus")).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  it("completion changed in OF -> marks the TaskNote done, no conflict", () => {
    const inp = converged({ t: { isCompleted: false }, o: { completed: true }, s: { isCompleted: false } });
    const plan = reconcile(inp);
    expect(byKind(plan, "setStatus")[0].status).toBe("done");
    expect(plan.conflicts).toHaveLength(0);
  });
});

// =====================================================================
describe("scope / de-surface", () => {
  it("deletes the OF mirror and clears the link when a task leaves scope (delete policy)", () => {
    const inp = converged({ t: { inScope: false } });
    const plan = reconcile(inp);
    expect(byKind(plan, "deleteOFTask")).toEqual([{ kind: "deleteOFTask", primaryKey: PK }]);
    expect(byKind(plan, "clearLink")).toEqual([{ kind: "clearLink", taskId: "t1" }]);
  });

  it("completes instead of deleting under the complete policy", () => {
    const inp = converged({ t: { inScope: false } });
    inp.config = { ...cfg, desurface: "complete" };
    const plan = reconcile(inp);
    expect(byKind(plan, "deleteOFTask")).toHaveLength(0);
    expect(byKind(plan, "clearLink")).toHaveLength(0);
    expect(byKind(plan, "updateOFTask")[0].fields.completed).toBe(true);
  });

  it("does not reconcile fields for an out-of-scope task (de-surface takes over)", () => {
    const inp = converged({ t: { inScope: false, title: "CHANGED" }, o: { name: "T" }, s: { title: "T" } });
    const plan = reconcile(inp);
    expect(byKind(plan, "updateOFTask")).toHaveLength(0);
  });
});

// =====================================================================
describe("missing mirror + loop guard + idempotency", () => {
  it("clears the link when the linked OF mirror is gone (no recreate)", () => {
    const inp = input({ tasks: [task({ omnifocusUrl: OFURL })], ofTasks: {}, snapshots: { [PK]: snap() } });
    const plan = reconcile(inp);
    expect(byKind(plan, "clearLink")).toEqual([{ kind: "clearLink", taskId: "t1" }]);
    expect(byKind(plan, "createOFTask")).toHaveLength(0);
  });

  it("skips a suppressed link entirely (loop guard)", () => {
    const inp = converged({ t: { title: "V" }, o: { name: "O" }, s: { title: "S" } });
    inp.suppressed = [PK];
    expect(reconcile(inp).mutations).toHaveLength(0);
  });

  it("emits nothing when everything already matches the snapshot", () => {
    const plan = reconcile(converged());
    expect(plan.mutations).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  it("emits nothing for an unlinked completed out-of-scope mix (no spurious work)", () => {
    const plan = reconcile(
      input({ direction: "sync", tasks: [task({ isCompleted: true, status: "done", inScope: false })] }),
    );
    expect(plan.mutations).toHaveLength(0);
  });
});

// =====================================================================
// tags as a FIRST-CLASS reconciled field (cycle 1.5), decoupled from priority.
describe("tags (first-class)", () => {
  it("push: syncs a standalone tag/context change to OF", () => {
    const inp = converged({ t: { tags: ["a"], contexts: ["@home"] }, o: { tags: [] }, s: { tags: [] } });
    inp.direction = "push";
    const ups = byKind(reconcile(inp), "updateOFTask");
    expect(ups).toHaveLength(1);
    expect(sortedTags(ups[0].fields.tags)).toEqual(["@home", "a"]);
  });

  it("push: treats tag sets as order-independent (no spurious update)", () => {
    const inp = converged({ t: { tags: ["a", "b"] }, o: { tags: ["b", "a"] }, s: { tags: ["a", "b"] } });
    inp.direction = "push";
    expect(byKind(reconcile(inp), "updateOFTask")).toHaveLength(0);
  });

  it("pull: does NOT write OF tag changes back to the vault (tags are push-only)", () => {
    // ofTagsFor merges vault contexts+tags into one OF set; pulling that back would demote contexts
    // into tags and lose the split, so the vault tag set is never overwritten from OmniFocus.
    const inp = converged({ t: { tags: ["x"] }, o: { tags: ["x", "y"] }, s: { tags: ["x"] } });
    inp.direction = "pull";
    const ups = byKind(reconcile(inp), "updateTask");
    // No vault write at all — the OF-side tag addition does not flow back.
    expect(ups).toHaveLength(0);
  });

  it("sync: an OF-only tag change is NOT written back to the vault (push-only)", () => {
    const inp = converged({ t: { tags: ["x"] }, o: { tags: ["x", "y"] }, s: { tags: ["x"] } });
    const plan = reconcile(inp);
    // Only OF changed -> nothing to push to OF, and tags never flow OF -> vault.
    expect(byKind(plan, "updateOFTask")).toHaveLength(0);
    expect(byKind(plan, "updateTask")).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  it("sync: a two-sided tag change pushes vault→OF (vault-authoritative), never logs a conflict", () => {
    const inp = converged({ t: { tags: ["v"] }, o: { tags: ["o"] }, s: { tags: ["s"] } });
    const plan = reconcile(inp);
    expect(sortedTags(byKind(plan, "updateOFTask")[0].fields.tags)).toEqual(["v"]);
    expect(byKind(plan, "updateTask")).toHaveLength(0);
    expect(plan.conflicts.some((c) => c.field === "tags")).toBe(false);
  });

  it("emits nothing when non-empty tag sets already match (order-independent)", () => {
    const inp = converged({ t: { tags: ["a", "b"] }, o: { tags: ["b", "a"] }, s: { tags: ["a", "b"] } });
    expect(reconcile(inp).mutations).toHaveLength(0);
  });

  it("pull: a priority-only change does not rewrite unrelated vault tags (decoupled)", () => {
    const inp = converged({
      t: { tags: ["keep"], priority: "none" },
      o: { tags: ["keep"], flagged: true, plannedDate: null },
      s: { tags: ["keep"], priority: "none", flagged: false },
    });
    inp.direction = "pull";
    const ups = byKind(reconcile(inp), "updateTask");
    expect(ups).toHaveLength(1);
    // flagged pulls back independently now; priority derives from the OF flag; tags stay untouched.
    expect(ups[0].fields.priority).toBe("high");
    expect(ups[0].fields.flagged).toBe(true);
    expect("tags" in ups[0].fields).toBe(false);
  });
});

// =====================================================================
// scheduled↔plannedDate remap + deferred↔deferDate (cycle 2 scheduling model).
describe("scheduled ↔ plannedDate", () => {
  it("push: vault scheduled writes OF plannedDate (not deferDate)", () => {
    const inp = converged({
      t: { scheduled: "2026-07-18T09:00:00.000Z" },
      o: { plannedDate: null },
      s: { scheduled: null },
    });
    inp.direction = "push";
    const ups = byKind(reconcile(inp), "updateOFTask");
    expect(ups).toHaveLength(1);
    expect(ups[0].fields.plannedDate).toBe("2026-07-18T09:00:00.000Z");
    expect("deferDate" in ups[0].fields).toBe(false);
  });

  it("pull: an OF plannedDate change flows back to vault scheduled", () => {
    const inp = converged({
      t: { scheduled: null },
      o: { plannedDate: "2026-07-18T09:00:00.000Z" },
      s: { scheduled: null },
    });
    inp.direction = "pull";
    const ups = byKind(reconcile(inp), "updateTask");
    expect(ups).toHaveLength(1);
    expect(ups[0].fields.scheduled).toBe("2026-07-18T09:00:00.000Z");
  });

  it("pull: an OF deferDate difference does NOT touch vault scheduled (defer is 'deferred' now)", () => {
    const inp = converged({
      t: { scheduled: null, deferred: null },
      o: { plannedDate: null, deferDate: "2026-07-18T09:00:00.000Z" },
      s: { scheduled: null, deferred: null },
    });
    inp.direction = "pull";
    const ups = byKind(reconcile(inp), "updateTask");
    expect(ups).toHaveLength(1);
    expect("scheduled" in ups[0].fields).toBe(false);
    expect(ups[0].fields.deferred).toBe("2026-07-18T09:00:00.000Z");
  });
});

describe("deferred ↔ deferDate", () => {
  it("push: vault deferred writes OF deferDate", () => {
    const inp = converged({
      t: { deferred: "2026-07-17T09:00:00.000Z" },
      o: { deferDate: null },
      s: { deferred: null },
    });
    inp.direction = "push";
    const ups = byKind(reconcile(inp), "updateOFTask");
    expect(ups).toHaveLength(1);
    expect(ups[0].fields.deferDate).toBe("2026-07-17T09:00:00.000Z");
    expect("plannedDate" in ups[0].fields).toBe(false);
  });

  it("pull: an OF deferDate change flows back to vault deferred", () => {
    const inp = converged({
      t: { deferred: null },
      o: { deferDate: "2026-07-17T09:00:00.000Z" },
      s: { deferred: null },
    });
    inp.direction = "pull";
    const ups = byKind(reconcile(inp), "updateTask");
    expect(ups).toHaveLength(1);
    expect(ups[0].fields.deferred).toBe("2026-07-17T09:00:00.000Z");
  });
});

describe("flagged (bidirectional, decoupled from priority)", () => {
  it("push: vault flagged=true writes the OF flag", () => {
    const inp = converged({ t: { flagged: true }, o: { flagged: false }, s: { flagged: false } });
    inp.direction = "push";
    const ups = byKind(reconcile(inp), "updateOFTask");
    expect(ups).toHaveLength(1);
    expect(ups[0].fields.flagged).toBe(true);
  });

  it("pull: an OF flag on flows back to vault flagged=true", () => {
    const inp = converged({ t: { flagged: false }, o: { flagged: true }, s: { flagged: false } });
    inp.direction = "pull";
    const ups = byKind(reconcile(inp), "updateTask");
    expect(ups).toHaveLength(1);
    expect(ups[0].fields.flagged).toBe(true);
  });

  it("pull: an OF flag off flows back to vault flagged=false", () => {
    const inp = converged({ t: { flagged: true }, o: { flagged: false }, s: { flagged: true } });
    inp.direction = "pull";
    const ups = byKind(reconcile(inp), "updateTask");
    expect(ups).toHaveLength(1);
    expect(ups[0].fields.flagged).toBe(false);
  });

  it("sync: only the vault flag changed -> pushes to OF, no conflict", () => {
    const inp = converged({ t: { flagged: true }, o: { flagged: false }, s: { flagged: false } });
    const plan = reconcile(inp);
    expect(byKind(plan, "updateOFTask")[0].fields.flagged).toBe(true);
    expect(plan.conflicts).toHaveLength(0);
  });

  it("sync: only the OF flag changed -> pulls to vault, no conflict", () => {
    const inp = converged({ t: { flagged: false }, o: { flagged: true }, s: { flagged: false } });
    const plan = reconcile(inp);
    expect(byKind(plan, "updateTask")[0].fields.flagged).toBe(true);
    expect(plan.conflicts).toHaveLength(0);
  });

  it("sync: flag matching the snapshot on both sides -> no flag mutation", () => {
    // OF flag on derives priority "high"; align vault priority so priority doesn't drive a mutation.
    const inp = converged({
      t: { flagged: true, priority: "high" },
      o: { flagged: true, tags: ["priority:high"] },
      s: { flagged: true, priority: "high", tags: ["priority:high"] },
    });
    const plan = reconcile(inp);
    expect(plan.mutations).toHaveLength(0);
  });
});
