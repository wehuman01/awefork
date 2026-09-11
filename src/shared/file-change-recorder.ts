import { promises as fs } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import type { AgentFileChangesFact } from "./agent-descriptor.js";
import { lineDiff } from "./diff.js";
import {
  emptySessionChanges,
  readSessionChanges,
  readSnapshotBlob,
  sessionChangesDir,
  writeSessionChanges,
  writeSnapshotBlob,
} from "./file-changes.js";
import type { FileChangeEntry, SessionFileChanges } from "./types.js";

/**
 * The observer-seat recorder. The opencode adapter feeds it every tool-part
 * snapshot frame it sees; this module decides what that frame did to a file
 * and persists the evidence before the world moves on.
 *
 * What the observer seat can and cannot promise:
 * - "before" is read the moment a frame first names a path — usually ahead of
 *   the tool's write, but SSE buffering can lose that race. A lost race
 *   undercounts the diff; it never invents changes that did not happen.
 * - A part whose first frame is already terminal (app started or reconnected
 *   mid-run) has no trustworthy "before": the entry records the file with
 *   status "unknown" instead of guessing.
 * - Snapshots cap at 2 MiB and skip binaries; those entries keep status-only
 *   rows. Coverage is project-local: paths outside the session's directory
 *   are dropped entirely.
 *
 * Net semantics per (message, path): the first observation keeps "before",
 * every terminal state refreshes "after", and a file returned to its original
 * content drops off the card.
 */

/** Max bytes read into a snapshot; larger files keep a status-only row. */
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

/** One frame as the adapter extracted it from the descriptor's paths. */
export interface ToolPartFrame {
  sessionId: string;
  messageId: string;
  partId: string;
  tool: string;
  filePath: string | null;
  stateKey: string | null;
}

export interface FileChangeRecorderOptions {
  /** Backend root dir; the session dir lives under it. */
  rootDir: string;
  /** The descriptor's fileChanges section; presence gates recording. */
  fact: AgentFileChangesFact;
  /** Resolve a session's working directory (project root); null = unknown. */
  directoryOf: (sessionId: string) => Promise<string | null>;
  /** Injectable for tests; defaults to node:fs. */
  readFile?: (path: string) => Promise<Buffer>;
}

/** Why a snapshot read produced no content. */
type ReadResult =
  | { kind: "ok"; content: string }
  /** The file was not there — a fact, unlike an error. */
  | { kind: "absent" }
  | { kind: "skipped"; note: string };

interface LiveEntry {
  entry: FileChangeEntry;
  ordinal: number;
  before: { kind: "ok"; content: string } | { kind: "absent" } | null;
  after: { kind: "ok"; content: string } | { kind: "absent" } | null;
  /** True once a terminal frame was seen for this path. */
  done: boolean;
  /** True unless the first frame for this path was already terminal. */
  sawActive: boolean;
}

export interface FileChangeRecorder {
  observe(frame: ToolPartFrame): void;
  /** Resolves once every frame handed to observe so far has settled. */
  flush(): Promise<void>;
}

export function createFileChangeRecorder(options: FileChangeRecorderOptions): FileChangeRecorder {
  const { fact } = options;
  const tools = new Set<string>(fact.tools);
  const doneStates = new Set<string>(fact.doneStates);
  const readFile = options.readFile ?? ((path: string) => fs.readFile(path));
  let sessionDir = "";

  /** messageId → path → live entry, insertion-ordered for stable ordinals. */
  const live = new Map<string, Map<string, LiveEntry>>();
  let index: SessionFileChanges = emptySessionChanges([...fact.tools]);
  let directory: string | null = null;
  let directoryAsked = false;
  let booted: Promise<void> | null = null;
  /** Serializes state mutations: snapshot reads are async and must land in frame order. */
  let queue: Promise<void> = Promise.resolve();

  const tracked = (frame: ToolPartFrame): boolean =>
    frame.filePath !== null &&
    frame.stateKey !== null &&
    tools.has(frame.tool) &&
    isAbsolute(frame.filePath);

  const snapshot = async (path: string): Promise<ReadResult> => {
    let buffer: Buffer;
    try {
      buffer = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
      return { kind: "skipped", note: "文件无法读取" };
    }
    if (buffer.byteLength > MAX_SNAPSHOT_BYTES) {
      return { kind: "skipped", note: "文件超过 2 MiB，未保存快照" };
    }
    if (buffer.includes(0)) {
      return { kind: "skipped", note: "二进制文件，未保存快照" };
    }
    return { kind: "ok", content: buffer.toString("utf8") };
  };

  const inProject = (path: string): boolean => {
    if (directory === null || directory === "") return false;
    const root = resolve(directory);
    const target = resolve(path);
    return target === root || target.startsWith(root + sep);
  };

  /** Persist the index; awaited on the frame queue so flush() means on-disk. */
  const persist = (): Promise<void> =>
    writeSessionChanges(sessionDir, index).catch(() => {
      // A failed sidecar write only costs the card, never the session; the
      // next terminal frame retries with the same data.
    });

  const rehydrate = async (): Promise<void> => {
    const stored = await readSessionChanges(sessionDir);
    if (!stored) return;
    index = stored;
    // Bring live entries back so a later edit in the same message (after a
    // restart or reconnect) keeps the original "before" instead of reading
    // the already-edited file as the baseline.
    for (const [messageId, entries] of Object.entries(stored.messages)) {
      const byPath = new Map<string, LiveEntry>();
      for (let ordinal = 0; ordinal < entries.length; ordinal += 1) {
        const entry = entries[ordinal];
        if (!entry) continue;
        const load = async (name: string | null): Promise<LiveEntry["before"]> => {
          if (name === null) return null;
          const content = await readSnapshotBlob(sessionDir, messageId, name);
          return content === null ? null : { kind: "ok", content };
        };
        byPath.set(entry.path, {
          entry,
          ordinal,
          before: await load(entry.before),
          after: await load(entry.after),
          done: false,
          sawActive: entry.status !== "unknown",
        });
      }
      live.set(messageId, byPath);
    }
  };

  const handleFrame = async (frame: ToolPartFrame): Promise<void> => {
    sessionDir = sessionChangesDir(options.rootDir, frame.sessionId);
    if (!booted) {
      booted = rehydrate();
    }
    await booted;
    if (!directoryAsked) {
      directoryAsked = true;
      directory = await options.directoryOf(frame.sessionId);
    }

    const filePath = frame.filePath;
    if (filePath === null || frame.stateKey === null) return;
    if (!inProject(filePath)) return;

    const byPath = live.get(frame.messageId) ?? new Map<string, LiveEntry>();
    live.set(frame.messageId, byPath);
    const existing = byPath.get(filePath);
    const terminal = doneStates.has(frame.stateKey);

    if (!existing) {
      const before = await snapshot(filePath);
      const after = terminal ? await snapshot(filePath) : null;
      const record: LiveEntry = {
        entry: {
          path: filePath,
          status: "unknown",
          added: null,
          removed: null,
          note: null,
          before: null,
          after: null,
        },
        ordinal: byPath.size,
        before: null,
        after: null,
        done: terminal,
        sawActive: !terminal,
      };
      if (!terminal && before.kind === "skipped") record.entry.note = before.note;
      // ok and absent are both facts worth keeping; only "skipped" leaves the
      // baseline unknown.
      if (!terminal && before.kind !== "skipped") record.before = before;
      if (terminal && after && after.kind !== "skipped") record.after = after;
      if (terminal && after?.kind === "skipped" && !record.entry.note) {
        record.entry.note = after.note;
      }
      byPath.set(filePath, record);
      if (terminal) await settle(frame.messageId, filePath);
      return;
    }

    existing.sawActive ||= !terminal;
    // A new active frame re-opens a settled entry: a second tool part editing
    // the same path must land its own completion, not be swallowed by the
    // previous part's done flag.
    if (!terminal) existing.done = false;
    if (terminal && !existing.done) {
      existing.done = true;
      const after = await snapshot(filePath);
      if (after.kind !== "skipped") existing.after = after;
      if (after.kind === "skipped" && !existing.entry.note) existing.entry.note = after.note;
      await settle(frame.messageId, filePath);
    }
  };

  /** Recompute status/totals from the captured contents and persist. */
  const settle = async (messageId: string, filePath: string): Promise<void> => {
    const byPath = live.get(messageId);
    const record = byPath?.get(filePath);
    if (!byPath || !record) return;
    const { entry } = record;

    const dropEntry = async (): Promise<void> => {
      byPath.delete(filePath);
      index.messages[messageId] = (index.messages[messageId] ?? []).filter(
        (e) => e.path !== filePath,
      );
      await persist();
    };

    if (!record.sawActive) {
      // Mid-run connect: record that the file was touched, claim nothing.
      entry.status = "unknown";
      entry.note = entry.note ?? "未观察到回合开始前的内容";
      entry.before = null;
      entry.added = null;
      entry.removed = null;
      await flushBlobs(messageId, record);
      await commit(messageId, entry);
      return;
    }

    const { before, after } = record;
    if (before === null || after === null) {
      // A skipped read (binary/oversized/unreadable) on either side leaves no
      // trustworthy pair — a status-only row is the honest output. Absent
      // files are facts, not skips, and survive as {kind:"absent"} above.
      entry.status = "unknown";
      entry.note = entry.note ?? "无法保存对比快照";
      await flushBlobs(messageId, record);
      await commit(messageId, entry);
      return;
    }

    if (before.kind === "absent" && after.kind === "ok") {
      entry.status = "created";
      entry.added = after.content === "" ? 0 : after.content.split("\n").length;
      entry.removed = 0;
    } else if (before.kind === "ok" && after.kind === "absent") {
      entry.status = "deleted";
      entry.added = 0;
      entry.removed = before.content === "" ? 0 : before.content.split("\n").length;
    } else if (before.kind === "ok" && after.kind === "ok") {
      const diff = lineDiff(before.content, after.content);
      if (diff.added === 0 && diff.removed === 0) {
        // Net no-op: the run returned the file to what it was. Drop the row
        // instead of showing a change that did not survive the turn.
        await dropEntry();
        return;
      }
      entry.status = "modified";
      entry.added = diff.added;
      entry.removed = diff.removed;
      if (diff.added === null) entry.note = entry.note ?? "改动过大，仅显示文件状态";
    }
    await flushBlobs(messageId, record);
    await commit(messageId, entry);
  };

  /** Write the captured contents as blobs and pin their names on the entry. */
  const flushBlobs = async (messageId: string, record: LiveEntry): Promise<void> => {
    if (record.before?.kind === "ok") {
      record.entry.before = await writeSnapshotBlob(
        sessionDir,
        messageId,
        record.ordinal,
        "before",
        record.before.content,
      );
    }
    if (record.after?.kind === "ok") {
      record.entry.after = await writeSnapshotBlob(
        sessionDir,
        messageId,
        record.ordinal,
        "after",
        record.after.content,
      );
    }
  };

  const commit = async (messageId: string, entry: FileChangeEntry): Promise<void> => {
    const entries = index.messages[messageId] ?? [];
    const at = entries.findIndex((e) => e.path === entry.path);
    if (at >= 0) entries[at] = entry;
    else entries.push(entry);
    index.messages[messageId] = entries;
    await persist();
  };

  return {
    observe(frame: ToolPartFrame): void {
      if (!tracked(frame)) return;
      // Serialize: an out-of-order snapshot read (a fast "after" beating a
      // slow "before") would swap the pair and invert the diff.
      queue = queue.then(
        () => handleFrame(frame),
        () => handleFrame(frame),
      );
    },
    flush(): Promise<void> {
      return queue;
    },
  };
}
