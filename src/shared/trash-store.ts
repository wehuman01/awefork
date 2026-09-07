import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { TrashEntry } from "./types.js";

/**
 * Trash store: sessions the user deleted whose grace window has not elapsed
 * (or that failed to flush). A plain JSON sidecar next to pins.json — it only
 * ever holds pending hard-deletes, never session data itself. The renderer
 * hides trashed sessions and flushes the queue (real deletes) on startup, so
 * entries here are always eventually executed exactly once.
 */

export async function readTrash(filePath: string): Promise<TrashEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is TrashEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as TrashEntry).id === "string" &&
        typeof (entry as TrashEntry).deletedAt === "number",
    );
  } catch {
    return [];
  }
}

export async function writeTrash(filePath: string, entries: TrashEntry[]): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}
