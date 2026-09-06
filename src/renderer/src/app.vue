<template>
  <div class="app">
    <aside class="sidebar">
      <header class="sidebar-header">
        <span class="brand">awefork</span>
        <span class="brand-sub">opencode sessions</span>
      </header>
      <SessionTree :groups="sessionGroups" :selected-id="store.selectedId" @select="selectSession" />
    </aside>
    <main class="content">
      <div v-if="store.connectionError" class="banner banner-error">
        {{ store.connectionError }}
      </div>
      <MessageList
        v-if="store.selectedId"
        :session="selectedSession"
        :messages="store.messages"
        :running="store.running"
        :stream-text="store.streamText"
        :error="store.messagesError"
        @fork="forkAtMessage"
      />
      <div v-else-if="!store.connectionError" class="empty">Select a session</div>
      <ChatInput
        v-if="store.selectedId"
        :running="store.running"
        @send="sendPrompt"
        @abort="abortRun"
      />
      <div v-if="store.actionError" class="banner banner-error" @click="dismissActionError">
        {{ store.actionError }} (click to dismiss)
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from "vue";
import ChatInput from "./components/chat-input.vue";
import MessageList from "./components/message-list.vue";
import SessionTree from "./components/session-tree.vue";
import {
  abortRun,
  dismissActionError,
  forkAtMessage,
  init,
  selectedSession,
  selectSession,
  sendPrompt,
  sessionGroups,
  store,
} from "./state";

onMounted(() => {
  void init();
});
</script>
