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
            :class="{
              fork: edge.kind === 'fork',
              active: onActivePath(edge),
              dim: hasActivePath && !onActivePath(edge),
            }"
          />
          <circle
            :cx="edge.ex"
            :cy="edge.ey"
            r="3.5"
            class="edge-dot"
            :class="{ active: onActivePath(edge), dim: hasActivePath && !onActivePath(edge) }"
          />
        </g>
      </svg>

      <article
        v-for="node in graph.nodes"
        :key="node.id"
        :ref="cardRef"
        :data-node-id="node.id"
        class="turn"
        :class="{
          selected: node.id === selectedTurnId,
          running: store.running[node.sessionId],
          stub: node.kind === 'stub',
          dimmed: hasActivePath && !activePathIds.has(node.id),
        }"
        :style="{ left: `${node.x}px`, top: `${node.y}px`, width: `${NODE_WIDTH}px` }"
        @mousedown.stop
        @click="selectNode(node)"
      >
        <button
          type="button"
          class="del-chip"
          title="删除这个会话（整条分支故事）"
          @click.stop="removeNode(node)"
        >🗑</button>
        <button
          type="button"
          class="add-chip"
          :title="isSessionTip(node) ? '继续这个分支' : '从这里长出新分支'"
          @click.stop="openDraft(node)"
        >
          ＋
        </button>
        <template v-if="node.kind === 'turn'">
          <div class="turn-head">
            <span class="avatar user">🍑</span>
            <span class="turn-title" :title="node.title">{{ node.title }}</span>
            <span class="turn-time">{{ relativeTime(node.createdAt) }}</span>
          </div>
          <div class="turn-body">
            <span class="avatar bot">✨</span>
            <p class="turn-preview" :class="{ errored: !node.preview && node.error }">
              {{ previewOf(node) }}
            </p>
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
            <span v-else>{{ footMeta(node) }}</span>
            <span
              class="model"
              :title="node.modelIds.length > 1 ? node.modelIds.join('\n') : undefined"
            >{{ modelLabel(node.modelIds) }}</span>
          </div>
        </template>
        <template v-else>
          <div class="turn-head">
            <span class="avatar user">🌱</span>
            <span class="turn-title" :title="node.title">{{ node.title }}</span>
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
          <span class="draft-tag">🌱 草稿 · {{ store.draft?.atMessageId == null ? "继续分支" : "新分支" }}</span>
          <button type="button" class="close" @click="dismissDraft">✕</button>
        </div>
        <textarea
          :value="store.draft?.text"
          :placeholder="store.draft?.atMessageId == null ? '描述下一步…（发送后继续这个分支）' : '描述下一步…（发送后从这里长出新分支）'"
          @input="setDraftText(($event.target as HTMLTextAreaElement).value)"
          @keydown.meta.enter.prevent="submitDraft"
          @keydown.ctrl.enter.prevent="submitDraft"
        ></textarea>
        <div class="draft-foot">
          <span class="hint">⌘/Ctrl ⏎ 发送</span>
          <ModelPicker
            class="draft-model"
            :model-value="store.draft?.model ?? null"
            :models="store.models"
            title="用哪个模型跑这条分支"
            @update:model-value="setDraftModel"
          />
          <button
            type="button"
            class="send-btn"
            :disabled="!store.draft?.text.trim() || store.draftSending"
            @click="submitDraft"
          >{{ store.draftSending ? "…" : "➤" }}</button>
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

    <div
      v-if="showMinimap"
      ref="minimapEl"
      class="minimap"
      title="小地图 — 点击或拖拽移动视图"
      @mousedown.stop.prevent="onMinimapDown"
    >
      <div
        v-for="n in graph.nodes"
        :key="`mm-${n.id}`"
        class="mm-node"
        :class="{
          stub: n.kind === 'stub',
          on: activePathIds.has(n.id),
          running: Boolean(store.running[n.sessionId]),
        }"
        :style="mmNodeStyle(n)"
      ></div>
      <div class="mm-view" :style="mmViewStyle"></div>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { TurnNode } from "../../../shared/canvas-graph";
import { COL_GAP, NODE_HEIGHT, NODE_WIDTH, ROW_GAP } from "../../../shared/canvas-graph";
import { formatDuration, formatTokens } from "../format";
import {
  activeChain,
  cardHeights,
  deleteSession,
  dismissDraft,
  isSessionTip,
  openDraft,
  selectTurn,
  sendDraft,
  setDraftModel,
  setDraftText,
  store,
  turnGraph,
} from "../state";
import ModelPicker from "./model-picker.vue";

const viewportEl = ref<HTMLElement | null>(null);
const scale = ref(1);
const tx = ref(0);
const ty = ref(0);
const panning = ref(false);

const graph = computed(() => turnGraph.value);
const selectedTurnId = computed(() => store.selectedTurnId);

const worldStyle = computed(() => ({
  transform: `translate(${tx.value}px, ${ty.value}px) scale(${scale.value})`,
}));

const svgSize = computed(() => {
  const maxX = Math.max(0, ...graph.value.nodes.map((n) => n.x + NODE_WIDTH + 100));
  const maxY = Math.max(0, ...graph.value.nodes.map((n) => n.y + n.height + 100));
  return { w: maxX, h: maxY };
});

const nodeById = computed(() => new Map(graph.value.nodes.map((n) => [n.id, n])));

// ── active path: the selected turn's lineage back to the story's root ──
// Shared with the pane's context chain — state.activeChain is the source.

const activePathIds = computed(() => new Set(activeChain.value.map((n) => n.id)));

const hasActivePath = computed(() => activeChain.value.length > 0);

/** An edge is on the active path when both ends are on it (nodes have one incoming edge). */
function onActivePath(edge: { from: string; to: string }): boolean {
  const ids = activePathIds.value;
  return ids.has(edge.from) && ids.has(edge.to);
}

const edgesWithPoints = computed(() =>
  graph.value.edges.flatMap((edge) => {
    const from = nodeById.value.get(edge.from);
    const to = nodeById.value.get(edge.to);
    if (!from || !to) return [];
    const x1 = from.x + NODE_WIDTH;
    const y1 = from.y + from.height / 2;
    const x2 = to.x;
    const y2 = to.y + to.height / 2;
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
const draftY = computed(
  () => (draftNode.value?.y ?? 0) + (draftNode.value?.height ?? NODE_HEIGHT) + 40,
);

function selectNode(node: TurnNode): void {
  void selectTurn(node);
}

function submitDraft(): void {
  void sendDraft();
}

/** A card IS a session's turn: deleting it removes the whole branch story. */
function removeNode(node: TurnNode): void {
  const title = node.title || "空会话";
  const ok = window.confirm(
    `删除会话「${title}」？\n它的所有回合都会一起删除（从它分叉出的子分支会保留）。`,
  );
  if (!ok) return;
  void deleteSession(node.sessionId);
}

// ── draft model picker ──────────────────────────────────────────────
// ModelPicker emits a ModelChoice directly — no string encoding needed.

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
  const maxY = Math.max(...graph.value.nodes.map((n) => n.y + n.height));
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
  ty.value = rect.height / 2 - (node.y + node.height / 2) * scale.value;
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

watch(
  () => store.fitRequest,
  (nonce) => {
    if (nonce) fitView();
  },
);

// ── minimap ─────────────────────────────────────────────────────────

const MM_WIDTH = 176;
const MM_HEIGHT = 110;
const minimapEl = ref<HTMLElement | null>(null);
const viewportSize = ref({ w: 0, h: 0 });
let resizeObserver: ResizeObserver | null = null;

// ── card heights feed the layout ────────────────────────────────────
// ResizeObserver reports pre-transform layout size, so zoom doesn't skew
// measurements. Height depends only on content + fixed card width, never on
// the row a card lands in — measure → re-layout settles in one pass.
// Created in setup (not onMounted): template refs fire during mount, before
// mounted hooks run, so the observer must already exist to catch them.
const cardObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const card = entry.target as HTMLElement;
    const id = card.dataset.nodeId;
    if (!id) continue;
    const height = Math.round(entry.borderBoxSize?.[0]?.blockSize ?? card.offsetHeight);
    if (cardHeights[id] !== height) cardHeights[id] = height;
  }
});

/** Template ref for turn cards: observe them and record measured heights. */
function cardRef(el: unknown): void {
  const card = el as HTMLElement | null;
  if (card?.dataset.nodeId) cardObserver.observe(card);
}

onMounted(() => {
  resizeObserver = new ResizeObserver((entries) => {
    const rect = entries[0]?.contentRect;
    if (rect) viewportSize.value = { w: rect.width, h: rect.height };
  });
  if (viewportEl.value) resizeObserver.observe(viewportEl.value);
});
onUnmounted(() => {
  resizeObserver?.disconnect();
  cardObserver.disconnect();
});

// Drop measurements for nodes that left the graph (deleted sessions, project
// switches). Deleting may recompute the graph once; the next pass finds
// nothing to remove, so the loop settles.
watch(graph, (g) => {
  const live = new Set(g.nodes.map((n) => n.id));
  for (const id of Object.keys(cardHeights)) {
    if (!live.has(id)) delete cardHeights[id];
  }
});

const showMinimap = computed(() => graph.value.nodes.length > OVERVIEW_NODE_LIMIT);

const minimapGeometry = computed(() => {
  const nodes = graph.value.nodes;
  if (nodes.length === 0) return null;
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const worldW = Math.max(...nodes.map((n) => n.x + NODE_WIDTH)) - minX || 1;
  const worldH = Math.max(...nodes.map((n) => n.y + n.height)) - minY || 1;
  const s = Math.min(MM_WIDTH / worldW, MM_HEIGHT / worldH);
  return { minX, minY, s, offX: (MM_WIDTH - worldW * s) / 2, offY: (MM_HEIGHT - worldH * s) / 2 };
});

function mmNodeStyle(node: TurnNode): Record<string, string> {
  const g = minimapGeometry.value;
  if (!g) return { display: "none" };
  return {
    left: `${g.offX + (node.x - g.minX) * g.s}px`,
    top: `${g.offY + (node.y - g.minY) * g.s}px`,
    width: `${Math.max(3, NODE_WIDTH * g.s)}px`,
    height: `${Math.max(2, node.height * g.s)}px`,
  };
}

/** The viewport's current slice of world space, drawn on the minimap. */
const mmViewStyle = computed(() => {
  const g = minimapGeometry.value;
  const { w, h } = viewportSize.value;
  if (!g || w === 0 || h === 0) return { display: "none" };
  return {
    left: `${g.offX + (-tx.value / scale.value - g.minX) * g.s}px`,
    top: `${g.offY + (-ty.value / scale.value - g.minY) * g.s}px`,
    width: `${(w / scale.value) * g.s}px`,
    height: `${(h / scale.value) * g.s}px`,
  };
});

function minimapPan(event: MouseEvent): void {
  const g = minimapGeometry.value;
  const rect = minimapEl.value?.getBoundingClientRect();
  if (!g || !rect) return;
  const worldX = (event.clientX - rect.left - g.offX) / g.s + g.minX;
  const worldY = (event.clientY - rect.top - g.offY) / g.s + g.minY;
  const { w, h } = viewportSize.value;
  tx.value = w / 2 - worldX * scale.value;
  ty.value = h / 2 - worldY * scale.value;
}

function onMinimapDown(event: MouseEvent): void {
  if (event.button !== 0) return;
  minimapPan(event);
  const move = (moveEvent: MouseEvent): void => minimapPan(moveEvent);
  const up = (): void => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

// ── formatting ──────────────────────────────────────────────────────

/** Foot label: first model, "+N" when a turn mixed several; agent name when none reported. */
function modelLabel(models: string[]): string {
  const [first, ...rest] = models;
  if (!first) return "opencode";
  return rest.length === 0 ? first : `${first} +${rest.length}`;
}

/** Foot left side: tool count plus the run's wall time and output tokens when known. */
function footMeta(node: TurnNode): string {
  const bits = [node.toolNames.length > 0 ? `${node.toolNames.length} 个工具` : "无工具调用"];
  if (node.durationMs !== null) bits.push(formatDuration(node.durationMs));
  if (node.outputTokens > 0) bits.push(formatTokens(node.outputTokens));
  return bits.join(" · ");
}

/** Preview line: the live stream while the tip runs, else the reply / failure / stand-in. */
function previewOf(node: TurnNode): string {
  if (node.kind === "turn" && store.running[node.sessionId] && isSessionTip(node)) {
    const stream = store.streams[node.sessionId]?.trim();
    if (stream) return stream;
    return node.preview || "正在思考…";
  }
  return (
    node.preview ||
    (node.error
      ? `⚠ ${node.error}`
      : node.toolNames.length > 0
        ? "(工具调用，无文本回复)"
        : "(无文本回复)")
  );
}

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
