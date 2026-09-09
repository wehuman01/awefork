<template>
  <Teleport to="body">
    <div v-if="paletteOpen" class="palette-backdrop" @mousedown.self="close">
      <div class="palette">
        <input
          ref="inputEl"
          v-model="query"
          class="palette-input"
          type="text"
          placeholder="搜索会话，或输入命令…"
          @keydown="onInputKeydown"
        />
        <div class="palette-list">
          <button
            v-for="(item, i) in items"
            :key="item.key"
            type="button"
            class="palette-item"
            :class="{ hl: i === highlighted }"
            @mouseenter="highlighted = i"
            @click="run(item)"
          >
            <span class="palette-icon">{{ item.icon }}</span>
            <span class="palette-label">{{ item.label }}</span>
            <span class="palette-hint">{{ item.hint }}</span>
          </button>
          <p v-if="items.length === 0" class="palette-empty">没有匹配项</p>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import type { SessionSummary } from "../../../shared/types";
import { paletteOpen, panels, togglePalette, togglePanel } from "../layout";
import {
  cloneSelectedSession,
  createSession,
  refreshSessions,
  requestCanvasFit,
  selectSession,
  store,
  switchDirectory,
  visibleSessions,
} from "../state";

interface PaletteItem {
  key: string;
  icon: string;
  label: string;
  hint: string;
  run: () => void;
}

const query = ref("");
const highlighted = ref(0);
const inputEl = ref<HTMLInputElement | null>(null);

watch(paletteOpen, (open) => {
  if (open) {
    query.value = "";
    highlighted.value = 0;
    void nextTick(() => inputEl.value?.focus());
  }
});

const items = computed<PaletteItem[]>(() => {
  const needle = query.value.trim().toLowerCase();
  const match = (text: string) => !needle || text.toLowerCase().includes(needle);
  const actions: PaletteItem[] = [
    {
      key: "act:new",
      icon: "＋",
      label: "新增对话",
      hint: "新会话",
      run: () => void createSession(),
    },
    { key: "act:fit", icon: "⛶", label: "适配视图", hint: "画布", run: requestCanvasFit },
    {
      key: "act:clone",
      icon: "⎇",
      label: "克隆当前分支",
      hint: "checkpoint",
      run: () => void cloneSelectedSession(),
    },
    {
      key: "act:refresh",
      icon: "↻",
      label: "刷新会话列表",
      hint: "",
      run: () => void refreshSessions(),
    },
    {
      key: "act:sidebar",
      icon: "▤",
      label: panels.sidebar.collapsed ? "展开侧栏" : "折叠侧栏",
      hint: "",
      run: () => togglePanel("sidebar"),
    },
    {
      key: "act:context",
      icon: "▥",
      label: panels.context.collapsed ? "展开右栏" : "折叠右栏",
      hint: "",
      run: () => togglePanel("context"),
    },
  ].filter((action) => match(action.label) || match(action.hint));

  const sessions = visibleSessions.value
    .filter((s) => match(s.title) || match(s.directory))
    .slice(0, 30)
    .map(
      (s): PaletteItem => ({
        key: `session:${s.id}`,
        icon: s.origin === "fork" ? "⎇" : "💬",
        label: s.title || "(untitled)",
        hint: shortDir(s.directory),
        run: () => void jumpToSession(s),
      }),
    );

  return [...actions, ...sessions];
});

watch(items, () => {
  highlighted.value = 0;
});

function run(item: PaletteItem): void {
  close();
  item.run();
}

function close(): void {
  paletteOpen.value = false;
}

async function jumpToSession(session: SessionSummary): Promise<void> {
  if (session.directory !== store.selectedDirectory) {
    await switchDirectory(session.directory);
  }
  await selectSession(session.id, { focus: true });
}

function onInputKeydown(event: KeyboardEvent): void {
  // 组输入（中文输入法）期间的按键在操作候选词窗：Enter 确认候选、方向键
  // 移动候选，都不该触发面板导航。keyCode 229 兜住 Safari 的合成键。
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const size = items.value.length;
    if (size === 0) return;
    const step = event.key === "ArrowDown" ? 1 : -1;
    highlighted.value = (highlighted.value + step + size) % size;
  } else if (event.key === "Enter") {
    event.preventDefault();
    const hit = items.value[highlighted.value];
    if (hit) run(hit);
  } else if (event.key === "Escape") {
    close();
  }
}

function onGlobalKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    togglePalette();
  }
}

onMounted(() => window.addEventListener("keydown", onGlobalKeydown));
onUnmounted(() => window.removeEventListener("keydown", onGlobalKeydown));

function shortDir(directory: string): string {
  const parts = directory.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || directory || "…";
}
</script>
