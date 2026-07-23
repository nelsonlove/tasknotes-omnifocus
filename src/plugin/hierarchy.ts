// Depth→type mapping of the TaskNotes project-node forest into an OmniFocus item tree, per the
// configurable hierarchyLevels (see levels.ts). Pure; no I/O.
//
// A node's OmniFocus type is typeAtDepth(levels, depth) where depth is its distance from a root
// (root = 0). Project-nodes (tasks that have subtasks) and leaf tasks both become OFItems:
//   - folder  → an OmniFocus folder (children: folders + projects)
//   - project → a single-action-list project (children: the task forest)
//   - task    → an OmniFocus task; with children it is a parallel action group, else a plain task.
// Leaf tasks (no subtasks) are always emitted as `task`.

import type { ProjectNodeInput } from "./tree.js";
import { typeAtDepth } from "./levels.js";
import type { OFLevelType } from "./levels.js";
import { orderByDeps } from "./topo.js";
import type { OFOp } from "../adapters/omnifocus.js";
import type { OFWriteFields } from "../core/types.js";

export interface OFItem {
  /** The TaskNote id this item mirrors (for linking / omnifocusUrl). */
  sourceId: string;
  /** OmniFocus display name: a project-node's key (basename) or a leaf task's title. */
  name: string;
  type: OFLevelType;
  /**
   * Whether this container was marked sequential (#8) — its OmniFocus mirror runs children in order
   * (a sequential project, or a sequential action group) and its direct children are ordered by their
   * blockedBy dependencies. Only meaningful for `project`/`task` container nodes; always false for folders.
   */
  sequential: boolean;
  /** Direct OmniFocus children (folders/projects under a folder; tasks under a project or task). */
  children: OFItem[];
}

/** Optional sequencing inputs for buildOFForest (#8): which nodes are sequential + each task's blockers. */
export interface ForestOptions {
  /** True if the node id names a container the user marked sequential. */
  isSequential?: (sourceId: string) => boolean;
  /** The blocker task ids for a task id (its blockedBy), used to order a sequential container's children. */
  depsFor?: (sourceId: string) => string[];
}

/**
 * Build the typed OmniFocus forest (roots) from the project-node inputs.
 *
 * @param nodes     project-nodes (each: id, title=key/basename, parents, childProjects, leafTaskIds)
 * @param leafName  id -> OmniFocus name for a leaf task (its title)
 * @param levels    validated hierarchyLevels
 *
 * Implement to satisfy test/hierarchy.test.ts:
 *  - Roots = nodes with empty `parents`, at depth 0.
 *  - A project-node at depth d has type typeAtDepth(levels, d); its children are its childProjects
 *    (project-nodes, depth d+1, resolved by key) followed by its leafTaskIds (leaf tasks, depth d+1).
 *  - A leaf task is always type "task" with no children; its name = leafName(id).
 *  - Cycle-guard: a node already on the ancestor stack is not re-expanded. Unknown child-project keys
 *    (no matching input) are skipped.
 */
export function buildOFForest(
  nodes: ProjectNodeInput[],
  leafName: (id: string) => string,
  levels: OFLevelType[],
  opts: ForestOptions = {},
): OFItem[] {
  // Index nodes by title (key) for O(1) child lookup
  const byTitle = new Map<string, ProjectNodeInput>();
  for (const n of nodes) {
    byTitle.set(n.title, n);
  }

  // A TaskNotes task may have multiple parents; place each sourceId (project-node OR leaf) exactly
  // ONCE — under the first parent reached in traversal ("first parent wins"). Without this, a
  // multi-parent task is emitted under every parent and creates duplicate OmniFocus tasks.
  const placed = new Set<string>();

  /**
   * Recursively expand a single project-node input into an OFItem.
   *
   * @param input     - the ProjectNodeInput to expand
   * @param depth     - this node's depth (root = 0)
   * @param ancestors - set of titles already on the current ancestor stack (cycle guard)
   */
  function expand(input: ProjectNodeInput, depth: number, ancestors: Set<string>): OFItem {
    const type = typeAtDepth(levels, depth);
    const newAncestors = new Set(ancestors).add(input.title);

    // Expand child project-nodes, skipping unknowns and cycle ancestors
    let children: OFItem[] = [];
    for (const childKey of input.childProjects) {
      if (ancestors.has(childKey)) continue; // cycle guard
      const childInput = byTitle.get(childKey);
      if (!childInput) continue; // skip unknowns
      if (placed.has(childInput.id)) continue; // already placed under an earlier parent
      placed.add(childInput.id);
      children.push(expand(childInput, depth + 1, newAncestors));
    }

    // Leaf tasks are always type "task" with no children
    for (const id of input.leafTaskIds) {
      if (placed.has(id)) continue; // already placed under an earlier parent
      placed.add(id);
      children.push({ sourceId: id, name: leafName(id), type: "task", sequential: false, children: [] });
    }

    // #8: only project/task containers can be sequential (a folder holds projects, not ordered tasks).
    // When sequential, order the direct children by their blockedBy dependencies (blockers first).
    const isContainer = type === "project" || type === "task";
    const sequential = isContainer && (opts.isSequential?.(input.id) ?? false);
    if (sequential && opts.depsFor) {
      const depsFor = opts.depsFor;
      const ordered = orderByDeps(children.map((c) => c.sourceId), depsFor);
      const byId = new Map(children.map((c) => [c.sourceId, c]));
      children = ordered.map((id) => byId.get(id)!);
    }

    return { sourceId: input.id, name: input.title, type, sequential, children };
  }

  // Roots = nodes with empty parents, expanded at depth 0
  const roots: OFItem[] = [];
  for (const n of nodes) {
    if (n.parents.length === 0) {
      if (placed.has(n.id)) continue;
      placed.add(n.id);
      roots.push(expand(n, 0, new Set()));
    }
  }
  return roots;
}

export interface FolderPlacement {
  sourceId: string;
  name: string;
  /** Ancestor folder names, outermost first (the folder path this folder sits in). */
  path: string[];
}

export interface ProjectPlacement {
  sourceId: string;
  name: string;
  /** Ancestor folder names, outermost first ([] = top level). */
  folderPath: string[];
  /** The project's task forest (its `task`-typed children subtree). */
  tasks: OFItem[];
  /** #8: this project was marked sequential — scaffold it as a sequential project (not a single-action list). */
  sequential: boolean;
}

/**
 * Flatten the forest to every folder that must exist, with its ancestor-folder path. Implement to
 * satisfy test/hierarchy.test.ts.
 */
export function collectFolders(forest: OFItem[]): FolderPlacement[] {
  const result: FolderPlacement[] = [];

  function walk(items: OFItem[], ancestorFolders: string[]): void {
    for (const item of items) {
      if (item.type === "folder") {
        result.push({ sourceId: item.sourceId, name: item.name, path: ancestorFolders });
        walk(item.children, [...ancestorFolders, item.name]);
      } else {
        walk(item.children, ancestorFolders);
      }
    }
  }

  walk(forest, []);
  return result;
}

/**
 * Flatten the forest to every project that must exist, each with its containing folder path and its
 * task forest. Implement to satisfy test/hierarchy.test.ts.
 */
export function collectProjects(forest: OFItem[]): ProjectPlacement[] {
  const result: ProjectPlacement[] = [];

  function walk(items: OFItem[], ancestorFolders: string[]): void {
    for (const item of items) {
      if (item.type === "project") {
        result.push({
          sourceId: item.sourceId,
          name: item.name,
          folderPath: ancestorFolders,
          tasks: item.children,
          sequential: item.sequential,
        });
        // Still recurse in case there are nested structures inside the project
        walk(item.children, ancestorFolders);
      } else if (item.type === "folder") {
        walk(item.children, [...ancestorFolders, item.name]);
      } else {
        // task: recurse without adding to folder path
        walk(item.children, ancestorFolders);
      }
    }
  }

  walk(forest, []);
  return result;
}

/**
 * Anomalies that violate OmniFocus containment given the config (should not occur with a well-formed
 * vault + valid config, but surfaced rather than silently mis-placed): a `task` whose parent chain has
 * no `project` ancestor, or a `folder`/`project` appearing under a `project`/`task`. Returns a list of
 * `{ sourceId, name, problem }`. Implement to satisfy test/hierarchy.test.ts.
 */
/**
 * Translate a project's task forest into ordered `create` OFOps, depth-first, PARENT BEFORE CHILDREN.
 * Idempotent: a task already linked (`linkedPk(sourceId)` returns its primaryKey) is NOT re-created —
 * its children instead nest under the existing OF task via `parentPrimaryKey`. A new task nests under
 * its parent via `parentRef` (if the parent is also new this batch) or `parentPrimaryKey` (if the
 * parent is already linked). A create for a task with children is marked `sequential: false` (parallel
 * action group). `ref` = sourceId (the TaskNote id); `fieldsFor` supplies the create fields. Non-task
 * nodes (folders/projects, handled by ensureStructure) are walked through.
 */
export function forestToCreateOps(
  project: string,
  items: OFItem[],
  fieldsFor: (sourceId: string, name: string) => OFWriteFields,
  linkedPk: (sourceId: string) => string | null = () => null,
): OFOp[] {
  const ops: OFOp[] = [];
  function walk(nodes: OFItem[], parent: { ref?: string; pk?: string }): void {
    for (const n of nodes) {
      if (n.type !== "task") {
        walk(n.children, parent);
        continue;
      }
      const existing = linkedPk(n.sourceId);
      if (existing) {
        // Already synced — don't recreate; its children hang off the existing OF task.
        walk(n.children, { pk: existing });
        continue;
      }
      const op: OFOp = { op: "create", ref: n.sourceId, project, fields: fieldsFor(n.sourceId, n.name) };
      if (parent.ref !== undefined) op.parentRef = parent.ref;
      else if (parent.pk !== undefined) op.parentPrimaryKey = parent.pk;
      // An action group is parallel by default; mark it sequential (#8) when the container is marked.
      if (n.children.length > 0) op.sequential = n.sequential === true;
      ops.push(op);
      walk(n.children, { ref: n.sourceId });
    }
  }
  walk(items, {});
  return ops;
}

export function findContainmentAnomalies(forest: OFItem[]): { sourceId: string; name: string; problem: string }[] {
  const result: { sourceId: string; name: string; problem: string }[] = [];

  /**
   * Walk the forest tracking the ancestor type chain.
   *
   * @param items         - nodes to check
   * @param ancestorTypes - types of all ancestors, outermost first
   */
  function walk(items: OFItem[], ancestorTypes: OFLevelType[]): void {
    for (const item of items) {
      const parentType = ancestorTypes.length > 0 ? ancestorTypes[ancestorTypes.length - 1] : null;

      if (item.type === "task") {
        // A task must have a "project" somewhere in its ancestor chain
        if (!ancestorTypes.includes("project")) {
          result.push({ sourceId: item.sourceId, name: item.name, problem: "task has no project ancestor" });
        }
      } else if (item.type === "folder" || item.type === "project") {
        // A folder or project cannot be contained inside a project or task
        if (parentType === "project" || parentType === "task") {
          result.push({
            sourceId: item.sourceId,
            name: item.name,
            problem: `${item.type} inside a ${parentType}`,
          });
        }
      }

      walk(item.children, [...ancestorTypes, item.type]);
    }
  }

  walk(forest, []);
  return result;
}
