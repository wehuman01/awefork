/**
 * What a composer may attach, classified from filename + mime alone so both
 * processes (renderer staging, main textutil conversion) agree on the rules.
 */

/** Word/RTF documents — binary, need main-process textutil conversion. */
export const DOC_EXTENSIONS: ReadonlySet<string> = new Set([".doc", ".docx", ".rtf"]);

/** Extensions safe to read as UTF-8 and send as text/plain. */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".mdx",
  ".rst",
  ".log",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".ndjson",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".properties",
  ".xml",
  ".svg",
  ".html",
  ".htm",
  ".css",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".vue",
  ".svelte",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cc",
  ".cs",
  ".php",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".bat",
  ".sql",
  ".graphql",
  ".gql",
  ".proto",
  ".tf",
]);

/** Extensionless files that are text by convention (compared lowercased). */
export const TEXT_FILENAMES: ReadonlySet<string> = new Set([
  "makefile",
  "dockerfile",
  "cmakelists.txt",
  ".env",
  ".gitignore",
  ".gitattributes",
]);

/** Mimes that are text even though they don't start with text/. */
export const TEXT_MIMES: ReadonlySet<string> = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/sql",
]);

export type FileKind = "image" | "text" | "document" | "unsupported";

export function fileKind(file: { name: string; type: string }): FileKind {
  if (file.type.startsWith("image/")) return "image";
  const name = file.name.toLowerCase();
  // Extension wins over mime for documents: .rtf arrives as text/rtf, but it
  // still needs textutil rather than a raw UTF-8 read.
  if (DOC_EXTENSIONS.has(extensionOf(name))) return "document";
  if (TEXT_FILENAMES.has(name) || TEXT_EXTENSIONS.has(extensionOf(name))) return "text";
  if (file.type.startsWith("text/")) return "text";
  if (TEXT_MIMES.has(file.type)) return "text";
  return "unsupported";
}

function extensionOf(lowercasedName: string): string {
  const dot = lowercasedName.lastIndexOf(".");
  return dot === -1 ? "" : lowercasedName.slice(dot);
}

/** `accept` value for the composer's file picker. */
export const ATTACHMENT_ACCEPT = ["image/*", ...DOC_EXTENSIONS, ...TEXT_EXTENSIONS].join(",");
