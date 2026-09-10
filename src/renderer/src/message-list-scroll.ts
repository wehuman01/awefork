import type { ReadonlyChatMessage } from "./state";

export const STICK_DISTANCE_PX = 40;

/** Whether the reader was close enough to the bottom before the DOM changed. */
export function shouldFollowStream(distanceFromBottom: number): boolean {
  return distanceFromBottom <= STICK_DISTANCE_PX;
}

/**
 * A server refresh replaces an optimistic local row with the persisted row.
 * The ids differ, but the user prompt is still the same pane view.
 */
export function isSamePaneStart(
  previous: ReadonlyChatMessage | undefined,
  next: ReadonlyChatMessage | undefined,
): boolean {
  if (!previous || !next) return previous === next;
  return previous.role === next.role && previous.text === next.text;
}
