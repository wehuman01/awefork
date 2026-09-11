import { getEventListeners } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { opencodeDescriptor, parseOpenCodeDescriptor } from "../src/shared/agent-descriptor";
import { readLineage } from "../src/shared/lineage-store";
import { createOpencodeAdapter, sleep } from "../src/shared/opencode-adapter";
import type { AgentEvent } from "../src/shared/types";

/**
 * Fake opencode server mirroring the endpoints and semantics verified against
 * a real opencode 1.18 instance:
 *  - POST /session/:id/fork with {messageID} keeps messages STRICTLY BEFORE it
 *  - POST /session/:id/message runs to completion; model is an object
 *    {providerID, modelID} when present. This is the variant that publishes
 *    the run's events on /event — prompt_async publishes none on 1.18.
 *  - GET /config/providers lists providers with nested model maps
 *  - GET /event streams SSE frames
 */

interface FakeMessage {
  info: {
    id: string;
    sessionID: string;
    role: "user" | "assistant";
    modelID?: string;
    providerID?: string;
    variant?: string;
    model?: { providerID?: string; modelID?: string; variant?: string };
    tokens?: { input?: number; output?: number; total?: number };
    error?: { name?: string; data?: { message?: string } };
    finish?: string;
    time: { created: number; completed?: number };
  };
  parts: {
    type: string;
    text?: string;
    tool?: string;
    filename?: string;
    mime?: string;
    url?: string;
  }[];
}

interface FakeSession {
  id: string;
  title: string;
  directory: string;
  parentID?: string;
  project?: string;
  time: { created: number; updated: number };
}

interface FakeProvider {
  id: string;
  name?: string;
  /** Secrets must never survive the adapter's mapping. */
  key?: string;
  models: Record<
    string,
    {
      id?: string;
      name?: string;
      variants?: Record<string, unknown>;
      capabilities?: { attachment?: boolean };
    }
  >;
}

interface FakeState {
  sessions: FakeSession[];
  messages: Record<string, FakeMessage[]>;
  forkCalls: { sessionId: string; cutMessageId: string | null }[];
  /** directory query param per POST /session; null = the client sent none. */
  createCalls: (string | null)[];
  promptCalls: { sessionId: string; body: Record<string, unknown> }[];
  deleteCalls: string[];
  deleteMessageCalls: { sessionId: string; messageId: string }[];
  providers: FakeProvider[];
  projects: { id: string; worktree: string }[];
  currentProject: string;
  /** SSE frames streamed by GET /event; defaults to one session.idle. */
  eventFrames?: { type: string; properties: Record<string, unknown> }[];
  /** How many leading GET /event requests fail with 503 before streams work. */
  eventFailuresRemaining?: number;
  /** First GET /event ends mid-frame before any eventFrames stream — a
   * connection dying mid-write, to exercise the reconnect path. */
  eventDropMidFrame?: boolean;
}

function startFakeServer(state: FakeState): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const body: string[] = [];
    req.on("data", (chunk) => body.push(String(chunk)));
    req.on("end", () => {
      const payload = body.length > 0 ? JSON.parse(body.join("")) : {};
      respond(url, req.method ?? "GET", payload);
    });

    function respond(url: URL, method: string, payload: Record<string, unknown>) {
      res.setHeader("content-type", "application/json");

      if (method === "GET" && url.pathname === "/session") {
        const directory = url.searchParams.get("directory");
        const limit = Number(url.searchParams.get("limit") ?? 100);
        const list = directory
          ? state.sessions.filter((s) => s.directory === directory)
          : state.sessions.filter((s) => (s.project ?? "global") === state.currentProject);
        res.end(JSON.stringify(list.slice(0, limit)));
        return;
      }
      if (method === "GET" && url.pathname === "/project") {
        res.end(JSON.stringify(state.projects));
        return;
      }
      if (method === "GET" && url.pathname === "/config/providers") {
        res.end(JSON.stringify({ providers: state.providers }));
        return;
      }
      if (method === "GET" && url.pathname === "/event") {
        if ((state.eventFailuresRemaining ?? 0) > 0) {
          state.eventFailuresRemaining -= 1;
          res.writeHead(503);
          res.end();
          return;
        }
        if (state.eventDropMidFrame) {
          state.eventDropMidFrame = false;
          res.writeHead(200, { "content-type": "text/event-stream" });
          // Half a frame with no blank-line terminator, then EOF.
          const partial = `data: ${JSON.stringify({
            id: "evt-cut",
            type: "session.updated",
            properties: { sessionID: "s1" },
          })}`;
          res.end(partial.slice(0, partial.length - 12));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const frames = state.eventFrames ?? [
          { id: "evt-1", type: "session.idle", properties: { sessionID: "s1" } },
        ];
        for (const frame of frames) {
          res.write(`data: ${JSON.stringify(frame)}\n\n`);
        }
        return;
      }

      if (method === "POST" && url.pathname === "/session") {
        const directory = url.searchParams.get("directory");
        state.createCalls.push(directory);
        const session: FakeSession = {
          id: `new-${state.createCalls.length}`,
          title: "New session",
          directory: directory ?? "/repo",
          time: { created: 500, updated: 500 },
        };
        state.sessions.push(session);
        res.end(JSON.stringify(session));
        return;
      }

      const deleteMatch = url.pathname.match(/^\/session\/([^/]+)$/);
      if (method === "DELETE" && deleteMatch) {
        const id = deleteMatch[1] ?? "";
        state.deleteCalls.push(id);
        delete state.messages[id];
        state.sessions = state.sessions.filter((s) => s.id !== id);
        res.writeHead(204);
        res.end();
        return;
      }

      if (method === "PATCH" && deleteMatch) {
        const id = deleteMatch[1] ?? "";
        const target = state.sessions.find((s) => s.id === id);
        if (!target) {
          res.writeHead(404);
          res.end(JSON.stringify({ data: { message: `Session not found: ${id}` } }));
          return;
        }
        if (typeof payload.title === "string") target.title = payload.title;
        res.end(JSON.stringify(target));
        return;
      }

      // Drift-test scaffold: a hypothetical newer opencode that renamed the
      // message endpoint — it tags one extra row so a test can tell which
      // route actually answered.
      const driftMatch = url.pathname.match(/^\/session\/([^/]+)\/messages\/v2$/);
      if (method === "GET" && driftMatch) {
        const id = driftMatch[1] ?? "";
        const rows = [
          ...(state.messages[id] ?? []),
          {
            info: { id: "v2-marker", sessionID: id, role: "assistant", time: { created: 1 } },
            parts: [],
          },
        ];
        res.end(JSON.stringify(rows));
        return;
      }

      const messageMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/);
      if (method === "GET" && messageMatch) {
        res.end(JSON.stringify(state.messages[messageMatch[1] ?? ""] ?? []));
        return;
      }

      const deleteMessageMatch = url.pathname.match(/^\/session\/([^/]+)\/message\/([^/]+)$/);
      if (method === "DELETE" && deleteMessageMatch) {
        const sessionId = deleteMessageMatch[1] ?? "";
        const messageId = deleteMessageMatch[2] ?? "";
        state.deleteMessageCalls.push({ sessionId, messageId });
        const rows = state.messages[sessionId] ?? [];
        state.messages[sessionId] = rows.filter((m) => m.info.id !== messageId);
        res.writeHead(204);
        res.end();
        return;
      }

      const forkMatch = url.pathname.match(/^\/session\/([^/]+)\/fork$/);
      if (method === "POST" && forkMatch) {
        const sessionId = forkMatch[1] ?? "";
        const cut = typeof payload.messageID === "string" ? payload.messageID : null;
        state.forkCalls.push({ sessionId, cutMessageId: cut });
        const source = state.messages[sessionId] ?? [];
        const cutIndex = cut ? source.findIndex((m) => m.info.id === cut) : -1;
        const kept = cutIndex >= 0 ? source.slice(0, cutIndex) : source;
        const id = `fork-${state.forkCalls.length}`;
        state.sessions.push({
          id,
          title: "forked",
          directory: "/repo",
          time: { created: 99, updated: 99 },
        });
        state.messages[id] = JSON.parse(JSON.stringify(kept));
        res.end(JSON.stringify(state.sessions.find((s) => s.id === id)));
        return;
      }

      const promptMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/);
      if (method === "POST" && promptMatch) {
        state.promptCalls.push({ sessionId: promptMatch[1] ?? "", body: payload });
        res.writeHead(204);
        res.end();
        return;
      }

      const abortMatch = url.pathname.match(/^\/session\/([^/]+)\/abort$/);
      if (method === "POST" && abortMatch) {
        res.writeHead(204);
        res.end();
        return;
      }

      res.writeHead(404);
      res.end("{}");
    }
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

let cleanup: (() => Promise<void>)[] = [];

beforeEach(() => {
  cleanup = [];
});

afterEach(async () => {
  for (const fn of cleanup) await fn();
});

function baseState(): FakeState {
  return {
    sessions: [
      { id: "s1", title: "root session", directory: "/repo", time: { created: 1, updated: 10 } },
      {
        id: "s1-sub",
        title: "subagent",
        directory: "/repo",
        parentID: "s1",
        time: { created: 2, updated: 20 },
      },
    ],
    messages: {
      s1: [
        msg("u1", "user", "first question"),
        msg("a1", "assistant", "first answer"),
        msg("u2", "user", "second question"),
        msg("a2", "assistant", "second answer"),
        msg("u3", "user", "third question"),
        msg("a3", "assistant", "third answer"),
      ],
    },
    forkCalls: [],
    createCalls: [],
    promptCalls: [],
    deleteCalls: [],
    deleteMessageCalls: [],
    providers: [
      {
        id: "oc-fake",
        name: "Fake Router",
        key: "sk-secret-must-not-leak",
        models: {
          "glm-5.3-flash": {
            id: "glm-5.3-flash",
            name: "GLM 5.3 Flash",
            // deliberately out of intensity order + one unknown key
            variants: { high: {}, medium: {}, turbo: {}, low: {} },
            capabilities: { attachment: true },
          },
          "gpt-5.6-sol": { id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
        },
      },
      { id: "bare", models: { "unnamed-model": {} } },
    ],
    projects: [{ id: "global", worktree: "/" }],
    currentProject: "global",
  };
}

function msg(id: string, role: "user" | "assistant", text: string): FakeMessage {
  return {
    info: {
      id,
      sessionID: "s1",
      role,
      modelID: role === "assistant" ? "glm/glm-5.3-flash" : undefined,
      providerID: role === "assistant" ? "oc-fake" : undefined,
      time: { created: id.charCodeAt(1) },
    },
    parts: [{ type: "text", text }],
  };
}

async function newAdapter(state: FakeState, descriptor = opencodeDescriptor()) {
  const { server, baseUrl } = await startFakeServer(state);
  const lineagePath = join(await mkdtemp(join(tmpdir(), "awefork-adapter-")), "lineage.json");
  cleanup.push(async () => {
    adapter.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const adapter = createOpencodeAdapter({ baseUrl, lineagePath, descriptor });
  return { adapter, lineagePath, baseUrl };
}

describe("opencode adapter", () => {
  it("maps sessions with subagent origin", async () => {
    const state = baseState();
    const { adapter } = await newAdapter(state);
    const sessions = await adapter.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.id === "s1-sub")).toMatchObject({ origin: "subagent" });
    expect(sessions.find((s) => s.id === "s1")).toMatchObject({ origin: "root" });
  });

  it("maps messages to text, thinking, tool names, and model id", async () => {
    const state = baseState();
    state.messages.s1?.[1]?.parts.push(
      { type: "reasoning", text: "I should inspect the event protocol first." },
      // a second reasoning part (the run's next step) must stay separated by a
      // blank line, not glue onto the first step's last line
      { type: "reasoning", text: "The grep result narrows it down." },
      { type: "tool", tool: "bash" },
    );
    // opencode 1.18: the user row that opens a run carries the model nested;
    // the assistant row reports top-level ids plus a completion time.
    const u1 = state.messages.s1?.[0]?.info;
    if (u1) u1.model = { providerID: "oc-fake", modelID: "glm/glm-5.3-flash" };
    const a1 = state.messages.s1?.[1]?.info;
    if (a1) a1.time.completed = 5000;
    const { adapter } = await newAdapter(state);
    const messages = await adapter.messages("s1");
    expect(messages[0]).toMatchObject({
      id: "u1",
      role: "user",
      text: "first question",
      modelId: "glm/glm-5.3-flash",
      providerId: "oc-fake",
      completedAt: null,
    });
    expect(messages[1]?.toolNames).toEqual(["bash"]);
    expect(messages[1]?.thinking).toBe(
      "I should inspect the event protocol first.\n\nThe grep result narrows it down.",
    );
    expect(messages[1]?.modelId).toBe("glm/glm-5.3-flash");
    expect(messages[1]?.providerId).toBe("oc-fake");
    expect(messages[1]?.completedAt).toBe(5000);
  });

  it("maps assistant token usage; user rows report none", async () => {
    const state = baseState();
    const a1 = state.messages.s1?.[1]?.info;
    if (a1) a1.tokens = { total: 99, input: 70, output: 29 };
    const { adapter } = await newAdapter(state);
    const messages = await adapter.messages("s1");
    expect(messages[0]?.outputTokens).toBeNull();
    expect(messages[1]?.outputTokens).toBe(29);
  });

  it("maps each step's finish reason; user and unreported rows carry null", async () => {
    // Multi-step run: the tool-calls step is mid-run, the stop step is the end.
    // The renderer's run watchdog settles on finish !== "tool-calls" — a mapped
    // finish is what keeps a mid-run step from looking like the final reply.
    const state = baseState();
    const a1 = state.messages.s1?.[1]?.info;
    if (a1) a1.finish = "tool-calls";
    const a2 = state.messages.s1?.[3]?.info;
    if (a2) a2.finish = "stop";
    const { adapter } = await newAdapter(state);
    const messages = await adapter.messages("s1");
    expect(messages[0]?.finish).toBeNull();
    expect(messages[1]?.finish).toBe("tool-calls");
    expect(messages[3]?.finish).toBe("stop");
    expect(messages[5]?.finish).toBeNull();
  });

  it("maps a failed run's error reason; successful rows carry null", async () => {
    const state = baseState();
    const a1 = state.messages.s1?.[1]?.info;
    if (a1) a1.error = { name: "APIError", data: { message: "no active subscription" } };
    const { adapter } = await newAdapter(state);
    const messages = await adapter.messages("s1");
    expect(messages[0]?.error).toBeNull();
    expect(messages[1]?.error).toBe("no active subscription");
  });

  it("maps the run's effort variant — assistant top-level, user nested", async () => {
    const state = baseState();
    const u1 = state.messages.s1?.[0]?.info;
    if (u1) u1.model = { providerID: "oc-fake", modelID: "glm/glm-5.3-flash", variant: "high" };
    const a1 = state.messages.s1?.[1]?.info;
    if (a1) a1.variant = "high";
    const { adapter } = await newAdapter(state);
    const messages = await adapter.messages("s1");
    expect(messages[0]?.variant).toBe("high");
    expect(messages[1]?.variant).toBe("high");
    expect(messages[2]?.variant).toBeNull();
  });

  it("maps file parts to attachment names; blanks become 附件", async () => {
    const state = baseState();
    const u1 = state.messages.s1?.[0];
    u1?.parts.push({ type: "file", filename: "shot.png" }, { type: "file" });
    const { adapter } = await newAdapter(state);
    const messages = await adapter.messages("s1");
    expect(messages[0]?.attachmentNames).toEqual(["shot.png", "附件"]);
    expect(messages[1]?.attachmentNames).toEqual([]);
  });

  it("messageAttachments hands a message's file parts back as sendable attachments", async () => {
    const state = baseState();
    state.messages.s1?.[0]?.parts.push(
      { type: "file", filename: "shot.png", mime: "image/png", url: "data:image/png;base64,AAA" },
      // filename lost server-side → the same 附件 fallback the names mapping uses
      { type: "file", mime: "text/plain", url: "data:text/plain;base64,Qg==" },
      // url lost → resending an empty file would fail the run, so it's dropped
      { type: "file", filename: "gone.txt", mime: "text/plain" },
    );
    const { adapter } = await newAdapter(state);
    const attachments = await adapter.messageAttachments("s1", "u1");
    expect(attachments).toEqual([
      { mime: "image/png", filename: "shot.png", dataUrl: "data:image/png;base64,AAA" },
      { mime: "text/plain", filename: "附件", dataUrl: "data:text/plain;base64,Qg==" },
    ]);
  });

  it("messageAttachments of an unknown message is an empty list", async () => {
    const state = baseState();
    const { adapter } = await newAdapter(state);
    expect(await adapter.messageAttachments("s1", "nope")).toEqual([]);
  });

  it("lists models with ids, names, ordered variants and attachment flag — secrets dropped", async () => {
    const state = baseState();
    const { adapter } = await newAdapter(state);
    const models = await adapter.listModels();
    expect(models).toEqual([
      {
        providerId: "oc-fake",
        providerName: "Fake Router",
        modelId: "glm-5.3-flash",
        modelName: "GLM 5.3 Flash",
        variants: ["low", "medium", "high", "turbo"],
        attachment: true,
      },
      {
        providerId: "oc-fake",
        providerName: "Fake Router",
        modelId: "gpt-5.6-sol",
        modelName: "GPT 5.6 Sol",
        variants: [],
        attachment: false,
      },
      {
        providerId: "bare",
        providerName: "bare",
        modelId: "unnamed-model",
        modelName: "unnamed-model",
        variants: [],
        attachment: false,
      },
    ]);
    expect(JSON.stringify(models)).not.toContain("sk-secret");
  });

  it("createSession starts an empty root session in the requested directory", async () => {
    const state = baseState();
    const { adapter } = await newAdapter(state);
    const created = await adapter.createSession("/other-repo");
    expect(state.createCalls).toEqual(["/other-repo"]);
    expect(created).toMatchObject({
      id: "new-1",
      directory: "/other-repo",
      origin: "root",
      parentSessionId: null,
    });
    // The fresh session is immediately usable: no rows yet, promptable later.
    expect(await adapter.messages(created.id)).toEqual([]);
  });

  it("createSession without a directory omits the query param", async () => {
    const state = baseState();
    const { adapter } = await newAdapter(state);
    await adapter.createSession(null);
    expect(state.createCalls).toEqual([null]);
  });

  it("fork at a user message keeps that full turn (exclusive cut at next user message)", async () => {
    const state = baseState();
    const { adapter } = await newAdapter(state);
    const forked = await adapter.fork("s1", "u2");

    expect(state.forkCalls).toEqual([{ sessionId: "s1", cutMessageId: "u3" }]);
    expect(forked).toMatchObject({ origin: "fork", parentSessionId: "s1" });
    const messages = await adapter.messages(forked.id);
    expect(messages.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("fork at the latest turn passes no cut (full copy)", async () => {
    const state = baseState();
    const { adapter } = await newAdapter(state);
    await adapter.fork("s1", "u3");
    expect(state.forkCalls).toEqual([{ sessionId: "s1", cutMessageId: null }]);
  });

  it("fork with null atMessageId passes no cut", async () => {
    const state = baseState();
    const { adapter } = await newAdapter(state);
    await adapter.fork("s1", null);
    expect(state.forkCalls).toEqual([{ sessionId: "s1", cutMessageId: null }]);
  });

  it("records fork lineage in the sidecar", async () => {
    const state = baseState();
    const { adapter, lineagePath } = await newAdapter(state);
    const forked = await adapter.fork("s1", "u1");
    const lineage = await readLineage(lineagePath);
    expect(lineage[forked.id]).toMatchObject({ parentId: "s1", atMessageId: "u1" });
  });

  it("rejects fork at an unknown message with an actionable error", async () => {
    const state = baseState();
    const { adapter } = await newAdapter(state);
    await expect(adapter.fork("s1", "nope")).rejects.toThrow(/not found in session s1/);
  });

  it("prompt fires the message endpoint (the event-publishing variant)", async () => {
    const state = baseState();
    const { adapter } = await newAdapter(state);
    await adapter.prompt("s1", "hello");
    // the request is detached; give the fake server a beat to record it
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.promptCalls).toEqual([
      { sessionId: "s1", body: { parts: [{ type: "text", text: "hello" }] } },
    ]);
  });

  it("prompt passes the chosen model as a provider/model object", async () => {
    const state = baseState();
    const { adapter } = await newAdapter(state);
    await adapter.prompt("s1", "hello", { providerId: "oc-fake", modelId: "gpt-5.6-sol" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.promptCalls[0]?.body.model).toEqual({
      providerID: "oc-fake",
      modelID: "gpt-5.6-sol",
    });
    expect(state.promptCalls[0]?.body.variant).toBeUndefined();
  });

  it("prompt sends the effort variant top-level and file parts before the text", async () => {
    const state = baseState();
    const { adapter } = await newAdapter(state);
    await adapter.prompt(
      "s1",
      "look at this",
      { providerId: "oc-fake", modelId: "glm-5.3-flash", variant: "high" },
      [{ mime: "image/png", filename: "shot.png", dataUrl: "data:image/png;base64,AAA" }],
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.promptCalls[0]?.body).toEqual({
      parts: [
        { type: "file", mime: "image/png", filename: "shot.png", url: "data:image/png;base64,AAA" },
        { type: "text", text: "look at this" },
      ],
      model: { providerID: "oc-fake", modelID: "glm-5.3-flash" },
      variant: "high",
    });
  });

  it("subscribe emits normalized events from the SSE stream", async () => {
    const state = baseState();
    const { adapter } = await newAdapter(state);
    const events: AgentEvent[] = [];
    const unsubscribe = await adapter.subscribe((event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 100));
    unsubscribe();
    expect(events).toContainEqual({ type: "session.idle", sessionId: "s1" });
  });

  it("reports one server.error per outage and server.reconnected on recovery", async () => {
    const state = baseState();
    // First /event connect 503s; the 1 s reconnect then succeeds — the
    // cold-start window where REST answers before the stream accepts.
    state.eventFailuresRemaining = 1;
    const { adapter } = await newAdapter(state);
    const events: AgentEvent[] = [];
    const unsubscribe = await adapter.subscribe((event) => events.push(event));
    // failure → 1 s backoff → reconnect; a little slack for scheduling
    await new Promise((resolve) => setTimeout(resolve, 1500));
    unsubscribe();
    expect(events.filter((e) => e.type === "server.error")).toHaveLength(1);
    expect(events).toContainEqual({ type: "server.reconnected" });
  });

  it("drops a severed connection's half-frame instead of splicing it into the next stream", async () => {
    const state = baseState();
    // The first /event connection dies mid-frame; the immediate reconnect
    // streams a full frame. A parser reused across connections would hold the
    // half-frame, merge it into the fresh stream's first frame, and lose that
    // event to a JSON parse failure.
    state.eventDropMidFrame = true;
    const { adapter } = await newAdapter(state);
    const events: AgentEvent[] = [];
    const unsubscribe = await adapter.subscribe((event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    unsubscribe();
    expect(events).toContainEqual({ type: "session.idle", sessionId: "s1" });
  });

  it("renameSession PATCHes the title onto the session row", async () => {
    const state = baseState();
    const { adapter } = await newAdapter(state);
    await adapter.renameSession("s1", "renamed title");
    expect(state.sessions.find((s) => s.id === "s1")?.title).toBe("renamed title");
  });

  it("deleteSession removes the session server-side and its lineage record", async () => {
    const state = baseState();
    const { adapter, lineagePath } = await newAdapter(state);
    const forked = await adapter.fork("s1", "u1");
    await adapter.deleteSession(forked.id);

    expect(state.deleteCalls).toEqual([forked.id]);
    expect(state.sessions.find((s) => s.id === forked.id)).toBeUndefined();
    const lineage = await readLineage(lineagePath);
    expect(lineage[forked.id]).toBeUndefined();
  });

  it("deleteMessage removes exactly the addressed row", async () => {
    const state = baseState();
    const { adapter } = await newAdapter(state);
    await adapter.deleteMessage("s1", "a2");

    expect(state.deleteMessageCalls).toEqual([{ sessionId: "s1", messageId: "a2" }]);
    const messages = await adapter.messages("s1");
    expect(messages.map((m) => m.id)).toEqual(["u1", "a1", "u2", "u3", "a3"]);
  });

  it("message.updated alone never marks a session running (fork replay)", async () => {
    const state = baseState();
    state.eventFrames = [
      // opencode replays these for every copied message when a fork is created
      { type: "message.updated", properties: { sessionID: "fork-1", info: { id: "m1" } } },
      { type: "message.part.updated", properties: { sessionID: "fork-1", messageID: "m1" } },
    ];
    const { adapter } = await newAdapter(state);
    const events: AgentEvent[] = [];
    const unsubscribe = await adapter.subscribe((event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 100));
    unsubscribe();
    expect(events).not.toContainEqual({
      type: "message.started",
      sessionId: "fork-1",
      messageId: "m1",
    });
    expect(events).not.toContainEqual({
      type: "message.delta",
      sessionId: "fork-1",
      messageId: "m1",
      delta: "",
    });
    expect(events.filter((e) => e.type === "message.part")).toHaveLength(0);
  });

  it("session.status busy marks a session running; real deltas stream through", async () => {
    const state = baseState();
    // Older opencode builds put the text delta in the part.updated frame
    // itself, next to the part snapshot announcing its kind.
    state.eventFrames = [
      { type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } },
      {
        type: "message.part.updated",
        properties: {
          sessionID: "s1",
          messageID: "m1",
          part: { id: "p1", type: "text", sessionID: "s1", messageID: "m1", text: "hello" },
          delta: "hello",
        },
      },
    ];
    const { adapter } = await newAdapter(state);
    const events: AgentEvent[] = [];
    const unsubscribe = await adapter.subscribe((event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 100));
    unsubscribe();
    expect(events).toContainEqual({ type: "message.started", sessionId: "s1", messageId: "" });
    expect(events).toContainEqual({
      type: "message.delta",
      sessionId: "s1",
      messageId: "m1",
      partId: "p1",
      kind: "text",
      delta: "hello",
    });
  });

  it("session.status idle finishes a run like session.idle (twin frames)", async () => {
    const state = baseState();
    state.eventFrames = [
      { type: "session.status", properties: { sessionID: "s1", status: { type: "idle" } } },
    ];
    const { adapter } = await newAdapter(state);
    const events: AgentEvent[] = [];
    const unsubscribe = await adapter.subscribe((event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 100));
    unsubscribe();
    expect(events).toContainEqual({ type: "session.idle", sessionId: "s1" });
    expect(events).not.toContainEqual({ type: "message.started", sessionId: "s1", messageId: "" });
  });

  it("routes opencode 1.18 text-field deltas by their announced part type", async () => {
    const state = baseState();
    state.eventFrames = [
      {
        type: "message.part.updated",
        properties: {
          sessionID: "s1",
          part: { id: "p-thinking", type: "reasoning", sessionID: "s1", messageID: "m1", text: "" },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          sessionID: "s1",
          part: { id: "p-text", type: "text", sessionID: "s1", messageID: "m1", text: "" },
        },
      },
      {
        type: "message.part.delta",
        properties: {
          sessionID: "s1",
          messageID: "m1",
          partID: "p-thinking",
          field: "text",
          delta: "hm",
        },
      },
      {
        type: "message.part.delta",
        properties: {
          sessionID: "s1",
          messageID: "m1",
          partID: "p-text",
          field: "text",
          delta: "he",
        },
      },
    ];
    const { adapter } = await newAdapter(state);
    const events: AgentEvent[] = [];
    const unsubscribe = await adapter.subscribe((event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 100));
    unsubscribe();
    expect(events).toContainEqual({
      type: "message.delta",
      sessionId: "s1",
      messageId: "m1",
      partId: "p-thinking",
      kind: "thinking",
      delta: "hm",
    });
    expect(events).toContainEqual({
      type: "message.delta",
      sessionId: "s1",
      messageId: "m1",
      partId: "p-text",
      kind: "text",
      delta: "he",
    });
  });

  it("forwards part snapshots with full text and the reasoning end time", async () => {
    const state = baseState();
    state.eventFrames = [
      // streaming snapshot: no end yet
      {
        type: "message.part.updated",
        properties: {
          sessionID: "s1",
          messageID: "m1",
          part: {
            id: "p-th",
            type: "reasoning",
            sessionID: "s1",
            messageID: "m1",
            text: "checking the config",
            time: { start: 1000 },
          },
        },
      },
      // reasoning-end snapshot: carries time.end and the full text
      {
        type: "message.part.updated",
        properties: {
          sessionID: "s1",
          messageID: "m1",
          part: {
            id: "p-th",
            type: "reasoning",
            sessionID: "s1",
            messageID: "m1",
            text: "checking the config, found it",
            time: { start: 1000, end: 43000 },
          },
        },
      },
      // tool and step-start snapshots are not part of the text stream
      {
        type: "message.part.updated",
        properties: {
          sessionID: "s1",
          messageID: "m1",
          part: { id: "p-tool", type: "tool", sessionID: "s1", messageID: "m1", tool: "grep" },
        },
      },
    ];
    const { adapter } = await newAdapter(state);
    const events: AgentEvent[] = [];
    const unsubscribe = await adapter.subscribe((event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 100));
    unsubscribe();
    expect(events).toContainEqual({
      type: "message.part",
      sessionId: "s1",
      messageId: "m1",
      partId: "p-th",
      kind: "thinking",
      text: "checking the config",
      startedAt: 1000,
      endedAt: null,
    });
    expect(events).toContainEqual({
      type: "message.part",
      sessionId: "s1",
      messageId: "m1",
      partId: "p-th",
      kind: "thinking",
      text: "checking the config, found it",
      startedAt: 1000,
      endedAt: 43000,
    });
    expect(events.filter((e) => e.type === "message.part")).toHaveLength(2);
  });

  it("drops deltas whose part kind was never announced instead of guessing text", async () => {
    const state = baseState();
    // App started mid-run / an SSE gap ate the part's first frame: the next
    // delta names a part nobody announced. Guessing "text" would render
    // reasoning as reply text; the snapshot that follows carries everything.
    state.eventFrames = [
      {
        type: "message.part.delta",
        properties: {
          sessionID: "s1",
          messageID: "m1",
          partID: "p-unknown",
          field: "text",
          delta: "reasoning leak",
        },
      },
      // same rule for older builds' part.updated frames without a part id
      {
        type: "message.part.updated",
        properties: { sessionID: "s1", messageID: "m1", delta: "leak too" },
      },
      // once the snapshot lands, later deltas route correctly
      {
        type: "message.part.updated",
        properties: {
          sessionID: "s1",
          messageID: "m1",
          part: {
            id: "p-unknown",
            type: "reasoning",
            sessionID: "s1",
            messageID: "m1",
            text: "reasoning leak",
          },
        },
      },
      {
        type: "message.part.delta",
        properties: {
          sessionID: "s1",
          messageID: "m1",
          partID: "p-unknown",
          field: "text",
          delta: " more",
        },
      },
    ];
    const { adapter } = await newAdapter(state);
    const events: AgentEvent[] = [];
    const unsubscribe = await adapter.subscribe((event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 100));
    unsubscribe();
    const deltas = events.filter((e) => e.type === "message.delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ partId: "p-unknown", kind: "thinking", delta: " more" });
  });

  it("session.error surfaces as server.error instead of dying silently", async () => {
    const state = baseState();
    state.eventFrames = [
      {
        type: "session.error",
        properties: {
          sessionID: "s1",
          error: { name: "UnknownError", data: { message: "Model not found: x/y" } },
        },
      },
    ];
    const { adapter } = await newAdapter(state);
    const events: AgentEvent[] = [];
    const unsubscribe = await adapter.subscribe((event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 100));
    unsubscribe();
    expect(events).toContainEqual({
      type: "server.error",
      sessionId: "s1",
      message: expect.stringContaining("Model not found: x/y"),
    });
  });

  it("lists sessions across all projects, not just the server's current project", async () => {
    const state = baseState();
    state.projects.push({ id: "pd", worktree: "/other" });
    state.sessions.push({
      id: "s-other",
      title: "other project",
      directory: "/other",
      project: "pd",
      time: { created: 3, updated: 30 },
    });
    const { adapter } = await newAdapter(state);
    const sessions = await adapter.listSessions();
    expect(sessions.map((s) => s.id)).toEqual(["s-other", "s1-sub", "s1"]);
  });

  it("fetches more than the server's default page size of 100", async () => {
    const state = baseState();
    for (let i = 0; i < 120; i++) {
      state.sessions.push({
        id: `bulk-${i}`,
        title: `bulk ${i}`,
        directory: "/repo",
        time: { created: i, updated: i },
      });
    }
    const { adapter } = await newAdapter(state);
    const sessions = await adapter.listSessions();
    expect(sessions).toHaveLength(122);
  });

  it("dedupes sessions reachable from both the current project and a directory query", async () => {
    const state = baseState();
    state.currentProject = "pd";
    state.projects.push({ id: "pd", worktree: "/repo" });
    const { adapter } = await newAdapter(state);
    const sessions = await adapter.listSessions();
    expect(sessions.filter((s) => s.id === "s1")).toHaveLength(1);
  });

  // The whole point of the descriptor: when opencode renames things, the fix
  // is a data edit. This test simulates that rename and proves the adapter
  // follows the file, not its old habits.
  it("follows a drifted descriptor — renamed endpoint, field path, and event", async () => {
    const state = baseState();
    (state.messages.s1?.[1]?.info as Record<string, unknown>).chosenModel = "drift/model";
    state.eventFrames = [{ type: "session.done", properties: { sessionID: "s1" } }];

    const root = JSON.parse(JSON.stringify(opencodeDescriptor())) as Record<string, unknown>;
    (root.endpoints as Record<string, unknown>).sessionMessages = "/session/{id}/messages/v2";
    (root.events as Record<string, unknown>).idle = ["session.done"];
    ((root.messages as Record<string, unknown>).fields as Record<string, unknown>).modelId = [
      "info.chosenModel",
    ];
    const drifted = parseOpenCodeDescriptor(root);

    const { adapter } = await newAdapter(state, drifted);

    // The v2 route answered (its marker row came back) and the model id came
    // from the renamed slot, not the old top-level modelID.
    const messages = await adapter.messages("s1");
    expect(messages.map((m) => m.id)).toContain("v2-marker");
    expect(messages[1]?.modelId).toBe("drift/model");

    const events: AgentEvent[] = [];
    const unsubscribe = await adapter.subscribe((event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 100));
    unsubscribe();
    expect(events).toContainEqual({ type: "session.idle", sessionId: "s1" });
  });
});

describe("sleep", () => {
  it("drops its abort listener when the timer wins (reconnect loop leak)", async () => {
    const controller = new AbortController();
    // The reconnect loop calls sleep once per second during an outage; every
    // call leaving its listener behind grew the signal's count without bound.
    for (let i = 0; i < 5; i += 1) {
      await sleep(1, controller.signal);
    }
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("still resolves early when aborted", async () => {
    const controller = new AbortController();
    const pending = sleep(5000, controller.signal);
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
  });
});
