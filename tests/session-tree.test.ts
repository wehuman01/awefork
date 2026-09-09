import { describe, expect, it } from "vitest";
import { buildSessionTree, pickNeighborId, withoutArchived } from "../src/shared/session-tree";
import type { ArchiveState, LineageMap, SessionSummary } from "../src/shared/types";

function session(partial: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    title: partial.id,
    directory: "/repo",
    parentSessionId: null,
    origin: "root",
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

describe("buildSessionTree", () => {
  const sessions: SessionSummary[] = [
    session({ id: "a", updatedAt: 10 }),
    session({ id: "b", updatedAt: 20, directory: "/other" }),
    session({ id: "sub", updatedAt: 30, parentSessionId: "a", origin: "subagent" }),
  ];
  const lineage: LineageMap = {
    "a-fork": { parentId: "a", atMessageId: "m1", createdAt: 5 },
    "a-fork-2": { parentId: "a-fork", atMessageId: null, createdAt: 6 },
  };

  it("groups by directory and sorts newest first", () => {
    const tree = buildSessionTree([...sessions, session({ id: "a-fork", updatedAt: 15 })], lineage);
    expect(tree.map((g) => g.directory)).toEqual(["/other", "/repo"]);
    const repo = tree.find((g) => g.directory === "/repo");
    expect(repo?.roots.map((n) => n.session.id)).toEqual(["a"]);
  });

  it("nests lineage forks and forks of forks", () => {
    const all = [...sessions, session({ id: "a-fork" }), session({ id: "a-fork-2" })];
    const tree = buildSessionTree(all, lineage);
    const root = tree.find((g) => g.directory === "/repo")?.roots.find((n) => n.session.id === "a");
    const fork = root?.children.find((n) => n.session.id === "a-fork");
    expect(fork?.session.origin).toBe("fork");
    expect(fork?.children.map((n) => n.session.id)).toEqual(["a-fork-2"]);
  });

  it("hides subagents by default and shows them on demand", () => {
    const all = [...sessions, session({ id: "a-fork" })];
    const root = buildSessionTree(all, lineage)
      .find((g) => g.directory === "/repo")
      ?.roots.find((n) => n.session.id === "a");
    expect(root?.children.map((n) => n.session.id)).toEqual(["a-fork"]);

    const shown = buildSessionTree(all, lineage, { hideSubagents: false });
    const rootShown = shown
      .find((g) => g.directory === "/repo")
      ?.roots.find((n) => n.session.id === "a");
    expect(rootShown?.children.map((n) => n.session.id)).toContain("sub");
  });

  it("treats a fork with a missing parent as a root", () => {
    const all = [session({ id: "a", updatedAt: 1 }), session({ id: "orphan", updatedAt: 99 })];
    const tree = buildSessionTree(all, {
      orphan: { parentId: "deleted", atMessageId: null, createdAt: 0 },
    });
    expect(tree[0]?.roots.map((n) => n.session.id)).toEqual(["orphan", "a"]);
  });
});

describe("pickNeighborId", () => {
  const ids = ["a", "b", "c"];

  it("takes over the deleted row's position (the next session)", () => {
    expect(pickNeighborId(ids, "a")).toBe("b");
    expect(pickNeighborId(ids, "b")).toBe("c");
  });

  it("falls back to the previous session at the end of the list", () => {
    expect(pickNeighborId(ids, "c")).toBe("b");
  });

  it("returns null for the last survivor and for unknown ids", () => {
    expect(pickNeighborId(["a"], "a")).toBeNull();
    expect(pickNeighborId(ids, "zzz")).toBeNull();
  });
});

describe("withoutArchived", () => {
  const sessions: SessionSummary[] = [
    session({ id: "a", updatedAt: 10 }),
    session({ id: "b", updatedAt: 20, directory: "/other" }),
    session({ id: "c", updatedAt: 30, directory: "/other" }),
  ];

  it("returns the input untouched when nothing is archived", () => {
    expect(withoutArchived(sessions, { sessions: [], directories: [] })).toBe(sessions);
  });

  it("hides an individually archived session, others stay", () => {
    const archive: ArchiveState = {
      sessions: [{ id: "b", archivedAt: 1 }],
      directories: [],
    };
    expect(withoutArchived(sessions, archive).map((s) => s.id)).toEqual(["a", "c"]);
  });

  it("hides every session under an archived directory — including later ones", () => {
    const archive: ArchiveState = {
      sessions: [],
      directories: [{ path: "/other", archivedAt: 1 }],
    };
    const withNewcomer = [...sessions, session({ id: "new", directory: "/other", updatedAt: 99 })];
    expect(withoutArchived(withNewcomer, archive).map((s) => s.id)).toEqual(["a"]);
  });

  it("restoring a directory leaves individually archived sessions hidden", () => {
    // "b" was archived on its own before the whole directory went in.
    const whileArchived = withoutArchived(sessions, {
      sessions: [{ id: "b", archivedAt: 1 }],
      directories: [{ path: "/other", archivedAt: 2 }],
    });
    expect(whileArchived.map((s) => s.id)).toEqual(["a"]);

    // Directory restored (its entry drops out); "b" keeps its own.
    const afterRestore = withoutArchived(sessions, {
      sessions: [{ id: "b", archivedAt: 1 }],
      directories: [],
    });
    expect(afterRestore.map((s) => s.id)).toEqual(["a", "c"]);
  });

  it("both lists combine: union of hidden sessions", () => {
    const archive: ArchiveState = {
      sessions: [{ id: "a", archivedAt: 1 }],
      directories: [{ path: "/other", archivedAt: 2 }],
    };
    expect(withoutArchived(sessions, archive)).toEqual([]);
  });
});
