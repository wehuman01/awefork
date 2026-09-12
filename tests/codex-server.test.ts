import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureCodexServer, isCodexInstalled, stopCodexServer } from "../src/main/codex-server.js";

/**
 * In-memory `codex app-server`: stdin is parsed as JSON-RPC requests, each
 * method answered from a script (result, or {__error__} for an error reply),
 * responses pushed back out on stdout.
 */
function fakeCodexChild(script: Record<string, unknown>): ChildProcess {
  const stdout = new EventEmitter();
  const stdin = {
    write(chunk: string): boolean {
      const request = JSON.parse(chunk) as { id: number; method: string };
      const scripted = script[request.method];
      const frame =
        scripted && typeof scripted === "object" && "__error__" in scripted
          ? { id: request.id, error: { code: -32000, message: String(scripted.__error__) } }
          : { id: request.id, result: scripted ?? null };
      queueMicrotask(() => {
        stdout.emit("data", `${JSON.stringify(frame)}\n`);
      });
      return true;
    },
  };
  const child = new EventEmitter() as unknown as ChildProcess;
  child.stdin = stdin;
  child.stdout = stdout;
  // No pid: stopCodexServer's process-group kill must stay a no-op in tests.
  child.pid = undefined;
  child.exitCode = null;
  child.kill = () => true;
  return child;
}

function spawnFnReturning(child: ChildProcess): typeof spawn {
  return (() => child) as unknown as typeof spawn;
}

afterEach(() => {
  // Drop the module-level slot so the next test spawns its own fake.
  stopCodexServer();
});

describe("ensureCodexServer per-home slots", () => {
  const baseScript = { initialize: { userAgent: "codex/0.154.0" } };

  it("pins the child to one CODEX_HOME when a home is given", async () => {
    const seen: Array<string | undefined> = [];
    const child = fakeCodexChild(baseScript);
    const spawnFn = ((_cmd: string, _args: string[], options: { env?: Record<string, string> }) => {
      seen.push(options.env?.CODEX_HOME);
      return child;
    }) as unknown as typeof spawn;
    await ensureCodexServer(() => {}, spawnFn, "/homes/cxo-heck");
    await ensureCodexServer(() => {}, spawnFn); // default home: inherit env
    expect(seen).toEqual(["/homes/cxo-heck", undefined]);
  });

  it("keeps one slot per home instead of reusing across homes", async () => {
    let spawns = 0;
    const child = fakeCodexChild(baseScript);
    const spawnFn = (() => {
      spawns += 1;
      return child;
    }) as unknown as typeof spawn;
    await ensureCodexServer(() => {}, spawnFn, "/homes/a");
    await ensureCodexServer(() => {}, spawnFn, "/homes/b");
    await ensureCodexServer(() => {}, spawnFn, "/homes/a"); // cached per home
    expect(spawns).toBe(2);
  });

  it("kills the child when the handshake deadline passes (no orphan app-server)", async () => {
    // Regression: the deadline path used to dispose the client and throw
    // without killing the child — and the never-registered slot meant
    // stopCodexServer would not come for it either, so a detached
    // app-server outlived the app and piled up on repeated failures.
    const child = fakeCodexChild({ initialize: { __error__: "stuck warming up" } });
    child.pid = 4321;
    const kills: unknown[][] = [];
    const killSpy = vi.spyOn(process, "kill").mockImplementation((...args: unknown[]) => {
      kills.push(args);
      return true;
    });
    let exits = 0;
    try {
      await expect(
        ensureCodexServer(
          () => {
            exits += 1;
          },
          spawnFnReturning(child),
          undefined,
          40,
        ),
      ).rejects.toThrow("did not complete its handshake");
    } finally {
      killSpy.mockRestore();
    }
    expect(kills).toEqual([[-4321, "SIGTERM"]]);
    expect(exits).toBe(1);
  });
});

describe("ensureCodexServer auth probe", () => {
  const baseScript = { initialize: { userAgent: "codex/0.154.0" } };

  it("reports no auth message when account/read returns a usable account", async () => {
    const child = fakeCodexChild({
      ...baseScript,
      "account/read": {
        account: { type: "chatgpt", email: "dev@example.com", planType: "pro" },
        requiresOpenaiAuth: false,
      },
    });
    const result = await ensureCodexServer(() => {}, spawnFnReturning(child));
    expect(result.authMessage).toBeNull();
    expect(result.version).toBe("0.154.0");
  });

  it("flags account: null as not logged in even though account/read succeeded", async () => {
    // Regression: 0.154 answers account/read successfully while reporting no
    // account (fresh install / logged out) — the old probe only caught a
    // failing call and let the first prompt hit the auth error instead.
    const child = fakeCodexChild({
      ...baseScript,
      "account/read": { account: null, requiresOpenaiAuth: false },
    });
    const result = await ensureCodexServer(() => {}, spawnFnReturning(child));
    expect(result.authMessage).toMatch(/codex login/);
    // A successful probe carries no error detail suffix.
    expect(result.authMessage).not.toMatch(/（/);
  });

  it("flags a missing account as not logged in even with requiresOpenaiAuth set", async () => {
    const child = fakeCodexChild({
      ...baseScript,
      "account/read": { requiresOpenaiAuth: true },
    });
    const result = await ensureCodexServer(() => {}, spawnFnReturning(child));
    expect(result.authMessage).toMatch(/codex login/);
  });

  it("treats requiresOpenaiAuth: true alongside an account as logged in", async () => {
    // Regression: codex 0.154's account/read returns the flag true with a
    // valid ChatGPT account — it is the provider's auth-mode config, not a
    // login status, and reading it as "logged out" banned every session.
    const child = fakeCodexChild({
      ...baseScript,
      "account/read": {
        account: { type: "chatgpt", email: "dev@example.com", planType: "plus" },
        requiresOpenaiAuth: true,
      },
    });
    const result = await ensureCodexServer(() => {}, spawnFnReturning(child));
    expect(result.authMessage).toBeNull();
  });

  it("keeps flagging a failing account/read with the error detail", async () => {
    const child = fakeCodexChild({
      ...baseScript,
      "account/read": { __error__: "no auth credentials" },
    });
    const result = await ensureCodexServer(() => {}, spawnFnReturning(child));
    expect(result.authMessage).toMatch(/codex login（no auth credentials）/);
  });
});

describe("isCodexInstalled platform handling", () => {
  /** Fake exec capturing the options each probe call was launched with. */
  function probeRecorder(): {
    options: Array<Record<string, unknown> | undefined>;
    exec: Parameters<typeof isCodexInstalled>[0];
  } {
    const options: Array<Record<string, unknown> | undefined> = [];
    const exec = (async (
      _file: string,
      _args: readonly string[],
      opts?: Record<string, unknown>,
    ) => {
      options.push(opts);
      return { stdout: "codex 0.154.0\n", stderr: "" };
    }) as unknown as Parameters<typeof isCodexInstalled>[0];
    return { options, exec };
  }

  it("shells out and passes a PATH-repaired env on win32 (npm .cmd shims)", async () => {
    const { options, exec } = probeRecorder();
    await expect(isCodexInstalled(exec, "win32")).resolves.toBe(true);
    expect(options[0]).toMatchObject({ shell: true, windowsHide: true });
    const env = options[0]?.env as { PATH?: string } | undefined;
    expect(env?.PATH).toBeTypeOf("string");
  });

  it("stays a plain exec on posix", async () => {
    const { options, exec } = probeRecorder();
    await expect(isCodexInstalled(exec, "darwin")).resolves.toBe(true);
    expect(options[0]).not.toHaveProperty("shell");
  });
});
