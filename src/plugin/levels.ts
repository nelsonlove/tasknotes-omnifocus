// The configurable depth→type map: hierarchyLevels[depth] is the OmniFocus representation for a node
// at that depth (root = 0); nodes deeper than the list keep nesting as "task".
//
// OmniFocus containment rules constrain valid configs: a folder holds folders + projects (not tasks);
// a project holds tasks (no project-in-project); a task holds tasks. So the only valid shape is:
//   all `folder`s, then exactly one `project`, then all `task`s.

export type OFLevelType = "folder" | "project" | "task";

export const DEFAULT_HIERARCHY_LEVELS: OFLevelType[] = ["folder", "project", "task"];

export interface LevelValidation {
  valid: boolean;
  /** Human-readable reason when invalid (empty when valid). */
  reason: string;
}

/**
 * Validate a hierarchyLevels config against the OmniFocus containment rule. Valid iff the sequence
 * matches `folder* project task*` — zero or more folders, then EXACTLY ONE project, then zero or more
 * tasks. Implement to satisfy test/levels.test.ts:
 *  - empty array -> invalid ("must contain exactly one project").
 *  - any entry not in {folder,project,task} -> invalid (name the bad value).
 *  - zero projects -> invalid ("tasks would have nowhere to live" / "must contain exactly one project").
 *  - more than one project -> invalid ("a project cannot contain another project").
 *  - a folder after a non-folder -> invalid ("a folder cannot live inside a project or task").
 *  - a task before the project -> invalid (a task needs a project ancestor).
 */
export function validateHierarchyLevels(levels: OFLevelType[]): LevelValidation {
  const fail = (reason: string): LevelValidation => ({ valid: false, reason });

  const allowed = new Set<string>(["folder", "project", "task"]);
  for (const l of levels) {
    if (!allowed.has(l)) return fail(`unknown level type "${l}" (must be folder, project, or task)`);
  }

  const projectCount = levels.filter((l) => l === "project").length;
  if (projectCount === 0) {
    return fail("config must contain exactly one project — tasks would have nowhere to live");
  }
  if (projectCount > 1) {
    return fail("config has more than one project, but a project cannot contain another project");
  }

  // Enforce the shape: folder* project task*.
  let seenProject = false;
  let seenTask = false;
  for (const l of levels) {
    if (l === "folder") {
      if (seenProject || seenTask) {
        return fail("a folder cannot live inside a project or task — folders must come first");
      }
    } else if (l === "project") {
      seenProject = true;
    } else {
      // task
      if (!seenProject) {
        return fail("a task appears before the project — tasks need a project ancestor");
      }
      seenTask = true;
    }
  }

  return { valid: true, reason: "" };
}

/**
 * The OmniFocus type for a node at `depth` given `levels`: levels[depth], or "task" for any depth
 * beyond the list (tasks nest arbitrarily deep as action groups). Assumes `levels` is valid.
 */
export function typeAtDepth(levels: OFLevelType[], depth: number): OFLevelType {
  return depth < levels.length ? levels[depth] : "task";
}
