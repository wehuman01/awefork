import { describe, expect, it } from "vitest";
import { buildTurnGraph, type TurnNode } from "../src/shared/canvas-graph";
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
      createdAt: i * 10,
      completedAt: null,
    },
    {
      id: assistantId,
      role: "assistant" as const,
      text: `reply ${assistantId}`,
      toolNames: [],
      modelId: `fake/model-${i + 1}`,
      providerId: "oc-fake",
      createdAt: i * 10 + 5,
      completedAt: null,
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
      { providerId: "oc-fake", modelId: "fake/model-1" },
      { providerId: "oc-fake", modelId: "fake/model-2" },
      { providerId: "oc-fake", modelId: "fake/model-3" },
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
