import { describe, it, expect } from "vitest";
import {
  buildOFForest,
  collectFolders,
  collectProjects,
  findContainmentAnomalies,
  forestToCreateOps,
  type OFItem,
} from "../src/plugin/hierarchy.js";
import type { OFWriteFields } from "../src/core/types.js";
import type { ProjectNodeInput } from "../src/plugin/tree.js";
import type { OFLevelType } from "../src/plugin/levels.js";

const node = (o: Partial<ProjectNodeInput> & { id: string; title: string }): ProjectNodeInput => ({
  parents: [],
  childProjects: [],
  leafTaskIds: [],
  ...o,
});

// The spec's worked example:
//   Area (folder)
//     Cat (project / single-action list)
//       B (action group: G, H)
//       A (task)
//       C (action group: D, E, F)
const FIXTURE: ProjectNodeInput[] = [
  node({ id: "area.md", title: "Area", childProjects: ["Cat"] }),
  node({ id: "cat.md", title: "Cat", parents: ["Area"], childProjects: ["B", "C"], leafTaskIds: ["a.md"] }),
  node({ id: "b.md", title: "B", parents: ["Cat"], leafTaskIds: ["g.md", "h.md"] }),
  node({ id: "c.md", title: "C", parents: ["Cat"], leafTaskIds: ["d.md", "e.md", "f.md"] }),
];
const NAMES: Record<string, string> = {
  "a.md": "Task A", "g.md": "Task G", "h.md": "Task H", "d.md": "Task D", "e.md": "Task E", "f.md": "Task F",
};
const leafName = (id: string) => NAMES[id] ?? id;
const DEFAULT: OFLevelType[] = ["folder", "project", "task"];

const find = (items: OFItem[], name: string): OFItem | undefined => {
  for (const it of items) {
    if (it.name === name) return it;
    const inner = find(it.children, name);
    if (inner) return inner;
  }
  return undefined;
};

describe("buildOFForest — default [folder, project, task]", () => {
  const forest = buildOFForest(FIXTURE, leafName, DEFAULT);

  it("area→folder, category→project, deeper→tasks", () => {
    expect(forest.map((r) => `${r.name}:${r.type}`)).toEqual(["Area:folder"]);
    expect(find(forest, "Cat")!.type).toBe("project");
    expect(find(forest, "B")!.type).toBe("task");
    expect(find(forest, "Task A")!.type).toBe("task");
  });

  it("a project-node with subtasks is a task with children (action group)", () => {
    const b = find(forest, "B")!;
    expect(b.type).toBe("task");
    expect(b.children.map((c) => c.name).sort()).toEqual(["Task G", "Task H"]);
    const c = find(forest, "C")!;
    expect(c.children.map((x) => x.name).sort()).toEqual(["Task D", "Task E", "Task F"]);
  });

  it("a leaf task has no children", () => {
    expect(find(forest, "Task A")!.children).toEqual([]);
  });

  it("the category project holds B, A, C as its task forest", () => {
    const cat = find(forest, "Cat")!;
    expect(cat.children.map((c) => c.name).sort()).toEqual(["B", "C", "Task A"]);
  });
});

describe("collectFolders / collectProjects", () => {
  const forest = buildOFForest(FIXTURE, leafName, DEFAULT);
  it("lists folders with their ancestor path", () => {
    const fs = collectFolders(forest);
    expect(fs.map((f) => `${f.name}[${f.path.join("/")}]`)).toEqual(["Area[]"]);
  });
  it("lists projects with folder path and task forest", () => {
    const ps = collectProjects(forest);
    expect(ps).toHaveLength(1);
    expect(ps[0].name).toBe("Cat");
    expect(ps[0].folderPath).toEqual(["Area"]);
    expect(ps[0].tasks.map((t) => t.name).sort()).toEqual(["B", "C", "Task A"]);
  });
});

describe("deeper config [folder, folder, project, task]", () => {
  // Area(0) -> Sub(1) -> Proj(2) -> leaf(3)
  const F: ProjectNodeInput[] = [
    node({ id: "area.md", title: "Area", childProjects: ["Sub"] }),
    node({ id: "sub.md", title: "Sub", parents: ["Area"], childProjects: ["Proj"] }),
    node({ id: "proj.md", title: "Proj", parents: ["Sub"], leafTaskIds: ["x.md"] }),
  ];
  const forest = buildOFForest(F, (id) => (id === "x.md" ? "Task X" : id), ["folder", "folder", "project", "task"]);
  it("maps depth 0/1 to folders, depth 2 to project, leaf to task", () => {
    expect(find(forest, "Area")!.type).toBe("folder");
    expect(find(forest, "Sub")!.type).toBe("folder");
    expect(find(forest, "Proj")!.type).toBe("project");
    expect(find(forest, "Task X")!.type).toBe("task");
  });
  it("collectFolders nests Sub under Area", () => {
    const fs = collectFolders(forest);
    expect(fs.find((f) => f.name === "Sub")!.path).toEqual(["Area"]);
    const ps = collectProjects(forest);
    expect(ps.find((p) => p.name === "Proj")!.folderPath).toEqual(["Area", "Sub"]);
  });
});

describe("forestToCreateOps", () => {
  const forest = buildOFForest(FIXTURE, leafName, DEFAULT);
  const cat = collectProjects(forest).find((p) => p.name === "Cat")!;
  const wf = (name: string): OFWriteFields => ({
    name, note: null, dueDate: null, deferDate: null, plannedDate: null, estimatedMinutes: null, flagged: false, tags: [], completed: false,
  });
  const ops = forestToCreateOps("Cat", cat.tasks, (_id, name) => wf(name));

  it("emits a create for every task in the forest, all in project Cat", () => {
    const refs = ops.map((o) => (o.op === "create" ? o.ref : "")).sort();
    expect(refs).toEqual(["a.md", "b.md", "c.md", "d.md", "e.md", "f.md", "g.md", "h.md"]);
    expect(ops.every((o) => o.op === "create" && o.project === "Cat")).toBe(true);
  });

  it("nests children under their parent via parentRef", () => {
    const byRef = new Map(ops.map((o) => [o.op === "create" ? o.ref : "", o]));
    const g = byRef.get("g.md")!;
    expect(g.op === "create" && g.parentRef).toBe("b.md");
    const d = byRef.get("d.md")!;
    expect(d.op === "create" && d.parentRef).toBe("c.md");
    const a = byRef.get("a.md")!; // leaf directly in project
    expect(a.op === "create" && a.parentRef).toBeUndefined();
  });

  it("marks action-group parents sequential:false and leaves plain tasks unmarked", () => {
    const byRef = new Map(ops.map((o) => [o.op === "create" ? o.ref : "", o]));
    expect((byRef.get("b.md") as { sequential?: boolean }).sequential).toBe(false);
    expect((byRef.get("c.md") as { sequential?: boolean }).sequential).toBe(false);
    expect((byRef.get("a.md") as { sequential?: boolean }).sequential).toBeUndefined();
    expect((byRef.get("g.md") as { sequential?: boolean }).sequential).toBeUndefined();
  });

  it("orders every parent before its children", () => {
    const idx = (r: string) => ops.findIndex((o) => o.op === "create" && o.ref === r);
    expect(idx("b.md")).toBeLessThan(idx("g.md"));
    expect(idx("b.md")).toBeLessThan(idx("h.md"));
    expect(idx("c.md")).toBeLessThan(idx("d.md"));
  });

  it("idempotent: skips a linked parent and nests its new children under the existing pk", () => {
    // B is already linked (pk "PKB"); its children G/H are new → created under parentPrimaryKey PKB.
    const linkedPk = (id: string) => (id === "b.md" ? "PKB" : null);
    const ops2 = forestToCreateOps("Cat", cat.tasks, (_id, name) => wf(name), linkedPk);
    const refs = ops2.map((o) => (o.op === "create" ? o.ref : "")).sort();
    expect(refs).not.toContain("b.md"); // B not recreated
    const g = ops2.find((o) => o.op === "create" && o.ref === "g.md")!;
    expect(g.op === "create" && g.parentPrimaryKey).toBe("PKB");
    expect(g.op === "create" && g.parentRef).toBeUndefined();
  });
});

describe("multi-parent dedup (first parent wins)", () => {
  // Area → Cat1, Cat2 (both projects). A shared leaf and a shared project-node each list BOTH cats
  // as parents; each must be emitted ONCE, under the first parent reached (Cat1).
  const F: ProjectNodeInput[] = [
    node({ id: "area.md", title: "Area", childProjects: ["Cat1", "Cat2"] }),
    node({ id: "cat1.md", title: "Cat1", parents: ["Area"], childProjects: ["Shared"], leafTaskIds: ["dup.md"] }),
    node({ id: "cat2.md", title: "Cat2", parents: ["Area"], childProjects: ["Shared"], leafTaskIds: ["dup.md"] }),
    node({ id: "shared.md", title: "Shared", parents: ["Cat1", "Cat2"], leafTaskIds: ["s1.md"] }),
  ];
  const forest = buildOFForest(F, (id) => id, DEFAULT);

  it("a shared leaf task appears under only the first parent", () => {
    const c1 = find(forest, "Cat1")!;
    const c2 = find(forest, "Cat2")!;
    expect(c1.children.some((x) => x.sourceId === "dup.md")).toBe(true);
    expect(c2.children.some((x) => x.sourceId === "dup.md")).toBe(false);
  });

  it("a shared project-node (and its subtree) is placed under only the first parent", () => {
    const c1 = find(forest, "Cat1")!;
    const c2 = find(forest, "Cat2")!;
    expect(c1.children.some((x) => x.sourceId === "shared.md")).toBe(true);
    expect(c2.children.some((x) => x.sourceId === "shared.md")).toBe(false);
    // and its own child is placed once, under the single Shared instance
    expect(find([c1], "s1.md")).toBeDefined();
  });

  it("collectProjects emits one create-ready task list with no duplicate sourceIds", () => {
    const ps = collectProjects(forest);
    const allTaskIds = ps.flatMap((p) => {
      const ids: string[] = [];
      const walk = (items: OFItem[]) => items.forEach((it) => { ids.push(it.sourceId); walk(it.children); });
      walk(p.tasks);
      return ids;
    });
    expect(allTaskIds.length).toBe(new Set(allTaskIds).size); // no duplicates
  });
});

describe("robustness", () => {
  it("skips unknown child-project keys and guards cycles", () => {
    const cyclic: ProjectNodeInput[] = [
      node({ id: "a.md", title: "A", childProjects: ["B", "Ghost"] }),
      node({ id: "b.md", title: "B", parents: ["A"], childProjects: ["A"] }),
    ];
    expect(() => buildOFForest(cyclic, (i) => i, DEFAULT)).not.toThrow();
  });

  it("findContainmentAnomalies flags a task directly under a folder", () => {
    // Area(folder) with a direct leaf task at depth 1 (would be a task under a folder — illegal).
    const bad: ProjectNodeInput[] = [
      node({ id: "area.md", title: "Area", childProjects: ["Cat"], leafTaskIds: ["loose.md"] }),
      node({ id: "cat.md", title: "Cat", parents: ["Area"], leafTaskIds: ["ok.md"] }),
    ];
    const forest = buildOFForest(bad, (id) => (id === "loose.md" ? "Loose" : "OK"), DEFAULT);
    const anomalies = findContainmentAnomalies(forest);
    expect(anomalies.some((a) => a.name === "Loose")).toBe(true);
  });

  it("no anomalies for the well-formed fixture", () => {
    expect(findContainmentAnomalies(buildOFForest(FIXTURE, leafName, DEFAULT))).toEqual([]);
  });
});

// =====================================================================
describe("inferred sequential containers + blockedBy ordering (#8)", () => {
  // Cat's direct children (B, C, Task A) carry an intra-container dependency edge, so Cat is INFERRED
  // sequential (no tag): a.md blockedBy c.md, b.md blockedBy a.md → order C, Task A, B.
  const depMap: Record<string, string[]> = { "a.md": ["c.md"], "b.md": ["a.md"] };
  const forest = buildOFForest(FIXTURE, leafName, DEFAULT, { depsFor: (id) => depMap[id] ?? [] });

  it("infers sequential from an intra-container dependency; leaves dep-free containers parallel", () => {
    expect(find(forest, "Cat")!.sequential).toBe(true); // has intra-child deps
    expect(find(forest, "B")!.sequential).toBe(false); // its children g/h have no deps
    expect(find(forest, "Area")!.sequential).toBe(false); // folders never sequential
  });

  it("orders the inferred-sequential container's children by blockedBy (blockers first)", () => {
    expect(find(forest, "Cat")!.children.map((c) => c.name)).toEqual(["C", "Task A", "B"]);
  });

  it("does NOT infer sequential from a cross-container dependency", () => {
    // a.md blocked by something outside Cat → not an intra-container edge → Cat stays parallel.
    const f = buildOFForest(FIXTURE, leafName, DEFAULT, { depsFor: (id) => (id === "a.md" ? ["outside.md"] : []) });
    expect(find(f, "Cat")!.sequential).toBe(false);
  });

  it("the parallel opt-out forces a dependency-bearing container parallel (unordered)", () => {
    const f = buildOFForest(FIXTURE, leafName, DEFAULT, {
      depsFor: (id) => depMap[id] ?? [],
      isForcedParallel: (id) => id === "cat.md",
    });
    expect(find(f, "Cat")!.sequential).toBe(false);
    // original child order preserved (no topo reordering when parallel)
    expect(find(f, "Cat")!.children.map((c) => c.name)).toEqual(["B", "C", "Task A"]);
  });

  it("disables inference entirely when depsFor is omitted (global off switch)", () => {
    const f = buildOFForest(FIXTURE, leafName, DEFAULT); // no opts → no depsFor → nothing sequential
    expect(f.every(function check(it): boolean {
      return it.sequential === false && it.children.every(check);
    })).toBe(true);
  });

  it("collectProjects surfaces the inferred sequential flag", () => {
    expect(collectProjects(forest).find((p) => p.name === "Cat")!.sequential).toBe(true);
  });

  it("forestToCreateOps marks an inferred-sequential action group's create op sequential:true", () => {
    // Give group B an intra-child dep (g blockedBy h) → B inferred sequential; C stays parallel.
    const f2 = buildOFForest(FIXTURE, leafName, DEFAULT, { depsFor: (id) => (id === "g.md" ? ["h.md"] : []) });
    const proj = collectProjects(f2).find((p) => p.name === "Cat")!;
    const fields = (): OFWriteFields => ({
      name: "x", note: null, dueDate: null, deferDate: null, plannedDate: null,
      estimatedMinutes: null, flagged: false, tags: [], completed: false,
    });
    const ops = forestToCreateOps("Cat", proj.tasks, fields);
    const bOp = ops.find((o) => o.op === "create" && o.ref === "b.md");
    expect(bOp && "sequential" in bOp && bOp.sequential).toBe(true);
    const cOp = ops.find((o) => o.op === "create" && o.ref === "c.md");
    expect(cOp && "sequential" in cOp && cOp.sequential).toBe(false);
  });
});
