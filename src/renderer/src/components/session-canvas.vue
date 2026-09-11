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
        <path v-if="draftEdge" :d="draftEdge.path" class="edge draft-edge" />
      </svg>

      <article
        v-for="node in graph.nodes"
        :key="node.id"
        :ref="cardRef"
        :data-node-id="node.id"
        class="turn"
        :class="{
          selected: node.id === selectedTurnId,
          running: isNodeRunning(node),
          recent: isNodeRecent(node),
          stub: node.kind === 'stub',
          dimmed: hasActivePath && !activePathIds.has(node.id),
          hit: searchHitIds.has(node.id),
        }"
        :style="{
          left: `${node.x}px`,
          top: `${node.y}px`,
          width: `${NODE_WIDTH}px`,
          '--recent-alpha': recentAlpha(node),
        }"
        @mousedown.stop
        @click="selectNode(node)"
      >
        <button
          type="button"
          class="del-chip"
          :title="isTurnDelete(node) ? '删除这个回合（更早的对话保留）' : '删除这个会话（整条分支故事）'"
          @click.stop="removeNode(node)"
        >🗑</button>
        <button
          v-if="node.kind === 'turn' && node.error"
          type="button"
          class="retry-chip"
          title="重跑这个回合（预填原文，可先换模型/档位）"
          @click.stop="retryNode(node)"
        >↻</button>
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
            <span
              class="turn-time"
              :class="{ recent: isNodeRecent(node) }"
            >{{ relativeTime(node.createdAt) }}</span>
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
            <span v-if="isNodeRunning(node)" class="running-flag">○ 运行中…</span>
            <span v-else>{{ footMeta(node) }}</span>
            <span
              class="model"
              :title="modelTitle(node)"
            >{{ modelChip(node) }}</span>
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
        :ref="draftRef"
        class="draft"
        :style="{ left: `${draftX}px`, top: `${draftY}px` }"
        @mousedown.stop
      >
        <div class="draft-head">
          <span class="draft-tag">🌱 草稿 · {{ store.draft?.atMessageId == null ? "继续分支" : "新分支" }}</span>
          <button type="button" class="close" @click="dismissDraft">✕</button>
        </div>
        <div v-if="(store.draft?.attachments.length ?? 0) > 0" class="draft-atts">
          <span v-for="a in store.draft?.attachments ?? []" :key="a.id" class="att-chip">
            <img
              v-if="a.mime.startsWith('image/')"
              :src="a.dataUrl"
              class="att-thumb"
              alt=""
            />
            <span v-else class="att-ico">📎</span>
            <span class="att-name" :title="a.name">{{ a.name }}</span>
            <button
              type="button"
              class="att-x"
              title="移除"
              @click="removeDraftAttachment(a.id)"
            >✕</button>
          </span>
        </div>
        <textarea
          :value="store.draft?.text"
          :placeholder="store.draft?.atMessageId == null ? '描述下一步…（发送后继续这个分支）' : '描述下一步…（发送后从这里长出新分支）'"
          @input="setDraftText(($event.target as HTMLTextAreaElement).value)"
          @keydown.meta.enter.prevent="submitDraft"
          @keydown.ctrl.enter.prevent="submitDraft"
          @keydown.esc="onDraftEsc"
          @paste="onDraftPaste"
        ></textarea>
        <div class="draft-foot">
          <span class="hint">⌘/Ctrl ⏎ 发送 · Esc 收起</span>
          <ModelPicker
            class="draft-model"
            :model-value="store.draft?.model ?? null"
            :models="store.models"
            title="用哪个模型跑这条分支"
            @update:model-value="setDraftModel"
          />
          <VariantPicker
            :model="store.draft?.model ?? null"
            :models="store.models"
            @select="setDraftVariant"
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

    <div v-if="graph.nodes.length === 0 && store.connectionError" class="canvas-empty">
      <div class="empty-mascot">🔌</div>
      <p class="empty-title">opencode 未连接</p>
      <p class="empty-sub">连接恢复后，点左侧「↻ 刷新」重新加载会话</p>
    </div>
    <div
      v-else-if="graph.nodes.length === 0 && !store.booted && !store.loadingMessages"
      class="canvas-loading"
    >正在连接 opencode…</div>
    <div v-else-if="graph.nodes.length === 0 && !store.loadingMessages" class="canvas-empty">
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

    <!-- Search & digest overlays: mousedown/wheel stay inside them so pans and
         zooms never fire while the user works the lists. -->
    <div class="canvas-panels" @mousedown.stop @wheel.stop>
      <StorySearch @jump="centerOnNode" />
      <BranchDigest @jump="centerOnNode" />
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
          running: isNodeRunning(n),
          recent: isNodeRecent(n),
          hit: searchHitIds.has(n.id),
        }"
        :style="{ ...mmNodeStyle(n), '--recent-alpha': recentAlpha(n) }"
      ></div>
      <div class="mm-view" :style="mmViewStyle"></div>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { fileKind } from "../../../shared/attachment-kinds";
import type { TurnNode } from "../../../shared/canvas-graph";
import { draftCellFor, NODE_WIDTH } from "../../../shared/canvas-graph";
import { type DraftAttachment, readAttachments } from "../attachments";
import { formatDuration, formatTokens } from "../format";
import {
  activeChain,
  cardHeights,
  deleteSession,
  deleteTurn,
  dismissDraft,
  isSessionTip,
  isTurnDelete,
  openDraft,
  recentAlphaFor,
  retryNode,
  selectTurn,
  sendDraft,
  setDraftAttachments,
  setDraftModel,
  setDraftText,
  setDraftVariant,
  store,
  storySearchHits,
  turnGraph,
} from "../state";
import BranchDigest from "./branch-digest.vue";
import ModelPicker from "./model-picker.vue";
import StorySearch from "./story-search.vue";
import VariantPicker from "./variant-picker.vue";

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

/** Story-search matches: while a query is live, every hit card gets a ring. */
const searchHitIds = computed(() => new Set(storySearchHits.value.map((h) => h.nodeId)));

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
// The draft floats in the branch's next free cell — the exact spot the sent
// turn's card will take — so the composer reads as the story's next card.
const draftCell = computed(() => {
  const anchor = draftNode.value;
  if (!anchor || !store.draft) return null;
  return draftCellFor(anchor, store.draft.atMessageId, graph.value.nodes);
});
const draftX = computed(() => draftCell.value?.x ?? 0);
const draftY = computed(() => draftCell.value?.y ?? 0);

// Measured draft height keeps the connector pinned to the box's left edge
// (attachment chips grow the box; the textarea inside is fixed).
const draftBoxHeight = ref(220);
let observedDraft: HTMLElement | null = null;
const draftObserver = new ResizeObserver((entries) => {
  const height = entries[0]?.borderBoxSize?.[0]?.blockSize;
  if (height) draftBoxHeight.value = Math.round(height);
});
/** Template ref for the draft box: move the observer to the live element. */
function draftRef(el: unknown): void {
  const box = el as HTMLElement | null;
  if (observedDraft && observedDraft !== box) draftObserver.unobserve(observedDraft);
  observedDraft = box;
  if (box) {
    draftBoxHeight.value = box.offsetHeight || 220;
    draftObserver.observe(box);
  }
}

/** Connector from the anchor card into the draft — the same bezier the tree
 *  edges use, dashed (see .edge.draft-edge) because the turn isn't sent yet. */
const draftEdge = computed(() => {
  const anchor = draftNode.value;
  if (!anchor) return null;
  const x1 = anchor.x + NODE_WIDTH;
  const y1 = anchor.y + anchor.height / 2;
  const x2 = draftX.value;
  const y2 = draftY.value + draftBoxHeight.value / 2;
  const bend = Math.max(46, (x2 - x1) / 2);
  return { path: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}` };
});

function selectNode(node: TurnNode): void {
  void selectTurn(node);
}

function submitDraft(): void {
  void sendDraft();
}

/** Esc closes the draft — except while an IME composition owns the key. */
function onDraftEsc(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return;
  dismissDraft();
}

/**
 * 🗑 deletes one turn at the session's tip, the whole session everywhere
 * else. Turn deletes are final — confirm stands. Session deletes ride the
 * undo toast, so they go straight through.
 */
function removeNode(node: TurnNode): void {
  if (isTurnDelete(node)) {
    const ok = window.confirm(
      `删除回合「${node.title}」？\n只删除这一问一答，更早的对话保留。此操作不可撤销。`,
    );
    if (ok) void deleteTurn(node);
    return;
  }
  void deleteSession(node.sessionId);
}

// ── draft model picker ──────────────────────────────────────────────
// ModelPicker emits a ModelChoice directly — no string encoding needed.

// ── pan / zoom / fit ────────────────────────────────────────────────

// The in-flight drag's window listeners (canvas pan or minimap); only one
// pointer drag can be live at a time, and an unmount mid-drag must drop them.
let activeDrag: { move: (event: MouseEvent) => void; up: () => void } | null = null;

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
    activeDrag = null;
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
  activeDrag = { move, up };
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
  const node = nodesOf(sessionId)[nodesOf(sessionId).length - 1];
  if (node) centerOnNode(node);
}

/** Search hits and digest rows land here: put one node in the middle of view. */
function centerOnNode(node: TurnNode): void {
  const rect = viewportEl.value?.getBoundingClientRect();
  if (!rect) return;
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
// A context-chain jump still waiting for its node to land on the canvas — the
// branch switch can be loading messages / re-laying-out the graph.
let pendingJump: string | null = null;
// fitView() as the initial overview leaves centeredFor null — remember it ran,
// so later graph changes (a branch switch reshaping the canvas) never re-fit
// and flash the whole-graph view before a jump lands.
let overviewShown = false;

function nodesOf(sessionId: string | null): TurnNode[] {
  if (!sessionId) return [];
  return graph.value.nodes.filter((n) => n.sessionId === sessionId);
}

function openInitialView(): void {
  if (graph.value.nodes.length === 0) return;
  if (graph.value.nodes.length <= OVERVIEW_NODE_LIMIT) {
    fitView();
    overviewShown = true;
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

/** Center on the pending chain jump once its node exists; false = still waiting. */
function resolvePendingJump(): boolean {
  if (!pendingJump) return true;
  const node = nodeById.value.get(pendingJump);
  if (!node) return false;
  centerOnNode(node);
  pendingJump = null;
  return true;
}

watch(graph, () => {
  // Wait for the directory's message batch to finish — every merge re-lays
  // out the whole graph, so centering mid-load lands on a stale position.
  if (store.loadingMessages) return;
  if (pendingJump) {
    resolvePendingJump();
    return;
  }
  if (pendingFocus) {
    if (nodesOf(pendingFocus).length > 0) focusNow(pendingFocus);
    return;
  }
  if (centeredFor === null && !overviewShown) openInitialView();
});
watch(
  () => store.loadingMessages,
  (loading, was) => {
    if (!was || loading) return;
    // The last merge's graph pass ran while still loading — finish a pending
    // chain jump here, or the view would wait on a graph change that never comes.
    if (!resolvePendingJump()) return;
    if (centeredFor === null && pendingFocus === null && !overviewShown) {
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

// Context-chain cards land here: center the view on the picked turn. Right
// after a branch switch the node can still be missing (messages loading,
// layout not settled) — stash it and jump on the first graph pass that has it.
watch(
  () => store.turnJumpRequest,
  (request) => {
    if (!request) return;
    pendingJump = request.nodeId;
    resolvePendingJump();
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
  draftObserver.disconnect();
  if (activeDrag) {
    window.removeEventListener("mousemove", activeDrag.move);
    window.removeEventListener("mouseup", activeDrag.up);
  }
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

const showMinimap = computed(() => graph.value.nodes.length > 0);

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
    activeDrag = null;
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
  activeDrag = { move, up };
}

// ── formatting ──────────────────────────────────────────────────────

/** Foot label: first model, "+N" when a turn mixed several; agent name when none reported. */
function modelLabel(models: string[]): string {
  const [first, ...rest] = models;
  if (!first) return "opencode";
  return rest.length === 0 ? first : `${first} +${rest.length}`;
}

/** Foot model chip: the label plus the run's effort variant (e.g. "glm-5.3 · high"). */
function modelChip(node: TurnNode): string {
  const base = modelLabel(node.modelIds);
  return node.model?.variant ? `${base} · ${node.model.variant}` : base;
}

function modelTitle(node: TurnNode): string | undefined {
  const ids = node.modelIds.join("\n");
  return node.modelIds.length > 1 ? ids : ids || undefined;
}

// ── draft composer attachments ──────────────────────────────────────

function draftAttachments(): readonly DraftAttachment[] {
  return store.draft?.attachments ?? [];
}

function onDraftPaste(event: ClipboardEvent): void {
  const files = event.clipboardData?.files;
  if (!files || files.length === 0) return;
  // Backend gate first: codex takes no attachments at all, and a staged chip
  // would silently not ship with the prompt.
  if (!store.capabilities.attachments) {
    event.preventDefault();
    return;
  }
  let list = [...files];
  const model = store.draft?.model ?? null;
  if (model) {
    const option = store.models.find(
      (m) => m.providerId === model.providerId && m.modelId === model.modelId,
    );
    // Text attachments need no media capability; only images are gated.
    if (option && !option.attachment) list = list.filter((f) => !f.type.startsWith("image/"));
  }
  list = list.filter((f) => fileKind(f) !== "unsupported");
  if (list.length === 0) return;
  event.preventDefault();
  void readAttachments(list).then(({ staged }) => {
    setDraftAttachments([...draftAttachments(), ...staged]);
  });
}

function removeDraftAttachment(id: string): void {
  setDraftAttachments(draftAttachments().filter((a) => a.id !== id));
}

/** Foot left side: tool count plus the run's wall time and output tokens when known. */
function footMeta(node: TurnNode): string {
  const bits = [node.toolNames.length > 0 ? `${node.toolNames.length} 个工具` : "无工具调用"];
  if (node.durationMs !== null) bits.push(formatDuration(node.durationMs));
  if (node.outputTokens > 0) bits.push(formatTokens(node.outputTokens));
  return bits.join(" · ");
}

/**
 * Running is tracked per SESSION, but only the tip card is the run in
 * progress — lighting every past turn of the session too made finished
 * cards look stuck at 运行中 while a later turn streams.
 */
function isNodeRunning(node: TurnNode): boolean {
  return Boolean(store.running[node.sessionId]) && isSessionTip(node);
}

/**
 * The "刚跑完" tint rides the same tip-only rule as running: one card per
 * session at most, and it yields as soon as a newer run takes the tip.
 */
function isNodeRecent(node: TurnNode): boolean {
  return node.kind === "turn" && isSessionTip(node) && recentAlphaFor(node.sessionId) > 0;
}

/** Fade driver for the CSS var — 1 right after settle, 0 five minutes later. */
function recentAlpha(node: TurnNode): number {
  return isSessionTip(node) ? recentAlphaFor(node.sessionId) : 0;
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
