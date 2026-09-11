import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createCodexJsonRpc, splitLines } from "../src/main/codex-jsonrpc";

/**
 * In-memory stdio pair: stdout is an EventEmitter the test pushes chunks on,
 * stdin records everything the client writes.
 */
function fakeStreams() {
  const written: string[] = [];
  const stdin = {
    write(chunk: string): boolean {
      written.push(chunk);
      return true;
    },
  };
  const stdout = new EventEmitter() as unknown as NodeJS.ReadableStream;
  return { stdin, stdout, written };
}

describe("splitLines", () => {
  it("returns complete lines and keeps a trailing partial as rest", () => {
    const { lines, rest } = splitLines('{"a":1}\n{"b"', "");
    expect(lines).toEqual(['{"a":1}']);
    expect(rest).toBe('{"b"');
  });

  it("feeds a partial buffer into the next chunk and completes the frame", () => {
    const first = splitLines("", '{"id":1,"resu');
    const second = splitLines(first.rest, 'lt":42}\n{"id":2}\n');
    expect(second.lines).toEqual(['{"id":1,"result":42}', '{"id":2}']);
    expect(second.rest).toBe("");
  });

  it("keeps the complete trailing line when the chunk ends with a newline", () => {
    // Regression: filtering before popping used to swallow this line.
    const { lines, rest } = splitLines("", '{"id":1,"result":"x"}\n');
    expect(lines).toEqual(['{"id":1,"result":"x"}']);
    expect(rest).toBe("");
  });

  it("drops blank lines", () => {
    const { lines, rest } = splitLines("", `\n\n{"id":1}\n\n \n`);
    expect(lines).toEqual(['{"id":1}']);
    expect(rest).toBe(""); // the chunk ended with \n; the stray " " had its own
  });
});

describe("createCodexJsonRpc", () => {
  it("correlates responses by id alone — codex omits the jsonrpc field", async () => {
    const { stdin, stdout, written } = fakeStreams();
    const rpc = createCodexJsonRpc(stdin, stdout, { onNotification: () => {} });
    const pending = rpc.request<{ thread?: unknown }>("thread/list");
    const id = JSON.parse(written[0] ?? "{}").id;
    stdout.emit("data", `${JSON.stringify({ id, result: { thread: {} } })}\n`);
    await expect(pending).resolves.toEqual({ thread: {} });
    rpc.dispose();
  });

  it("splits frames across read chunks at arbitrary byte boundaries", async () => {
    const { stdin, stdout, written } = fakeStreams();
    const rpc = createCodexJsonRpc(stdin, stdout, { onNotification: () => {} });
    const pending = rpc.request("initialize", {}, 5_000);
    const id = JSON.parse(written[0] ?? "{}").id;
    const frame = `${JSON.stringify({ id, result: { userAgent: "codex/0.154.0" } })}\n`;
    const cut = Math.floor(frame.length / 3);
    stdout.emit("data", frame.slice(0, cut));
    stdout.emit("data", frame.slice(cut, cut * 2));
    stdout.emit("data", frame.slice(cut * 2));
    await expect(pending).resolves.toEqual({ userAgent: "codex/0.154.0" });
    rpc.dispose();
  });

  it("rejects with the server's error message", async () => {
    const { stdin, stdout, written } = fakeStreams();
    const rpc = createCodexJsonRpc(stdin, stdout, { onNotification: () => {} });
    const pending = rpc.request("turn/start");
    const id = JSON.parse(written[0] ?? "{}").id;
    stdout.emit(
      "data",
      `${JSON.stringify({ id, error: { code: -32000, message: "not logged in" } })}\n`,
    );
    await expect(pending).rejects.toThrow("not logged in");
    rpc.dispose();
  });

  it("rejects on per-request timeout", async () => {
    const { stdin, written } = fakeStreams();
    const rpc = createCodexJsonRpc(stdin, new EventEmitter(), {
      onNotification: () => {},
    });
    await expect(rpc.request("thread/list", {}, 25)).rejects.toThrow(
      "thread/list timed out after 25ms",
    );
    rpc.dispose();
  });

  it("stream end rejects pending requests, fires onDisconnect once, and refuses new ones", async () => {
    const { stdin, stdout, written } = fakeStreams();
    let disconnects = 0;
    const rpc = createCodexJsonRpc(stdin, stdout, {
      onNotification: () => {},
      onDisconnect: () => {
        disconnects += 1;
      },
    });
    const pending = rpc.request("turn/start", {}, 60_000);
    stdout.emit("end");
    await expect(pending).rejects.toThrow("connection lost");
    stdout.emit("close"); // a second teardown must not double-fire
    expect(disconnects).toBe(1);
    await expect(rpc.request("thread/list")).rejects.toThrow("not connected");
  });

  it("fans notifications out to the current handler", async () => {
    const { stdout } = fakeStreams();
    const initial: Array<[string, unknown]> = [];
    const rpc = createCodexJsonRpc({ write: () => true }, stdout, {
      onNotification: (method, params) => initial.push([method, params]),
    });
    stdout.emit(
      "data",
      `${JSON.stringify({ method: "thread/started", params: { threadId: "t1" } })}\n`,
    );
    expect(initial).toEqual([["thread/started", { threadId: "t1" }]]);

    const replaced: Array<[string, unknown]> = [];
    rpc.setNotificationHandler((method, params) => replaced.push([method, params]));
    stdout.emit("data", `${JSON.stringify({ method: "thread/deleted", params: null })}\n`);
    expect(initial).toHaveLength(1);
    expect(replaced).toEqual([["thread/deleted", null]]);
    rpc.dispose();
  });

  it("answers unknown server→client requests with an explicit -32601 so codex never blocks", async () => {
    const { stdin, stdout, written } = fakeStreams();
    const rpc = createCodexJsonRpc(stdin, stdout, { onNotification: () => {} });
    stdout.emit(
      "data",
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "currentTime/read",
        params: {},
      })}\n`,
    );
    expect(JSON.parse(written[0] ?? "{}")).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32601, message: "awefork does not handle currentTime/read" },
    });
    rpc.dispose();
  });

  it("falls back to the safe reply for every supported request when no handler is installed", async () => {
    const { stdin, stdout, written } = fakeStreams();
    const rpc = createCodexJsonRpc(stdin, stdout, { onNotification: () => {} });
    const requests: Array<[string, number]> = [
      ["item/commandExecution/requestApproval", 1],
      ["item/fileChange/requestApproval", 2],
      ["item/permissions/requestApproval", 3],
      ["mcpServer/elicitation/request", 4],
      ["execCommandApproval", 5],
      ["applyPatchApproval", 6],
      ["item/tool/requestUserInput", 7],
    ];
    for (const [method, id] of requests) {
      stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id, method, params: {} })}\n`);
    }
    const replies = written.map((chunk) => JSON.parse(chunk));
    // Exact wire shapes verified against the codex 0.154 app-server schema.
    // Denials keep the turn running (the agent reports the refusal); they are
    // never default-approvals and never silent hangs.
    expect(replies[0]).toEqual({ jsonrpc: "2.0", id: 1, result: { decision: "decline" } });
    expect(replies[1]).toEqual({ jsonrpc: "2.0", id: 2, result: { decision: "decline" } });
    expect(replies[2]).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: { permissions: { fileSystem: null, network: null } },
    });
    expect(replies[3]).toEqual({ jsonrpc: "2.0", id: 4, result: { action: "decline" } });
    expect(replies[4]).toEqual({
      jsonrpc: "2.0",
      id: 5,
      result: { decision: { denied: { rejection: "用户拒绝了该操作" } } },
    });
    expect(replies[5]).toEqual({
      jsonrpc: "2.0",
      id: 6,
      result: { decision: { denied: { rejection: "用户拒绝了该操作" } } },
    });
    // User input has no safe default value — an explicit error cancels it.
    expect(replies[6]).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32000, message: "awefork 未获得用户输入，请求已取消" },
    });
    rpc.dispose();
  });

  it("delivers supported requests to the installed handler and replies with its value", async () => {
    const { stdin, stdout, written } = fakeStreams();
    const rpc = createCodexJsonRpc(stdin, stdout, { onNotification: () => {} });
    const seen: Array<[string, unknown]> = [];
    rpc.setRequestHandler((method, params) => {
      seen.push([method, params]);
      return method === "item/tool/requestUserInput"
        ? { answers: { q1: "蓝色" } }
        : { decision: "accept" };
    });
    stdout.emit(
      "data",
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 11,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "t1", command: "npm test" },
      })}\n`,
    );
    stdout.emit(
      "data",
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 12,
        method: "item/tool/requestUserInput",
        params: { questions: [{ id: "q1", question: "选哪个？" }] },
      })}\n`,
    );
    // Handler replies land on a microtask; let both frames flush.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const replies = written.map((chunk) => JSON.parse(chunk));
    expect(replies[0]).toEqual({ jsonrpc: "2.0", id: 11, result: { decision: "accept" } });
    expect(replies[1]).toEqual({ jsonrpc: "2.0", id: 12, result: { answers: { q1: "蓝色" } } });
    expect(seen).toEqual([
      ["item/commandExecution/requestApproval", { threadId: "t1", command: "npm test" }],
      ["item/tool/requestUserInput", { questions: [{ id: "q1", question: "选哪个？" }] }],
    ]);
    rpc.dispose();
  });

  it("replies with an error when the handler rejects an unmappable request", async () => {
    const { stdin, stdout, written } = fakeStreams();
    const rpc = createCodexJsonRpc(stdin, stdout, { onNotification: () => {} });
    rpc.setRequestHandler(() => Promise.reject(new Error("awefork 无法处理 codex 请求 x")));
    stdout.emit(
      "data",
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 13,
        method: "item/permissions/requestApproval",
        params: {},
      })}\n`,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(written[0] ?? "{}")).toEqual({
      jsonrpc: "2.0",
      id: 13,
      error: { code: -32000, message: "awefork 无法处理 codex 请求 x" },
    });
    rpc.dispose();
  });

  it("safe-replies an approval once the 30s user-input deadline lapses", async () => {
    vi.useFakeTimers();
    const { stdin, stdout, written } = fakeStreams();
    const rpc = createCodexJsonRpc(stdin, stdout, { onNotification: () => {} });
    rpc.setRequestHandler(() => new Promise<unknown>(() => {}));
    stdout.emit(
      "data",
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 31,
        method: "item/commandExecution/requestApproval",
        params: { command: "rm -rf /" },
      })}\n`,
    );
    expect(written).toHaveLength(0);
    vi.advanceTimersByTime(29_999);
    expect(written).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(JSON.parse(written[0] ?? "{}")).toEqual({
      jsonrpc: "2.0",
      id: 31,
      result: { decision: "decline" },
    });
    rpc.dispose();
    vi.useRealTimers();
  });

  it("cancels a user-input request that outlives the deadline instead of guessing an answer", async () => {
    vi.useFakeTimers();
    const { stdin, stdout, written } = fakeStreams();
    const rpc = createCodexJsonRpc(stdin, stdout, { onNotification: () => {} });
    rpc.setRequestHandler(() => new Promise<unknown>(() => {}));
    stdout.emit(
      "data",
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 32,
        method: "item/tool/requestUserInput",
        params: { questions: [{ id: "q1", question: "？" }] },
      })}\n`,
    );
    vi.advanceTimersByTime(30_000);
    expect(JSON.parse(written[0] ?? "{}")).toEqual({
      jsonrpc: "2.0",
      id: 32,
      error: { code: -32000, message: "awefork 未获得用户输入，请求已超时" },
    });
    rpc.dispose();
    vi.useRealTimers();
  });

  it("keeps exactly one reply when the handler resolves after the deadline", async () => {
    vi.useFakeTimers();
    const { stdin, stdout, written } = fakeStreams();
    const rpc = createCodexJsonRpc(stdin, stdout, { onNotification: () => {} });
    let resolveHandler: (value: unknown) => void = () => {};
    rpc.setRequestHandler(() => new Promise<unknown>((resolve) => (resolveHandler = resolve)));
    stdout.emit(
      "data",
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 33,
        method: "item/commandExecution/requestApproval",
        params: {},
      })}\n`,
    );
    vi.advanceTimersByTime(30_000);
    resolveHandler({ decision: "accept" });
    await Promise.resolve();
    await Promise.resolve();
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0] ?? "{}").result).toEqual({ decision: "decline" });
    rpc.dispose();
    vi.useRealTimers();
  });

  it("settles an in-flight server request on disconnect — its deadline timer and a late reply never write to the dead stdin", async () => {
    // Regression: a reply written after the stream ended hit a destroyed
    // pipe, whose 'error' event had no listener and crashed the main process.
    vi.useFakeTimers();
    const { stdin, stdout, written } = fakeStreams();
    let resolveHandler: (value: unknown) => void = () => {};
    const rpc = createCodexJsonRpc(stdin, stdout, {
      onNotification: () => {},
      onRequest: () => new Promise<unknown>((resolve) => (resolveHandler = resolve)),
    });
    stdout.emit(
      "data",
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 34,
        method: "item/commandExecution/requestApproval",
        params: { command: "cargo test" },
      })}\n`,
    );
    expect(written).toHaveLength(0);
    // The child dies before the user answers.
    stdout.emit("end");
    vi.advanceTimersByTime(60_000);
    resolveHandler({ decision: "accept" });
    await Promise.resolve();
    await Promise.resolve();
    expect(written).toHaveLength(0);
    rpc.dispose();
    vi.useRealTimers();
  });

  it("answers new-API approval requests with the safe decline when nobody is subscribed yet", async () => {
    const { stdin, stdout, written } = fakeStreams();
    const seen: string[] = [];
    const rpc = createCodexJsonRpc(stdin, stdout, {
      onNotification: (method) => seen.push(method),
    });
    stdout.emit(
      "data",
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 11,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "t1", turnId: "turn-1", itemId: "c1", command: "rm -rf /" },
      })}\n`,
    );
    stdout.emit(
      "data",
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 12,
        method: "item/fileChange/requestApproval",
        params: { threadId: "t1", turnId: "turn-1", itemId: "f1" },
      })}\n`,
    );
    const replies = written.map((chunk) => JSON.parse(chunk));
    // Decision shapes verified against the codex 0.154 app-server schema:
    // decline keeps the turn running so the agent can report the refusal —
    // never a silent hang and never a default-allow.
    expect(replies[0]).toEqual({
      jsonrpc: "2.0",
      id: 11,
      result: { decision: "decline" },
    });
    expect(replies[1]).toEqual({
      jsonrpc: "2.0",
      id: 12,
      result: { decision: "decline" },
    });
    // Approval requests also fan out to the notification handler.
    expect(seen).toEqual([
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
    ]);
    rpc.dispose();
  });

  it("answers legacy approval requests with the exact ReviewDecision deny shape", async () => {
    const { stdin, stdout, written } = fakeStreams();
    const rpc = createCodexJsonRpc(stdin, stdout, { onNotification: () => {} });
    stdout.emit(
      "data",
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 21,
        method: "execCommandApproval",
        params: { conversationId: "c", eventId: "e" },
      })}\n`,
    );
    stdout.emit(
      "data",
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 22,
        method: "applyPatchApproval",
        params: { conversationId: "c", eventId: "e" },
      })}\n`,
    );
    const replies = written.map((chunk) => JSON.parse(chunk));
    expect(replies[0]).toEqual({
      jsonrpc: "2.0",
      id: 21,
      result: { decision: { denied: { rejection: "用户拒绝了该操作" } } },
    });
    expect(replies[1]).toEqual({
      jsonrpc: "2.0",
      id: 22,
      result: { decision: { denied: { rejection: "用户拒绝了该操作" } } },
    });
    rpc.dispose();
  });

  it("drops malformed frames without tearing down the stream", async () => {
    const { stdin, stdout, written } = fakeStreams();
    const seen: string[] = [];
    const rpc = createCodexJsonRpc(stdin, stdout, {
      onNotification: (method) => seen.push(method),
    });
    stdout.emit("data", "not json at all\n");
    const pending = rpc.request("thread/list");
    const id = JSON.parse(written[0] ?? "{}").id;
    stdout.emit("data", `${JSON.stringify({ id, result: [] })}\n`);
    await expect(pending).resolves.toEqual([]);
    expect(seen).toEqual([]);
    rpc.dispose();
  });
});
