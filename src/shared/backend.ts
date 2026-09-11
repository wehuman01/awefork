import type { AgentEvent } from "./types.js";

/**
 * Agent backends awefork can drive. Backend is a per-call argument end to
 * end (renderer → preload → IPC → registry); the main process never has a
 * "current" mode beyond the persisted selection read at boot.
 */
export type BackendId = "opencode" | "codex";

/** One entry of awefork:backends — what the top-bar switcher renders. */
export interface BackendInfo {
  id: BackendId;
  label: string;
  /** Probed via `--version` spawn; no server is started for the probe. */
  installed: boolean;
}

/** What awefork:backends resolves to: the list plus the persisted selection. */
export interface BackendsResult {
  selected: BackendId;
  backends: BackendInfo[];
}

/**
 * Per-backend feature surface. The renderer hides affordances the backend
 * lacks (attach button, turn delete) instead of surfacing errors on click.
 */
export interface BackendCapabilities {
  deleteMessage: boolean;
  attachments: boolean;
}

/**
 * Every spawned backend's events are forwarded on one channel as these
 * envelopes; the renderer routes by `backend` (running maps, view refresh)
 * and only the active backend drives the visible canvas.
 */
export interface BackendEventEnvelope {
  backend: BackendId;
  event: AgentEvent;
}

export const BACKEND_LABELS: Record<BackendId, string> = {
  opencode: "opencode",
  codex: "codex",
};

export function isBackendId(value: unknown): value is BackendId {
  return value === "opencode" || value === "codex";
}

/**
 * Static capability table (v1): opencode does message deletes and file
 * attachments; codex does neither (its app-server does not round-trip sent
 * bytes and has no single-message delete).
 */
export function backendCapabilities(backend: BackendId): BackendCapabilities {
  if (backend === "codex") return { deleteMessage: false, attachments: false };
  return { deleteMessage: true, attachments: true };
}

/**
 * Overlay-store path per backend (`lineage`, `pins`, `trash`, `archive` →
 * e.g. `lineage-codex.json`). Migration without moves: when the
 * opencode-suffixed file does not exist but the legacy bare one does,
 * opencode keeps reading/writing the legacy path; a fresh install (neither
 * file exists) writes the suffixed path so the two backends never collide.
 * `exists` is injected so the resolution stays pure and testable.
 */
export function resolveStorePath(
  directory: string,
  base: string,
  backend: BackendId,
  exists: (path: string) => boolean,
): string {
  const suffixed = joinPath(directory, `${base}-${backend}.json`);
  if (backend === "codex") return suffixed;
  if (exists(suffixed)) return suffixed;
  const legacy = joinPath(directory, `${base}.json`);
  return exists(legacy) ? legacy : suffixed;
}

function joinPath(directory: string, name: string): string {
  if (directory === "") return name;
  return directory.endsWith("/") || directory.endsWith("\\")
    ? `${directory}${name}`
    : `${directory}/${name}`;
}
