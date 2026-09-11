import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CodexRpc, createCodexAdapter } from "../src/shared/codex-adapter";
import type { AgentEvent } from "../src/shared/types";

/**
 * Scripted JSON-RPC stand-in: one handler per method (keyed on params when a
 * method is called for several threads), plus direct access to whatever
 * notification handler the adapter installed.
 */
type RequestHandler = (params: Record<string, unknown>) => unknown;

function fakeClient(handlers: Record<string, RequestHandler>) {
  const calls: Array<{ method: string; params: unknown }> = [];
  let onNotification: (method: string, params: unknown) => void = () => {};
  const client: CodexRpc = {
    async request<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      const handler = handlers[method];
      if (!handler) throw new Error(`no fixture for ${method}`);
      return handler((params ?? {}) as Record<string, unknown>) as T;
    },
    setNotificationHandler(handler) {
      onNotification = handler;
    },
  };
  return {
    client,
    calls,
    callsOf: (method: string) => calls.filter((c) => c.method === method),
    notify: (method: string, params: unknown) => onNotification(method, params),
  };
}

const dirs: string[] = [];

async function tempLineagePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "awefork-codex-"));
  dirs.push(dir);
  return join(dir, "lineage-codex.json");
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A completed turn shaped like real `thread/turns/list itemsView:"full"` data. */
const TURN_FIXTURE = {
  id: "turn-1",
  status: "completed",
  startedAt: 1726000000,
  completedAt: 1726000042,
  items: [
    {
      type: "userMessage",
      id: "u1",
      content: [{ text: "帮我看看登录接口" }, { text: "顺便看看限流" }],
    },
    {
      type: "reasoning",
      id: "r1",
      content: [{ text: "先读代码" }],
      summary: ["规划步骤"],
    },
    { type: "commandExecution", id: "c1", command: "rg login" },
    { type: "mcpToolCall", id: "m1", server: "aweshelf", tool: "search" },
    { type: "agentMessage", id: "a1", text: "登录接口在 src/auth.ts" },
  ],
};

const THREAD_FIXTURE = {
  id: "s1",
  cwd: "/demo/shop-api",
  model: "gpt-5-codex",
  modelProvider: "openai",
  reasoningEffort: "high",
  createdAt: 1726000000,
  updatedAt: 1726000042,
};

function turnPageFixture(turns: unknown[]) {
  return { data: turns, nextCursor: null };
}

describe("createCodexAdapter messages()", () => {
  it("maps a Turn into user and assistant rows, seconds → milliseconds", async () => {
    const { client } = fakeClient({
      "thread/resume": () => ({ thread: THREAD_FIXTURE }),
      "thread/turns/list": () => turnPageFixture([TURN_FIXTURE]),
    });
    const adapter = createCodexAdapter({ client, lineagePath: await tempLineagePath() });

    const rows = await adapter.messages("s1");
    expect(rows).toHaveLength(2);

    const [user, assistant] = rows;
    expect(user).toMatchObject({
      id: "u1",
      role: "user",
      text: "帮我看看登录接口\n顺便看看限流",
      createdAt: 1726000000000,
      providerId: "codex",
      modelId: "gpt-5-codex",
      variant: "high",
    });
    expect(assistant).toMatchObject({
      id: "turn-1",
      role: "assistant",
      text: "登录接口在 src/auth.ts",
      thinking: "先读代码\n\n规划步骤",
      toolNames: ["shell", "aweshelf/search"],
      createdAt: 1726000000000,
      completedAt: 1726000042000,
      finish: "stop",
    });
  });

  it("lists turns ascending and full-view, following pagination cursors", async () => {
    const { client, callsOf } = fakeClient({
      "thread/resume": () => ({ thread: THREAD_FIXTURE }),
      "thread/turns/list": (params) =>
        params.cursor === null
          ? { data: [TURN_FIXTURE], nextCursor: "page-2" }
          : turnPageFixture([
              {
                id: "turn-2",
                status: "completed",
                startedAt: 1726000100,
                completedAt: 1726000110,
                items: [{ type: "userMessage", id: "u2", content: [{ text: "继续" }] }],
              },
            ]),
    });
    const adapter = createCodexAdapter({ client, lineagePath: await tempLineagePath() });

    const rows = await adapter.messages("s1");
    expect(rows.map((r) => r.id)).toEqual(["u1", "turn-1", "u2"]);
    const listCalls = callsOf("thread/turns/list").map((c) => c.params);
    expect(listCalls[0]).toMatchObject({ threadId: "s1", sortDirection: "asc", itemsView: "full" });
    expect(listCalls[1]).toMatchObject({ cursor: "page-2" });
  });

  it("drops the assistant row when a turn produced nothing visible", async () => {
    const { client } = fakeClient({
      "thread/resume": () => ({ thread: THREAD_FIXTURE }),
      "thread/turns/list": () =>
        turnPageFixture([
          {
            id: "turn-3",
            status: "completed",
            startedAt: 1726000200,
            completedAt: 1726000201,
            items: [{ type: "userMessage", id: "u3", content: [{ text: "还在吗" }] }],
          },
        ]),
    });
    const adapter = createCodexAdapter({ client, lineagePath: await tempLineagePath() });
    expect(await adapter.messages("s1")).toHaveLength(1);
  });
});

describe("createCodexAdapter listSessions()", () => {
  it("paginates thread/list and sorts newest-first with title fallbacks", async () => {
    const { client } = fakeClient({
      "thread/list": (params) =>
        params.cursor === null
          ? {
              data: [
                {
                  id: "t1",
                  name: null,
                  preview: "预览文本",
                  cwd: "/a",
                  createdAt: 100,
                  updatedAt: 300,
                },
                { id: "t2", name: null, preview: null, cwd: "/b", createdAt: 100, updatedAt: 500 },
              ],
              nextCursor: "p2",
            }
          : {
              data: [
                {
                  id: "t3",
                  name: "命名会话",
                  forkedFromId: "t1",
                  cwd: "/c",
                  createdAt: 100,
                  updatedAt: 400,
                },
              ],
              nextCursor: null,
            },
    });
    const adapter = createCodexAdapter({ client, lineagePath: await tempLineagePath() });

    const sessions = await adapter.listSessions();
    expect(sessions.map((s) => s.id)).toEqual(["t2", "t3", "t1"]);
    expect(sessions.map((s) => s.title)).toEqual(["(未命名会话)", "命名会话", "预览文本"]);
    expect(sessions.find((s) => s.id === "t3")).toMatchObject({
      parentSessionId: "t1",
      origin: "fork",
    });
    expect(sessions.find((s) => s.id === "t2")?.origin).toBe("root");
  });
});

describe("createCodexAdapter listModels()", () => {
  it("flattens pages, hides hidden models, and derives variants and attachment", async () => {
    const { client } = fakeClient({
      "model/list": () => ({
        data: [
          {
            id: "gpt-5",
            displayName: "GPT-5",
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
            inputModalities: ["text", "image"],
          },
          { id: "secret", displayName: "Secret", hidden: true },
          { id: "bare", displayName: null, hidden: false },
        ],
        nextCursor: null,
      }),
    });
    const adapter = createCodexAdapter({ client, lineagePath: await tempLineagePath() });

    const models = await adapter.listModels();
    expect(models.map((m) => m.modelId)).toEqual(["gpt-5", "bare"]);
    const gpt5 = models[0];
    expect(gpt5).toMatchObject({
      providerId: "codex",
      providerName: "Codex",
      modelName: "GPT-5",
      variants: ["low", "high"],
      attachment: true,
    });
    expect(models[1]).toMatchObject({
      modelName: "bare",
      variants: ["low", "medium", "high"],
      attachment: false,
    });
  });
});

describe("createCodexAdapter fork()", () => {
  it("translates atMessageId to the containing turn and sends lastTurnId on 0.154+", async () => {
    const { client, callsOf } = fakeClient({
      "thread/turns/list": () => turnPageFixture([TURN_FIXTURE]),
      "thread/fork": () => ({
        thread: {
          id: "fork-1",
          forkedFromId: "s1",
          cwd: "/demo",
          createdAt: 1726000099,
          updatedAt: 1726000099,
        },
      }),
    });
    const lineagePath = await tempLineagePath();
    const adapter = createCodexAdapter({ client, lineagePath, cliVersion: "0.154.0" });

    const forked = await adapter.fork("s1", "u1");
    expect(forked).toMatchObject({ id: "fork-1", origin: "fork", parentSessionId: "s1" });
    expect(callsOf("thread/fork")[0]?.params).toMatchObject({
      threadId: "s1",
      lastTurnId: "turn-1",
    });
    const saved = JSON.parse(await readFile(lineagePath, "utf8"));
    expect(saved["fork-1"]).toMatchObject({ parentId: "s1", atMessageId: "u1" });
  });

  it("forks without a cut point when atMessageId is null", async () => {
    const { client, callsOf } = fakeClient({
      "thread/fork": () => ({
        thread: { id: "fork-2", forkedFromId: "s1", cwd: "/demo", createdAt: 1, updatedAt: 1 },
      }),
    });
    const adapter = createCodexAdapter({ client, lineagePath: await tempLineagePath() });

    const forked = await adapter.fork("s1", null);
    expect(forked.id).toBe("fork-2");
    expect(callsOf("thread/turns/list")).toHaveLength(0);
    expect(callsOf("thread/fork")[0]?.params).toEqual({ threadId: "s1" });
  });

  it("falls back to fork + rollback when the CLI predates lastTurnId", async () => {
    const { client, callsOf } = fakeClient({
      "thread/turns/list": (params) =>
        (params as { threadId?: string }).threadId === "fork-1"
          ? turnPageFixture([TURN_FIXTURE, { id: "turn-2", items: [] }])
          : turnPageFixture([TURN_FIXTURE]),
      "thread/fork": () => ({
        thread: { id: "fork-1", forkedFromId: "s1", cwd: "/demo", createdAt: 1, updatedAt: 1 },
      }),
      "thread/rollback": () => ({}),
    });
    const adapter = createCodexAdapter({
      client,
      lineagePath: await tempLineagePath(),
      cliVersion: "0.150.0",
    });

    await adapter.fork("s1", "u1");
    expect(callsOf("thread/fork")[0]?.params).toEqual({ threadId: "s1" });
    expect(callsOf("thread/rollback")[0]?.params).toEqual({
      threadId: "fork-1",
      numTurns: 1,
    });
  });

  it("rejects when the message id belongs to no turn", async () => {
    const { client } = fakeClient({
      "thread/turns/list": () => turnPageFixture([]),
    });
    const adapter = createCodexAdapter({ client, lineagePath: await tempLineagePath() });
    await expect(adapter.fork("s1", "ghost")).rejects.toThrow(/not found in session s1/);
  });
});

describe("createCodexAdapter prompt/abort", () => {
  it("starts a turn with model + effort and aborts via the active turn pair", async () => {
    const { client, callsOf } = fakeClient({
      "turn/start": () => ({ turn: { id: "turn-9" } }),
      "turn/interrupt": () => ({}),
    });
    const adapter = createCodexAdapter({ client, lineagePath: await tempLineagePath() });

    await adapter.prompt("s1", "你好", { providerId: "codex", modelId: "gpt-5", variant: "low" });
    expect(callsOf("turn/start")[0]?.params).toMatchObject({
      threadId: "s1",
      input: [{ type: "text", text: "你好" }],
      model: "gpt-5",
      effort: "low",
    });

    await adapter.abort("s1");
    expect(callsOf("turn/interrupt")[0]?.params).toEqual({
      threadId: "s1",
      turnId: "turn-9",
    });
  });

  it("throws when aborting a session with no active turn", async () => {
    const { client } = fakeClient({});
    const adapter = createCodexAdapter({ client, lineagePath: await tempLineagePath() });
    await expect(adapter.abort("s1")).rejects.toThrow("该会话当前没有正在运行的回合");
  });

  it("emits server.error with the session id when turn/start fails", async () => {
    const { client } = fakeClient({
      "turn/start": () => {
        throw new Error("Usage limit reached");
      },
    });
    const adapter = createCodexAdapter({ client, lineagePath: await tempLineagePath() });
    const events: AgentEvent[] = [];
    adapter.subscribe((event) => events.push(event));

    await adapter.prompt("s1", "hi");
    expect(events).toEqual([
      {
        type: "server.error",
        sessionId: "s1",
        message: "codex prompt failed: Usage limit reached",
      },
    ]);
  });
});

describe("createCodexAdapter notification mapping", () => {
  async function subscribedAdapter(
    handlers: Record<string, RequestHandler>,
  ): Promise<{ notify: (method: string, params: unknown) => void; events: AgentEvent[] }> {
    const fake = fakeClient(handlers);
    const adapter = createCodexAdapter({
      client: fake.client,
      lineagePath: await tempLineagePath(),
    });
    const events: AgentEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    return { notify: fake.notify, events };
  }

  it("maps turn lifecycle: started → message.started, completed → idle", async () => {
    const { notify, events } = await subscribedAdapter({});
    notify("turn/started", { threadId: "s1", turn: { id: "turn-5" } });
    notify("turn/completed", { threadId: "s1", turn: { id: "turn-5" } });
    expect(events).toEqual([
      { type: "message.started", sessionId: "s1", messageId: "turn-5" },
      { type: "session.idle", sessionId: "s1" },
    ]);
  });

  it("reports a failed turn as server.error before idle", async () => {
    const { notify, events } = await subscribedAdapter({});
    notify("turn/completed", {
      threadId: "s1",
      turn: { id: "turn-5", error: { message: "context overflow" } },
    });
    expect(events.map((e) => e.type)).toEqual(["server.error", "session.idle"]);
    expect(events[0]).toMatchObject({ sessionId: "s1", message: "codex: context overflow" });
  });

  it("maps stream deltas: agent text, reasoning, and summary parts", async () => {
    const { notify, events } = await subscribedAdapter({});
    notify("item/agentMessage/delta", {
      threadId: "s1",
      turnId: "turn-5",
      itemId: "a1",
      delta: "he",
    });
    notify("item/reasoning/textDelta", {
      threadId: "s1",
      turnId: "turn-5",
      itemId: "r1",
      delta: "想",
    });
    notify("item/reasoning/summaryTextDelta", {
      threadId: "s1",
      turnId: "turn-5",
      itemId: "r1",
      delta: "摘",
    });
    expect(events).toEqual([
      {
        type: "message.delta",
        sessionId: "s1",
        messageId: "turn-5",
        partId: "a1",
        kind: "text",
        delta: "he",
      },
      {
        type: "message.delta",
        sessionId: "s1",
        messageId: "turn-5",
        partId: "r1",
        kind: "thinking",
        delta: "想",
      },
      {
        type: "message.delta",
        sessionId: "s1",
        messageId: "turn-5",
        partId: "r1:summary",
        kind: "thinking",
        delta: "摘",
      },
    ]);
  });

  it("maps item lifecycle snapshots with millisecond timestamps intact", async () => {
    const { notify, events } = await subscribedAdapter({});
    notify("item/started", {
      threadId: "s1",
      turnId: "turn-5",
      startedAtMs: 1726000000123,
      item: { type: "agentMessage", id: "a1", text: "" },
    });
    notify("item/completed", {
      threadId: "s1",
      turnId: "turn-5",
      completedAtMs: 1726000009876,
      item: { type: "agentMessage", id: "a1", text: "完整回复" },
    });
    expect(events).toEqual([
      {
        type: "message.part",
        sessionId: "s1",
        messageId: "turn-5",
        partId: "a1",
        kind: "text",
        text: "",
        startedAt: 1726000000123,
        endedAt: null,
      },
      {
        type: "message.part",
        sessionId: "s1",
        messageId: "turn-5",
        partId: "a1",
        kind: "text",
        text: "完整回复",
        startedAt: null,
        endedAt: 1726000009876,
      },
    ]);
  });

  it("maps thread status changes and structural updates", async () => {
    const { notify, events } = await subscribedAdapter({});
    notify("thread/status/changed", { threadId: "s1", status: { type: "active" } });
    notify("thread/status/changed", { threadId: "s1", status: { type: "idle" } });
    notify("thread/name/updated", { threadId: "s1" });
    expect(events).toEqual([
      { type: "message.started", sessionId: "s1", messageId: "" },
      { type: "session.idle", sessionId: "s1" },
      { type: "session.updated", sessionId: "s1" },
    ]);
  });

  it("surfaces fatal error notifications but skips ones codex will retry", async () => {
    const { notify, events } = await subscribedAdapter({});
    notify("error", { threadId: "s1", willRetry: true, error: { message: "transient" } });
    expect(events).toHaveLength(0);
    notify("error", { threadId: "s1", willRetry: false, error: { message: "stream dead" } });
    expect(events).toEqual([
      { type: "server.error", sessionId: "s1", message: "codex: stream dead" },
    ]);
  });

  it("emits the auth banner once at subscribe time", async () => {
    const fake = fakeClient({});
    const adapter = createCodexAdapter({
      client: fake.client,
      lineagePath: await tempLineagePath(),
      authMessage: "codex 未登录或无可用账号",
    });
    const events: AgentEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    expect(events).toEqual([{ type: "server.error", message: "codex 未登录或无可用账号" }]);
  });
});

describe("createCodexAdapter unsupported surfaces", () => {
  it("returns no attachments and refuses single-message delete", async () => {
    const { client } = fakeClient({});
    const adapter = createCodexAdapter({ client, lineagePath: await tempLineagePath() });
    expect(await adapter.messageAttachments("s1", "u1")).toEqual([]);
    await expect(adapter.deleteMessage("s1", "u1")).rejects.toThrow(
      "codex does not support deleting a single message",
    );
  });

  it("deletes a thread and its lineage record", async () => {
    const { client, callsOf } = fakeClient({
      "thread/delete": () => ({}),
    });
    const lineagePath = await tempLineagePath();
    const adapter = createCodexAdapter({ client, lineagePath });
    // Seed a lineage entry to verify the delete prunes it.
    const { recordFork } = await import("../src/shared/lineage-store");
    await recordFork(lineagePath, "s1", { parentId: "root", atMessageId: null, createdAt: 1 });

    await adapter.deleteSession("s1");
    expect(callsOf("thread/delete")[0]?.params).toEqual({ threadId: "s1" });
    expect(JSON.parse(await readFile(lineagePath, "utf8"))).toEqual({});
  });
});
