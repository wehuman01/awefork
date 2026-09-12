import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
 * Env names the login shell must not hand to the agent child: launcher
 * identity the app already provides, terminal cosmetics a server process has
 * no use for, and interpreter overrides that would change how the CLI itself
 * runs (a developer's NODE_OPTIONS/DYLD_* belong to their shell, not to the
 * spawned opencode/codex).
 */
const SHELL_ENV_KEEP_OUT = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
  "COLORTERM",
  "LINES",
  "COLUMNS",
  "GPG_TTY",
  "NODE_ENV",
  "NODE_OPTIONS",
  "NODE_PATH",
]);

const SHELL_ENV_KEEP_OUT_PREFIXES = ["TERM", "DYLD_", "LD_"];

function shellMayProvide(key: string): boolean {
  if (SHELL_ENV_KEEP_OUT.has(key)) return false;
  return !SHELL_ENV_KEEP_OUT_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * The interactive shell's full export set, probed once per app session.
 * Agent configs resolve credentials from the environment (opencode's
 * `{env:NAME}` provider keys), and those exports usually live in rc files
 * (~/.zshrc) that a Finder/Dock launch never sources — so the probe is what
 * makes provider auth work under a GUI launch. Best-effort, macOS only:
 * Windows GUI apps inherit the user-profile environment from the registry,
 * and the candidate dirs cover its common installs.
 */
function loginShellEnv(): Promise<Record<string, string> | null> {
  loginShellEnvPromise ??= probeLoginShellEnv();
  return loginShellEnvPromise;
}

let loginShellEnvPromise: Promise<Record<string, string> | null> | null = null;

async function probeLoginShellEnv(): Promise<Record<string, string> | null> {
  if (process.platform !== "darwin") return null;
  const shell = process.env.SHELL;
  if (!shell) return null;
  try {
    // -i: nvm and friends initialize in .zshrc, which zsh sources for
    // interactive shells only. printenv emits KEY=VALUE lines; rc noise on
    // earlier stdout lines lacks the shape and is dropped by the parser, and
    // a value with embedded newlines truncates at its first line — tokens
    // and paths never contain them.
    const { stdout } = await execFileAsync(shell, ["-ilc", "printenv"], { timeout: 3000 });
    const vars = parsePrintenv(stdout);
    return Object.keys(vars).length > 0 ? vars : null;
  } catch {
    // Broken rc files, timeout, no shell — the launcher env is used as-is.
    return null;
  }
}

function parsePrintenv(stdout: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const hit = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (hit?.[1] !== undefined) vars[hit[1]] = hit[2] ?? "";
  }
  return vars;
}

function splitPath(pathValue: string | undefined, platform: NodeJS.Platform): string[] {
  const delimiter = platform === "win32" ? ";" : ":";
  return (pathValue ?? "").split(delimiter).filter(Boolean);
}

/**
 * Spawn env for the agent child under a GUI launch. Candidate bin dirs are
 * prepended so the CLI resolves, and exports the login shell provides fill
 * every gap the launcher left (API tokens exported in rc files) without ever
 * overriding values the app itself was started with. PATH unions rather than
 * replaces: the spawned server also shells out to git and friends that live
 * on the original (Finder-minimal) PATH.
 */
export async function resolveSpawnEnv(
  env: { PATH?: string; [key: string]: string | undefined } = process.env,
  home: string = homedir(),
  shellEnvProbe: () => Promise<Record<string, string> | null> = loginShellEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<{ PATH?: string; [key: string]: string | undefined }> {
  const probed = await shellEnvProbe();
  const merged: { PATH?: string; [key: string]: string | undefined } = { ...env };
  if (probed) {
    for (const [key, value] of Object.entries(probed)) {
      if (key === "PATH" || !shellMayProvide(key) || value === "" || merged[key] !== undefined) {
        continue;
      }
      merged[key] = value;
    }
  }
  // Union the probed PATH ahead of the launcher's (versioned install dirs
  // like ~/.nvm/... aren't in the candidate list). POSIX joining is safe:
  // the probe never runs on win32.
  const path = probed?.PATH ? [probed.PATH, env.PATH ?? ""].filter(Boolean).join(":") : env.PATH;
  return path === undefined ? merged : buildSpawnEnv({ ...merged, PATH: path }, home, platform);
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
  if (await isFullyReady(client, baseUrl)) {
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
  // The loop only reaches here via deadline or child exit. One last probe
  // covers the warm-up race — a winning opencode whose /event accepted right
  // after the loop's final check — before diagnosing the failure.
  if (await isFullyReady(client, baseUrl)) {
    return { spawned: true, baseUrl };
  }
  if (await isReachable(client)) {
    throw new Error(
      `${baseUrl} is held by a server that does not behave like opencode (REST answers but the event stream does not). Free up port ${port} or start opencode on another port.`,
    );
  }
  throw new Error(
    `opencode server did not become ready on ${baseUrl}. Is the "opencode" CLI on PATH? Start it manually with: opencode serve --port ${port}`,
  );
}

async function isReachable(client: ReturnType<typeof createOpencodeClient>): Promise<boolean> {
  try {
    // Shape matters as much as status: any HTTP server can answer 200 on a
    // path it does not know, but only an opencode answers /session with a
    // sessions array — the reuse probe must not adopt a foreign server that
    // happens to hold the port.
    return Array.isArray(await client.listSessions());
  } catch {
    return false;
  }
}

/**
 * `/session` answering is not enough on its own: a cold-started opencode
 * serves REST before its event stream accepts connections, and the adapter
 * subscribes the moment we resolve — which is what produced the
 * "Event stream lost, reconnecting" toast on every cold launch. The same
 * probe gates reuse, so a port held by anything but an opencode is never
 * adopted silently.
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
