/**
 * Canvas scope: decide which sessions belong on the canvas.
 *
 * Rule: the canvas shows the story you are looking at — the selected
 * session's whole fork tree, found by walking up to the top of its story
 * first, so a fresh fork keeps the source line and its sibling branches
 * visible. Everything else, starred or not, stays in the sidebar index —
 * the canvas is a workbench, not the archive; stars are bookmarks.
 */

import type { LineageMap, SessionSummary } from "./types.js";

export function selectCanvasSessions(
  sessions: SessionSummary[],
  lineage: LineageMap,
  selectedId: string | null,
): SessionSummary[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));

  if (!selectedId || !byId.has(selectedId)) return [];

  const childrenOf = new Map<string, string[]>();
  for (const session of sessions) {
    const parent = lineage[session.id]?.parentId ?? session.parentSessionId;
    if (parent && byId.has(parent)) push(childrenOf, parent, session.id);
  }

  const keep = new Set<string>();
  const addSubtree = (rootId: string): void => {
    const queue = [rootId];
    for (let i = 0; i < queue.length; i += 1) {
      const id = queue[i];
      if (!id || !byId.has(id) || keep.has(id)) continue;
      keep.add(id);
      for (const child of childrenOf.get(id) ?? []) queue.push(child);
    }
  };

  // Whole story, not just the branch below the selection: walk up to the
  // story's root, then keep its entire fork tree (siblings included).
  let rootId = selectedId;
  const walked = new Set([rootId]);
  for (;;) {
    const parent = lineage[rootId]?.parentId ?? byId.get(rootId)?.parentSessionId;
    if (!parent || !byId.has(parent) || walked.has(parent)) break;
    walked.add(parent);
    rootId = parent;
  }
  addSubtree(rootId);

  return sessions.filter((s) => keep.has(s.id));
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
