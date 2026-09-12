import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexHome } from "../src/main/codex-homes.js";
import { createCodexMultiHomeAdapter } from "../src/main/codex-multihome.js";
import type { AgentAdapter, AgentEvent } from "../src/shared/types.js";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = join(tmpdir(), `awefork-mh-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** In-memory per-home adapter recording which calls it received. */
function fakeHomeAdapter(
  home: CodexHome,
  sessions: string[],
  updatedAt: Record<string, number> = {},
): AgentAdapter {
  const adapter = {
    kind: "codex",
    listSessions: vi
      .fn()
      .mockResolvedValue(
        sessions.map((id) => makeSummary(id, updatedAt[id] ?? (home.id === "default" ? 200 : 100))),
      ),
    messages: vi.fn().mockResolvedValue([]),
    messageAttachments: vi.fn().mockResolvedValue([]),
    listModels: vi.fn().mockResolvedValue([]),
    createSession: vi.fn(),
    fork: vi.fn().mockResolvedValue(makeSummary("forked", 100)),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    renameSession: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue(undefined),
    respondInteraction: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(() => {}),
    dispose: vi.fn(),
  };
  return adapter as unknown as AgentAdapter;
}

function makeSummary(
  id: string,
  updatedAt: number,
): {
  id: string;
  title: string;
  directory: string;
  parentSessionId: null;
  origin: "root";
  createdAt: number;
  updatedAt: number;
} {
  return {
    id,
    title: `session ${id}`,
    directory: "/tmp",
    parentSessionId: null,
    origin: "root",
    createdAt: 1,
    updatedAt,
  };
}

interface Harness {
  facade: AgentAdapter;
  byHome: Map<string, AgentAdapter>;
}

function makeFacade(
  homeSessions: Record<string, string[]>,
  overrides: Partial<Parameters<typeof createCodexMultiHomeAdapter>[0]> = {},
  updatedAt: Record<string, Record<string, number>> = {},
): Harness {
  const homes: CodexHome[] = Object.keys(homeSessions).map((id) => ({
    id,
    path: join("/homes", id),
    label: id,
  }));
  const byHome = new Map<string, AgentAdapter>(
    Object.entries(homeSessions).map(([id, sessions]) => {
      const home = homes.find((h) => h.id === id)!;
      return [id, fakeHomeAdapter(home, sessions, updatedAt[id])];
    }),
  );
  const facade = createCodexMultiHomeAdapter({
    lineagePath: join(makeDir(), "lineage.json"),
    homes: () => homes,
    createHomeAdapter: (home) => Promise.resolve(byHome.get(home.id)!),
    defaultHomePath: () => "/homes/default",
    ...overrides,
  });
  return { facade, byHome };
}

describe("codex multi-home facade", () => {
  it("merges sessions from every home, default home winning id collisions", async () => {
    const { facade } = makeFacade({
      default: ["shared", "own"],
      cxo: ["foreign"],
    });
    const sessions = await facade.listSessions();
    expect(sessions.map((s) => s.id).sort()).toEqual(["foreign", "own", "shared"]);
    // The duplicate from the foreign home is dropped, not double-listed.
    expect(sessions).toHaveLength(3);
  });

  it("sorts the merged list by updatedAt descending", async () => {
    // A foreign session newer than every default-home one must still land on
    // top — the merge is not default-first.
    const { facade } = makeFacade({ default: ["old"], cxo: ["new"] }, {}, { cxo: { new: 300 } });
    const sessions = await facade.listSessions();
    expect(sessions.map((s) => s.id)).toEqual(["new", "old"]);
  });

  it("keeps a colliding id owned by the default home even when its fetch lands last", async () => {
    // Dedupe must follow homes order, not fetch-completion order: a foreign
    // home that answers first would otherwise claim the shared id (an
    // imported rollout keeps the id in both homes) and route reads to its
    // staler copy.
    const homes: CodexHome[] = [
      { id: "default", path: "/homes/default", label: "Codex" },
      { id: "cxo", path: "/homes/cxo", label: "cxo" },
    ];
    const slowDefault = fakeHomeAdapter(homes[0], []);
    (slowDefault.listSessions as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return [{ ...makeSummary("shared", 200), title: "default copy" }];
    });
    const foreign = fakeHomeAdapter(homes[1], []);
    (foreign.listSessions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...makeSummary("shared", 100), title: "foreign copy" },
    ]);
    const byHome = new Map<string, AgentAdapter>([
      ["default", slowDefault],
      ["cxo", foreign],
    ]);
    const facade = createCodexMultiHomeAdapter({
      lineagePath: join(makeDir(), "lineage.json"),
      homes: () => homes,
      createHomeAdapter: (home) => Promise.resolve(byHome.get(home.id)!),
      defaultHomePath: () => "/homes/default",
    });
    const sessions = await facade.listSessions();
    expect(sessions.find((s) => s.id === "shared")?.title).toBe("default copy");
    await facade.messages("shared");
    expect(byHome.get("default")!.messages).toHaveBeenCalledWith("shared");
    expect(byHome.get("cxo")!.messages).not.toHaveBeenCalled();
  });

  it("does not drop a foreign home's later sessions after an id collision", async () => {
    // A duplicate id must skip only its own row, not end the home's loop. The
    // foreign home answers last, so its duplicate is mid-list when it lands.
    const homes: CodexHome[] = [
      { id: "default", path: "/homes/default", label: "Codex" },
      { id: "cxo", path: "/homes/cxo", label: "cxo" },
    ];
    const foreign = fakeHomeAdapter(homes[1], []);
    (foreign.listSessions as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return [makeSummary("shared", 100), makeSummary("other", 100)];
    });
    const byHome = new Map<string, AgentAdapter>([
      ["default", fakeHomeAdapter(homes[0], ["shared"])],
      ["cxo", foreign],
    ]);
    const facade = createCodexMultiHomeAdapter({
      lineagePath: join(makeDir(), "lineage.json"),
      homes: () => homes,
      createHomeAdapter: (home) => Promise.resolve(byHome.get(home.id)!),
      defaultHomePath: () => "/homes/default",
    });
    const sessions = await facade.listSessions();
    expect(sessions.map((s) => s.id).sort()).toEqual(["other", "shared"]);
  });

  it("keeps a created session listed until thread/list carries it", async () => {
    // codex 0.154 lists only threads that wrote a turn of their own, so a
    // fresh thread/start is invisible to every listSessions until its first
    // prompt — without the memo the renderer could never select the session
    // it just made.
    let serverListsFresh = false;
    const { facade, byHome } = makeFacade({ default: [] });
    (byHome.get("default")!.listSessions as ReturnType<typeof vi.fn>).mockImplementation(
      async () => (serverListsFresh ? [makeSummary("fresh", 300)] : [makeSummary("older", 100)]),
    );
    (byHome.get("default")!.createSession as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeSummary("fresh", 200),
    );

    await facade.createSession("/repo");
    const before = await facade.listSessions();
    expect(before.map((s) => s.id)).toEqual(["fresh", "older"]);

    // The first own turn lands: the server now lists the id, so the memo row
    // retires instead of duplicating.
    serverListsFresh = true;
    const after = await facade.listSessions();
    expect(after.filter((s) => s.id === "fresh")).toHaveLength(1);
    expect(after.find((s) => s.id === "fresh")?.updatedAt).toBe(300);
  });

  it("keeps a just-cut fork listed before its first own turn", async () => {
    const { facade, byHome } = makeFacade({ default: ["parent"] });
    (byHome.get("default")!.fork as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...makeSummary("fork-1", 300),
      origin: "fork",
      parentSessionId: "parent",
    });
    const forked = await facade.fork("parent", null);
    expect(forked).toMatchObject({ id: "fork-1", origin: "fork", parentSessionId: "parent" });
    const sessions = await facade.listSessions();
    expect(sessions.map((s) => s.id)).toEqual(["fork-1", "parent"]);
  });

  it("drops the memo row when the session is deleted before the server lists it", async () => {
    const { facade, byHome } = makeFacade({ default: [] });
    (byHome.get("default")!.createSession as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeSummary("fresh", 200),
    );
    await facade.createSession("/repo");
    await facade.deleteSession("fresh");
    expect(await facade.listSessions()).toEqual([]);
  });

  it("still lists the default home when a foreign home cannot spawn", async () => {
    const homes: CodexHome[] = [
      { id: "default", path: "/homes/default", label: "Codex" },
      { id: "broken", path: "/homes/broken", label: "broken" },
    ];
    const defaultAdapter = fakeHomeAdapter(homes[0], ["own"]);
    const facade = createCodexMultiHomeAdapter({
      lineagePath: "/tmp/lineage.json",
      homes: () => homes,
      createHomeAdapter: (home) =>
        home.id === "broken"
          ? Promise.reject(new Error("spawn failed"))
          : Promise.resolve(defaultAdapter),
      defaultHomePath: () => "/homes/default",
    });
    const sessions = await facade.listSessions();
    expect(sessions.map((s) => s.id)).toEqual(["own"]);
  });

  it("reads a foreign session through its own home", async () => {
    const { facade, byHome } = makeFacade({ default: [], cxo: ["foreign"] });
    await facade.listSessions();
    await facade.messages("foreign");
    expect(byHome.get("cxo")!.messages).toHaveBeenCalledWith("foreign");
    expect(byHome.get("default")!.messages).not.toHaveBeenCalled();
  });

  it("continues a foreign session on the default account by importing its rollout", async () => {
    const foreignHome = makeDir();
    const defaultHome = makeDir();
    const threadId = "01a08d8f-4862-7093-98da-e763eb8024af";
    const rel = join("sessions", "2026", "09", "11");
    mkdirSync(join(foreignHome, rel), { recursive: true });
    writeFileSync(join(foreignHome, rel, `rollout-2026-09-11T07-02-52-${threadId}.jsonl`), "{}\n");

    const homes: CodexHome[] = [
      { id: "default", path: defaultHome, label: "Codex" },
      { id: "cxo", path: foreignHome, label: "cxo" },
    ];
    const byHome = new Map<string, AgentAdapter>([
      ["default", fakeHomeAdapter(homes[0], [])],
      ["cxo", fakeHomeAdapter(homes[1], [threadId])],
    ]);
    const { facade } = makeFacade(
      { default: [], cxo: [threadId] },
      {
        homes: () => homes,
        createHomeAdapter: (home) => Promise.resolve(byHome.get(home.id)!),
        defaultHomePath: () => defaultHome,
      },
    );
    await facade.listSessions();
    await facade.prompt(threadId, "继续", null);

    // The rollout landed in the default home and the turn ran there.
    expect(
      existsSync(join(defaultHome, rel, `rollout-2026-09-11T07-02-52-${threadId}.jsonl`)),
    ).toBe(true);
    expect(byHome.get("default")!.prompt.mock.calls[0]?.slice(0, 3)).toEqual([
      threadId,
      "继续",
      null,
    ]);
    expect(byHome.get("cxo")!.prompt).not.toHaveBeenCalled();

    // The session now routes to the default home for everything else.
    await facade.messages(threadId);
    expect(byHome.get("default")!.messages).toHaveBeenCalledWith(threadId);
  });

  it("does not import when continuing a default-home session", async () => {
    const defaultHome = makeDir();
    const homes: CodexHome[] = [{ id: "default", path: defaultHome, label: "Codex" }];
    const byHome = new Map<string, AgentAdapter>([["default", fakeHomeAdapter(homes[0], ["own"])]]);
    const { facade } = makeFacade(
      { default: ["own"] },
      {
        homes: () => homes,
        createHomeAdapter: (home) => Promise.resolve(byHome.get(home.id)!),
        defaultHomePath: () => defaultHome,
      },
    );
    await facade.listSessions();
    await facade.prompt("own", "hi", null);
    expect(byHome.get("default")!.prompt).toHaveBeenCalled();
  });

  it("forks a foreign session under the default account too", async () => {
    const foreignHome = makeDir();
    const defaultHome = makeDir();
    const threadId = "01a08d8f-fork-test";
    const rel = join("sessions", "2026", "09", "11");
    mkdirSync(join(foreignHome, rel), { recursive: true });
    writeFileSync(join(foreignHome, rel, `rollout-${threadId}.jsonl`), "{}\n");

    const homes: CodexHome[] = [
      { id: "default", path: defaultHome, label: "Codex" },
      { id: "cxo", path: foreignHome, label: "cxo" },
    ];
    const byHome = new Map<string, AgentAdapter>([
      ["default", fakeHomeAdapter(homes[0], [])],
      ["cxo", fakeHomeAdapter(homes[1], [threadId])],
    ]);
    const { facade } = makeFacade(
      { default: [], cxo: [threadId] },
      {
        homes: () => homes,
        createHomeAdapter: (home) => Promise.resolve(byHome.get(home.id)!),
        defaultHomePath: () => defaultHome,
      },
    );
    await facade.listSessions();
    await facade.fork(threadId, null);

    expect(byHome.get("default")!.fork).toHaveBeenCalledWith(threadId, null);
    expect(existsSync(join(defaultHome, rel, `rollout-${threadId}.jsonl`))).toBe(true);
  });

  it("re-mints interaction request ids so replies reach the right home", async () => {
    const homes: CodexHome[] = [
      { id: "default", path: "/homes/default", label: "Codex" },
      { id: "cxo", path: "/homes/cxo", label: "cxo" },
    ];
    const byHome = new Map<string, AgentAdapter>([
      ["default", fakeHomeAdapter(homes[0], [])],
      ["cxo", fakeHomeAdapter(homes[1], ["foreign"])],
    ]);
    const { facade } = makeFacade(
      { default: [], cxo: ["foreign"] },
      {
        homes: () => homes,
        createHomeAdapter: (home) => Promise.resolve(byHome.get(home.id)!),
      },
    );
    await facade.listSessions();

    // Both homes mint the same inner id "codex-interaction-1"; the facade
    // must hand out distinct outer ids.
    const events: AgentEvent[] = [];
    await facade.subscribe((event) => events.push(event));
    for (const id of ["default", "cxo"]) {
      const adapter = byHome.get(id) as unknown as {
        subscribe: ReturnType<typeof vi.fn>;
      };
      const handler = adapter.subscribe.mock.calls[0][0] as (event: AgentEvent) => void;
      handler({
        type: "interaction.requested",
        request: {
          requestId: "codex-interaction-1",
          sessionId: null,
          kind: "command-approval",
          title: "t",
          detail: "d",
          command: "ls",
        },
      });
    }
    const requestIds = events
      .filter((e) => e.type === "interaction.requested")
      .map((e) => (e.request as { requestId: string }).requestId);
    expect(new Set(requestIds).size).toBe(2);

    await facade.respondInteraction(requestIds[1], { decision: "allow" });
    expect(byHome.get("cxo")!.respondInteraction).toHaveBeenCalledWith("codex-interaction-1", {
      decision: "allow",
    });
    expect(byHome.get("default")!.respondInteraction).not.toHaveBeenCalled();
  });
});
