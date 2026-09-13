/**
 * Renders markdown.ts's block tree as vnodes. Text only ever becomes text
 * nodes here, so reply content cannot smuggle in HTML — the sole exception
 * is math: math.ts renders TeX through KaTeX (trust disabled, errors shown
 * as red source) and that output is injected as innerHTML. Links route
 * through the openExternal IPC (shell.openExternal) instead of navigating
 * the app window. Single newlines inside a paragraph render as <br> — the
 * chat-pane reading of a hard-wrapped model reply.
 */

import { defineComponent, h, type VNode, type VNodeChild } from "vue";
import { isLocalPath } from "../../../shared/local-path";
import {
  downgradeUserBlocks,
  type MdBlock,
  type MdInline,
  type MdListBlock,
  type MdListItem,
  parseMarkdown,
} from "../markdown";
import { renderTex } from "../math";
import { reportActionError } from "../state";
import CodeBlock from "./code-block.vue";

function openLink(event: MouseEvent, href: string): void {
  event.preventDefault();
  if (isLocalPath(href)) {
    void window.awefork
      .openPath(href)
      .then((result) => {
        if (!result.ok) reportActionError(result.error ?? "路径打不开");
      })
      .catch(() => reportActionError("路径打不开"));
    return;
  }
  void window.awefork.openExternal(href).catch(() => {
    // Nothing sane to tell the user about a dead link click.
  });
}

function renderInline(nodes: readonly MdInline[]): VNodeChild[] {
  const out: VNodeChild[] = [];
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        for (const [j, seg] of node.text.split("\n").entries()) {
          if (j > 0) out.push(h("br"));
          if (seg !== "") out.push(seg);
        }
        break;
      case "code":
        out.push(h("code", { class: "md-code" }, node.text));
        break;
      case "math":
        out.push(
          h("span", {
            class: node.display ? "md-math md-math-display" : "md-math",
            innerHTML: renderTex(node.tex, node.display),
          }),
        );
        break;
      case "strong":
        out.push(h("strong", renderInline(node.children)));
        break;
      case "em":
        out.push(h("em", renderInline(node.children)));
        break;
      case "del":
        out.push(h("del", renderInline(node.children)));
        break;
      case "link":
        out.push(
          h(
            "a",
            {
              class: "md-link",
              href: "#",
              title: node.href,
              onClick: (e) => openLink(e, node.href),
            },
            renderInline(node.children),
          ),
        );
        break;
    }
  }
  return out;
}

function renderList(list: MdListBlock): VNode {
  const children = list.items.map((item: MdListItem) => {
    const kids = [h("span", { class: "md-li" }, renderInline(item.inline))];
    if (item.sublist) kids.push(renderList(item.sublist));
    return h("li", kids);
  });
  return h(
    list.ordered ? "ol" : "ul",
    { class: "md-list", start: list.ordered && list.start !== 1 ? list.start : undefined },
    children,
  );
}

function renderBlock(block: MdBlock): VNode {
  switch (block.kind) {
    case "paragraph":
      return h("p", { class: "md-p" }, renderInline(block.inline));
    case "heading":
      return h(`h${Math.min(block.level, 6)}`, { class: "md-h" }, renderInline(block.inline));
    case "code":
      return h(CodeBlock, { lang: block.lang, code: block.code });
    case "mathBlock":
      return h("div", { class: "md-math md-math-display", innerHTML: renderTex(block.tex, true) });
    case "hr":
      return h("hr", { class: "md-hr" });
    case "quote":
      return h("blockquote", { class: "md-quote" }, block.children.map(renderBlock));
    case "list":
      return renderList(block);
    case "table": {
      const cell = (tag: "th" | "td", inline: readonly MdInline[], i: number): VNode =>
        h(tag, { class: "md-td", style: { textAlign: block.align[i] ?? "left" } }, [
          renderInline(inline),
        ]);
      return h("div", { class: "md-table-wrap" }, [
        h("table", { class: "md-table" }, [
          h("thead", [
            h(
              "tr",
              block.head.map((c, i) => cell("th", c, i)),
            ),
          ]),
          h(
            "tbody",
            block.rows.map((row) =>
              h(
                "tr",
                row.map((c, i) => cell("td", c, i)),
              ),
            ),
          ),
        ]),
      ]);
    }
  }
}

export const MarkdownView = defineComponent({
  name: "MarkdownView",
  props: {
    source: { type: String, default: "" },
    /** Render as the user's own prompt: downgrade headings/tables/math to
     *  plain content (downgradeUserBlocks) instead of reply typography. */
    user: { type: Boolean, default: false },
  },
  setup(props) {
    // Re-parsing per render is O(reply length) with a tiny constant — fine
    // even for every streamed frame of a long reply.
    return () => {
      const blocks = parseMarkdown(props.source);
      return h(
        "div",
        { class: "md" },
        (props.user ? downgradeUserBlocks(blocks) : blocks).map(renderBlock),
      );
    };
  },
});
