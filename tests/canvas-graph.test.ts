import { describe, expect, it } from "vitest";
import {
  buildTurnGraph,
  chainToTip,
  NODE_HEIGHT,
  ROW_GAP,
  type TurnNode,
} from "../src/shared/canvas-graph";
import type { ChatMessage, ForkRecord, LineageMap, SessionSummary } from "../src/shared/types";

function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    title: `session ${id}`,
    directory: "/repo",
    parentSessionId: null,
    origin: "root",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function chain(...pairs: [string, string][]): ChatMessage[] {
  return pairs.flatMap(([userId, assistantId], i) => [
    {
      id: userId,
      role: "user" as const,
      text: `prompt ${userId}`,
      toolNames: [],
      modelId: null,
      providerId: null,
      variant: null,
      attachmentNames: [],
      createdAt: i * 10,
      completedAt: null,
      outputTokens: null,
      error: null,
    },
    {
      id: assistantId,
      role: "assistant" as const,
      text: `reply ${assistantId}`,
      toolNames: [],
      modelId: `fake/model-${i + 1}`,
      providerId: "oc-fake",
      variant: null,
      attachmentNames: [],
      createdAt: i * 10 + 5,
      completedAt: null,
      outputTokens: null,
      error: null,
    },
  ]);
}

function fork(parentId: string, atMessageId: string | null, at = 500): ForkRecord {
  return { parentId, atMessageId, createdAt: at };
}

function nodeIds(graph: { nodes: TurnNode[] }, sessionId: string): string[] {
  return graph.nodes.filter((n) => n.sessionId === sessionId).map((n) => n.id);
}

describe("buildTurnGraph", () => {
  it("chains turns of a single session left to right with sequence edges", () => {
    const graph = buildTurnGraph({
      sessions: [session("a")],
      lineage: {},
      messages: { a: chain(["a-u1", "a-r1"], ["a-u2", "a-r2"], ["a-u3", "a-r3"]) },
    });

    expect(nodeIds(graph, "a")).toEqual(["a:a-u1", "a:a-u2", "a:a-u3"]);
    expect(graph.edges).toEqual([
      { from: "a:a-u1", to: "a:a-u2", kind: "sequence" },
      { from: "a:a-u2", to: "a:a-u3", kind: "sequence" },
    ]);
    expect(graph.nodes.map((n) => n.col)).toEqual([0, 1, 2]);
    expect(graph.nodes.every((n) => n.row === 0)).toBe(true);
    expect(graph.nodes.map((n) => n.modelIds)).toEqual([
      ["fake/model-1"],
      ["fake/model-2"],
      ["fake/model-3"],
    ]);
    expect(graph.nodes.map((n) => n.model)).toEqual([
      { providerId: "oc-fake", modelId: "fake/model-1", variant: null },
      { providerId: "oc-fake", modelId: "fake/model-2", variant: null },
      { providerId: "oc-fake", modelId: "fake/model-3", variant: null },
    ]);
  });

  it("grows a fork from the forked turn with a dashed edge and skips the inherited prefix", () => {
    const graph = buildTurnGraph({
      sessions: [session("a"), session("b", { origin: "fork", createdAt: 500 })],
      lineage: { b: fork("a", "a-u1") },
      messages: {
        a: chain(["a-u1", "a-r1"], ["a-u2", "a-r2"]),
        // opencode copies the parent history into the fork, ids preserved
        b: chain(["a-u1", "a-r1"], ["a-u2", "a-r2"], ["b-u3", "b-r3"]),
      },
    });

    expect(nodeIds(graph, "b")).toEqual(["b:b-u3"]);
    expect(graph.edges).toContainEqual({ from: "a:a-u1", to: "b:b-u3", kind: "fork" });
    const bNode = graph.nodes.find((n) => n.id === "b:b-u3");
    const forkTurn = graph.nodes.find((n) => n.id === "a:a-u1");
    expect(bNode?.col).toBe((forkTurn?.col ?? 0) + 1);
    expect(bNode?.row).toBeGreaterThan(forkTurn?.row ?? 0);
  });

  it("falls back to the recorded fork position when forked message ids differ", () => {
    const graph = buildTurnGraph({
      sessions: [session("a"), session("b", { origin: "fork", createdAt: 500 })],
      lineage: { b: fork("a", "a-u1") },
      messages: {
        a: chain(["a-u1", "a-r1"], ["a-u2", "a-r2"]),
        // same history, re-keyed ids; a fork at a-u1 keeps only that first turn
        b: chain(["b-u1", "b-r1"], ["b-u3", "b-r3"]),
      },
    });

    // fork at a-u1 keeps turn 1 → only b's 3rd turn is new
    expect(nodeIds(graph, "b")).toEqual(["b:b-u3"]);
    expect(graph.edges).toContainEqual({ from: "a:a-u1", to: "b:b-u3", kind: "fork" });
  });

  it("renders an empty branch as a stub node connected to its fork point", () => {
    const graph = buildTurnGraph({
      sessions: [session("a"), session("b", { origin: "fork", createdAt: 500 })],
      lineage: { b: fork("a", "a-u2") },
      messages: {
        a: chain(["a-u1", "a-r1"], ["a-u2", "a-r2"]),
        b: chain(["a-u1", "a-r1"], ["a-u2", "a-r2"]),
      },
    });

    const stubs = graph.nodes.filter((n) => n.kind === "stub");
    expect(stubs).toHaveLength(1);
    expect(stubs[0]?.sessionId).toBe("b");
    expect(graph.edges).toEqual([
      { from: "a:a-u1", to: "a:a-u2", kind: "sequence" },
      { from: "a:a-u2", to: "b::stub", kind: "fork" },
    ]);
  });

  it("stacks sibling forks below each other without collisions", () => {
    const graph = buildTurnGraph({
      sessions: [
        session("a"),
        session("b", { origin: "fork", createdAt: 500 }),
        session("c", { origin: "fork", createdAt: 600 }),
      ],
      lineage: { b: fork("a", "a-u1"), c: fork("a", "a-u1") },
      messages: {
        a: chain(["a-u1", "a-r1"], ["a-u2", "a-r2"]),
        b: chain(["a-u1", "a-r1"], ["b-u2", "b-r2"]),
        c: chain(["a-u1", "a-r1"], ["c-u2", "c-r2"]),
      },
    });

    const slots = graph.nodes.map((n) => `${n.col}:${n.row}`);
    expect(new Set(slots).size).toBe(slots.length);
    const bNode = graph.nodes.find((n) => n.sessionId === "b");
    const cNode = graph.nodes.find((n) => n.sessionId === "c");
    expect(bNode?.row).not.toBe(cNode?.row);
  });

  it("treats a fork whose parent is missing as a root chain", () => {
    const graph = buildTurnGraph({
      sessions: [session("orphan", { origin: "fork" })],
      lineage: { orphan: fork("ghost", null) },
      messages: { orphan: chain(["o-u1", "o-r1"], ["o-u2", "o-r2"]) },
    });

    expect(nodeIds(graph, "orphan")).toEqual(["orphan:o-u1", "orphan:o-u2"]);
    expect(graph.edges).toEqual([{ from: "orphan:o-u1", to: "orphan:o-u2", kind: "sequence" }]);
  });

  it("renders a session whose messages failed to load as a stub", () => {
    const graph = buildTurnGraph({
      sessions: [session("a"), session("b", { createdAt: 500 })],
      lineage: {},
      messages: { a: chain(["a-u1", "a-r1"]) },
    });

    const stubs = graph.nodes.filter((n) => n.kind === "stub");
    expect(stubs.map((s) => s.sessionId)).toEqual(["b"]);
  });

  it("hides subagent sessions", () => {
    const graph = buildTurnGraph({
      sessions: [session("a"), session("sub", { origin: "subagent", parentSessionId: "a" })],
      lineage: {},
      messages: { a: chain(["a-u1", "a-r1"]), sub: chain(["s-u1", "s-r1"]) },
    });

    expect(graph.nodes.map((n) => n.sessionId)).toEqual(["a"]);
  });
});

describe("chainToTip", () => {
  it("walks a linear session root-first", () => {
    const graph = buildTurnGraph({
      sessions: [session("a")],
      lineage: {},
      messages: { a: chain(["a-u1", "a-r1"], ["a-u2", "a-r2"]) },
    });

    expect(chainToTip(graph, "a:a-u2").map((n) => n.id)).toEqual(["a:a-u1", "a:a-u2"]);
  });

  it("crosses a fork edge back into the parent session's turn", () => {
    const graph = buildTurnGraph({
      sessions: [session("a"), session("b", { origin: "fork", createdAt: 500 })],
      lineage: { b: fork("a", "a-u1") },
      messages: {
        a: chain(["a-u1", "a-r1"], ["a-u2", "a-r2"]),
        b: chain(["a-u1", "a-r1"], ["a-u2", "a-r2"], ["b-u3", "b-r3"]),
      },
    });

    expect(chainToTip(graph, "b:b-u3").map((n) => n.id)).toEqual(["a:a-u1", "b:b-u3"]);
  });

  it("returns empty for a null tip and ignores unknown tip ids", () => {
    const graph = buildTurnGraph({
      sessions: [session("a")],
      lineage: {},
      messages: { a: chain(["a-u1", "a-r1"]) },
    });

    expect(chainToTip(graph, null)).toEqual([]);
    expect(chainToTip(graph, "ghost:x")).toEqual([]);
  });
});

describe("layout invariants", () => {
  /** Root with two turns, two siblings forked from a-u1, and a fork of a fork. */
  const story = {
    sessions: [
      session("a"),
      session("b", { origin: "fork", createdAt: 500 }),
      session("c", { origin: "fork", createdAt: 600 }),
      session("d", { origin: "fork", createdAt: 700 }),
    ],
    lineage: { b: fork("a", "a-u1"), c: fork("a", "a-u1"), d: fork("b", "b-u2") },
    messages: {
      a: chain(["a-u1", "a-r1"], ["a-u2", "a-r2"]),
      b: chain(["a-u1", "a-r1"], ["b-u2", "b-r2"]),
      c: chain(["a-u1", "a-r1"], ["c-u2", "c-r2"]),
      d: chain(["a-u1", "a-r1"], ["b-u2", "b-r2"], ["d-u3", "d-r3"], ["d-u4", "d-r4"]),
    },
  };

  it("never places two nodes in the same col:row slot", () => {
    const graph = buildTurnGraph(story);
    const slots = graph.nodes.map((n) => `${n.col}:${n.row}`);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it("moves every edge exactly one column right", () => {
    const graph = buildTurnGraph(story);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const edge of graph.edges) {
      expect(byId.get(edge.to)?.col).toBe((byId.get(edge.from)?.col ?? -1) + 1);
    }
  });

  it("keeps a session's turns in time order left to right", () => {
    const graph = buildTurnGraph(story);
    const turns = graph.nodes.filter((n) => n.kind === "turn").sort((a, b) => a.col - b.col);
    const bySession = new Map<string, TurnNode[]>();
    for (const turn of turns) {
      bySession.set(turn.sessionId, [...(bySession.get(turn.sessionId) ?? []), turn]);
    }
    for (const nodes of bySession.values()) {
      const times = nodes.map((n) => n.createdAt);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    }
  });

  it("never stacks cards in a column so they overlap", () => {
    // Heights as a real session would measure them: varied per node.
    const first = buildTurnGraph(story);
    const heights: Record<string, number> = {};
    for (const node of first.nodes) {
      heights[node.id] = 80 + ((node.col * 37 + node.row * 53) % 200);
    }
    const graph = buildTurnGraph({ ...story, heights });

    const byCol = new Map<number, TurnNode[]>();
    for (const node of graph.nodes) {
      byCol.set(node.col, [...(byCol.get(node.col) ?? []), node]);
    }
    for (const nodes of byCol.values()) {
      nodes.sort((a, b) => a.row - b.row);
      for (let i = 1; i < nodes.length; i += 1) {
        const prev = nodes[i - 1];
        const next = nodes[i];
        expect(prev.y + prev.height).toBeLessThanOrEqual(next.y);
      }
    }
  });
});

describe("measured card heights", () => {
  it("bands each row by its tallest card and defaults the rest", () => {
    // a's turns share row 0; b's forked turn opens row 1.
    const graph = buildTurnGraph({
      sessions: [session("a"), session("b", { origin: "fork", createdAt: 500 })],
      lineage: { b: fork("a", "a-u1") },
      messages: {
        a: chain(["a-u1", "a-r1"], ["a-u2", "a-r2"]),
        b: chain(["a-u1", "a-r1"], ["b-u2", "b-r2"]),
      },
      heights: { "a:a-u1": 300 },
    });

    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get("a:a-u1")?.height).toBe(300);
    expect(byId.get("a:a-u2")?.height).toBe(NODE_HEIGHT);
    expect(byId.get("a:a-u1")?.y).toBe(0);
    expect(byId.get("a:a-u2")?.y).toBe(0);
    expect(byId.get("b:b-u2")?.y).toBe(300 + ROW_GAP);
  });

  it("collapses rows whose cards are all measured shorter than the default", () => {
    const graph = buildTurnGraph({
      sessions: [session("a"), session("b", { origin: "fork", createdAt: 500 })],
      lineage: { b: fork("a", "a-u2") },
      messages: {
        a: chain(["a-u1", "a-r1"], ["a-u2", "a-r2"]),
        b: chain(["a-u1", "a-r1"], ["a-u2", "a-r2"]),
      },
      heights: { "a:a-u1": 120, "a:a-u2": 120, "b::stub": 80 },
    });

    const stub = graph.nodes.find((n) => n.kind === "stub");
    expect(stub?.height).toBe(80);
    expect(stub?.y).toBe(120 + ROW_GAP);
  });

  it("keeps the plain grid when nothing is measured", () => {
    const graph = buildTurnGraph({
      sessions: [session("a")],
      lineage: {},
      messages: { a: chain(["a-u1", "a-r1"], ["a-u2", "a-r2"]) },
    });

    for (const node of graph.nodes) {
      expect(node.height).toBe(NODE_HEIGHT);
      expect(node.y).toBe(node.row * (NODE_HEIGHT + ROW_GAP));
    }
  });
});
