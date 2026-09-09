import { describe, expect, test } from "vitest";
import { fileKind } from "../src/shared/attachment-kinds";
import {
  MAX_TEXT_BYTES,
  readAttachments,
  toPromptAttachments,
  type DocumentTextExtractor,
} from "../src/renderer/src/attachments";

function decodeDataUrl(dataUrl: string): string {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return Buffer.from(base64, "base64").toString("utf8");
}

const noDocuments: DocumentTextExtractor = async () => {
  throw new Error("no textutil in this test");
};

describe("fileKind", () => {
  test("images by mime", () => {
    expect(fileKind({ name: "a.png", type: "image/png" })).toBe("image");
  });

  test("text by extension even with no mime", () => {
    expect(fileKind({ name: "notes.md", type: "" })).toBe("text");
    expect(fileKind({ name: "main.rs", type: "" })).toBe("text");
    expect(fileKind({ name: "settings.json", type: "" })).toBe("text");
  });

  test("text by mime", () => {
    expect(fileKind({ name: "notes.md", type: "text/markdown" })).toBe("text");
    expect(fileKind({ name: "data.json", type: "application/json" })).toBe("text");
  });

  test("extensionless text files by name", () => {
    expect(fileKind({ name: "Makefile", type: "" })).toBe("text");
    expect(fileKind({ name: ".gitignore", type: "" })).toBe("text");
  });

  test("documents by extension win over a text mime (.rtf arrives as text/rtf)", () => {
    expect(fileKind({ name: "old.rtf", type: "text/rtf" })).toBe("document");
    expect(
      fileKind({
        name: "report.DOCX",
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ).toBe("document");
  });

  test("unknown binaries are unsupported", () => {
    expect(fileKind({ name: "app.zip", type: "application/zip" })).toBe("unsupported");
    expect(fileKind({ name: "mystery.blob", type: "" })).toBe("unsupported");
    expect(fileKind({ name: "paper.pdf", type: "application/pdf" })).toBe("unsupported");
  });
});

describe("readAttachments", () => {
  test("stages images with their own mime", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "pic.png", { type: "image/png" });
    const { staged, notes } = await readAttachments([file], noDocuments);
    expect(notes).toEqual([]);
    expect(staged).toHaveLength(1);
    expect(staged[0]?.mime).toBe("image/png");
    expect(staged[0]?.dataUrl).toBe("data:image/png;base64,AQID");
  });

  test("normalizes text files to text/plain and keeps the filename", async () => {
    const file = new File(["# hello"], "readme.md", { type: "text/markdown" });
    const { staged } = await readAttachments([file], noDocuments);
    expect(staged).toHaveLength(1);
    expect(staged[0]?.name).toBe("readme.md");
    expect(staged[0]?.mime).toBe("text/plain");
    expect(decodeDataUrl(staged[0]?.dataUrl ?? "")).toBe("# hello");
  });

  test("stages code files with an empty mime via extension", async () => {
    const file = new File(["let x = 1"], "main.ts");
    const { staged } = await readAttachments([file], noDocuments);
    expect(staged).toHaveLength(1);
    expect(staged[0]?.mime).toBe("text/plain");
  });

  test("converts word documents through the extractor and sends them as text", async () => {
    const bytes = new Uint8Array([1, 2]);
    const file = new File([bytes], "report.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const seen: Array<{ filename: string; bytes: Uint8Array }> = [];
    const extract: DocumentTextExtractor = async (filename, b) => {
      seen.push({ filename, bytes: b });
      return "converted text";
    };
    const { staged, notes } = await readAttachments([file], extract);
    expect(notes).toEqual([]);
    expect(seen).toEqual([{ filename: "report.docx", bytes }]);
    expect(staged[0]?.mime).toBe("text/plain");
    expect(decodeDataUrl(staged[0]?.dataUrl ?? "")).toBe("converted text");
  });

  test("notes a failed document conversion instead of staging", async () => {
    const file = new File([new Uint8Array([0])], "broken.docx", { type: "" });
    const { staged, notes } = await readAttachments([file], noDocuments);
    expect(staged).toEqual([]);
    expect(notes.join()).toContain("无法从 broken.docx 提取文本");
  });

  test("notes empty extraction results", async () => {
    const file = new File([new Uint8Array([0])], "empty.doc", { type: "" });
    const { staged, notes } = await readAttachments([file], async () => "  ");
    expect(staged).toEqual([]);
    expect(notes.join()).toContain("没有可提取的文本");
  });

  test("skips unsupported files with a note", async () => {
    const zip = new File([new Uint8Array([0])], "bundle.zip", { type: "application/zip" });
    const { staged, notes } = await readAttachments([zip], noDocuments);
    expect(staged).toEqual([]);
    expect(notes.join()).toContain("bundle.zip");
  });

  test("truncates text beyond the byte budget and says so", async () => {
    const big = "a".repeat(MAX_TEXT_BYTES + 500);
    const file = new File([big], "huge.log", { type: "text/plain" });
    const { staged, notes } = await readAttachments([file], noDocuments);
    const decoded = decodeDataUrl(staged[0]?.dataUrl ?? "");
    expect(decoded).toContain("[truncated after 1 MB]");
    expect(decoded.length).toBeLessThan(big.length);
    expect(notes.join()).toContain("已截断");
  });

  test("truncation lands on a code-point boundary for multi-byte text", async () => {
    // 2-byte chars: force the cut inside a character pair.
    const big = "字".repeat(Math.ceil((MAX_TEXT_BYTES + 100) / 2));
    const file = new File([big], "cjk.txt", { type: "text/plain" });
    const { staged } = await readAttachments([file], noDocuments);
    const decoded = decodeDataUrl(staged[0]?.dataUrl ?? "");
    expect(decoded).not.toContain("\ufffd");
    expect(decoded.endsWith("[truncated after 1 MB]")).toBe(true);
  });
});

describe("toPromptAttachments", () => {
  test("flattens drafts into the IPC payload shape", () => {
    const list = toPromptAttachments([
      { id: "att_1", name: "a.md", mime: "text/plain", dataUrl: "data:text/plain;base64,eA==" },
    ]);
    expect(list).toEqual([
      { filename: "a.md", mime: "text/plain", dataUrl: "data:text/plain;base64,eA==" },
    ]);
  });
});
