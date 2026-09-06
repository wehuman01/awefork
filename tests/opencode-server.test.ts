import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildSpawnEnv } from "../src/main/opencode-server.js";

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
});
