/**
 * Minimal JSON-RPC 2.0 client over a child process's stdio.
 *
 * `codex app-server` speaks newline-delimited JSON; a frame can split across
 * read chunks at any byte, so the reader decodes once at the source (keeping
 * multi-byte characters split across chunks intact) and buffers a partial
 * line until the next chunk. Responses may omit the `jsonrpc` field —
 * correlation keys on `id` alone. The server also pushes notifications and server-originated
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

export type CodexRequestHandler = (method: string, params: unknown) => unknown | Promise<unknown>;

export interface CodexJsonRpcOptions {
  onNotification: (method: string, params: unknown) => void;
  /** Fired once when the stream ends, errors, or the client is disposed. */
  onDisconnect?: () => void;
  /** Handles server→client requests after the adapter has subscribed. */
  onRequest?: CodexRequestHandler;
  /** Safe-reply deadline for a server request. */
  requestTimeoutMs?: number;
}

export interface CodexJsonRpc {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  /** Replace the notification handler (the adapter installs its own post-handshake). */
  setNotificationHandler(handler: (method: string, params: unknown) => void): void;
  setRequestHandler(handler?: CodexRequestHandler): void;
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

/** Safe replies verified against the Codex 0.154 app-server schema. */
const SAFE_REPLIES: Record<string, unknown> = {
  "item/commandExecution/requestApproval": { decision: "decline" },
  "item/fileChange/requestApproval": { decision: "decline" },
  "item/permissions/requestApproval": { permissions: { fileSystem: null, network: null } },
  "mcpServer/elicitation/request": { action: "decline" },
  execCommandApproval: { decision: { denied: { rejection: "用户拒绝了该操作" } } },
  applyPatchApproval: { decision: { denied: { rejection: "用户拒绝了该操作" } } },
};

const KNOWN_REQUESTS = new Set([...Object.keys(SAFE_REPLIES), "item/tool/requestUserInput"]);
const REQUEST_TIMEOUT_MS = 30_000;

export function createCodexJsonRpc(
  stdin: { write(chunk: string | Uint8Array): boolean },
  stdout: NodeJS.ReadableStream,
  options: CodexJsonRpcOptions,
): CodexJsonRpc {
  const pending = new Map<number, PendingEntry>();
  /** Server requests whose guard timer is still live; settled on disconnect. */
  const openServerRequests = new Set<() => void>();
  let nextId = 1;
  let buffer = "";
  let disconnected = false;
  let notify = options.onNotification;
  let handleRequest = options.onRequest;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  const notifyDisconnect = () => {
    if (disconnected) return;
    disconnected = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("codex app-server connection lost"));
    }
    pending.clear();
    // Settle in-flight server requests as well: their fallback timers (and
    // any late user reply resolving the handler) would otherwise write to the
    // dead stdin, raising an unhandled stream error in the main process.
    for (const cancel of openServerRequests) cancel();
    openServerRequests.clear();
    stdout.removeListener("data", onData);
    stdout.removeListener("end", onEnd);
    stdout.removeListener("error", onEnd);
    stdout.removeListener("close", onEnd);
    options.onDisconnect?.();
  };

  // Writing to a destroyed pipe emits 'error' with no listener — a crash —
  // so every reply path checks the flag; request() checks it on entry.
  const replyResult = (id: number | string, result: unknown) => {
    if (disconnected) return;
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  };

  const replyError = (id: number | string, code: number, message: string) => {
    if (disconnected) return;
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
  };

  const safeReply = (method: string) => SAFE_REPLIES[method];

  const handleServerRequest = (id: number | string, method: string, params: unknown) => {
    if (!KNOWN_REQUESTS.has(method)) {
      replyError(id, -32601, `awefork does not handle ${method}`);
      return;
    }
    if (!handleRequest) {
      const fallback = safeReply(method);
      if (fallback === undefined) replyError(id, -32000, "awefork 未获得用户输入，请求已取消");
      else replyResult(id, fallback);
      return;
    }
    let settled = false;
    const finish = (result: unknown, error?: unknown) => {
      if (settled) return;
      settled = true;
      openServerRequests.delete(cancel);
      clearTimeout(timer);
      if (error) replyError(id, -32000, error instanceof Error ? error.message : String(error));
      else replyResult(id, result);
    };
    const timer = setTimeout(() => {
      const fallback = safeReply(method);
      if (fallback === undefined) finish(null, "awefork 未获得用户输入，请求已超时");
      else finish(fallback);
    }, requestTimeoutMs);
    // Disconnect settles the request here (the reply write is a guarded
    // no-op), so neither the timer above nor a late handler resolution can
    // reach the dead stdin.
    const cancel = () => finish(null, "codex app-server connection lost");
    openServerRequests.add(cancel);
    Promise.resolve(handleRequest(method, params)).then(
      (result) => finish(result ?? {}),
      (error) => finish(null, error),
    );
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
        handleServerRequest(frame.id, frame.method, frame.params ?? null);
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

  // Decode at the source, not per chunk: Node's string decoder keeps a
  // multi-byte character split across read chunks intact, where per-chunk
  // toString would turn both halves into U+FFFD and silently garble CJK
  // frames. Test doubles push plain EventBuffers, hence the guard.
  if (typeof stdout.setEncoding === "function") stdout.setEncoding("utf8");
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
    setRequestHandler(handler?: CodexRequestHandler) {
      handleRequest = handler;
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
