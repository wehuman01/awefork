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

    <ChatInput v-if="selectedSession" :running="isRunning" @send="send" @abort="abort" />
  </aside>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { abortRun, paneMessages, paneTurn, selectedSession, sendPanePrompt, store } from "../state";
import ChatInput from "./chat-input.vue";
import MessageList from "./message-list.vue";

const isRunning = computed(() => {
  const id = store.selectedId;
  return id != null && Boolean(store.running[id]);
});

const turnMeta = computed(() => {
  const pane = paneTurn.value;
  return pane ? `回合 ${pane.index + 1}/${pane.total}` : null;
});

function send(text: string): void {
  void sendPanePrompt(text);
}

function abort(): void {
  void abortRun();
}
</script>
