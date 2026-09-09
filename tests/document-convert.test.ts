import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { convertDocumentToText } from "../src/main/document-convert";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("convertDocumentToText", () => {
  test("extracts paragraph text from a .docx", async () => {
    const bytes = new Uint8Array(readFileSync(join(fixtures, "sample.docx")));
    const text = await convertDocumentToText("sample.docx", bytes);
    expect(text).toContain("awefork fixture paragraph one");
    expect(text).toContain("second paragraph");
  });

  test("extracts text from an .rtf, skipping font tables", async () => {
    const rtf =
      "{\\rtf1\\ansi{\\fonttbl\\f0 Helvetica;}{\\*\\generator some editor}\\pard\\f0\\fs24 first paragraph\\par second caf\\'e9 \\u8212 ? ends\\par}";
    const bytes = new Uint8Array(Buffer.from(rtf, "latin1"));
    const text = await convertDocumentToText("note.rtf", bytes);
    expect(text).toBe("first paragraph\nsecond café — ends");
  });

  test("rejects legacy .doc with a save-as hint", async () => {
    await expect(convertDocumentToText("old.doc", new Uint8Array([0]))).rejects.toThrow(
      /legacy \.doc is not supported.*\.docx or \.rtf/,
    );
  });

  test("rejects non-document extensions", async () => {
    await expect(convertDocumentToText("photo.png", new Uint8Array([0]))).rejects.toThrow(
      /unsupported document/,
    );
  });
});
