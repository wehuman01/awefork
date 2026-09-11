import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BackendRegistry, createBackendRegistry } from "../src/main/backend-registry";
import type { CodexJsonRpc } from "../src/main/codex-jsonrpc";
import { readBackendSelection, writeBackendSelection } from "../src/main/settings-store";
import type { BackendEventEnvelope } from "../src/shared/backend";

/**
 * The registry's collaborators are all side effects (spawns, probes, kills) —
 * each is replaced with a vi.fn; only the adapters themselves stay real, so
 * the routing/envelope/respawn contracts are exercised end to end.
 */
const mocks = vi.hoisted(() => ({
  ensureCodexServer: vi.fn(),
  isCodexInstalled: vi.fn(),
  stopCodexServer: vi.fn(),
  ensureOpencodeServer: vi.fn(),
  stopManagedServer: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock("../src/main/codex-server", () => ({
  ensureCodexServer: mocks.ensureCodexServer,
  isCodexInstalled: mocks.isCodexInstalled,
  stopCodexServer: mocks.stopCodexServer,
}));

vi.mock("../src/main/opencode-server", () => ({
  ensureOpencodeServer: mocks.ensureOpencodeServer,
  stopManagedServer: mocks.stopManagedServer,
}));

// probeInstalled() execs `opencode --version` through the real execFile; the
// mock decides whether it is "installed" so listBackends/select stay deterministic.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: mocks.execFile };
});

/** A codex client whose every request fails — enough for the prompt-failure path. */
function failingCodexClient(): CodexJsonRpc {
  return {
    request: vi.fn().mockRejectedValue(new Error("offline")),
    setNotificationHandler: vi.fn(),
    setRequestHandler: vi.fn(),
    dispose: vi.fn(),
  };
}

let userDataDir: string;
let registry: BackendRegistry;

beforeEach(async () => {
  vi.clearAllMocks();
  userDataDir = await mkdtemp(join(tmpdir(), "awefork-registry-"));
  registry = createBackendRegistry(userDataDir);
  // By default the opencode CLI "is on PATH".
  mocks.execFile.mockImplementation(
    (_file: string, _args: string[], _opts: unknown, callback: (error: Error | null) => void) => {
      callback(null);
    },
  );
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

describe("routing and adapter lifecycle", () => {
  it("resolves the opencode adapter lazily and caches it", async () => {
    mocks.ensureOpencodeServer.mockResolvedValue({
      baseUrl: "http://127.0.0.1:4096",
      spawned: true,
    });

    const first = await registry.get("opencode");
    const second = await registry.get("opencode");
    expect(first).toBe(second);
    expect(first.kind).toBe("opencode");
    expect(mocks.ensureOpencodeServer).toHaveBeenCalledTimes(1);
    expect(mocks.ensureCodexServer).not.toHaveBeenCalled();
  });

  it("builds the codex adapter from the server handshake", async () => {
    mocks.ensureCodexServer.mockResolvedValue({
      client: failingCodexClient(),
      version: "0.154.0",
      authMessage: null,
    });

    const adapter = await registry.get("codex");
    expect(adapter.kind).toBe("codex");
    expect(mocks.ensureOpencodeServer).not.toHaveBeenCalled();
  });

  it("does not cache a failed spawn — the next call retries", async () => {
    mocks.ensureCodexServer
      .mockRejectedValueOnce(new Error("spawn ENOENT"))
      .mockResolvedValue({ client: failingCodexClient(), version: null, authMessage: null });

    await expect(registry.get("codex")).rejects.toThrow("spawn ENOENT");
    await expect(registry.get("codex")).resolves.toHaveProperty("kind", "codex");
    expect(mocks.ensureCodexServer).toHaveBeenCalledTimes(2);
  });
});

describe("event envelopes", () => {
  it("forwards adapter events tagged with their backend", async () => {
    mocks.ensureCodexServer.mockResolvedValue({
      client: failingCodexClient(),
      version: null,
      authMessage: null,
    });
    const envelopes: BackendEventEnvelope[] = [];
    registry.forward((envelope) => envelopes.push(envelope));

    const adapter = await registry.get("codex");
    // The failed prompt emits its server.error envelope AND rejects — the
    // renderer arms its completion watchdog only after prompt() resolves.
    await expect(adapter.prompt("s1", "hello")).rejects.toThrow("offline");
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.backend).toBe("codex");
    expect(envelopes[0]?.event).toMatchObject({
      type: "server.error",
      sessionId: "s1",
    });
  });

  it("reports a codex crash, re-spawns lazily, and announces the reconnect once", async () => {
    let onExit: (() => void) | null = null;
    mocks.ensureCodexServer.mockImplementation((callback: () => void) => {
      onExit = callback;
      return Promise.resolve({ client: failingCodexClient(), version: null, authMessage: null });
    });
    const envelopes: BackendEventEnvelope[] = [];
    registry.forward((envelope) => envelopes.push(envelope));

    await registry.get("codex");
    expect(envelopes).toEqual([]); // no crash yet → no reconnect noise

    onExit?.();
    expect(envelopes).toEqual([
      {
        backend: "codex",
        event: { type: "server.error", message: expect.stringContaining("连接中断") },
      },
    ]);

    await registry.get("codex"); // lazy re-spawn
    expect(mocks.ensureCodexServer).toHaveBeenCalledTimes(2);
    expect(envelopes.at(-1)).toEqual({ backend: "codex", event: { type: "server.reconnected" } });

    await registry.get("codex"); // cached again: no third spawn, no second banner
    expect(mocks.ensureCodexServer).toHaveBeenCalledTimes(2);
    expect(envelopes.filter((e) => e.event.type === "server.reconnected")).toHaveLength(1);
  });
});

describe("switcher data and selection", () => {
  it("lists both backends with installed probes and the persisted selection", async () => {
    await writeBackendSelection(join(userDataDir, "settings.json"), "codex");
    mocks.isCodexInstalled.mockResolvedValue(false);

    await expect(registry.listBackends()).resolves.toEqual({
      selected: "codex",
      backends: [
        { id: "opencode", label: "opencode", installed: true },
        { id: "codex", label: "codex", installed: false },
      ],
    });
  });

  it("select probes before persisting; a missing CLI keeps the old selection", async () => {
    const settingsPath = join(userDataDir, "settings.json");
    mocks.isCodexInstalled.mockResolvedValue(false);

    const failed = await registry.select("codex");
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/codex CLI/);
    expect(await readBackendSelection(settingsPath)).toBe("opencode");

    mocks.isCodexInstalled.mockResolvedValue(true);
    await expect(registry.select("codex")).resolves.toEqual({ ok: true });
    expect(await readBackendSelection(settingsPath)).toBe("codex");
  });

  it("rejects an unknown backend id outright", async () => {
    const result = await registry.select("claude" as "codex");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/未知后端/);
  });

  it("refuses to select opencode when its CLI is missing", async () => {
    mocks.execFile.mockImplementation(
      (_file: string, _args: string[], _opts: unknown, callback: (error: Error) => void) => {
        callback(new Error("spawn opencode ENOENT"));
      },
    );
    const result = await registry.select("opencode");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/opencode CLI/);
    expect(await readBackendSelection(join(userDataDir, "settings.json"))).toBe("opencode");
  });
});

describe("capabilities and store paths", () => {
  it("mirrors the static capability table", () => {
    expect(registry.capabilities("codex")).toEqual({
      deleteMessage: false,
      attachments: false,
    });
    expect(registry.capabilities("opencode")).toEqual({
      deleteMessage: true,
      attachments: true,
    });
  });

  it("keeps opencode on legacy bare files that exist, and suffixes codex always", async () => {
    await writeFile(join(userDataDir, "pins.json"), "{}\n", "utf8");

    const opencode = registry.storePaths("opencode");
    const codex = registry.storePaths("codex");
    expect(opencode.pins).toBe(join(userDataDir, "pins.json"));
    expect(opencode.lineage).toBe(join(userDataDir, "lineage-opencode.json"));
    expect(codex.pins).toBe(join(userDataDir, "pins-codex.json"));
    expect(codex.lineage).toBe(join(userDataDir, "lineage-codex.json"));
    expect(codex.archive).toBe(join(userDataDir, "archive-codex.json"));
    expect(codex.composer).toBe(join(userDataDir, "composer-codex.json"));
    expect(opencode.composer).toBe(join(userDataDir, "composer-opencode.json"));
  });
});

describe("dispose", () => {
  it("stops both servers and clears the adapter cache", async () => {
    mocks.ensureOpencodeServer.mockResolvedValue({
      baseUrl: "http://127.0.0.1:4096",
      spawned: true,
    });
    mocks.ensureCodexServer.mockResolvedValue({
      client: failingCodexClient(),
      version: null,
      authMessage: null,
    });
    await registry.get("opencode");
    await registry.get("codex");

    registry.dispose();
    expect(mocks.stopManagedServer).toHaveBeenCalledTimes(1);
    expect(mocks.stopCodexServer).toHaveBeenCalledTimes(1);

    // After dispose the registry is cold again: a new get re-spawns.
    mocks.ensureCodexServer.mockResolvedValue({
      client: failingCodexClient(),
      version: null,
      authMessage: null,
    });
    await registry.get("codex");
    expect(mocks.ensureCodexServer).toHaveBeenCalledTimes(2);
  });
});

describe("interaction replies route by backend", () => {
  it("lands a codex interaction reply on the codex adapter's pending request", async () => {
    let onRequest: ((method: string, params: unknown) => Promise<unknown>) | null = null;
    const client: CodexJsonRpc = {
      request: vi.fn().mockResolvedValue({}),
      setNotificationHandler: vi.fn(),
      setRequestHandler: vi.fn((handler: typeof onRequest) => {
        onRequest = handler;
      }),
      dispose: vi.fn(),
    };
    mocks.ensureCodexServer.mockResolvedValue({
      client,
      version: "0.154.0",
      authMessage: null,
    });
    const envelopes: BackendEventEnvelope[] = [];
    registry.forward((envelope) => envelopes.push(envelope));

    // Subscribe installs the request handler.
    const adapter = await registry.get("codex");
    if (!onRequest) throw new Error("adapter never installed a request handler");
    const pending = onRequest("item/commandExecution/requestApproval", {
      threadId: "s1",
      command: "npm test",
    });

    // The IPC layer resolves the same cached adapter by backend argument and
    // forwards the reply; the synthetic requestId never touches the wire id.
    const routed = await registry.get("codex");
    const requested = envelopes.find((envelope) => envelope.event.type === "interaction.requested");
    if (requested?.event.type !== "interaction.requested") throw new Error("no request event");
    await routed.respondInteraction(requested.event.request.requestId, { decision: "allow" });
    await expect(pending).resolves.toEqual({ decision: "accept" });
  });

  it("treats a reply for an unknown request id as a no-op, not an error", async () => {
    mocks.ensureCodexServer.mockResolvedValue({
      client: failingCodexClient(),
      version: null,
      authMessage: null,
    });
    const adapter = await registry.get("codex");
    await expect(
      adapter.respondInteraction("codex-interaction-404", { decision: "deny" }),
    ).resolves.toBeUndefined();
  });

  it("keeps opencode's interaction responder an explicit unsupported error", async () => {
    mocks.ensureOpencodeServer.mockResolvedValue({ baseUrl: "http://127.0.0.1:1" });
    const adapter = await registry.get("opencode");
    await expect(adapter.respondInteraction("any", { decision: "deny" })).rejects.toThrow(
      "opencode has no server-originated interactions to answer",
    );
  });
});
