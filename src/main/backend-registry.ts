import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  BACKEND_LABELS,
  type BackendCapabilities,
  type BackendEventEnvelope,
  type BackendId,
  type BackendInfo,
  backendCapabilities,
  resolveStorePath,
} from "../shared/backend.js";
import { createCodexAdapter } from "../shared/codex-adapter.js";
import { createOpencodeAdapter } from "../shared/opencode-adapter.js";
import type { AgentAdapter } from "../shared/types.js";
import { ensureCodexServer, isCodexInstalled, stopCodexServer } from "./codex-server.js";
import { ensureOpencodeServer, stopManagedServer } from "./opencode-server.js";
import { readBackendSelection, writeBackendSelection } from "./settings-store.js";

const execFileAsync = promisify(execFile);

const OPENCODE_PORT = 4096;
const STORE_BASES = ["lineage", "pins", "trash", "archive", "composer"] as const;
type StoreBase = (typeof STORE_BASES)[number];
type StorePaths = Record<StoreBase, string>;

export interface BackendRegistry {
  /** Resolve (spawning lazily) the adapter for one backend. */
  get(backend: BackendId): Promise<AgentAdapter>;
  /** Switcher data: installed probes + the persisted selection. */
  listBackends(): Promise<{ selected: BackendId; backends: BackendInfo[] }>;
  /** Probe + persist a selection; {ok:false} keeps the current one. */
  select(backend: BackendId): Promise<{ ok: boolean; error?: string }>;
  capabilities(backend: BackendId): BackendCapabilities;
  /** Per-backend overlay-store paths (legacy bare files stay on opencode). */
  storePaths(backend: BackendId): StorePaths;
  /** Forward every spawned backend's events as tagged envelopes, forever. */
  forward(send: (envelope: BackendEventEnvelope) => void): void;
  dispose(): void;
}

/**
 * Routes IPC calls to a backend's adapter and keeps one adapter per backend
 * alive for the app's lifetime. Spawning is lazy — launch only materializes
 * the persisted selection — and events from every spawned backend stream out
 * together, so runs in flight keep streaming while the user views the other
 * backend. A crashed codex child is re-spawned on the next call for it, and
 * the renderer hears `server.reconnected` once the new handshake succeeds.
 */
export function createBackendRegistry(userDataDir: string): BackendRegistry {
  const settingsPath = join(userDataDir, "settings.json");
  const caches = new Map<BackendId, StorePaths>();
  const adapters = new Map<BackendId, Promise<AgentAdapter>>();
  const unsubscribers: Array<() => void> = [];
  let forwardEvent: ((envelope: BackendEventEnvelope) => void) | null = null;
  /** Set when the codex child died; the successful re-spawn reports it once. */
  let codexCrashed = false;

  const storePaths = (backend: BackendId): StorePaths => {
    const cached = caches.get(backend);
    if (cached) return cached;
    const paths = Object.fromEntries(
      STORE_BASES.map((base) => [
        base,
        resolveStorePath(userDataDir, base, backend, (path) => existsSync(path)),
      ]),
    ) as StorePaths;
    caches.set(backend, paths);
    return paths;
  };

  const subscribeAdapter = (backend: BackendId, adapter: AgentAdapter): void => {
    void adapter
      .subscribe((event) => {
        forwardEvent?.({ backend, event });
      })
      .then((unsubscribe) => {
        unsubscribers.push(unsubscribe);
      });
  };

  const ensureBackend = (backend: BackendId): Promise<AgentAdapter> => {
    const existing = adapters.get(backend);
    if (existing) return existing;
    const promise =
      backend === "opencode"
        ? ensureOpencodeServer(OPENCODE_PORT).then(({ baseUrl }) => {
            const adapter = createOpencodeAdapter({
              baseUrl,
              lineagePath: storePaths("opencode").lineage,
            });
            subscribeAdapter("opencode", adapter);
            return adapter;
          })
        : ensureCodexServer(() => {
            // Child died mid-run: tell the renderer, drop the cache, and let
            // the next codex call spawn a fresh server lazily.
            codexCrashed = true;
            adapters.delete("codex");
            forwardEvent?.({
              backend: "codex",
              event: {
                type: "server.error",
                message: "codex app-server 连接中断，将在下次操作时重启",
              },
            });
          }).then(({ client, version, authMessage }) => {
            const adapter = createCodexAdapter({
              client,
              lineagePath: storePaths("codex").lineage,
              cliVersion: version,
              authMessage,
            });
            subscribeAdapter("codex", adapter);
            if (codexCrashed) {
              codexCrashed = false;
              forwardEvent?.({
                backend: "codex",
                event: { type: "server.reconnected" },
              });
            }
            return adapter;
          });
    // A failed spawn must not be cached as the permanent truth; drop it so
    // the next call retries (matches the lazy re-spawn contract).
    promise.catch(() => adapters.delete(backend));
    adapters.set(backend, promise);
    return promise;
  };

  return {
    get: ensureBackend,

    async listBackends() {
      const [selected, opencodeInstalled, codexInstalled] = await Promise.all([
        readBackendSelection(settingsPath),
        probeInstalled("opencode"),
        isCodexInstalled(),
      ]);
      return {
        selected,
        backends: [
          { id: "opencode", label: BACKEND_LABELS.opencode, installed: opencodeInstalled },
          { id: "codex", label: BACKEND_LABELS.codex, installed: codexInstalled },
        ],
      };
    },

    async select(backend) {
      if (backend !== "opencode" && backend !== "codex") {
        return { ok: false, error: `未知后端：${String(backend)}` };
      }
      const installed =
        backend === "codex" ? await isCodexInstalled() : await probeInstalled("opencode");
      if (!installed) {
        const hint =
          backend === "codex"
            ? "未在 PATH 上找到 codex CLI。安装：npm install -g @openai/codex"
            : "未在 PATH 上找到 opencode CLI。安装后重试，或手动运行 opencode serve。";
        return { ok: false, error: hint };
      }
      await writeBackendSelection(settingsPath, backend);
      return { ok: true };
    },

    capabilities: backendCapabilities,

    storePaths,

    forward(send) {
      forwardEvent = send;
    },

    dispose() {
      for (const unsubscribe of unsubscribers.splice(0)) {
        try {
          unsubscribe();
        } catch {
          // A dead backend's stream may already be gone.
        }
      }
      for (const promise of adapters.values()) {
        void promise.then((adapter) => adapter.dispose()).catch(() => {});
      }
      adapters.clear();
      stopManagedServer();
      stopCodexServer();
    },
  };
}

async function probeInstalled(binary: "opencode"): Promise<boolean> {
  try {
    await execFileAsync(binary, ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
