import { describe, it, expect } from "vitest";
import { orderByDeps } from "../src/plugin/topo.js";

const deps = (m: Record<string, string[]>) => (id: string) => m[id] ?? [];

describe("orderByDeps (#8)", () => {
  it("orders a linear chain blockers-first", () => {
    // C blockedBy B, B blockedBy A → A, B, C
    expect(orderByDeps(["C", "B", "A"], deps({ C: ["B"], B: ["A"] }))).toEqual(["A", "B", "C"]);
  });

  it("keeps original order for independent ids (stable)", () => {
    expect(orderByDeps(["X", "Y", "Z"], deps({}))).toEqual(["X", "Y", "Z"]);
  });

  it("keeps unrelated ids in place around a dependency", () => {
    // Only B depends on A; X/Y are free and keep their slots relative to the freed order.
    expect(orderByDeps(["X", "B", "A", "Y"], deps({ B: ["A"] }))).toEqual(["X", "A", "B", "Y"]);
  });

  it("ignores dependencies pointing outside the set", () => {
    expect(orderByDeps(["A", "B"], deps({ B: ["external"], A: [] }))).toEqual(["A", "B"]);
  });

  it("ignores a self-dependency", () => {
    expect(orderByDeps(["A", "B"], deps({ A: ["A"] }))).toEqual(["A", "B"]);
  });

  it("dedupes repeated dependencies", () => {
    expect(orderByDeps(["B", "A"], deps({ B: ["A", "A"] }))).toEqual(["A", "B"]);
  });

  it("breaks a cycle without dropping or duplicating ids", () => {
    // A↔B cycle plus a free C: every id appears exactly once.
    const out = orderByDeps(["A", "B", "C"], deps({ A: ["B"], B: ["A"] }));
    expect([...out].sort()).toEqual(["A", "B", "C"]);
    expect(out).toHaveLength(3);
  });

  it("handles a diamond (A before B and C, both before D)", () => {
    const out = orderByDeps(["D", "B", "C", "A"], deps({ D: ["B", "C"], B: ["A"], C: ["A"] }));
    expect(out.indexOf("A")).toBeLessThan(out.indexOf("B"));
    expect(out.indexOf("A")).toBeLessThan(out.indexOf("C"));
    expect(out.indexOf("B")).toBeLessThan(out.indexOf("D"));
    expect(out.indexOf("C")).toBeLessThan(out.indexOf("D"));
  });
});
