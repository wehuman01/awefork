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
      :error="null"
    />
    <div v-else class="ctx-empty">
      <p>左侧选会话，或在画布上点一张卡片。</p>
    </div>

    <ChatInput
      v-if="selectedSession"
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
import { computed, onMounted, onUnmounted } from "vue";
import type { ModelChoice } from "../../../shared/types";
import { formatDuration, formatTokens } from "../format";
import {
  abortRun,
  cloneSelectedSession,
  paneMessages,
  paneTurn,
  selectedSession,
  sendPanePrompt,
  setPaneModel,
  stepTurn,
  store,
} from "../state";
import ChatInput from "./chat-input.vue";
import MessageList from "./message-list.vue";

const pane = computed(() => paneTurn.value);

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

function send(text: string): void {
  void sendPanePrompt(text);
}

function abort(): void {
  void abortRun();
}

function cloneBranch(): void {
  void cloneSelectedSession();
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
