import { describe, it, expect } from "vitest";
import type { App } from "obsidian";
import { readBody } from "../src/plugin/frontmatter.js";

// Minimal App mock: readBody only touches vault.getAbstractFileByPath + vault.cachedRead, and treats
// anything with an `extension` as a TFile.
function mockApp(content: string): App {
  const file = { extension: "md", path: "note.md" };
  return {
    vault: {
      getAbstractFileByPath: (p: string) => (p === "note.md" ? file : null),
      cachedRead: async () => content,
    },
  } as unknown as App;
}

describe("readBody", () => {
  it("strips an LF frontmatter block", async () => {
    const raw = "---\ntitle: X\n---\nBody line\nsecond";
    expect(await readBody(mockApp(raw), "note.md")).toBe("Body line\nsecond");
  });

  it("strips a CRLF frontmatter block (Windows line endings)", async () => {
    const raw = "---\r\ntitle: X\r\n---\r\nBody line\r\nsecond";
    expect(await readBody(mockApp(raw), "note.md")).toBe("Body line\r\nsecond");
  });

  it("returns the whole content (trimmed) when there is no frontmatter", async () => {
    expect(await readBody(mockApp("just a body\n"), "note.md")).toBe("just a body");
  });

  it("returns null for an empty body after a CRLF frontmatter block", async () => {
    expect(await readBody(mockApp("---\r\ntitle: X\r\n---\r\n"), "note.md")).toBeNull();
  });

  it("returns null when the file does not exist", async () => {
    expect(await readBody(mockApp("x"), "missing.md")).toBeNull();
  });
});
