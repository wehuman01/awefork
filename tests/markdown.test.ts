import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "../src/renderer/src/markdown";

describe("parseMarkdown blocks", () => {
  it("parses a fenced code block with its language", () => {
    const blocks = parseMarkdown("before\n\n```ts\nconst x = 1;\n```\n\nafter");
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toEqual({ kind: "code", lang: "ts", code: "const x = 1;" });
  });

  it("treats an unclosed fence as code to end of input (mid-stream)", () => {
    const blocks = parseMarkdown("```python\ndef f():");
    expect(blocks).toEqual([{ kind: "code", lang: "python", code: "def f():" }]);
  });

  it("keeps indented code lines inside the fence", () => {
    const blocks = parseMarkdown("```\n  a\n    b\n```");
    expect(blocks[0]).toEqual({ kind: "code", lang: "", code: "  a\n    b" });
  });

  it("parses headings with inline marks", () => {
    const blocks = parseMarkdown("## Plan *now*");
    expect(blocks[0]?.kind).toBe("heading");
    if (blocks[0]?.kind === "heading") {
      expect(blocks[0].level).toBe(2);
      expect(blocks[0].inline).toContainEqual({
        kind: "em",
        children: [{ kind: "text", text: "now" }],
      });
    }
  });

  it("parses nested lists by indent rank", () => {
    const blocks = parseMarkdown("- a\n  - a1\n  - a2\n- b");
    expect(blocks[0]?.kind).toBe("list");
    if (blocks[0]?.kind === "list") {
      expect(blocks[0].items).toHaveLength(2);
      const a = blocks[0].items[0];
      expect(a?.sublist?.items.map((i) => i.inline)).toEqual([
        [{ kind: "text", text: "a1" }],
        [{ kind: "text", text: "a2" }],
      ]);
    }
  });

  it("captures ordered list start numbers", () => {
    const blocks = parseMarkdown("3. three\n4. four");
    expect(blocks[0]).toMatchObject({ kind: "list", ordered: true, start: 3 });
  });

  it("joins a list item's continuation lines", () => {
    const blocks = parseMarkdown("- first\n  wrapped\n- second");
    if (blocks[0]?.kind !== "list") throw new Error("expected list");
    expect(blocks[0].items[1]?.inline).toEqual([{ kind: "text", text: "second" }]);
    expect(blocks[0].items[0]?.inline).toEqual([{ kind: "text", text: "first\nwrapped" }]);
  });

  it("parses GFM tables with alignment", () => {
    const blocks = parseMarkdown("| a | b |\n| :- | -: |\n| 1 | 2 |");
    expect(blocks[0]).toMatchObject({
      kind: "table",
      align: ["left", "right"],
      head: [[{ kind: "text", text: "a" }], [{ kind: "text", text: "b" }]],
      rows: [[[{ kind: "text", text: "1" }], [{ kind: "text", text: "2" }]]],
    });
  });

  it("rejects a table whose delimiter row does not match", () => {
    expect(parseMarkdown("| a | b |\n| x | y |\n| 1 | 2 |")[0]?.kind).not.toBe("table");
  });

  it("parses blockquotes by recursing into the quoted body", () => {
    const blocks = parseMarkdown("> quoted **bold**");
    expect(blocks[0]?.kind).toBe("quote");
    if (blocks[0]?.kind === "quote") {
      expect(blocks[0].children[0]?.kind).toBe("paragraph");
    }
  });

  it("renders horizontal rules", () => {
    expect(parseMarkdown("---")[0]?.kind).toBe("hr");
    expect(parseMarkdown("***")[0]?.kind).toBe("hr");
  });

  it("splits paragraphs on blank lines and lets lists interrupt them", () => {
    const blocks = parseMarkdown("intro:\n- a\n- b");
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "list"]);
  });
});

describe("parseInline", () => {
  it("parses code spans before other marks", () => {
    expect(parseInline("`a*b* c`")).toEqual([{ kind: "code", text: "a*b* c" }]);
  });

  it("parses bold, italic, and strikethrough", () => {
    expect(parseInline("**x**")).toEqual([
      { kind: "strong", children: [{ kind: "text", text: "x" }] },
    ]);
    expect(parseInline("*x*")).toEqual([{ kind: "em", children: [{ kind: "text", text: "x" }] }]);
    expect(parseInline("~~x~~")).toEqual([
      { kind: "del", children: [{ kind: "text", text: "x" }] },
    ]);
  });

  it("nests marks inside each other", () => {
    expect(parseInline("**a *b* c**")).toEqual([
      {
        kind: "strong",
        children: [
          { kind: "text", text: "a " },
          { kind: "em", children: [{ kind: "text", text: "b" }] },
          { kind: "text", text: " c" },
        ],
      },
    ]);
  });

  it("leaves snake_case underscores alone", () => {
    expect(parseInline("foo_bar_baz")).toEqual([{ kind: "text", text: "foo_bar_baz" }]);
  });

  it("parses markdown links", () => {
    expect(parseInline("[docs](https://x.dev/a)")).toEqual([
      { kind: "link", href: "https://x.dev/a", children: [{ kind: "text", text: "docs" }] },
    ]);
  });

  it("autolinks bare URLs and drops trailing punctuation", () => {
    expect(parseInline("see https://x.dev/a.")).toEqual([
      { kind: "text", text: "see " },
      {
        kind: "link",
        href: "https://x.dev/a",
        children: [{ kind: "text", text: "https://x.dev/a" }],
      },
      { kind: "text", text: "." },
    ]);
  });

  it("refuses unsafe link schemes", () => {
    expect(parseInline("[x](javascript:alert(1))")).toEqual([
      { kind: "text", text: "[x](javascript:alert(1))" },
    ]);
  });

  it("respects backslash escapes", () => {
    expect(parseInline("\\*not em\\*")).toEqual([{ kind: "text", text: "*not em*" }]);
  });

  it("keeps unmatched delimiters as literal text", () => {
    expect(parseInline("a * b")).toEqual([{ kind: "text", text: "a * b" }]);
    expect(parseInline("`unclosed")).toEqual([{ kind: "text", text: "`unclosed" }]);
  });
});
