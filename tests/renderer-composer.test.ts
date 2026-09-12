import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AweforkApi } from "../src/shared/awefork-api";
import type { BackendEventEnvelope, BackendId } from "../src/shared/backend";
import type {
  ChatMessage,
  ModelChoice,
  PersistedComposer,
  SessionSummary,
} from "../src/shared/types";

/**
 * Composer-persistence × backend-switch regression harness: the state module
 * is a singleton, so every test boots a fresh instance via vi.resetModules +
 * dynamic import, backed by a scripted window.awefork. The app starts on
 * opencode with session s1; codex boots with session c1.
 */

const OPENCODE: SessionSummary = {
  id: "s1",
  title: "登录接口排查",
  directory: "/demo/shop-api",
  parentSessionId: null,
  origin: "root",
  createdAt: 1_726_000_000_000,
  updatedAt: 1_726_000_000_000,
};

const CODEX: SessionSummary = {
  id: "c1",
  title: "codex 会话",
  directory: "/demo/shop-api",
  parentSessionId: null,
  origin: "root",
  createdAt: 1_726_000_000_000,
  updatedAt: 1_726_000_000_000,
};

const MODEL: ModelChoice = { providerId: "oc", modelId: "glm-5.3" };

/** A mid-story turn node: openDraft turns it into a fork-branch draft. */
function turnNode() {
  return {
    id: "s1:m1",
    kind: "turn" as const,
    sessionId: "s1",
    messageId: "m1",
    title: "第一轮",
    preview: "",
    toolNames: [],
    modelIds: [],
    model: null,
    createdAt: 1,
    durationMs: null,
    outputTokens: 0,
    error: null,
    col: 0,
    row: 0,
    x: 0,
    y: 0,
    height: 100,
  };
}

async function bootState(
  options: { composer?: PersistedComposer | null; messages?: Record<string, ChatMessage[]> } = {},
) {
  vi.resetModules();
  const saves: Array<{ backend: BackendId; value: PersistedComposer | null }> = [];
  let forkDeferred: ((session: SessionSummary) => void) | null = null;
  const api: AweforkApi = {
    ready: async () => ({ ok: true }),
    sessions: vi.fn(async (backend: BackendId) =>
      backend === "codex"
        ? { sessions: [CODEX], lineage: {} }
        : { sessions: [OPENCODE], lineage: {} },
    ),
    messages: vi.fn(
      async (_backend: BackendId, sessionId: string) => options.messages?.[sessionId] ?? [],
    ),
    models: async () => [],
    messageAttachments: async () => [],
    createSession: async () => OPENCODE,
    fork: vi.fn(
      () =>
        new Promise<SessionSummary>((resolve) => {
          forkDeferred = resolve;
        }),
    ),
    deleteSession: async () => [],
    deleteMessage: async () => {},
    prompt: vi.fn(async () => {}),
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
    composer: vi.fn(async () => options.composer ?? null),
    saveComposer: vi.fn(async (backend: BackendId, value: PersistedComposer | null) => {
      saves.push({ backend, value });
    }),
    backends: async () => ({
      selected: "opencode",
      backends: [
        { id: "opencode", label: "opencode", installed: true },
        { id: "codex", label: "codex", installed: true },
      ],
    }),
    selectBackend: async () => ({ ok: true }),
    capabilities: async () => ({ deleteMessage: true, attachments: true }),
    openPath: async () => ({ ok: true }),
    openExternal: async () => {},
    convertDocument: async () => "",
    checkUpdates: async () => ({
      currentVersion: "0.2.1",
      latest: null,
      updateAvailable: false,
    }),
    skipUpdate: async () => ({ ok: true }),
    openRelease: async () => ({ ok: true }),
    fileChanges: async () => null,
    fileChangeDiff: async () => null,
    onEvent: (_handler: (envelope: BackendEventEnvelope) => void) => () => {},
  };
  (globalThis as unknown as { window: { awefork: AweforkApi } }).window = { awefork: api };
  const state = await import("../src/renderer/src/state");
  await state.init();
  return {
    store: state.store,
    mod: state,
    api,
    saves,
    resolveFork: (session: SessionSummary = OPENCODE) => forkDeferred?.(session),
    openDraft: state.openDraft,
    setDraftText: state.setDraftText,
    sendDraft: state.sendDraft,
    switchBackend: state.switchBackend,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("composer persistence × backend switch", () => {
  it("aborts the send when the backend switches mid-fork and keeps both drafts", async () => {
    const codexDraft = {
      draft: {
        sessionId: "c1",
        atMessageId: null,
        text: "codex 未发送草稿",
        model: null,
        attachments: [],
      },
      paneModels: {},
    };
    const h = await bootState({ composer: codexDraft });
    // Mid-story draft on opencode → sendDraft goes through the fork branch.
    h.openDraft(turnNode());
    h.setDraftText("hello");

    const sending = h.sendDraft();
    // Switch while the fork request is still in flight.
    await h.switchBackend("codex");
    h.resolveFork();
    await sending;

    // The send never fired: no prompt, no running card, no optimistic row.
    expect(h.api.prompt).not.toHaveBeenCalled();
    expect(h.store.running.s1).toBeFalsy();
    expect(h.store.draftSending).toBe(false);
    // The outgoing backend kept its unsent draft (flushed at switch time)…
    expect(h.saves).toContainEqual({
      backend: "opencode",
      value: expect.objectContaining({
        draft: expect.objectContaining({ text: "hello" }),
      }),
    });
    // …and the restored codex draft is still on screen — the stale send
    // must not null it out or write it away.
    expect(h.store.draft?.text).toBe("codex 未发送草稿");
    expect(h.saves).not.toContainEqual({ backend: "codex", value: null });
  });

  it("clears the sidecar as soon as the draft is sent, not on the debounce", async () => {
    const h = await bootState();
    h.openDraft(turnNode());
    h.setDraftText("hello");

    const sending = h.sendDraft();
    // Let the send pass its flush and reach the fork call before resolving.
    await vi.advanceTimersByTimeAsync(0);
    h.resolveFork();
    await sending;

    expect(h.api.prompt).toHaveBeenCalledWith("opencode", "s1", "hello", null, []);
    expect(h.store.draft).toBeNull();
    // Without advancing the 600ms debounce — a crash right after sending
    // must not resurrect the sent draft.
    expect(h.saves).toContainEqual({ backend: "opencode", value: null });
  });

  it("filters restored pane model picks down to sessions that still exist", async () => {
    const h = await bootState({
      composer: { draft: null, paneModels: { s1: MODEL, gone: MODEL } },
    });
    // Let the void-restore settle without arming the debounce flush.
    await vi.advanceTimersByTimeAsync(0);

    expect(h.store.paneModels).toEqual({ s1: MODEL });
  });
});

/**
 * Pane composer model following: with no explicit pick the composer mirrors
 * the selected branch's own last-used model+variant, and only a hand-picked
 * model (or a deliberate 默认模型) overrides it.
 */
describe("pane composer follows the selected session", () => {
  /** One ChatMessage with only the fields the tests care about. */
  function row(
    id: string,
    role: "user" | "assistant",
    model: { modelId: string; variant: string | null },
  ): ChatMessage {
    return {
      id,
      role,
      text: role === "user" ? "第一轮" : "回复",
      thinking: "",
      toolNames: [],
      modelId: model.modelId,
      providerId: "oc",
      variant: model.variant,
      attachmentNames: [],
      createdAt: 1,
      completedAt: role === "assistant" ? 10 : null,
      finish: null,
      outputTokens: null,
      error: null,
    };
  }

  it("derives model and thinking variant from the session's last turn", async () => {
    const h = await bootState({
      messages: {
        s1: [
          row("m1", "user", { modelId: "glm-5.3", variant: null }),
          row("m2", "assistant", { modelId: "glm-5.3", variant: "high" }),
        ],
      },
    });

    // The pane is on the session's latest turn, so the composer shows what
    // wrote it — variant included — without the user picking anything.
    expect(h.mod.paneComposerModel.value).toEqual({
      providerId: "oc",
      modelId: "glm-5.3",
      variant: "high",
    });
  });

  it("an explicit pick — model or 默认模型 — wins over the derived one", async () => {
    const h = await bootState({
      messages: {
        s1: [
          row("m1", "user", { modelId: "glm-5.3", variant: null }),
          row("m2", "assistant", { modelId: "glm-5.3", variant: "high" }),
        ],
      },
    });

    h.mod.setPaneModel("s1", { providerId: "oc", modelId: "glm-5.3-flash", variant: null });
    expect(h.mod.paneComposerModel.value).toEqual({
      providerId: "oc",
      modelId: "glm-5.3-flash",
      variant: null,
    });

    h.mod.setPaneModel("s1", null);
    expect(h.mod.paneComposerModel.value).toBeNull();
  });

  it("sends with the derived model when the user never picked one", async () => {
    const h = await bootState({
      messages: {
        s1: [
          row("m1", "user", { modelId: "glm-5.3", variant: null }),
          row("m2", "assistant", { modelId: "glm-5.3", variant: "high" }),
        ],
      },
    });

    await h.mod.sendPanePrompt("继续");
    expect(h.api.prompt).toHaveBeenCalledWith(
      "opencode",
      "s1",
      "继续",
      { providerId: "oc", modelId: "glm-5.3", variant: "high" },
      [],
    );
  });

  it("falls back to 默认模型 for a session with no model-bearing turns", async () => {
    const h = await bootState({ messages: { s1: [] } });

    expect(h.mod.paneComposerModel.value).toBeNull();
  });
});
