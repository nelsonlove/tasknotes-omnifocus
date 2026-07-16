import { describe, it, expect, vi } from "vitest";
import {
  buildBatchScript,
  buildReadScript,
  createOmniFocusAdapter,
  encodePayload,
  normalizeOFTask,
  type BatchResult,
  type OFOp,
  type RawOFTask,
} from "../src/adapters/omnifocus.js";
import type { OFWriteFields } from "../src/core/types.js";

const rawTask = (o: Partial<RawOFTask> = {}): RawOFTask => ({
  id: "pk1",
  name: "T",
  note: null,
  completed: false,
  due: null,
  defer: null,
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
      estimatedMinutes: 30,
      flagged: true,
      tags: ["x"],
    });
  });

  it("uses null (not empty string) for absent dates and note", () => {
    const t = normalizeOFTask(rawTask({ due: null, defer: null, note: null }));
    expect(t.dueDate).toBeNull();
    expect(t.deferDate).toBeNull();
    expect(t.note).toBeNull();
  });
});

describe("buildReadScript / buildBatchScript", () => {
  it("read script embeds the project safely and returns JSON", () => {
    const script = buildReadScript('Proj "X"');
    // Project name is embedded via encodePayload (not naive concatenation).
    expect(script).toContain(encodePayload('Proj "X"'));
    expect(script).toContain("JSON.stringify");
  });

  it("batch script embeds ops via encodePayload and returns JSON", () => {
    const ops: OFOp[] = [{ op: "delete", primaryKey: "pk1" }];
    const script = buildBatchScript(ops);
    expect(script).toContain(encodePayload(ops));
    expect(script).toContain("JSON.stringify");
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
