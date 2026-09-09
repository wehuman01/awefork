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
  test("prepends home bin dirs that exist so packaged apps can find opencode", () => {
    const home = fakeHome();
    const env = buildSpawnEnv({ PATH: "/usr/bin:/bin", HOME: home }, home);
    expect(env.PATH?.startsWith(join(home, ".deskclaw", "node", "bin"))).toBe(true);
    expect(env.PATH).toContain("/usr/bin:/bin");
  });

  test("keeps other env vars untouched and does not duplicate PATH entries", () => {
    const home = fakeHome();
    const env = buildSpawnEnv(
      { PATH: "/usr/bin:/bin", HOME: home, ELECTRON_NO_ATTACH_CONSOLE: "1" },
      home,
    );
    expect(env.ELECTRON_NO_ATTACH_CONSOLE).toBe("1");
    const parts = (env.PATH ?? "").split(":");
    expect(new Set(parts).size).toBe(parts.length);
  });

  test("works when candidate dirs are missing", () => {
    const home = mkdtempSync(join(tmpdir(), "awefork-empty-"));
    const env = buildSpawnEnv({ PATH: "/usr/bin:/bin" }, home);
    expect(env.PATH).not.toContain(home);
    expect(env.PATH?.endsWith("/usr/bin:/bin")).toBe(true);
  });

  test("win32 keeps ';'-separated PATH intact (drive letters contain ':')", () => {
    const home = mkdtempSync(join(tmpdir(), "awefork-win-"));
    const opencodeBin = join(home, ".opencode", "bin");
    const npmBin = join(home, "AppData", "Roaming", "npm");
    mkdirSync(opencodeBin, { recursive: true });
    mkdirSync(npmBin, { recursive: true });
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
  test("asks the login shell for PATH when opencode is nowhere on it", async () => {
    const home = mkdtempSync(join(tmpdir(), "awefork-noopencode-"));
    let probed = false;
    const env = await resolveSpawnEnv({ PATH: "/usr/bin:/bin" }, home, async () => {
      probed = true;
      return "/Users/x/.nvm/versions/node/v22.0.0/bin";
    });
    expect(probed).toBe(true);
    // Machine-wide candidate dirs (/opt/homebrew/bin …) may also be prepended,
    // so assert membership, not order.
    expect(env.PATH).toContain("/Users/x/.nvm/versions/node/v22.0.0/bin");
    // The probed PATH is a union, not a replacement — the server child still
    // needs git & friends from the original entries.
    expect(env.PATH).toContain("/usr/bin:/bin");
  });

  test("skips the login shell when candidates already resolve opencode", async () => {
    const home = fakeHome();
    const env = await resolveSpawnEnv({ PATH: "/usr/bin:/bin" }, home, async () => {
      throw new Error("probe must not run");
    });
    expect(env.PATH?.startsWith(join(home, ".deskclaw", "node", "bin"))).toBe(true);
  });

  test("falls back to the merged PATH when the probe finds nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "awefork-noopencode-"));
    const env = await resolveSpawnEnv({ PATH: "/usr/bin:/bin" }, home, async () => null);
    // Original entries survive; only machine-local candidate dirs may lead.
    expect(env.PATH?.endsWith("/usr/bin:/bin")).toBe(true);
  });
});

describe("ensureOpencodeServer", () => {
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
});
