/**
 * Absolute local-path detection, shared by the renderer's markdown parser
 * (what becomes a clickable link) and the main process's openPath gate
 * (what may be handed to the OS) — one definition so the two can't drift.
 * Brackets stay in (legal in paths); whitespace and <>() are prose
 * delimiters and end the path.
 */
export const DRIVE_PATH = /^[A-Za-z]:[\\/][^\s<>()]*/;
/** Absolute POSIX path: "/repo/src/main.ts". The segment after the first
 * slash must start alphanumeric, so "//", "/.", and friends stay prose. */
export const POSIX_PATH = /^\/[A-Za-z0-9][^\s<>()]*/;

/** True for absolute Windows paths: "C:\repo\src" or "D:/proj/file.ts". */
export function isDrivePath(value: string): boolean {
  return DRIVE_PATH.test(value);
}

/** True for any absolute path a reply may point at — drive or POSIX. */
export function isLocalPath(value: string): boolean {
  return isDrivePath(value) || POSIX_PATH.test(value);
}

/**
 * Strip what isn't part of an openable path: trailing sentence punctuation
 * (ASCII and CJK — replies end sentences in 。and , too) and a trailing
 * ":line" or ":line:col" reference (the file.ts:42 idiom agents cite;
 * shell.openPath chokes on it).
 */
export function openablePath(value: string): string {
  return value.replace(/[.,;:!?。，、；：！？）】」』》]+$/, "").replace(/:\d+(?::\d+)?$/, "");
}
