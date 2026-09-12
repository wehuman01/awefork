import { type ChildProcess, execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { app } from "electron";
import { CODEX_NOT_LOGGED_IN_MESSAGE } from "../shared/codex-adapter.js";
import { type CodexJsonRpc, createCodexJsonRpc } from "./codex-jsonrpc.js";
import { resolveSpawnEnv } from "./opencode-server.js";

const execFileAsync = promisify(execFile);

const NOT_LOGGED_IN_MESSAGE = CODEX_NOT_LOGGED_IN_MESSAGE;

export interface EnsureCodexServerResult {
  client: CodexJsonRpc;
  /** CLI version parsed from the initialize response, when it exposes one. */
  version: string | null;
  /**
   * Set when the CLI is installed but not logged in (account/read failed or
   * reported no usable account) — surfaced once so the UI can say "run codex
   * login" before the first prompt instead of after.
   */
  authMessage: string | null;
}

/**
 * Probe whether the codex CLI is on PATH without starting its server — the
 * backend switcher calls this for every candidate, on boot and on switch.
 */
export async function isCodexInstalled(
  execFn: typeof execFileAsync = execFileAsync,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  try {
    await execFn("codex", ["--version"], {
      timeout: 5000,
      env: await resolveSpawnEnv(process.env, homedir(), undefined, platform, "codex"),
      // npm's .cmd shims only run under cmd.exe — without shell the probe
      // reports every npm-installed CLI as missing on Windows (the serve
      // spawn below carries the same branch).
      ...(platform === "win32" ? { shell: true, windowsHide: true } : {}),
    });
    return true;
  } catch {
    return false;
  }
}

interface ServerSlot {
  child: ChildProcess;
  result: EnsureCodexServerResult;
  alive: boolean;
}

/** One app-server per codex home (default `~/.codex` + aweswitch accounts). */
const servers = new Map<string, ServerSlot>();
const DEFAULT_KEY = "__default__";

/**
 * Spawn `codex app-server` as a child and drive it over stdio JSON-RPC.
 * Readiness is the `initialize` handshake — there is no port to probe. The
 * npm `codex` shim spawns the real binary as a grandchild, so the child runs
 * detached in its own process group and shutdown kills the whole group
 * (mirroring the `taskkill /T` note in opencode-server.ts for Windows).
 *
 * `home` pins the server to one CODEX_HOME: sessions of aweswitch's
 * per-account homes are invisible to a server on the default home, so each
 * home gets its own child. `onExit` fires once if the child later dies; the
 * caller drops its cached adapter so the next call lazily re-spawns.
 */
export async function ensureCodexServer(
  onExit: () => void = () => {},
  spawnFn: typeof spawn = spawn,
  home?: string,
): Promise<EnsureCodexServerResult> {
  const key = home ?? DEFAULT_KEY;
  const existing = servers.get(key);
  if (existing?.alive) return existing.result;
  if (existing) stopCodexServer(key);

  const spawnEnv = await resolveSpawnEnv(
    process.env,
    homedir(),
    undefined,
    process.platform,
    "codex",
  );
  const child = spawnFn("codex", ["app-server"], {
    stdio: ["pipe", "pipe", "ignore"],
    cwd: homedir(),
    env: home ? { ...spawnEnv, CODEX_HOME: home } : spawnEnv,
    // Own process group on POSIX (see doc comment); the npm .cmd shim needs
    // cmd.exe on Windows, same as the opencode spawn.
    detached: process.platform !== "win32",
    ...(process.platform === "win32" ? { shell: true, windowsHide: true } : {}),
  });

  const slot: ServerSlot = {
    child,
    alive: true,
    result: { client: null as unknown as CodexJsonRpc, version: null, authMessage: null },
  };
  let exitNotified = false;
  const markDead = () => {
    if (!slot.alive) return;
    slot.alive = false;
    if (!exitNotified) {
      exitNotified = true;
      onExit();
    }
  };
  // A failed spawn (ENOENT — CLI not on PATH) emits "error" and never sets
  // exitCode; the handshake loop must watch this flag or it idles the deadline.
  const spawnFailure = { error: null as Error | null };
  child.on("error", (error) => {
    spawnFailure.error = error;
    markDead();
  });
  child.on("exit", markDead);
  // A request racing the child's death surfaces on stdin as an 'error' event
  // (EPIPE / ERR_STREAM_DESTROYED); with no listener that is an uncaught
  // exception. The jsonrpc layer learns of the death via stdout and settles
  // everything itself, so the event needs no handling beyond not crashing.
  child.stdin?.on?.("error", () => {});

  const client = createCodexJsonRpc(child.stdin, child.stdout, {
    onNotification: () => {},
    onDisconnect: markDead,
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (spawnFailure.error) {
      client.dispose();
      throw new Error(
        `Could not start codex app-server: ${spawnFailure.error.message}. Is the "codex" CLI on PATH? Install it with: npm install -g @openai/codex`,
      );
    }
    if (child.exitCode !== null || !slot.alive) {
      client.dispose();
      throw new Error(
        'codex app-server exited during startup. Is the "codex" CLI on PATH and healthy?',
      );
    }
    try {
      const init = await client.request<{ userAgent?: string }>(
        "initialize",
        {
          clientInfo: { name: "awefork", title: "awefork", version: clientVersion() },
        },
        5_000,
      );
      // Auth probe: a codex that never ran `codex login` fails every
      // turn/start with an auth error — better to know before the prompt.
      // Only a null account means logged out. requiresOpenaiAuth is NOT a
      // login flag: on 0.154 it mirrors the provider's "uses OpenAI auth"
      // config and comes back true alongside a perfectly valid account.
      let authMessage: string | null = null;
      try {
        const account = await client.request<{ account?: unknown; requiresOpenaiAuth?: boolean }>(
          "account/read",
          {},
          10_000,
        );
        if (!account?.account) {
          authMessage = NOT_LOGGED_IN_MESSAGE;
        }
      } catch (error) {
        authMessage = `${NOT_LOGGED_IN_MESSAGE}（${
          error instanceof Error ? error.message : String(error)
        }）`;
      }
      servers.set(key, slot);
      slot.result = {
        client,
        version: parseCliVersion(init?.userAgent),
        authMessage,
      };
      return slot.result;
    } catch (error) {
      // Handshake-level failures (timeout while the CLI warms up) retry until
      // the deadline; the spawn/exit checks above break the loop early.
      if (Date.now() > deadline) {
        client.dispose();
        markDead();
        throw new Error(
          `codex app-server did not complete its handshake: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      await sleep(500);
    }
  }
}

/** Stop one managed codex child, or every one when no home is given. */
export function stopCodexServer(home?: string): void {
  const keys = home === undefined ? [...servers.keys()] : [home ?? DEFAULT_KEY];
  for (const key of keys) {
    const current = servers.get(key);
    if (!current) continue;
    servers.delete(key);
    stopSlot(current);
  }
}

function stopSlot(current: ServerSlot): void {
  if (current.child.exitCode !== null) return;
  if (process.platform === "win32" && current.child.pid) {
    spawn("taskkill", ["/pid", String(current.child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    // Negative pid = the whole process group (npm shim + real binary).
    if (current.child.pid) process.kill(-current.child.pid, "SIGTERM");
  } catch {
    current.child.kill("SIGTERM");
  }
}

function parseCliVersion(userAgent: string | undefined | null): string | null {
  if (typeof userAgent !== "string") return null;
  return userAgent.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

/**
 * Real app version for the initialize handshake. `app` only exists inside a
 * running Electron app — tests import this module cold (same lazy pattern as
 * update-check), where the read fails soft to a placeholder.
 */
function clientVersion(): string {
  try {
    return app.getVersion();
  } catch {
    return "0.0.0";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
