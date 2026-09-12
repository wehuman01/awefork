/**
 * The one sanctioned HTML-string exit in the renderer. KaTeX with trust
 * disabled escapes every byte of the TeX source and emits no scripts, event
 * handlers, or external references, so its output is safe to inject as
 * innerHTML; with throwOnError off, invalid TeX degrades to red source text
 * instead of throwing mid-stream. Everything else in the reply renderer
 * stays text-node only (see markdown-view.ts).
 */

import katex from "katex";

export function renderTex(tex: string, displayMode: boolean): string {
  return katex.renderToString(tex, {
    displayMode,
    throwOnError: false,
    strict: false,
    trust: false,
    output: "html",
  });
}
