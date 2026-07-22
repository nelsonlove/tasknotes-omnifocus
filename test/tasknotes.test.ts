import { describe, it, expect, vi } from "vitest";
import {
  buildUpdateBody,
  createTaskNotesAdapter,
  mapTNPriority,
  normalizeTNTask,
  type FetchLike,
  type RawTNTask,
} from "../src/adapters/tasknotes.js";

const COMPLETED = ["done", "cancelled"];

const rawTN = (o: Partial<RawTNTask> = {}): RawTNTask => ({
  id: "path/to/task.md",
  title: "T",
  status: "open",
  ...o,
});

/** A fake fetch that records calls and returns a canned envelope. */
function fakeFetch(body: unknown, ok = true, status = 200) {
  const fn = vi.fn(async (_url: string, _init?: unknown) => ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
  return fn as unknown as FetchLike & ReturnType<typeof vi.fn>;
}

describe("mapTNPriority", () => {
  it("maps known priorities and defaults unknown to none", () => {
    expect(mapTNPriority("high")).toBe("high");
    expect(mapTNPriority("normal")).toBe("normal");
    expect(mapTNPriority("low")).toBe("low");
    expect(mapTNPriority(undefined)).toBe("none");
    expect(mapTNPriority("weird")).toBe("none");
  });
});

describe("normalizeTNTask", () => {
  it("maps the real TaskNotes shape into a core TaskNote", () => {
    const t = normalizeTNTask(
      rawTN({
        id: "a.md",
        title: "Task A",
        status: "in-progress",
        priority: "high",
        due: "2026-07-20T09:00:00",
        scheduled: "2026-07-18",
        timeEstimate: 45,
        tags: ["x"],
        contexts: ["@home"],
        details: "the body",
      }),
      COMPLETED,
    );
    expect(t).toEqual({
      id: "a.md",
      title: "Task A",
      body: "the body",
      isCompleted: false,
      status: "in-progress",
      due: "2026-07-20T09:00:00.000Z",
      scheduled: "2026-07-18T00:00:00.000Z",
      deferred: null,
      timeEstimate: 45,
      priority: "high",
      flagged: false,
      tags: ["x"],
      contexts: ["@home"],
      projects: [],
      omnifocusUrl: null,
      inScope: true,
    });
  });

  it("derives isCompleted from the completed-status set", () => {
    expect(normalizeTNTask(rawTN({ status: "done" }), COMPLETED).isCompleted).toBe(true);
    expect(normalizeTNTask(rawTN({ status: "open" }), COMPLETED).isCompleted).toBe(false);
  });

  it("preserves the projects (parent) links", () => {
    expect(normalizeTNTask(rawTN({ projects: ["[[Parent]]"] }), COMPLETED).projects).toEqual(["[[Parent]]"]);
    expect(normalizeTNTask(rawTN(), COMPLETED).projects).toEqual([]);
  });

  it("uses null for absent body/dates and [] for absent tags/contexts", () => {
    const t = normalizeTNTask(rawTN(), COMPLETED);
    expect(t.body).toBeNull();
    expect(t.due).toBeNull();
    expect(t.scheduled).toBeNull();
    expect(t.timeEstimate).toBeNull();
    expect(t.tags).toEqual([]);
    expect(t.contexts).toEqual([]);
  });

  it("reads the deferred/flagged userFields (deferred canonicalized, flagged defaulting to false)", () => {
    const t = normalizeTNTask(rawTN({ deferred: "2026-07-17", flagged: true }), COMPLETED);
    expect(t.deferred).toBe("2026-07-17T00:00:00.000Z");
    expect(t.flagged).toBe(true);
  });

  it("defaults deferred to null and flagged to false when absent", () => {
    const t = normalizeTNTask(rawTN(), COMPLETED);
    expect(t.deferred).toBeNull();
    expect(t.flagged).toBe(false);
  });
});

describe("buildUpdateBody", () => {
  it("includes only the provided fields and maps priority symmetrically", () => {
    expect(buildUpdateBody({ title: "New", priority: "high" })).toEqual({ title: "New", priority: "high" });
    expect(buildUpdateBody({ due: "2026-07-20T09:00:00.000Z" })).toEqual({ due: "2026-07-20T09:00:00.000Z" });
    expect(buildUpdateBody({ tags: ["a", "b"] })).toEqual({ tags: ["a", "b"] });
  });

  it("does not emit keys for fields that were not provided", () => {
    expect(Object.keys(buildUpdateBody({ title: "X" }))).toEqual(["title"]);
  });

  it("forwards the deferred/flagged/scheduled userFields to the update body", () => {
    expect(
      buildUpdateBody({ deferred: "2026-07-17T00:00:00.000Z", flagged: true, scheduled: "2026-07-18T00:00:00.000Z" }),
    ).toEqual({
      deferred: "2026-07-17T00:00:00.000Z",
      flagged: true,
      scheduled: "2026-07-18T00:00:00.000Z",
    });
  });
});

describe("adapter.query", () => {
  it("POSTs the filter to /api/tasks/query and returns normalized tasks", async () => {
    const fetch = fakeFetch({ success: true, data: { tasks: [rawTN({ id: "a.md", due: "2026-07-20" })] } });
    const adapter = createTaskNotesAdapter({ baseUrl: "http://localhost:8080", fetch, completedStatuses: COMPLETED });
    const tasks = await adapter.query({ any: "filter" });
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("http://localhost:8080/api/tasks/query");
    expect(init.method).toBe("POST");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("a.md");
    expect(tasks[0].due).toBe("2026-07-20T00:00:00.000Z");
    expect(tasks[0].inScope).toBe(true);
  });

  it("throws when the API envelope reports failure", async () => {
    const fetch = fakeFetch({ success: false, error: "boom" });
    const adapter = createTaskNotesAdapter({ baseUrl: "http://localhost:8080", fetch, completedStatuses: COMPLETED });
    await expect(adapter.query({})).rejects.toThrow(/tasknotes/i);
  });

  it("throws on a non-ok HTTP response", async () => {
    const fetch = fakeFetch({}, false, 500);
    const adapter = createTaskNotesAdapter({ baseUrl: "http://localhost:8080", fetch, completedStatuses: COMPLETED });
    await expect(adapter.query({})).rejects.toThrow();
  });
});

describe("adapter.update / setStatus", () => {
  it("PUTs mapped fields to /api/tasks/:id", async () => {
    const fetch = fakeFetch({ success: true, data: {} });
    const adapter = createTaskNotesAdapter({ baseUrl: "http://localhost:8080", fetch, completedStatuses: COMPLETED });
    await adapter.update("dir/a.md", { title: "New", priority: "high" });
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    // The whole id is one encoded path segment (slash -> %2F); /api/tasks/:id captures one segment.
    expect(url).toBe("http://localhost:8080/api/tasks/dir%2Fa.md");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ title: "New", priority: "high" });
  });

  it("PUTs the status for setStatus", async () => {
    const fetch = fakeFetch({ success: true, data: {} });
    const adapter = createTaskNotesAdapter({ baseUrl: "http://localhost:8080", fetch, completedStatuses: COMPLETED });
    await adapter.setStatus("a.md", "done");
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("http://localhost:8080/api/tasks/a.md");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ status: "done" });
  });
});

describe("adapter.getById", () => {
  it("returns null when the task is not found", async () => {
    const fetch = fakeFetch({ success: false, error: "not found" }, false, 404);
    const adapter = createTaskNotesAdapter({ baseUrl: "http://localhost:8080", fetch, completedStatuses: COMPLETED });
    expect(await adapter.getById("missing.md")).toBeNull();
  });
});
