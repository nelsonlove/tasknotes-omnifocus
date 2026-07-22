import type { TaskNote, TaskNotePriority, TaskWriteFields } from "../core/types.js";
import { canonicalDate } from "../core/dates.js";

/** Minimal fetch surface the adapter needs (injectable for tests). */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

/** The raw TaskNotes API task shape (subset we consume), per the live OpenAPI. */
export interface RawTNTask {
  id: string;
  title: string;
  status: string;
  priority?: string;
  due?: string | null;
  scheduled?: string | null;
  deferred?: string | null;
  timeEstimate?: number | null;
  flagged?: boolean;
  tags?: string[];
  contexts?: string[];
  projects?: string[];
  details?: string | null;
  archived?: boolean;
}

export interface TaskNotesAdapterOptions {
  baseUrl: string; // e.g. "http://localhost:8080"
  fetch: FetchLike;
  /** Status values considered completed (derives TaskNote.isCompleted). */
  completedStatuses: string[];
  authToken?: string;
}

export interface TaskNotesAdapter {
  /** POST /api/tasks/query with the given filter; returns normalized in-scope tasks. */
  query(filter: unknown): Promise<TaskNote[]>;
  /** GET /api/tasks/:id -> normalized task, or null if not found. */
  getById(id: string): Promise<TaskNote | null>;
  /** PUT /api/tasks/:id with mapped scalar fields. */
  update(id: string, fields: Partial<TaskWriteFields>): Promise<void>;
  /** PUT /api/tasks/:id { status }. */
  setStatus(id: string, status: string): Promise<void>;
}

/** TaskNotes priority string -> core priority. Unknown/absent -> "none". */
export function mapTNPriority(p: string | undefined): TaskNotePriority {
  if (p === "low" || p === "normal" || p === "high") return p;
  return "none";
}

/**
 * Normalize a raw TaskNotes task into the core TaskNote.
 *  - id, title straight; body <- details (null if absent)
 *  - status straight; isCompleted <- completedStatuses.includes(status)
 *  - due/scheduled/deferred via canonicalDate; timeEstimate <- timeEstimate ?? null
 *  - priority via mapTNPriority; flagged <- flagged ?? false; tags/contexts <- [] if absent
 *  - omnifocusUrl <- null (link lives in the plugin data.json table, set by the caller)
 *  - inScope <- true (scope is a caller concern; the plugin overrides for de-surface candidates)
 */
export function normalizeTNTask(raw: RawTNTask, completedStatuses: string[]): TaskNote {
  return {
    id: raw.id,
    title: raw.title,
    body: raw.details ?? null,
    status: raw.status,
    isCompleted: completedStatuses.includes(raw.status),
    due: canonicalDate(raw.due),
    scheduled: canonicalDate(raw.scheduled),
    deferred: canonicalDate(raw.deferred),
    timeEstimate: raw.timeEstimate ?? null,
    priority: mapTNPriority(raw.priority),
    flagged: raw.flagged ?? false,
    tags: raw.tags ?? [],
    contexts: raw.contexts ?? [],
    projects: raw.projects ?? [],
    omnifocusUrl: null,
    inScope: true,
  };
}

/**
 * Build the PUT body from core TaskWriteFields (only keys present in `fields`):
 *  title->title, due->due, scheduled->scheduled, deferred->deferred, timeEstimate->timeEstimate,
 *  flagged->flagged, tags->tags,
 *  priority-> the TaskNotes priority string ("none"|"low"|"normal"|"high", symmetric with mapTNPriority).
 *  (deferred and flagged are TaskNotes userFields; verified the REST API accepts and echoes them.)
 */
export function buildUpdateBody(fields: Partial<TaskWriteFields>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if ("title" in fields) body.title = fields.title;
  if ("due" in fields) body.due = fields.due;
  if ("scheduled" in fields) body.scheduled = fields.scheduled;
  if ("deferred" in fields) body.deferred = fields.deferred;
  if ("timeEstimate" in fields) body.timeEstimate = fields.timeEstimate;
  if ("flagged" in fields) body.flagged = fields.flagged;
  if ("tags" in fields) body.tags = fields.tags;
  if ("priority" in fields) body.priority = fields.priority; // "none"|"low"|"normal"|"high" pass through
  return body;
}

/**
 * Adapter factory. Unwraps the `{success, data}` envelope; throws a clear Error (mentioning TaskNotes)
 * on `!ok` or `success === false`. getById returns null ONLY on a genuine 404 (task absent) or a
 * success=false envelope; any other non-ok status (500, etc.) throws rather than masking a transient
 * failure as "not found".
 */
export function createTaskNotesAdapter(opts: TaskNotesAdapterOptions): TaskNotesAdapter {
  const { baseUrl, fetch, completedStatuses, authToken } = opts;

  function authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
    return headers;
  }

  // TaskNotes ids are vault paths (e.g. "Folder Name/My Task.md"). The `/api/tasks/:id` route
  // captures a SINGLE path segment, so the whole id must be one encoded component — slashes become
  // %2F. (Verified live: per-segment encoding that keeps "/" 404s; full encodeURIComponent works.)
  function encodeId(id: string): string {
    return encodeURIComponent(id);
  }

  async function throwOnError(res: Awaited<ReturnType<FetchLike>>, context: string): Promise<unknown> {
    if (!res.ok) {
      throw new Error(`TaskNotes: ${context} failed with HTTP ${res.status}`);
    }
    const envelope = await res.json() as { success: boolean; data?: unknown; error?: string };
    if (envelope.success === false) {
      throw new Error(`TaskNotes: ${context} returned success=false: ${envelope.error ?? "unknown error"}`);
    }
    return envelope.data;
  }

  return {
    async query(filter: unknown): Promise<TaskNote[]> {
      const res = await fetch(`${baseUrl}/api/tasks/query`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify(filter),
      });
      const data = await throwOnError(res, "query") as { tasks: RawTNTask[] };
      return data.tasks.map((t) => normalizeTNTask(t, completedStatuses));
    },

    async getById(id: string): Promise<TaskNote | null> {
      const res = await fetch(`${baseUrl}/api/tasks/${encodeId(id)}`, {
        method: "GET",
        headers: authHeaders(),
      });
      if (!res.ok) {
        // Only a genuine 404 means the task is absent -> null. Any other non-ok status (500, etc.)
        // is a transient failure and must THROW: silently treating it as "not found" would make a
        // de-surface candidate look absent and skip it (deleting/completing the wrong OF mirror).
        if (res.status === 404) return null;
        throw new Error(`TaskNotes: getById(${id}) failed with HTTP ${res.status}`);
      }
      const envelope = await res.json() as { success: boolean; data?: RawTNTask };
      if (envelope.success === false) return null;
      return normalizeTNTask(envelope.data!, completedStatuses);
    },

    async update(id: string, fields: Partial<TaskWriteFields>): Promise<void> {
      const res = await fetch(`${baseUrl}/api/tasks/${encodeId(id)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify(buildUpdateBody(fields)),
      });
      await throwOnError(res, "update");
    },

    async setStatus(id: string, status: string): Promise<void> {
      const res = await fetch(`${baseUrl}/api/tasks/${encodeId(id)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({ status }),
      });
      await throwOnError(res, "setStatus");
    },
  };
}
