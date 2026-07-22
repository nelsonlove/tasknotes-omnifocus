import { describe, it, expect, vi } from "vitest";
import {
  buildBatchScript,
  buildReadInboxScript,
  buildReadProjectsMetaScript,
  buildReadScript,
  buildScaffoldScript,
  createOmniFocusAdapter,
  encodePayload,
  normalizeOFTask,
  type BatchResult,
  type FolderSpec,
  type OFOp,
  type ProjectSpec,
  type RawOFTask,
  type ScaffoldResult,
} from "../src/adapters/omnifocus.js";
import type { OFWriteFields } from "../src/core/types.js";

const rawTask = (o: Partial<RawOFTask> = {}): RawOFTask => ({
  id: "pk1",
  name: "T",
  note: null,
  completed: false,
  due: null,
  defer: null,
  planned: null,
  estimatedMinutes: null,
  flagged: false,
  tags: [],
  ...o,
});

const writeFields = (o: Partial<OFWriteFields> = {}): OFWriteFields => ({
  name: "T",
  note: null,
  dueDate: null,
  deferDate: null,
  plannedDate: null,
  estimatedMinutes: null,
  flagged: false,
  tags: [],
  completed: false,
  ...o,
});

describe("encodePayload (injection safety)", () => {
  it("round-trips values with quotes, newlines, and backslashes", () => {
    const value = { name: 'He said "hi"\nline2\\path', tags: ["a/b"] };
    expect(JSON.parse(encodePayload(value))).toEqual(value);
  });

  it("escapes U+2028 / U+2029 so the JS source stays valid", () => {
    const value = { name: "line\u2028sep\u2029end" };
    const encoded = encodePayload(value);
    // The raw line-terminator code points must not appear unescaped in the JS source.
    expect(encoded).not.toContain("\u2028");
    expect(encoded).not.toContain("\u2029");
    expect(JSON.parse(encoded)).toEqual(value);
  });
});

describe("normalizeOFTask", () => {
  it("maps fields and canonicalizes dates", () => {
    const t = normalizeOFTask(
      rawTask({ id: "pk9", name: "N", note: "body", completed: true, due: "2026-07-20T09:00:00", defer: Date.UTC(2026, 6, 18, 0, 0, 0), estimatedMinutes: 30, flagged: true, tags: ["x"] }),
    );
    expect(t).toEqual({
      primaryKey: "pk9",
      name: "N",
      note: "body",
      completed: true,
      dueDate: "2026-07-20T09:00:00.000Z",
      deferDate: "2026-07-18T00:00:00.000Z",
      plannedDate: null,
      estimatedMinutes: 30,
      flagged: true,
      tags: ["x"],
    });
  });

  it("uses null (not empty string) for absent dates and note", () => {
    const t = normalizeOFTask(rawTask({ due: null, defer: null, planned: null, note: null }));
    expect(t.dueDate).toBeNull();
    expect(t.deferDate).toBeNull();
    expect(t.plannedDate).toBeNull();
    expect(t.note).toBeNull();
  });

  it("canonicalizes the planned date into plannedDate", () => {
    const t = normalizeOFTask(rawTask({ planned: Date.UTC(2026, 6, 18, 0, 0, 0) }));
    expect(t.plannedDate).toBe("2026-07-18T00:00:00.000Z");
  });
});

describe("buildReadScript / buildBatchScript", () => {
  it("read script embeds the project safely and returns JSON", () => {
    const script = buildReadScript('Proj "X"');
    // Project name is embedded via encodePayload (not naive concatenation).
    expect(script).toContain(encodePayload('Proj "X"'));
    expect(script).toContain("JSON.stringify");
  });

  it("read script emits the task plannedDate (planned field)", () => {
    const script = buildReadScript("P");
    expect(script).toContain("planned:");
    expect(script).toContain("task.plannedDate");
  });

  it("batch script sets plannedDate in setTaskFields", () => {
    const ops: OFOp[] = [{ op: "update", primaryKey: "pk1", fields: { plannedDate: "2026-07-18T09:00:00.000Z" } }];
    const script = buildBatchScript(ops);
    expect(script).toContain("task.plannedDate");
    expect(script).toContain(encodePayload(ops));
  });

  it("batch script embeds ops via encodePayload and returns JSON", () => {
    const ops: OFOp[] = [{ op: "delete", primaryKey: "pk1" }];
    const script = buildBatchScript(ops);
    expect(script).toContain(encodePayload(ops));
    expect(script).toContain("JSON.stringify");
  });

  it("batch script handles an updateProject op via Project.byIdentifier and Project.Status", () => {
    const ops: OFOp[] = [{ op: "updateProject", primaryKey: "pk1", fields: { dueDate: null, completed: true } }];
    const script = buildBatchScript(ops);
    expect(script).toContain(encodePayload(ops));
    expect(script).toContain("Project.byIdentifier");
    expect(script).toContain("Project.Status");
  });

  it("batch script supports nested-task creation (parentRef → action group) with a ref map", () => {
    const ops: OFOp[] = [
      { op: "create", ref: "parent", project: "P", sequential: false, fields: writeFields({ name:"Group" }) },
      { op: "create", ref: "child", project: "P", parentRef: "parent", fields: writeFields({ name:"Child" }) },
    ];
    const script = buildBatchScript(ops);
    expect(script).toContain(encodePayload(ops));
    // resolves a parent task by ref and nests under it; and sets sequential for parallel groups
    expect(script).toContain("parentRef");
    expect(script).toContain("sequential");
  });

  it("scaffold script marks single-action-list projects via containsSingletonActions", () => {
    const script = buildScaffoldScript([], [{ title: "P", folderPath: [], singleActionList: true }]);
    expect(script).toContain("containsSingletonActions");
  });

  it("read-projects-meta script embeds names via encodePayload and returns JSON", () => {
    const script = buildReadProjectsMetaScript(["ProjA", "ProjB"]);
    expect(script).toContain(encodePayload(["ProjA", "ProjB"]));
    expect(script).toContain("JSON.stringify");
    expect(script).toContain("flattenedProjects");
  });

  it("scaffold script embeds folders+projects via encodePayload and returns JSON", () => {
    const folders: FolderSpec[] = [{ path: ["Area"] }, { path: ["Area", "MixedP"] }];
    const projects: ProjectSpec[] = [
      { title: "ProjA", folderPath: ["Area"] },
      { title: "Solo", folderPath: [] },
    ];
    const script = buildScaffoldScript(folders, projects);
    expect(script).toContain(encodePayload({ folders, projects }));
    expect(script).toContain("JSON.stringify");
    // Uses the folder/project constructors (pure OmniJS, not JXA).
    expect(script).toContain("new Folder");
    expect(script).toContain("new Project");
  });
});

describe("buildReadInboxScript", () => {
  it("reads the global inbox and emits the same per-task fields as the project read script", () => {
    const script = buildReadInboxScript();
    expect(script).toContain("inbox");
    expect(script).toContain("JSON.stringify");
    expect(script).toContain("planned:");
    expect(script).toContain("task.plannedDate");
    // Excludes dropped tasks, same as buildReadScript.
    expect(script).toContain("Task.Status.Dropped");
  });
});

describe("adapter.readInbox", () => {
  it("runs the inbox read script and returns normalized tasks", async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify([rawTask({ id: "inb1", due: "2026-07-20" })]));
    const adapter = createOmniFocusAdapter(run);
    const tasks = await adapter.readInbox();
    expect(run).toHaveBeenCalledOnce();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].primaryKey).toBe("inb1");
    expect(tasks[0].dueDate).toBe("2026-07-20T00:00:00.000Z");
  });

  it("throws a clear error when the runner output is not valid JSON", async () => {
    const run = vi.fn().mockResolvedValue("not json");
    const adapter = createOmniFocusAdapter(run);
    await expect(adapter.readInbox()).rejects.toThrow(/omnifocus/i);
  });
});

describe("adapter.readProject", () => {
  it("runs the read script and returns normalized tasks", async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify([rawTask({ id: "a", due: "2026-07-20" })]));
    const adapter = createOmniFocusAdapter(run);
    const tasks = await adapter.readProject("P");
    expect(run).toHaveBeenCalledOnce();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].primaryKey).toBe("a");
    expect(tasks[0].dueDate).toBe("2026-07-20T00:00:00.000Z");
  });

  it("throws a clear error when the runner output is not valid JSON", async () => {
    const run = vi.fn().mockResolvedValue("not json");
    const adapter = createOmniFocusAdapter(run);
    await expect(adapter.readProject("P")).rejects.toThrow(/omnifocus/i);
  });

  it("propagates a runner rejection as an error", async () => {
    const run = vi.fn().mockRejectedValue(new Error("osascript failed"));
    const adapter = createOmniFocusAdapter(run);
    await expect(adapter.readProject("P")).rejects.toThrow();
  });
});

describe("adapter.applyBatch", () => {
  it("runs one script for all ops and returns the parsed BatchResult", async () => {
    const ops: OFOp[] = [
      { op: "create", ref: "t1", project: "P", fields: writeFields({ name: "New" }) },
      { op: "update", primaryKey: "pk2", fields: { completed: true } },
      { op: "delete", primaryKey: "pk3" },
    ];
    const result: BatchResult = { created: { t1: "pkNEW" }, updated: ["pk2"], deleted: ["pk3"], errors: [] };
    const run = vi.fn().mockResolvedValue(JSON.stringify(result));
    const adapter = createOmniFocusAdapter(run);
    const out = await adapter.applyBatch(ops);
    expect(run).toHaveBeenCalledOnce();
    expect(out.created.t1).toBe("pkNEW");
    expect(out.updated).toEqual(["pk2"]);
    expect(out.deleted).toEqual(["pk3"]);
    expect(out.errors).toEqual([]);
  });

  it("does no work and spawns nothing for an empty op list", async () => {
    const run = vi.fn();
    const adapter = createOmniFocusAdapter(run);
    const out = await adapter.applyBatch([]);
    expect(run).not.toHaveBeenCalled();
    expect(out).toEqual({ created: {}, updated: [], deleted: [], errors: [] });
  });
});

describe("adapter.ensureStructure", () => {
  it("runs one script and returns the parsed ScaffoldResult", async () => {
    const result: ScaffoldResult = {
      createdFolders: ["Area", "Area/MixedP"],
      createdProjects: ["ProjA", "MixedP"],
      errors: [],
    };
    const run = vi.fn().mockResolvedValue(JSON.stringify(result));
    const adapter = createOmniFocusAdapter(run);
    const out = await adapter.ensureStructure([{ path: ["Area"] }], [{ title: "ProjA", folderPath: ["Area"] }]);
    expect(run).toHaveBeenCalledOnce();
    expect(out.createdFolders).toEqual(["Area", "Area/MixedP"]);
    expect(out.createdProjects).toEqual(["ProjA", "MixedP"]);
    expect(out.errors).toEqual([]);
  });

  it("does no work and spawns nothing when there is nothing to ensure", async () => {
    const run = vi.fn();
    const adapter = createOmniFocusAdapter(run);
    const out = await adapter.ensureStructure([], []);
    expect(run).not.toHaveBeenCalled();
    expect(out).toEqual({ createdFolders: [], createdProjects: [], errors: [] });
  });

  it("throws a clear error when the runner output is not valid JSON", async () => {
    const run = vi.fn().mockResolvedValue("not json");
    const adapter = createOmniFocusAdapter(run);
    await expect(adapter.ensureStructure([{ path: ["A"] }], [])).rejects.toThrow(/omnifocus/i);
  });
});

describe("adapter.readProjectsMeta", () => {
  it("runs one script and normalizes each project's meta by name", async () => {
    const raw: Record<string, RawOFTask> = {
      ProjA: rawTask({ id: "pkA", name: "ProjA", due: "2026-08-01", flagged: true }),
    };
    const run = vi.fn().mockResolvedValue(JSON.stringify(raw));
    const adapter = createOmniFocusAdapter(run);
    const out = await adapter.readProjectsMeta(["ProjA", "Missing"]);
    expect(run).toHaveBeenCalledOnce();
    expect(out.ProjA.primaryKey).toBe("pkA");
    expect(out.ProjA.dueDate).toBe("2026-08-01T00:00:00.000Z");
    expect(out.ProjA.flagged).toBe(true);
    expect(out.Missing).toBeUndefined();
  });

  it("spawns nothing for an empty name list", async () => {
    const run = vi.fn();
    const adapter = createOmniFocusAdapter(run);
    expect(await adapter.readProjectsMeta([])).toEqual({});
    expect(run).not.toHaveBeenCalled();
  });
});

describe("adapter.readTasksByIds", () => {
  it("runs one script and returns tasks normalized, keyed by primaryKey", async () => {
    const raw: Record<string, RawOFTask> = { pkA: rawTask({ id: "pkA", completed: true }) };
    const run = vi.fn().mockResolvedValue(JSON.stringify(raw));
    const adapter = createOmniFocusAdapter(run);
    const out = await adapter.readTasksByIds(["pkA", "gone"]);
    expect(run).toHaveBeenCalledOnce();
    expect(out.pkA.completed).toBe(true);
    expect(out.gone).toBeUndefined();
  });

  it("spawns nothing for an empty id list", async () => {
    const run = vi.fn();
    const adapter = createOmniFocusAdapter(run);
    expect(await adapter.readTasksByIds([])).toEqual({});
    expect(run).not.toHaveBeenCalled();
  });
});
