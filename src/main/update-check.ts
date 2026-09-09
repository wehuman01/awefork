import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app, shell } from "electron";
import { writeFileAtomic } from "../shared/atomic-write.js";
import type { CheckUpdatesResult } from "../shared/awefork-api.js";

/**
 * "Check for a newer release" lives in the main process: the renderer never
 * sees the GitHub API nor builds release URLs itself. Every entry point here
 * fails soft — a network hiccup or a corrupt sidecar surfaces as "no update",
 * never as a thrown IPC rejection.
 */

export const RELEASES_API_URL = "https://api.github.com/repos/wehuman01/awefork/releases/latest";

/** skips: `v0.1.7` -> `0.1.7`; anything shorter, longer or non-numeric -> null. */
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;

export function normalizeVersion(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const match = VERSION_PATTERN.exec(raw);
  if (!match) return null;
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return `${major}.${minor}.${patch}`;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const normalizedCandidate = normalizeVersion(candidate);
  const normalizedCurrent = normalizeVersion(current);
  if (!normalizedCandidate || !normalizedCurrent) return false;
  const parts = (version: string): [number, number, number] => {
    const [major, minor, patch] = version.split(".") as [string, string, string];
    return [Number(major), Number(minor), Number(patch)];
  };
  const [candidateMajor, candidateMinor, candidatePatch] = parts(normalizedCandidate);
  const [currentMajor, currentMinor, currentPatch] = parts(normalizedCurrent);
  return (
    candidateMajor > currentMajor ||
    (candidateMajor === currentMajor &&
      (candidateMinor > currentMinor ||
        (candidateMinor === currentMinor && candidatePatch > currentPatch)))
  );
}

/** Best-effort latest release fetch; every failure path returns null. */
export async function fetchLatestVersion(): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(RELEASES_API_URL, {
      headers: { "User-Agent": "awefork" },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    const release = (await response.json()) as { tag_name?: unknown };
    if (typeof release.tag_name !== "string") return null;
    return normalizeVersion(release.tag_name);
  } catch {
    return null;
  }
}

/**
 * Sidecar storing the version the user chose to stop being nagged about.
 * `app.getPath` is called lazily inside the function — the module stays
 * importable (and testable) outside a running Electron app.
 */
const UPDATE_FILE_NAME = "update.json";

function updateFilePath(): string {
  return join(app.getPath("userData"), UPDATE_FILE_NAME);
}

export async function readSkippedVersion(filePath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const value = (parsed as { skippedVersion?: unknown }).skippedVersion;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

export async function writeSkippedVersion(filePath: string, version: string | null): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, `${JSON.stringify({ skippedVersion: version }, null, 2)}\n`);
}

export async function checkForUpdates(respectSkip: boolean): Promise<CheckUpdatesResult> {
  try {
    const currentVersion = app.getVersion();
    const latest = await fetchLatestVersion();
    const skippedVersion = await readSkippedVersion(updateFilePath());
    const updateAvailable =
      latest !== null &&
      isNewerVersion(latest, currentVersion) &&
      (!respectSkip || latest !== skippedVersion);
    return { currentVersion, latest, updateAvailable };
  } catch {
    return { currentVersion: app.getVersion(), latest: null, updateAvailable: false };
  }
}

export async function skipUpdate(version: string): Promise<{ ok: boolean; error?: string }> {
  const normalized = normalizeVersion(version);
  if (!normalized) return { ok: false, error: "invalid version" };
  try {
    await writeSkippedVersion(updateFilePath(), normalized);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Only ever opens a release page URL built here — never a renderer-supplied URL. */
export async function openRelease(version: string): Promise<{ ok: boolean; error?: string }> {
  const normalized = normalizeVersion(version);
  if (!normalized) return { ok: false, error: "invalid version" };
  try {
    await shell.openExternal(`https://github.com/wehuman01/awefork/releases/tag/v${normalized}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
