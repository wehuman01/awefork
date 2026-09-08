/**
 * Full-text search over the turns of the story on the canvas.
 *
 * The whole working set lives in memory as TurnNodes, so a plain substring
 * scan is enough — no index to maintain. A turn matches when EVERY
 * whitespace-separated term appears in at least one of its searchable fields
 * (title, reply preview, tool names). The reported hit carries a snippet
 * around the best-ranked match so the results list can show context.
 */

import type { TurnNode } from "./canvas-graph.js";

/** Which field a hit's snippet comes from; also its relevance rank. */
export type HitField = "title" | "preview" | "tool";

export interface TurnSearchHit {
  nodeId: string;
  sessionId: string;
  field: HitField;
  /** Window of the field's text around the first match, "…" when trimmed. */
  snippet: string;
  /** Where the match starts inside `snippet`. */
  matchStart: number;
  matchLength: number;
}

const FIELD_RANK: Record<HitField, number> = { title: 0, preview: 1, tool: 2 };
/** Characters of context kept on each side of a match inside the snippet. */
const SNIPPET_RADIUS = 36;

export function searchTurns(nodes: TurnNode[], query: string): TurnSearchHit[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const hits: (TurnSearchHit & { rank: number; createdAt: number })[] = [];
  for (const node of nodes) {
    if (node.kind !== "turn") continue;
    const fields: { field: HitField; text: string }[] = [
      { field: "title", text: node.title },
      // A failed run's preview is empty — the error string is its only content.
      { field: "preview", text: node.preview || node.error || "" },
      { field: "tool", text: node.toolNames.join(" ") },
    ];

    let best: { field: HitField; index: number; length: number } | null = null;
    let matchedAll = true;
    for (const term of terms) {
      let termHit: { field: HitField; index: number; length: number } | null = null;
      for (const { field, text } of fields) {
        const index = text.toLowerCase().indexOf(term);
        if (index === -1) continue;
        if (
          !termHit ||
          FIELD_RANK[field] < FIELD_RANK[termHit.field] ||
          (field === termHit.field && index < termHit.index)
        ) {
          termHit = { field, index, length: term.length };
        }
      }
      if (!termHit) {
        matchedAll = false;
        break;
      }
      if (!best || FIELD_RANK[termHit.field] < FIELD_RANK[best.field]) best = termHit;
    }
    if (!matchedAll || !best) continue;

    const text = fields.find((f) => f.field === best?.field)?.text ?? "";
    const { snippet, matchStart } = snippetAround(text, best.index, best.length);
    hits.push({
      nodeId: node.id,
      sessionId: node.sessionId,
      field: best.field,
      snippet,
      matchStart,
      matchLength: best.length,
      rank: FIELD_RANK[best.field],
      createdAt: node.createdAt,
    });
  }

  return hits
    .sort(
      (a, b) => a.rank - b.rank || a.createdAt - b.createdAt || a.nodeId.localeCompare(b.nodeId),
    )
    .map((hit) => ({
      nodeId: hit.nodeId,
      sessionId: hit.sessionId,
      field: hit.field,
      snippet: hit.snippet,
      matchStart: hit.matchStart,
      matchLength: hit.matchLength,
    }));
}

function snippetAround(
  text: string,
  index: number,
  length: number,
): { snippet: string; matchStart: number } {
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + length + SNIPPET_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return {
    snippet: `${prefix}${text.slice(start, end)}${suffix}`,
    matchStart: index - start + prefix.length,
  };
}
