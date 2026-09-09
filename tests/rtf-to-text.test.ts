import { describe, expect, test } from "vitest";
import { rtfToText } from "../src/main/rtf-to-text";

function rtf(source: string): Uint8Array {
  return new Uint8Array(Buffer.from(source, "latin1"));
}

describe("rtfToText", () => {
  test("escapes: \\'hh hex, \\uN signed 16-bit, \\tab, literal braces", () => {
    const text = rtfToText(rtf(String.raw`{\rtf1 a\'7eb <\\b\{x\}> \tab \u-10179 ? end}`));
    expect(text).toContain("a~b"); // \'7e → 0x7E
    expect(text).toContain("<\\b{x}>");
    expect(text).toContain("\t");
    // \u-10179 → 55357: signed decoding must not produce NaN/garbage.
    expect(text).toContain(String.fromCharCode(55357));
    expect(text).toContain("end");
  });

  test("\\uc0 suppresses the fallback char after \\uN", () => {
    const text = rtfToText(rtf(String.raw`{\rtf1\uc1 a\u233 ?b\uc0 c\u233 d}`));
    // The space after \uc0 is a control-word delimiter, not content.
    expect(text).toBe("aébcéd");
  });

  test("skips nested destination groups entirely", () => {
    const text = rtfToText(
      rtf(
        String.raw`{\rtf1{\fonttbl\f0 {\*\expandedcolortbl;;} Helvetica;}{\colortbl \red0;}keep{\pict\picw1 no}me}`,
      ),
    );
    expect(text).toBe("keepme");
  });

  test("drops raw CR/LF and collapses runs of blank lines", () => {
    const text = rtfToText(rtf("{\\rtf1\r\na\\par \\par \\par b}"));
    expect(text).toBe("a\n\nb");
  });

  test("unbalanced closing braces do not corrupt the stack", () => {
    expect(rtfToText(rtf("{\\rtf1 a}b}c"))).toBe("abc");
  });
});
