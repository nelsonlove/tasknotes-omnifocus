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
 * The `deferred` frontmatter date (TaskNotes userField), or null. The `/query` API does not return
 * userFields, so the plugin reads it from the metadata cache (same pattern as `description`).
 */
export function readDeferred(app: App, path: string): string | null {
  const v = frontmatter(app, path)?.["deferred"];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * The `flagged` frontmatter boolean (TaskNotes userField), defaulting to false when absent/non-boolean.
 * Read from the metadata cache since `/query` does not return userFields.
 */
export function readFlagged(app: App, path: string): boolean {
  return frontmatter(app, path)?.["flagged"] === true;
}

/** The note body (content below the frontmatter block), trimmed, or null if empty/missing. */
export async function readBody(app: App, path: string): Promise<string | null> {
  const f = fileFor(app, path);
  if (!f) return null;
  const raw = await app.vault.cachedRead(f);
  const m = raw.match(/^---\n[\s\S]*?\n---\n?/);
  const body = (m ? raw.slice(m[0].length) : raw).trim();
  return body.length > 0 ? body : null;
}

/** Stamp the link identity into frontmatter after a create (sync-safe). */
export async function writeOmnifocusUrl(app: App, path: string, url: string): Promise<void> {
  const f = fileFor(app, path);
  if (!f) return;
  await app.fileManager.processFrontMatter(f, (fm) => {
    fm.omnifocusUrl = url;
  });
}

/** Remove the link identity from frontmatter (on clearLink / de-surface). */
export async function clearOmnifocusUrl(app: App, path: string): Promise<void> {
  const f = fileFor(app, path);
  if (!f) return;
  await app.fileManager.processFrontMatter(f, (fm) => {
    delete fm.omnifocusUrl;
  });
}
