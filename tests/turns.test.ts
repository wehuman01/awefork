import { describe, expect, it } from "vitest";
import { buildTurns } from "../src/shared/turns";
import type { ChatMessage } from "../src/shared/types";

function user(id: string, text: string, createdAt = 1000): ChatMessage {
  return { id, role: "user", text, toolNames: [], modelId: null, createdAt };
}

function assistant(
  id: string,
  text: string,
  createdAt = 2000,
  toolNames: string[] = [],
  modelId: string | null = null,
): ChatMessage {
  return { id, role: "assistant", text, toolNames, modelId, createdAt };
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
      assistant("a1", "", 2000, [], "glm/glm-5.3-flash"),
      assistant("a2", "done", 3000, [], "glm/glm-5.3-flash"),
      user("u2", "q2"),
      assistant("a3", "ok", 4000, [], "codex/gpt-5.6-sol"),
    ]);
    expect(turns[0]?.modelIds).toEqual(["glm/glm-5.3-flash"]);
    expect(turns[1]?.modelIds).toEqual(["codex/gpt-5.6-sol"]);
  });

  it("keeps model ids empty when the backend reports none", () => {
    const turns = buildTurns("s1", [user("u1", "q"), assistant("a1", "done")]);
    expect(turns[0]?.modelIds).toEqual([]);
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

  it("returns no turns for an empty session", () => {
    expect(buildTurns("s1", [])).toEqual([]);
  });
});
