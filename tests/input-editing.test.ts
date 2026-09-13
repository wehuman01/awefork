import { describe, expect, it } from "vitest";
import {
  indentLines,
  looksLikeCode,
  outdentLines,
  type TextEdit,
  wrapCodeFence,
} from "../src/renderer/src/input-editing";

/** Apply a TextEdit the way chat-input.vue splices it into the textarea. */
function applyEdit(value: string, edit: TextEdit): string {
  return value.slice(0, edit.from) + edit.insert + value.slice(edit.to);
}

describe("indentLines", () => {
  it("inserts two spaces at a bare caret", () => {
    expect(indentLines("ab", 1, 1)).toEqual({ from: 1, to: 1, insert: "  ", start: 3, end: 3 });
  });

  it("indents every line a multi-line selection touches", () => {
    const edit = indentLines("a\nb\nc", 2, 4);
    expect(edit).toMatchObject({ from: 2, to: 5, insert: "  b\n  c" });
    expect(applyEdit("a\nb\nc", edit)).toBe("a\n  b\n  c");
    expect(edit.start).toBe(2); // line b's start stays at its indent
    expect(edit.end).toBe(6); // line c's start moved past b's indent
  });

  it("grows the selection to cover the added indents", () => {
    const edit = indentLines("a\nb\nc", 2, 3); // selection is just "b"
    expect(applyEdit("a\nb\nc", edit)).toBe("a\n  b\nc");
    expect(edit.start).toBe(2);
    expect(edit.end).toBe(5); // after "  b"
  });
});

describe("outdentLines", () => {
  it("strips up to two leading spaces per line", () => {
    const edit = outdentLines("  a\n    b\nc", 0, 10);
    expect(edit.insert).toBe("a\n  b\nc");
    expect(applyEdit("  a\n    b\nc", edit)).toBe("a\n  b\nc");
  });

  it("treats one leading tab as a single indent", () => {
    expect(outdentLines("\ta\n\t\tb", 0, 6).insert).toBe("a\n\tb");
  });

  it("keeps a caret glued to its line's content", () => {
    // caret sits between the indent and "a" at position 4 of "x\n  a"
    expect(outdentLines("x\n  a", 4, 4).start).toBe(2);
  });
});

describe("wrapCodeFence", () => {
  it("wraps pasted text and drops trailing blank lines", () => {
    expect(wrapCodeFence("x = 1\n\n")).toBe("```\nx = 1\n```");
  });
});

describe("looksLikeCode", () => {
  it("wraps python, shell sessions and js", () => {
    expect(looksLikeCode("def f():\n    return 1")).toBe(true);
    expect(looksLikeCode("$ npm i\n$ npm run build")).toBe(true);
    expect(looksLikeCode("const a = 1;\nfunction f() {\n  return a;\n}")).toBe(true);
  });

  it("wraps tracebacks, diffs, configs and markup", () => {
    expect(
      looksLikeCode(
        'Traceback (most recent call last):\n  File "app.py", line 10, in main\nValueError: bad',
      ),
    ).toBe(true);
    expect(looksLikeCode("diff --git a/x b/x\nindex abc..def 100644\n@@ -1 +1 @@")).toBe(true);
    expect(looksLikeCode("port: 8080\nname: 'demo'")).toBe(true);
    expect(looksLikeCode("[server]\nhost = localhost\nport = 8080")).toBe(true);
    expect(looksLikeCode("<div>\n  <p>hi</p>\n</div>")).toBe(true);
  });

  it("leaves prose and markdown alone", () => {
    expect(looksLikeCode("Here is the plan.\nWe ship tomorrow.\nThanks!")).toBe(false);
    expect(looksLikeCode("# Title\n\nSome **bold** prose.\n\n- item one\n- item two")).toBe(false);
  });

  it("requires multiple matching lines", () => {
    expect(looksLikeCode("const x = 1;")).toBe(false); // single line
    expect(looksLikeCode("def f():\nthis is prose about nothing\nmore prose here")).toBe(false);
  });

  it("never double-wraps text that already carries a fence", () => {
    expect(looksLikeCode("```js\nconst a = 1;\nconst b = 2;\n```")).toBe(false);
  });
});
