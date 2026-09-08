<template>
  <button
    v-if="!open"
    type="button"
    class="panel-pill"
    title="搜索画布上所有节点的正文（⌘/Ctrl+F）"
    @click="openSearch"
  >🔍 搜节点</button>
  <div v-else class="story-search">
    <div class="ss-box">
      <span class="ss-icon">🔍</span>
      <input
        ref="inputEl"
        v-model="searchQuery"
        type="text"
        placeholder="搜索画布所有节点（提问 / 回复 / 工具）…"
        @keydown.esc="close"
      />
      <span v-if="searchQuery.trim()" class="ss-count">{{ storySearchHits.length }} 命中</span>
      <button type="button" class="ss-close" title="收起（Esc）" @click="close">✕</button>
    </div>
    <div v-if="searchQuery.trim() && storySearchHits.length > 0" class="ss-results">
      <button
        v-for="hit in storySearchHits"
        :key="hit.nodeId"
        type="button"
        class="ss-hit"
        @click="jump(hit)"
      >
        <span class="ss-hit-head">
          <span class="ss-field" :class="hit.field">{{ fieldLabel(hit.field) }}</span>
          <span class="ss-hit-title">{{ titleOf(hit) }}</span>
        </span>
        <span class="ss-snippet">{{ hit.snippet.slice(0, hit.matchStart) }}<mark>{{ hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength) }}</mark>{{ hit.snippet.slice(hit.matchStart + hit.matchLength) }}</span>
      </button>
    </div>
    <div v-else-if="searchQuery.trim()" class="ss-results">
      <p class="ss-empty">没有命中 — 换个关键词试试</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import type { TurnNode } from "../../../shared/canvas-graph";
import type { TurnSearchHit } from "../../../shared/turn-search";
import { searchQuery, selectTurn, storySearchHits, turnGraph } from "../state";

const emit = defineEmits<{ jump: [node: TurnNode] }>();

const open = ref(false);
const inputEl = ref<HTMLInputElement | null>(null);

const nodeById = computed(() => new Map(turnGraph.value.nodes.map((n) => [n.id, n])));

function titleOf(hit: TurnSearchHit): string {
  return nodeById.value.get(hit.nodeId)?.title ?? "";
}

function fieldLabel(field: TurnSearchHit["field"]): string {
  return field === "prompt" ? "提问" : field === "preview" ? "回复" : "工具";
}

function openSearch(): void {
  open.value = true;
  void nextTick(() => inputEl.value?.focus());
}

function close(): void {
  open.value = false;
  searchQuery.value = "";
}

function jump(hit: TurnSearchHit): void {
  const node = nodeById.value.get(hit.nodeId);
  if (!node) return;
  void selectTurn(node);
  emit("jump", node);
}

// ⌘/Ctrl+F opens the story search from anywhere in the app.
function onKeydown(event: KeyboardEvent): void {
  if (event.key.toLowerCase() !== "f" || !(event.metaKey || event.ctrlKey)) return;
  event.preventDefault();
  openSearch();
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => window.removeEventListener("keydown", onKeydown));
</script>
