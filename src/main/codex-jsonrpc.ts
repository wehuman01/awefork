/**
 * Minimal JSON-RPC 2.0 client over a child process's stdio.
 *
 * `codex app-server` speaks newline-delimited JSON; a frame can split across
 * read chunks at any byte, so the reader buffers a partial line until the
 * next chunk. Responses may omit the `jsonrpc` field — correlation keys on
 * `id` alone. The server also pushes notifications and server-originated
 * requests (approvals, tool user input); a request with an `id` MUST get
 * some reply or the server blocks on it. Approval requests get an explicit
 * deny decision (see `REQUEST_REPLIES`); anything we do not know is answered
 * with a method-not-found error so codex fails the request visibly instead
 * of hanging — never silence, never a default-allow.
 */

interface PendingEntry {
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

export interface CodexJsonRpcOptions {
  onNotification: (method: string, params: unknown) => void;
  /** Fired once when the stream ends, errors, or the client is disposed. */
  onDisconnect?: () => void;
}

export interface CodexJsonRpc {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  /** Replace the notification handler (the adapter installs its own post-handshake). */
  setNotificationHandler(handler: (method: string, params: unknown) => void): void;
  dispose(): void;
}

interface RpcFrame {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/** Reason sent with every deny decision so codex logs why it was refused. */
const APPROVAL_DENIED_REASON = "awefork has no approval UI; request denied";

/**
 * Server→client requests answered without a user in the loop. v1 has no
 * approval UI, so every approval is explicitly denied: a well-formed denial
 * (rather than an error reply) lets the agent finish the turn and report the
 * refusal. Method names and decision shapes verified against the codex
 * 0.154 app-server schema.
 */
const REQUEST_REPLIES: Record<string, () => unknown> = {
  // New approval API (turns started via turn/start) — decision enum.
  "item/commandExecution/requestApproval": () => ({ decision: "decline" }),
  "item/fileChange/requestApproval": () => ({ decision: "decline" }),
  // Legacy approval methods (deprecated send APIs) — ReviewDecision shape.
  execCommandApproval: () => ({
    decision: { denied: { rejection: APPROVAL_DENIED_REASON } },
  }),
  applyPatchApproval: () => ({
    decision: { denied: { rejection: APPROVAL_DENIED_REASON } },
  }),
};

export function createCodexJsonRpc(
  stdin: { write(chunk: string | Uint8Array): boolean },
  stdout: NodeJS.ReadableStream,
  options: CodexJsonRpcOptions,
): CodexJsonRpc {
  const pending = new Map<number, PendingEntry>();
  let nextId = 1;
  let buffer = "";
  let disconnected = false;
  let notify = options.onNotification;

  const notifyDisconnect = () => {
    if (disconnected) return;
    disconnected = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("codex app-server connection lost"));
    }
    pending.clear();
    stdout.removeListener("data", onData);
    stdout.removeListener("end", onEnd);
    stdout.removeListener("error", onEnd);
    options.onDisconnect?.();
  };

  const replyResult = (id: number | string, result: unknown) => {
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  };

  const replyError = (id: number | string, message: string) => {
    // A server→client request left unanswered would hang the agent (it waits
    // on approval replies); answering with an error lets it fail the request
    // and end the turn visibly.
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message } })}\n`);
  };

  const handleLine = (line: string) => {
    if (disconnected || line.trim() === "") return;
    let frame: RpcFrame;
    try {
      frame = JSON.parse(line) as RpcFrame;
    } catch {
      // Malformed frame — drop it rather than kill the whole stream.
      return;
    }
    if (typeof frame.method === "string") {
      if (frame.id !== undefined && frame.id !== null) {
        const reply = REQUEST_REPLIES[frame.method];
        if (reply) replyResult(frame.id, reply());
        else replyError(frame.id, `awefork does not handle ${frame.method}`);
      }
      notify(frame.method, frame.params ?? null);
      return;
    }
    // Response: key on `id` only — codex omits the `jsonrpc` field.
    if (typeof frame.id !== "number") return;
    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id);
    clearTimeout(entry.timer);
    if (frame.error) {
      entry.reject(
        new Error(
          typeof frame.error.message === "string"
            ? frame.error.message
            : `codex error ${frame.error.code ?? "unknown"}`,
        ),
      );
    } else {
      entry.resolve(frame.result ?? null);
    }
  };

  const onData = (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    // Feed complete lines through and keep the partial tail buffered.
    const { lines, rest } = splitLines(buffer, "");
    buffer = rest;
    for (const line of lines) handleLine(line);
  };
  const onEnd = () => notifyDisconnect();

  stdout.on("data", onData);
  stdout.on("end", onEnd);
  stdout.on("error", onEnd);
  stdout.on("close", onEnd);

  return {
    request<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
      if (disconnected) return Promise.reject(new Error("codex app-server not connected"));
      const id = nextId++;
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} });
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          reject(new Error(`codex request ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, { timer, resolve: resolve as (value: unknown) => void, reject });
        // A failed write (EPIPE while the child is dying) surfaces through the
        // stream's close handler, which rejects every pending request.
        stdin.write(`${payload}\n`);
      });
    },
    setNotificationHandler(handler: (method: string, params: unknown) => void) {
      notify = handler;
    },
    dispose() {
      notifyDisconnect();
    },
  };
}

/**
 * Pure line splitter exported for tests: complete lines pass through, a
 * trailing partial line is returned as `rest` to feed into the next chunk.
 */
export function splitLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const parts = (buffer + chunk).split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.filter((line) => line.trim() !== ""), rest };
}
