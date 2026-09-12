import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildSpawnEnv,
  ensureOpencodeServer,
  resolveSpawnEnv,
} from "../src/main/opencode-server.js";

function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "awefork-home-"));
  const bin = join(home, ".deskclaw", "node", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "opencode"), "#!/bin/sh\n", { mode: 0o755 });
  return home;
}

/** A child that neither errors nor exits — a healthy `opencode serve`. */
function fakeRunningChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  child.exitCode = null;
  return child;
}

/**
 * Local server simulating a cold-started opencode: the first `sessionFailures`
 * /session requests fail (nothing is listening yet — including the reuse
 * probe), then REST answers while /event keeps 503ing its first
 * `eventFailures` requests before accepting streams.
 */
function startGateServer(options: {
  sessionFailures: number;
  eventFailures: number;
}): Promise<{ server: Server; port: number }> {
  let sessionAttempts = 0;
  let eventAttempts = 0;
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname === "/session") {
      sessionAttempts += 1;
      res.setHeader("content-type", "application/json");
      if (sessionAttempts <= options.sessionFailures) {
        res.writeHead(503);
        res.end();
        return;
      }
      res.end("[]");
      return;
    }
    if (pathname === "/event") {
      eventAttempts += 1;
      if (eventAttempts <= options.eventFailures) {
        res.writeHead(503);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("buildSpawnEnv", () => {
  // POSIX cases pin "darwin" so they keep testing POSIX behavior when vitest
  // runs on the Windows CI runner (win32 has its own cases below).
  test("prepends home bin dirs that exist so packaged apps can find opencode", () => {
    const home = fakeHome();
    const env = buildSpawnEnv({ PATH: "/usr/bin:/bin", HOME: home }, home, "darwin");
    expect(env.PATH?.startsWith(join(home, ".deskclaw", "node", "bin"))).toBe(true);
    expect(env.PATH).toContain("/usr/bin:/bin");
  });

  test("keeps other env vars untouched and does not duplicate PATH entries", () => {
    const home = fakeHome();
    const env = buildSpawnEnv(
      { PATH: "/usr/bin:/bin", HOME: home, ELECTRON_NO_ATTACH_CONSOLE: "1" },
      home,
      "darwin",
    );
    expect(env.ELECTRON_NO_ATTACH_CONSOLE).toBe("1");
    const parts = (env.PATH ?? "").split(":");
    expect(new Set(parts).size).toBe(parts.length);
  });

  test("works when candidate dirs are missing", () => {
    const home = mkdtempSync(join(tmpdir(), "awefork-empty-"));
    const env = buildSpawnEnv({ PATH: "/usr/bin:/bin" }, home, "darwin");
    expect(env.PATH).not.toContain(home);
    expect(env.PATH?.endsWith("/usr/bin:/bin")).toBe(true);
  });

  test("win32 keeps ';'-separated PATH intact (drive letters contain ':')", () => {
    const home = mkdtempSync(join(tmpdir(), "awefork-win-"));
    const opencodeBin = join(home, ".opencode", "bin");
    const npmBin = join(home, "AppData", "Roaming", "npm");
    const scoopBin = join(home, "scoop", "shims");
    mkdirSync(opencodeBin, { recursive: true });
    mkdirSync(npmBin, { recursive: true });
    mkdirSync(scoopBin, { recursive: true });
    const env = buildSpawnEnv(
      { PATH: "C:\\Windows\\System32;C:\\Windows", APPDATA: join(home, "AppData", "Roaming") },
      home,
      "win32",
    );
    // Drive-letter colons must survive: entries stay ';' separated and untouched.
    const parts = (env.PATH ?? "").split(";");
    expect(parts).toContain("C:\\Windows\\System32");
    expect(parts).toContain("C:\\Windows");
    // Existing win dirs prepend without duplicates.
    expect(parts.indexOf(opencodeBin)).toBe(0);
    expect(parts.indexOf(npmBin)).toBe(1);
    expect(parts).toContain(scoopBin);
    expect(new Set(parts).size).toBe(parts.length);
  });

  test("win32 skips POSIX-only candidate dirs", () => {
    const home = fakeHome(); // creates ~/.deskclaw — must be ignored on win32
    const env = buildSpawnEnv({ PATH: "C:\\Windows" }, home, "win32");
    expect(env.PATH).not.toContain(".deskclaw");
    expect(env.PATH).not.toContain("/opt/homebrew/bin");
    expect(env.PATH?.endsWith("C:\\Windows")).toBe(true);
  });
});

describe("resolveSpawnEnv", () => {
  // The login-shell probe is darwin-only in production; pin "darwin" so these
  // cases exercise the POSIX path on every CI OS.
  test("fills launcher-missing exports from the login shell and unions its PATH", async () => {
    const home = mkdtempSync(join(tmpdir(), "awefork-noopencode-"));
    const env = await resolveSpawnEnv(
      { PATH: "/usr/bin:/bin" },
      home,
      async () => ({
        PATH: "/Users/x/.nvm/versions/node/v22.0.0/bin",
        AWESHARE_CONSUMER_TOKEN: "asc_test",
      }),
      "darwin",
    );
    // GUI launches never source rc files — the provider key opencode's
    // `{env:NAME}` options resolve against must come from the probe.
    expect(env.AWESHARE_CONSUMER_TOKEN).toBe("asc_test");
    // Machine-wide candidate dirs (/opt/homebrew/bin …) may also be prepended,
    // so assert membership, not order. The probed PATH is a union, not a
    // replacement — the server child still needs git & friends.
    expect(env.PATH).toContain("/Users/x/.nvm/versions/node/v22.0.0/bin");
    expect(env.PATH).toContain("/usr/bin:/bin");
  });

  test("never overrides vars the app itself was started with", async () => {
    const home = mkdtempSync(join(tmpdir(), "awefork-envfill-"));
    const env = await resolveSpawnEnv(
      { PATH: "/usr/bin:/bin", OPENAI_API_KEY: "app-value" },
      home,
      async () => ({ OPENAI_API_KEY: "shell-value" }),
      "darwin",
    );
    expect(env.OPENAI_API_KEY).toBe("app-value");
  });

  test("keeps launcher identity, terminal cosmetics and interpreter overrides out", async () => {
    const home = mkdtempSync(join(tmpdir(), "awefork-envfill-"));
    const env = await resolveSpawnEnv(
      { PATH: "/usr/bin:/bin" },
      home,
      async () => ({
        HOME: "/Users/x",
        USER: "x",
        TMPDIR: "/Users/x/tmp",
        TERM: "xterm-256color",
        TERM_PROGRAM: "iTerm.app",
        NODE_OPTIONS: "--require=/x.js",
        LD_LIBRARY_PATH: "/opt/x/lib",
        EMPTY_TOKEN: "",
      }),
      "darwin",
    );
    expect(env.HOME).toBeUndefined();
    expect(env.USER).toBeUndefined();
    expect(env.TMPDIR).toBeUndefined();
    expect(env.TERM).toBeUndefined();
    expect(env.TERM_PROGRAM).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.LD_LIBRARY_PATH).toBeUndefined();
    expect(env.EMPTY_TOKEN).toBeUndefined();
  });

  test("unions the probed PATH even when candidates already resolve the CLI", async () => {
    const home = fakeHome();
    const env = await resolveSpawnEnv(
      { PATH: "/usr/bin:/bin" },
      home,
      async () => ({ PATH: "/Users/x/.nvm/versions/node/v22.0.0/bin" }),
      "darwin",
    );
    expect(env.PATH?.startsWith(join(home, ".deskclaw", "node", "bin"))).toBe(true);
    expect(env.PATH).toContain("/Users/x/.nvm/versions/node/v22.0.0/bin");
    expect(env.PATH).toContain("/usr/bin:/bin");
  });

  test("falls back to the merged PATH when the probe finds nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "awefork-noopencode-"));
    const env = await resolveSpawnEnv({ PATH: "/usr/bin:/bin" }, home, async () => null, "darwin");
    // Original entries survive; only machine-local candidate dirs may lead.
    expect(env.PATH?.endsWith("/usr/bin:/bin")).toBe(true);
  });
});

describe("ensureOpencodeServer", () => {
  test("reuses a running server without spawning when REST and /event answer", async () => {
    const { server, port } = await startGateServer({ sessionFailures: 0, eventFailures: 0 });
    try {
      const spawnFn: typeof spawn = () => {
        throw new Error("must not spawn");
      };
      await expect(ensureOpencodeServer(port, spawnFn)).resolves.toMatchObject({
        spawned: false,
      });
    } finally {
      await closeServer(server);
    }
  });

  test("reports a failed spawn immediately instead of idling to the 30s deadline", async () => {
    // A CLI missing from PATH: spawn emits "error" and never sets exitCode.
    const spawnFn: typeof spawn = (() => {
      const child = new EventEmitter() as unknown as ChildProcess;
      child.exitCode = null;
      queueMicrotask(() => child.emit("error", new Error("spawn opencode ENOENT")));
      return child;
    }) as typeof spawn;
    // Port 0: nothing can listen there, so the reachability probe fails and
    // the spawn path actually runs.
    await expect(ensureOpencodeServer(0, spawnFn)).rejects.toThrow(
      /Could not start opencode serve.*ENOENT/,
    );
  });

  test("waits for the event stream, not just /session, before resolving", async () => {
    // Entry probe fails once; then REST answers while /event 503s two polls.
    const { server, port } = await startGateServer({ sessionFailures: 1, eventFailures: 2 });
    try {
      const result = ensureOpencodeServer(port, () => fakeRunningChild());
      // ~1 s of polls with REST up but SSE down — resolving here is the bug
      // that surfaced as "Event stream lost, reconnecting" on cold launches.
      const early = await Promise.race([
        result.then(() => "resolved"),
        new Promise((resolve) => setTimeout(() => resolve("still-pending"), 1200)),
      ]);
      expect(early).toBe("still-pending");
      await expect(result).resolves.toMatchObject({ spawned: true });
    } finally {
      await closeServer(server);
    }
  });

  test("resolves when another instance answers even if the spawned child exited", async () => {
    // Port race: the child exits at ~600 ms while the winning instance's
    // /event needs the second poll to accept streams. Reachability must win
    // over the exit check, or the loop bails to the 30 s timeout error.
    const { server, port } = await startGateServer({ sessionFailures: 1, eventFailures: 1 });
    try {
      const child = fakeRunningChild();
      setTimeout(() => {
        child.exitCode = 1;
      }, 600);
      await expect(ensureOpencodeServer(port, () => child)).resolves.toMatchObject({
        spawned: true,
      });
    } finally {
      await closeServer(server);
    }
  });

  test("reports a foreign server holding the port instead of a generic timeout", async () => {
    // /session answers an array forever but /event never accepts: reuse must
    // not adopt it, and the failed spawn's error must name the real problem.
    const { server, port } = await startGateServer({ sessionFailures: 0, eventFailures: Infinity });
    try {
      const child = fakeRunningChild();
      queueMicrotask(() => {
        child.exitCode = 1;
      });
      await expect(ensureOpencodeServer(port, () => child)).rejects.toThrow(
        /held by a server that does not behave like opencode/,
      );
    } finally {
      await closeServer(server);
    }
  });

  test("does not reuse a server whose /session is not a sessions array", async () => {
    // A JSON 200 that isn't the sessions array is a foreign server too.
    const server = createServer((req, res) => {
      const { pathname } = new URL(req.url ?? "/", "http://localhost");
      if (pathname === "/session") {
        res.setHeader("content-type", "application/json");
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
    try {
      const child = fakeRunningChild();
      queueMicrotask(() => {
        child.exitCode = 1;
      });
      await expect(ensureOpencodeServer(port, () => child)).rejects.toThrow(/did not become ready/);
    } finally {
      await closeServer(server);
    }
  });
});
