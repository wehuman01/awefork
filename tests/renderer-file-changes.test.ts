import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AweforkApi } from "../src/shared/awefork-api";
import type { BackendEventEnvelope, BackendId } from "../src/shared/backend";
import type { ChatMessage, SessionFileChanges, SessionSummary } from "../src/shared/types";

/**
 * File-change loading × the renderer state module: the pane's card data
 * arrives through window.awefork.fileChanges, rides the first message load,
 * and refreshes again when a run settles.
 */

const SESSION: SessionSummary = {
  id: "s1",
  title: "改几个文件",
  directory: "/demo/shop-api",
  parentSessionId: null,
  origin: "root",
  createdAt: 1,
  updatedAt: 1,
};

function message(
  id: string,
  role: "user" | "assistant",
  over: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    role,
    text: role === "user" ? "改一下" : "done",
    thinking: "",
    toolNames: role === "assistant" ? ["edit"] : [],
    modelId: null,
    providerId: null,
    variant: null,
    attachmentNames: [],
    createdAt: 1,
    completedAt: 1,
    finish: null,
    outputTokens: null,
    error: null,
    ...over,
  };
}

const CHANGES: SessionFileChanges = {
  version: 1,
  tools: ["edit", "write"],
  messages: {
    a1: [
      {
        path: "/demo/shop-api/src/app.ts",
        status: "modified",
        added: 3,
        removed: 1,
        note: null,
        before: "0.before",
        after: "0.after",
      },
    ],
  },
};

let emitEvent: ((envelope: BackendEventEnvelope) => void) | null = null;

async function bootState(options: { changes?: SessionFileChanges | null } = {}) {
  vi.resetModules();
  const fileChangesCalls: string[] = [];
  const api: AweforkApi = {
    ready: async () => ({ ok: true }),
    sessions: async () => ({ sessions: [SESSION], lineage: {} }),
    messages: async () => [message("u1", "user"), message("a1", "assistant")],
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
    fileChanges: vi.fn(async (_backend: BackendId, sessionId: string) => {
      fileChangesCalls.push(sessionId);
      return options.changes ?? null;
    }),
    fileChangeDiff: async () => null,
    backends: async () => ({
      selected: "opencode",
      backends: [{ id: "opencode", label: "opencode", installed: true }],
    }),
    selectBackend: async () => ({ ok: true }),
    capabilities: async () => ({ deleteMessage: true, attachments: true, fileChanges: true }),
    openPath: async () => ({ ok: true }),
    openExternal: async () => {},
    convertDocument: async () => "",
    checkUpdates: async () => ({ currentVersion: "0.2.2", latest: null, updateAvailable: false }),
    skipUpdate: async () => ({ ok: true }),
    openRelease: async () => ({ ok: true }),
    onEvent: (handler) => {
      emitEvent = handler;
      return () => {
        emitEvent = null;
      };
    },
  };
  (globalThis as unknown as { window: { awefork: AweforkApi } }).window = { awefork: api };
  const state = await import("../src/renderer/src/state");
  await state.init();
  return { store: state.store, api, fileChangesCalls, state };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  emitEvent = null;
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("file-change loading", () => {
  it("loads the index with the session's first message load", async () => {
    const h = await bootState({ changes: CHANGES });
    await h.state.selectSession("s1");
    expect(h.store.fileChangesBySession.s1).toEqual(CHANGES);
  });

  it("resolves a missing sidecar to null and records the fetch", async () => {
    const h = await bootState({ changes: null });
    await h.state.selectSession("s1");
    expect(h.store.fileChangesBySession.s1).toBeNull();
    expect(h.fileChangesCalls).toContain("s1");
  });

  it("refreshes the index when a run settles", async () => {
    const h = await bootState({ changes: null });
    await h.state.selectSession("s1");
    const before = h.fileChangesCalls.length;
    emitEvent?.({ backend: "opencode", event: { type: "session.idle", sessionId: "s1" } });
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.fileChangesCalls.length).toBeGreaterThan(before);
  });
});
