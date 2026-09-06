import type { LineageMap, SessionSummary } from "./types.js";

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

  const enrich = (session: SessionSummary): SessionSummary => {
    const record = lineage[session.id];
    if (record) {
      return { ...session, origin: "fork", parentSessionId: record.parentId };
    }
    return session;
  };

  const nodes: SessionTreeNode[] = [];
  for (const raw of sessions) {
    const session = enrich(raw);
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

function addRootBucket(rootsByDir: Map<string, SessionTreeNode[]>, directory: string) {
  const bucket: SessionTreeNode[] = [];
  rootsByDir.set(directory, bucket);
  return bucket;
}

function latestUpdated(nodes: SessionTreeNode[]): number {
  if (nodes.length === 0) return 0;
  return Math.max(...nodes.map((n) => n.session.updatedAt));
}
