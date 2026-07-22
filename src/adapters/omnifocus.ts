import type { OFWriteFields, OmniFocusTask } from "../core/types.js";
import { canonicalDate } from "../core/dates.js";
import { execFileSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/** Runs an OmniJS source string inside OmniFocus and returns its stdout (the script's JSON result). */
export type OmniJSRunner = (source: string) => Promise<string>;

/** The raw per-task shape our OmniJS read script emits (before normalization). */
export interface RawOFTask {
  id: string;
  name: string;
  note: string | null;
  completed: boolean;
  /** epoch ms or ISO string or null */
  due: string | number | null;
  /** epoch ms or ISO string or null */
  defer: string | number | null;
  /** epoch ms or ISO string or null */
  planned: string | number | null;
  estimatedMinutes: number | null;
  flagged: boolean;
  tags: string[];
}

/** One OmniFocus-side mutation, translated from the reconcile Plan by the executor. */
export type OFOp =
  // Create a task. Placement, in priority order: `parentRef` → under the parent task created earlier
  // THIS batch (action group); `parentPrimaryKey` → under an EXISTING OF task by id (a new child of an
  // already-synced parent); else directly in `project`. `sequential: false` marks the created task a
  // parallel action group (set when it will have children). Batches ordered parents-before-children.
  | { op: "create"; ref: string; project: string; parentRef?: string; parentPrimaryKey?: string; sequential?: boolean; fields: OFWriteFields }
  | { op: "update"; primaryKey: string; fields: Partial<OFWriteFields> }
  | { op: "delete"; primaryKey: string }
  // "enrich" a PROJECT's own root-task fields (due/defer/flag/note/completion). primaryKey is the
  // project's primaryKey. Completion maps to Project.Status (Done/Active); name/tags are not written.
  | { op: "updateProject"; primaryKey: string; fields: Partial<OFWriteFields> };

export interface BatchResult {
  /** create `ref` (caller correlation id, e.g. taskId) -> new primaryKey */
  created: Record<string, string>;
  updated: string[];
  deleted: string[];
  errors: { ref?: string; primaryKey?: string; message: string }[];
}

/** One OmniFocus folder to ensure exists, identified by its FULL path (outermost-first, including its own title). */
export interface FolderSpec {
  path: string[];
}

/** One OmniFocus project to ensure exists, matched by name, created inside `folderPath` ([] = top level). */
export interface ProjectSpec {
  title: string;
  /** Containing folder path, outermost-first; [] = top level. */
  folderPath: string[];
  /** When true, mark the project a single-action list (`containsSingletonActions = true`). Idempotent. */
  singleActionList?: boolean;
}

export interface ScaffoldResult {
  /** Full paths ("/"-joined) of folders that were newly created this run. */
  createdFolders: string[];
  /** Titles of projects that were newly created this run. */
  createdProjects: string[];
  errors: { path?: string; message: string }[];
}

export interface OmniFocusAdapter {
  /** ONE osascript spawn: returns every task in the named project, normalized. */
  readProject(project: string): Promise<OmniFocusTask[]>;
  /**
   * ONE osascript spawn: returns projects' tasks, normalized, keyed by project NAME. Replaces the
   * per-project readProject fan-out on a full sync (one spawn instead of ~one per project). A name
   * collision (two projects sharing a name) keeps the FIRST one, consistent with readProject's
   * first-match `flattenedProjects.find`. Pass `projectNames` to restrict the read to the in-scope
   * projects (a large vault isn't fully read when few projects matter); omit it to read every project.
   * Callers look up `result[projectName] ?? []`.
   */
  readAllProjects(projectNames?: string[]): Promise<Record<string, OmniFocusTask[]>>;
  /**
   * ONE osascript spawn: returns every top-level OmniFocus INBOX task (tasks with no containing
   * project), normalized. Used by the inbox-capture pass to pull OF-native captures into the vault.
   */
  readInbox(): Promise<OmniFocusTask[]>;
  /** ONE osascript spawn: performs ALL ops inside a single OmniJS script. */
  applyBatch(ops: OFOp[]): Promise<BatchResult>;
  /**
   * ONE osascript spawn: ensure every folder and project exists (create the missing ones),
   * so tasks can reconcile into a project that is guaranteed to be present.
   */
  ensureStructure(folders: FolderSpec[], projects: ProjectSpec[]): Promise<ScaffoldResult>;
  /**
   * ONE osascript spawn: read each named project's OWN fields (its root-task due/defer/flag/note +
   * completion) as an OmniFocusTask (primaryKey = the project's primaryKey). Missing projects are
   * omitted from the result. Used by the enrich pass so a project-node's own fields round-trip.
   */
  readProjectsMeta(projectNames: string[]): Promise<Record<string, OmniFocusTask>>;
  /**
   * ONE osascript spawn: read specific tasks by primaryKey (via Task.byIdentifier), normalized and
   * keyed by primaryKey. Missing tasks are omitted. Used by the de-surface pass so a task leaving
   * scope is distinguished from a genuinely-deleted mirror (present -> delete/complete; absent -> clear).
   */
  readTasksByIds(primaryKeys: string[]): Promise<Record<string, OmniFocusTask>>;
}

/**
 * Embed an arbitrary value as a JS-literal-safe expression inside generated OmniJS source.
 * MUST be injection-safe: JSON.stringify escapes quotes/backslashes/newlines, but ALSO escape
 * U+2028 and U+2029 (valid in JSON strings but are line terminators in JS source, which would
 * break the literal). Implement to satisfy test/omnifocus.test.ts.
 */
export function encodePayload(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
}

/** Normalize a raw OmniJS task into the core's OmniFocusTask (canonical dates, null conventions). */
export function normalizeOFTask(raw: RawOFTask): OmniFocusTask {
  return {
    primaryKey: raw.id,
    name: raw.name,
    note: raw.note ?? null,
    completed: raw.completed,
    dueDate: canonicalDate(raw.due ?? null),
    deferDate: canonicalDate(raw.defer ?? null),
    plannedDate: canonicalDate(raw.planned ?? null),
    estimatedMinutes: raw.estimatedMinutes ?? null,
    flagged: raw.flagged,
    tags: raw.tags ?? [],
  };
}

/**
 * Shared OmniJS per-task projection: maps ONE task to the RawOFTask shape (nested-tag "/"-join,
 * completed/date logic). Referenced by buildReadScript / buildReadInboxScript /
 * buildReadAllProjectsScript so a field change lands in exactly one place and all three stay
 * byte-identical in the task shape they emit. Written as a `function (task) {...}` expression so it
 * can be dropped straight into a `.map(...)`.
 */
const TASK_PROJECTION_JS = `function (task) {
      return {
        id: task.id.primaryKey,
        name: task.name,
        note: task.note || null,
        completed: task.taskStatus === Task.Status.Completed,
        due: task.dueDate ? task.dueDate.getTime() : null,
        defer: task.deferDate ? task.deferDate.getTime() : null,
        planned: task.plannedDate ? task.plannedDate.getTime() : null,
        estimatedMinutes: (task.estimatedMinutes === null || task.estimatedMinutes === undefined) ? null : task.estimatedMinutes,
        flagged: task.flagged,
        tags: task.tags.map(function (t) { var p=[]; var c=t; while(c){ p.unshift(c.name); c=c.parent; } return p.join('/'); })
      };
    }`;

/**
 * Build the OmniJS source that reads all tasks of `project` and ends with JSON.stringify(result),
 * result being RawOFTask[]. Embed the project name via encodePayload. If the project is missing,
 * the script should return "[]" (empty array), not error.
 */
export function buildReadScript(project: string): string {
  const encodedProject = encodePayload(project);
  // Pure OmniJS (runs inside OmniFocus via evaluateJavascript): properties, not JXA function calls.
  return `
(function() {
  var projectName = ${encodedProject};
  var proj = flattenedProjects.find(function (p) { return p.name === projectName; });
  if (!proj) { return JSON.stringify([]); }
  var result = proj.flattenedTasks
    .filter(function (task) { return task.taskStatus !== Task.Status.Dropped; })
    .map(${TASK_PROJECTION_JS});
  return JSON.stringify(result);
})();
`.trim();
}

/**
 * Build the OmniJS source that reads EVERY project's tasks in ONE spawn and ends with
 * JSON.stringify(result), result being Record<projectName, RawOFTask[]>. Iterates `flattenedProjects`
 * and, for each, maps its `flattenedTasks` to the SAME RawOFTask shape buildReadScript emits (same
 * fields, same dropped-filter, same nested-tag join), keyed by the project name.
 *
 * A name collision keeps the FIRST project seen (a `seen` guard), matching readProject/buildReadScript
 * which use `flattenedProjects.find` (first-match); keying by name without the guard would silently let
 * the LAST duplicate win, disagreeing with the rest of the code.
 *
 * When `projectNames` is provided, ONLY projects whose name is in that set are emitted (the names are
 * embedded via encodePayload); callers pass the in-scope project names so a large vault isn't fully
 * read when only a few projects matter. Omit the arg (or pass []) to read every project.
 */
export function buildReadAllProjectsScript(projectNames?: string[]): string {
  const encodedNames = encodePayload(projectNames ?? []);
  return `
(function() {
  var wanted = ${encodedNames};
  var filterByName = wanted.length > 0;
  var wantedSet = {};
  for (var i = 0; i < wanted.length; i++) { wantedSet[wanted[i]] = true; }
  var result = {};
  var seen = {};
  flattenedProjects.forEach(function (proj) {
    if (filterByName && wantedSet[proj.name] !== true) { return; }
    // First-match on duplicate names (consistent with flattenedProjects.find elsewhere).
    if (seen[proj.name] === true) { return; }
    seen[proj.name] = true;
    result[proj.name] = proj.flattenedTasks
      .filter(function (task) { return task.taskStatus !== Task.Status.Dropped; })
      .map(${TASK_PROJECTION_JS});
  });
  return JSON.stringify(result);
})();
`.trim();
}

/**
 * Build the OmniJS source that reads the global `inbox` (top-level OmniFocus inbox tasks — tasks
 * with no containing project) and ends with JSON.stringify(result), result being RawOFTask[]. Maps
 * each task exactly like buildReadScript maps a project's tasks (same fields, same nested-tag join).
 */
export function buildReadInboxScript(): string {
  // Pure OmniJS (runs inside OmniFocus via evaluateJavascript): the global `inbox` is the array of
  // top-level inbox tasks. Mirror buildReadScript's per-task mapping exactly.
  return `
(function() {
  var result = inbox
    .filter(function (task) { return task.taskStatus !== Task.Status.Dropped; })
    .map(${TASK_PROJECTION_JS});
  return JSON.stringify(result);
})();
`.trim();
}

/**
 * Build the OmniJS source that performs every op in `ops` (create/update/delete) and ends with
 * JSON.stringify(result: BatchResult). Embed `ops` via encodePayload. Per-op failures are collected
 * into result.errors (keyed by ref/primaryKey) rather than aborting the whole batch. A create must
 * put the new task's primaryKey into result.created[ref].
 */
export function buildBatchScript(ops: OFOp[]): string {
  const encodedOps = encodePayload(ops);
  // Pure OmniJS: new Task(name, location), Task.byIdentifier, deleteObject, markComplete, tag props.
  return `
(function() {
  var ops = ${encodedOps};
  var result = { created: {}, updated: [], deleted: [], errors: [] };
  // ref -> the Task created this batch, so a later create with parentRef nests under it (action group).
  var refMap = {};

  // A "/"-separated tag name maps to a NESTED OmniFocus tag hierarchy: "github/sync" -> a "sync" tag
  // under a "github" tag. Walk/create each segment, reusing existing tags at each level; return the leaf.
  function findOrCreateTag(name) {
    var parts = name.split('/');
    var parent = null;
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      if (seg === '') { continue; }
      var found = null;
      if (parent) {
        found = parent.tagNamed(seg);
      } else {
        for (var j = 0; j < tags.length; j++) { if (tags[j].name === seg) { found = tags[j]; break; } }
      }
      if (!found) { found = parent ? new Tag(seg, parent) : new Tag(seg); }
      parent = found;
    }
    return parent;
  }

  function setTaskFields(task, fields) {
    if (fields.name !== undefined && fields.name !== null) { task.name = fields.name; }
    if (fields.note !== undefined) { task.note = fields.note || ''; }
    if (fields.flagged !== undefined) { task.flagged = fields.flagged; }
    if (fields.estimatedMinutes !== undefined) {
      task.estimatedMinutes = (fields.estimatedMinutes === null) ? null : fields.estimatedMinutes;
    }
    if (fields.dueDate !== undefined) { task.dueDate = fields.dueDate ? new Date(fields.dueDate) : null; }
    if (fields.deferDate !== undefined) { task.deferDate = fields.deferDate ? new Date(fields.deferDate) : null; }
    if (fields.plannedDate !== undefined) { task.plannedDate = fields.plannedDate ? new Date(fields.plannedDate) : null; }
    if (fields.tags !== undefined && fields.tags !== null) {
      task.clearTags();
      fields.tags.forEach(function (n) { task.addTag(findOrCreateTag(n)); });
    }
  }

  for (var i = 0; i < ops.length; i++) {
    var op = ops[i];
    try {
      if (op.op === 'create') {
        var newTask;
        if (op.parentRef) {
          // Nested task (action group): create UNDER the parent task created earlier this batch.
          var parentTask = refMap[op.parentRef];
          if (!parentTask) {
            result.errors.push({ ref: op.ref, message: 'Parent ref not found in batch: ' + op.parentRef });
            continue;
          }
          newTask = new Task(op.fields.name || 'Untitled', parentTask.ending);
        } else if (op.parentPrimaryKey) {
          // New child of an already-synced parent task (found by id).
          var existingParent = Task.byIdentifier(op.parentPrimaryKey);
          if (!existingParent) {
            result.errors.push({ ref: op.ref, message: 'Parent task not found: ' + op.parentPrimaryKey });
            continue;
          }
          newTask = new Task(op.fields.name || 'Untitled', existingParent.ending);
        } else {
          var proj = flattenedProjects.find(function (p) { return p.name === op.project; });
          if (!proj) {
            // ensureStructure runs first and guarantees the project exists; a miss here means a
            // scaffold/name mismatch — surface it rather than silently creating a duplicate top-level project.
            result.errors.push({ ref: op.ref, message: 'Project not found (scaffold missing?): ' + op.project });
            continue;
          }
          newTask = new Task(op.fields.name || 'Untitled', proj.ending);
        }
        setTaskFields(newTask, op.fields);
        // A task with children is an action group; sequential:false makes it parallel.
        if (op.sequential === false) { newTask.sequential = false; }
        if (op.fields.completed) { newTask.markComplete(); }
        refMap[op.ref] = newTask;
        result.created[op.ref] = newTask.id.primaryKey;
      } else if (op.op === 'update') {
        var task = Task.byIdentifier(op.primaryKey);
        if (!task) {
          result.errors.push({ primaryKey: op.primaryKey, message: 'Task not found: ' + op.primaryKey });
          continue;
        }
        setTaskFields(task, op.fields);
        if (op.fields.completed === true) { task.markComplete(); }
        else if (op.fields.completed === false) { task.markIncomplete(); }
        result.updated.push(op.primaryKey);
      } else if (op.op === 'delete') {
        var taskToDelete = Task.byIdentifier(op.primaryKey);
        if (!taskToDelete) {
          result.errors.push({ primaryKey: op.primaryKey, message: 'Task not found: ' + op.primaryKey });
          continue;
        }
        deleteObject(taskToDelete);
        result.deleted.push(op.primaryKey);
      } else if (op.op === 'updateProject') {
        var proj = Project.byIdentifier(op.primaryKey);
        if (!proj) {
          result.errors.push({ primaryKey: op.primaryKey, message: 'Project not found: ' + op.primaryKey });
          continue;
        }
        if (op.fields.note !== undefined) { proj.note = op.fields.note || ''; }
        if (op.fields.flagged !== undefined) { proj.flagged = op.fields.flagged; }
        if (op.fields.dueDate !== undefined) { proj.dueDate = op.fields.dueDate ? new Date(op.fields.dueDate) : null; }
        if (op.fields.deferDate !== undefined) { proj.deferDate = op.fields.deferDate ? new Date(op.fields.deferDate) : null; }
        if (op.fields.completed === true) { proj.status = Project.Status.Done; }
        else if (op.fields.completed === false) { proj.status = Project.Status.Active; }
        result.updated.push(op.primaryKey);
      }
    } catch (e) {
      var errEntry = { message: String(e) };
      if (op.op === 'create') { errEntry.ref = op.ref; } else { errEntry.primaryKey = op.primaryKey; }
      result.errors.push(errEntry);
    }
  }

  return JSON.stringify(result);
})();
`.trim();
}

/**
 * Build the OmniJS source that ensures every folder in `folders` and every project in `projects`
 * exists, and ends with JSON.stringify(result: ScaffoldResult). Embed the input via encodePayload.
 *
 * REQUIREMENTS (implement to satisfy test/omnifocus.test.ts):
 *  - Folders are identified by their FULL path (outermost-first). Create missing folders
 *    PARENTS-FIRST: a nested folder's parent must exist (or be created) before it. Idempotent —
 *    a folder whose full path already exists is reused, never duplicated. Match a folder by walking
 *    its parent chain of names (folder `.parent`) and comparing to the spec path.
 *      OmniJS: `new Folder(name)` (top level), `new Folder(name, parentFolder)` (nested),
 *              `flattenedFolders`, folder `.parent`, folder `.name`.
 *  - Projects are matched BY NAME across the whole database (`flattenedProjects.find(p => p.name === title)`);
 *    if found, reused (folder ignored — documented name-collision caveat). If missing, created inside
 *    its `folderPath` folder (ensuring that folder path first), or at top level when folderPath is [].
 *      OmniJS: `new Project(title, folder)` (in a folder), `new Project(title)` (top level).
 *  - Per-item failures go into result.errors (with the offending "/"-joined path) rather than aborting
 *    the whole scaffold. result.createdFolders / result.createdProjects list only what was NEWLY created.
 */
export function buildScaffoldScript(folders: FolderSpec[], projects: ProjectSpec[]): string {
  const encoded = encodePayload({ folders, projects });
  return `
(function() {
  var payload = ${encoded};
  var folders = payload.folders;
  var projects = payload.projects;
  var result = { createdFolders: [], createdProjects: [], errors: [] };

  function getFolderPath(folder) {
    var chain = [];
    var current = folder;
    while (current) {
      chain.unshift(current.name);
      current = current.parent;
    }
    return chain;
  }

  function pathsEqual(a, b) {
    if (a.length !== b.length) { return false; }
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) { return false; }
    }
    return true;
  }

  function findFolder(path) {
    return flattenedFolders.find(function(f) {
      return pathsEqual(getFolderPath(f), path);
    });
  }

  function ensureFolder(path) {
    if (path.length === 0) { return null; }
    var existing = findFolder(path);
    if (existing) { return existing; }
    var name = path[path.length - 1];
    var newFolder;
    if (path.length === 1) {
      newFolder = new Folder(name);
    } else {
      var parentPath = path.slice(0, path.length - 1);
      var parentFolder = ensureFolder(parentPath);
      newFolder = new Folder(name, parentFolder);
    }
    result.createdFolders.push(path.join('/'));
    return newFolder;
  }

  // Sort folders by path length ascending so parents are created before children.
  var sortedFolders = folders.slice().sort(function(a, b) {
    return a.path.length - b.path.length;
  });

  for (var i = 0; i < sortedFolders.length; i++) {
    var spec = sortedFolders[i];
    try {
      ensureFolder(spec.path);
    } catch (e) {
      result.errors.push({ path: spec.path.join('/'), message: String(e) });
    }
  }

  for (var j = 0; j < projects.length; j++) {
    var projSpec = projects[j];
    try {
      var proj = flattenedProjects.find(function(p) { return p.name === projSpec.title; });
      if (!proj) {
        if (projSpec.folderPath.length === 0) {
          proj = new Project(projSpec.title);
        } else {
          var folder = ensureFolder(projSpec.folderPath);
          proj = new Project(projSpec.title, folder);
        }
        result.createdProjects.push(projSpec.title);
      }
      // Idempotently mark single-action lists (whether newly created or reused).
      if (projSpec.singleActionList && proj.containsSingletonActions !== true) {
        proj.containsSingletonActions = true;
      }
    } catch (e) {
      result.errors.push({ path: projSpec.folderPath.concat([projSpec.title]).join('/'), message: String(e) });
    }
  }

  return JSON.stringify(result);
})();
`.trim();
}

/**
 * Build the OmniJS source that reads each project's OWN fields and ends with
 * JSON.stringify(result: Record<projectName, RawOFTask>). Embed `projectNames` via encodePayload.
 *
 * REQUIREMENTS (implement to satisfy test/omnifocus.test.ts):
 *  - For each name, find the project via `flattenedProjects.find(p => p.name === name)`. Skip missing.
 *  - Emit a RawOFTask keyed by the project NAME, where:
 *      id = project.id.primaryKey, name = project.name, note = project.note || null,
 *      completed = (project.status === Project.Status.Done),
 *      due = project.dueDate ? project.dueDate.getTime() : null,
 *      defer = project.deferDate ? project.deferDate.getTime() : null,
 *      estimatedMinutes = null, flagged = project.flagged,
 *      tags = project.tags ? project.tags.map(t => t.name) : []
 *  - Pure OmniJS; end with `return JSON.stringify(result);`.
 */
export function buildReadProjectsMetaScript(projectNames: string[]): string {
  const encoded = encodePayload(projectNames);
  return `
(function() {
  var names = ${encoded};
  var result = {};
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    var p = flattenedProjects.find(function(proj) { return proj.name === name; });
    if (!p) { continue; }
    result[name] = {
      id: p.id.primaryKey,
      name: p.name,
      note: p.note || null,
      completed: (p.status === Project.Status.Done),
      due: p.dueDate ? p.dueDate.getTime() : null,
      defer: p.deferDate ? p.deferDate.getTime() : null,
      estimatedMinutes: null,
      flagged: p.flagged,
      tags: p.tags ? p.tags.map(function(t) { var a=[]; var c=t; while(c){ a.unshift(c.name); c=c.parent; } return a.join('/'); }) : []
    };
  }
  return JSON.stringify(result);
})();
`.trim();
}

/**
 * Build the OmniJS source that reads specific tasks by primaryKey (Task.byIdentifier) and ends with
 * JSON.stringify(result: Record<primaryKey, RawOFTask>). Missing tasks are omitted. Embed the ids
 * via encodePayload.
 */
export function buildReadTasksByIdsScript(primaryKeys: string[]): string {
  const encoded = encodePayload(primaryKeys);
  return `
(function() {
  var ids = ${encoded};
  var result = {};
  for (var i = 0; i < ids.length; i++) {
    var t = Task.byIdentifier(ids[i]);
    if (!t) { continue; }
    result[ids[i]] = {
      id: t.id.primaryKey,
      name: t.name,
      note: t.note || null,
      completed: t.taskStatus === Task.Status.Completed,
      due: t.dueDate ? t.dueDate.getTime() : null,
      defer: t.deferDate ? t.deferDate.getTime() : null,
      planned: t.plannedDate ? t.plannedDate.getTime() : null,
      estimatedMinutes: (t.estimatedMinutes === null || t.estimatedMinutes === undefined) ? null : t.estimatedMinutes,
      flagged: t.flagged,
      tags: t.tags.map(function (x) { var a=[]; var c=x; while(c){ a.unshift(c.name); c=c.parent; } return a.join('/'); })
    };
  }
  return JSON.stringify(result);
})();
`.trim();
}

/**
 * Adapter factory. `readProject` runs buildReadScript then normalizes; `applyBatch` runs
 * buildBatchScript then parses BatchResult. A runner rejection or unparseable output must throw
 * a clear Error (mentioning OmniFocus), never return a partial/garbage result.
 */
export function createOmniFocusAdapter(run: OmniJSRunner): OmniFocusAdapter {
  return {
    async readProject(project: string): Promise<OmniFocusTask[]> {
      const script = buildReadScript(project);
      const output = await run(script);
      let parsed: RawOFTask[];
      try {
        parsed = JSON.parse(output) as RawOFTask[];
      } catch {
        throw new Error(`OmniFocus: failed to parse readProject output: ${output}`);
      }
      return parsed.map(normalizeOFTask);
    },

    async readAllProjects(projectNames?: string[]): Promise<Record<string, OmniFocusTask[]>> {
      const script = buildReadAllProjectsScript(projectNames);
      const output = await run(script);
      let parsed: Record<string, RawOFTask[]>;
      try {
        parsed = JSON.parse(output) as Record<string, RawOFTask[]>;
      } catch {
        throw new Error(`OmniFocus: failed to parse readAllProjects output: ${output}`);
      }
      const result: Record<string, OmniFocusTask[]> = {};
      for (const [name, tasks] of Object.entries(parsed)) {
        result[name] = tasks.map(normalizeOFTask);
      }
      return result;
    },

    async readInbox(): Promise<OmniFocusTask[]> {
      const script = buildReadInboxScript();
      const output = await run(script);
      let parsed: RawOFTask[];
      try {
        parsed = JSON.parse(output) as RawOFTask[];
      } catch {
        throw new Error(`OmniFocus: failed to parse readInbox output: ${output}`);
      }
      return parsed.map(normalizeOFTask);
    },

    async applyBatch(ops: OFOp[]): Promise<BatchResult> {
      if (ops.length === 0) {
        return { created: {}, updated: [], deleted: [], errors: [] };
      }
      const script = buildBatchScript(ops);
      const output = await run(script);
      let parsed: BatchResult;
      try {
        parsed = JSON.parse(output) as BatchResult;
      } catch {
        throw new Error(`OmniFocus: failed to parse applyBatch output: ${output}`);
      }
      return parsed;
    },

    async ensureStructure(folders: FolderSpec[], projects: ProjectSpec[]): Promise<ScaffoldResult> {
      if (folders.length === 0 && projects.length === 0) {
        return { createdFolders: [], createdProjects: [], errors: [] };
      }
      const script = buildScaffoldScript(folders, projects);
      const output = await run(script);
      let parsed: ScaffoldResult;
      try {
        parsed = JSON.parse(output) as ScaffoldResult;
      } catch {
        throw new Error(`OmniFocus: failed to parse ensureStructure output: ${output}`);
      }
      return parsed;
    },

    async readProjectsMeta(projectNames: string[]): Promise<Record<string, OmniFocusTask>> {
      if (projectNames.length === 0) return {};
      const script = buildReadProjectsMetaScript(projectNames);
      const output = await run(script);
      let parsed: Record<string, RawOFTask>;
      try {
        parsed = JSON.parse(output) as Record<string, RawOFTask>;
      } catch {
        throw new Error(`OmniFocus: failed to parse readProjectsMeta output: ${output}`);
      }
      const result: Record<string, OmniFocusTask> = {};
      for (const [name, raw] of Object.entries(parsed)) {
        result[name] = normalizeOFTask(raw);
      }
      return result;
    },

    async readTasksByIds(primaryKeys: string[]): Promise<Record<string, OmniFocusTask>> {
      if (primaryKeys.length === 0) return {};
      const script = buildReadTasksByIdsScript(primaryKeys);
      const output = await run(script);
      let parsed: Record<string, RawOFTask>;
      try {
        parsed = JSON.parse(output) as Record<string, RawOFTask>;
      } catch {
        throw new Error(`OmniFocus: failed to parse readTasksByIds output: ${output}`);
      }
      const result: Record<string, OmniFocusTask> = {};
      for (const [pk, raw] of Object.entries(parsed)) {
        result[pk] = normalizeOFTask(raw);
      }
      return result;
    },
  };
}

/**
 * Default OmniJS runner: writes the source to a temp file and invokes it via osascript JXA.
 * Not tested — injected in production via createOmniFocusAdapter(defaultRunOmniJS).
 */
export async function defaultRunOmniJS(source: string): Promise<string> {
  // Write the OmniJS to a temp file and have a JXA driver read it via the ObjC/Foundation bridge
  // (osascript's JavaScript context is JXA, NOT Node — there is no require('fs')), then hand it to
  // OmniFocus.evaluateJavascript, which returns the script's JSON string result.
  const tmpFile = join(tmpdir(), `omnifocus-tnof-${process.pid}-${Date.now()}.omnijs`);
  const driver = [
    'ObjC.import("Foundation");',
    "function run() {",
    `  var path = ${JSON.stringify(tmpFile)};`,
    "  var src = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null).js;",
    '  return Application("OmniFocus").evaluateJavascript(src);',
    "}",
  ].join("\n");
  try {
    writeFileSync(tmpFile, source, "utf8");
    const result = execFileSync("osascript", ["-l", "JavaScript", "-e", driver], {
      encoding: "utf8",
      // A batch can be large on a first full-vault sync and OmniFocus slows as it fills; 30s was too
      // low (timed out mid-push on a ~1000-task vault). 120s comfortably covers a big applyBatch.
      timeout: 120000,
      // A whole-vault read (readTasksByIds over ~1000 tasks with notes + all date fields) easily
      // exceeds execFileSync's default 1MB stdout buffer → ENOBUFS. 256MB is ample headroom.
      maxBuffer: 256 * 1024 * 1024,
    });
    return result.trim();
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      // ignore cleanup errors
    }
  }
}
