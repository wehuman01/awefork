import { describe, expect, it } from "vitest";
import { lineDiff } from "../src/shared/diff";

describe("lineDiff", () => {
  it("reports nothing for identical content", () => {
    const result = lineDiff("a\nb\nc", "a\nb\nc");
    expect(result).toEqual({ added: 0, removed: 0, hunks: [] });
  });

  it("counts a pure addition", () => {
    const result = lineDiff("", "one\ntwo");
    expect(result.added).toBe(2);
    expect(result.removed).toBe(0);
    expect(result.hunks).toHaveLength(1);
    const lines = result.hunks[0]?.lines ?? [];
    expect(lines.map((l) => l.type)).toEqual(["+", "+"]);
  });

  it("counts a pure removal", () => {
    const result = lineDiff("one\ntwo", "");
    expect(result.added).toBe(0);
    expect(result.removed).toBe(2);
    expect((result.hunks[0]?.lines ?? []).map((l) => l.type)).toEqual(["-", "-"]);
  });

  it("nets a modification with context rows in the hunk", () => {
    const before = "keep1\nold\nkeep2\nkeep3";
    const after = "keep1\nnew\nkeep2\nkeep3";
    const result = lineDiff(before, after);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    const hunk = result.hunks[0];
    expect(hunk?.beforeStart).toBe(1);
    expect(hunk?.afterStart).toBe(1);
    expect(hunk?.lines.map((l) => `${l.type}${l.text}`)).toEqual([
      " keep1",
      "-old",
      "+new",
      " keep2",
      " keep3",
    ]);
  });

  it("splits hunks when unchanged runs exceed the context gap", () => {
    const before = ["a", ...Array.from({ length: 12 }, (_, i) => `x${i}`), "b"].join("\n");
    const after = ["A", ...Array.from({ length: 12 }, (_, i) => `x${i}`), "B"].join("\n");
    const result = lineDiff(before, after);
    expect(result.added).toBe(2);
    expect(result.removed).toBe(2);
    expect(result.hunks).toHaveLength(2);
  });

  it("matches a moved tail through shared prefix and suffix", () => {
    const before = "head\na\nb\ntail";
    const after = "head\nb\na\ntail";
    const result = lineDiff(before, after);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
  });

  it("reports unknown instead of diffing past the LCS cap", () => {
    const big = (prefix: string): string =>
      Array.from({ length: 900 }, (_, i) => `${prefix}${i}`).join("\n");
    const result = lineDiff(big("a"), big("b"));
    expect(result.added).toBeNull();
    expect(result.removed).toBeNull();
    expect(result.hunks).toEqual([]);
  });
});
