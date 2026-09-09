<template>
  <aside class="context">
    <div class="ctx-head">
      <span class="ctx-icon">💬</span>
      <div class="ctx-headings">
        <div class="ctx-title">分支上下文</div>
        <div class="ctx-sub" :title="selectedSession?.title ?? ''">
          <template v-if="turnMeta">{{ turnMeta }} · </template>{{ selectedSession?.title || "在画布上选一个节点" }}
        </div>
      </div>
      <div class="ctx-nav">
        <button
          v-if="pane?.turn.error"
          type="button"
          class="nav-btn"
          title="重跑这个回合（预填原文，可先换模型/档位）"
          @click="retry"
        >↻</button>
        <button
          type="button"
          class="nav-btn"
          title="克隆当前分支（从最新状态存一个 checkpoint）"
          :disabled="!selectedSession || isRunning"
          @click="cloneBranch"
        >⎇</button>
        <template v-if="pane">
          <button
            type="button"
            class="nav-btn"
            title="上一回合（←）"
            :disabled="pane.index === 0"
            @click="stepTurn(-1)"
          >‹</button>
          <button
            type="button"
            class="nav-btn"
            title="下一回合（→）"
            :disabled="pane.index === pane.total - 1"
            @click="stepTurn(1)"
          >›</button>
        </template>
      </div>
      <span v-if="isRunning" class="ctx-running">○ 运行中</span>
    </div>

    <div v-if="store.messagesError" class="banner banner-error">{{ store.messagesError }}</div>

    <MessageList
      v-if="selectedSession"
      :session="selectedSession"
      :messages="paneMessages"
      :running="isRunning"
      :stream-text="store.streamText"
      :stream-thinking="store.streamThinking"
      :error="null"
    >
      <template v-if="contextTurns.length > 0 || omittedCount > 0" #context>
        <div class="chain">
          <div class="chain-label">上文链路</div>
          <p v-if="omittedCount > 0" class="chain-omitted">…更早 {{ omittedCount }} 个回合</p>
          <button
            v-for="(node, i) in contextTurns"
            :key="node.id"
            type="button"
            class="chain-card"
            title="跳到这个回合"
            @click="jumpTo(node)"
          >
            <span class="chain-step">{{ chainStart + i }}</span>
            <span class="chain-body">
              <span class="chain-title">
                <span
                  v-if="node.sessionId !== store.selectedId"
                  class="chain-fork"
                  title="来自上游分支"
                >⎇</span>
                {{ node.title }}
              </span>
              <span class="chain-preview">{{
                node.preview ||
                  (node.error
                    ? `⚠ ${node.error}`
                    : node.toolNames.length > 0
                      ? `(${node.toolNames.length} 个工具调用，无文本回复)`
                      : "(无文本回复)")
              }}</span>
            </span>
          </button>
        </div>
      </template>
    </MessageList>
    <div v-else class="ctx-empty">
      <p>左侧选会话，或在画布上点一张卡片。</p>
    </div>

    <ChatInput
      v-if="selectedSession"
      ref="chatInputEl"
      :running="isRunning"
      :model="paneModel"
      :models="store.models"
      @send="send"
      @abort="abort"
      @set-model="onSetModel"
    />
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import type { TurnNode } from "../../../shared/canvas-graph";
import type { ModelChoice, PromptAttachment } from "../../../shared/types";
import { formatDuration, formatTokens } from "../format";
import {
  abortRun,
  activeChain,
  cloneSelectedSession,
  paneMessages,
  paneTurn,
  retryTurn,
  selectedSession,
  selectTurn,
  sendPanePrompt,
  setPaneModel,
  stepTurn,
  store,
} from "../state";
import ChatInput from "./chat-input.vue";
import MessageList from "./message-list.vue";

const pane = computed(() => paneTurn.value);

const chatInputEl = ref<{ focus: () => void } | null>(null);
// 新增对话 landed: the fresh session is selected and mounted by now — put the
// caret in the pane composer so its first prompt starts with a keystroke.
watch(
  () => store.composerFocusRequest,
  (nonce) => {
    if (nonce === null) return;
    void nextTick(() => chatInputEl.value?.focus());
  },
);

// ── context chain: the turns before the pane's current one ──────────

/** Keep the pane readable: at most this many ancestor cards, oldest dropped. */
const MAX_CONTEXT = 12;

const omittedCount = computed(() => Math.max(0, activeChain.value.length - 1 - MAX_CONTEXT));
const contextTurns = computed(() => activeChain.value.slice(0, -1).slice(-MAX_CONTEXT));
const chainStart = computed(() => omittedCount.value + 1);

function jumpTo(node: TurnNode): void {
  void selectTurn(node);
}

const isRunning = computed(() => {
  const id = store.selectedId;
  return id != null && Boolean(store.running[id]);
});

const turnMeta = computed(() => {
  const current = pane.value;
  if (!current) return null;
  const bits = [`回合 ${current.index + 1}/${current.total}`];
  if (current.turn.durationMs !== null) bits.push(formatDuration(current.turn.durationMs));
  if (current.turn.outputTokens > 0) bits.push(formatTokens(current.turn.outputTokens));
  return bits.join(" · ");
});

function send(text: string, attachments: PromptAttachment[]): void {
  void sendPanePrompt(text, attachments);
}

function abort(): void {
  void abortRun();
}

function cloneBranch(): void {
  void cloneSelectedSession();
}

function retry(): void {
  const current = pane.value;
  if (current) retryTurn(current.turn);
}

const paneModel = computed(() =>
  store.selectedId ? (store.paneModels[store.selectedId] ?? null) : null,
);

function onSetModel(model: ModelChoice | null): void {
  if (store.selectedId) setPaneModel(store.selectedId, model);
}

// ←/→ walk turns without leaving the pane — but never while typing somewhere.
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const target = event.target as HTMLElement | null;
  if (
    target &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
  ) {
    return;
  }
  if (!pane.value) return;
  event.preventDefault();
  stepTurn(event.key === "ArrowLeft" ? -1 : 1);
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => window.removeEventListener("keydown", onKeydown));
</script>
