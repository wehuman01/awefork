// Moves installers from previous builds out of dist/ into dist/archive/<version>/
// before electron-builder runs, so dist/ root only holds the current build's
// artifacts. Wired into `npm run dist` / `npm run dist:win`.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Installers carry the version in their file name (awefork-0.1.8-arm64.dmg,
// awefork-0.1.8-x64-setup.exe, plus .blockmap sidecars). Unversioned files
// (latest*.yml, builder-debug.yml) are overwritten by every build and stay put.
export function planArchive(fileNames, productName, currentVersion) {
  const pattern = new RegExp(
    `^${escapeRegExp(productName)}-(\\d+\\.\\d+\\.\\d+)(-[0-9A-Za-z.]+)?-.+\\.(?:dmg|exe)(?:\\.blockmap)?$`,
  );
  const moves = [];
  for (const fileName of fileNames) {
    const match = fileName.match(pattern);
    if (!match) {
      continue;
    }
    // `awefork-0.1.8-x64-setup.exe` parses with `-x64` absorbed as a would-be
    // prerelease; if either parse names the current version, keep the file.
    const core = match[1];
    const withPrerelease = match[2] ? `${core}${match[2]}` : core;
    if (core !== currentVersion && withPrerelease !== currentVersion) {
      moves.push({ file: fileName, version: core });
    }
  }
  return moves;
}

export async function archiveOldBuilds(distDir, fileNames, productName, currentVersion) {
  const moves = planArchive(fileNames, productName, currentVersion);
  for (const move of moves) {
    const targetDir = path.join(distDir, "archive", move.version);
    const target = path.join(targetDir, move.file);
    await mkdir(targetDir, { recursive: true });
    // rename refuses to overwrite on Windows; rebuilding an old version replaces it
    await rm(target, { force: true });
    await rename(path.join(distDir, move.file), target);
  }
  return moves;
}

async function main() {
  const pkg = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const productName = pkg.build?.productName ?? pkg.name;
  const distDir = path.join(projectRoot, pkg.build?.directories?.output ?? "dist");
  if (!existsSync(distDir)) {
    return;
  }
  const entries = await readdir(distDir, { withFileTypes: true });
  const fileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const moves = await archiveOldBuilds(distDir, fileNames, productName, pkg.version);
  for (const move of moves) {
    console.log(`archived ${move.file} -> dist/archive/${move.version}/`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
