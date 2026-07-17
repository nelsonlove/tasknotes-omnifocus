import { describe, it, expect } from "vitest";
import { buildProjectMembershipFilter, filterIgnored, computeDesurfaceIds } from "../src/plugin/projects.js";
import type { TaskNote } from "../src/core/types.js";

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

describe("buildProjectMembershipFilter", () => {
  it("selects tasks whose projects contains a link to the project note", () => {
    const f = buildProjectMembershipFilter("Website");
    expect(f.type).toBe("group");
    expect(f.conjunction).toBe("and");
    expect(f.children).toHaveLength(1);
    const cond = f.children[0] as Record<string, unknown>;
    expect(cond.type).toBe("condition");
    expect(cond.property).toBe("projects");
    expect(cond.operator).toBe("contains");
    expect(cond.value).toBe("[[Website]]");
  });

  it("is deterministic (stable ids, no randomness)", () => {
    expect(buildProjectMembershipFilter("X")).toEqual(buildProjectMembershipFilter("X"));
  });
});

describe("filterIgnored", () => {
  it("removes tasks carrying the ignore tag, keeps the rest", () => {
    const keep = task({ id: "keep", tags: ["a"] });
    const drop = task({ id: "drop", tags: ["a", "omnifocus/ignore"] });
    expect(filterIgnored([keep, drop], "omnifocus/ignore").map((t) => t.id)).toEqual(["keep"]);
  });

  it("keeps everything when no task carries the ignore tag", () => {
    const ts = [task({ id: "a" }), task({ id: "b" })];
    expect(filterIgnored(ts, "omnifocus/ignore")).toHaveLength(2);
  });
});

describe("computeDesurfaceIds", () => {
  it("returns linked ids that are no longer members of any synced project", () => {
    const members = ["t1", "t2"];
    const linked = ["t1", "t2", "t3", "t4"];
    expect(computeDesurfaceIds(members, linked).sort()).toEqual(["t3", "t4"]);
  });

  it("returns nothing when every linked task is still a member", () => {
    expect(computeDesurfaceIds(["t1", "t2"], ["t1", "t2"])).toEqual([]);
  });

  it("accepts Sets as well as arrays", () => {
    expect(computeDesurfaceIds(new Set(["t1"]), new Set(["t1", "t2"]))).toEqual(["t2"]);
  });
});
