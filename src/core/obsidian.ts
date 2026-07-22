// Back-link from an OmniFocus item to its source note in Obsidian.
//
// OmniFocus has no dedicated URL field and rejects non-file URLs for linked files, but a note
// containing an `obsidian://` URI is rendered clickable — so the back-link lives at the top of the
// OmniFocus note, with the task body (if any) below it.

/** Build an `obsidian://open` URI for a TaskNotes id (its vault-relative path, e.g. "Folder/Note.md"). */
export function obsidianUri(taskId: string, vault: string): string {
  const path = taskId.replace(/\.md$/, "");
  return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(path)}`;
}

/**
 * Compose an OmniFocus note from up to three parts, top to bottom:
 *   back-link URI, then the frontmatter description, then the body.
 * Blank/empty parts are omitted; parts are separated by a blank line. Returns null if all empty.
 */
export function composeOFNote(
  body: string | null,
  uri: string | null,
  description?: string | null,
): string | null {
  const parts: string[] = [];
  if (uri && uri.trim().length > 0) parts.push(uri.trim());
  if (description && description.trim().length > 0) parts.push(description.trim());
  if (body && body.trim().length > 0) parts.push(body);
  return parts.length > 0 ? parts.join("\n\n") : null;
}
