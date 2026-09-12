import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BackendRegistry,
  createBackendRegistry,
  probeOpencode,
} from "../src/main/backend-registry";
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
  resolveSpawnEnv: vi.fn(),
  execFile: vi.fn(),
  discoverCodexHomes: vi.fn(),
}));

vi.mock("../src/main/codex-server.js", () => ({
  ensureCodexServer: mocks.ensureCodexServer,
  isCodexInstalled: mocks.isCodexInstalled,
  stopCodexServer: mocks.stopCodexServer,
}));

// Keep home discovery synthetic: the real probe would pick up whatever
// aweswitch accounts exist on the dev machine and skew spawn counts.
vi.mock("../src/main/codex-homes.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/main/codex-homes.js")>()),
  discoverCodexHomes: mocks.discoverCodexHomes,
}));

vi.mock("../src/main/opencode-server", () => ({
  ensureOpencodeServer: mocks.ensureOpencodeServer,
  stopManagedServer: mocks.stopManagedServer,
  resolveSpawnEnv: mocks.resolveSpawnEnv,
}));

// probeOpencode() execs `opencode --version` through the real execFile; the
// mock decides whether it is "installed" so listBackends/select stay deterministic.
// The real execFile carries a util.promisify.custom that resolves to
// {stdout, stderr}; a bare vi.fn() lacks it, and plain promisify would resolve
// to the first callback argument (the stdout string) — so the custom symbol is
// replicated here to keep the promisified contract faithful.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFileWithPromisify = Object.assign(mocks.execFile, {
    [Symbol.for("nodejs.util.promisify.custom")](
      file: string,
      args: readonly string[],
      options?: unknown,
    ) {
      return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        mocks.execFile(
          file,
          args,
          options,
          (error: Error | null, stdout: string, stderr: string) => {
            if (error) reject(error);
            else resolve({ stdout, stderr });
          },
        );
      });
    },
  });
  return { ...actual, execFile: execFileWithPromisify };
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

/** A codex client answering list paging with no sessions. */
function listCodexClient(): CodexJsonRpc {
  return {
    request: vi.fn().mockResolvedValue({ data: [], nextCursor: null }),
    setNotificationHandler: vi.fn(),
    setRequestHandler: vi.fn(),
    dispose: vi.fn(),
  };
}

function mockDefaultHomeOnly(): void {
  mocks.discoverCodexHomes.mockReturnValue([
    { path: "/homes/default", id: "default", label: "Codex" },
  ]);
}

let userDataDir: string;
let registry: BackendRegistry;

beforeEach(async () => {
  vi.clearAllMocks();
  mockDefaultHomeOnly();
  // Passthrough so probeOpencode's env handling runs against a stable object.
  mocks.resolveSpawnEnv.mockImplementation(async (env: unknown) => env);
  userDataDir = await mkdtemp(join(tmpdir(), "awefork-registry-"));
  registry = createBackendRegistry(userDataDir);
  // By default the opencode CLI "is on PATH" with a version inside the
  // descriptor's tested range, so no compat warning fires.
  mocks.execFile.mockImplementation(
    (
      _file: string,
      _args: string[],
      _opts: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      callback(null, "1.18.30\n", "");
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

  it("creates the codex facade without spawning until first used", async () => {
    mocks.ensureCodexServer.mockResolvedValue({
      client: listCodexClient(),
      version: "0.154.0",
      authMessage: null,
    });

    const adapter = await registry.get("codex");
    expect(adapter.kind).toBe("codex");
    // Spawning is deferred to the first home-touching call, not get().
    expect(mocks.ensureCodexServer).not.toHaveBeenCalled();
    await adapter.listSessions();
    expect(mocks.ensureCodexServer).toHaveBeenCalledTimes(1);
    expect(mocks.ensureOpencodeServer).not.toHaveBeenCalled();
  });

  it("does not cache a failed home spawn — the next call retries", async () => {
    mocks.ensureCodexServer.mockResolvedValue({
      client: listCodexClient(),
      version: null,
      authMessage: null,
    });
    const adapter = await registry.get("codex");

    mocks.ensureCodexServer.mockRejectedValueOnce(new Error("spawn ENOENT"));
    await expect(adapter.listSessions()).rejects.toThrow("spawn ENOENT");
    await expect(adapter.listSessions()).resolves.toEqual([]);
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
      return Promise.resolve({ client: listCodexClient(), version: null, authMessage: null });
    });
    const envelopes: BackendEventEnvelope[] = [];
    registry.forward((envelope) => envelopes.push(envelope));

    const adapter = await registry.get("codex");
    await adapter.listSessions(); // first use materializes the home server
    expect(envelopes).toEqual([]); // no crash yet → no reconnect noise

    onExit?.();
    expect(envelopes).toEqual([
      {
        backend: "codex",
        event: { type: "server.error", message: expect.stringContaining("连接中断") },
      },
    ]);

    await adapter.listSessions(); // lazy re-spawn
    expect(mocks.ensureCodexServer).toHaveBeenCalledTimes(2);
    expect(envelopes.at(-1)).toEqual({ backend: "codex", event: { type: "server.reconnected" } });

    await adapter.listSessions(); // cached again: no third spawn, no second banner
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
        {
          id: "opencode",
          label: "opencode",
          installed: true,
          version: "1.18.30",
          versionWarning: null,
        },
        { id: "codex", label: "codex", installed: false, version: null, versionWarning: null },
      ],
    });
  });

  it("warns — loudly, not blocking — when the CLI is outside the tested range", async () => {
    mocks.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _opts: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(null, "1.19.2\n", "");
      },
    );
    const { backends } = await registry.listBackends();
    expect(backends[0]).toMatchObject({ installed: true, version: "1.19.2" });
    expect(backends[0]?.versionWarning).toMatch(/1\.19\.2.*已测试的版本区间/);
    // Out of range is a warning, not a refusal: selecting still succeeds.
    await expect(registry.select("opencode")).resolves.toEqual({ ok: true });
  });

  it("reports no warning when the probe cannot read a version", async () => {
    mocks.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _opts: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(null, "", "");
      },
    );
    const { backends } = await registry.listBackends();
    expect(backends[0]).toMatchObject({ installed: true, version: null, versionWarning: null });
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

describe("probeOpencode platform handling", () => {
  /** Fake exec capturing the options each probe call was launched with. */
  function probeRecorder(): {
    options: Array<Record<string, unknown> | undefined>;
    exec: Parameters<typeof probeOpencode>[0];
  } {
    const options: Array<Record<string, unknown> | undefined> = [];
    const exec = (async (
      _file: string,
      _args: readonly string[],
      opts?: Record<string, unknown>,
    ) => {
      options.push(opts);
      return { stdout: "1.18.30\n", stderr: "" };
    }) as unknown as Parameters<typeof probeOpencode>[0];
    return { options, exec };
  }

  it("shells out and passes a PATH-repaired env on win32 (npm .cmd shims)", async () => {
    const { options, exec } = probeRecorder();
    await expect(probeOpencode(exec, "win32")).resolves.toEqual({
      installed: true,
      version: "1.18.30",
    });
    expect(options[0]).toMatchObject({ shell: true, windowsHide: true });
    expect(mocks.resolveSpawnEnv).toHaveBeenCalledWith(
      process.env,
      expect.any(String),
      undefined,
      "win32",
      "opencode",
    );
    expect(options[0]?.env).toBe(process.env);
  });

  it("stays a plain exec on posix", async () => {
    const { options, exec } = probeRecorder();
    await expect(probeOpencode(exec, "darwin")).resolves.toMatchObject({ installed: true });
    expect(options[0]).not.toHaveProperty("shell");
  });
});

describe("capabilities and store paths", () => {
  it("serves opencode capabilities from its agent descriptor", () => {
    expect(registry.capabilities("codex")).toEqual({
      deleteMessage: false,
      attachments: false,
      fileChanges: false,
    });
    expect(registry.capabilities("opencode")).toEqual({
      deleteMessage: true,
      attachments: true,
      fileChanges: true,
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
      client: listCodexClient(),
      version: null,
      authMessage: null,
    });
    await registry.get("opencode");
    const codex = await registry.get("codex");
    await codex.listSessions(); // materialize the home server before dispose

    registry.dispose();
    expect(mocks.stopManagedServer).toHaveBeenCalledTimes(1);
    expect(mocks.stopCodexServer).toHaveBeenCalledTimes(1);

    // After dispose the registry is cold again: a new get re-spawns.
    await (await registry.get("codex")).listSessions();
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

    // Subscribe installs the request handler — but the facade defers the
    // inner adapter's creation to first use, so touch a home first.
    const adapter = await registry.get("codex");
    await adapter.listSessions();
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
