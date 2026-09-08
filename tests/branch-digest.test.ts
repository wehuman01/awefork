import { describe, expect, it } from "vitest";
import { buildBranchDigests } from "../src/shared/branch-digest";
import { buildTurnGraph } from "../src/shared/canvas-graph";
import type { ChatMessage, ForkRecord, SessionSummary } from "../src/shared/types";

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

function msg(id: string, role: "user" | "assistant", text: string): ChatMessage {
  return {
    id,
    role,
    text,
    toolNames: [],
    modelId: role === "assistant" ? "fake/model" : null,
    providerId: role === "assistant" ? "oc-fake" : null,
    createdAt: 1000,
    completedAt: role === "assistant" ? 1100 : null,
    outputTokens: role === "assistant" ? 500 : null,
    error: null,
  };
}

/** Root a (2 turns) with fork b after a-u1 (1 own turn) and empty fork c. */
function story() {
  const sessions = [
    session("a", { title: "主线", createdAt: 100, updatedAt: 800 }),
    session("b", { title: "JWT 路线", origin: "fork", createdAt: 500, updatedAt: 900 }),
    session("c", { title: "空分支", origin: "fork", createdAt: 600, updatedAt: 600 }),
  ];
  const lineage: Record<string, ForkRecord> = {
    b: { parentId: "a", atMessageId: "a-u1", createdAt: 500 },
    c: { parentId: "a", atMessageId: null, createdAt: 600 },
  };
  const messages: Record<string, ChatMessage[]> = {
    a: [
      msg("a-u1", "user", "第一个问题"),
      msg("a-u1-r", "assistant", "第一个回答"),
      msg("a-u2", "user", "第二个问题"),
      msg("a-u2-r", "assistant", "第二个回答"),
    ],
    b: [
      msg("a-u1", "user", "第一个问题"),
      msg("a-u1-r", "assistant", "第一个回答"),
      msg("b-u2", "user", "JWT 怎么做"),
      msg("b-u2-r", "assistant", "这样这样做"),
    ],
    c: [
      msg("a-u1", "user", "第一个问题"),
      msg("a-u1-r", "assistant", "第一个回答"),
      msg("a-u2", "user", "第二个问题"),
      msg("a-u2-r", "assistant", "第二个回答"),
    ],
  };
  return { sessions, lineage, messages };
}

describe("buildBranchDigests", () => {
  it("summarizes each session on the canvas: own turns, tokens, last activity", () => {
    const { sessions, lineage, messages } = story();
    const graph = buildTurnGraph({ sessions, lineage, messages });
    const digests = buildBranchDigests(graph, sessions, lineage);

    expect(digests.map((d) => d.sessionId)).toEqual(["a", "b", "c"]);
    const a = digests[0];
    const b = digests[1];
    const c = digests[2];
    expect(a?.turnCount).toBe(2);
    expect(a?.outputTokens).toBe(1000);
    expect(a?.lastTurnTitle).toBe("第二个问题");
    expect(a?.forkedFrom).toBeNull();
    // b inherited a's prefix — only its own turn counts
    expect(b?.turnCount).toBe(1);
    expect(b?.lastTurnTitle).toBe("JWT 怎么做");
    // c forked at latest state: nothing of its own, stub only
    expect(c?.turnCount).toBe(0);
    expect(c?.lastTurnTitle).toBe("");
    expect(c?.jumpNodeId).toBe("c::stub");
  });

  it("records where each fork split off, by turn title when recorded", () => {
    const { sessions, lineage, messages } = story();
    const graph = buildTurnGraph({ sessions, lineage, messages });
    const b = buildBranchDigests(graph, sessions, lineage).find((d) => d.sessionId === "b");

    expect(b?.forkedFrom).toEqual({
      sessionId: "a",
      sessionTitle: "主线",
      turnTitle: "第一个问题",
    });
  });

  it("falls back to the parent's last node when the fork recorded no turn", () => {
    const { sessions, lineage, messages } = story();
    const graph = buildTurnGraph({ sessions, lineage, messages });
    const c = buildBranchDigests(graph, sessions, lineage).find((d) => d.sessionId === "c");

    expect(c?.forkedFrom?.turnTitle).toBe("第二个问题");
  });

  it("flags branches with a failed run and drops lineage pointing outside the story", () => {
    const sessions = [
      session("a"),
      session("b", { origin: "fork", createdAt: 500, updatedAt: 700 }),
    ];
    const lineage: Record<string, ForkRecord> = {
      b: { parentId: "ghost", atMessageId: null, createdAt: 500 },
    };
    const messages: Record<string, ChatMessage[]> = {
      a: [
        msg("a-u1", "user", "问"),
        { ...msg("a-u1-r", "assistant", ""), error: "provider quota exceeded" },
      ],
      b: [msg("b-u1", "user", "问"), msg("b-u1-r", "assistant", "答")],
    };
    const graph = buildTurnGraph({ sessions, lineage, messages });
    const digests = buildBranchDigests(graph, sessions, lineage);

    expect(digests.find((d) => d.sessionId === "a")?.hasError).toBe(true);
    // ghost parent is not on the canvas — the fork digests as a root
    expect(digests.find((d) => d.sessionId === "b")?.forkedFrom).toBeNull();
  });
});
