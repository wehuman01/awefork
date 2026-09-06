<template>
  <main
    ref="viewportEl"
    class="viewport"
    :class="{ panning }"
    @wheel.prevent="onWheel"
    @mousedown="onMouseDown"
  >
    <div class="world" :style="worldStyle">
      <svg class="edges" :width="svgSize.w" :height="svgSize.h">
        <g v-for="edge in edgesWithPoints" :key="`${edge.from}->${edge.to}`">
          <path
            :d="edge.path"
            class="edge"
            :class="{ fork: edge.kind === 'fork' }"
          />
          <circle :cx="edge.ex" :cy="edge.ey" r="3.5" class="edge-dot" />
        </g>
      </svg>

      <article
        v-for="node in graph.nodes"
        :key="node.id"
        class="turn"
        :class="{
          selected: node.id === selectedTurnId,
          running: store.running[node.sessionId],
          stub: node.kind === 'stub',
        }"
        :style="{ left: `${node.x}px`, top: `${node.y}px`, width: `${NODE_WIDTH}px` }"
        @mousedown.stop
        @click="selectNode(node)"
      >
        <template v-if="node.kind === 'turn'">
          <button
            type="button"
            class="add-chip"
            title="从这里长出新分支"
            @click.stop="openDraft(node)"
          >
            ＋
          </button>
          <div class="turn-head">
            <span class="avatar user">🍑</span>
            <span class="turn-title" :title="node.title">{{ node.title }}</span>
            <span class="turn-time">{{ relativeTime(node.createdAt) }}</span>
            <button
              type="button"
              class="pin-star"
              :class="{ on: isPinned(node.sessionId) }"
              :title="isPinned(node.sessionId) ? '取消收藏' : '收藏这个分支故事'"
              @click.stop="pinToggle(node.sessionId)"
            >{{ isPinned(node.sessionId) ? "★" : "☆" }}</button>
          </div>
          <div class="turn-body">
            <span class="avatar bot">✨</span>
            <p class="turn-preview">{{ node.preview || "(工具调用，无文本回复)" }}</p>
          </div>
          <div v-if="node.toolNames.length > 0" class="chips">
            <span
              v-for="(name, i) in node.toolNames"
              :key="name"
              class="chip"
              :class="{ lav: i % 2 === 1 }"
            >{{ name }}</span>
          </div>
          <div class="turn-foot">
            <span v-if="store.running[node.sessionId]" class="running-flag">○ 运行中…</span>
            <span v-else>{{ node.toolNames.length > 0 ? `${node.toolNames.length} 个工具` : "无工具调用" }}</span>
            <span class="model">opencode</span>
          </div>
        </template>
        <template v-else>
          <div class="turn-head">
            <span class="avatar user">🌱</span>
            <span class="turn-title" :title="node.title">{{ node.title }}</span>
            <button
              type="button"
              class="pin-star"
              :class="{ on: isPinned(node.sessionId) }"
              :title="isPinned(node.sessionId) ? '取消收藏' : '收藏这个分支故事'"
              @click.stop="pinToggle(node.sessionId)"
            >{{ isPinned(node.sessionId) ? "★" : "☆" }}</button>
          </div>
          <p class="stub-hint">新分支还没有自己的回合 — 点「＋」写下第一步，或者直接在右侧回复。</p>
        </template>
      </article>

      <article
        v-if="draftNode"
        class="draft"
        :style="{ left: `${draftX}px`, top: `${draftY}px` }"
        @mousedown.stop
      >
        <div class="draft-head">
          <span class="draft-tag">🌱 草稿 · {{ draftNode.kind === "stub" ? "继续分支" : "新分支" }}</span>
          <button type="button" class="close" @click="dismissDraft">✕</button>
        </div>
        <textarea
          :value="store.draft?.text"
          placeholder="描述下一步…（发送后从这里长出新分支）"
          @input="setDraftText(($event.target as HTMLTextAreaElement).value)"
          @keydown.meta.enter.prevent="submitDraft"
          @keydown.ctrl.enter.prevent="submitDraft"
        ></textarea>
        <div class="draft-foot">
          <span class="hint">⌘/Ctrl ⏎ 发送</span>
          <span class="mini-select">{{ draftNode.kind === "stub" ? "继续此分支" : "fork 后发送" }}</span>
          <button type="button" class="send-btn" :disabled="!store.draft?.text.trim()" @click="submitDraft">➤</button>
        </div>
      </article>
    </div>

    <div v-if="graph.nodes.length === 0 && !store.loadingMessages" class="canvas-empty">
      <div class="empty-mascot">🍑</div>
      <p class="empty-title">这个项目还没有会话</p>
      <p class="empty-sub">在终端里用 opencode 开一场对话，它就会作为第一个节点出现在这里</p>
    </div>
    <div v-if="store.loadingMessages" class="canvas-loading">正在铺开分支图…</div>

    <div class="canvas-status">
      {{ graph.nodes.length }} 个节点 · {{ sequenceCount }} 段对话 · {{ forkCount }} 条分支
    </div>
    <div class="canvas-tools">
      <div class="zoom-ctl">
        <button type="button" @click="zoomBy(0.85)">−</button>
        <span>{{ Math.round(scale * 100) }}%</span>
        <button type="button" @click="zoomBy(1.18)">＋</button>
      </div>
      <button type="button" class="fit-btn" title="适配视图" @click="fitView">⛶</button>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { TurnNode } from "../../../shared/canvas-graph";
import { COL_GAP, NODE_HEIGHT, NODE_WIDTH, ROW_GAP } from "../../../shared/canvas-graph";
import {
  dismissDraft,
  openDraft,
  selectTurn,
  sendDraft,
  setDraftText,
  store,
  togglePin,
  turnGraph,
} from "../state";

const viewportEl = ref<HTMLElement | null>(null);
const scale = ref(1);
const tx = ref(0);
const ty = ref(0);
const panning = ref(false);

const graph = computed(() => turnGraph.value);
const selectedTurnId = computed(() => store.selectedTurnId);

function isPinned(sessionId: string): boolean {
  return store.pins.includes(sessionId);
}

function pinToggle(sessionId: string): void {
  void togglePin(sessionId);
}

const worldStyle = computed(() => ({
  transform: `translate(${tx.value}px, ${ty.value}px) scale(${scale.value})`,
}));

const svgSize = computed(() => {
  const maxX = Math.max(0, ...graph.value.nodes.map((n) => n.x + NODE_WIDTH + 100));
  const maxY = Math.max(0, ...graph.value.nodes.map((n) => n.y + NODE_HEIGHT + 100));
  return { w: maxX, h: maxY };
});

const nodeById = computed(() => new Map(graph.value.nodes.map((n) => [n.id, n])));

const edgesWithPoints = computed(() =>
  graph.value.edges.flatMap((edge) => {
    const from = nodeById.value.get(edge.from);
    const to = nodeById.value.get(edge.to);
    if (!from || !to) return [];
    const x1 = from.x + NODE_WIDTH;
    const y1 = from.y + NODE_HEIGHT / 2;
    const x2 = to.x;
    const y2 = to.y + NODE_HEIGHT / 2;
    const bend = Math.max(46, (x2 - x1) / 2);
    return [
      {
        ...edge,
        path: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
        ex: x2 - 2,
        ey: y2,
      },
    ];
  }),
);

const sequenceCount = computed(() => new Set(graph.value.nodes.map((n) => n.sessionId)).size);
const forkCount = computed(() => graph.value.edges.filter((e) => e.kind === "fork").length);

const draftNode = computed(() =>
  store.draft ? (nodeById.value.get(store.draft.nodeId) ?? null) : null,
);
const draftX = computed(() => (draftNode.value?.x ?? 0) + 56);
const draftY = computed(() => (draftNode.value?.y ?? 0) + NODE_HEIGHT + 40);

function selectNode(node: TurnNode): void {
  void selectTurn(node);
}

function submitDraft(): void {
  void sendDraft();
}

// ── pan / zoom / fit ────────────────────────────────────────────────

function onMouseDown(event: MouseEvent): void {
  if (event.button !== 0) return;
  panning.value = true;
  const startX = event.clientX - tx.value;
  const startY = event.clientY - ty.value;
  const move = (moveEvent: MouseEvent): void => {
    tx.value = moveEvent.clientX - startX;
    ty.value = moveEvent.clientY - startY;
  };
  const up = (): void => {
    panning.value = false;
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

function onWheel(event: WheelEvent): void {
  const rect = viewportEl.value?.getBoundingClientRect();
  if (!rect) return;
  zoomAt(event.clientX - rect.left, event.clientY - rect.top, event.deltaY < 0 ? 1.08 : 0.93);
}

function zoomBy(factor: number): void {
  const rect = viewportEl.value?.getBoundingClientRect();
  if (!rect) return;
  zoomAt(rect.width / 2, rect.height / 2, factor);
}

function zoomAt(px: number, py: number, factor: number): void {
  const next = Math.min(1.8, Math.max(0.45, scale.value * factor));
  const applied = next / scale.value;
  tx.value = px - (px - tx.value) * applied;
  ty.value = py - (py - ty.value) * applied;
  scale.value = next;
}

function fitView(): void {
  const rect = viewportEl.value?.getBoundingClientRect();
  if (!rect || graph.value.nodes.length === 0) return;
  const minX = Math.min(...graph.value.nodes.map((n) => n.x));
  const minY = Math.min(...graph.value.nodes.map((n) => n.y));
  const maxX = Math.max(...graph.value.nodes.map((n) => n.x + NODE_WIDTH));
  const maxY = Math.max(...graph.value.nodes.map((n) => n.y + NODE_HEIGHT));
  const padding = 48;
  const boundsW = maxX - minX + padding * 2;
  const boundsH = maxY - minY + padding * 2;
  // Overview only: never shrink so far that cards become unreadable dots.
  scale.value = Math.min(1, Math.max(0.2, Math.min(rect.width / boundsW, rect.height / boundsH)));
  tx.value = (rect.width - boundsW * scale.value) / 2 - (minX - padding) * scale.value;
  ty.value = (rect.height - boundsH * scale.value) / 2 - (minY - padding) * scale.value;
}

function centerOnSession(sessionId: string): void {
  const rect = viewportEl.value?.getBoundingClientRect();
  const node = nodesOf(sessionId)[nodesOf(sessionId).length - 1];
  if (!node || !rect) return;
  scale.value = Math.max(scale.value, 0.85);
  tx.value = rect.width / 2 - (node.x + NODE_WIDTH / 2) * scale.value;
  ty.value = rect.height / 2 - (node.y + NODE_HEIGHT / 2) * scale.value;
}

// Real directories can hold hundreds of sessions — fitting everything would
// shrink the graph into dust. Open focused on the selected session's latest
// node; only small graphs get the full overview. Sidebar focus requests
// re-center on demand, retried once the session's messages (and therefore
// its nodes) have loaded.
const OVERVIEW_NODE_LIMIT = 18;
let centeredFor: string | null = null;
let pendingFocus: string | null = null;

function nodesOf(sessionId: string | null): TurnNode[] {
  if (!sessionId) return [];
  return graph.value.nodes.filter((n) => n.sessionId === sessionId);
}

function openInitialView(): void {
  if (graph.value.nodes.length === 0) return;
  if (graph.value.nodes.length <= OVERVIEW_NODE_LIMIT) {
    fitView();
    return;
  }
  if (store.selectedId && nodesOf(store.selectedId).length > 0) {
    focusNow(store.selectedId);
  }
}

function focusNow(sessionId: string): void {
  centerOnSession(sessionId);
  centeredFor = sessionId;
  pendingFocus = null;
}

watch(graph, () => {
  // Wait for the directory's message batch to finish — every merge re-lays
  // out the whole graph, so centering mid-load lands on a stale position.
  if (store.loadingMessages) return;
  if (pendingFocus) {
    if (nodesOf(pendingFocus).length > 0) focusNow(pendingFocus);
    return;
  }
  if (centeredFor === null) openInitialView();
});
watch(
  () => store.loadingMessages,
  (loading, was) => {
    if (was && !loading && centeredFor === null && pendingFocus === null) {
      openInitialView();
    }
  },
);
watch(
  () => store.focusRequest,
  (request) => {
    if (!request) return;
    pendingFocus = request.sessionId;
    if (nodesOf(pendingFocus).length > 0) focusNow(pendingFocus);
  },
);

// ── formatting ──────────────────────────────────────────────────────

function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
</script>
