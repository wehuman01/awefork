import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { opencodeDescriptor, parseVersion, versionInRange } from "../shared/agent-descriptor.js";
import {
  BACKEND_LABELS,
  type BackendCapabilities,
  type BackendEventEnvelope,
  type BackendId,
  type BackendInfo,
  backendCapabilities,
  resolveStorePath,
} from "../shared/backend.js";
import { createOpencodeAdapter } from "../shared/opencode-adapter.js";
import type { AgentAdapter } from "../shared/types.js";
import { createCodexMultiHomeAdapter } from "./codex-multihome.js";
import { isCodexInstalled, stopCodexServer } from "./codex-server.js";
import { ensureOpencodeServer, resolveSpawnEnv, stopManagedServer } from "./opencode-server.js";
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
  /** Root of the per-session file-change sidecar directories. */
  fileChangesDir(backend: BackendId): string;
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

  const fileChangesRoot = (backend: BackendId): string =>
    join(userDataDir, "file-changes", backend);

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
              fileChangesDir: fileChangesRoot("opencode"),
            });
            subscribeAdapter("opencode", adapter);
            return adapter;
          })
        : // The codex facade manages one app-server per home (default +
          // aweswitch accounts) internally, including crash re-spawns.
          Promise.resolve().then(() => {
            const adapter = createCodexMultiHomeAdapter({
              lineagePath: storePaths("codex").lineage,
            });
            subscribeAdapter("codex", adapter);
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

    fileChangesDir: fileChangesRoot,

    async listBackends() {
      const [selected, opencode, codexInstalled] = await Promise.all([
        readBackendSelection(settingsPath),
        probeOpencode(),
        isCodexInstalled(),
      ]);
      return {
        selected,
        backends: [
          {
            id: "opencode",
            label: BACKEND_LABELS.opencode,
            installed: opencode.installed,
            version: opencode.version,
            versionWarning: versionWarning(opencode),
          },
          {
            id: "codex",
            label: BACKEND_LABELS.codex,
            installed: codexInstalled,
            version: null,
            versionWarning: null,
          },
        ],
      };
    },

    async select(backend) {
      if (backend !== "opencode" && backend !== "codex") {
        return { ok: false, error: `未知后端：${String(backend)}` };
      }
      const installed =
        backend === "codex" ? await isCodexInstalled() : (await probeOpencode()).installed;
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

interface OpencodeProbe {
  installed: boolean;
  version: string | null;
}

/**
 * `opencode --version` probe for the switcher. Same two platform repairs the
 * serve spawn relies on: a GUI-launched app gets a minimal PATH that misses
 * homebrew/npm-style installs (resolveSpawnEnv), and Windows npm installs are
 * .cmd shims that only run under cmd.exe (shell). Both probes and both spawns
 * must stay in lockstep, or the switcher refuses a backend that would work.
 */
export async function probeOpencode(
  execFn: typeof execFileAsync = execFileAsync,
  platform: NodeJS.Platform = process.platform,
): Promise<OpencodeProbe> {
  try {
    const { stdout } = await execFn("opencode", ["--version"], {
      timeout: 5000,
      env: await resolveSpawnEnv(process.env, homedir(), undefined, platform, "opencode"),
      ...(platform === "win32" ? { shell: true, windowsHide: true } : {}),
    });
    return { installed: true, version: parseVersion(stdout) };
  } catch {
    return { installed: false, version: null };
  }
}

/**
 * The README's old failure mode was silent degradation: an opencode whose
 * event shapes drifted away made runs hang forever with nothing saying why.
 * A version outside the descriptor's tested range now carries an explicit
 * warning instead — visible, but not a block (it may well still work).
 */
function versionWarning(probe: OpencodeProbe): string | null {
  if (!probe.installed || probe.version === null) return null;
  const { compat } = opencodeDescriptor();
  if (versionInRange(probe.version, compat)) return null;
  return `opencode ${probe.version} 不在 awefork 已测试的版本区间（≥${compat.min}，<${compat.max}）；若运行不结束或回复为空，请切换到已测试版本`;
}
