import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
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

  it("answers server→client requests with an error reply so codex never blocks", async () => {
    const { stdin, stdout, written } = fakeStreams();
    const rpc = createCodexJsonRpc(stdin, stdout, { onNotification: () => {} });
    stdout.emit(
      "data",
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "session/approval",
        params: { reason: "run command?" },
      })}\n`,
    );
    const reply = JSON.parse(written[0] ?? "{}");
    expect(reply).toMatchObject({ id: 7, error: { code: -32601 } });
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
