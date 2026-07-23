// Frontmatter/body access through Obsidian (sync-safe). The TaskNotes API does not expose arbitrary
// frontmatter (omnifocusUrl, description) or the note body, so the plugin reads/writes them directly:
//   - reads via app.metadataCache (frontmatter) and app.vault.cachedRead (body)
//   - writes via app.fileManager.processFrontMatter (Obsidian is the writer; Sync stays consistent)
import type { App, TFile } from "obsidian";

function fileFor(app: App, path: string): TFile | null {
  const f = app.vault.getAbstractFileByPath(path);
  // A TFile has an `extension`; a TFolder does not.
  return f && (f as TFile).extension !== undefined ? (f as TFile) : null;
}

function frontmatter(app: App, path: string): Record<string, unknown> | undefined {
  const f = fileFor(app, path);
  return f ? app.metadataCache.getFileCache(f)?.frontmatter : undefined;
}

/** The `omnifocusUrl` frontmatter value (`omnifocus:///task/<pk>`), or null. This is the link identity. */
export function readOmnifocusUrl(app: App, path: string): string | null {
  const v = frontmatter(app, path)?.["omnifocusUrl"];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** The `description` frontmatter one-liner, or null. */
export function readDescription(app: App, path: string): string | null {
  const v = frontmatter(app, path)?.["description"];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * The deferred-date frontmatter value (a TaskNotes userField), or null. The `/query` API does not return
 * userFields, so the plugin reads it from the metadata cache (same pattern as `description`). The
 * frontmatter key is configurable (#10); a blank key disables the mapping and always returns null.
 */
export function readDeferred(app: App, path: string, key = "deferred"): string | null {
  if (!key) return null;
  const v = frontmatter(app, path)?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * The flagged-boolean frontmatter value (a TaskNotes userField), defaulting to false when absent/non-
 * boolean. Read from the metadata cache since `/query` does not return userFields. The frontmatter key is
 * configurable (#10); a blank key disables the mapping and always returns false.
 */
export function readFlagged(app: App, path: string, key = "flagged"): boolean {
  if (!key) return false;
  return frontmatter(app, path)?.[key] === true;
}

/** Strip a `[[wikilink]]` (or `[[link|alias]]`) down to its link target; return a non-link string as-is. */
function wikilinkTarget(ref: string): { link: string; wasLink: boolean } {
  const m = ref.match(/^\[\[([^\]]+)\]\]$/);
  if (!m) return { link: ref, wasLink: false };
  const inner = m[1].split("|")[0].trim(); // drop a display alias
  return { link: inner, wasLink: true };
}

/**
 * The task's `blockedBy` dependencies (#8), resolved to vault task paths. TaskNotes stores blockedBy as
 * a list of `{ uid: "[[link]]", reltype }` entries (or, in older data, bare strings). Each uid wikilink
 * is resolved against the vault via metadataCache; unresolvable links are dropped, a bare path is kept
 * as-is. Returns the deduped list of blocker task ids (paths). Used only to ORDER children within a
 * container the user marked sequential — cross-container blockers are ignored downstream.
 */
export function readBlockedBy(app: App, path: string): string[] {
  const raw = frontmatter(app, path)?.["blockedBy"];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    const ref =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object"
          ? (entry as { uid?: unknown }).uid
          : undefined;
    if (typeof ref !== "string" || !ref) continue;
    const { link, wasLink } = wikilinkTarget(ref);
    const dest = app.metadataCache.getFirstLinkpathDest?.(link, path) as TFile | null | undefined;
    if (dest?.path) out.push(dest.path);
    else if (!wasLink) out.push(link); // a bare, already-resolved path
  }
  return [...new Set(out)];
}

/** The note body (content below the frontmatter block), trimmed, or null if empty/missing. */
export async function readBody(app: App, path: string): Promise<string | null> {
  const f = fileFor(app, path);
  if (!f) return null;
  const raw = await app.vault.cachedRead(f);
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  const body = (m ? raw.slice(m[0].length) : raw).trim();
  return body.length > 0 ? body : null;
}

/** Stamp the link identity into frontmatter after a create (sync-safe). */
export async function writeOmnifocusUrl(app: App, path: string, url: string): Promise<void> {
  await mutateFrontmatter(app, path, (fm) => {
    fm.omnifocusUrl = url;
  });
}

/**
 * Sync-safe fallback for the TaskNotes per-task PUT route (#11). That route 404s / no-ops for notes in
 * software-project task dirs, so field-reconcile's writes to them are otherwise lost. Write the same
 * key/value body Obsidian-side via processFrontMatter — a `null`/`undefined` value DELETES the key (a
 * field "clear"), matching how the API PUT clears a field. Throws if the note isn't found, so the caller
 * records a genuine failure rather than a silently-dropped write.
 *
 * LIMITATIONS (best-effort last resort — it is NOT the TaskNotes API): the body keys are written to
 * frontmatter verbatim, so this does NOT apply TaskNotes' configurable field-mapping (a user who remapped
 * e.g. `due`→`dueDate` would get the wrong key), and a `status` write does NOT reproduce the API's
 * completion side-effects (`completedDate`, recurring-instance regeneration). Correct for the default
 * identity field-mapping and plain (non-recurring) tasks — the case this path exists for.
 */
export async function writeTaskFrontmatter(app: App, path: string, body: Record<string, unknown>): Promise<void> {
  const ok = await mutateFrontmatter(app, path, (fm) => {
    for (const [k, v] of Object.entries(body)) {
      if (v === null || v === undefined) delete fm[k];
      else fm[k] = v;
    }
  });
  if (!ok) throw new Error(`TaskNotes frontmatter fallback: note not found at ${path}`);
}

/** Remove the link identity from frontmatter (on clearLink / de-surface). */
export async function clearOmnifocusUrl(app: App, path: string): Promise<void> {
  await mutateFrontmatter(app, path, (fm) => {
    delete fm.omnifocusUrl;
  });
}

/**
 * Shared sync-safe frontmatter mutation: resolve the file, run `mutate` inside processFrontMatter
 * (Obsidian is the writer, so Sync stays consistent). Returns false (a no-op) when the note is missing —
 * callers that require the write to land check the result and surface an error.
 */
async function mutateFrontmatter(
  app: App,
  path: string,
  mutate: (fm: Record<string, unknown>) => void,
): Promise<boolean> {
  const f = fileFor(app, path);
  if (!f) return false;
  await app.fileManager.processFrontMatter(f, mutate);
  return true;
}
