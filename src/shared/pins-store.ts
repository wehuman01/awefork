import { promises as fs } from "node:fs";
import { dirname } from "node:path";

/**
 * Pin store: the session ids the user explicitly saved to the canvas.
 * A plain JSON sidecar next to the lineage file — losing it only loses the
 * curation, never session data.
 */

export async function readPins(filePath: string): Promise<string[]> {
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
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

export async function writePins(filePath: string, pins: string[]): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(pins, null, 2)}\n`, "utf8");
}
