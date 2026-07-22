import { describe, it, expect } from "vitest";
import { validateHierarchyLevels, typeAtDepth, DEFAULT_HIERARCHY_LEVELS, type OFLevelType } from "../src/plugin/levels.js";

describe("validateHierarchyLevels", () => {
  it("accepts the default and other folder* project task* shapes", () => {
    expect(validateHierarchyLevels(DEFAULT_HIERARCHY_LEVELS).valid).toBe(true);
    expect(validateHierarchyLevels(["folder", "folder", "project", "task"]).valid).toBe(true);
    expect(validateHierarchyLevels(["project", "task"]).valid).toBe(true);
    expect(validateHierarchyLevels(["folder", "project"]).valid).toBe(true); // deeper -> implicit tasks
    expect(validateHierarchyLevels(["project"]).valid).toBe(true);
  });

  it("rejects an empty config", () => {
    expect(validateHierarchyLevels([]).valid).toBe(false);
  });

  it("rejects unknown entry values", () => {
    const r = validateHierarchyLevels(["folder", "widget" as OFLevelType, "task"]);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/widget/);
  });

  it("rejects zero projects", () => {
    expect(validateHierarchyLevels(["folder", "folder"]).valid).toBe(false);
  });

  it("rejects more than one project", () => {
    expect(validateHierarchyLevels(["folder", "project", "project"]).valid).toBe(false);
    expect(validateHierarchyLevels(["project", "task", "project"]).valid).toBe(false);
  });

  it("rejects a folder after a non-folder", () => {
    expect(validateHierarchyLevels(["folder", "project", "folder"]).valid).toBe(false);
    expect(validateHierarchyLevels(["project", "folder"]).valid).toBe(false);
    expect(validateHierarchyLevels(["folder", "task", "folder"]).valid).toBe(false); // (also task-before-project)
  });

  it("rejects a task before the project", () => {
    expect(validateHierarchyLevels(["task", "project"]).valid).toBe(false);
    expect(validateHierarchyLevels(["folder", "task", "project"]).valid).toBe(false);
  });
});

describe("typeAtDepth", () => {
  const L: OFLevelType[] = ["folder", "project", "task"];
  it("maps within the list", () => {
    expect(typeAtDepth(L, 0)).toBe("folder");
    expect(typeAtDepth(L, 1)).toBe("project");
    expect(typeAtDepth(L, 2)).toBe("task");
  });
  it("returns task beyond the list", () => {
    expect(typeAtDepth(L, 3)).toBe("task");
    expect(typeAtDepth(["folder", "project"], 5)).toBe("task");
  });
});
