// Pure construction of the OmniFocus folder/project tree from TaskNotes' project hierarchy.
//
// TaskNotes model: a task is a "project node" iff another task references it in `projects`
// (i.e. it has subtasks). A node's children split into child project-nodes and child LEAF tasks
// (tasks that are themselves referenced by no one).
//
// OmniFocus model: Folders contain projects/folders (NOT tasks); Projects contain tasks. So we map:
//   - node with child project-nodes but NO leaf tasks  -> FOLDER
//   - node with leaf tasks but NO child project-nodes  -> PROJECT (leaf tasks become its tasks)
//   - node with BOTH (mixed)                            -> FOLDER + a same-named PROJECT inside it
//        holding the loose leaf tasks (folders can't hold tasks — the "loose notes" fix)

/** One TaskNotes project-node and its resolved children (built by the caller from API queries). */
export interface ProjectNodeInput {
  id: string; // task path
  title: string;
  parents: string[]; // this node's own `projects` (titles) — empty => a root
  childProjects: string[]; // titles of children that are themselves project-nodes
  leafTaskIds: string[]; // ids of children that are leaf tasks
}

export type OFNodeKind = "folder" | "project";

export interface OFNode {
  title: string;
  /** The TaskNotes project-node this came from (for a mixed node, both the folder and its synthetic project share it). */
  sourceId: string;
  kind: OFNodeKind;
  /** Ancestor folder titles, outermost first (the OmniFocus folder path this node sits in). */
  path: string[];
  /** Sub-folders/projects (for folders). Empty for projects. */
  children: OFNode[];
  /** Leaf task ids that live directly in this project. Empty for folders. */
  leafTaskIds: string[];
}

/**
 * Build the OmniFocus node tree (roots) from the project-node inputs. Implement to satisfy
 * test/tree.test.ts:
 *  - Roots = nodes with empty `parents`.
 *  - Classify each node folder/project/mixed per the rules above; recurse into child project-nodes.
 *  - A mixed node yields a FOLDER whose children include a same-named PROJECT (carrying the loose
 *    leaf tasks) plus the recursively-classified child project-nodes.
 *  - `path` is the ancestor folder titles (outermost first); a root's path is [].
 *  - Guard against cycles (a node already on the current ancestor stack is not re-expanded).
 *  - Unknown child-project titles (no matching input) are skipped.
 */
export function buildOFTree(nodes: ProjectNodeInput[]): OFNode[] {
  // Index nodes by title for O(1) lookup when resolving childProjects
  const byTitle = new Map<string, ProjectNodeInput>();
  for (const n of nodes) {
    byTitle.set(n.title, n);
  }

  /**
   * Classify and recursively expand a single input node into one or two OFNodes.
   *
   * @param input   - the ProjectNodeInput to classify
   * @param path    - ancestor folder titles, outermost-first (this node's path, not its children's)
   * @param ancestors - set of titles already on the current ancestor stack (cycle guard)
   * @returns OFNode[] — one node (folder or project) or two nodes for the mixed case, but callers
   *          always receive the "top-level" result: this function returns the single OFNode that
   *          represents `input` in the tree.
   */
  function classify(input: ProjectNodeInput, path: string[], ancestors: Set<string>): OFNode {
    const hasMixed = input.childProjects.length > 0 && input.leafTaskIds.length > 0;
    const hasOnlyChildren = input.childProjects.length > 0 && input.leafTaskIds.length === 0;
    const hasOnlyLeaves = input.childProjects.length === 0;

    if (hasOnlyLeaves || (hasOnlyChildren === false && hasMixed === false)) {
      // Pure project (no child projects, may or may not have leaf tasks)
      return {
        title: input.title,
        sourceId: input.id,
        kind: "project",
        path,
        children: [],
        leafTaskIds: input.leafTaskIds,
      };
    }

    // From here the node has child projects (pure folder or mixed folder)
    // Build the child path = path + [this title]  (this node is a folder)
    const childPath = [...path, input.title];

    // Expand child project-nodes, skipping unknowns and cycle ancestors
    const newAncestors = new Set(ancestors).add(input.title);
    const childNodes: OFNode[] = [];
    for (const childTitle of input.childProjects) {
      if (ancestors.has(childTitle)) continue; // cycle guard
      const childInput = byTitle.get(childTitle);
      if (!childInput) continue; // skip unknowns
      childNodes.push(classify(childInput, childPath, newAncestors));
    }

    if (hasOnlyChildren) {
      // Pure folder
      return {
        title: input.title,
        sourceId: input.id,
        kind: "folder",
        path,
        children: childNodes,
        leafTaskIds: [],
      };
    }

    // Mixed: folder + synthetic same-named project carrying the loose leaf tasks
    // Synthetic project's path = childPath (it lives inside the folder)
    const syntheticProject: OFNode = {
      title: input.title,
      sourceId: input.id,
      kind: "project",
      path: childPath,
      children: [],
      leafTaskIds: input.leafTaskIds,
    };

    return {
      title: input.title,
      sourceId: input.id,
      kind: "folder",
      path,
      // synthetic project FIRST, then the real child project-nodes
      children: [syntheticProject, ...childNodes],
      leafTaskIds: [],
    };
  }

  // Roots are nodes with empty parents
  const roots: OFNode[] = [];
  for (const n of nodes) {
    if (n.parents.length === 0) {
      roots.push(classify(n, [], new Set()));
    }
  }
  return roots;
}

/** Flatten the tree to the list of projects that need to exist in OmniFocus (kind === "project"). */
export function flattenProjects(roots: OFNode[]): OFNode[] {
  const result: OFNode[] = [];
  function walk(nodes: OFNode[]): void {
    for (const n of nodes) {
      if (n.kind === "project") result.push(n);
      walk(n.children);
    }
  }
  walk(roots);
  return result;
}

/** Flatten the tree to the list of folders that need to exist in OmniFocus (kind === "folder"). */
export function flattenFolders(roots: OFNode[]): OFNode[] {
  const result: OFNode[] = [];
  function walk(nodes: OFNode[]): void {
    for (const n of nodes) {
      if (n.kind === "folder") result.push(n);
      walk(n.children);
    }
  }
  walk(roots);
  return result;
}
