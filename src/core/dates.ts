/**
 * Canonical date normalization shared by both adapters.
 *
 * The reconcile core compares date fields with raw string equality, so BOTH adapters must
 * feed it dates in one identical canonical form, or every sync spuriously diffs.
 *
 * Canonical form: full ISO-8601 in UTC with milliseconds, e.g. "2026-07-20T09:00:00.000Z".
 * Timezone-naive datetimes are treated as UTC so the result is machine-timezone-independent.
 */
export function canonicalDate(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined || v === "") return null;

  let d: Date;
  if (typeof v === "number") {
    d = new Date(v);
  } else {
    let s = v.trim();
    if (s === "") return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      // date-only -> UTC midnight
      s = `${s}T00:00:00Z`;
    } else if (s.includes("T") && !/[zZ]$/.test(s) && !/[+-]\d{2}:?\d{2}$/.test(s)) {
      // datetime without a timezone -> treat as UTC
      s = `${s}Z`;
    }
    d = new Date(s);
  }

  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
