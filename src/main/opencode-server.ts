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
 * GUI apps launched from Finder get a minimal PATH (/usr/bin:/bin/...) that
 * rarely covers user-level installs (homebrew, ~/.local/bin, deskclaw).
 * Prepend every candidate dir that actually exists so `opencode` resolves.
 */
export function buildSpawnEnv(
  env: { PATH?: string; [key: string]: string | undefined },
  home: string = homedir(),
): { PATH?: string; [key: string]: string | undefined } {
  const candidates = [
    join(home, ".deskclaw", "node", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".opencode", "bin"),
  ].filter((dir) => existsSync(dir));

  const path = env.PATH ?? "";
  const existing = new Set(path.split(":").filter(Boolean));
  const extra = candidates.filter((dir) => !existing.has(dir));
  return { ...env, PATH: [...extra, ...path.split(":").filter(Boolean)].join(":") };
}

/**
 * The candidate list above can't cover versioned install dirs
 * (~/.nvm/versions/node/vX/bin). When the merged PATH still has no `opencode`,
 * ask the user's login shell for its PATH — once, best-effort, macOS only
 * (the app ships as a mac DMG; Windows/Linux launchers pass a real shell env).
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

function isOnPath(name: string, pathValue: string | undefined): boolean {
  for (const dir of (pathValue ?? "").split(":")) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      // Not in this dir.
    }
  }
  return false;
}

/** Spawn env for the opencode child, with the login-shell PATH as fallback. */
export async function resolveSpawnEnv(
  env: { PATH?: string; [key: string]: string | undefined } = process.env,
  home: string = homedir(),
  shellPathProbe: () => Promise<string | null> = loginShellPath,
): Promise<{ PATH?: string; [key: string]: string | undefined }> {
  const merged = buildSpawnEnv(env, home);
  if (isOnPath("opencode", merged.PATH)) return merged;
  const probed = await shellPathProbe();
  if (!probed) return merged;
  // Union, not replace: the spawned server also shells out to git and friends
  // that live on the original (Finder-minimal) PATH.
  return buildSpawnEnv({ ...env, PATH: [probed, env.PATH ?? ""].filter(Boolean).join(":") }, home);
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
    serverChild.kill("SIGTERM");
  }
  serverChild = null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
