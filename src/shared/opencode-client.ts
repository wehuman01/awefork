/**
 * Thin typed client for opencode's local HTTP API (opencode serve).
 * Only the endpoints awefork needs; only the fields awefork reads.
 * Talked to over fetch so it works in the Electron main process with no
 * SDK dependency and can be tested against a fake server.
 */
import type { ModelChoice, ModelOption } from "./types.js";

export interface OcSession {
  id: string;
  title: string;
  directory: string;
  parentID?: string;
  time: { created: number; updated: number };
}

/** Shape of GET /config/providers — only the fields awefork reads. */
interface OcProviderList {
  providers?: {
    id: string;
    name?: string;
    models?: Record<string, { id?: string; name?: string }>;
  }[];
}

interface OcMessageInfo {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  /** Present on assistant messages, e.g. "glm/glm-5.3-flash". */
  modelID?: string;
  /** Provider that served the model, e.g. "oc-awerouter". */
  providerID?: string;
  /** User messages record the run's model here instead of top-level modelID. */
  model?: { providerID?: string; modelID?: string };
  /** Present on assistant messages: {total, input, output, reasoning, cache}. */
  tokens?: { input?: number; output?: number; total?: number };
  /** Set when the run failed; `data.message` carries the human-readable reason. */
  error?: { name?: string; data?: { message?: string } };
  time: { created: number; completed?: number };
}

interface OcPart {
  type: string;
  text?: string;
  state?: string;
  tool?: string;
}

export interface OcMessage {
  info: OcMessageInfo;
  parts: OcPart[];
}

export interface OcProject {
  id: string;
  worktree: string;
}

export class OpencodeApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OpencodeApiError";
  }
}

export interface OpencodeClient {
  /**
   * GET /session is scoped to the server's current project (resolved from its
   * cwd) and pages at 100. `directory` switches scope to any directory's
   * sessions regardless of project.
   */
  listSessions(directory?: string): Promise<OcSession[]>;
  listProjects(): Promise<OcProject[]>;
  messages(sessionId: string): Promise<OcMessage[]>;
  listModels(): Promise<ModelOption[]>;
  /** Cut point is exclusive: the new session keeps messages strictly before it. */
  fork(sessionId: string, cutMessageId: string | null): Promise<OcSession>;
  /** Permanently remove a session and its messages. */
  deleteSession(sessionId: string): Promise<void>;
  /** PATCH /session/:id — rename a session in place. */
  renameSession(sessionId: string, title: string): Promise<OcSession>;
  /**
   * Fire a run on POST /session/:id/message. This endpoint resolves only when
   * the whole run finishes — and unlike prompt_async it publishes the run's
   * events on /event (opencode 1.18: prompt_async publishes none), so callers
   * detach it and follow progress through the event stream.
   */
  prompt(sessionId: string, text: string, model?: ModelChoice | null): Promise<void>;
  abort(sessionId: string): Promise<void>;
}

export function createOpencodeClient(baseUrl: string): OpencodeClient {
  const url = (path: string) => `${baseUrl.replace(/\/$/, "")}${path}`;

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url(path), init);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new OpencodeApiError(
        0,
        `Cannot reach opencode server at ${baseUrl} (${reason}). Start it with: opencode serve --port 4096`,
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new OpencodeApiError(
        response.status,
        `opencode API ${path} failed: ${response.status} ${body.slice(0, 200)}`,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  return {
    listSessions: (directory?: string) => {
      const query = new URLSearchParams({ limit: "1000" });
      if (directory) query.set("directory", directory);
      return request<OcSession[]>(`/session?${query.toString()}`);
    },
    listProjects: () => request<OcProject[]>("/project"),
    messages: (id) => request<OcMessage[]>(`/session/${id}/message`),
    listModels: async () => {
      // Read only ids and names — the response also carries provider secrets.
      const list = await request<OcProviderList>("/config/providers");
      const options: ModelOption[] = [];
      for (const provider of list.providers ?? []) {
        for (const [key, model] of Object.entries(provider.models ?? {})) {
          const id = model.id || key;
          options.push({
            providerId: provider.id,
            providerName: provider.name || provider.id,
            modelId: id,
            modelName: model.name || id,
          });
        }
      }
      return options.filter((o) => o.modelId);
    },
    fork: (id, cutMessageId) =>
      request<OcSession>(`/session/${id}/fork`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cutMessageId ? { messageID: cutMessageId } : {}),
      }),
    deleteSession: async (id) => {
      await request(`/session/${id}`, { method: "DELETE" });
    },
    renameSession: (id, title) =>
      request<OcSession>(`/session/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      }),
    prompt: async (id, text, model) => {
      await request(`/session/${id}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ type: "text", text }],
          ...(model ? { model: { providerID: model.providerId, modelID: model.modelId } } : {}),
        }),
      });
    },
    abort: (id) => request(`/session/${id}/abort`, { method: "POST" }),
  };
}
