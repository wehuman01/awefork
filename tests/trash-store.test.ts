import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addTrashEntry, readTrash, removeTrashEntry, writeTrash } from "../src/shared/trash-store";

async function tempTrashPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "awefork-trash-")), "trash.json");
}

describe("trash store", () => {
  it("returns empty list when file does not exist", async () => {
    expect(await readTrash(await tempTrashPath())).toEqual([]);
  });

  it("treats corrupted files as empty", async () => {
    const path = await tempTrashPath();
    await writeFile(path, "not json at all", "utf8");
    expect(await readTrash(path)).toEqual([]);
  });

  it("addTrashEntry queues a pending delete; removeTrashEntry drops it", async () => {
    const path = await tempTrashPath();
    await expect(addTrashEntry(path, "ses_1", "Title", 10)).resolves.toEqual([
      { id: "ses_1", title: "Title", deletedAt: 10 },
    ]);
    await expect(removeTrashEntry(path, "ses_1")).resolves.toEqual([]);
    expect(await readTrash(path)).toEqual([]);
  });

  it("re-adding the same session replaces its entry", async () => {
    const path = await tempTrashPath();
    await addTrashEntry(path, "ses_1", "Old", 1);
    await addTrashEntry(path, "ses_1", "New", 2);
    expect(await readTrash(path)).toEqual([{ id: "ses_1", title: "New", deletedAt: 2 }]);
  });

  it("serializes concurrent add and remove so neither entry is lost", async () => {
    const path = await tempTrashPath();
    // Without serialization both reads see the empty file and the remove's
    // write can resurrect (or drop) the add's entry depending on ordering.
    await Promise.all([
      addTrashEntry(path, "ses_1", "One", 1),
      addTrashEntry(path, "ses_2", "Two", 2),
    ]);
    expect(await readTrash(path)).toEqual([
      { id: "ses_1", title: "One", deletedAt: 1 },
      { id: "ses_2", title: "Two", deletedAt: 2 },
    ]);
  });
});

describe("cleanup", () => {
  it("removes temp dirs", async () => {
    const path = await tempTrashPath();
    await writeTrash(path, []);
    await rm(join(path, ".."), { recursive: true, force: true });
    expect(await readTrash(path)).toEqual([]);
  });
});
