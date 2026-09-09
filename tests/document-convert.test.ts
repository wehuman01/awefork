import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, test } from "vitest";
import { convertDocumentToText, type ExecFile } from "../src/main/document-convert";

interface Call {
  file: string;
  args: readonly string[];
}

function recordingExec(stdout: string, calls: Call[]): ExecFile {
  return async (file, args) => {
    calls.push({ file, args });
    return { stdout };
  };
}

describe("convertDocumentToText", () => {
  test("spills bytes to a temp file and returns textutil's stdout", async () => {
    const calls: Call[] = [];
    const exec = recordingExec("extracted text", calls);
    const text = await convertDocumentToText("report.docx", new Uint8Array([1, 2]), exec);
    expect(text).toBe("extracted text");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.file).toBe("textutil");
    expect(call?.args.slice(0, 3)).toEqual(["-convert", "txt", "-stdout"]);
    // Extension survives so textutil can sniff the input format.
    expect(call?.args[3]).toMatch(/input\.docx$/);
  });

  test("removes the temp dir afterwards", async () => {
    const calls: Call[] = [];
    await convertDocumentToText("old.rtf", new Uint8Array([0]), recordingExec("", calls));
    const tempPath = calls[0]?.args[3];
    expect(tempPath).toBeDefined();
    expect(existsSync(dirname(tempPath as string))).toBe(false);
  });

  test("cleans up even when conversion fails", async () => {
    const calls: Call[] = [];
    const exec: ExecFile = async (file, args) => {
      calls.push({ file, args });
      throw new Error("textutil failed");
    };
    await expect(convertDocumentToText("a.doc", new Uint8Array([0]), exec)).rejects.toThrow(
      "textutil failed",
    );
    expect(existsSync(dirname(calls[0]?.args[3] as string))).toBe(false);
  });

  test("rejects non-document extensions before touching the disk", async () => {
    const calls: Call[] = [];
    await expect(
      convertDocumentToText("photo.png", new Uint8Array([0]), recordingExec("", calls)),
    ).rejects.toThrow(/unsupported document/);
    expect(calls).toEqual([]);
  });
});
