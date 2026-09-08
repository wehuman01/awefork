import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createOpencodeClient } from "../shared/opencode-client.js";

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
    env: buildSpawnEnv(process.env),
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
    if (child.exitCode !== null) break;
    if (await isReachable(client)) {
      return { spawned: true, baseUrl };
    }
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
