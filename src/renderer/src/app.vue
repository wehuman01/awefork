<template>
  <div class="app">
    <TopBar />
    <div class="shell">
      <SideBar :style="panelStyle('sidebar')" />
      <div
        class="col-handle"
        title="拖拽调宽 · 双击折叠/展开"
        @mousedown="startDrag('sidebar', $event)"
        @dblclick="togglePanel('sidebar')"
      ></div>
      <SessionCanvas />
      <div
        class="col-handle"
        title="拖拽调宽 · 双击折叠/展开"
        @mousedown="startDrag('context', $event)"
        @dblclick="togglePanel('context')"
      ></div>
      <BranchContext :style="panelStyle('context')" />
    </div>
    <CommandPalette />
    <div
      v-if="store.actionError"
      class="toast banner-error"
      role="alert"
      @click="dismissActionError"
    >
      {{ store.actionError }}（点击关闭）
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from "vue";
import BranchContext from "./components/branch-context.vue";
import CommandPalette from "./components/command-palette.vue";
import SessionCanvas from "./components/session-canvas.vue";
import SideBar from "./components/side-bar.vue";
import TopBar from "./components/top-bar.vue";
import { PANEL_LIMITS, panelStyle, panels, persistLayout, togglePanel } from "./layout";
import { dismissActionError, init, store } from "./state";

onMounted(() => {
  void init();
});

// ── panel drag handles ───────────────────────────────────────────────

function startDrag(side: "sidebar" | "context", event: MouseEvent): void {
  if (event.button !== 0) return;
  const panel = panels[side];
  panel.collapsed = false;
  const startX = event.clientX;
  // Collapse only hides the panel; width keeps the live value.
  const startWidth = panel.width;
  const growRight = side === "sidebar";
  const { min, max } = PANEL_LIMITS[side];
  const move = (moveEvent: MouseEvent): void => {
    const delta = (moveEvent.clientX - startX) * (growRight ? 1 : -1);
    panel.width = Math.min(max, Math.max(min, startWidth + delta));
  };
  const up = (): void => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    persistLayout();
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}
</script>
