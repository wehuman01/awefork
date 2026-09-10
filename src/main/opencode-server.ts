import { type ChildProcess, execFile, spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createOpencodeClient } from "../shared/opencode-client.js";

const execFileAsync = promisify(execFile);

export interface EnsureServerResult {
  /** true if awefork started the server itself (and owns its lifetime). */
  spawned: boolean;
  baseUrl: string;
}

/**
 * GUI apps launched from Finder/Explorer get a minimal PATH that rarely covers
 * user-level installs (homebrew, ~/.local/bin, npm shims, winget links).
 * Prepend every candidate dir that actually exists so `opencode` resolves.
 * `platform` is injectable so POSIX behavior stays testable on Windows CI
 * (and vice versa); the PATH delimiter follows it, not the host OS.
 */
export function buildSpawnEnv(
  env: { PATH?: string; [key: string]: string | undefined },
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): { PATH?: string; [key: string]: string | undefined } {
  const delimiter = platform === "win32" ? ";" : ":";
  const candidates = candidateBinDirs(env, home, platform).filter((dir) => existsSync(dir));

  const entries = splitPath(env.PATH, platform);
  const existing = new Set(entries);
  const extra = candidates.filter((dir) => !existing.has(dir));
  return { ...env, PATH: [...extra, ...entries].join(delimiter) };
}

function candidateBinDirs(
  env: { PATH?: string; [key: string]: string | undefined },
  home: string,
  platform: NodeJS.Platform,
): string[] {
  if (platform === "win32") {
    // %APPDATA%/%LOCALAPPDATA% fall back to their default locations so the
    // paths still resolve when the launcher environment omits them.
    const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
    const localAppData = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return [
      join(home, ".opencode", "bin"),
      join(home, ".local", "bin"),
      join(appData, "npm"),
      join(localAppData, "Microsoft", "WinGet", "Links"),
      // scoop is one of opencode's documented Windows install methods; its
      // shims live in the user profile, not on the system PATH Explorer passes.
      join(home, "scoop", "shims"),
    ];
  }
  return [
    join(home, ".deskclaw", "node", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".opencode", "bin"),
  ];
}

/**
 * The candidate list above can't cover versioned install dirs
 * (~/.nvm/versions/node/vX/bin). When the merged PATH still has no `opencode`,
 * ask the user's login shell for its PATH — once, best-effort, macOS only
 * (Windows has no equivalent; its candidate dirs cover the common installs).
 */
async function loginShellPath(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const shell = process.env.SHELL;
  if (!shell) return null;
  try {
    // -i: nvm and friends initialize in .zshrc, which zsh sources for
    // interactive shells only. PATH can't contain newlines, so rc noise on
    // earlier stdout lines is discarded by taking the last non-empty line.
    const { stdout } = await execFileAsync(shell, ["-ilc", "echo $PATH"], { timeout: 3000 });
    const probed = stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
    return probed.includes("/") ? probed : null;
  } catch {
    // Broken rc files, timeout, no shell — fall back to the merged PATH.
    return null;
  }
}

function splitPath(pathValue: string | undefined, platform: NodeJS.Platform): string[] {
  const delimiter = platform === "win32" ? ";" : ":";
  return (pathValue ?? "").split(delimiter).filter(Boolean);
}

function dirHasBinary(dir: string, name: string): boolean {
  try {
    accessSync(join(dir, name), constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Spawn env for the opencode child, with the login-shell PATH as fallback. */
export async function resolveSpawnEnv(
  env: { PATH?: string; [key: string]: string | undefined } = process.env,
  home: string = homedir(),
  shellPathProbe: () => Promise<string | null> = loginShellPath,
  platform: NodeJS.Platform = process.platform,
): Promise<{ PATH?: string; [key: string]: string | undefined }> {
  const merged = buildSpawnEnv(env, home, platform);
  // Check the sources, not the merged PATH string: re-splitting it with ':'
  // would shred Windows drive-letter paths when POSIX behavior is emulated
  // (tests) — and the probe below is darwin-only in production anyway.
  const dirs = [...splitPath(env.PATH, platform), ...candidateBinDirs(env, home, platform)];
  if (dirs.some((dir) => dirHasBinary(dir, "opencode"))) return merged;
  const probed = await shellPathProbe();
  if (!probed) return merged;
  // Union, not replace: the spawned server also shells out to git and friends
  // that live on the original (Finder-minimal) PATH.
  return buildSpawnEnv(
    { ...env, PATH: [probed, env.PATH ?? ""].filter(Boolean).join(":") },
    home,
    platform,
  );
}

/**
 * Reuse a running `opencode serve` on the port when possible; otherwise
 * spawn one as a child of this app and keep it alive until quit.
 * `spawnFn` is injectable for tests.
 */
export async function ensureOpencodeServer(
  port: number,
  spawnFn: typeof spawn = spawn,
): Promise<EnsureServerResult> {
  const baseUrl = `http://127.0.0.1:${port}`;
  const client = createOpencodeClient(baseUrl);
  if (await isReachable(client)) {
    return { spawned: false, baseUrl };
  }

  const child = spawnFn("opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    stdio: "ignore",
    detached: false,
    cwd: homedir(),
    env: await resolveSpawnEnv(),
    // npm installs CLIs as .cmd shims on Windows; only cmd.exe runs those,
    // plain spawn gets ENOENT. The fixed args contain no shell metacharacters.
    ...(process.platform === "win32" ? { shell: true, windowsHide: true } : {}),
  });
  // A failed spawn (ENOENT — CLI not on PATH) emits "error" and NEVER sets
  // exitCode, so the loop must watch this flag or it idles the full 30 s.
  // Held on an object: a plain let gets narrowed to its initializer because
  // the assignment lives in a callback TypeScript's flow analysis never runs.
  const spawnFailure = { error: null as Error | null };
  child.on("error", (error) => {
    spawnFailure.error = error;
  });
  registerCleanup(child);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await sleep(500);
    const spawnError = spawnFailure.error;
    if (spawnError) {
      throw new Error(
        `Could not start opencode serve: ${spawnError.message}. Is the "opencode" CLI on PATH? Install it, or start it manually with: opencode serve --port ${port}`,
      );
    }
    // Reachability wins over exit: a child that lost a port race to another
    // opencode instance still leaves a working server behind.
    if (await isFullyReady(client, baseUrl)) {
      return { spawned: true, baseUrl };
    }
    if (child.exitCode !== null) break;
  }
  throw new Error(
    `opencode server did not become ready on ${baseUrl}. Is the "opencode" CLI on PATH? Start it manually with: opencode serve --port ${port}`,
  );
}

async function isReachable(client: ReturnType<typeof createOpencodeClient>): Promise<boolean> {
  try {
    await client.listSessions();
    return true;
  } catch {
    return false;
  }
}

/**
 * `/session` answering is not enough on its own: a cold-started opencode
 * serves REST before its event stream accepts connections, and the adapter
 * subscribes the moment we resolve — which is what produced the
 * "Event stream lost, reconnecting" toast on every cold launch.
 */
async function isFullyReady(
  client: ReturnType<typeof createOpencodeClient>,
  baseUrl: string,
): Promise<boolean> {
  if (!(await isReachable(client))) return false;
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/event`, {
      signal: AbortSignal.timeout(2000),
    });
    // SSE keeps the connection open; the response headers alone prove the
    // endpoint is accepting streams, so release the socket right away.
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

let serverChild: ChildProcess | null = null;

function registerCleanup(child: ChildProcess) {
  serverChild = child;
}

export function stopManagedServer(): void {
  if (serverChild && serverChild.exitCode === null) {
    // On win32 the child is cmd.exe (shell:true for .cmd shims) and the real
    // server is its grandchild — a bare kill() would orphan it and leave the
    // port bound. taskkill /T takes down the whole tree.
    if (process.platform === "win32" && serverChild.pid) {
      spawn("taskkill", ["/pid", String(serverChild.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      serverChild.kill("SIGTERM");
    }
  }
  serverChild = null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
