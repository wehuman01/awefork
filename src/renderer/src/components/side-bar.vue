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
        <div
          class="proj-row"
          :class="{ active: group.directory === selectedDirectory }"
          @contextmenu.prevent="openDirMenu(group.directory, $event)"
        >
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
            <input
              v-if="renaming?.sessionId === row.session.id"
              :ref="focusRenameInput"
              v-model="renameText"
              class="sess-rename"
              :style="{ marginLeft: `${8 + row.depth * 14}px` }"
              @keydown.enter="onRenameEnter"
              @keydown.esc.stop="onRenameEsc"
              @mousedown.stop
              @blur="commitRename"
            />
            <button
              v-else
              type="button"
              class="sess"
              :class="{ running: store.running[row.session.id] }"
              :style="{ paddingLeft: `${8 + row.depth * 14}px` }"
              :title="row.session.title || '(untitled)'"
              @click="selectSession(row.session.id, { focus: true })"
              @contextmenu.prevent="openMenu(row.session, $event)"
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

    <div class="archive-zone">
      <button type="button" class="archive-head" @click="archiveOpen = !archiveOpen">
        <span class="archive-caret">{{ archiveOpen ? "▾" : "▸" }}</span>
        <span>📦 归档</span>
        <span v-if="archiveCount > 0" class="proj-count">{{ archiveCount }}</span>
      </button>
      <div v-if="archiveOpen" class="archive-list">
        <div v-for="dir in archivedDirectoryViews" :key="`dir:${dir.path}`" class="arch-row">
          <span class="arch-name" :title="dir.path">📁 {{ shortPath(dir.path) }}</span>
          <span class="arch-count" :title="`${dir.hiddenCount} 个会话被隐藏`">{{ dir.hiddenCount }}</span>
          <button
            type="button"
            class="arch-restore"
            title="恢复这个目录（含以后新增的会话）"
            @click="onRestoreDirectory(dir.path)"
          >↩</button>
        </div>
        <div v-for="sess in archivedSessionViews" :key="`sess:${sess.id}`" class="arch-row">
          <span class="arch-name" :title="sess.title">{{ sess.title }}</span>
          <button
            type="button"
            class="arch-restore"
            title="恢复这个会话"
            @click="onRestoreSession(sess.id)"
          >↩</button>
        </div>
        <p v-if="archiveCount === 0" class="group-empty">归档区是空的</p>
      </div>
    </div>

    <div
      v-if="menu"
      class="ctx-menu"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      @mousedown.stop
    >
      <button type="button" class="ctx-menu-item" @click="beginRename">✏️ 重命名</button>
      <button type="button" class="ctx-menu-item" @click="copySessionId">📋 复制会话 ID</button>
      <button type="button" class="ctx-menu-item" @click="beginArchive">📦 归档会话</button>
      <button type="button" class="ctx-menu-item danger" @click="beginDelete">
        🗑 删除会话…
      </button>
    </div>

    <div
      v-if="dirMenu"
      class="ctx-menu"
      :style="{ left: `${dirMenu.x}px`, top: `${dirMenu.y}px` }"
      @mousedown.stop
    >
      <button type="button" class="ctx-menu-item" @click="beginDirArchive">
        📦 归档这个目录…
      </button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { SessionGroup, SessionTreeNode } from "../../../shared/session-tree";
import type { SessionSummary } from "../../../shared/types";
import { shortPath } from "../format";
import {
  archiveDirectory,
  archivedDirectoryViews,
  archivedSessionViews,
  archiveSession,
  deleteSession,
  refreshSessions,
  renameSession,
  restoreDirectory,
  restoreSession,
  selectSession,
  sessionGroups,
  store,
  switchDirectory,
  togglePin,
} from "../state";

const query = ref("");
/** Per-directory expansion overrides; a directory defaults open when selected. */
const expandedOverride = ref<Record<string, boolean>>({});

// ── context menu + inline rename ────────────────────────────────────

const menu = ref<{ sessionId: string; title: string; x: number; y: number } | null>(null);
const renaming = ref<{ sessionId: string; title: string } | null>(null);
const renameText = ref("");
const dirMenu = ref<{ directory: string; x: number; y: number } | null>(null);

function openMenu(session: SessionSummary, event: MouseEvent): void {
  dirMenu.value = null;
  menu.value = { sessionId: session.id, title: session.title, x: event.clientX, y: event.clientY };
}

function closeMenu(): void {
  menu.value = null;
  dirMenu.value = null;
}

function openDirMenu(directory: string, event: MouseEvent): void {
  menu.value = null;
  dirMenu.value = { directory, x: event.clientX, y: event.clientY };
}

function beginRename(): void {
  const active = menu.value;
  if (!active) return;
  closeMenu();
  renaming.value = { sessionId: active.sessionId, title: active.title };
  renameText.value = active.title;
}

function cancelRename(): void {
  renaming.value = null;
}

/** 组输入期间的回车在确认候选词，不是提交重命名（见 chat-input 的 onEnterKey）。 */
function onRenameEnter(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  commitRename();
}

/** 组输入期间的 Esc 在关候选词窗，第一次不该顺手关掉重命名。 */
function onRenameEsc(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  cancelRename();
}

function commitRename(): void {
  const active = renaming.value;
  if (!active) return;
  renaming.value = null;
  const title = renameText.value.trim();
  if (!title || title === active.title) return;
  void renameSession(active.sessionId, title);
}

/** Copy the raw session id — for resuming the branch in a terminal. */
function copySessionId(): void {
  const active = menu.value;
  if (!active) return;
  closeMenu();
  void navigator.clipboard.writeText(active.sessionId);
}

/** Same soft delete as the canvas 🗑 chip: confirm, then the undo toast rules. */
function beginDelete(): void {
  const active = menu.value;
  if (!active) return;
  closeMenu();
  const title = active.title || "空会话";
  const ok = window.confirm(
    `删除会话「${title}」？\n它的所有回合都会一起删除（从它分叉出的子分支会保留）。`,
  );
  if (!ok) return;
  void deleteSession(active.sessionId);
}

/** Archive is fully reversible — no confirm, the archive section undoes it. */
function beginArchive(): void {
  const active = menu.value;
  if (!active) return;
  closeMenu();
  void archiveSession(active.sessionId);
}

/** Whole-directory archive hides a lot at once — confirm before the move. */
function beginDirArchive(): void {
  const active = dirMenu.value;
  if (!active) return;
  closeMenu();
  const ok = window.confirm(
    `归档目录「${shortPath(active.directory)}」？\n它下面的所有会话（包括以后新增的）都会隐藏，随时可在侧栏底部的归档区恢复。`,
  );
  if (!ok) return;
  void archiveDirectory(active.directory);
}

// ── archive section ─────────────────────────────────────────────────

const archiveOpen = ref(false);

const archiveCount = computed(
  () => archivedDirectoryViews.value.length + archivedSessionViews.value.length,
);

function onRestoreDirectory(directory: string): void {
  void restoreDirectory(directory);
}

function onRestoreSession(sessionId: string): void {
  void restoreSession(sessionId);
}

/** Function ref: focus (and select) the rename input the moment it mounts. */
function focusRenameInput(el: unknown): void {
  const input = el as HTMLInputElement | null;
  if (input) {
    input.focus();
    input.select();
  }
}

function onDocMousedown(): void {
  closeMenu();
}

onMounted(() => document.addEventListener("mousedown", onDocMousedown));
onUnmounted(() => document.removeEventListener("mousedown", onDocMousedown));

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
</script>
