/**
 * Markdown parser for agent replies in the branch-context pane.
 *
 * Covers the subset models actually emit — fenced code, ATX headings, nested
 * lists, blockquotes, GFM tables, and the usual inline marks. It outputs a
 * plain block/inline tree (no HTML strings anywhere); markdown-view maps that
 * tree onto vnodes, so untrusted reply text can never inject markup. Input
 * that matches no rule simply stays literal text, the same way it renders
 * today; an unclosed ``` fence swallows the rest of the input as code, which
 * is exactly right while a reply is still streaming in.
 */

import { DRIVE_PATH } from "../../shared/drive-path";

export type MdInline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: MdInline[] }
  | { kind: "em"; children: MdInline[] }
  | { kind: "del"; children: MdInline[] }
  | { kind: "link"; href: string; children: MdInline[] };

export interface MdListBlock {
  kind: "list";
  ordered: boolean;
  start: number;
  items: MdListItem[];
}

export interface MdListItem {
  inline: MdInline[];
  sublist: MdListBlock | null;
}

export type MdBlock =
  | { kind: "code"; lang: string; code: string }
  | { kind: "heading"; level: number; inline: MdInline[] }
  | { kind: "paragraph"; inline: MdInline[] }
  | MdListBlock
  | { kind: "quote"; children: MdBlock[] }
  | { kind: "hr" }
  | { kind: "table"; align: MdAlign[]; head: MdInline[][]; rows: MdInline[][][] };

export type MdAlign = "left" | "center" | "right";

// ── inline ───────────────────────────────────────────────────────────

/** Link schemes we are willing to hand to the OS; everything else stays text. */
const SAFE_HREF = /^(https?:\/\/|mailto:)/i;
/** Bare http(s) URLs inside prose become links too. */
const AUTOLINK = /^https?:\/\/[^\s<>()[\]]+/;

export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf !== "") out.push({ kind: "text", text: buf });
    buf = "";
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? "";

    if (ch === "\\") {
      const next = text[i + 1] ?? "";
      if (next !== "" && "\\`*_~[]()#!>|+-".includes(next)) {
        buf += next;
        i += 2;
      } else {
        buf += "\\";
        i += 1;
      }
      continue;
    }

    if (ch === "`") {
      const run = runOf(text, i, "`");
      const close = text.indexOf(run, i + run.length);
      if (close >= 0) {
        flush();
        let content = text.slice(i + run.length, close);
        // A code span flanked by single spaces on both sides drops them.
        if (content.startsWith(" ") && content.endsWith(" ") && content.trim() !== "") {
          content = content.slice(1, -1);
        }
        out.push({ kind: "code", text: content.replace(/\n/g, " ") });
        i = close + run.length;
      } else {
        buf += run;
        i += run.length;
      }
      continue;
    }

    if (ch === "*" || ch === "_" || ch === "~") {
      const run = runOf(text, i, ch);
      const mark = inlineMark(ch, run.length);
      // "_" only emphasizes at word boundaries, so snake_case names stay put.
      const boundaryOk = ch !== "_" || !/\w/.test(text[i - 1] ?? " ");
      const close = mark && boundaryOk ? findClosing(text, i + run.length, ch, run.length) : -1;
      if (mark && close > i + run.length) {
        flush();
        out.push({ kind: mark, children: parseInline(text.slice(i + run.length, close)) });
        i = close + run.length;
      } else {
        buf += run;
        i += run.length;
      }
      continue;
    }

    // Windows drive paths are consumed whole, before the escape rule can
    // mangle C:\repo\[old]\file.ts into C:repo[old]file.ts, and stay
    // clickable so a reply's file reference opens with the OS. The letter
    // must start a word — "file:///C:/x" links from neither its "e:" nor
    // the drive letter inside the URL tail.
    if (/[A-Za-z]/.test(ch) && text[i + 1] === ":" && !/[\w/]/.test(text[i - 1] ?? " ")) {
      const match = DRIVE_PATH.exec(text.slice(i));
      if (match) {
        // Trailing sentence punctuation is prose, not part of the path.
        const href = match[0].replace(/[.,;:!?]+$/, "");
        flush();
        out.push({ kind: "link", href, children: [{ kind: "text", text: href }] });
        i += href.length;
        continue;
      }
    }

    // Links (and images, rendered as links to their href — CSP blocks the
    // pixels anyway, but the URL is still worth a click).
    const linkStart = ch === "[" ? i : ch === "!" && text[i + 1] === "[" ? i + 1 : -1;
    if (linkStart >= 0) {
      const close = text.indexOf("]", linkStart + 1);
      if (close > linkStart + 1 && text[close + 1] === "(") {
        const end = text.indexOf(")", close + 2);
        // A trailing "title" chunk is legal link syntax; the href is the part
        // before the first whitespace.
        const href =
          end > 0
            ? (text
                .slice(close + 2, end)
                .trim()
                .split(/\s+/)[0] ?? "")
            : "";
        // Trailing sentence punctuation is prose, not path — the bare-path
        // rule above strips it, and an explicit drive href must not smuggle
        // it back in for shell.openPath to choke on.
        const driveHref = href.replace(/[.,;:!?]+$/, "");
        if (end > 0 && (SAFE_HREF.test(href) || DRIVE_PATH.test(driveHref))) {
          flush();
          out.push({
            kind: "link",
            href: SAFE_HREF.test(href) ? href : driveHref,
            children: parseInline(text.slice(linkStart + 1, close)),
          });
          i = end + 1;
          continue;
        }
      }
      buf += ch;
      i += 1;
      continue;
    }

    if (ch === "h") {
      const url = AUTOLINK.exec(text.slice(i));
      if (url) {
        // Trailing sentence punctuation is prose, not part of the URL.
        const href = url[0].replace(/[.,;:!?]+$/, "");
        flush();
        out.push({ kind: "link", href, children: [{ kind: "text", text: href }] });
        i += href.length;
        continue;
      }
    }

    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

function runOf(text: string, at: number, ch: string): string {
  let end = at;
  while (end < text.length && text[end] === ch) end += 1;
  return text.slice(at, end);
}

/** Map an opening delimiter run to the mark it opens; "" = not a mark. */
function inlineMark(ch: string, len: number): "strong" | "em" | "del" | "" {
  if (ch === "~") return len === 2 ? "del" : "";
  if (len === 1) return "em";
  return "strong"; // 2 or 3+ of * / _
}

/** Find where an emphasis run closes: the next run of the same char that is at least as long. */
function findClosing(text: string, from: number, ch: string, len: number): number {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] !== ch) continue;
    if (runOf(text, i, ch).length >= len) return i;
  }
  return -1;
}

// ── blocks ───────────────────────────────────────────────────────────

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*))?$/;
const HR = /^ {0,3}((?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}>/;
const ITEM = /^(\s*)([-*+]|(\d+)[.)])(?:\s+(.*))?$/;

export function parseMarkdown(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      const marker = (fence[1] ?? "`")[0] ?? "`";
      const len = (fence[1] ?? "").length;
      // Info strings look like "js" or "ts twoslash"; only the first word is the language.
      const lang = ((fence[2] ?? "").trim().split(/\s+/)[0] ?? "").toLowerCase();
      const body: string[] = [];
      i += 1;
      // An unterminated fence runs to the end of input — correct mid-stream.
      while (i < lines.length) {
        const cur = lines[i] ?? "";
        const close = cur.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
        if (close && (close[1] ?? "")[0] === marker && (close[1] ?? "").length >= len) {
          i += 1;
          break;
        }
        body.push(cur);
        i += 1;
      }
      blocks.push({ kind: "code", lang, code: body.join("\n") });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: (heading[1] ?? "#").length,
        inline: parseInline(heading[2] ?? ""),
      });
      i += 1;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] ?? "")) {
        inner.push((lines[i] ?? "").replace(/^ {0,3}> ?/, ""));
        i += 1;
      }
      blocks.push({ kind: "quote", children: parseMarkdown(inner.join("\n")) });
      continue;
    }

    const table = tableAt(lines, i);
    if (table) {
      blocks.push(table.block);
      i = table.next;
      continue;
    }

    const list = ITEM.test(line);
    if (list) {
      const parsed = parseList(lines, i);
      blocks.push(parsed.block);
      i = parsed.next;
      continue;
    }

    // Paragraph: up to a blank line or the start of any block above.
    const para: string[] = [];
    while (i < lines.length) {
      const cur = lines[i] ?? "";
      if (
        cur.trim() === "" ||
        FENCE.test(cur) ||
        HEADING.test(cur) ||
        HR.test(cur) ||
        QUOTE.test(cur) ||
        ITEM.test(cur) ||
        tableAt(lines, i) !== null
      ) {
        break;
      }
      para.push(cur);
      i += 1;
    }
    blocks.push({ kind: "paragraph", inline: parseInline(para.join("\n")) });
  }

  return blocks;
}

// ── lists ────────────────────────────────────────────────────────────

interface RawItem {
  indent: number;
  ordered: boolean;
  /** First number of an ordered item ("3." starts counting at 3). */
  start: number;
  text: string;
}

/**
 * Gather one list: marker lines plus their indented continuations, stopping at
 * the first line that belongs to a shallower context. Indents map to nesting
 * depths by rank (normalized so the shallowest marker is depth 0), which
 * absorbs both 2-space and 4-space conventions.
 */
function parseList(lines: string[], start: number): { block: MdListBlock; next: number } {
  const raw: RawItem[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      // Blank inside a list only continues it when another item follows soon.
      const nextNonBlank = lines.findIndex((l, j) => j > i && l.trim() !== "");
      if (nextNonBlank === -1 || !ITEM.test(lines[nextNonBlank] ?? "")) break;
      i += 1;
      continue;
    }
    const item = line.match(ITEM);
    if (item) {
      raw.push({
        indent: (item[1] ?? "").length,
        ordered: item[3] !== undefined,
        start: item[3] !== undefined ? Number(item[3]) || 1 : 1,
        text: item[4] ?? "",
      });
      i += 1;
      continue;
    }
    // A more-indented plain line continues the current item; anything else
    // ends the list and becomes the next block.
    const current = raw[raw.length - 1];
    if (current && (line.match(/^\s+/)?.[0] ?? "").length > current.indent) {
      current.text += `\n${line.trim()}`;
      i += 1;
    } else {
      break;
    }
  }

  // Indent rank = nesting depth (shallowest marker → 0), so both 2-space and
  // 4-space conventions land correctly. Assembly walks a depth stack: an item
  // becomes a child of the nearest previously seen item with smaller indent.
  const indents = [...new Set(raw.map((r) => r.indent))].sort((a, b) => a - b);
  const items: MdListItem[] = [];
  const stack: { item: MdListItem; depth: number }[] = [];
  for (const entry of raw) {
    const depth = indents.indexOf(entry.indent);
    const item: MdListItem = { inline: parseInline(entry.text), sublist: null };
    while (stack.length > 0 && (stack[stack.length - 1]?.depth ?? -1) >= depth) stack.pop();
    const parent = stack[stack.length - 1]?.item;
    if (parent) {
      parent.sublist ??= { kind: "list", ordered: entry.ordered, start: entry.start, items: [] };
      parent.sublist.items.push(item);
    } else {
      items.push(item);
    }
    stack.push({ item, depth });
  }

  const first = raw[0];
  const block: MdListBlock = {
    kind: "list",
    ordered: first?.ordered ?? false,
    start: first?.start ?? 1,
    items,
  };
  return { block, next: i };
}

// ── tables ───────────────────────────────────────────────────────────

/** A GFM table starts where a |-bearing row is followed by a delimiter row. */
function tableAt(lines: string[], head: number): { block: MdBlock; next: number } | null {
  const header = lines[head] ?? "";
  if (!header.includes("|")) return null;
  const delim = lines[head + 1] ?? "";
  const align = delimiterAlign(delim);
  if (!align) return null;

  const headCells = splitRow(header).map((cell) => parseInline(cell.trim()));
  if (headCells.length !== align.length) return null;

  const rows: MdInline[][][] = [];
  let i = head + 2;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || !line.includes("|")) break;
    const cells = splitRow(line).map((cell) => parseInline(cell.trim()));
    while (cells.length < align.length) cells.push([]);
    rows.push(cells.slice(0, align.length));
    i += 1;
  }
  return { block: { kind: "table", align, head: headCells, rows }, next: i };
}

function delimiterAlign(line: string): MdAlign[] | null {
  const cells = splitRow(line);
  if (cells.length === 0) return null;
  const align: MdAlign[] = [];
  for (const cell of cells) {
    const m = cell.trim().match(/^(:?)(-+)(:?)$/);
    if (!m) return null;
    align.push(m[1] && m[3] ? "center" : m[3] ? "right" : "left");
  }
  return align;
}

/** Split a table row on |, dropping the optional leading/trailing pipe. */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|");
}
