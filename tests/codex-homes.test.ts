import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  codexRolloutProviderFallback,
  DEFAULT_HOME_ID,
  defaultCodexHome,
  discoverCodexHomes,
} from "../src/main/codex-homes.js";

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

describe("codexRolloutProviderFallback", () => {
  const sessionId = "01a09310-de4f-7200-a76b-30c824db7cf5";

  /** A codex home with a rollout whose thread settings name the given provider. */
  function makeHome(config: string, providers: string[]): string {
    const home = join(makeRoot(), ".codex");
    const day = join(home, "sessions", "2026", "09", "12");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(home, "config.toml"), config);
    const settings = (provider: string, model: string) =>
      `{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_id":"${sessionId}","thread_settings":{"model":"${model}","model_provider_id":"${provider}"}}}`;
    const lines = [
      settings("openai", "gpt-6-astra"),
      ...providers.map((p) => settings(p, "glm-5.3")),
    ];
    writeFileSync(
      join(day, `rollout-2026-09-12T08-42-31-${sessionId}.jsonl`),
      `${lines.join("\n")}\n`,
    );
    return home;
  }

  it("returns the config default when the recorded provider is gone", () => {
    const home = makeHome('model = "glm-5.3"\n', ["custom"]);
    expect(codexRolloutProviderFallback(home, sessionId)).toBe("openai");
  });

  it("falls back to openai when the config default itself is unresolvable", () => {
    const home = makeHome('model_provider = "custom"\n', ["other"]);
    expect(codexRolloutProviderFallback(home, sessionId)).toBe("openai");
  });

  it("returns the configured default provider, not just openai", () => {
    const home = makeHome(
      'model_provider = "aweswitch"\n\n[model_providers.aweswitch]\nname = "x"\n',
      ["custom"],
    );
    expect(codexRolloutProviderFallback(home, sessionId)).toBe("aweswitch");
  });

  it("yields null while the recorded provider is still defined", () => {
    const home = makeHome('[model_providers.custom]\nname = "x"\n', ["custom"]);
    expect(codexRolloutProviderFallback(home, sessionId)).toBeNull();
  });

  it("yields null when the recorded provider is the config default", () => {
    const home = makeHome('model_provider = "custom"\n', ["custom"]);
    expect(codexRolloutProviderFallback(home, sessionId)).toBeNull();
  });

  it("yields null without a rollout or recorded settings", () => {
    const home = makeHome('model = "glm-5.3"\n', []);
    expect(codexRolloutProviderFallback(home, sessionId)).toBeNull();
    expect(codexRolloutProviderFallback(join(makeRoot(), ".codex"), sessionId)).toBeNull();
  });
});
