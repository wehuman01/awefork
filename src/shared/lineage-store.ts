import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { ForkRecord, LineageMap } from "./types.js";

/**
 * Lineage store: a single JSON file mapping forked session ids to their
 * origin. opencode's fork API copies messages but records no parent link,
 * so awefork owns this sidecar to rebuild fork trees.
 *
 * Assumption: a single awefork instance writes to a given file. If you run
 * two, last write wins on conflict.
 */

export async function readLineage(filePath: string): Promise<LineageMap> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as LineageMap;
  } catch {
    // Corrupted sidecar is worse than an empty one: ignore it, forks just
    // lose their nesting until re-forked.
    return {};
  }
}

export async function recordFork(
  filePath: string,
  forkedSessionId: string,
  record: ForkRecord,
): Promise<void> {
  const map = await readLineage(filePath);
  map[forkedSessionId] = record;
  await fs.mkdir(dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(map, null, 2)}\n`, "utf8");
}

/** Forget a session's own fork record (its children keep theirs, pointing at
 *  a now-missing parent — readers already treat that as "root"). */
export async function removeFork(filePath: string, sessionId: string): Promise<void> {
  const map = await readLineage(filePath);
  if (!(sessionId in map)) return;
  delete map[sessionId];
  await fs.writeFile(filePath, `${JSON.stringify(map, null, 2)}\n`, "utf8");
}
