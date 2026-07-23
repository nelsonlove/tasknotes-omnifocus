// Validation of the configurable deferred/flagged userField keys (#10) against TaskNotes' own
// userFields registry. Pure; the plugin reads the registry live from TaskNotes' settings and passes it
// here. TaskNotes stores userFields as an array of { id, displayName, key, type } (verified live: type
// is "date" for the deferred field, "boolean" for the flagged field).

/** A TaskNotes userField entry (the subset we read). */
export interface TNUserField {
  id?: string;
  key?: string;
  displayName?: string;
  type?: string;
}

/**
 * Validate that `key` is a registered TaskNotes userField of `expectedType`. Returns a human-readable
 * warning to surface in the run log, or null when there's nothing to warn about:
 *   - blank key            -> null (the mapping is disabled; nothing to validate).
 *   - userFields not a recognizable array -> null (can't tell — don't emit a false warning).
 *   - no field with that key -> warn (the classic "set the field name but didn't create the userField").
 *   - field present, wrong type -> warn (e.g. a text field where a date is expected).
 * `label` names the mapping in the message (e.g. "deferred").
 */
export function validateUserField(
  userFields: unknown,
  key: string,
  expectedType: string,
  label: string,
): string | null {
  if (!key) return null;
  if (!Array.isArray(userFields)) return null;
  const fields = userFields as TNUserField[];
  const match = fields.find((f) => f && f.key === key);
  if (!match) {
    return `TaskNotes has no userField with key "${key}" (needed for the ${label} mapping). Create a ${expectedType} userField named "${key}" in TaskNotes → Settings → User Fields, or clear the ${label} field key in this plugin's settings to disable the mapping.`;
  }
  if (match.type && match.type !== expectedType) {
    return `TaskNotes userField "${key}" is type "${match.type}" but the ${label} mapping expects "${expectedType}" — writes may not round-trip.`;
  }
  return null;
}
