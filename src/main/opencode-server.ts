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
 */
export async function ensureOpencodeServer(port: number): Promise<EnsureServerResult> {
  const baseUrl = `http://127.0.0.1:${port}`;
  const client = createOpencodeClient(baseUrl);
  if (await isReachable(client)) {
    return { spawned: false, baseUrl };
  }

  const child = spawn("opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    stdio: "ignore",
    detached: false,
    env: buildSpawnEnv(process.env),
  });
  child.on("error", (error) => {
    console.error(`opencode serve failed to start: ${error.message}`);
  });
  registerCleanup(child);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await sleep(500);
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
