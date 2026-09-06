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
 *  - POST /session/:id/prompt_async fires and returns empty
 *  - GET /event streams SSE frames
 */

interface FakeMessage {
  info: { id: string; sessionID: string; role: "user" | "assistant"; time: { created: number } };
  parts: { type: string; text?: string; tool?: string }[];
}

interface FakeState {
  sessions: {
    id: string;
    title: string;
    directory: string;
    parentID?: string;
    time: { created: number; updated: number };
  }[];
  messages: Record<string, FakeMessage[]>;
  forkCalls: { sessionId: string; cutMessageId: string | null }[];
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
        res.end(JSON.stringify(state.sessions));
        return;
      }
      if (method === "GET" && url.pathname === "/event") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const frame = JSON.stringify({
          id: "evt-1",
          type: "session.idle",
          properties: { sessionID: "s1" },
        });
        res.write(`data: ${frame}\n\n`);
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

      const promptMatch = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
      if (method === "POST" && promptMatch) {
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
  };
}

function msg(id: string, role: "user" | "assistant", text: string): FakeMessage {
  return {
    info: { id, sessionID: "s1", role, time: { created: id.charCodeAt(1) } },
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

  it("maps messages to text and tool names", async () => {
    const state = baseState();
    state.messages.s1?.[1]?.parts.push({ type: "tool", tool: "bash" });
    const { adapter } = await newAdapter(state);
    const messages = await adapter.messages("s1");
    expect(messages[0]).toMatchObject({ id: "u1", role: "user", text: "first question" });
    expect(messages[1]?.toolNames).toEqual(["bash"]);
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

  it("prompt fires the async endpoint", async () => {
    const state = baseState();
    const { adapter } = await newAdapter(state);
    await expect(adapter.prompt("s1", "hello")).resolves.toBeUndefined();
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
});
