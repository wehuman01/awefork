import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMPTY_ARCHIVE, readArchive, setArchived, writeArchive } from "../src/shared/archive-store";

async function tempArchivePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "awefork-archive-")), "archive.json");
}

describe("archive store", () => {
  it("returns empty state when file does not exist", async () => {
    expect(await readArchive(await tempArchivePath())).toEqual({ sessions: [], directories: [] });
  });

  it("round-trips sessions and directories", async () => {
    const path = await tempArchivePath();
    await setArchived(path, "session", "ses_1", true, 1);
    await setArchived(path, "directory", "/repo", true, 2);

    expect(await readArchive(path)).toEqual({
      sessions: [{ id: "ses_1", archivedAt: 1 }],
      directories: [{ path: "/repo", archivedAt: 2 }],
    });
  });

  it("keeps the other list untouched when one changes", async () => {
    const path = await tempArchivePath();
    await setArchived(path, "session", "ses_1", true, 1);
    await setArchived(path, "directory", "/repo", true, 2);

    await setArchived(path, "session", "ses_1", false);

    expect(await readArchive(path)).toEqual({
      sessions: [],
      directories: [{ path: "/repo", archivedAt: 2 }],
    });
  });

  it("re-archiving updates the timestamp instead of duplicating", async () => {
    const path = await tempArchivePath();
    await setArchived(path, "session", "ses_1", true, 1);
    await setArchived(path, "session", "ses_1", true, 9);

    expect(await readArchive(path)).toEqual({
      sessions: [{ id: "ses_1", archivedAt: 9 }],
      directories: [],
    });
  });

  it("restoring an unarchived entry is a no-op", async () => {
    const path = await tempArchivePath();
    await expect(setArchived(path, "session", "never-there", false)).resolves.toEqual({
      sessions: [],
      directories: [],
    });
    expect(await readArchive(path)).toEqual({ sessions: [], directories: [] });
  });

  it("treats corrupted files as empty", async () => {
    const path = await tempArchivePath();
    await writeFile(path, "not json at all", "utf8");
    expect(await readArchive(path)).toEqual({ sessions: [], directories: [] });
  });

  it("rejects structurally wrong content as empty", async () => {
    const path = await tempArchivePath();
    await writeFile(path, JSON.stringify({ sessions: "nope", directories: [] }), "utf8");
    expect(await readArchive(path)).toEqual({ sessions: [], directories: [] });
  });

  it("creates the parent directory on demand", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "awefork-archive-")), "nested", "archive.json");
    await writeArchive(path, { sessions: [], directories: [] });
    const raw = await readFile(path, "utf8");
    expect(JSON.parse(raw)).toEqual({ sessions: [], directories: [] });
  });

  it("serializes concurrent updates so neither entry is lost", async () => {
    const path = await tempArchivePath();
    // Fired without awaiting in between — without serialization both reads
    // see the empty file and the second write drops the first entry.
    await Promise.all([
      setArchived(path, "session", "ses_1", true, 1),
      setArchived(path, "session", "ses_2", true, 2),
      setArchived(path, "directory", "/repo", true, 3),
    ]);
    expect(await readArchive(path)).toEqual({
      sessions: [
        { id: "ses_1", archivedAt: 1 },
        { id: "ses_2", archivedAt: 2 },
      ],
      directories: [{ path: "/repo", archivedAt: 3 }],
    });
  });

  it("hands out the shared empty sentinel frozen", async () => {
    expect(Object.isFrozen(EMPTY_ARCHIVE)).toBe(true);
    expect(Object.isFrozen(EMPTY_ARCHIVE.sessions)).toBe(true);
    expect(Object.isFrozen(EMPTY_ARCHIVE.directories)).toBe(true);
    // The missing-file path returns that same sentinel, not a fresh object.
    expect(await readArchive(await tempArchivePath())).toBe(EMPTY_ARCHIVE);
  });
});

describe("cleanup", () => {
  it("removes temp dirs", async () => {
    const path = await tempArchivePath();
    await setArchived(path, "session", "x", true, 0);
    await rm(join(path, ".."), { recursive: true, force: true });
    expect(await readArchive(path)).toEqual({ sessions: [], directories: [] });
  });
});
