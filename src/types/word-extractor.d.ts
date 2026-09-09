/**
 * Minimal ambient types for word-extractor (v1.0.4), which ships no bundled
 * declarations. Only the API surface used by src/main/document-convert.ts is
 * described; the module is CommonJS, so the default import comes via
 * esModuleInterop.
 */

declare module "word-extractor" {
  /** A parsed Word document; getBody() returns the main text as a string. */
  class Document {
    /** Body content as plain text. May end with a trailing newline. */
    getBody(): string;
  }

  class WordExtractor {
    constructor();
    /** Accepts a filename or an in-memory Buffer with the file contents. */
    extract(source: string | Buffer): Promise<Document>;
  }

  export = WordExtractor;
}
