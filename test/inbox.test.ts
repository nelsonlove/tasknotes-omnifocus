import { describe, it, expect } from "vitest";
import { sanitizeFilename, filterUncaptured, buildCaptureFrontmatter } from "../src/plugin/inbox.js";
import type { OmniFocusTask } from "../src/core/types.js";

const ofTask = (o: Partial<OmniFocusTask> = {}): OmniFocusTask => ({
  primaryKey: "pk1",
  name: "Task",
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

describe("sanitizeFilename", () => {
  it("passes a clean title through unchanged", () => {
    expect(sanitizeFilename("Buy milk")).toBe("Buy milk");
  });

  it("replaces slashes and colons with spaces", () => {
    expect(sanitizeFilename("a/b:c")).toBe("a b c");
  });

  it("strips every illegal character class", () => {
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe("a b c d e f g h i j");
  });

  it("replaces control characters (NUL..\\x1f) with spaces", () => {
    expect(sanitizeFilename("a\u0000b\u001fc")).toBe("a b c");
  });

  it("collapses runs of whitespace to a single space", () => {
    expect(sanitizeFilename("a   b\t\tc")).toBe("a b c");
  });

  it("strips leading dots (no hidden files)", () => {
    expect(sanitizeFilename("...hidden")).toBe("hidden");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeFilename("  spaced  ")).toBe("spaced");
  });

  it("falls back to Untitled for an empty string", () => {
    expect(sanitizeFilename("")).toBe("Untitled");
  });

  it("falls back to Untitled when the title is entirely illegal characters", () => {
    expect(sanitizeFilename("/////")).toBe("Untitled");
  });

  it("falls back to Untitled for whitespace-only input", () => {
    expect(sanitizeFilename("   ")).toBe("Untitled");
  });

  it("caps length at ~180 chars and does not end on a trailing space", () => {
    const long = "x".repeat(300);
    const out = sanitizeFilename(long);
    expect(out.length).toBeLessThanOrEqual(180);
    expect(out).not.toMatch(/\s$/);
  });
});

describe("filterUncaptured", () => {
  it("drops tasks whose primaryKey is already captured", () => {
    const tasks = [ofTask({ primaryKey: "a" }), ofTask({ primaryKey: "b" }), ofTask({ primaryKey: "c" })];
    const out = filterUncaptured(tasks, new Set(["b"]));
    expect(out.map((t) => t.primaryKey)).toEqual(["a", "c"]);
  });

  it("keeps everything when nothing is captured (idempotency: first run)", () => {
    const tasks = [ofTask({ primaryKey: "a" }), ofTask({ primaryKey: "b" })];
    expect(filterUncaptured(tasks, new Set())).toHaveLength(2);
  });

  it("returns empty when all are captured (idempotency: no re-creation)", () => {
    const tasks = [ofTask({ primaryKey: "a" }), ofTask({ primaryKey: "b" })];
    expect(filterUncaptured(tasks, new Set(["a", "b"]))).toEqual([]);
  });
});

describe("buildCaptureFrontmatter", () => {
  const opts = { markerTag: "note/task", doneStatus: "done", openStatus: "open" };

  it("builds the base frontmatter for an open task with no dates", () => {
    const fm = buildCaptureFrontmatter(ofTask({ name: "Do thing", primaryKey: "pkX" }), opts);
    expect(fm).toEqual({
      title: "Do thing",
      tags: ["note/task"],
      status: "open",
      omnifocusUrl: "omnifocus:///task/pkX",
      flagged: false,
    });
  });

  it("maps a completed task to the done status", () => {
    const fm = buildCaptureFrontmatter(ofTask({ completed: true }), opts);
    expect(fm.status).toBe("done");
  });

  it("maps OmniFocus plannedDate → vault scheduled", () => {
    const fm = buildCaptureFrontmatter(ofTask({ plannedDate: "2026-07-20T00:00:00.000Z" }), opts);
    expect(fm.scheduled).toBe("2026-07-20T00:00:00.000Z");
    expect(fm).not.toHaveProperty("planned");
  });

  it("includes due and deferred when present", () => {
    const fm = buildCaptureFrontmatter(
      ofTask({ dueDate: "2026-08-01T00:00:00.000Z", deferDate: "2026-07-15T00:00:00.000Z" }),
      opts,
    );
    expect(fm.due).toBe("2026-08-01T00:00:00.000Z");
    expect(fm.deferred).toBe("2026-07-15T00:00:00.000Z");
  });

  it("omits null date fields (no due/scheduled/deferred keys)", () => {
    const fm = buildCaptureFrontmatter(ofTask(), opts);
    expect(fm).not.toHaveProperty("due");
    expect(fm).not.toHaveProperty("scheduled");
    expect(fm).not.toHaveProperty("deferred");
  });

  it("always sets flagged, carrying the OmniFocus flag through", () => {
    expect(buildCaptureFrontmatter(ofTask({ flagged: true }), opts).flagged).toBe(true);
    expect(buildCaptureFrontmatter(ofTask({ flagged: false }), opts).flagged).toBe(false);
  });

  it("never sets uid or projects (plugin stamps uid; captures are unfiled)", () => {
    const fm = buildCaptureFrontmatter(ofTask(), opts);
    expect(fm).not.toHaveProperty("uid");
    expect(fm).not.toHaveProperty("projects");
  });
});
