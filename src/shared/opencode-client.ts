/**
 * Thin typed client for opencode's local HTTP API (opencode serve).
 * Only the endpoints awefork needs; only the fields awefork reads.
 * Talked to over fetch so it works in the Electron main process with no
 * SDK dependency and can be tested against a fake server.
 */

export interface OcSession {
  id: string;
  title: string;
  directory: string;
  parentID?: string;
  time: { created: number; updated: number };
}

interface OcMessageInfo {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  /** Present on assistant messages, e.g. "glm/glm-5.3-flash". */
  modelID?: string;
  time: { created: number };
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
  /** Cut point is exclusive: the new session keeps messages strictly before it. */
  fork(sessionId: string, cutMessageId: string | null): Promise<OcSession>;
  promptAsync(sessionId: string, text: string): Promise<void>;
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
    fork: (id, cutMessageId) =>
      request<OcSession>(`/session/${id}/fork`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cutMessageId ? { messageID: cutMessageId } : {}),
      }),
    promptAsync: async (id, text) => {
      await request(`/session/${id}/prompt_async`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text }] }),
      });
    },
    abort: (id) => request(`/session/${id}/abort`, { method: "POST" }),
  };
}
