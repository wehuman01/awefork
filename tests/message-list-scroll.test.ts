import { describe, expect, it } from "vitest";
import {
  isSamePaneStart,
  promptAnchorScrollTop,
  STICK_DISTANCE_PX,
  shouldFollowStream,
} from "../src/renderer/src/message-list-scroll";
import type { ReadonlyChatMessage } from "../src/renderer/src/state";

function message(id: string, role: "user" | "assistant", text: string): ReadonlyChatMessage {
  return {
    id,
    role,
    text,
    thinking: "",
    toolNames: [],
    modelId: null,
    providerId: null,
    variant: null,
    attachmentNames: [],
    createdAt: 0,
    completedAt: null,
    finish: null,
    outputTokens: null,
    error: null,
  };
}

describe("message list scroll", () => {
  it("follows streaming updates only while the reader was at the bottom", () => {
    expect(shouldFollowStream(STICK_DISTANCE_PX)).toBe(true);
    expect(shouldFollowStream(STICK_DISTANCE_PX + 1)).toBe(false);
  });

  it("keeps the reading position when a local prompt is replaced by its server row", () => {
    expect(
      isSamePaneStart(message("local_1", "user", "测试"), message("server_1", "user", "测试")),
    ).toBe(true);
  });

  it("resets the reader for an actual turn change", () => {
    expect(isSamePaneStart(message("u1", "user", "旧问题"), message("u2", "user", "新问题"))).toBe(
      false,
    );
    expect(isSamePaneStart(message("u1", "user", "问题"), message("a1", "assistant", "问题"))).toBe(
      false,
    );
  });

  it("computes the offset that pins the turn prompt to the pane top", () => {
    const containerTop = 120;
    const scrollTop = 40;
    // At this scroll the prompt renders 150px below the pane's top edge.
    const anchorTop = containerTop + 150;
    const target = promptAnchorScrollTop(containerTop, anchorTop, scrollTop);
    expect(target).toBe(190);
    // After landing, the prompt sits at the pane's top edge.
    expect(anchorTop - (target - scrollTop)).toBe(containerTop);
  });
});
