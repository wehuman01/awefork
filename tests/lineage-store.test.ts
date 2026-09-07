import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readLineage, recordFork, removeFork } from "../src/shared/lineage-store";

async function tempLineagePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "awefork-lineage-")), "lineage.json");
}

describe("lineage store", () => {
  it("returns empty map when file does not exist", async () => {
    expect(await readLineage(await tempLineagePath())).toEqual({});
  });

  it("round-trips fork records", async () => {
    const path = await tempLineagePath();
    await recordFork(path, "fork-1", {
      parentId: "parent-1",
      atMessageId: "msg-1",
      createdAt: 1,
    });
    await recordFork(path, "fork-2", { parentId: "parent-1", atMessageId: null, createdAt: 2 });

    expect(await readLineage(path)).toEqual({
      "fork-1": { parentId: "parent-1", atMessageId: "msg-1", createdAt: 1 },
      "fork-2": { parentId: "parent-1", atMessageId: null, createdAt: 2 },
    });
  });

  it("treats corrupted files as empty", async () => {
    const path = await tempLineagePath();
    await writeFile(path, "not json at all", "utf8");
    expect(await readLineage(path)).toEqual({});
  });

  it("creates the parent directory on demand", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "awefork-lineage-")), "nested", "lineage.json");
    await recordFork(path, "f", { parentId: "p", atMessageId: null, createdAt: 0 });
    const raw = await readFile(path, "utf8");
    expect(JSON.parse(raw)).toEqual({ f: { parentId: "p", atMessageId: null, createdAt: 0 } });
  });

  it("removeFork drops only the given record", async () => {
    const path = await tempLineagePath();
    await recordFork(path, "fork-1", { parentId: "parent-1", atMessageId: "msg-1", createdAt: 1 });
    await recordFork(path, "fork-2", { parentId: "fork-1", atMessageId: null, createdAt: 2 });

    await removeFork(path, "fork-1");

    expect(await readLineage(path)).toEqual({
      // fork-2 keeps its record even though its parent is gone — readers
      // re-root sessions whose lineage parent is missing.
      "fork-2": { parentId: "fork-1", atMessageId: null, createdAt: 2 },
    });
  });

  it("removeFork on a missing record is a no-op", async () => {
    const path = await tempLineagePath();
    await expect(removeFork(path, "never-recorded")).resolves.toBeUndefined();
  });
});

describe("cleanup", () => {
  it("removes temp dirs", async () => {
    const path = await tempLineagePath();
    await recordFork(path, "x", { parentId: "p", atMessageId: null, createdAt: 0 });
    await rm(join(path, ".."), { recursive: true, force: true });
    expect(await readLineage(path)).toEqual({});
  });
});
