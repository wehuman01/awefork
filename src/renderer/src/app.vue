<template>
  <div class="app">
    <TopBar />
    <div
      v-if="store.updateLatest && !store.updateBannerDismissed"
      class="update-banner"
      role="status"
    >
      <span class="update-banner-icon">⬆</span>
      <span class="update-banner-text">
        v{{ store.updateLatest }} available · current v{{ store.currentVersion }}
      </span>
      <div class="update-banner-actions">
        <button type="button" class="update-banner-btn" @click="openReleaseNotes()">Release Notes ↗</button>
        <button type="button" class="update-banner-btn" @click="skipUpdateVersion()">Skip this version</button>
        <button type="button" class="update-banner-x" @click="dismissUpdateBanner()">✕</button>
      </div>
    </div>
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
    <InteractionDialog />
    <div
      v-if="store.actionError"
      class="toast banner-error"
      role="alert"
      @click="dismissActionError"
    >
      {{ store.actionError }}（点击关闭）
    </div>
    <div v-if="store.deletedToast" class="toast banner-undo" role="status">
      <span class="undo-text">已删除「{{ store.deletedToast.title }}」（⌘/Ctrl+Z 也可撤销）</span>
      <button
        type="button"
        class="undo-btn"
        title="把会话放回来"
        @click="undoDelete(store.deletedToast.sessionId)"
      >撤销</button>
    </div>
    <div v-if="store.updateToast" class="toast banner-update" role="status">
      {{ store.updateToast }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import BranchContext from "./components/branch-context.vue";
import CommandPalette from "./components/command-palette.vue";
import InteractionDialog from "./components/interaction-dialog.vue";
import SessionCanvas from "./components/session-canvas.vue";
import SideBar from "./components/side-bar.vue";
import TopBar from "./components/top-bar.vue";
import { PANEL_LIMITS, panelStyle, panels, persistLayout, togglePanel } from "./layout";
import {
  dismissActionError,
  dismissUpdateBanner,
  init,
  latestPendingDeleteId,
  openReleaseNotes,
  skipUpdateVersion,
  store,
  undoDelete,
} from "./state";

onMounted(() => {
  void init();
  window.addEventListener("keydown", onKeydown);
});
onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
  if (activeDrag) {
    window.removeEventListener("mousemove", activeDrag.move);
    window.removeEventListener("mouseup", activeDrag.up);
  }
});

// ── Ctrl/⌘+Z: undo the most recent delete still awaiting its flush ──
// Works even after the toast has faded; the undo window only closes when a
// new operation flushes the pending deletes. While typing, the keystroke
// stays a native text undo.

function onKeydown(event: KeyboardEvent): void {
  if (event.key.toLowerCase() !== "z" || !(event.metaKey || event.ctrlKey)) return;
  if (event.shiftKey || event.altKey) return;
  const target = event.target as HTMLElement | null;
  if (
    target &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
  ) {
    return;
  }
  const sessionId = latestPendingDeleteId();
  if (!sessionId) return;
  event.preventDefault();
  void undoDelete(sessionId);
}

// ── panel drag handles ───────────────────────────────────────────────

// The in-flight drag's window listeners; only one drag can be live at a time,
// and an unmount mid-drag must drop them instead of leaking the closures.
let activeDrag: { move: (event: MouseEvent) => void; up: () => void } | null = null;

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
    activeDrag = null;
    persistLayout();
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
  activeDrag = { move, up };
}
</script>
