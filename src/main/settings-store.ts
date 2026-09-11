import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../shared/atomic-write.js";
import { type BackendId, isBackendId } from "../shared/backend.js";

/**
 * Persisted app settings (userData/settings.json). Today this is only the
 * selected agent backend; the shape stays open so future keys have a home.
 * Corrupt or missing files read as defaults — settings must never block boot.
 */

interface Settings {
  /** Agent backend the app boots into; default "opencode". */
  backend?: unknown;
}

export async function readBackendSelection(filePath: string): Promise<BackendId> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return "opencode";
  }
  try {
    const parsed = JSON.parse(raw) as Settings;
    return isBackendId(parsed.backend) ? parsed.backend : "opencode";
  } catch {
    return "opencode";
  }
}

export async function writeBackendSelection(filePath: string, backend: BackendId): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true });
  // Read-modify-write keeps unknown future keys intact.
  let settings: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or corrupt — start over.
  }
  settings.backend = backend;
  await writeFileAtomic(filePath, `${JSON.stringify(settings, null, 2)}\n`);
}
