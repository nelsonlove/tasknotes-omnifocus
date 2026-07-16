import { describe, it, expect } from "vitest";
import { canonicalDate } from "../src/core/dates.js";

describe("canonicalDate", () => {
  it("maps empty inputs to null", () => {
    expect(canonicalDate(null)).toBeNull();
    expect(canonicalDate(undefined)).toBeNull();
    expect(canonicalDate("")).toBeNull();
  });

  it("converts epoch milliseconds to ISO UTC", () => {
    const ms = Date.UTC(2026, 6, 20, 9, 0, 0); // 2026-07-20T09:00:00Z
    expect(canonicalDate(ms)).toBe("2026-07-20T09:00:00.000Z");
  });

  it("expands a date-only string to UTC midnight", () => {
    expect(canonicalDate("2026-07-20")).toBe("2026-07-20T00:00:00.000Z");
  });

  it("treats a timezone-naive datetime as UTC (machine-independent)", () => {
    expect(canonicalDate("2026-07-20T09:00:00")).toBe("2026-07-20T09:00:00.000Z");
    expect(canonicalDate("2026-07-20T09:00")).toBe("2026-07-20T09:00:00.000Z");
  });

  it("normalizes an already-UTC datetime and adds milliseconds", () => {
    expect(canonicalDate("2026-07-20T09:00:00Z")).toBe("2026-07-20T09:00:00.000Z");
    expect(canonicalDate("2026-07-20T09:00:00.000Z")).toBe("2026-07-20T09:00:00.000Z");
  });

  it("converts an offset datetime to the equivalent UTC instant", () => {
    expect(canonicalDate("2026-07-20T05:00:00-04:00")).toBe("2026-07-20T09:00:00.000Z");
  });

  it("two equivalent representations converge to the same canonical value", () => {
    const a = canonicalDate("2026-07-20T09:00:00Z");
    const b = canonicalDate("2026-07-20T05:00:00-04:00");
    expect(a).toBe(b);
  });

  it("is idempotent", () => {
    for (const v of ["2026-07-20", "2026-07-20T09:00:00", "2026-07-20T09:00:00Z"]) {
      const once = canonicalDate(v);
      expect(canonicalDate(once)).toBe(once);
    }
  });

  it("returns null for unparseable input", () => {
    expect(canonicalDate("not a date")).toBeNull();
    expect(canonicalDate("2026-13-99")).toBeNull();
  });
});
