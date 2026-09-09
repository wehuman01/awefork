import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import type {
  ArchivedDirectoryEntry,
  ArchivedSessionEntry,
  ArchiveKind,
  ArchiveState,
} from "./types.js";

/**
 * Archive store: sessions and directories the user tucked away, fully
 * recoverable. A plain JSON sidecar next to pins.json — awefork-side overlay
 * only, the sessions stay alive in the agent backend the whole time.
 */

// Frozen: this one object is handed to every caller that reads a missing or
// corrupt sidecar, which is only safe if nobody can mutate it.
export const EMPTY_ARCHIVE: ArchiveState = Object.freeze({
  sessions: Object.freeze([] as ArchivedSessionEntry[]),
  directories: Object.freeze([] as ArchivedDirectoryEntry[]),
}) as ArchiveState;

function isArchiveState(value: unknown): value is ArchiveState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<ArchiveState>;
  return (
    Array.isArray(state.sessions) &&
    Array.isArray(state.directories) &&
    state.sessions.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof entry.id === "string" &&
        typeof entry.archivedAt === "number",
    ) &&
    state.directories.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof entry.path === "string" &&
        typeof entry.archivedAt === "number",
    )
  );
}

export async function readArchive(filePath: string): Promise<ArchiveState> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_ARCHIVE;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    // A corrupted sidecar is worse than an empty one: ignore it, archived
    // items simply reappear until re-archived.
    return isArchiveState(parsed) ? parsed : EMPTY_ARCHIVE;
  } catch {
    return EMPTY_ARCHIVE;
  }
}

export async function writeArchive(filePath: string, archive: ArchiveState): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, `${JSON.stringify(archive, null, 2)}\n`);
}

/**
 * Per-sidecar write queue: setArchived is a read-modify-write and the IPC
 * surface can fire it concurrently (rapid archive clicks), so operations on
 * the same file run one after another — the later write can't read stale
 * state and drop the earlier entry.
 */
const pendingWrites = new Map<string, Promise<unknown>>();

/**
 * Archive or restore one entry (kind picks the list; key is the session id or
 * directory path). Read-modify-write, idempotent, serialized per file;
 * returns the new state.
 */
export function setArchived(
  filePath: string,
  kind: ArchiveKind,
  key: string,
  archived: boolean,
  now: number = Date.now(),
): Promise<ArchiveState> {
  const previous = (pendingWrites.get(filePath) ?? Promise.resolve()).then(
    () => undefined,
    () => undefined,
  );
  const run = previous.then(() => applySetArchived(filePath, kind, key, archived, now));
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  pendingWrites.set(filePath, tail);
  void tail.then(() => {
    if (pendingWrites.get(filePath) === tail) pendingWrites.delete(filePath);
  });
  return run;
}

async function applySetArchived(
  filePath: string,
  kind: ArchiveKind,
  key: string,
  archived: boolean,
  now: number,
): Promise<ArchiveState> {
  const archive = await readArchive(filePath);
  const next: ArchiveState =
    kind === "session"
      ? {
          ...archive,
          sessions: archived
            ? [...archive.sessions.filter((e) => e.id !== key), { id: key, archivedAt: now }]
            : archive.sessions.filter((e) => e.id !== key),
        }
      : {
          ...archive,
          directories: archived
            ? [...archive.directories.filter((e) => e.path !== key), { path: key, archivedAt: now }]
            : archive.directories.filter((e) => e.path !== key),
        };
  await writeArchive(filePath, next);
  return next;
}
