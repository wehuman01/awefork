import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildSpawnEnv, ensureOpencodeServer } from "../src/main/opencode-server.js";

function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "awefork-home-"));
  const bin = join(home, ".deskclaw", "node", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "opencode"), "#!/bin/sh\n", { mode: 0o755 });
  return home;
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
    const env = buildSpawnEnv({ PATH: "/usr/bin:/bin", HOME: home }, home);
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
});
