/**
 * Minimal RTF → plain text, for .rtf attachments. Covers what real-world
 * writers (Word, TextEdit) emit: \'hh and \uN character escapes, \par/\line
 * breaks, and skips non-text destination groups (font tables, colors,
 * pictures, `{\*\...}` blobs). Not a general RTF renderer — unknown control
 * words are dropped, and \bin binary payloads (rare) are not supported.
 */

/** Groups whose content never contributes text. */
const SKIPPED_DESTINATIONS = new Set([
  "colortbl",
  "colorschememapping",
  "datastore",
  "fonttbl",
  "generator",
  "info",
  "latentstyles",
  "listoverridetable",
  "listtable",
  "mmath",
  "object",
  "pict",
  "rsidtbl",
  "stylesheet",
  "themedata",
  "xmlnstbl",
]);

export function rtfToText(bytes: Uint8Array): string {
  // RTF body bytes are ASCII; every other character arrives via escapes, so
  // mapping bytes 1:1 to code points keeps \'hh and \uN decodable.
  return render(Buffer.from(bytes).toString("latin1"));
}

interface GroupState {
  skip: boolean;
  /** \ucN — fallback chars to drop after each \uN, scoped per group. */
  ucSkip: number;
}

/** Stand-in for a (never-reachable) empty stack; keeps indexed access total. */
const BASE_STATE: GroupState = { skip: false, ucSkip: 1 };

function render(source: string): string {
  const stack: GroupState[] = [BASE_STATE];
  const state = (): GroupState => stack[stack.length - 1] ?? BASE_STATE;
  let out = "";
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    if (ch === "{") {
      stack.push({
        skip: state().skip || groupOpensSkippedDestination(source, i + 1),
        ucSkip: state().ucSkip,
      });
      i++;
      continue;
    }
    if (ch === "}") {
      if (stack.length > 1) stack.pop();
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < source.length) {
      i = renderEscape(source, i, state(), (text) => {
        if (!state().skip) out += text;
      });
      continue;
    }
    if (ch !== "\r" && ch !== "\n" && !state().skip) out += ch;
    i++;
  }

  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** True when the token right after `{` marks a group we don't want. */
function groupOpensSkippedDestination(source: string, start: number): boolean {
  let j = start;
  while (j < source.length && (source[j] === " " || source[j] === "\r" || source[j] === "\n")) {
    j++;
  }
  if (source[j] !== "\\") return false;
  j++;
  // `\*` flags any unknown optional destination; skip those groups too.
  if (source[j] === "*") return true;
  let word = "";
  while (j < source.length) {
    const c = source[j];
    if (!c || !/[a-z]/i.test(c)) break;
    word += c;
    j++;
  }
  return SKIPPED_DESTINATIONS.has(word.toLowerCase());
}

/** Handles one escape at `i` (points at the backslash); returns the next index. */
function renderEscape(
  source: string,
  i: number,
  state: GroupState,
  emit: (text: string) => void,
): number {
  const next = source[i + 1] ?? "";
  // \'hh — one byte as two hex digits.
  if (next === "'" && /^[0-9a-f]{2}/i.test(source.slice(i + 2, i + 4))) {
    emit(String.fromCharCode(parseInt(source.slice(i + 2, i + 4), 16)));
    return i + 4;
  }
  if (next === "{" || next === "}" || next === "\\") {
    emit(next);
    return i + 2;
  }
  if (next === "~") {
    emit(" ");
    return i + 2;
  }
  const word = /^\\([a-z]+)(-?\d+)? ?/i.exec(source.slice(i, i + 32));
  if (!word) return i + 2; // lone backslash or unknown symbol (\-, \_ …): drop
  const matched = word[0] ?? "";
  const name = (word[1] ?? "").toLowerCase();
  const digits = word[2];
  const number = digits ? Number.parseInt(digits, 10) : null;
  if (name === "u" && number !== null) {
    // \uN is signed 16-bit; the next `ucSkip` chars are the legacy-codepage
    // fallback for old readers and must not reach the output.
    emit(String.fromCharCode(number < 0 ? number + 0x10000 : number));
    let skipped = 0;
    let j = i + matched.length;
    while (skipped < state.ucSkip && j < source.length) {
      if (source[j] === "?") {
        j++;
        skipped++;
      } else if (source[j] === "\\" && source[j + 1] === "'") {
        j += 4;
        skipped++;
      } else {
        break;
      }
    }
    return j;
  }
  if (name === "uc" && number !== null) {
    state.ucSkip = number;
  } else if (!state.skip && (name === "par" || name === "line" || name === "sect")) {
    emit("\n");
  } else if (!state.skip && name === "tab") {
    emit("\t");
  }
  return i + matched.length;
}
