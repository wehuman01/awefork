/**
 * Canvas scope: decide which sessions belong on the canvas.
 *
 * Rule: the canvas shows the branch stories you pinned, plus the story you
 * are looking at. Concretely: pinned sessions and the selected session each
 * bring their fork subtree (descendants); the selected session also brings
 * its direct parent so the fork point has context. Everything else stays in
 * the sidebar index — the canvas is a workbench, not the archive.
 */

import type { LineageMap, SessionSummary } from "./types.js";

export function selectCanvasSessions(
  sessions: SessionSummary[],
  lineage: LineageMap,
  pinnedIds: string[],
  selectedId: string | null,
): SessionSummary[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
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

  for (const id of pinnedIds) addSubtree(id);

  if (selectedId && byId.has(selectedId)) {
    addSubtree(selectedId);
    const parent = lineage[selectedId]?.parentId ?? byId.get(selectedId)?.parentSessionId;
    if (parent && byId.has(parent)) keep.add(parent);
  }

  return sessions.filter((s) => keep.has(s.id));
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
