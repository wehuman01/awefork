import { describe, expect, it } from "vitest";
import { isNewerVersion, normalizeVersion } from "../src/main/update-check";

describe("normalizeVersion", () => {
  it("keeps a plain x.y.z version", () => {
    expect(normalizeVersion("0.1.7")).toBe("0.1.7");
    expect(normalizeVersion("1.2.3")).toBe("1.2.3");
    expect(normalizeVersion("10.20.300")).toBe("10.20.300");
  });

  it("strips a leading v from tags", () => {
    expect(normalizeVersion("v0.1.7")).toBe("0.1.7");
    expect(normalizeVersion("v1.2.3")).toBe("1.2.3");
  });

  it("rejects malformed versions", () => {
    expect(normalizeVersion("0.1")).toBeNull();
    expect(normalizeVersion("0.1.6.1")).toBeNull();
    expect(normalizeVersion("0.1.7-beta")).toBeNull();
    expect(normalizeVersion("abc")).toBeNull();
    expect(normalizeVersion("")).toBeNull();
    expect(normalizeVersion("v")).toBeNull();
  });

  it("rejects non-string input", () => {
    expect(normalizeVersion(null)).toBeNull();
    expect(normalizeVersion(undefined)).toBeNull();
  });
});

describe("isNewerVersion", () => {
  it("is true when the candidate advances the major version", () => {
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
  });

  it("is true when the candidate advances the minor version", () => {
    expect(isNewerVersion("0.2.0", "0.1.9")).toBe(true);
  });

  it("is true when the candidate advances the patch version", () => {
    expect(isNewerVersion("0.1.8", "0.1.7")).toBe(true);
  });

  it("is false when candidate equals current", () => {
    expect(isNewerVersion("0.1.7", "0.1.7")).toBe(false);
  });

  it("is false when candidate is older than current", () => {
    expect(isNewerVersion("0.1.6", "0.1.7")).toBe(false);
  });

  it("tolerates the v prefix on either side", () => {
    expect(isNewerVersion("v0.1.8", "0.1.7")).toBe(true);
    expect(isNewerVersion("0.1.8", "v0.1.7")).toBe(true);
    expect(isNewerVersion("v0.1.7", "v0.1.8")).toBe(false);
  });

  it("returns false when either side is malformed", () => {
    expect(isNewerVersion("0.1", "0.1.7")).toBe(false);
    expect(isNewerVersion("0.1.6.1", "0.1.7")).toBe(false);
    expect(isNewerVersion("0.1.7-beta", "0.1.7")).toBe(false);
    expect(isNewerVersion("abc", "0.1.7")).toBe(false);
    expect(isNewerVersion("", "0.1.7")).toBe(false);
    expect(isNewerVersion("0.1.8", "0.1")).toBe(false);
    expect(isNewerVersion("0.1.8", "0.1.6.1")).toBe(false);
    expect(isNewerVersion("0.1.8", "0.1.7-beta")).toBe(false);
  });

  it("returns false when either side is null", () => {
    expect(isNewerVersion(null as unknown as string, "0.1.7")).toBe(false);
    expect(isNewerVersion("0.1.8", null as unknown as string)).toBe(false);
  });
});
