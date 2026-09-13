/**
 * Pure text-editing helpers behind the composer's Tab and paste handling.
 * They are DOM-free so vitest can exercise them in the node environment;
 * chat-input.vue splices the returned edit into the textarea with
 * execCommand("insertText"), keeping Tab and wrapped pastes on the
 * textarea's native undo stack.
 */

/** A splice replacing [from, to) with `insert`, plus the selection to leave. */
export interface TextEdit {
  from: number;
  to: number;
  insert: string;
  start: number;
  end: number;
}

/** [lineStart, lineEnd) covering every line the selection touches. */
function lineBounds(value: string, start: number, end: number): [number, number] {
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const nl = value.indexOf("\n", end);
  return [lineStart, nl === -1 ? value.length : nl];
}

/** Map a caret at `pos` (block-relative) through per-line edits: each line
 *  fully before it shifts it by its signed `delta`; a caret strictly inside
 *  a line rides along with that line's edit, one at a line start stays put. */
function trackCaret(lines: readonly string[], deltas: readonly number[], pos: number): number {
  let offset = 0;
  let shift = 0;
  for (const [i, line] of lines.entries()) {
    if (pos <= offset) break;
    if (pos <= offset + line.length) {
      shift += pos > offset ? (deltas[i] ?? 0) : 0;
      break;
    }
    shift += deltas[i] ?? 0;
    offset += line.length + 1;
  }
  return pos + shift;
}

/** Tab with a bare caret inserts two spaces; with a selection it indents every covered line. */
export function indentLines(value: string, start: number, end: number): TextEdit {
  if (start === end) {
    return { from: start, to: start, insert: "  ", start: start + 2, end: start + 2 };
  }
  const [ls, le] = lineBounds(value, start, end);
  const lines = value.slice(ls, le).split("\n");
  const insert = lines.map((line) => `  ${line}`).join("\n");
  const deltas = lines.map(() => 2);
  return {
    from: ls,
    to: le,
    insert,
    start: ls + trackCaret(lines, deltas, start - ls),
    end: ls + trackCaret(lines, deltas, end - ls),
  };
}

/** Shift+Tab strips up to two leading spaces (or one tab) from each covered line. */
export function outdentLines(value: string, start: number, end: number): TextEdit {
  const [ls, le] = lineBounds(value, start, end);
  const lines = value.slice(ls, le).split("\n");
  const out = lines.map((line) => line.replace(/^(?:\t| {1,2})/, ""));
  const deltas = lines.map((line, i) => (out[i] ?? "").length - line.length);
  return {
    from: ls,
    to: le,
    insert: out.join("\n"),
    start: ls + trackCaret(lines, deltas, start - ls),
    end: ls + trackCaret(lines, deltas, end - ls),
  };
}

/** Wrap pasted text in an unlabeled ``` fence, dropping trailing blank lines. */
export function wrapCodeFence(text: string): string {
  return `\`\`\`\n${text.replace(/\s+$/, "")}\n\`\`\``;
}

/**
 * Per-line code fingerprints. Precision beats recall: a missed paste just
 * lands as plain text like today, while a wrong wrap silently changes what
 * the model receives. Kept case-sensitive — code keywords are lowercase.
 */
const CODE_LINE_SIGNALS: readonly RegExp[] = [
  /^\s{0,3}[$%>]\s/, // shell / REPL prompts
  /^\s*(def|class|import|from|const|let|var|function|fn|func|return|public|private|protected|static|package|using|include|type|struct|enum|impl|trait|export|require)\b/,
  /^\s*(diff --git|index |@@|commit |Author:|Date:|Merge:)/,
  /^\s*(Traceback|Exception|Warning)\b/,
  /^\s*[A-Za-z]+(Error|Exception)\b/, // ValueError, TypeError…
  /^\s+File "/, // traceback frames
  /^\s*\d{4}-\d{2}-\d{2}[T ]/, // timestamped logs
  /[;{}]\s*$/, // statement / brace endings
  /=>|::|&&|\|\||===|!==|\+\+/,
  /^\s*<[/?\w!]/, // markup tags
  /^\s*\[[^\]]+\]\s*$/, // ini / toml sections
  /^\s*[\w$.#/+-]+\s*[:=]\s*([0-9'"[{~*-]|true\b|false\b|null\b|yes\b|no\b)/, // config values
];

/**
 * Should a pasted chunk be fenced as code? Multi-line only — never anything
 * that already carries a fence — and at least half the non-empty lines
 * (minimum two) must carry a code fingerprint, so prose stays prose.
 */
export function looksLikeCode(text: string): boolean {
  if (!text.includes("\n") || text.includes("```")) return false;
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const hits = lines.filter((line) => CODE_LINE_SIGNALS.some((signal) => signal.test(line)));
  return lines.length >= 2 && hits.length >= 2 && hits.length * 2 >= lines.length;
}
