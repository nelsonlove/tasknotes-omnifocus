// Auto-discovery of the TaskNotes project forest, in PURE functions the plugin wires together.
//
// The vault's project hierarchy is the inverse of the `projects` field: if task B lists task A in
// `projects`, then A has subtask B. A task is a "project-node" iff it has ≥1 subtask (TaskNotes'
// `hasSubtasks` is true). Everything else is a leaf.
//
// We discover the whole forest in TWO queries (not one-per-node):
//   1. every project-node            -> buildHasSubtasksFilter()
//   2. every task that has a parent  -> buildHasParentFilter()  (`projects is-not-empty`)
// then build the parent→child edges in memory from each task's `projects` links.

import type { TaskNote } from "../core/types.js";
import type { ProjectNodeInput } from "./tree.js";
import type { FilterQuery } from "./projects.js";

/**
 * The join key for the project tree: a note's filename basename (its `id` with any folder path and
 * the trailing `.md` removed). Obsidian wikilinks in the `projects` field resolve by BASENAME, not by
 * the `title` frontmatter — a note titled "X—Y" may live in "X — Y.md" and be linked as "[[X — Y]]".
 * So parent↔child matching MUST use the basename, and it doubles as the OmniFocus folder/project name.
 */
export function noteKey(id: string): string {
  const last = id.split("/").pop() ?? id;
  return last.replace(/\.md$/, "");
}

/** A condition excluding archived tasks (they're retired — never surfaced in OmniFocus). */
const notArchived = {
  type: "condition" as const,
  id: "tnof-not-archived",
  property: "archived",
  operator: "is-not-checked",
  value: true,
};

/** Selects every non-archived task that IS a project-node (has subtasks). */
export function buildHasSubtasksFilter(): FilterQuery {
  return {
    type: "group",
    id: "tnof-hassubtasks",
    conjunction: "and",
    children: [
      {
        type: "condition",
        id: "tnof-hassubtasks-cond",
        property: "hasSubtasks",
        operator: "is-checked",
        value: true,
      },
      notArchived,
    ],
  };
}

/** Selects every non-archived task that has at least one parent project (`projects is-not-empty`). */
export function buildHasParentFilter(): FilterQuery {
  return {
    type: "group",
    id: "tnof-hasparent",
    conjunction: "and",
    children: [
      {
        type: "condition",
        id: "tnof-hasparent-cond",
        property: "projects",
        operator: "is-not-empty",
        value: null,
      },
      notArchived,
    ],
  };
}

/**
 * Extract the linked note titles from a `projects` frontmatter array.
 *  - "[[Title]]"        -> "Title"
 *  - "[[Target|Alias]]" -> "Target"   (link target, before the pipe)
 *  - "[[folder/Note]]"  -> "folder/Note" (kept as-is; matching is by the node's own title)
 *  - "Bare"             -> "Bare"      (non-wikilink passes through, trimmed)
 * Blank/whitespace entries are dropped. Implement to satisfy test/discovery.test.ts.
 */
export function extractProjectTitles(projects: string[] | undefined): string[] {
  if (!projects) return [];
  const result: string[] = [];
  for (const entry of projects) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const wikilinkMatch = trimmed.match(/^\[\[(.+?)\]\]$/);
    if (wikilinkMatch) {
      const inside = wikilinkMatch[1];
      const pipeIdx = inside.indexOf("|");
      const target = pipeIdx === -1 ? inside : inside.slice(0, pipeIdx);
      result.push(target.trim());
    } else {
      result.push(trimmed);
    }
  }
  return result;
}

/**
 * Build the ProjectNodeInput[] (for buildOFTree) plus a leaf-task lookup, from the two query results.
 *
 * @param projectNodes every project-node (result of buildHasSubtasksFilter)
 * @param childTasks   every task with a parent (result of buildHasParentFilter)
 * @returns
 *   - inputs: one ProjectNodeInput per project-node, where `title` is the node's KEY (noteKey(id),
 *       i.e. its basename — this is both the join key and the OmniFocus folder/project name), and
 *       parents      = the node's own parent keys, RESTRICTED to keys that are themselves
 *                      project-nodes (defensive: a dangling parent must not hide a real root)
 *       childProjects = keys of this node's direct children that are themselves project-nodes (deduped)
 *       leafTaskIds   = ids of this node's direct children that are NOT project-nodes
 *   - leafById: id -> TaskNote for every leaf task encountered (so the caller can reconcile them
 *               without re-querying)
 *
 * A "direct child" of node N is any task whose extracted `projects` links include N's key.
 * Match project-node membership by KEY: a task is a project-node iff noteKey(its id) is in the
 * project-node key set. Because wikilinks resolve by basename, extractProjectTitles already yields
 * basenames, which are compared directly against noteKey(id). Implement to satisfy test/discovery.test.ts.
 */
export function buildProjectNodeInputs(
  projectNodes: TaskNote[],
  childTasks: TaskNote[],
): { inputs: ProjectNodeInput[]; leafById: Map<string, TaskNote> } {
  // Set of all project-node keys (basenames)
  const projectKeySet = new Set(projectNodes.map((n) => noteKey(n.id)));

  // Build parent-key -> children map from childTasks
  // extractProjectTitles already yields basenames (wikilink targets are basenames)
  const childrenByParent = new Map<string, TaskNote[]>();
  for (const task of childTasks) {
    for (const parentKey of extractProjectTitles(task.projects)) {
      if (!childrenByParent.has(parentKey)) {
        childrenByParent.set(parentKey, []);
      }
      childrenByParent.get(parentKey)!.push(task);
    }
  }

  const leafById = new Map<string, TaskNote>();

  const inputs: ProjectNodeInput[] = projectNodes.map((node) => {
    const key = noteKey(node.id);

    // Parents filtered to only project-nodes (compare basenames against key set)
    const parents = extractProjectTitles(node.projects).filter((t) => projectKeySet.has(t));

    const directChildren = childrenByParent.get(key) ?? [];

    // Collect child project keys (deduped) and leaf task ids
    const childProjectsSet = new Set<string>();
    const leafTaskIds: string[] = [];

    for (const child of directChildren) {
      const childKey = noteKey(child.id);
      if (projectKeySet.has(childKey)) {
        childProjectsSet.add(childKey);
      } else {
        leafTaskIds.push(child.id);
        leafById.set(child.id, child);
      }
    }

    return {
      id: node.id,
      title: key,   // KEY = basename; this is what OmniFocus uses as folder/project name
      parents,
      childProjects: [...childProjectsSet],
      leafTaskIds,
    };
  });

  return { inputs, leafById };
}

/**
 * Keys (noteKey/basenames) whose whole subtree is excluded by the ignore tag: a node is ignored if
 * it OR ANY of its ancestors (walking up parents that are project-nodes, matched by key) carries
 * `ignoreTag`. Cycle-guarded. Returns the set of ignored node KEYS. Implement to satisfy
 * test/discovery.test.ts.
 */
export function computeIgnoredTitles(projectNodes: TaskNote[], ignoreTag: string): Set<string> {
  // Build key (basename) -> node map
  const nodeByKey = new Map<string, TaskNote>();
  for (const node of projectNodes) {
    nodeByKey.set(noteKey(node.id), node);
  }

  const ignored = new Set<string>();

  for (const node of projectNodes) {
    const nodeK = noteKey(node.id);
    // Walk ancestor chain (including self) with cycle guard (tracked by KEY)
    const visited = new Set<string>();
    let current: TaskNote | undefined = node;

    while (current) {
      const curKey = noteKey(current.id);
      if (visited.has(curKey)) break;
      visited.add(curKey);

      if (current.tags.includes(ignoreTag)) {
        ignored.add(nodeK);
        break;
      }

      // Move up to first unvisited parent (extractProjectTitles yields basenames = keys)
      const parentKeys = extractProjectTitles(current.projects);
      let nextNode: TaskNote | undefined = undefined;
      for (const parentKey of parentKeys) {
        if (!visited.has(parentKey)) {
          nextNode = nodeByKey.get(parentKey);
          if (nextNode) break;
        }
      }
      current = nextNode;
    }
  }

  return ignored;
}

/**
 * Drop ignored nodes from the input set and strip ignored titles out of every surviving node's
 * childProjects (so the pruned subtree does not dangle). Implement to satisfy test/discovery.test.ts.
 */
export function pruneIgnored(inputs: ProjectNodeInput[], ignoredTitles: Set<string>): ProjectNodeInput[] {
  return inputs
    .filter((input) => !ignoredTitles.has(input.title))
    .map((input) => ({
      ...input,
      childProjects: input.childProjects.filter((cp) => !ignoredTitles.has(cp)),
    }));
}
