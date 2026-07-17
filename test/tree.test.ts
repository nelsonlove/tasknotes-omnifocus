import { describe, it, expect } from "vitest";
import { buildOFTree, flattenFolders, flattenProjects, type OFNode, type ProjectNodeInput } from "../src/plugin/tree.js";

const node = (o: Partial<ProjectNodeInput> & { title: string; id: string }): ProjectNodeInput => ({
  parents: [],
  childProjects: [],
  leafTaskIds: [],
  ...o,
});

// Area (folder)
//   ProjA (project: t1,t2)
//   MixedP (mixed -> folder + synthetic project MixedP: t3)
//     SubP (project: t4)
// Solo (root project: t5)
const FIXTURE: ProjectNodeInput[] = [
  node({ id: "area.md", title: "Area", childProjects: ["ProjA", "MixedP"] }),
  node({ id: "proja.md", title: "ProjA", parents: ["Area"], leafTaskIds: ["t1", "t2"] }),
  node({ id: "mixedp.md", title: "MixedP", parents: ["Area"], childProjects: ["SubP"], leafTaskIds: ["t3"] }),
  node({ id: "subp.md", title: "SubP", parents: ["MixedP"], leafTaskIds: ["t4"] }),
  node({ id: "solo.md", title: "Solo", leafTaskIds: ["t5"] }),
];

function findNode(roots: OFNode[], pred: (n: OFNode) => boolean): OFNode | undefined {
  for (const n of roots) {
    if (pred(n)) return n;
    const inner = findNode(n.children, pred);
    if (inner) return inner;
  }
  return undefined;
}

describe("buildOFTree", () => {
  const roots = buildOFTree(FIXTURE);

  it("roots are the parent-less nodes, classified", () => {
    const titles = roots.map((r) => `${r.title}:${r.kind}`).sort();
    expect(titles).toEqual(["Area:folder", "Solo:project"]);
  });

  it("a node with only child-projects is a FOLDER at the right path", () => {
    const area = findNode(roots, (n) => n.title === "Area")!;
    expect(area.kind).toBe("folder");
    expect(area.path).toEqual([]);
    expect(area.leafTaskIds).toEqual([]);
    expect(area.children.map((c) => c.title).sort()).toEqual(["MixedP", "ProjA"]);
  });

  it("a node with only leaf tasks is a PROJECT carrying those tasks", () => {
    const projA = findNode(roots, (n) => n.title === "ProjA" && n.kind === "project")!;
    expect(projA.path).toEqual(["Area"]);
    expect(projA.leafTaskIds).toEqual(["t1", "t2"]);
    expect(projA.children).toEqual([]);
  });

  it("a mixed node becomes a FOLDER containing a same-named PROJECT (loose tasks) plus sub-projects", () => {
    const mixedFolder = findNode(roots, (n) => n.title === "MixedP" && n.kind === "folder")!;
    expect(mixedFolder.path).toEqual(["Area"]);
    const synthetic = mixedFolder.children.find((c) => c.title === "MixedP" && c.kind === "project")!;
    expect(synthetic.leafTaskIds).toEqual(["t3"]);
    expect(synthetic.path).toEqual(["Area", "MixedP"]);
    const subp = mixedFolder.children.find((c) => c.title === "SubP")!;
    expect(subp.kind).toBe("project");
    expect(subp.path).toEqual(["Area", "MixedP"]);
    expect(subp.leafTaskIds).toEqual(["t4"]);
  });

  it("skips unknown child-project titles", () => {
    const roots2 = buildOFTree([node({ id: "x.md", title: "X", childProjects: ["Ghost"], leafTaskIds: ["a"] })]);
    // X is mixed (a ghost child-project + a leaf) -> folder + synthetic project; Ghost is skipped.
    const folder = findNode(roots2, (n) => n.title === "X" && n.kind === "folder")!;
    expect(folder.children.map((c) => c.title)).toEqual(["X"]); // only the synthetic project, no Ghost
  });

  it("terminates on a cycle (A <-> B) without infinite recursion", () => {
    const cyclic: ProjectNodeInput[] = [
      node({ id: "a.md", title: "A", childProjects: ["B"] }),
      node({ id: "b.md", title: "B", parents: ["A"], childProjects: ["A"] }),
    ];
    expect(() => buildOFTree(cyclic)).not.toThrow();
  });
});

describe("flattenProjects / flattenFolders", () => {
  const roots = buildOFTree(FIXTURE);
  it("lists every project that must exist in OmniFocus", () => {
    expect(flattenProjects(roots).map((p) => p.title).sort()).toEqual(["MixedP", "ProjA", "Solo", "SubP"]);
  });
  it("lists every folder that must exist in OmniFocus", () => {
    expect(flattenFolders(roots).map((f) => f.title).sort()).toEqual(["Area", "MixedP"]);
  });
});
