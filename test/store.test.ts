import { describe, it, expect } from "vitest";
import { SyncStore } from "../src/plugin/store.js";
import type { Snapshot } from "../src/core/types.js";

const snap = (o: Partial<Snapshot> = {}): Snapshot => ({
  linkId: "pk1",
  title: "T",
  body: null,
  isCompleted: false,
  due: null,
  scheduled: null,
  timeEstimate: null,
  priority: "none",
  flagged: false,
  tags: [],
  ...o,
});

describe("SyncStore links", () => {
  it("stores and reverse-resolves a link", () => {
    const s = new SyncStore();
    s.setLink("t1", "pkA");
    expect(s.getPrimaryKey("t1")).toBe("pkA");
    expect(s.getTaskId("pkA")).toBe("t1");
  });

  it("clears a link in both directions", () => {
    const s = new SyncStore();
    s.setLink("t1", "pkA");
    s.clearLinkByTaskId("t1");
    expect(s.getPrimaryKey("t1")).toBeUndefined();
    expect(s.getTaskId("pkA")).toBeUndefined();
  });

  it("hydrates from persisted state", () => {
    const s = new SyncStore({ links: { t1: "pkA" }, snapshots: {} });
    expect(s.getPrimaryKey("t1")).toBe("pkA");
  });
});

describe("SyncStore snapshots", () => {
  it("stores, reads, and deletes a snapshot by linkId", () => {
    const s = new SyncStore();
    s.setSnapshot(snap({ linkId: "pkA", title: "X" }));
    expect(s.getSnapshot("pkA")?.title).toBe("X");
    s.deleteSnapshot("pkA");
    expect(s.getSnapshot("pkA")).toBeUndefined();
  });
});

describe("SyncStore suppression (ephemeral, TTL)", () => {
  it("suppresses until the TTL elapses using the injected clock", () => {
    let t = 1000;
    const s = new SyncStore(undefined, () => t);
    s.suppress("pkA", 500);
    expect(s.isSuppressed("pkA")).toBe(true);
    t = 1499;
    expect(s.isSuppressed("pkA")).toBe(true);
    t = 1500;
    expect(s.isSuppressed("pkA")).toBe(false);
  });

  it("suppressedList reflects currently-suppressed links", () => {
    let t = 0;
    const s = new SyncStore(undefined, () => t);
    s.suppress("pkA", 100);
    expect(s.suppressedList()).toContain("pkA");
    t = 200;
    expect(s.suppressedList()).not.toContain("pkA");
  });
});

describe("SyncStore serialization", () => {
  it("toJSON emits links + snapshots and excludes suppression", () => {
    const s = new SyncStore(undefined, () => 0);
    s.setLink("t1", "pkA");
    s.setSnapshot(snap({ linkId: "pkA" }));
    s.suppress("pkA", 1000);
    const json = s.toJSON();
    expect(json.links).toEqual({ t1: "pkA" });
    expect(json.snapshots.pkA.linkId).toBe("pkA");
    expect(json).not.toHaveProperty("suppressed");
    // round-trips
    const s2 = new SyncStore(JSON.parse(JSON.stringify(json)));
    expect(s2.getPrimaryKey("t1")).toBe("pkA");
    expect(s2.getSnapshot("pkA")?.linkId).toBe("pkA");
  });
});
