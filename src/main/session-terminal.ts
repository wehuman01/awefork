import { execFile } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BackendId } from "../shared/backend.js";

const execFileAsync = promisify(execFile);

/**
 * "Jump to this session in the agent's native TUI": write the backend's
 * resume command into a temp script, then hand it to a system terminal.
 *
 * Terminal choice follows the user, in this order (macOS):
 *   1. the app registered for `.command` files, when the user picked one
 *      (Warp/iTerm2 "set as default terminal" writes this binding);
 *   2. Warp, when installed;
 *   3. plain `open` — LaunchServices' default, Terminal.app out of the box.
 * Windows opens `cmd /k <script>`; Linux tries the common terminals in turn.
 */
export interface SessionTerminalRequest {
  backend: BackendId;
  sessionId: string;
  /** Working directory the session belongs to; the TUI must resume in it. */
  directory: string;
  /**
   * CODEX_HOME of the account that owns the session, when it lives in an
   * aweswitch per-account home — a bare `codex resume` under the default
   * home cannot see those rollouts. Null for opencode and default-home codex.
   */
  codexHome: string | null;
  /**
   * Provider to force with `-c model_provider=…` when the rollout's last
   * recorded provider no longer exists in the home's config.toml (config
   * switchers rewrite it); resume would crash at bootstrap otherwise. Null
   * when the recorded provider is still resolvable.
   */
  codexProviderOverride?: string | null;
}

export type SessionTerminalResult = { ok: true } | { ok: false; error: string };

/** Everything the launcher touches, injectable so tests run on any platform. */
export interface SessionTerminalDeps {
  platform?: NodeJS.Platform;
  exec?: typeof execFileAsync;
  exists?: (path: string) => boolean;
  write?: (path: string, content: string) => void;
  chmod?: (path: string, mode: number) => void;
  userHome?: () => string;
  tempDir?: () => string;
  /**
   * macOS: bundle id registered as the `.command` handler (the user's
   * "default terminal" choice), null when no override exists. Production
   * reads the LaunchServices plists via plutil.
   */
  defaultTerminalBundleId?: () => Promise<string | null>;
}

/** Session ids are opaque CLI tokens; anything beyond these chars never reaches a script unquoted. */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

/**
 * Provider ids are embedded raw (the batch body has no quoting); values from
 * a hand-edited config that fall outside this set are dropped, not written.
 */
const SAFE_PROVIDER_ID = /^[A-Za-z0-9_-]+$/;

/** The `-c model_provider=…` suffix a codex resume needs, or "" when none. */
function providerOverrideArg(request: SessionTerminalRequest): string {
  const id = request.codexProviderOverride ?? null;
  return id !== null && SAFE_PROVIDER_ID.test(id) ? ` -c model_provider=${id}` : "";
}

/** POSIX single-quote: the only characters a '…'-wrapped string cannot hold are quotes themselves. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** cmd.exe double-quote; "" is cmd's in-quote escape. */
function batchQuote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** The POSIX script a macOS/Linux terminal runs: cd, optional CODEX_HOME, TUI. */
export function sessionScriptBody(request: SessionTerminalRequest): string {
  const lines = ["#!/bin/sh", `cd ${shellQuote(request.directory)} || exit 1`];
  if (request.backend === "codex" && request.codexHome !== null) {
    lines.push(`export CODEX_HOME=${shellQuote(request.codexHome)}`);
  }
  lines.push(
    request.backend === "codex"
      ? `exec codex resume ${shellQuote(request.sessionId)}${providerOverrideArg(request)}`
      : `exec opencode -s ${shellQuote(request.sessionId)}`,
  );
  return `${lines.join("\n")}\n`;
}

/** The batch file a Windows terminal runs — npm's .cmd shims resolve inside cmd. */
export function sessionBatchBody(request: SessionTerminalRequest): string {
  const lines = [
    "@echo off",
    // cmd decodes batch files with the ANSI codepage (GBK on Chinese
    // Windows); the file is written UTF-8, so the console must switch before
    // the first line that can carry a non-ASCII path, or cd targets mojibake.
    // cmd re-reads each line after chcp with the new codepage.
    "@chcp 65001 >nul",
    `cd /d ${batchQuote(request.directory)}`,
    "if errorlevel 1 exit /b 1",
  ];
  if (request.backend === "codex" && request.codexHome !== null) {
    lines.push(`set "CODEX_HOME=${request.codexHome}"`);
  }
  lines.push(
    request.backend === "codex"
      ? `codex resume ${request.sessionId}${providerOverrideArg(request)}`
      : `opencode -s ${request.sessionId}`,
  );
  return `${lines.join("\r\n")}\r\n`;
}

/** Temp script path per session (.command for macOS's open, .sh/.cmd elsewhere). */
export function sessionScriptPath(
  request: SessionTerminalRequest,
  dir: string,
  ext: string,
): string {
  const safeId = request.sessionId.replaceAll(/[^A-Za-z0-9._-]/g, "_");
  return join(dir, `awefork-session-${safeId}${ext}`);
}

/** Linux terminal candidates, first whose binary exists wins; bash runs the script. */
const LINUX_LAUNCHERS: ReadonlyArray<{ bin: string; args: (file: string) => string[] }> = [
  { bin: "gnome-terminal", args: (file) => ["--", "bash", file] },
  { bin: "konsole", args: (file) => ["-e", "bash", file] },
  { bin: "xfce4-terminal", args: (file) => ["-x", "bash", file] },
  { bin: "kitty", args: (file) => ["bash", file] },
  { bin: "alacritty", args: (file) => ["-e", "bash", file] },
  { bin: "wezterm", args: (file) => ["start", "--", "bash", file] },
  { bin: "xterm", args: (file) => ["-e", "bash", file] },
];

export async function openSessionInTerminal(
  request: SessionTerminalRequest,
  deps: SessionTerminalDeps = {},
): Promise<SessionTerminalResult> {
  if (!SAFE_SESSION_ID.test(request.sessionId)) {
    return { ok: false, error: `会话 ID 含意外字符，拒绝写入终端脚本：${request.sessionId}` };
  }
  if (!request.directory) {
    return { ok: false, error: "会话没有工作目录，无法在终端中打开" };
  }
  const platform = deps.platform ?? process.platform;
  const exec = deps.exec ?? execFileAsync;
  const exists = deps.exists ?? existsSync;
  const write = deps.write ?? writeFileSync;
  const chmod = deps.chmod ?? chmodSync;
  const tempDir = deps.tempDir ?? tmpdir;
  const home = deps.userHome ?? homedir;

  try {
    if (platform === "win32") {
      const file = sessionScriptPath(request, tempDir(), ".cmd");
      write(file, sessionBatchBody(request));
      // start's first quoted arg is the window title; /k keeps the window
      // open after the TUI exits, like the macOS .command behavior.
      await exec("cmd.exe", ["/c", "start", "", "cmd", "/k", file]);
      return { ok: true };
    }

    const file = sessionScriptPath(request, tempDir(), platform === "darwin" ? ".command" : ".sh");
    write(file, sessionScriptBody(request));
    if (platform === "darwin") {
      // Terminal runs the file itself; without +x it shows an error dialog.
      chmod(file, 0o755);
      const bundleId = await (deps.defaultTerminalBundleId ?? readDefaultTerminalBundleId)(exec);
      const warpInstalled =
        exists("/Applications/Warp.app") || exists(join(home(), "Applications", "Warp.app"));
      if (bundleId !== null) {
        try {
          await exec("open", ["-b", bundleId, file]);
          return { ok: true };
        } catch {
          // A stale override (app uninstalled) falls through to the open order.
        }
      }
      if (warpInstalled) {
        try {
          await exec("open", ["-a", "Warp", file]);
          return { ok: true };
        } catch {
          // Warp present but broken: let the system default have it.
        }
      }
      await exec("open", [file]);
      return { ok: true };
    }

    for (const launcher of LINUX_LAUNCHERS) {
      try {
        await exec(launcher.bin, launcher.args(file));
        return { ok: true };
      } catch (error) {
        // ENOENT = not installed, try the next; anything else is a real failure.
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      }
    }
    return { ok: false, error: "未找到可用的终端（尝试过 gnome-terminal、konsole、kitty 等）" };
  } catch (error) {
    return {
      ok: false,
      error: `打开终端失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * The user's explicit "default terminal": LaunchServices records it as the
 * handler for the `.command` extension / shell-script UTI. Both plist domains
 * are read (secure is the current one); no override records mean null.
 */
export async function readDefaultTerminalBundleId(
  exec: typeof execFileAsync = execFileAsync,
  home: () => string = homedir,
  exists: (path: string) => boolean = existsSync,
): Promise<string | null> {
  const domains = [
    "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist",
    "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.plist",
  ];
  for (const rel of domains) {
    const path = join(home(), rel);
    if (!exists(path)) continue;
    let stdout: string;
    try {
      ({ stdout } = await exec("plutil", ["-convert", "json", "-o", "-", path]));
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(stdout) as { LSHandlers?: Array<Record<string, unknown>> };
      for (const handler of parsed.LSHandlers ?? []) {
        const tag = handler.LSHandlerContentTag;
        const uti = handler.LSHandlerContentType;
        if (
          tag !== "command" &&
          uti !== "com.apple.terminal.shell-script" &&
          uti !== "public.shell-script"
        ) {
          continue;
        }
        const app = handler.LSHandlerRoleAll ?? handler.LSHandlerRoleViewer;
        if (typeof app === "string" && app !== "") return app;
      }
    } catch {
      // Malformed JSON: the next domain may still be readable.
    }
  }
  return null;
}
