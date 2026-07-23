import { describe, it, expect } from "vitest";
import { validateUserField } from "../src/plugin/userfields.js";

const REGISTRY = [
  { id: "f1", displayName: "Deferred date", key: "deferred", type: "date" },
  { id: "f2", displayName: "Flagged", key: "flagged", type: "boolean" },
];

describe("validateUserField (#10)", () => {
  it("returns null when the key is a registered field of the expected type", () => {
    expect(validateUserField(REGISTRY, "deferred", "date", "deferred")).toBeNull();
    expect(validateUserField(REGISTRY, "flagged", "boolean", "flagged")).toBeNull();
  });

  it("warns when no userField has that key", () => {
    const w = validateUserField(REGISTRY, "deferDate", "date", "deferred");
    expect(w).toMatch(/no userField with key "deferDate"/);
  });

  it("warns when the field exists but is the wrong type", () => {
    const reg = [{ key: "deferred", type: "text" }];
    const w = validateUserField(reg, "deferred", "date", "deferred");
    expect(w).toMatch(/type "text".*expects "date"/);
  });

  it("returns null for a blank key (mapping disabled — nothing to validate)", () => {
    expect(validateUserField(REGISTRY, "", "date", "deferred")).toBeNull();
  });

  it("returns null when userFields isn't a recognizable array (no false warning)", () => {
    expect(validateUserField(undefined, "deferred", "date", "deferred")).toBeNull();
    expect(validateUserField({ not: "an array" }, "deferred", "date", "deferred")).toBeNull();
  });

  it("does not warn on type when the registered field omits a type", () => {
    expect(validateUserField([{ key: "deferred" }], "deferred", "date", "deferred")).toBeNull();
  });
});
