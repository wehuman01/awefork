import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { archiveOldBuilds, planArchive } from "../scripts/archive-dist.mjs";

const DIST_SNAPSHOT = [
  ".icon-ico", // directory in real dist, ignored by name matching
  "awefork-0.1.5-arm64.dmg",
  "awefork-0.1.5-arm64.dmg.blockmap",
  "awefork-0.1.6-arm64.dmg",
  "awefork-0.1.8-arm64.dmg",
  "awefork-0.1.8-arm64.dmg.blockmap",
  "awefork-0.1.8-x64-setup.exe",
  "awefork-0.1.8-x64-setup.exe.blockmap",
  "builder-debug.yml",
  "latest-mac.yml",
  "latest.yml",
];

describe("planArchive", () => {
  it("plans old installers and their blockmaps into versioned archive dirs", () => {
    const moves = planArchive(DIST_SNAPSHOT, "awefork", "0.1.8");

    expect(moves).toEqual([
      { file: "awefork-0.1.5-arm64.dmg", version: "0.1.5" },
      { file: "awefork-0.1.5-arm64.dmg.blockmap", version: "0.1.5" },
      { file: "awefork-0.1.6-arm64.dmg", version: "0.1.6" },
    ]);
  });

  it("keeps the current version and unversioned builder files in dist/", () => {
    const moved = new Set(planArchive(DIST_SNAPSHOT, "awefork", "0.1.8").map((m) => m.file));
    expect(moved.has("awefork-0.1.8-x64-setup.exe")).toBe(false);
    expect(moved.has("awefork-0.1.8-arm64.dmg.blockmap")).toBe(false);
    expect(moved.has("latest-mac.yml")).toBe(false);
    expect(moved.has("builder-debug.yml")).toBe(false);
  });

  it("archives pre-release builds under their core version, but keeps them while current", () => {
    expect(planArchive(["awefork-0.2.0-beta.1-arm64.dmg"], "awefork", "0.1.8")).toEqual([
      { file: "awefork-0.2.0-beta.1-arm64.dmg", version: "0.2.0" },
    ]);
    expect(planArchive(["awefork-0.2.0-beta.1-arm64.dmg"], "awefork", "0.2.0-beta.1")).toEqual([]);
  });
});

describe("archiveOldBuilds", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function makeDist(files: string[]): Promise<string> {
    const distDir = await mkdtemp(path.join(tmpdir(), "awefork-dist-"));
    tempDirs.push(distDir);
    await Promise.all(files.map((file) => writeFile(path.join(distDir, file), "placeholder")));
    return distDir;
  }

  it("moves old installers on disk and leaves everything else untouched", async () => {
    const distDir = await makeDist(DIST_SNAPSHOT);

    const moves = await archiveOldBuilds(distDir, DIST_SNAPSHOT, "awefork", "0.1.8");

    expect(moves).toHaveLength(3);
    await expect(readdir(path.join(distDir, "archive", "0.1.5"))).resolves.toEqual([
      "awefork-0.1.5-arm64.dmg",
      "awefork-0.1.5-arm64.dmg.blockmap",
    ]);
    await expect(readdir(path.join(distDir, "archive", "0.1.6"))).resolves.toEqual([
      "awefork-0.1.6-arm64.dmg",
    ]);
    const remaining = (await readdir(distDir)).filter((name) => name !== "archive");
    expect(remaining).toEqual([
      ".icon-ico",
      "awefork-0.1.8-arm64.dmg",
      "awefork-0.1.8-arm64.dmg.blockmap",
      "awefork-0.1.8-x64-setup.exe",
      "awefork-0.1.8-x64-setup.exe.blockmap",
      "builder-debug.yml",
      "latest-mac.yml",
      "latest.yml",
    ]);
  });

  it("replaces an already-archived file when the same old version is rebuilt", async () => {
    const distDir = await makeDist(["awefork-0.1.5-arm64.dmg"]);
    await mkdir(path.join(distDir, "archive", "0.1.5"), { recursive: true });
    await writeFile(path.join(distDir, "archive", "0.1.5", "awefork-0.1.5-arm64.dmg"), "stale");

    await archiveOldBuilds(distDir, ["awefork-0.1.5-arm64.dmg"], "awefork", "0.1.8");

    await expect(readdir(path.join(distDir, "archive", "0.1.5"))).resolves.toEqual([
      "awefork-0.1.5-arm64.dmg",
    ]);
    await expect(readdir(distDir)).resolves.toEqual(["archive"]);
  });
});
