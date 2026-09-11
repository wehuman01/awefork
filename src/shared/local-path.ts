/**
 * Windows drive-path detection, shared by the renderer's markdown parser
 * (what becomes a clickable link) and the main process's openPath gate
 * (what may be handed to the OS) — one definition so the two can't drift.
 * Brackets stay in (legal in Windows paths); whitespace and <>() are prose
 * delimiters and end the path.
 */
export const DRIVE_PATH = /^[A-Za-z]:[\\/][^\s<>()]*/;

/** True for absolute Windows paths: "C:\repo\src" or "D:/proj/file.ts". */
export function isDrivePath(value: string): boolean {
  return DRIVE_PATH.test(value);
}
