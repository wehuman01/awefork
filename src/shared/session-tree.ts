import type { ArchiveState, LineageMap, SessionSummary } from "./types.js";

export interface SessionGroup {
  directory: string;
  /** Tree roots in this directory, newest first. */
  roots: SessionTreeNode[];
}

export interface SessionTreeNode {
  session: SessionSummary;
  children: SessionTreeNode[];
}

export interface BuildTreeOptions {
  /** Hide agent-spawned subagent sessions. Default true. */
  hideSubagents: boolean;
}

/**
 * Overlay awefork's fork lineage onto raw sessions: a session recorded as a
 * fork gets origin "fork" and its parent id, even though the agent API reports
 * it as a plain root session.
 */
export function enrichSessions(sessions: SessionSummary[], lineage: LineageMap): SessionSummary[] {
  return sessions.map((session) => {
    const record = lineage[session.id];
    if (record) {
      return { ...session, origin: "fork", parentSessionId: record.parentId };
    }
    return session;
  });
}

/**
 * Build the display tree: group by directory, nest forks (and optionally
 * subagents) under their parent, newest first.
 *
 * A fork whose parent is missing (e.g. the parent was deleted, or the fork
 * happened outside awefork) is treated as a root — never dropped.
 */
export function buildSessionTree(
  sessions: SessionSummary[],
  lineage: LineageMap,
  options: BuildTreeOptions = { hideSubagents: true },
): SessionGroup[] {
  const nodeOf = new Map<string, SessionTreeNode>();

  const nodes: SessionTreeNode[] = [];
  for (const session of enrichSessions(sessions, lineage)) {
    if (options.hideSubagents && session.origin === "subagent") continue;
    const node: SessionTreeNode = { session, children: [] };
    nodeOf.set(session.id, node);
    nodes.push(node);
  }

  // Attach under the parent only when the parent is present as a rendered
  // node. Hidden (subagent) parents or absent parents have no node, so their
  // forks fall through to roots — never silently dropped.
  const rootsByDir = new Map<string, SessionTreeNode[]>();
  for (const node of nodes) {
    const pnode = node.session.parentSessionId
      ? nodeOf.get(node.session.parentSessionId)
      : undefined;
    if (pnode) {
      pnode.children.push(node);
      continue;
    }
    const roots =
      rootsByDir.get(node.session.directory) ?? addRootBucket(rootsByDir, node.session.directory);
    roots.push(node);
  }

  const sortRec = (list: SessionTreeNode[]): void => {
    list.sort((a, b) => b.session.updatedAt - a.session.updatedAt);
    for (const node of list) sortRec(node.children);
  };

  return [...rootsByDir.entries()]
    .map(([directory, roots]) => {
      sortRec(roots);
      return { directory, roots };
    })
    .sort((a, b) => latestUpdated(b.roots) - latestUpdated(a.roots));
}

/**
 * Sessions strictly below `rootId` in the fork tree — its children and every
 * deeper descendant. Parents resolve lineage-first, like the canvas graph and
 * sidebar tree; subagents are skipped so the set matches the rendered cards.
 * The canvas uses this to keep the selected session's subtree readable while
 * everything off the active path dims.
 */
export function descendantSessionIds(
  sessions: SessionSummary[],
  lineage: LineageMap,
  rootId: string | null,
): Set<string> {
  const ids = new Set<string>();
  if (!rootId) return ids;

  const byId = new Map(sessions.filter((s) => s.origin !== "subagent").map((s) => [s.id, s]));
  if (!byId.has(rootId)) return ids;

  const childrenOf = new Map<string, string[]>();
  for (const session of byId.values()) {
    const parent = lineage[session.id]?.parentId ?? session.parentSessionId;
    if (parent && parent !== session.id && byId.has(parent)) {
      const list = childrenOf.get(parent);
      if (list) list.push(session.id);
      else childrenOf.set(parent, [session.id]);
    }
  }

  const queue = childrenOf.get(rootId) ?? [];
  for (let i = 0; i < queue.length; i += 1) {
    const id = queue[i];
    if (id === undefined || ids.has(id)) continue;
    ids.add(id);
    queue.push(...(childrenOf.get(id) ?? []));
  }
  return ids;
}

function addRootBucket(rootsByDir: Map<string, SessionTreeNode[]>, directory: string) {
  const bucket: SessionTreeNode[] = [];
  rootsByDir.set(directory, bucket);
  return bucket;
}

function latestUpdated(nodes: SessionTreeNode[]): number {
  if (nodes.length === 0) return 0;
  return Math.max(...nodes.map((n) => n.session.updatedAt));
}

/**
 * The session that takes the deleted one's place in a flat display list:
 * the next row, else the previous one, else null. Deleting from the middle
 * keeps the selection where the user's cursor is instead of jumping away.
 */
export function pickNeighborId(orderedIds: string[], deletedId: string): string | null {
  const index = orderedIds.indexOf(deletedId);
  if (index === -1) return null;
  const rest = orderedIds.filter((id) => id !== deletedId);
  return rest[index] ?? rest[index - 1] ?? null;
}

/**
 * Drop archived sessions from the sidebar pool. A session is hidden when its
 * own id is archived OR its whole directory is; directories match by path at
 * read time, so sessions created under an archived directory later are hidden
 * too. The two lists combine independently: restoring a directory leaves
 * individually archived sessions archived.
 */
export function withoutArchived(
  sessions: SessionSummary[],
  archive: ArchiveState,
): SessionSummary[] {
  if (archive.sessions.length === 0 && archive.directories.length === 0) return sessions;
  const ids = new Set(archive.sessions.map((entry) => entry.id));
  const dirs = new Set(archive.directories.map((entry) => entry.path));
  return sessions.filter((s) => !ids.has(s.id) && !dirs.has(s.directory));
}
