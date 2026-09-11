import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createCodexAdapter } from "../shared/codex-adapter.js";
import type {
  AgentAdapter,
  AgentEvent,
  ChatMessage,
  ModelOption,
  PromptAttachment,
  SessionSummary,
} from "../shared/types.js";
import {
  type CodexHome,
  DEFAULT_HOME_ID,
  defaultCodexHome,
  discoverCodexHomes,
} from "./codex-homes.js";
import { ensureCodexServer } from "./codex-server.js";

export interface CodexMultiHomeOptions {
  /** Path to the codex lineage sidecar file (shared by every home). */
  lineagePath: string;
  /**
   * Test seam: build one home's adapter. Production spawns that home's
   * app-server and wraps it in createCodexAdapter.
   */
  createHomeAdapter?: (home: CodexHome) => Promise<AgentAdapter>;
  /** Test seam: home list (production re-discovers on each listSessions). */
  homes?: () => CodexHome[];
  /** Test seam: import destination (production: the primary CODEX_HOME). */
  defaultHomePath?: () => string;
}

interface HomeEntry {
  home: CodexHome;
  adapterPromise?: Promise<AgentAdapter>;
  /** Set when the home's child died; cleared by the next successful spawn. */
  crashed: boolean;
}

/** A pending interaction: facade id → the home adapter holding the inner one. */
interface RoutedInteraction {
  adapter: AgentAdapter;
  innerRequestId: string;
}

/**
 * One AgentAdapter facade over several codex homes: the primary CODEX_HOME
 * plus every aweswitch per-account home. Sessions are merged into one list
 * (the default home wins on id collisions), and each call routes to the
 * home that owns the session.
 *
 * Continue semantics: browsing a foreign-home session reads it through that
 * home's server, but continuing it (prompt / fork) runs under the primary
 * home's logged-in account — codex can only resume a rollout that lives in
 * its own CODEX_HOME, so the first continue copies the rollout file into the
 * default home ("imports" it) and the session routes there from then on.
 */
export function createCodexMultiHomeAdapter(options: CodexMultiHomeOptions): AgentAdapter {
  const homesOf = options.homes ?? (() => discoverCodexHomes());
  const defaultHome = options.defaultHomePath ?? (() => defaultCodexHome());
  /** sessionId → owning home id, populated by listSessions. */
  const owners = new Map<string, string>();
  const entries = new Map<string, HomeEntry>();
  const unsubs: Array<() => void> = [];
  /** facade requestId → inner home adapter + its own id. */
  const interactions = new Map<string, RoutedInteraction>();
  let nextInteractionId = 1;
  let emitEvent: ((event: AgentEvent) => void) | null = null;

  const emit = (event: AgentEvent) => emitEvent?.(event);

  const createDefaultHomeAdapter = async (home: CodexHome): Promise<AgentAdapter> => {
    const { client, version, authMessage } = await ensureCodexServer(
      () => notifyHomeDeath(home.id),
      spawn,
      home.path,
    );
    // A foreign home's auth banner would nag about an account awefork never
    // prompts through; only the default home gets the login notice.
    return createCodexAdapter({
      client,
      lineagePath: options.lineagePath,
      cliVersion: version,
      authMessage: home.id === DEFAULT_HOME_ID ? authMessage : null,
    });
  };

  const buildHomeAdapter =
    options.createHomeAdapter ?? ((home: CodexHome) => createDefaultHomeAdapter(home));

  function notifyHomeDeath(homeId: string): void {
    const entry = entries.get(homeId);
    if (!entry) return;
    entry.adapterPromise = undefined;
    if (entry.crashed) return;
    entry.crashed = true;
    // A foreign home dying is invisible unless the user opens one of its
    // sessions; only the primary home is worth a toast.
    if (homeId === DEFAULT_HOME_ID) {
      emit({
        type: "server.error",
        message: "codex app-server 连接中断，将在下次操作时重启",
      });
    }
  }

  /**
   * Interaction request ids are minted inside each home's adapter, so two
   * homes can mint the same id. The facade re-mints every outgoing request
   * and remembers which home it came from, keeping replies unambiguous.
   */
  function retagInteraction(event: AgentEvent, adapter: AgentAdapter): AgentEvent {
    if (event.type !== "interaction.requested") return event;
    const facadeRequestId = `codex-mh-${nextInteractionId++}`;
    interactions.set(facadeRequestId, {
      adapter,
      innerRequestId: event.request.requestId,
    });
    return { ...event, request: { ...event.request, requestId: facadeRequestId } };
  }

  async function ensureHome(home: CodexHome): Promise<AgentAdapter> {
    let entry = entries.get(home.id);
    if (!entry) {
      entry = { home, crashed: false };
      entries.set(home.id, entry);
    }
    if (entry.adapterPromise) return entry.adapterPromise;
    const promise = buildHomeAdapter(home)
      .then(async (adapter) => {
        const unsub = await adapter.subscribe((event) => emit(retagInteraction(event, adapter)));
        unsubs.push(unsub);
        if (entry.crashed) {
          entry.crashed = false;
          if (home.id === DEFAULT_HOME_ID) {
            emit({ type: "server.reconnected" });
          }
        }
        return adapter;
      })
      .catch((error) => {
        // A failed spawn must not be cached; the next call retries.
        entry.adapterPromise = undefined;
        throw error;
      });
    entry.adapterPromise = promise;
    return promise;
  }

  /** Adapter of the home that owns a session (unknown ids: the default). */
  async function adapterFor(sessionId: string): Promise<AgentAdapter> {
    const ownerId = owners.get(sessionId) ?? DEFAULT_HOME_ID;
    const home = homesOf().find((h) => h.id === ownerId);
    return ensureHome(home ?? { path: defaultHome(), id: DEFAULT_HOME_ID, label: "Codex" });
  }

  async function defaultAdapter(): Promise<AgentAdapter> {
    return ensureHome({ path: defaultHome(), id: DEFAULT_HOME_ID, label: "Codex" });
  }

  /**
   * Make a foreign session continuable under the default account: copy its
   * rollout into the default home (idempotent) and repoint the owner. The
   * rollout's date-path segment is reused verbatim so the copy lands where
   * codex's scanner looks.
   */
  function importToDefault(sessionId: string, ownerId: string): void {
    if (ownerId === DEFAULT_HOME_ID) return;
    const source = homesOf().find((h) => h.id === ownerId);
    if (!source) throw new Error(`会话 ${sessionId} 的来源账号 ${ownerId} 不存在，无法继续`);
    const rel = findRolloutRelPath(source.path, sessionId);
    if (!rel) {
      throw new Error(`找不到会话 ${sessionId} 的记录文件，无法用默认账号继续`);
    }
    const dest = join(defaultHome(), "sessions", rel);
    if (!existsSync(dest)) {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(source.path, "sessions", rel), dest);
    }
    owners.set(sessionId, DEFAULT_HOME_ID);
  }

  return {
    kind: "codex",

    async listSessions() {
      const homes = homesOf();
      const merged: SessionSummary[] = [];
      const seen = new Set<string>();
      await Promise.all(
        homes.map(async (home) => {
          let adapter: AgentAdapter;
          if (home.id === DEFAULT_HOME_ID) {
            // The primary home failing is a real backend failure: propagate.
            adapter = await defaultAdapter();
          } else {
            // A foreign account that won't spawn must not kill the list.
            try {
              adapter = await ensureHome(home);
            } catch (error) {
              console.warn(`codex home ${home.id} unavailable: ${String(error)}`);
              return;
            }
          }
          for (const session of await adapter.listSessions()) {
            if (seen.has(session.id)) return;
            seen.add(session.id);
            owners.set(session.id, home.id);
            merged.push(session);
          }
        }),
      );
      return merged.sort((a, b) => b.updatedAt - a.updatedAt);
    },

    async messages(sessionId) {
      return (await adapterFor(sessionId)).messages(sessionId);
    },

    async messageAttachments(sessionId, messageId) {
      return (await adapterFor(sessionId)).messageAttachments(sessionId, messageId);
    },

    async listModels() {
      // Models come from the account that will run the turns: the default.
      return (await defaultAdapter()).listModels();
    },

    async createSession(directory) {
      // New sessions always belong to the default home.
      return (await defaultAdapter()).createSession(directory);
    },

    async fork(sessionId, atMessageId) {
      importToDefault(sessionId, owners.get(sessionId) ?? DEFAULT_HOME_ID);
      return (await adapterFor(sessionId)).fork(sessionId, atMessageId);
    },

    async deleteSession(sessionId) {
      await (await adapterFor(sessionId)).deleteSession(sessionId);
      owners.delete(sessionId);
    },

    async deleteMessage(sessionId, messageId) {
      await (await adapterFor(sessionId)).deleteMessage(sessionId, messageId);
    },

    async renameSession(sessionId, title) {
      await (await adapterFor(sessionId)).renameSession(sessionId, title);
    },

    async prompt(sessionId, text, model, attachments) {
      // Continuing a foreign session switches it to the default account.
      importToDefault(sessionId, owners.get(sessionId) ?? DEFAULT_HOME_ID);
      await (await adapterFor(sessionId)).prompt(sessionId, text, model, attachments);
    },

    async abort(sessionId) {
      await (await adapterFor(sessionId)).abort(sessionId);
    },

    async respondInteraction(requestId, response) {
      const routed = interactions.get(requestId);
      if (!routed) return;
      interactions.delete(requestId);
      await routed.adapter.respondInteraction(routed.innerRequestId, response);
    },

    async subscribe(handler) {
      emitEvent = handler;
      return () => {
        emitEvent = null;
        for (const unsub of unsubs.splice(0)) {
          try {
            unsub();
          } catch {
            // A dead home's stream may already be gone.
          }
        }
      };
    },

    dispose() {
      emitEvent = null;
      for (const entry of entries.values()) {
        void entry.adapterPromise?.then((adapter) => adapter.dispose()).catch(() => {});
      }
      entries.clear();
      owners.clear();
    },
  };
}

/** sessions/<year>/<month>/<day>/rollout-…-<threadId>.jsonl, relative. */
function findRolloutRelPath(homePath: string, threadId: string): string | null {
  const root = join(homePath, "sessions");
  for (const year of subDirs(root)) {
    for (const month of subDirs(join(root, year))) {
      for (const day of subDirs(join(root, year, month))) {
        const dir = join(root, year, month, day);
        for (const file of readdirSync(dir)) {
          if (file.endsWith(`-${threadId}.jsonl`)) return join(year, month, day, file);
        }
      }
    }
  }
  return null;
}

function subDirs(path: string): string[] {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}
