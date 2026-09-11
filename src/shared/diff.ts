/**
 * Pure line diff for the file-change cards. One implementation feeds both
 * consumers: the recorder persists +N/−M totals when a tool turn settles, and
 * the IPC diff view renders hunks from the same snapshots later — so the
 * number on the collapsed row always matches the diff that expands under it.
 *
 * Bounded on purpose: prefix/suffix lines are stripped first, and a middle
 * that still exceeds the LCS cap reports unknown rather than burning CPU (or
 * inventing totals) on a machine-generated rewrite.
 */

/** One changed region; line numbers are 1-based, pointing at the first row. */
export interface DiffHunk {
  beforeStart: number;
  afterStart: number;
  /** Unified-style rows: "-" removed, "+" added, " " context. */
  lines: Array<{ type: "+" | "-" | " "; text: string }>;
}

export interface LineDiffResult {
  /** Added/removed line counts; null when the middle exceeded the LCS cap. */
  added: number | null;
  removed: number | null;
  hunks: DiffHunk[];
}

/** Middle-region cap on either side; above this the diff reports unknown. */
const LCS_CAP = 800;
/** Context lines around each change when the renderer expands the row. */
const CONTEXT = 3;
/** Same-line runs longer than this split two hunks apart. */
const HUNK_GAP = CONTEXT * 2;

type Mask = Array<"same" | "removed" | "added">;

/**
 * Longest-common-subsequence walk over two line arrays. Classic DP table;
 * callers stay within LCS_CAP so the table stays bounded. Returns one entry
 * per output row: same / removed (before-only) / added (after-only).
 */
function lcsMask(before: string[], after: string[]): Mask {
  const width = after.length + 1;
  const table = new Uint32Array((before.length + 1) * (after.length + 1));
  const at = (i: number, j: number): number => table[i * width + j] ?? 0;
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        before[i] === after[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const mask: Mask = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    const left = before[i] ?? "";
    const right = after[j] ?? "";
    if (left === right) {
      mask.push("same");
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      mask.push("removed");
      i += 1;
    } else {
      mask.push("added");
      j += 1;
    }
  }
  while (i < before.length) {
    mask.push("removed");
    i += 1;
  }
  while (j < after.length) {
    mask.push("added");
    j += 1;
  }
  return mask;
}

/** Group the mask into unified hunks with CONTEXT lines around each change. */
function toHunks(mask: Mask, before: string[], after: string[]): DiffHunk[] {
  // Where the two sequences' line numbers sit at the hunk's first row.
  const beforeAt = (index: number): number => {
    let n = 0;
    for (let k = 0; k < index; k += 1) if (mask[k] !== "added") n += 1;
    return n;
  };
  const afterAt = (index: number): number => {
    let n = 0;
    for (let k = 0; k < index; k += 1) if (mask[k] !== "removed") n += 1;
    return n;
  };

  const hunks: DiffHunk[] = [];
  let index = 0;
  while (index < mask.length) {
    if (mask[index] === "same") {
      index += 1;
      continue;
    }
    // Extend the change run: a same-stretch no longer than HUNK_GAP keeps the
    // next change inside this hunk instead of slicing a sliver between them.
    let end = index;
    let sameRun = 0;
    for (let scan = index; scan < mask.length; scan += 1) {
      if (mask[scan] === "same") {
        sameRun += 1;
        if (sameRun > HUNK_GAP) break;
      } else {
        sameRun = 0;
        end = scan;
      }
    }
    const from = Math.max(index - CONTEXT, 0);
    const to = Math.min(end + CONTEXT + 1, mask.length);
    const lines: DiffHunk["lines"] = [];
    for (let k = from; k < to; k += 1) {
      const entry = mask[k];
      if (entry === undefined) continue;
      lines.push({
        type:
          entry === "same" ? (" " as const) : entry === "removed" ? ("-" as const) : ("+" as const),
        text: entry === "added" ? (after[afterAt(k)] ?? "") : (before[beforeAt(k)] ?? ""),
      });
    }
    hunks.push({
      beforeStart: beforeAt(from) + 1,
      afterStart: afterAt(from) + 1,
      lines,
    });
    index = to;
  }
  return hunks;
}

export function lineDiff(before: string, after: string): LineDiffResult {
  if (before === after) return { added: 0, removed: 0, hunks: [] };
  const beforeLines = before === "" ? [] : before.split("\n");
  const afterLines = after === "" ? [] : after.split("\n");

  // Strip the shared prefix/suffix first: they are usually most of the file,
  // and the LCS only needs to see what actually moved.
  let head = 0;
  while (
    head < beforeLines.length &&
    head < afterLines.length &&
    beforeLines[head] === afterLines[head]
  ) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < beforeLines.length - head &&
    tail < afterLines.length - head &&
    beforeLines[beforeLines.length - 1 - tail] === afterLines[afterLines.length - 1 - tail]
  ) {
    tail += 1;
  }
  const midBefore = beforeLines.slice(head, beforeLines.length - tail);
  const midAfter = afterLines.slice(head, afterLines.length - tail);
  if (midBefore.length > LCS_CAP || midAfter.length > LCS_CAP) {
    return { added: null, removed: null, hunks: [] };
  }

  const mask = lcsMask(midBefore, midAfter);
  let added = 0;
  let removed = 0;
  for (const entry of mask) {
    if (entry === "added") added += 1;
    if (entry === "removed") removed += 1;
  }
  // Re-pad the trimmed regions as context so hunks near a file's start or
  // end keep their CONTEXT rows and report file-absolute line numbers.
  const fullMask: Mask = [
    ...Array.from({ length: head }, () => "same" as const),
    ...mask,
    ...Array.from({ length: tail }, () => "same" as const),
  ];
  return { added, removed, hunks: toHunks(fullMask, beforeLines, afterLines) };
}
