import { describe, expect, it } from "vitest";
import { buildTurns, turnMessageRange } from "../src/shared/turns";
import type { ChatMessage } from "../src/shared/types";

function user(id: string, text: string, createdAt = 1000): ChatMessage {
  return {
    id,
    role: "user",
    text,
    toolNames: [],
    modelId: null,
    providerId: null,
    variant: null,
    attachmentNames: [],
    createdAt,
    completedAt: null,
    outputTokens: null,
    error: null,
  };
}

function assistant(
  id: string,
  text: string,
  createdAt = 2000,
  toolNames: string[] = [],
  modelId: string | null = null,
  providerId: string | null = null,
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    role: "assistant",
    text,
    toolNames,
    modelId,
    providerId,
    variant: null,
    attachmentNames: [],
    createdAt,
    completedAt: null,
    outputTokens: null,
    error: null,
    ...overrides,
  };
}

describe("buildTurns", () => {
  it("groups each user message with the assistant reply that follows it", () => {
    const turns = buildTurns("s1", [
      user("u1", "first question"),
      assistant("a1", "first answer", 2000, ["read"]),
      user("u2", "second question"),
      assistant("a2", "second answer"),
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      messageId: "u1",
      title: "first question",
      preview: "first answer",
      toolNames: ["read"],
    });
    expect(turns[1]).toMatchObject({ messageId: "u2", preview: "second answer" });
  });

  it("uses the first non-empty line of the prompt as the title", () => {
    const turns = buildTurns("s1", [user("u1", "  \nfix the bug in main.ts\nplease")]);
    expect(turns[0]?.title).toBe("fix the bug in main.ts");
  });

  it("merges multi-message replies and dedupes tool names", () => {
    const turns = buildTurns("s1", [
      user("u1", "q"),
      assistant("a1", "", 2000, ["bash", "read"]),
      assistant("a2", "done", 3000, ["read", "edit"]),
    ]);
    expect(turns[0]?.preview).toBe("done");
    expect(turns[0]?.toolNames).toEqual(["bash", "read", "edit"]);
  });

  it("collects distinct model ids of the turn's replies in first-seen order", () => {
    const turns = buildTurns("s1", [
      user("u1", "q"),
      assistant("a1", "", 2000, [], "glm/glm-5.3-flash", "oc-awerouter"),
      assistant("a2", "done", 3000, [], "glm/glm-5.3-flash", "oc-awerouter"),
      user("u2", "q2"),
      assistant("a3", "ok", 4000, [], "codex/gpt-5.6-sol", "oc-aweshare"),
    ]);
    expect(turns[0]?.modelIds).toEqual(["glm/glm-5.3-flash"]);
    expect(turns[1]?.modelIds).toEqual(["codex/gpt-5.6-sol"]);
  });

  it("keeps the model of the turn's last reply as the actionable choice", () => {
    const turns = buildTurns("s1", [
      user("u1", "q"),
      assistant("a1", "", 2000, [], "glm/glm-5.3-flash", "oc-awerouter"),
      assistant("a2", "done", 3000, [], "codex/gpt-5.6-sol", "oc-aweshare"),
    ]);
    expect(turns[0]?.model).toEqual({
      providerId: "oc-aweshare",
      modelId: "codex/gpt-5.6-sol",
      variant: null,
    });
  });

  it("rides the effort variant on the model choice — user seed and assistant override", () => {
    const turns = buildTurns("s1", [
      {
        ...user("u1", "q"),
        modelId: "glm/glm-5.3-flash",
        providerId: "oc-awerouter",
        variant: "high",
      },
      assistant("a1", "done", 2000, [], "codex/gpt-5.6-sol", "oc-aweshare", { variant: "medium" }),
      { ...user("u2", "q2"), modelId: "glm/glm-5.3", providerId: "oc-awerouter", variant: "low" },
      assistant("a2", "ok", 3000),
    ]);
    expect(turns[0]?.model).toEqual({
      providerId: "oc-aweshare",
      modelId: "codex/gpt-5.6-sol",
      variant: "medium",
    });
    expect(turns[1]?.model).toEqual({
      providerId: "oc-awerouter",
      modelId: "glm/glm-5.3",
      variant: "low",
    });
  });

  it("keeps model ids empty when the backend reports none", () => {
    const turns = buildTurns("s1", [user("u1", "q"), assistant("a1", "done")]);
    expect(turns[0]?.modelIds).toEqual([]);
    expect(turns[0]?.model).toBeNull();
  });

  it("seeds the turn model from the user row when the reply reports none", () => {
    const turns = buildTurns("s1", [
      { ...user("u1", "q"), modelId: "stepfun-2/step-3.7-flash", providerId: "oc-awerouter" },
      assistant("a1", "", 2000),
    ]);
    expect(turns[0]?.modelIds).toEqual(["stepfun-2/step-3.7-flash"]);
    expect(turns[0]?.model).toEqual({
      providerId: "oc-awerouter",
      modelId: "stepfun-2/step-3.7-flash",
      variant: null,
    });
  });

  it("drops assistant messages before the first user message", () => {
    const turns = buildTurns("s1", [assistant("a0", "orphan"), user("u1", "q")]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.preview).toBe("");
  });

  it("falls back to a placeholder title for blank prompts", () => {
    const turns = buildTurns("s1", [user("u1", "   ")]);
    expect(turns[0]?.title).toBe("(empty prompt)");
  });

  it("titles a blank prompt after its first tool, else the reply's first line", () => {
    const withTool = buildTurns("s1", [
      user("u1", "  "),
      assistant("a1", "did things", 2000, ["read"]),
    ]);
    expect(withTool[0]?.title).toBe("🔧 read");

    const withReplyOnly = buildTurns("s1", [user("u1", ""), assistant("a1", "summary line\nmore")]);
    expect(withReplyOnly[0]?.title).toBe("summary line");
  });

  it("measures the turn's run duration and sums output tokens", () => {
    const turns = buildTurns("s1", [
      user("u1", "q", 1000),
      assistant("a1", "part one", 2000, [], null, null, { outputTokens: 120, completedAt: 5000 }),
      assistant("a2", "part two", 6000, [], null, null, { outputTokens: 30, completedAt: 8000 }),
    ]);
    expect(turns[0]?.durationMs).toBe(7000);
    expect(turns[0]?.outputTokens).toBe(150);
  });

  it("keeps duration null and tokens zero while a run never reported completion", () => {
    const turns = buildTurns("s1", [user("u1", "q"), assistant("a1", "partial")]);
    expect(turns[0]?.durationMs).toBeNull();
    expect(turns[0]?.outputTokens).toBe(0);
  });

  it("keeps the run's failure reason on the turn", () => {
    const turns = buildTurns("s1", [
      user("u1", "我是谁", 1000),
      assistant("a1", "", 2000, [], null, null, {
        error: "you have no active step plan subscription",
        completedAt: 2500,
      }),
    ]);
    expect(turns[0]?.error).toBe("you have no active step plan subscription");
  });

  it("returns no turns for an empty session", () => {
    expect(buildTurns("s1", [])).toEqual([]);
  });
});

describe("turnMessageRange", () => {
  it("covers the user row and every row it produced, up to the next user row", () => {
    const messages = [
      user("u1", "q1"),
      assistant("a1", "answer 1"),
      assistant("a2", "answer 2"),
      user("u2", "q2"),
      assistant("a3", "answer 3"),
    ];
    expect(turnMessageRange(messages, "u1")).toEqual({ start: 0, end: 3 });
    expect(turnMessageRange(messages, "u2")).toEqual({ start: 3, end: 5 });
  });

  it("returns null for an unknown message id", () => {
    const messages = [user("u1", "q1"), assistant("a1", "answer 1")];
    expect(turnMessageRange(messages, "ghost")).toBeNull();
    expect(turnMessageRange([], "u1")).toBeNull();
  });
});
