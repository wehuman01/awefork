<template>
  <aside class="context">
    <div class="ctx-head">
      <span class="ctx-icon">💬</span>
      <div class="ctx-headings">
        <div class="ctx-title">分支上下文</div>
        <div class="ctx-sub" :title="selectedSession?.title ?? ''">
          {{ selectedSession?.title || "在画布上选一个节点" }}
        </div>
      </div>
      <span v-if="isRunning" class="ctx-running">○ 运行中</span>
    </div>

    <div v-if="store.messagesError" class="banner banner-error">{{ store.messagesError }}</div>

    <MessageList
      v-if="selectedSession"
      :session="selectedSession"
      :messages="selectedMessages"
      :running="isRunning"
      :stream-text="store.streamText"
      :error="null"
      @fork="forkAt"
    />
    <div v-else class="ctx-empty">
      <p>左侧选会话，或在画布上点一张卡片。</p>
    </div>

    <ChatInput
      v-if="selectedSession"
      :running="isRunning"
      @send="send"
      @abort="abort"
    />
  </aside>
</template>

<script setup lang="ts">
import { computed } from "vue";
import {
  abortRun,
  forkAtMessage,
  selectedMessages,
  selectedSession,
  sendPrompt,
  store,
} from "../state";
import ChatInput from "./chat-input.vue";
import MessageList from "./message-list.vue";

const isRunning = computed(() => {
  const id = store.selectedId;
  return id != null && Boolean(store.running[id]);
});

function forkAt(messageId: string): void {
  void forkAtMessage(messageId);
}

function send(text: string): void {
  void sendPrompt(text);
}

function abort(): void {
  void abortRun();
}
</script>
