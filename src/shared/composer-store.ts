import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import type { ModelChoice, PersistedComposer, PersistedDraft } from "./types.js";
import { enqueueWrite } from "./write-queue.js";

/**
 * Composer store: the unsent canvas draft and the pane's model picks,
 * persisted so a crash or restart hands the input back. Losing the file
 * only costs the unsent text, never session data — the sessions
 * themselves keep living in the agent backend.
 */

function sanitizeModel(value: unknown): ModelChoice | null {
  if (typeof value !== "object" || value === null) return null;
  const providerId = (value as Record<string, unknown>).providerId;
  const modelId = (value as Record<string, unknown>).modelId;
  if (typeof providerId !== "string" || typeof modelId !== "string") return null;
  const variant = (value as Record<string, unknown>).variant;
  return { providerId, modelId, variant: typeof variant === "string" ? variant : null };
}

function sanitizeDraft(value: unknown): PersistedDraft | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.sessionId !== "string") return null;
  const atMessageId = typeof v.atMessageId === "string" ? v.atMessageId : null;
  const text = typeof v.text === "string" ? v.text : "";
  const attachments = Array.isArray(v.attachments)
    ? v.attachments.filter(
        (a): a is PersistedDraft["attachments"][number] =>
          typeof a === "object" &&
          a !== null &&
          typeof (a as Record<string, unknown>).id === "string" &&
          typeof (a as Record<string, unknown>).name === "string" &&
          typeof (a as Record<string, unknown>).mime === "string" &&
          typeof (a as Record<string, unknown>).dataUrl === "string",
      )
    : [];
  return { sessionId: v.sessionId, atMessageId, text, model: sanitizeModel(v.model), attachments };
}

function sanitizePaneModels(value: unknown): Record<string, ModelChoice> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, ModelChoice> = {};
  for (const [sessionId, model] of Object.entries(value)) {
    const sanitized = sanitizeModel(model);
    if (sanitized) out[sessionId] = sanitized;
  }
  return out;
}

export async function readComposer(filePath: string): Promise<PersistedComposer | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const v = parsed as Record<string, unknown>;
    return {
      draft: sanitizeDraft(v.draft),
      paneModels: sanitizePaneModels(v.paneModels),
    };
  } catch {
    return null;
  }
}

/**
 * Persist the composer state; null removes the file (nothing left to
 * recover). Serialized so a debounced save can't interleave with the
 * "draft sent" clear.
 */
export function writeComposer(filePath: string, value: PersistedComposer | null): Promise<void> {
  return enqueueWrite(filePath, async () => {
    if (value === null) {
      await fs.rm(filePath, { force: true });
      return;
    }
    await fs.mkdir(dirname(filePath), { recursive: true });
    await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
  });
}
