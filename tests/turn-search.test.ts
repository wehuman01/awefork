import { describe, expect, it } from "vitest";
import { buildTurnGraph, type TurnNode } from "../src/shared/canvas-graph";
import { searchTurns } from "../src/shared/turn-search";
import type { ChatMessage, SessionSummary } from "../src/shared/types";

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

function turnMessages(
  userId: string,
  prompt: string,
  reply: string,
  extras: Partial<ChatMessage> = {},
): ChatMessage[] {
  return [
    {
      id: userId,
      role: "user",
      text: prompt,
      toolNames: [],
      modelId: null,
      providerId: null,
      variant: null,
      attachmentNames: [],
      createdAt: 1000,
      completedAt: null,
      outputTokens: null,
      error: null,
    },
    {
      id: `${userId}-r`,
      role: "assistant",
      text: reply,
      toolNames: [],
      modelId: "fake/model",
      providerId: "oc-fake",
      variant: null,
      attachmentNames: [],
      createdAt: 1005,
      completedAt: 1010,
      outputTokens: 100,
      error: null,
      ...extras,
    },
  ];
}

/** Three-turn story with distinct keywords: JWT, redis, 内存泄漏. */
function storyNodes(): TurnNode[] {
  return buildTurnGraph({
    sessions: [session("a")],
    lineage: {},
    messages: {
      a: [
        ...turnMessages("u1", "对比 JWT 和 session 方案", "JWT 无状态，session 要存 redis。"),
        ...turnMessages(
          "u2",
          "修一下压测里发现的内存泄漏",
          "泄漏在限流器的 Map，没有清理过期键。",
          { toolNames: ["read", "edit"] },
        ),
        ...turnMessages("u3", "收尾", "都改完了。"),
      ],
    },
  }).nodes;
}

describe("searchTurns", () => {
  it("finds a turn by a word in its prompt", () => {
    const hits = searchTurns(storyNodes(), "内存泄漏");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.nodeId).toBe("a:u2");
    expect(hits[0]?.field).toBe("prompt");
    expect(hits[0]?.snippet).toContain("内存泄漏");
  });

  it("finds a turn by a word only present in the reply preview", () => {
    const hits = searchTurns(storyNodes(), "redis");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.nodeId).toBe("a:u1");
    expect(hits[0]?.field).toBe("preview");
  });

  it("matches tool names as a third field", () => {
    const hits = searchTurns(storyNodes(), "edit");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.nodeId).toBe("a:u2");
    expect(hits[0]?.field).toBe("tool");
  });

  it("requires every whitespace-separated term to match somewhere", () => {
    const nodes = storyNodes();
    expect(searchTurns(nodes, "内存泄漏 限流器")).toHaveLength(1);
    expect(searchTurns(nodes, "内存泄漏 postgres")).toHaveLength(0);
  });

  it("is case-insensitive on both sides", () => {
    const hits = searchTurns(storyNodes(), "JWT");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain("JWT");
  });

  it("reports title hits before preview hits, older turns first", () => {
    const nodes = buildTurnGraph({
      sessions: [session("a")],
      lineage: {},
      messages: {
        a: [
          ...turnMessages("u1", "聊聊 kafka", "kafka 很快。"),
          ...turnMessages("u2", "别的", "再聊聊 kafka 的副本同步。"),
        ],
      },
    }).nodes;
    const hits = searchTurns(nodes, "kafka");
    expect(hits.map((h) => h.nodeId)).toEqual(["a:u1", "a:u2"]);
    expect(hits.map((h) => h.field)).toEqual(["prompt", "preview"]);
  });

  it("reaches the full multi-line prompt body only when messages are passed", () => {
    const messages = {
      a: turnMessages(
        "u1",
        "帮我看下这个报错\n完整 stack 指向 rate_limiter.go 第 40 行",
        "限流器的阈值写死了。",
      ),
    };
    const nodes = buildTurnGraph({
      sessions: [session("a")],
      lineage: {},
      messages,
    }).nodes;
    // Without messages the card only knows the prompt's first line.
    expect(searchTurns(nodes, "rate_limiter")).toHaveLength(0);
    const hits = searchTurns(nodes, "rate_limiter", messages);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.nodeId).toBe("a:u1");
    expect(hits[0]?.field).toBe("prompt");
  });

  it("trims long previews to a window around the match, keeping match coordinates", () => {
    const filler = "很长的铺垫。".repeat(30);
    const nodes = buildTurnGraph({
      sessions: [session("a")],
      lineage: {},
      messages: { a: turnMessages("u1", "标题", `${filler}目标关键词在这里${filler}`) },
    }).nodes;
    const hit = searchTurns(nodes, "目标关键词")[0];
    expect(hit?.snippet.startsWith("…")).toBe(true);
    expect(hit?.snippet.endsWith("…")).toBe(true);
    const matched = hit?.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength);
    expect(matched).toBe("目标关键词");
  });

  it("falls back to the error string when a failed run has no reply text", () => {
    const nodes = buildTurnGraph({
      sessions: [session("a")],
      lineage: {},
      messages: {
        a: [
          {
            id: "u1",
            role: "user",
            text: "跑一下",
            toolNames: [],
            modelId: null,
            providerId: null,
            createdAt: 1000,
            completedAt: null,
            outputTokens: null,
            error: null,
          },
          {
            id: "u1-r",
            role: "assistant",
            text: "",
            toolNames: [],
            modelId: null,
            providerId: null,
            createdAt: 1005,
            completedAt: null,
            outputTokens: null,
            error: "provider quota exceeded",
          },
        ],
      },
    }).nodes;
    const hits = searchTurns(nodes, "quota");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.field).toBe("preview");
  });

  it("returns nothing for blank queries and skips stub nodes", () => {
    const nodes = buildTurnGraph({
      sessions: [session("a"), session("b", { origin: "fork", createdAt: 500 })],
      lineage: { b: { parentId: "a", atMessageId: "u1", createdAt: 500 } },
      messages: {
        a: turnMessages("u1", "标题", "回复"),
        b: turnMessages("u1", "标题", "回复"),
      },
    }).nodes;
    expect(searchTurns(nodes, "   ")).toEqual([]);
    // the stub renders no text of its own; only a's turn can match
    expect(searchTurns(nodes, "标题").map((h) => h.nodeId)).toEqual(["a:u1"]);
  });
});
