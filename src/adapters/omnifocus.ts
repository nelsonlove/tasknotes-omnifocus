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
  estimatedMinutes: number | null;
  flagged: boolean;
  tags: string[];
}

/** One OmniFocus-side mutation, translated from the reconcile Plan by the executor. */
export type OFOp =
  | { op: "create"; ref: string; project: string; fields: OFWriteFields }
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
    estimatedMinutes: raw.estimatedMinutes ?? null,
    flagged: raw.flagged,
    tags: raw.tags ?? [],
  };
}

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
    .map(function (task) {
      return {
        id: task.id.primaryKey,
        name: task.name,
        note: task.note || null,
        completed: task.taskStatus === Task.Status.Completed,
        due: task.dueDate ? task.dueDate.getTime() : null,
        defer: task.deferDate ? task.deferDate.getTime() : null,
        estimatedMinutes: (task.estimatedMinutes === null || task.estimatedMinutes === undefined) ? null : task.estimatedMinutes,
        flagged: task.flagged,
        tags: task.tags.map(function (t) { return t.name; })
      };
    });
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

  function findOrCreateTag(name) {
    var t = flattenedTags.find(function (x) { return x.name === name; });
    return t ? t : new Tag(name);
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
    if (fields.tags !== undefined && fields.tags !== null) {
      task.clearTags();
      fields.tags.forEach(function (n) { task.addTag(findOrCreateTag(n)); });
    }
  }

  for (var i = 0; i < ops.length; i++) {
    var op = ops[i];
    try {
      if (op.op === 'create') {
        var proj = flattenedProjects.find(function (p) { return p.name === op.project; });
        if (!proj) {
          // ensureStructure runs first and guarantees the project exists; a miss here means a
          // scaffold/name mismatch — surface it rather than silently creating a duplicate top-level project.
          result.errors.push({ ref: op.ref, message: 'Project not found (scaffold missing?): ' + op.project });
          continue;
        }
        var newTask = new Task(op.fields.name || 'Untitled', proj.ending);
        setTaskFields(newTask, op.fields);
        if (op.fields.completed) { newTask.markComplete(); }
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
      var existing = flattenedProjects.find(function(p) { return p.name === projSpec.title; });
      if (existing) {
        // Reuse — do not push to createdProjects
      } else {
        var newProject;
        if (projSpec.folderPath.length === 0) {
          newProject = new Project(projSpec.title);
        } else {
          var folder = ensureFolder(projSpec.folderPath);
          newProject = new Project(projSpec.title, folder);
        }
        result.createdProjects.push(projSpec.title);
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
      tags: p.tags ? p.tags.map(function(t) { return t.name; }) : []
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
      estimatedMinutes: (t.estimatedMinutes === null || t.estimatedMinutes === undefined) ? null : t.estimatedMinutes,
      flagged: t.flagged,
      tags: t.tags.map(function (x) { return x.name; })
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
      timeout: 30000,
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
