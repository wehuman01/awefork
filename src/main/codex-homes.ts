import { existsSync, readdirSync } from "node:fs";
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
        const dir = join(root, year, month, day);
        for (const file of readdirSync(dir)) {
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
