import { describe, expect, it } from "vitest";
import { thoughtSummary, thoughtTitle } from "../src/renderer/src/thought";

describe("thoughtTitle", () => {
  it("extracts the bolded first line (OpenAI-style reasoning summary)", () => {
    expect(thoughtTitle("**检查配置**\n\n用户想让我检查配置，先看…")).toBe("检查配置");
  });

  it("falls back to the first non-empty line, headings stripped", () => {
    expect(thoughtTitle("\n\n## 定位构建错误\n先看 tsconfig…")).toBe("定位构建错误");
    expect(thoughtTitle("构建错误可能在 tsconfig")).toBe("构建错误可能在 tsconfig");
  });

  it("truncates a long fallback line and marks the cut", () => {
    const title = thoughtTitle(`${"很".repeat(80)}长的一行思考`);
    expect(title).toHaveLength(61);
    expect(title?.endsWith("…")).toBe(true);
  });

  it("returns null while nothing legible has streamed yet", () => {
    expect(thoughtTitle("")).toBeNull();
    expect(thoughtTitle(" \n\n ")).toBeNull();
  });
});

describe("thoughtSummary", () => {
  const base = { text: "**检查配置**\n\n先看配置文件", startedAt: 1000, endedAt: null };

  it("while streaming: live title with no duration", () => {
    expect(thoughtSummary(base)).toEqual({ title: "检查配置", duration: null });
  });

  it("while streaming with no legible text yet: the Thinking label", () => {
    expect(thoughtSummary({ ...base, text: "" })).toEqual({ title: "Thinking…", duration: null });
  });

  it("after the end snapshot: Thought header with duration", () => {
    expect(thoughtSummary({ ...base, endedAt: 43000 })).toEqual({
      title: "Thought: 检查配置",
      duration: "42s",
    });
  });

  it("after the end snapshot with no legible text: bare Thought header", () => {
    expect(thoughtSummary({ ...base, text: "  ", endedAt: 4000 })).toEqual({
      title: "Thought",
      duration: "3.0s",
    });
  });

  it("missing times leave the duration off", () => {
    expect(thoughtSummary({ ...base, startedAt: null, endedAt: 43000 })).toEqual({
      title: "Thought: 检查配置",
      duration: null,
    });
  });
});
