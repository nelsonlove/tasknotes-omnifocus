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
  | { op: "delete"; primaryKey: string };

export interface BatchResult {
  /** create `ref` (caller correlation id, e.g. taskId) -> new primaryKey */
  created: Record<string, string>;
  updated: string[];
  deleted: string[];
  errors: { ref?: string; primaryKey?: string; message: string }[];
}

export interface OmniFocusAdapter {
  /** ONE osascript spawn: returns every task in the named project, normalized. */
  readProject(project: string): Promise<OmniFocusTask[]>;
  /** ONE osascript spawn: performs ALL ops inside a single OmniJS script. */
  applyBatch(ops: OFOp[]): Promise<BatchResult>;
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
        if (!proj) { proj = new Project(op.project); }
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
