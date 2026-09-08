import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLineage } from "../src/shared/lineage-store";
import { createOpencodeAdapter } from "../src/shared/opencode-adapter";
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
    model?: { providerID?: string; modelID?: string };
    tokens?: { input?: number; output?: number; total?: number };
    error?: { name?: string; data?: { message?: string } };
    time: { created: number; completed?: number };
  };
  parts: { type: string; text?: string; tool?: string }[];
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
  models: Record<string, { id?: string; name?: string }>;
}

interface FakeState {
  sessions: FakeSession[];
  messages: Record<string, FakeMessage[]>;
  forkCalls: { sessionId: string; cutMessageId: string | null }[];
  promptCalls: { sessionId: string; body: Record<string, unknown> }[];
  deleteCalls: string[];
  providers: FakeProvider[];
  projects: { id: string; worktree: string }[];
  currentProject: string;
  /** SSE frames streamed by GET /event; defaults to one session.idle. */
  eventFrames?: { type: string; properties: Record<string, unknown> }[];
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
        res.writeHead(200, { "content-type": "text/event-stream" });
        const frames = state.eventFrames ?? [
          { id: "evt-1", type: "session.idle", properties: { sessionID: "s1" } },
        ];
        for (const frame of frames) {
          res.write(`data: ${JSON.stringify(frame)}\n\n`);
        }
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

      const messageMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/);
      if (method === "GET" && messageMatch) {
        res.end(JSON.stringify(state.messages[messageMatch[1] ?? ""] ?? []));
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
    promptCalls: [],
    deleteCalls: [],
    providers: [
      {
        id: "oc-fake",
        name: "Fake Router",
        key: "sk-secret-must-not-leak",
        models: {
          "glm-5.3-flash": { id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
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

async function newAdapter(state: FakeState) {
  const { server, baseUrl } = await startFakeServer(state);
  const lineagePath = join(await mkdtemp(join(tmpdir(), "awefork-adapter-")), "lineage.json");
  cleanup.push(async () => {
    adapter.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const adapter = createOpencodeAdapter({ baseUrl, lineagePath });
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

  it("maps messages to text, tool names, and model id", async () => {
    const state = baseState();
    state.messages.s1?.[1]?.parts.push({ type: "tool", tool: "bash" });
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

  it("maps a failed run's error reason; successful rows carry null", async () => {
    const state = baseState();
    const a1 = state.messages.s1?.[1]?.info;
    if (a1) a1.error = { name: "APIError", data: { message: "no active subscription" } };
    const { adapter } = await newAdapter(state);
    const messages = await adapter.messages("s1");
    expect(messages[0]?.error).toBeNull();
    expect(messages[1]?.error).toBe("no active subscription");
  });

  it("lists models with ids and names only — provider secrets dropped", async () => {
    const state = baseState();
    const { adapter } = await newAdapter(state);
    const models = await adapter.listModels();
    expect(models).toEqual([
      {
        providerId: "oc-fake",
        providerName: "Fake Router",
        modelId: "glm-5.3-flash",
        modelName: "GLM 5.3 Flash",
      },
      {
        providerId: "oc-fake",
        providerName: "Fake Router",
        modelId: "gpt-5.6-sol",
        modelName: "GPT 5.6 Sol",
      },
      {
        providerId: "bare",
        providerName: "bare",
        modelId: "unnamed-model",
        modelName: "unnamed-model",
      },
    ]);
    expect(JSON.stringify(models)).not.toContain("sk-secret");
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
  });

  it("session.status busy marks a session running; real deltas stream through", async () => {
    const state = baseState();
    state.eventFrames = [
      { type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } },
      {
        type: "message.part.updated",
        properties: { sessionID: "s1", messageID: "m1", delta: "hello" },
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

  it("message.part.delta streams text deltas (opencode 1.18 shape)", async () => {
    const state = baseState();
    state.eventFrames = [
      {
        type: "message.part.delta",
        properties: {
          sessionID: "s1",
          messageID: "m1",
          partID: "p1",
          field: "text",
          delta: "he",
        },
      },
      {
        type: "message.part.delta",
        properties: {
          sessionID: "s1",
          messageID: "m1",
          partID: "p2",
          field: "thinking",
          delta: "hm",
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
      delta: "he",
    });
    expect(events).not.toContainEqual({
      type: "message.delta",
      sessionId: "s1",
      messageId: "m1",
      delta: "hm",
    });
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
});
