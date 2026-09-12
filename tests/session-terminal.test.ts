import { describe, expect, it } from "vitest";
import {
  openSessionInTerminal,
  readDefaultTerminalBundleId,
  type SessionTerminalDeps,
  type SessionTerminalRequest,
  sessionBatchBody,
  sessionScriptBody,
  sessionScriptPath,
  shellQuote,
} from "../src/main/session-terminal.js";

type ExecCall = { file: string; args: string[] };

/** Recording exec: canned stdout per command, ENOENT per blacklisted binary. */
function fakeExec(options: {
  stdout?: (file: string) => string;
  missing?: string[];
  failOn?: (call: ExecCall) => boolean;
}) {
  const calls: ExecCall[] = [];
  const exec = async (file: string, args: readonly string[]) => {
    calls.push({ file, args: [...args] });
    if (options.missing?.includes(file)) {
      const error = new Error("spawn ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    if (options.failOn?.({ file, args: [...args] })) throw new Error("boom");
    return { stdout: options.stdout?.(file) ?? "", stderr: "" };
  };
  return { calls, exec };
}

/** In-memory write/chmod/exists deps; nothing touches the real filesystem. */
function recordingDeps(overrides?: Partial<SessionTerminalDeps>) {
  const files = new Map<string, string>();
  const chmods: Array<{ path: string; mode: number }> = [];
  const deps: SessionTerminalDeps = {
    write: (path, content) => void files.set(path, content),
    chmod: (path, mode) => void chmods.push({ path, mode }),
    exists: () => false,
    tempDir: () => "/tmp/awefork-test",
    userHome: () => "/Users/tester",
    defaultTerminalBundleId: async () => null,
    ...overrides,
  };
  return { files, chmods, deps };
}

const OPENCODE: SessionTerminalRequest = {
  backend: "opencode",
  sessionId: "ses_abc123",
  directory: "/Users/tester/repo",
  codexHome: null,
};

const CODEX_FOREIGN: SessionTerminalRequest = {
  backend: "codex",
  sessionId: "6f0e9b28-1111-2222-3333-444455556666",
  directory: "/Users/tester/repo",
  codexHome: "/Users/tester/.config/aweswitch/accounts/codex/cxo-peng",
};

describe("shellQuote", () => {
  it("wraps a plain path", () => {
    expect(shellQuote("/repo/path")).toBe("'/repo/path'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("/it's")).toBe("'/it'\\''s'");
  });
});

describe("sessionScriptBody", () => {
  it("runs opencode with -s in the session directory", () => {
    expect(sessionScriptBody(OPENCODE)).toBe(
      ["#!/bin/sh", "cd '/Users/tester/repo' || exit 1", "exec opencode -s 'ses_abc123'", ""].join(
        "\n",
      ),
    );
  });

  it("resumes codex and exports the owning home only for foreign homes", () => {
    const foreign = sessionScriptBody(CODEX_FOREIGN);
    expect(foreign).toContain("exec codex resume '");
    expect(foreign).toContain(
      "export CODEX_HOME='/Users/tester/.config/aweswitch/accounts/codex/cxo-peng'",
    );

    const local = sessionScriptBody({ ...CODEX_FOREIGN, codexHome: null });
    expect(local).not.toContain("CODEX_HOME");
  });

  it("forces the fallback provider after the session id", () => {
    const body = sessionScriptBody({ ...CODEX_FOREIGN, codexProviderOverride: "openai" });
    expect(body).toContain(
      "exec codex resume '6f0e9b28-1111-2222-3333-444455556666' -c model_provider=openai",
    );
  });

  it("drops a provider override that could smuggle script characters", () => {
    const body = sessionScriptBody({ ...CODEX_FOREIGN, codexProviderOverride: "x; rm -rf /" });
    expect(body).toContain("exec codex resume '6f0e9b28-1111-2222-3333-444455556666'\n");
  });
});

describe("sessionBatchBody", () => {
  it("cds with quoting and runs the TUI", () => {
    expect(sessionBatchBody(OPENCODE)).toBe(
      [
        "@echo off",
        'cd /d "/Users/tester/repo"',
        "if errorlevel 1 exit /b 1",
        "opencode -s ses_abc123",
        "",
      ].join("\r\n"),
    );
  });

  it("sets CODEX_HOME before codex resume for foreign homes", () => {
    expect(sessionBatchBody(CODEX_FOREIGN)).toContain(
      'set "CODEX_HOME=/Users/tester/.config/aweswitch/accounts/codex/cxo-peng"',
    );
    expect(sessionBatchBody(CODEX_FOREIGN)).toContain(
      "codex resume 6f0e9b28-1111-2222-3333-444455556666",
    );
  });

  it("forces the fallback provider after the session id", () => {
    expect(sessionBatchBody({ ...CODEX_FOREIGN, codexProviderOverride: "openai" })).toContain(
      "codex resume 6f0e9b28-1111-2222-3333-444455556666 -c model_provider=openai",
    );
  });
});

describe("sessionScriptPath", () => {
  it("sanitizes characters that do not belong in a filename", () => {
    expect(sessionScriptPath({ ...OPENCODE, sessionId: "we/ird id" }, "/tmp", ".command")).toBe(
      "/tmp/awefork-session-we_ird_id.command",
    );
  });
});

describe("openSessionInTerminal (darwin)", () => {
  it("writes an executable .command and opens it with plain open", async () => {
    const { calls, exec } = fakeExec({});
    const { files, chmods, deps } = recordingDeps({ exec });
    const result = await openSessionInTerminal(OPENCODE, { ...deps, platform: "darwin" });
    expect(result).toEqual({ ok: true });
    const file = "/tmp/awefork-test/awefork-session-ses_abc123.command";
    expect(files.get(file)).toBe(sessionScriptBody(OPENCODE));
    expect(chmods).toEqual([{ path: file, mode: 0o755 }]);
    expect(calls).toEqual([{ file: "open", args: [file] }]);
  });

  it("prefers Warp when it is installed and no default was registered", async () => {
    const { calls, exec } = fakeExec({});
    const { deps } = recordingDeps({
      exec,
      exists: (path) => path === "/Applications/Warp.app",
    });
    await openSessionInTerminal(OPENCODE, { ...deps, platform: "darwin" });
    expect(calls[0]?.args[0]).toBe("-a");
    expect(calls[0]?.args[1]).toBe("Warp");
  });

  it("honors the registered default-terminal bundle id first", async () => {
    const { calls, exec } = fakeExec({});
    const { deps } = recordingDeps({
      exec,
      exists: () => true,
      defaultTerminalBundleId: async () => "com.googlecode.iterm2",
    });
    await openSessionInTerminal(OPENCODE, { ...deps, platform: "darwin" });
    expect(calls).toEqual([
      {
        file: "open",
        args: [
          "-b",
          "com.googlecode.iterm2",
          "/tmp/awefork-test/awefork-session-ses_abc123.command",
        ],
      },
    ]);
  });

  it("falls back to plain open when the registered app fails to launch", async () => {
    const { calls, exec } = fakeExec({
      failOn: (call) => call.args[0] === "-b",
    });
    const { deps } = recordingDeps({
      exec,
      defaultTerminalBundleId: async () => "com.dead.app",
    });
    const result = await openSessionInTerminal(OPENCODE, { ...deps, platform: "darwin" });
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args[0]).not.toBe("-b");
  });
});

describe("openSessionInTerminal (win32)", () => {
  it("writes a .cmd file and starts cmd /k on it", async () => {
    const { calls, exec } = fakeExec({});
    const { files, chmods, deps } = recordingDeps({ exec });
    const result = await openSessionInTerminal(OPENCODE, { ...deps, platform: "win32" });
    expect(result).toEqual({ ok: true });
    const file = "/tmp/awefork-test/awefork-session-ses_abc123.cmd";
    expect(files.get(file)).toBe(sessionBatchBody(OPENCODE));
    expect(chmods).toEqual([]);
    expect(calls).toEqual([{ file: "cmd.exe", args: ["/c", "start", "", "cmd", "/k", file] }]);
  });
});

describe("openSessionInTerminal (linux)", () => {
  it("tries terminals until one exists", async () => {
    const { calls, exec } = fakeExec({ missing: ["gnome-terminal", "konsole"] });
    const { deps } = recordingDeps({ exec });
    const result = await openSessionInTerminal(OPENCODE, { ...deps, platform: "linux" });
    expect(result).toEqual({ ok: true });
    expect(calls.map((call) => call.file)).toEqual(["gnome-terminal", "konsole", "xfce4-terminal"]);
    expect(calls[2]?.args).toEqual([
      "-x",
      "bash",
      "/tmp/awefork-test/awefork-session-ses_abc123.sh",
    ]);
  });

  it("reports an error when no known terminal is installed", async () => {
    const { exec } = fakeExec({
      missing: [
        "gnome-terminal",
        "konsole",
        "xfce4-terminal",
        "kitty",
        "alacritty",
        "wezterm",
        "xterm",
      ],
    });
    const { deps } = recordingDeps({ exec });
    const result = await openSessionInTerminal(OPENCODE, { ...deps, platform: "linux" });
    expect(result.ok).toBe(false);
  });
});

describe("openSessionInTerminal (guards)", () => {
  it("refuses session ids that could smuggle script characters", async () => {
    const { deps } = recordingDeps();
    const result = await openSessionInTerminal(
      { ...OPENCODE, sessionId: "ses'; rm -rf /" },
      { ...deps, platform: "darwin" },
    );
    expect(result.ok).toBe(false);
  });

  it("refuses sessions without a working directory", async () => {
    const { deps } = recordingDeps();
    const result = await openSessionInTerminal(
      { ...OPENCODE, directory: "" },
      { ...deps, platform: "darwin" },
    );
    expect(result.ok).toBe(false);
  });

  it("wraps a failed launch as {ok:false}", async () => {
    const { exec } = fakeExec({ failOn: () => true });
    const { deps } = recordingDeps({ exec });
    const result = await openSessionInTerminal(OPENCODE, { ...deps, platform: "darwin" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("打开终端失败");
  });
});

describe("readDefaultTerminalBundleId", () => {
  const home = () => "/Users/tester";
  const securePlist =
    "/Users/tester/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist";

  it("returns the app registered for .command files", async () => {
    const { exec } = fakeExec({
      stdout: () =>
        JSON.stringify({
          LSHandlers: [
            { LSHandlerURLScheme: "zoomphonecall", LSHandlerRoleAll: "us.zoom.xos" },
            { LSHandlerContentTag: "command", LSHandlerRoleAll: "dev.warp.Warp-Stable" },
          ],
        }),
    });
    const id = await readDefaultTerminalBundleId(exec, home, () => true);
    expect(id).toBe("dev.warp.Warp-Stable");
  });

  it("matches the shell-script UTI too", async () => {
    const { exec } = fakeExec({
      stdout: () =>
        JSON.stringify({
          LSHandlers: [
            {
              LSHandlerContentType: "com.apple.terminal.shell-script",
              LSHandlerRoleAll: "com.googlecode.iterm2",
            },
          ],
        }),
    });
    const id = await readDefaultTerminalBundleId(exec, home, () => true);
    expect(id).toBe("com.googlecode.iterm2");
  });

  it("yields null when no override exists", async () => {
    const { exec } = fakeExec({ stdout: () => JSON.stringify({ LSHandlers: [] }) });
    expect(await readDefaultTerminalBundleId(exec, home, () => true)).toBeNull();
    const { exec: exec2 } = fakeExec({});
    expect(await readDefaultTerminalBundleId(exec2, home, () => false)).toBeNull();
  });
});
