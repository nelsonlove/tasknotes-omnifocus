import { describe, it, expect } from "vitest";
import { composeOFNote, obsidianUri } from "../src/core/obsidian.js";

describe("obsidianUri", () => {
  it("builds an obsidian://open URI from a vault path, dropping .md", () => {
    expect(obsidianUri("Folder/My Note.md", "obsidian")).toBe(
      "obsidian://open?vault=obsidian&file=Folder%2FMy%20Note",
    );
  });
  it("encodes the vault name and special characters", () => {
    expect(obsidianUri("a/b — c.md", "My Vault")).toBe(
      "obsidian://open?vault=My%20Vault&file=a%2Fb%20%E2%80%94%20c",
    );
  });
});

describe("composeOFNote", () => {
  it("null uri -> body unchanged", () => {
    expect(composeOFNote("body", null)).toBe("body");
    expect(composeOFNote(null, null)).toBeNull();
  });
  it("uri only when there is no body", () => {
    expect(composeOFNote(null, "obsidian://x")).toBe("obsidian://x");
    expect(composeOFNote("   ", "obsidian://x")).toBe("obsidian://x");
  });
  it("uri on top, body below", () => {
    expect(composeOFNote("the plan", "obsidian://x")).toBe("obsidian://x\n\nthe plan");
  });

  it("orders back-link, description, body — omitting empties", () => {
    expect(composeOFNote("the plan", "obsidian://x", "a summary")).toBe("obsidian://x\n\na summary\n\nthe plan");
    expect(composeOFNote(null, "obsidian://x", "a summary")).toBe("obsidian://x\n\na summary");
    expect(composeOFNote("the plan", null, "a summary")).toBe("a summary\n\nthe plan");
    expect(composeOFNote(null, null, "  ")).toBeNull();
  });
});
