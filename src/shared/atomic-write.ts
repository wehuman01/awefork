import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";

/**
 * Write-then-rename, so a crash mid-write can never leave a truncated JSON
 * sidecar behind: readers of a half-written file would silently fall back to
 * empty and lose the data (pins, lineage). rename() replaces the destination
 * atomically on POSIX and Windows; the random suffix keeps concurrent
 * writers from sharing a temp file.
 */
export async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  const temp = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temp, contents, "utf8");
    await fs.rename(temp, filePath);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
