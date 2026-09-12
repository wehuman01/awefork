import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AweforkApi } from "../src/shared/awefork-api";
import type { BackendEventEnvelope } from "../src/shared/backend";
import type { AgentEvent, ChatMessage, SessionSummary } from "../src/shared/types";

/**
 * Run-settle tint harness: the state module is a singleton, so every test
 * boots a fresh instance via vi.resetModules + dynamic import, backed by a
 * scripted window.awefork. The scripted s1 messages decide how the run
 * ended — a set error on the last assistant row or a clean null. Fake
 * timers drive the tint's five-minute fade.
 */

const SESSION: SessionSummary = {
  id: "s1",
  title: "登录接口排查",
  directory: "/demo/shop-api",
  parentSessionId: null,
  origin: "root",
  createdAt: 1_726_000_000_000,
  updatedAt: 1_726_000_000_000,
};

const USER_ROW: ChatMessage = {
  id: "m1",
  role: "user",
  text: "帮我修一下登录接口",
  thinking: "",
  toolNames: [],
  modelId: null,
  providerId: null,
  variant: null,
  attachmentNames: [],
  createdAt: 1,
  completedAt: 1,
  finish: null,
  outputTokens: null,
  error: null,
};

function assistantRow(error: string | null): ChatMessage {
  return { ...USER_ROW, id: "m2", role: "assistant", text: "修好了", error };
}

async function bootState(options: { runError?: string | null } = {}) {
  vi.resetModules();
  const rows = [USER_ROW, assistantRow(options.runError ?? null)];
  let onEnvelope: ((envelope: BackendEventEnvelope) => void) | null = null;
  const api: AweforkApi = {
    ready: async () => ({ ok: true }),
    sessions: async () => ({ sessions: [SESSION], lineage: {} }),
    messages: async () => rows,
    models: async () => [],
    messageAttachments: async () => [],
    createSession: async () => SESSION,
    fork: async () => SESSION,
    deleteSession: async () => [],
    deleteMessage: async () => {},
    prompt: async () => {},
    abort: async () => {},
    respondInteraction: async () => {},
    renameSession: async () => {},
    openSessionTerminal: async () => ({ ok: true }),
    pins: async () => [],
    togglePin: async () => [],
    trash: async () => [],
    trashAdd: async () => [],
    trashRemove: async () => [],
    archive: async () => ({ sessions: [], directories: [] }),
    archiveAdd: async () => ({ sessions: [], directories: [] }),
    archiveRemove: async () => ({ sessions: [], directories: [] }),
    composer: async () => null,
    saveComposer: async () => {},
    backends: async () => ({
      selected: "codex",
      backends: [
        { id: "codex", label: "codex", installed: true, version: null, versionWarning: null },
      ],
    }),
    selectBackend: async () => ({ ok: true }),
    capabilities: async () => ({ deleteMessage: true, attachments: true }),
    openPath: async () => ({ ok: true }),
    openExternal: async () => {},
    convertDocument: async () => "",
    checkUpdates: async () => ({
      currentVersion: "0.2.5",
      latest: null,
      updateAvailable: false,
    }),
    skipUpdate: async () => ({ ok: true }),
    openRelease: async () => ({ ok: true }),
    fileChanges: async () => null,
    fileChangeDiff: async () => null,
    onEvent: (handler: (envelope: BackendEventEnvelope) => void) => {
      onEnvelope = handler;
      return () => {};
    },
  };
  (globalThis as unknown as { window: { awefork: AweforkApi } }).window = { awefork: api };
  const state = await import("../src/renderer/src/state");
  await state.init();
  return {
    store: state.store,
    alphaFor: state.recentAlphaFor,
    send: (event: AgentEvent) => onEnvelope?.({ backend: "codex", event }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { window?: unknown }).window;
});

/** Drive a started → idle run, flushing the async finishRun chain. */
async function runAndSettle(h: Awaited<ReturnType<typeof bootState>>): Promise<void> {
  h.send({ type: "message.started", sessionId: "s1", messageId: "m2" });
  h.send({ type: "session.idle", sessionId: "s1" });
  await vi.advanceTimersByTimeAsync(1_000);
}

describe("renderer run settle", () => {
  it("stamps the recent tint on a completed run and clears it after five minutes", async () => {
    const h = await bootState();
    await runAndSettle(h);
    expect(h.store.running.s1).toBeFalsy();
    expect(h.alphaFor("s1")).toBe(1);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.store.recent.s1).toBeUndefined();
    expect(h.alphaFor("s1")).toBe(0);
  });

  it("leaves no tint when the run's last assistant row errored", async () => {
    const h = await bootState({ runError: "codex: provider 500" });
    await runAndSettle(h);
    expect(h.store.running.s1).toBeFalsy();
    expect(h.store.recent.s1).toBeUndefined();
    expect(h.alphaFor("s1")).toBe(0);
  });

  it("drops a previous run's tint when a rerun fails in flight", async () => {
    const h = await bootState();
    await runAndSettle(h);
    expect(h.alphaFor("s1")).toBe(1);

    h.send({ type: "message.started", sessionId: "s1", messageId: "m4" });
    h.send({ type: "server.error", message: "codex server died", sessionId: "s1" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.store.running.s1).toBeFalsy();
    expect(h.store.recent.s1).toBeUndefined();
    expect(h.alphaFor("s1")).toBe(0);
  });

  it("settles a transport failure without the tint", async () => {
    const h = await bootState();
    h.send({ type: "message.started", sessionId: "s1", messageId: "m2" });
    h.send({ type: "server.error", message: "connection reset", sessionId: "s1" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.store.running.s1).toBeFalsy();
    expect(h.store.recent.s1).toBeUndefined();
    expect(h.alphaFor("s1")).toBe(0);
  });
});
