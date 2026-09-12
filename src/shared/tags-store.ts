import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { enqueueWrite } from "./write-queue.js";

/**
 * Tag store: the labels the user pinned on sessions (执行 / 实验设计 /
 * 咨询 …). A plain JSON sidecar like pins — losing it only loses the
 * curation, never session data. Shape: sessionId → tag names, ordered.
 */

export type TagMap = Record<string, string[]>;

export async function readTags(filePath: string): Promise<TagMap> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const map: TagMap = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      const tags = value.filter((t): t is string => typeof t === "string");
      if (tags.length > 0) map[id] = tags;
    }
    return map;
  } catch {
    return {};
  }
}

export async function writeTags(filePath: string, tags: TagMap): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, `${JSON.stringify(tags, null, 2)}\n`);
}

/** Replace one session's tags (empty list drops the entry); serialized per file. */
export function setSessionTags(
  filePath: string,
  sessionId: string,
  tags: string[],
): Promise<TagMap> {
  return enqueueWrite(filePath, async () => {
    const map = await readTags(filePath);
    const next: TagMap = tags.length > 0 ? { ...map, [sessionId]: tags } : { ...map };
    if (tags.length === 0) delete next[sessionId];
    await writeTags(filePath, next);
    return next;
  });
}

/** Drop a session's tags (hard delete path); returns the pruned map. */
export function pruneTags(filePath: string, sessionId: string): Promise<TagMap> {
  return enqueueWrite(filePath, async () => {
    const map = await readTags(filePath);
    if (!(sessionId in map)) return map;
    const next = { ...map };
    delete next[sessionId];
    await writeTags(filePath, next);
    return next;
  });
}
