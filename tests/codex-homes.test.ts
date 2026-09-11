import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HOME_ID, defaultCodexHome, discoverCodexHomes } from "../src/main/codex-homes.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = join(tmpdir(), `awefork-homes-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("defaultCodexHome", () => {
  it("defaults to ~/.codex", () => {
    expect(defaultCodexHome({}, "/Users/x")).toBe("/Users/x/.codex");
  });

  it("honors an inherited CODEX_HOME so discovery matches the spawned server", () => {
    expect(defaultCodexHome({ CODEX_HOME: "/custom/home" }, "/Users/x")).toBe("/custom/home");
    expect(defaultCodexHome({ CODEX_HOME: "rel/home" }, "/Users/x")).toBe("/Users/x/rel/home");
  });
});

describe("discoverCodexHomes", () => {
  it("returns only the default home when aweswitch has no accounts", () => {
    const root = makeRoot();
    const homes = discoverCodexHomes({}, root);
    expect(homes).toHaveLength(1);
    expect(homes[0]).toMatchObject({ id: DEFAULT_HOME_ID, path: join(root, ".codex") });
  });

  it("lists every aweswitch account that looks like a codex home", () => {
    const root = makeRoot();
    const accounts = join(root, ".config", "aweswitch", "accounts", "codex");
    for (const name of ["cxo-heck", "cxo-peng"]) {
      mkdirSync(join(accounts, name), { recursive: true });
      writeFileSync(join(accounts, name, "config.toml"), "");
    }
    // No marker: not a codex home, must be skipped. Dot-dirs: skipped.
    mkdirSync(join(accounts, "empty"), { recursive: true });
    mkdirSync(join(accounts, ".hidden"), { recursive: true });

    const homes = discoverCodexHomes({ CODEX_HOME: "/custom" }, root);
    expect(homes).toHaveLength(3);
    expect(homes[0]).toMatchObject({ id: DEFAULT_HOME_ID, path: "/custom" });
    expect(homes.slice(1).map((home) => home.id)).toEqual(["cxo-heck", "cxo-peng"]);
    expect(homes[1].path).toBe(join(accounts, "cxo-heck"));
  });
});
