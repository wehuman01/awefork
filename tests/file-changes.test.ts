import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentFileChangesFact } from "../src/shared/agent-descriptor";
import { createFileChangeRecorder, type ToolPartFrame } from "../src/shared/file-change-recorder";
import {
  clearSessionChanges,
  readSessionChanges,
  readSnapshotBlob,
  sessionChangesDir,
  writeSessionChanges,
} from "../src/shared/file-changes";
import type { SessionFileChanges } from "../src/shared/types";

/**
 * Observer-seat recording, end to end on a real temp tree: frames in, index
 * and snapshot blobs out. The "agent" is the test flipping file contents
 * between frames — exactly the order the real SSE stream produces.
 */

const FACT: AgentFileChangesFact = {
  tools: ["edit", "write"],
  stateKeyPath: "state.key",
  filePathPaths: ["state.input.filePath", "filePath"],
  doneStates: ["output-available", "error"],
};

const dirs: string[] = [];

/** Temp workspace: `project` is the session's directory, `root` the sidecar root. */
async function tempRoot(): Promise<{ root: string; project: string }> {
  const base = await mkdtemp(join(tmpdir(), "awefork-changes-"));
  dirs.push(base);
  const project = join(base, "proj");
  await mkdir(join(project, "src"), { recursive: true });
  return { root: join(base, "sidecar"), project };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function frame(project: string, over: Partial<ToolPartFrame> = {}): ToolPartFrame {
  return {
    sessionId: "ses_1",
    messageId: "msg_1",
    partId: "part_1",
    tool: "edit",
    filePath: join(project, "src", "app.ts"),
    stateKey: "running",
    ...over,
  };
}

async function makeRecorder(root: string, project: string) {
  return createFileChangeRecorder({
    rootDir: root,
    fact: FACT,
    directoryOf: async () => project,
  });
}

describe("file-change store", () => {
  it("reads null for a session with no sidecar", async () => {
    const { root } = await tempRoot();
    expect(await readSessionChanges(sessionChangesDir(root, "ses_x"))).toBeNull();
  });

  it("round-trips entries and survives a clear", async () => {
    const { root } = await tempRoot();
    const sessionDir = sessionChangesDir(root, "ses_1");
    const value: SessionFileChanges = {
      version: 1,
      tools: ["edit"],
      messages: {
        msg_1: [
          {
            path: "/p/a.ts",
            status: "modified",
            added: 3,
            removed: 1,
            note: null,
            before: "0.before",
            after: "0.after",
          },
        ],
      },
    };
    await writeSessionChanges(sessionDir, value);
    expect(await readSessionChanges(sessionDir)).toEqual(value);
    await clearSessionChanges(sessionDir);
    expect(await readSessionChanges(sessionDir)).toBeNull();
  });

  it("drops malformed entries instead of failing the whole index", async () => {
    const { root } = await tempRoot();
    const sessionDir = sessionChangesDir(root, "ses_2");
    await writeSessionChanges(sessionDir, {
      version: 1,
      tools: [],
      messages: {
        msg_1: [
          {
            path: "/p/ok.ts",
            status: "modified",
            added: 1,
            removed: 0,
            note: null,
            before: null,
            after: null,
          },
          // Bad status and blob names degrade; the path-less row is dropped.
          {
            path: "/p/bad.ts",
            status: "nonsense",
            added: 1,
            removed: 0,
            note: null,
            before: "../escape",
            after: "9.before",
          },
        ],
      },
    });
    const read = await readSessionChanges(sessionDir);
    const entries = read?.messages.msg_1 ?? [];
    expect(entries).toHaveLength(2);
    expect(entries[1]?.status).toBe("unknown");
    expect(entries[1]?.before).toBeNull();
  });
});

describe("file-change recorder", () => {
  it("records a modified file with totals and a readable diff pair", async () => {
    const { root, project } = await tempRoot();
    const file = join(project, "src", "app.ts");
    await writeFile(file, "line1\nline2\nline3\n");
    const recorder = await makeRecorder(root, project);

    recorder.observe(frame(project));
    await recorder.flush();
    await writeFile(file, "line1\nline2 changed\nline3\nline4\n");
    recorder.observe(frame(project, { stateKey: "output-available" }));
    await recorder.flush();

    const read = await readSessionChanges(sessionChangesDir(root, "ses_1"));
    const entry = read?.messages.msg_1?.[0];
    expect(entry?.status).toBe("modified");
    expect(entry?.added).toBe(2);
    expect(entry?.removed).toBe(1);
    expect(entry?.before).toBe("0.before");
    expect(entry?.after).toBe("0.after");
    const sessionDir = sessionChangesDir(root, "ses_1");
    expect(await readSnapshotBlob(sessionDir, "msg_1", "0.before")).toBe("line1\nline2\nline3\n");
    expect(await readSnapshotBlob(sessionDir, "msg_1", "0.after")).toBe(
      "line1\nline2 changed\nline3\nline4\n",
    );
  });

  it("records a created file that did not exist before the run", async () => {
    const { root, project } = await tempRoot();
    const file = join(project, "new.ts");
    const recorder = await makeRecorder(root, project);

    recorder.observe(frame(project, { filePath: file, tool: "write" }));
    await recorder.flush();
    await writeFile(file, "a\nb");
    recorder.observe(frame(project, { filePath: file, stateKey: "output-available" }));
    await recorder.flush();

    const entry = (await readSessionChanges(sessionChangesDir(root, "ses_1")))?.messages.msg_1?.[0];
    expect(entry?.status).toBe("created");
    expect(entry?.added).toBe(2);
    expect(entry?.removed).toBe(0);
    expect(entry?.before).toBeNull();
  });

  it("records a deleted file", async () => {
    const { root, project } = await tempRoot();
    const file = join(project, "src", "app.ts");
    await writeFile(file, "gone\nsoon");
    const recorder = await makeRecorder(root, project);

    recorder.observe(frame(project));
    await recorder.flush();
    await rm(file);
    recorder.observe(frame(project, { stateKey: "output-available" }));
    await recorder.flush();

    const entry = (await readSessionChanges(sessionChangesDir(root, "ses_1")))?.messages.msg_1?.[0];
    expect(entry?.status).toBe("deleted");
    expect(entry?.removed).toBe(2);
    expect(entry?.after).toBeNull();
  });

  it("claims nothing when the first frame is already terminal", async () => {
    const { root, project } = await tempRoot();
    const file = join(project, "src", "app.ts");
    await writeFile(file, "already edited");
    const recorder = await makeRecorder(root, project);

    recorder.observe(frame(project, { stateKey: "output-available" }));
    await recorder.flush();

    const entry = (await readSessionChanges(sessionChangesDir(root, "ses_1")))?.messages.msg_1?.[0];
    expect(entry?.status).toBe("unknown");
    expect(entry?.added).toBeNull();
    expect(entry?.note).toContain("未观察");
  });

  it("keeps one entry per path with the latest after when a message edits twice", async () => {
    const { root, project } = await tempRoot();
    const file = join(project, "src", "app.ts");
    await writeFile(file, "v0");
    const recorder = await makeRecorder(root, project);

    recorder.observe(frame(project, { partId: "p1" }));
    await recorder.flush();
    await writeFile(file, "v1");
    recorder.observe(frame(project, { partId: "p1", stateKey: "output-available" }));
    recorder.observe(frame(project, { partId: "p2" }));
    await recorder.flush();
    await writeFile(file, "v2 final");
    recorder.observe(frame(project, { partId: "p2", stateKey: "output-available" }));
    await recorder.flush();

    const entries =
      (await readSessionChanges(sessionChangesDir(root, "ses_1")))?.messages.msg_1 ?? [];
    expect(entries).toHaveLength(1);
    const sessionDir = sessionChangesDir(root, "ses_1");
    expect(await readSnapshotBlob(sessionDir, "msg_1", "0.before")).toBe("v0");
    expect(await readSnapshotBlob(sessionDir, "msg_1", "0.after")).toBe("v2 final");
  });

  it("drops a file the run returned to its original content", async () => {
    const { root, project } = await tempRoot();
    const file = join(project, "src", "app.ts");
    await writeFile(file, "same");
    const recorder = await makeRecorder(root, project);

    recorder.observe(frame(project));
    await recorder.flush();
    await writeFile(file, "touched");
    recorder.observe(frame(project, { stateKey: "output-available" }));
    recorder.observe(frame(project, { partId: "p2" }));
    await recorder.flush();
    await writeFile(file, "same");
    recorder.observe(frame(project, { partId: "p2", stateKey: "output-available" }));
    await recorder.flush();

    const read = await readSessionChanges(sessionChangesDir(root, "ses_1"));
    expect(read?.messages.msg_1).toBeUndefined();
  });

  it("ignores paths outside the session's project", async () => {
    const { root, project } = await tempRoot();
    const outside = join(project, "..", "elsewhere.txt");
    await writeFile(outside, "x");
    const recorder = await makeRecorder(root, project);

    recorder.observe(frame(project, { filePath: outside }));
    recorder.observe(frame(project, { filePath: outside, stateKey: "output-available" }));
    await recorder.flush();

    expect(await readSessionChanges(sessionChangesDir(root, "ses_1"))).toBeNull();
  });

  it("keeps a status-only row for binary files", async () => {
    const { root, project } = await tempRoot();
    const file = join(project, "blob.bin");
    await writeFile(file, Buffer.from([0x61, 0x00, 0x62]));
    const recorder = await makeRecorder(root, project);

    recorder.observe(frame(project, { filePath: file }));
    await recorder.flush();
    await writeFile(file, Buffer.from([0x61, 0x00, 0x63]));
    recorder.observe(frame(project, { filePath: file, stateKey: "output-available" }));
    await recorder.flush();

    const entry = (await readSessionChanges(sessionChangesDir(root, "ses_1")))?.messages.msg_1?.[0];
    expect(entry?.status).toBe("unknown");
    expect(entry?.note).toContain("二进制");
  });

  it("rehydrates from the stored index so a restart keeps the original before", async () => {
    const { root, project } = await tempRoot();
    const file = join(project, "src", "app.ts");
    await writeFile(file, "original");

    const first = await makeRecorder(root, project);
    first.observe(frame(project));
    await first.flush();
    await writeFile(file, "edited once");
    first.observe(frame(project, { stateKey: "output-available" }));
    await first.flush();

    // A new process joins mid-message: the file now says "edited once", but
    // the stored baseline is still "original".
    const second = await makeRecorder(root, project);
    second.observe(frame(project, { partId: "p2" }));
    await second.flush();
    await writeFile(file, "edited twice");
    second.observe(frame(project, { partId: "p2", stateKey: "output-available" }));
    await second.flush();

    const sessionDir = sessionChangesDir(root, "ses_1");
    expect(await readSnapshotBlob(sessionDir, "msg_1", "0.before")).toBe("original");
    expect(await readSnapshotBlob(sessionDir, "msg_1", "0.after")).toBe("edited twice");
  });

  it("ignores tools the descriptor does not track", async () => {
    const { root, project } = await tempRoot();
    const file = join(project, "src", "app.ts");
    await writeFile(file, "x");
    const recorder = await makeRecorder(root, project);

    recorder.observe(frame(project, { tool: "bash" }));
    recorder.observe(frame(project, { tool: "bash", stateKey: "output-available" }));
    await recorder.flush();

    expect(await readSessionChanges(sessionChangesDir(root, "ses_1"))).toBeNull();
  });
});
