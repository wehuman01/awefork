import { promises as fs } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import type { FileChangeEntry, FileChangeStatus, SessionFileChanges } from "./types.js";
import { enqueueWrite } from "./write-queue.js";

/**
 * Per-turn file changes: the observer-seat record of what an agent run
 * actually did to disk. Snapshots are taken the moment a tool event arrives
 * and never recomputed, so a historical diff cannot change after later edits.
 *
 * Layout per session, under
 *   <userData>/file-changes/<backend>/<sessionId>/
 *     index.json                      — entries per assistant message id
 *     <messageId>/<n>.before|.after   — content snapshots, written once
 *
 * Pure awefork overlay: the agent's own storage is never touched, and the
 * directory dies with its session. Types live in types.ts (renderer-safe);
 * this module is the node-side storage.
 */

export type { FileChangeEntry, FileChangeStatus, SessionFileChanges } from "./types.js";

export function emptySessionChanges(tools: string[]): SessionFileChanges {
  return { version: 1, tools: [...tools], messages: {} };
}

/** Index path of one session's sidecar directory. */
export function changesIndexPath(sessionDir: string): string {
  return join(sessionDir, "index.json");
}

const STATUS_VALUES: readonly FileChangeStatus[] = ["modified", "created", "deleted", "unknown"];

function sanitizeEntry(value: unknown): FileChangeEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.path !== "string" || v.path === "") return null;
  const status = STATUS_VALUES.includes(v.status as FileChangeStatus)
    ? (v.status as FileChangeStatus)
    : "unknown";
  const numberOrNull = (n: unknown): number | null =>
    typeof n === "number" && Number.isFinite(n) ? n : null;
  const blobOrNull = (n: unknown): string | null =>
    typeof n === "string" && /^\d+\.(before|after)$/.test(n) ? n : null;
  return {
    path: v.path,
    status,
    added: numberOrNull(v.added),
    removed: numberOrNull(v.removed),
    note: typeof v.note === "string" ? v.note : null,
    before: blobOrNull(v.before),
    after: blobOrNull(v.after),
  };
}

/** Read defensively: a corrupt or hand-edited index degrades to null. */
export async function readSessionChanges(sessionDir: string): Promise<SessionFileChanges | null> {
  let raw: string;
  try {
    raw = await fs.readFile(changesIndexPath(sessionDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const v = parsed as Record<string, unknown>;
    if (v.version !== 1 || typeof v.messages !== "object" || v.messages === null) {
      return null;
    }
    const tools = Array.isArray(v.tools)
      ? v.tools.filter((t): t is string => typeof t === "string")
      : [];
    const messages: SessionFileChanges["messages"] = {};
    for (const [messageId, files] of Object.entries(v.messages as Record<string, unknown>)) {
      const entries = Array.isArray(files)
        ? files.map(sanitizeEntry).filter((e): e is FileChangeEntry => e !== null)
        : [];
      if (entries.length > 0) messages[messageId] = entries;
    }
    return { version: 1, tools, messages };
  } catch {
    return null;
  }
}

/** Persist the index; serialized per file so recorder updates commit in order. */
export function writeSessionChanges(sessionDir: string, value: SessionFileChanges): Promise<void> {
  return enqueueWrite(changesIndexPath(sessionDir), async () => {
    await fs.mkdir(sessionDir, { recursive: true });
    await writeFileAtomic(changesIndexPath(sessionDir), `${JSON.stringify(value, null, 2)}\n`);
  });
}

/** Write one content snapshot blob; returns its file name relative to the dir. */
export async function writeSnapshotBlob(
  sessionDir: string,
  messageId: string,
  ordinal: number,
  kind: "before" | "after",
  content: string,
): Promise<string> {
  const name = `${ordinal}.${kind}`;
  const dir = join(sessionDir, messageId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, name), content, "utf8");
  return name;
}

/** Read one snapshot blob; null when absent or the name is malformed. */
export async function readSnapshotBlob(
  sessionDir: string,
  messageId: string,
  name: string,
): Promise<string | null> {
  if (!/^\d+\.(before|after)$/.test(name)) return null;
  try {
    return await fs.readFile(join(sessionDir, messageId, name), "utf8");
  } catch {
    return null;
  }
}

/** Remove a session's whole sidecar directory; gone with the session. */
export async function clearSessionChanges(sessionDir: string): Promise<void> {
  await enqueueWrite(changesIndexPath(sessionDir), async () => {
    await fs.rm(sessionDir, { recursive: true, force: true });
  });
}

/** Locate one entry by message id + path. */
export function findEntry(
  changes: SessionFileChanges,
  messageId: string,
  path: string,
): FileChangeEntry | null {
  return (changes.messages[messageId] ?? []).find((e) => e.path === path) ?? null;
}

/** Where the per-session directory for a backend lives under userData. */
export function sessionChangesDir(rootDir: string, sessionId: string): string {
  return join(rootDir, sessionId.replace(/[^a-zA-Z0-9_-]/g, "_"));
}
