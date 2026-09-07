import { reactive, ref } from "vue";

/**
 * Shell layout state: the two side panels' widths and folded state,
 * persisted to localStorage, plus the command palette's open flag.
 * Shared by app.vue (drag handles) and the command palette (toggle actions).
 */

export interface PanelState {
  width: number;
  collapsed: boolean;
  /** Width to restore on un-collapse. */
  saved: number;
}

export type PanelSide = "sidebar" | "context";

const LAYOUT_KEY = "awefork:layout";

const DEFAULTS: Record<PanelSide, PanelState> = {
  sidebar: { width: 232, collapsed: false, saved: 232 },
  context: { width: 336, collapsed: false, saved: 336 },
};

export const PANEL_LIMITS: Record<PanelSide, { min: number; max: number }> = {
  sidebar: { min: 180, max: 420 },
  context: { min: 300, max: 680 },
};

function load(): Record<PanelSide, PanelState> {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(raw) as Partial<Record<PanelSide, Partial<PanelState>>>;
    const merge = (side: PanelSide): PanelState => {
      const saved = parsed[side];
      if (!saved || typeof saved.width !== "number") return { ...DEFAULTS[side] };
      const { min, max } = PANEL_LIMITS[side];
      return {
        width: Math.min(max, Math.max(min, saved.width)),
        collapsed: Boolean(saved.collapsed),
        saved: typeof saved.saved === "number" ? saved.saved : DEFAULTS[side].saved,
      };
    };
    return { sidebar: merge("sidebar"), context: merge("context") };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export const panels = reactive(load());

/** True while the ⌘K palette overlay is up. */
export const paletteOpen = ref(false);

export function togglePalette(): void {
  paletteOpen.value = !paletteOpen.value;
}

export function persistLayout(): void {
  localStorage.setItem(
    LAYOUT_KEY,
    JSON.stringify({ sidebar: { ...panels.sidebar }, context: { ...panels.context } }),
  );
}

export function togglePanel(side: PanelSide): void {
  const panel = panels[side];
  if (panel.collapsed) {
    panel.collapsed = false;
    panel.width = panel.saved;
  } else {
    panel.saved = panel.width;
    panel.collapsed = true;
  }
  persistLayout();
}

export function panelStyle(side: PanelSide): Record<string, string> {
  const panel = panels[side];
  const size = panel.collapsed ? "0px" : `${panel.width}px`;
  return { width: size, flexBasis: size, overflow: "hidden" };
}
