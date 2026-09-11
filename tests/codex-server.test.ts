import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCodexServer, stopCodexServer } from "../src/main/codex-server.js";

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

  it("flags requiresOpenaiAuth: true as not logged in", async () => {
    const child = fakeCodexChild({
      ...baseScript,
      "account/read": { requiresOpenaiAuth: true },
    });
    const result = await ensureCodexServer(() => {}, spawnFnReturning(child));
    expect(result.authMessage).toMatch(/codex login/);
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
