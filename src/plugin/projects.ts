import type { TaskNote } from "../core/types.js";

/** A minimal TaskNotes FilterQuery group (enough to select project members). */
export interface FilterQuery {
  type: "group";
  id: string;
  conjunction: "and" | "or";
  children: unknown[];
}

/**
 * Build a TaskNotes query selecting tasks whose `projects` contains a link to the given project note.
 * Shape (per the live OpenAPI):
 *   { type:"group", id, conjunction:"and", children:[
 *       { type:"condition", id, property:"projects", operator:"contains", value:"[[<title>]]" } ] }
 * Use stable ids (no Date.now/random).
 */
export function buildProjectMembershipFilter(projectTitle: string): FilterQuery {
  return {
    type: "group",
    id: "tnof-membership",
    conjunction: "and",
    children: [
      {
        type: "condition",
        id: "tnof-projects",
        property: "projects",
        operator: "contains",
        value: `[[${projectTitle}]]`,
      },
    ],
  };
}

/** Drop tasks carrying the ignore tag (per-task opt-out). */
export function filterIgnored(tasks: TaskNote[], ignoreTag: string): TaskNote[] {
  return tasks.filter((t) => !t.tags.includes(ignoreTag));
}

/**
 * Linked taskIds that are no longer a member of ANY synced project — candidates for de-surface.
 * = linkedTaskIds minus the union of current member ids.
 */
export function computeDesurfaceIds(memberIds: Iterable<string>, linkedTaskIds: Iterable<string>): string[] {
  const memberSet = new Set(memberIds);
  const result: string[] = [];
  for (const id of linkedTaskIds) {
    if (!memberSet.has(id)) {
      result.push(id);
    }
  }
  return result;
}
