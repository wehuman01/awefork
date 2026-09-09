import { extname } from "node:path";
import mammoth from "mammoth";
import WordExtractor from "word-extractor";
import { DOC_EXTENSIONS } from "../shared/attachment-kinds.js";
import { rtfToText } from "./rtf-to-text.js";

/** One reused extractor; the class is stateless between extract() calls. */
const wordExtractor = new WordExtractor();

/**
 * Pull plain text out of a Word/RTF attachment in-process, with the same code
 * path on every platform (the old macOS `textutil` call was the one OS
 * dependency). Legacy binary .doc is read by word-extractor, a pure-JS parser
 * for the OLE-based Word 97-2003 format.
 */
export async function convertDocumentToText(filename: string, bytes: Uint8Array): Promise<string> {
  const ext = extname(filename).toLowerCase();
  if (!DOC_EXTENSIONS.has(ext)) throw new Error(`unsupported document: ${filename}`);
  if (ext === ".docx") {
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return value.trim();
  }
  if (ext === ".doc") {
    try {
      const document = await wordExtractor.extract(Buffer.from(bytes));
      return document.getBody().trim();
    } catch (error) {
      // word-extractor reports unparseable input as "Unable to read this type
      // of file" — rethrow with the context a user needs.
      throw new Error(
        `could not read legacy .doc (${filename}) — the file may be corrupt or not a real Word document`,
        { cause: error },
      );
    }
  }
  if (ext === ".rtf") return rtfToText(bytes);
  throw new Error(`unknown document extension: ${ext}`);
}
