<template>
  <aside class="sidebar">
    <div class="side-label">项目</div>
    <div class="side-actions">
      <button type="button" class="icon-btn wide" title="重新加载会话" @click="emitRefresh">↻ 刷新</button>
    </div>
    <div class="search">
      <span>⌕</span>
      <input v-model="query" type="text" placeholder="搜索会话" />
    </div>
    <nav class="session-list">
      <template v-for="group in visibleGroups" :key="group.directory">
        <div class="proj-row" :class="{ active: group.directory === selectedDirectory }">
          <button
            type="button"
            class="proj-caret"
            :title="isOpen(group) ? '收起这个目录' : '展开这个目录'"
            @click="toggleDir(group.directory)"
          >{{ isOpen(group) ? "▾" : "▸" }}</button>
          <button
            type="button"
            class="proj"
            :class="{ active: group.directory === selectedDirectory }"
            :title="group.directory"
            @click="selectDirectory(group.directory)"
          >
            <span>📁</span>
            <span class="proj-name">{{ shortPath(group.directory) }}</span>
            <span v-if="countSessions(group) > 0" class="proj-count">{{ countSessions(group) }}</span>
          </button>
        </div>
        <template v-if="isOpen(group)">
          <div
            v-for="row in flatSessions(group)"
            :key="row.session.id"
            class="sess-row"
            :class="{ active: row.session.id === selectedId }"
          >
            <button
              type="button"
              class="sess"
              :class="{ running: store.running[row.session.id] }"
              :style="{ paddingLeft: `${8 + row.depth * 14}px` }"
              :title="row.session.title || '(untitled)'"
              @click="selectSession(row.session.id, { focus: true })"
            >
              <span class="dot"></span>
              <span v-if="row.session.origin === 'fork'" class="fork-glyph">⎇</span>
              <span class="sess-name">{{ row.session.title || "(untitled)" }}</span>
            </button>
            <button
              type="button"
              class="pin-star"
              :class="{ on: store.pins.includes(row.session.id) }"
              :title="store.pins.includes(row.session.id) ? '取消收藏' : '收藏这个分支故事'"
              @click.stop="pinToggle(row.session.id)"
            >{{ store.pins.includes(row.session.id) ? "★" : "☆" }}</button>
          </div>
        </template>
      </template>
      <p v-if="visibleGroups.length === 0" class="group-empty">没有匹配的会话</p>
    </nav>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { SessionGroup, SessionTreeNode } from "../../../shared/session-tree";
import {
  refreshSessions,
  selectSession,
  sessionGroups,
  store,
  switchDirectory,
  togglePin,
} from "../state";

const query = ref("");
/** Per-directory expansion overrides; a directory defaults open when selected. */
const expandedOverride = ref<Record<string, boolean>>({});

const selectedDirectory = computed(() => store.selectedDirectory);
const selectedId = computed(() => store.selectedId);

const searching = computed(() => query.value.trim().length > 0);

function isDirOpen(directory: string): boolean {
  if (searching.value) return true;
  const override = expandedOverride.value[directory];
  return override ?? directory === selectedDirectory.value;
}

function isOpen(group: SessionGroup): boolean {
  return isDirOpen(group.directory);
}

function toggleDir(directory: string): void {
  expandedOverride.value = { ...expandedOverride.value, [directory]: !isDirOpen(directory) };
}

function pinToggle(sessionId: string): void {
  void togglePin(sessionId);
}

const visibleGroups = computed<SessionGroup[]>(() => {
  const needle = query.value.trim().toLowerCase();
  return sessionGroups.value
    .map((group) => {
      if (!needle) return group;
      const keep = (node: SessionTreeNode): SessionTreeNode | null => {
        const children = node.children.map(keep).filter((n): n is SessionTreeNode => n !== null);
        const hit = node.session.title.toLowerCase().includes(needle);
        return hit || children.length > 0 ? { ...node, children } : null;
      };
      const roots = group.roots.map(keep).filter((n): n is SessionTreeNode => n !== null);
      return { directory: group.directory, roots };
    })
    .filter((group) => group.roots.length > 0);
});

interface SessionRow {
  session: SessionTreeNode["session"];
  depth: number;
}

function flatSessions(group: SessionGroup): SessionRow[] {
  const rows: SessionRow[] = [];
  const walk = (nodes: SessionTreeNode[], depth: number): void => {
    for (const node of nodes) {
      rows.push({ session: node.session, depth });
      walk(node.children, depth + 1);
    }
  };
  walk(group.roots, 0);
  return rows;
}

function countSessions(group: SessionGroup): number {
  return flatSessions(group).length;
}

function selectDirectory(directory: string): void {
  expandedOverride.value = { ...expandedOverride.value, [directory]: true };
  void switchDirectory(directory);
}

function emitRefresh(): void {
  void refreshSessions();
}

function shortPath(directory: string): string {
  const parts = directory.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || directory || "…";
}
</script>
