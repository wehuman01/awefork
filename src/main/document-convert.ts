import { extname } from "node:path";
import mammoth from "mammoth";
import { DOC_EXTENSIONS } from "../shared/attachment-kinds.js";
import { rtfToText } from "./rtf-to-text.js";

/**
 * Pull plain text out of a Word/RTF attachment in-process, with the same code
 * path on every platform (the old macOS `textutil` call was the one OS
 * dependency). Legacy binary .doc is rejected — no cross-platform converter
 * ships with the app; the error tells the user how to save it differently.
 */
export async function convertDocumentToText(filename: string, bytes: Uint8Array): Promise<string> {
  const ext = extname(filename).toLowerCase();
  if (!DOC_EXTENSIONS.has(ext)) throw new Error(`unsupported document: ${filename}`);
  if (ext === ".docx") {
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return value.trim();
  }
  if (ext === ".rtf") return rtfToText(bytes);
  throw new Error(`legacy .doc is not supported (${filename}) — save it as .docx or .rtf`);
}
