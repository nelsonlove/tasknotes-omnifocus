import { describe, it, expect } from "vitest";
import {
  buildHasParentFilter,
  buildHasSubtasksFilter,
  buildProjectNodeInputs,
  computeIgnoredTitles,
  computeParallelIds,
  extractProjectTitles,
  noteKey,
  pruneIgnored,
} from "../src/plugin/discovery.js";
import type { TaskNote } from "../src/core/types.js";
import type { ProjectNodeInput } from "../src/plugin/tree.js";

const tn = (o: Partial<TaskNote> & { id: string; title: string }): TaskNote => ({
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
});

// A TaskNote's parent links live in a field the core doesn't model (`projects`). Discovery reads it
// off the raw task, so tests attach it as an extra property the way the adapter would surface it.
const withProjects = (t: TaskNote, projects: string[]): TaskNote =>
  Object.assign(t, { projects });

describe("filter builders", () => {
  it("hasSubtasks filter selects project-nodes", () => {
    const f = buildHasSubtasksFilter();
    expect(f.type).toBe("group");
    const cond = f.children[0] as Record<string, unknown>;
    expect(cond.property).toBe("hasSubtasks");
    expect(cond.operator).toBe("is-checked");
  });

  it("hasParent filter selects tasks with a non-empty projects field", () => {
    const f = buildHasParentFilter();
    const cond = f.children[0] as Record<string, unknown>;
    expect(cond.property).toBe("projects");
    expect(cond.operator).toBe("is-not-empty");
  });

  it("uses stable ids (no Date.now/random)", () => {
    expect(buildHasSubtasksFilter().id).toBe(buildHasSubtasksFilter().id);
    expect(buildHasParentFilter().id).toBe(buildHasParentFilter().id);
  });

  it("both filters exclude archived tasks", () => {
    for (const f of [buildHasSubtasksFilter(), buildHasParentFilter()]) {
      const archived = f.children.find((c) => (c as Record<string, unknown>).property === "archived") as
        | Record<string, unknown>
        | undefined;
      expect(archived?.operator).toBe("is-not-checked");
    }
  });
});

describe("extractProjectTitles", () => {
  it("strips wikilink brackets", () => {
    expect(extractProjectTitles(["[[Area]]", "[[Q3 Budget review]]"])).toEqual(["Area", "Q3 Budget review"]);
  });
  it("takes the link target before an alias pipe", () => {
    expect(extractProjectTitles(["[[Target|Shown]]"])).toEqual(["Target"]);
  });
  it("passes through bare (non-wikilink) titles, trimmed", () => {
    expect(extractProjectTitles([" Plain "])).toEqual(["Plain"]);
  });
  it("drops blank entries and handles undefined", () => {
    expect(extractProjectTitles(["", "  ", "[[A]]"])).toEqual(["A"]);
    expect(extractProjectTitles(undefined)).toEqual([]);
  });
});

describe("buildProjectNodeInputs", () => {
  // Forest:
  //   Area (node) -> children: ProjA (node), MixedP (node)
  //   ProjA (node) -> children: t1 (leaf), t2 (leaf)
  //   MixedP (node) -> children: SubP (node), t3 (leaf)
  //   SubP (node) -> child: t4 (leaf)
  //   Solo (node, root) -> child: t5 (leaf)
  const Area = withProjects(tn({ id: "d/Area.md", title: "Area" }), []);
  const ProjA = withProjects(tn({ id: "d/ProjA.md", title: "ProjA" }), ["[[Area]]"]);
  const MixedP = withProjects(tn({ id: "d/MixedP.md", title: "MixedP" }), ["[[Area]]"]);
  const SubP = withProjects(tn({ id: "d/SubP.md", title: "SubP" }), ["[[MixedP]]"]);
  const Solo = withProjects(tn({ id: "d/Solo.md", title: "Solo" }), []);
  const t1 = withProjects(tn({ id: "t1.md", title: "t1" }), ["[[ProjA]]"]);
  const t2 = withProjects(tn({ id: "t2.md", title: "t2" }), ["[[ProjA]]"]);
  const t3 = withProjects(tn({ id: "t3.md", title: "t3" }), ["[[MixedP]]"]);
  const t4 = withProjects(tn({ id: "t4.md", title: "t4" }), ["[[SubP]]"]);
  const t5 = withProjects(tn({ id: "t5.md", title: "t5" }), ["[[Solo]]"]);

  const projectNodes = [Area, ProjA, MixedP, SubP, Solo];
  const childTasks = [ProjA, MixedP, SubP, t1, t2, t3, t4, t5];

  const { inputs, leafById } = buildProjectNodeInputs(projectNodes, childTasks);
  const byTitle = new Map(inputs.map((i) => [i.title, i]));

  it("produces one input per project-node", () => {
    expect(inputs.map((i) => i.title).sort()).toEqual(["Area", "MixedP", "ProjA", "SubP", "Solo"].sort());
  });

  it("classifies child project-nodes vs leaf tasks", () => {
    expect(byTitle.get("Area")!.childProjects.sort()).toEqual(["MixedP", "ProjA"]);
    expect(byTitle.get("Area")!.leafTaskIds).toEqual([]);
    expect(byTitle.get("ProjA")!.childProjects).toEqual([]);
    expect(byTitle.get("ProjA")!.leafTaskIds.sort()).toEqual(["t1.md", "t2.md"]);
    expect(byTitle.get("MixedP")!.childProjects).toEqual(["SubP"]);
    expect(byTitle.get("MixedP")!.leafTaskIds).toEqual(["t3.md"]);
  });

  it("sets parents restricted to project-node titles; roots have empty parents", () => {
    expect(byTitle.get("Area")!.parents).toEqual([]);
    expect(byTitle.get("Solo")!.parents).toEqual([]);
    expect(byTitle.get("ProjA")!.parents).toEqual(["Area"]);
    expect(byTitle.get("SubP")!.parents).toEqual(["MixedP"]);
  });

  it("returns a leaf lookup covering every leaf task", () => {
    expect([...leafById.keys()].sort()).toEqual(["t1.md", "t2.md", "t3.md", "t4.md", "t5.md"]);
    expect(leafById.get("t1.md")!.title).toBe("t1");
  });

  // The real-vault bug: a note's `title` frontmatter differs from its filename (em-dash spacing),
  // and children link it by FILENAME. Joining on title loses them; joining on basename recovers them.
  it("joins parent↔child by filename basename, NOT the title frontmatter", () => {
    // The note's title uses a tight em-dash ("Report—Q3") but its filename spaces it
    // ("Report — Q3.md"); children link by filename. Joining on title would lose them.
    const parent = withProjects(
      tn({ id: "dir/Report — Q3 draft.md", title: "Report—Q3 draft" }),
      [],
    );
    const kid = withProjects(tn({ id: "dir/Appendix figures.md", title: "Appendix figures" }), [
      "[[Report — Q3 draft]]",
    ]);
    const { inputs: got } = buildProjectNodeInputs([parent], [kid]);
    expect(got).toHaveLength(1);
    // The node's key/title is the basename, and the child resolves as its leaf.
    expect(got[0].title).toBe("Report — Q3 draft");
    expect(got[0].leafTaskIds).toEqual(["dir/Appendix figures.md"]);
  });
});

describe("noteKey", () => {
  it("strips folder path and .md extension", () => {
    expect(noteKey("a/b/My Note.md")).toBe("My Note");
    expect(noteKey("Top.md")).toBe("Top");
    expect(noteKey("bare")).toBe("bare");
  });
});

describe("computeIgnoredTitles", () => {
  const A = withProjects(tn({ id: "A.md", title: "A", tags: ["omnifocus/ignore"] }), []);
  const B = withProjects(tn({ id: "B.md", title: "B" }), ["[[A]]"]); // descendant of ignored A
  const C = withProjects(tn({ id: "C.md", title: "C" }), ["[[B]]"]); // deeper descendant
  const D = withProjects(tn({ id: "D.md", title: "D" }), []); // unrelated, not ignored

  it("ignores a tagged node and its whole subtree", () => {
    const ignored = computeIgnoredTitles([A, B, C, D], "omnifocus/ignore");
    expect(ignored.has("A")).toBe(true);
    expect(ignored.has("B")).toBe(true);
    expect(ignored.has("C")).toBe(true);
    expect(ignored.has("D")).toBe(false);
  });

  it("does not throw on a parent cycle", () => {
    const X = withProjects(tn({ id: "X.md", title: "X" }), ["[[Y]]"]);
    const Y = withProjects(tn({ id: "Y.md", title: "Y" }), ["[[X]]"]);
    expect(() => computeIgnoredTitles([X, Y], "omnifocus/ignore")).not.toThrow();
  });
});

describe("computeParallelIds (#8 opt-out)", () => {
  const P = withProjects(tn({ id: "P.md", title: "P", tags: ["omnifocus/parallel"] }), []);
  const C = withProjects(tn({ id: "C.md", title: "C" }), ["[[P]]"]); // child of tagged P — NOT inherited
  const Q = withProjects(tn({ id: "Q.md", title: "Q" }), []);

  it("marks only nodes that themselves carry the opt-out tag (no subtree inheritance)", () => {
    const ids = computeParallelIds([P, C, Q], "omnifocus/parallel");
    expect(ids.has("P.md")).toBe(true);
    expect(ids.has("C.md")).toBe(false); // child does not inherit
    expect(ids.has("Q.md")).toBe(false);
  });

  it("returns an empty set for a blank tag", () => {
    expect(computeParallelIds([P], "").size).toBe(0);
  });
});

describe("pruneIgnored", () => {
  const inputs: ProjectNodeInput[] = [
    { id: "a", title: "A", parents: [], childProjects: ["B", "C"], leafTaskIds: [] },
    { id: "b", title: "B", parents: ["A"], childProjects: [], leafTaskIds: ["t1"] },
    { id: "c", title: "C", parents: ["A"], childProjects: [], leafTaskIds: ["t2"] },
  ];

  it("removes ignored nodes and strips them from surviving childProjects", () => {
    const out = pruneIgnored(inputs, new Set(["B"]));
    expect(out.map((i) => i.title).sort()).toEqual(["A", "C"]);
    expect(out.find((i) => i.title === "A")!.childProjects).toEqual(["C"]);
  });
});
