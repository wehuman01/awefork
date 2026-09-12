import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Codex "home" discovery. The primary home is `$CODEX_HOME` (default
 * `~/.codex`) — the one the logged-in CLI writes to. aweswitch additionally
 * runs official-login accounts inside private per-account homes under
 * `~/.config/aweswitch/accounts/codex/<name>`; sessions created there are
 * invisible to a server pointed at the default home. awefork merges both so
 * those sessions show up in the session list.
 */
export interface CodexHome {
  /** Routing key: the home directory the app-server is spawned with. */
  path: string;
  /** "default" for the primary home; the account directory name otherwise. */
  id: string;
  /** Directory basename — surfaced in logs, kept human-readable. */
  label: string;
}

export const DEFAULT_HOME_ID = "default";

/** Aweswitch's fixed layout for per-account codex homes. */
export function aweswitchCodexRoot(home: string = homedir()): string {
  return join(home, ".config", "aweswitch", "accounts", "codex");
}

/**
 * The primary home. An inherited CODEX_HOME must win — the spawned
 * app-server sees the same env, so discovery and server must agree.
 */
export function defaultCodexHome(
  env: { CODEX_HOME?: string } = process.env,
  home: string = homedir(),
): string {
  const configured = env.CODEX_HOME?.trim();
  if (configured) return isAbsolute(configured) ? resolve(configured) : join(home, configured);
  return join(home, ".codex");
}

/**
 * All homes worth listing: the default first, then each aweswitch account
 * that looks like a codex home. Sync fs is fine — a handful of stat calls on
 * the session-list path. Unreadable/missing roots just yield the default.
 */
export function discoverCodexHomes(
  env: { CODEX_HOME?: string } = process.env,
  userHome: string = homedir(),
): CodexHome[] {
  const homes: CodexHome[] = [
    { path: defaultCodexHome(env, userHome), id: DEFAULT_HOME_ID, label: "Codex" },
  ];
  let entries: string[];
  try {
    entries = readdirSync(aweswitchCodexRoot(userHome));
  } catch {
    return homes;
  }
  for (const entry of entries.sort()) {
    if (entry.startsWith(".")) continue;
    const path = join(aweswitchCodexRoot(userHome), entry);
    if (!looksLikeCodexHome(path)) continue;
    homes.push({ path, id: entry, label: entry });
  }
  return homes;
}

/** A directory without any codex marker would only spawn a broken server. */
function looksLikeCodexHome(path: string): boolean {
  return (
    existsSync(join(path, "config.toml")) ||
    existsSync(join(path, "auth.json")) ||
    existsSync(join(path, "sessions"))
  );
}

/** sessions/<year>/<month>/<day>/rollout-…-<threadId>.jsonl, relative to the home. */
export function findRolloutRelPath(homePath: string, threadId: string): string | null {
  const root = join(homePath, "sessions");
  for (const year of subDirs(root)) {
    for (const month of subDirs(join(root, year))) {
      for (const day of subDirs(join(root, year, month))) {
        // A non-directory at the day position (or a dir pruned by codex's
        // retention between the listing and this read) must not throw its
        // way out of a browse or a continue — there is simply nothing here.
        let files: string[];
        try {
          files = readdirSync(join(root, year, month, day));
        } catch {
          continue;
        }
        for (const file of files) {
          if (file.endsWith(`-${threadId}.jsonl`)) return join(year, month, day, file);
        }
      }
    }
  }
  return null;
}

function subDirs(path: string): string[] {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}

/**
 * The home a session's rollout file actually lives in — the honest answer to
 * "which CODEX_HOME must a terminal codex run under to see this session?".
 * The default home is searched first, so a session imported into it (the
 * multihome continue path) reports the default, matching the facade's
 * "continues run under the default account" semantics. Null when no
 * discovered home has the rollout.
 */
export function codexHomeForSession(
  sessionId: string,
  env: { CODEX_HOME?: string } = process.env,
  userHome: string = homedir(),
): CodexHome | null {
  for (const home of discoverCodexHomes(env, userHome)) {
    if (findRolloutRelPath(home.path, sessionId)) return home;
  }
  return null;
}

/**
 * The home a terminal `codex` uses when the script exports no CODEX_HOME:
 * plain `~/.codex`. A session living anywhere else — an aweswitch account
 * home, or a home the app inherited via CODEX_HOME — must carry the export.
 */
export function terminalDefaultCodexHome(userHome: string = homedir()): string {
  return join(userHome, ".codex");
}

/**
 * The provider a terminal `codex resume` must be forced onto with
 * `-c model_provider=…`, or null when no override is needed.
 *
 * Resume restores the rollout's last thread settings, provider included. When
 * that provider has since disappeared from the home's config.toml — profile
 * switchers like aweswitch/cc-switch rewrite the whole file — the TUI dies at
 * bootstrap with "Model provider `x` not found". Forcing the config's current
 * default provider keeps the session resumable; sessions whose recorded
 * provider still exists resume untouched.
 */
export function codexRolloutProviderFallback(homePath: string, sessionId: string): string | null {
  const rel = findRolloutRelPath(homePath, sessionId);
  if (rel === null) return null;
  const recorded = lastRecordedRolloutProvider(join(homePath, "sessions", rel));
  if (recorded === null) return null;
  const config = readCodexProviderConfig(join(homePath, "config.toml"));
  if (recorded === "openai" || recorded === config.default || config.defined.has(recorded)) {
    return null;
  }
  // A default the config itself cannot resolve is no fallback at all.
  const fallback =
    config.default === "openai" || config.defined.has(config.default) ? config.default : "openai";
  return /^[A-Za-z0-9_-]+$/.test(fallback) ? fallback : null;
}

/** The last provider the rollout's thread settings recorded, if any. */
function lastRecordedRolloutProvider(rolloutPath: string): string | null {
  let rollout: string;
  try {
    rollout = readFileSync(rolloutPath, "utf8");
  } catch {
    return null;
  }
  let provider: string | null = null;
  for (const line of rollout.split("\n")) {
    if (!line.includes('"thread_settings_applied"')) continue;
    try {
      const parsed = JSON.parse(line) as {
        payload?: { thread_settings?: { model_provider_id?: unknown } };
      };
      const value = parsed.payload?.thread_settings?.model_provider_id;
      if (typeof value === "string" && value !== "") provider = value;
    } catch {
      // A torn final line still leaves the earlier settings usable.
    }
  }
  return provider;
}

/**
 * The root `model_provider` and the `[model_providers.<id>]` table ids of a
 * codex config. "openai" is codex's built-in default, so it stands even when
 * the file is missing or names nothing.
 */
function readCodexProviderConfig(path: string): { default: string; defined: Set<string> } {
  let config = "openai";
  const defined = new Set<string>();
  let configText: string;
  try {
    configText = readFileSync(path, "utf8");
  } catch {
    return { default: config, defined };
  }
  let inRootTable = true;
  for (const line of configText.split("\n")) {
    const section = line.match(/^\s*\[([^\]]*)\]/);
    if (section) {
      inRootTable = false;
      const table = section[1] ?? "";
      if (table.startsWith("model_providers.")) {
        const id = table
          .slice("model_providers.".length)
          .trim()
          .replace(/^"+|"+$/g, "");
        if (id !== "") defined.add(id);
      }
      continue;
    }
    if (!inRootTable) continue;
    const match = line.match(/^\s*model_provider\s*=\s*"?([^"\s#]+)"?/);
    if (match?.[1]) config = match[1];
  }
  return { default: config, defined };
}
