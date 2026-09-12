import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS, PANEL_LIMITS } from "../src/renderer/src/layout";

/**
 * layout.ts is a singleton that reads localStorage at import time, so every
 * test seeds an in-memory storage and boots a fresh module via
 * vi.resetModules + dynamic import — the same trick renderer-state-
 * interactions uses for the state singleton. vitest runs in the node
 * environment here, hence the hand-rolled storage instead of jsdom's.
 */

type LayoutModule = typeof import("../src/renderer/src/layout");

class MemoryStorage {
  private map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  (globalThis as unknown as { localStorage: Storage }).localStorage = storage as unknown as Storage;
});

afterEach(() => {
  delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
});

/** Boot a fresh layout module; seed raw JSON under the layout key first. */
async function bootLayout(raw: string | null = null): Promise<LayoutModule> {
  if (raw !== null) storage.setItem("awefork:layout", raw);
  vi.resetModules();
  return await import("../src/renderer/src/layout");
}

describe("load", () => {
  it("falls back to defaults on a clean storage", async () => {
    const { panels } = await bootLayout();
    expect({ ...panels.sidebar }).toEqual(DEFAULTS.sidebar);
    expect({ ...panels.context }).toEqual(DEFAULTS.context);
  });

  it("clamps a persisted width into the panel limits", async () => {
    const raw = JSON.stringify({
      sidebar: { width: 99_999, collapsed: false, saved: 99_999 },
      context: { width: 1, collapsed: false, saved: 1 },
    });
    const { panels } = await bootLayout(raw);
    expect(panels.sidebar.width).toBe(PANEL_LIMITS.sidebar.max);
    expect(panels.context.width).toBe(PANEL_LIMITS.context.min);
  });

  it("keeps a legal persisted width untouched", async () => {
    const raw = JSON.stringify({
      sidebar: { width: 260, collapsed: false, saved: 260 },
      context: { width: 500, collapsed: false, saved: 500 },
    });
    const { panels } = await bootLayout(raw);
    expect(panels.sidebar.width).toBe(260);
    expect(panels.context.width).toBe(500);
  });

  it("falls back to defaults on corrupt JSON", async () => {
    const { panels } = await bootLayout("{not json");
    expect({ ...panels.sidebar }).toEqual(DEFAULTS.sidebar);
  });

  it("falls back to defaults when a panel entry has no numeric width", async () => {
    const raw = JSON.stringify({ sidebar: { collapsed: true }, context: {} });
    const { panels } = await bootLayout(raw);
    expect({ ...panels.sidebar }).toEqual(DEFAULTS.sidebar);
    expect({ ...panels.context }).toEqual(DEFAULTS.context);
  });

  it("restores the collapsed flag and a missing saved width", async () => {
    const raw = JSON.stringify({ sidebar: { width: 300, collapsed: true } });
    const { panels } = await bootLayout(raw);
    expect(panels.sidebar.collapsed).toBe(true);
    expect(panels.sidebar.saved).toBe(DEFAULTS.sidebar.saved);
  });
});

describe("togglePanel", () => {
  it("collapse saves the live width and expands back to it", async () => {
    const { panels, togglePanel } = await bootLayout();
    panels.sidebar.width = 300;
    togglePanel("sidebar");
    expect(panels.sidebar.collapsed).toBe(true);
    expect(panels.sidebar.saved).toBe(300);
    togglePanel("sidebar");
    expect(panels.sidebar.collapsed).toBe(false);
    expect(panels.sidebar.width).toBe(300);
  });

  it("only touches the asked-for panel", async () => {
    const { panels, togglePanel } = await bootLayout();
    togglePanel("sidebar");
    expect(panels.sidebar.collapsed).toBe(true);
    expect(panels.context.collapsed).toBe(false);
  });

  it("persists through localStorage across a module reboot", async () => {
    const first = await bootLayout();
    first.panels.sidebar.width = 300;
    first.togglePanel("sidebar");
    const second = await bootLayout();
    expect(second.panels.sidebar.collapsed).toBe(true);
    expect(second.panels.sidebar.width).toBe(300);
    second.togglePanel("sidebar");
    expect(second.panels.sidebar.width).toBe(300);
    expect(second.panels.sidebar.collapsed).toBe(false);
  });
});

describe("panelStyle", () => {
  it("renders the live width expanded and zero when collapsed", async () => {
    const { panels, panelStyle, togglePanel } = await bootLayout();
    panels.sidebar.width = 300;
    expect(panelStyle("sidebar")).toEqual({
      width: "300px",
      flexBasis: "300px",
      overflow: "hidden",
    });
    togglePanel("sidebar");
    expect(panelStyle("sidebar")).toEqual({
      width: "0px",
      flexBasis: "0px",
      overflow: "hidden",
      padding: "0",
      borderWidth: "0",
    });
  });
});

describe("persistLayout", () => {
  it("round-trips both panels' state", async () => {
    const { panels, persistLayout } = await bootLayout();
    panels.sidebar.width = 400;
    panels.context.width = 512;
    persistLayout();
    expect(JSON.parse(storage.getItem("awefork:layout") ?? "{}")).toEqual({
      sidebar: { width: 400, collapsed: false, saved: DEFAULTS.sidebar.saved },
      context: { width: 512, collapsed: false, saved: DEFAULTS.context.saved },
    });
  });
});

describe("togglePalette", () => {
  it("flips the palette flag both ways", async () => {
    const { paletteOpen, togglePalette } = await bootLayout();
    expect(paletteOpen.value).toBe(false);
    togglePalette();
    expect(paletteOpen.value).toBe(true);
    togglePalette();
    expect(paletteOpen.value).toBe(false);
  });
});
