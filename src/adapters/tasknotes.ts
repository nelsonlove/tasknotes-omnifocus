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
  /** Configurable keys for the deferred/flagged userFields; the PUT body must use the user's key. (#10) */
  fieldKeys?: UserFieldKeys;
  /**
   * Sync-safe fallback for the per-task PUT route. The TaskNotes `/api/tasks/:id` route returns a 404 —
   * or a 2xx with an empty body — for notes living in software-project task dirs (`…/Tasks/`, `…/issues/`,
   * `…/Tasks for <x>/`) even though the bulk `/query` endpoint indexes them, so `update()`/`setStatus()`
   * writes to those notes would otherwise be lost. When provided, the adapter routes those writes through
   * this callback (Obsidian `processFrontMatter` — Obsidian is the writer, so Sync stays consistent),
   * passing the SAME key/value body the PUT would have sent. If the fallback throws, the write is a real
   * failure and surfaces to the caller. Genuine errors (non-404 like 500) never trigger the fallback. (#11)
   */
  frontmatterFallback?: (id: string, body: Record<string, unknown>) => Promise<void>;
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
 * The core PUT-body keys buildUpdateBody writes (plus `status`, written by setStatus). A configurable
 * userField key MUST NOT collide with one of these — doing so would clobber the core field in the body
 * (or, on the read side, read the core field's value as the userField). Exported so the plugin can
 * disable a colliding mapping and warn. (#10 review)
 */
export const CORE_UPDATE_KEYS: ReadonlySet<string> = new Set([
  "title",
  "due",
  "scheduled",
  "timeEstimate",
  "tags",
  "priority",
  "status",
]);

/** Configurable frontmatter/API keys for the deferred + flagged userFields (#10). */
export interface UserFieldKeys {
  /** API/frontmatter key for the deferred date. Default "deferred"; blank omits the field. */
  defer?: string;
  /** API/frontmatter key for the flagged boolean. Default "flagged"; blank omits the field. */
  flag?: string;
}

/**
 * Build the PUT body from core TaskWriteFields (only keys present in `fields`):
 *  title->title, due->due, scheduled->scheduled, deferred-><deferKey>, timeEstimate->timeEstimate,
 *  flagged-><flagKey>, tags->tags,
 *  priority-> the TaskNotes priority string ("none"|"low"|"normal"|"high", symmetric with mapTNPriority).
 *  deferred and flagged are TaskNotes userFields whose keys are configurable (#10) — the body key must
 *  match the user's registered userField key. Defaults are "deferred"/"flagged"; a blank key omits it.
 */
export function buildUpdateBody(
  fields: Partial<TaskWriteFields>,
  fieldKeys?: UserFieldKeys,
): Record<string, unknown> {
  const deferKey = fieldKeys?.defer ?? "deferred";
  const flagKey = fieldKeys?.flag ?? "flagged";
  const body: Record<string, unknown> = {};
  if ("title" in fields) body.title = fields.title;
  if ("due" in fields) body.due = fields.due;
  if ("scheduled" in fields) body.scheduled = fields.scheduled;
  // Guard: a userField key colliding with a core key would clobber the core field — never let it. (The
  // plugin also disables a colliding mapping up front and warns; this is the last-line defense.)
  if ("deferred" in fields && deferKey && !CORE_UPDATE_KEYS.has(deferKey)) body[deferKey] = fields.deferred;
  if ("timeEstimate" in fields) body.timeEstimate = fields.timeEstimate;
  if ("flagged" in fields && flagKey && !CORE_UPDATE_KEYS.has(flagKey)) body[flagKey] = fields.flagged;
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
  const { baseUrl, fetch, completedStatuses, authToken, fieldKeys, frontmatterFallback } = opts;

  function authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
    return headers;
  }

  // The per-task PUT route is "unavailable" (didn't write) when it 404s, or answers 2xx with an empty
  // body — the observed behavior for notes in software-project task dirs. Only these two shapes trigger
  // the frontmatter fallback; a genuine error (500, etc.) is NOT masked and still throws. (#11)
  async function perTaskRouteUnavailable(res: Awaited<ReturnType<FetchLike>>): Promise<boolean> {
    if (res.status === 404) return true;
    // A 2xx with an empty body. TaskNotes answers a genuine success with a JSON `{success,data}`
    // envelope (never empty), so in practice only the unreachable-route case is blank; if a future
    // build ever 204'd a real success, this would reroute it through the fallback (a redundant but
    // still-correct vault write, logged as an api-fallback).
    if (res.ok) return (await res.text()).trim().length === 0;
    return false;
  }

  // Shared PUT path for update()/setStatus(): send the body; on route-unavailable with a fallback set,
  // re-route the SAME body through the sync-safe frontmatter writer; otherwise unwrap/throw as usual.
  async function putTask(id: string, body: Record<string, unknown>, context: string): Promise<void> {
    const res = await fetch(`${baseUrl}/api/tasks/${encodeId(id)}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify(body),
    });
    if (frontmatterFallback && (await perTaskRouteUnavailable(res))) {
      await frontmatterFallback(id, body);
      return;
    }
    await throwOnError(res, context);
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
      await putTask(id, buildUpdateBody(fields, fieldKeys), "update");
    },

    async setStatus(id: string, status: string): Promise<void> {
      await putTask(id, { status }, "setStatus");
    },
  };
}
