import { formatDuration } from "./format";

/**
 * Collapsed-state summary of a reasoning part, following opencode's TUI: the
 * title is the part's bolded first line when the model wrote one (OpenAI-style
 * reasoning summary), else its first non-empty line; the duration comes from
 * the part snapshot's start/end times.
 */

const TITLE_MAX_CHARS = 60;

export function thoughtTitle(text: string): string | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const bold = trimmed.match(/^\*\*(.+?)\*\*:?$/);
    const raw = (bold?.[1] ?? trimmed.replace(/^#+\s*/, "")).trim();
    if (!raw) continue;
    return raw.length > TITLE_MAX_CHARS ? `${raw.slice(0, TITLE_MAX_CHARS)}…` : raw;
  }
  return null;
}

function thoughtDuration(part: {
  startedAt: number | null;
  endedAt: number | null;
}): string | null {
  if (part.startedAt === null || part.endedAt === null || part.endedAt < part.startedAt) {
    return null;
  }
  return formatDuration(part.endedAt - part.startedAt);
}

/**
 * Summary line of a live thinking part: while it streams, the (still growing)
 * first-line title under a spinner; once the end snapshot landed, the fixed
 * `Thought: title · duration` collapse header.
 */
export function thoughtSummary(part: {
  text: string;
  startedAt: number | null;
  endedAt: number | null;
}): { title: string; duration: string | null } {
  const title = thoughtTitle(part.text);
  if (part.endedAt === null) return { title: title ?? "Thinking…", duration: null };
  return { title: title ? `Thought: ${title}` : "Thought", duration: thoughtDuration(part) };
}
