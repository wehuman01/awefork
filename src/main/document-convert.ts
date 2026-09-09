import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { DOC_EXTENSIONS } from "../shared/attachment-kinds.js";

/** execFile promisified shape, injectable for tests. */
export type ExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number; encoding: "utf8"; maxBuffer: number },
) => Promise<{ stdout: string }>;

const execFileUtf8: ExecFile = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout: stdout as string });
    });
  });

/**
 * Pull plain text out of a Word/RTF document with macOS `textutil` — the one
 * converter that ships with every install and needs no dependency. Bytes are
 * spilled to a temp file because textutil only reads paths.
 */
export async function convertDocumentToText(
  filename: string,
  bytes: Uint8Array,
  exec: ExecFile = execFileUtf8,
): Promise<string> {
  const ext = extname(filename).toLowerCase();
  if (!DOC_EXTENSIONS.has(ext)) throw new Error(`unsupported document: ${filename}`);
  const dir = await mkdtemp(join(tmpdir(), "awefork-doc-"));
  try {
    // Extension-only name: the format hint textutil needs stays, unsafe
    // name characters from the original don't.
    const input = join(dir, `input${ext}`);
    await writeFile(input, bytes);
    const { stdout } = await exec("textutil", ["-convert", "txt", "-stdout", input], {
      timeout: 10_000,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      // Cleanup is best-effort; the temp dir lives under os.tmpdir() anyway.
    });
  }
}
