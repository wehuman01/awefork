import { buildTurns, type Turn } from "./turns.js";
import type { ChatMessage, LineageMap, ModelChoice, SessionSummary } from "./types.js";

/**
 * Turn-level graph for one project directory.
 *
 * A node is a turn (user prompt + its reply) or a "stub" (a session with no
 * turns of its own — a fresh fork, or a session whose messages failed to
 * load). Edges: "sequence" chains turns inside a session; "fork" connects the
 * forked-from turn to the first turn the child branch added.
 *
 * Forked sessions inherit a copy of the parent's history, so only the child's
 * turns AFTER the inherited prefix are rendered — otherwise every branch
 * would re-draw the conversation it forked from. The prefix is detected by
 * leading message ids shared with the parent; if ids don't match (copied
 * rows re-keyed), the recorded fork position (`atMessageId`'s turn index + 1)
 * is used as a fallback.
 */

export const NODE_WIDTH = 340;
export const NODE_HEIGHT = 172;
export const COL_GAP = 72;
export const ROW_GAP = 44;

export interface TurnNode {
  /** `${sessionId}:${messageId}` for turns, `${sessionId}::stub` for stubs. */
  id: string;
  kind: "turn" | "stub";
  sessionId: string;
  /** User message id of the turn; null for stubs. */
  messageId: string | null;
  title: string;
  preview: string;
  toolNames: string[];
  /** Distinct models used by the turn's replies; empty for stubs. */
  modelIds: string[];
  /** Model that wrote the turn's last reply; null for stubs / when unreported. */
  model: ModelChoice | null;
  createdAt: number;
  col: number;
  row: number;
  x: number;
  y: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: "sequence" | "fork";
}

export interface TurnGraph {
  nodes: TurnNode[];
  edges: GraphEdge[];
}

export interface BuildGraphOptions {
  /** Sessions of ONE directory, already sorted or not — the builder sorts. */
  sessions: SessionSummary[];
  lineage: LineageMap;
  /** Messages per session id; missing entries render as stubs. */
  messages: Record<string, ChatMessage[]>;
}

export function buildTurnGraph(options: BuildGraphOptions): TurnGraph {
  const sessions = options.sessions.filter((s) => s.origin !== "subagent");
  const turnsOf = new Map<string, Turn[]>();
  for (const session of sessions) {
    turnsOf.set(session.id, buildTurns(session.id, options.messages[session.id] ?? []));
  }

  const parentOf = new Map<string, string | null>();
  for (const session of sessions) {
    const lineageParent = options.lineage[session.id]?.parentId;
    const directParent = session.parentSessionId;
    const parent = sessions.some((s) => s.id === (lineageParent ?? directParent))
      ? (lineageParent ?? directParent)
      : null;
    parentOf.set(session.id, parent);
  }

  // Shared-prefix length per session with a parent (see module comment).
  const sharedCount = new Map<string, number>();
  const byId = new Map(sessions.map((s) => [s.id, s]));
  for (const session of sessions) {
    const parent = parentOf.get(session.id);
    if (!parent) continue;
    sharedCount.set(session.id, sharedPrefixCount(session.id, parent, options));
  }

  const childrenOf = new Map<string, SessionSummary[]>();
  const roots: SessionSummary[] = [];
  for (const session of sessions) {
    const parent = parentOf.get(session.id);
    if (parent) {
      push(childrenOf, parent, session);
    } else {
      roots.push(session);
    }
  }
  const byCreation = (a: SessionSummary, b: SessionSummary) =>
    a.createdAt - b.createdAt || a.id.localeCompare(b.id);
  roots.sort(byCreation);
  for (const list of childrenOf.values()) list.sort(byCreation);

  const nodes: TurnNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeById = new Map<string, TurnNode>();
  /** messageId → node id, shared-prefix ids included (they resolve to the
   *  original session's node, so forks of forks branch from the right card). */
  const nodeByMessage = new Map<string, string>();
  const nodeBySessionLast = new Map<string, string>();
  const occupied = new Set<string>();
  let maxRow = -1;

  const findFreeRow = (col: number, from: number): number => {
    let row = Math.max(from, 0);
    while (occupied.has(`${col}:${row}`)) row += 1;
    occupied.add(`${col}:${row}`);
    maxRow = Math.max(maxRow, row);
    return row;
  };

  const addNode = (
    session: SessionSummary,
    col: number,
    fromRow: number,
    data: Omit<TurnNode, "col" | "row" | "x" | "y" | "sessionId">,
  ): TurnNode => {
    const row = findFreeRow(col, fromRow);
    const node: TurnNode = {
      ...data,
      sessionId: session.id,
      col,
      row,
      x: col * (NODE_WIDTH + COL_GAP),
      y: row * (NODE_HEIGHT + ROW_GAP),
    };
    nodes.push(node);
    nodeById.set(node.id, node);
    nodeBySessionLast.set(session.id, node.id);
    return node;
  };

  const connect = (from: string | null, to: string, kind: GraphEdge["kind"]): void => {
    if (from) edges.push({ from, to, kind });
  };

  const visit = (
    session: SessionSummary,
    startCol: number,
    fromRow: number,
    sourceNodeId: string | null,
    edgeKind: GraphEdge["kind"],
  ): void => {
    const turns = turnsOf.get(session.id) ?? [];
    const fresh = turns.slice(sharedCount.get(session.id) ?? 0);

    if (fresh.length === 0) {
      const stub = addNode(session, startCol, fromRow, {
        id: `${session.id}::stub`,
        kind: "stub",
        messageId: null,
        title: session.title || "空会话",
        preview: "",
        toolNames: [],
        modelIds: [],
        model: null,
        createdAt: session.createdAt,
      });
      connect(sourceNodeId, stub.id, edgeKind);
    }

    let previousId = sourceNodeId;
    let previousKind = edgeKind;
    for (const [index, turn] of fresh.entries()) {
      const node = addNode(session, startCol + index, fromRow, {
        id: `${session.id}:${turn.messageId}`,
        kind: "turn",
        messageId: turn.messageId,
        title: turn.title,
        preview: turn.preview,
        toolNames: turn.toolNames,
        modelIds: turn.modelIds,
        model: turn.model,
        createdAt: turn.createdAt,
      });
      nodeByMessage.set(turn.messageId, node.id);
      connect(previousId, node.id, index === 0 ? previousKind : "sequence");
      previousId = node.id;
      previousKind = "sequence";
      fromRow = node.row;
    }

    for (const child of childrenOf.get(session.id) ?? []) {
      const record = options.lineage[child.id];
      const forkNode = resolveForkSource(session, record?.atMessageId ?? null);
      visit(
        child,
        (forkNode?.col ?? startCol + fresh.length) + 1,
        forkNode ? forkNode.row + 1 : fromRow + 1,
        forkNode?.id ?? previousId,
        "fork",
      );
    }
  };

  const resolveForkSource = (
    session: SessionSummary,
    atMessageId: string | null,
  ): TurnNode | null => {
    if (atMessageId) {
      const id = nodeByMessage.get(atMessageId);
      if (id) return nodeById.get(id) ?? null;
    }
    // Fall back to the session's own last rendered node (stub or last turn).
    const lastId = nodeBySessionLast.get(session.id);
    return lastId ? (nodeById.get(lastId) ?? null) : null;
  };

  let cursorRow = 0;
  for (const root of roots) {
    visit(root, 0, cursorRow, null, "sequence");
    cursorRow = maxRow + 2;
  }

  return { nodes, edges };
}

function sharedPrefixCount(
  sessionId: string,
  parentId: string,
  options: BuildGraphOptions,
): number {
  const childTurns = buildTurns(sessionId, options.messages[sessionId] ?? []);
  const parentTurns = buildTurns(parentId, options.messages[parentId] ?? []);
  const parentIds = new Set(parentTurns.map((t) => t.messageId));

  let count = 0;
  while (count < childTurns.length) {
    const turn = childTurns[count];
    if (!turn || !parentIds.has(turn.messageId)) break;
    count += 1;
  }
  if (count > 0) return count;

  const atMessageId = options.lineage[sessionId]?.atMessageId;
  if (!atMessageId) return 0;
  const index = parentTurns.findIndex((t) => t.messageId === atMessageId);
  if (index === -1) return 0;
  return Math.min(index + 1, childTurns.length);
}

function push(map: Map<string, SessionSummary[]>, key: string, value: SessionSummary): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
