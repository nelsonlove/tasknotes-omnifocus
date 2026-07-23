import { describe, it, expect } from "vitest";
import type { App } from "obsidian";
import { readBody, readDeferred, readFlagged, readBlockedBy } from "../src/plugin/frontmatter.js";

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

// Minimal App mock exposing frontmatter via metadataCache.getFileCache.
function mockAppFM(fm: Record<string, unknown>): App {
  const file = { extension: "md", path: "note.md" };
  return {
    vault: { getAbstractFileByPath: (p: string) => (p === "note.md" ? file : null) },
    metadataCache: { getFileCache: () => ({ frontmatter: fm }) },
  } as unknown as App;
}

describe("readDeferred / readFlagged — configurable keys (#10)", () => {
  it("reads the default keys when none is passed", () => {
    const app = mockAppFM({ deferred: "2026-07-17", flagged: true });
    expect(readDeferred(app, "note.md")).toBe("2026-07-17");
    expect(readFlagged(app, "note.md")).toBe(true);
  });

  it("reads a custom key", () => {
    const app = mockAppFM({ deferDate: "2026-07-17", isFlagged: true });
    expect(readDeferred(app, "note.md", "deferDate")).toBe("2026-07-17");
    expect(readFlagged(app, "note.md", "isFlagged")).toBe(true);
  });

  it("a blank key disables the mapping (null / false)", () => {
    const app = mockAppFM({ deferred: "2026-07-17", flagged: true });
    expect(readDeferred(app, "note.md", "")).toBeNull();
    expect(readFlagged(app, "note.md", "")).toBe(false);
  });
});

// App mock exposing frontmatter + wikilink resolution.
function mockAppLinks(fm: Record<string, unknown>, resolve: Record<string, string>): App {
  const file = { extension: "md", path: "note.md" };
  return {
    vault: { getAbstractFileByPath: (p: string) => (p === "note.md" ? file : null) },
    metadataCache: {
      getFileCache: () => ({ frontmatter: fm }),
      getFirstLinkpathDest: (link: string) => (resolve[link] ? { path: resolve[link] } : null),
    },
  } as unknown as App;
}

describe("readBlockedBy (#8)", () => {
  it("resolves { uid: [[link]] } entries to vault task paths", () => {
    const app = mockAppLinks(
      { blockedBy: [{ uid: "[[Finish scanning]]", reltype: "FINISHTOSTART" }, { uid: "[[Audit]]" }] },
      { "Finish scanning": "dir/Finish scanning.md", Audit: "dir/Audit.md" },
    );
    expect(readBlockedBy(app, "note.md")).toEqual(["dir/Finish scanning.md", "dir/Audit.md"]);
  });

  it("drops an alias and unresolvable links, dedupes", () => {
    const app = mockAppLinks(
      { blockedBy: [{ uid: "[[Blocker|shown as]]" }, { uid: "[[Missing]]" }, { uid: "[[Blocker]]" }] },
      { Blocker: "dir/Blocker.md" },
    );
    expect(readBlockedBy(app, "note.md")).toEqual(["dir/Blocker.md"]);
  });

  it("keeps a bare (non-wikilink) path as-is", () => {
    const app = mockAppLinks({ blockedBy: ["dir/Plain.md"] }, {});
    expect(readBlockedBy(app, "note.md")).toEqual(["dir/Plain.md"]);
  });

  it("returns [] when blockedBy is absent or not a list", () => {
    expect(readBlockedBy(mockAppLinks({}, {}), "note.md")).toEqual([]);
    expect(readBlockedBy(mockAppLinks({ blockedBy: "nope" }, {}), "note.md")).toEqual([]);
  });
});
