<template>
  <section class="message-list" ref="listEl">
    <slot name="context" />
    <article v-for="message in messages" :key="message.id" class="message" :class="message.role">
      <template v-if="message.role === 'user'">
        <div class="message-row user-row">
          <div class="user-body">
            <p class="message-text">{{ message.text }}</p>
            <p v-if="message.attachmentNames.length > 0" class="att-row">
              <span v-for="name in message.attachmentNames" :key="name" class="att-chip">
                📎 {{ name }}
              </span>
            </p>
          </div>
          <span class="avatar user">🍑</span>
        </div>
      </template>
      <template v-else>
        <div class="message-row">
          <span class="avatar bot">✨</span>
          <div class="message-body">
            <button
              v-if="message.text"
              type="button"
              class="msg-copy"
              :title="copiedId === message.id ? '已复制' : '复制这条回复'"
              @click="copyMessage(message)"
            >{{ copiedId === message.id ? "✓" : "⧉" }}</button>
            <p v-if="message.toolNames.length > 0" class="tool-row">
              <span v-for="name in message.toolNames" :key="name" class="tool-chip lav">{{
                name
              }}</span>
            </p>
            <details v-if="message.thinking" class="thought">
              <summary class="thought-toggle">Thought</summary>
              <div class="thought-body">{{ message.thinking }}</div>
            </details>
            <MarkdownView v-if="message.text" :source="message.text" />
            <p v-else-if="message.error" class="message-text run-error">
              ⚠ 运行失败：{{ message.error }}
            </p>
          </div>
        </div>
      </template>
    </article>
    <article v-if="running" class="message assistant">
      <div class="message-row">
        <span class="avatar bot">✨</span>
        <div class="message-body">
          <p class="tool-row"><span class="tool-chip running">running…</span></p>
          <details v-if="streamThinking" :open="!streamText" class="thought streaming-thought">
            <summary class="thought-toggle">Thinking…</summary>
            <div class="thought-body">{{ streamThinking }}<span class="stream-caret"></span></div>
          </details>
          <template v-if="streamText">
            <MarkdownView :source="streamText" class="stream" />
            <span class="stream-caret"></span>
          </template>
        </div>
      </div>
    </article>
  </section>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import type { SessionSummary } from "../../../shared/types";
import { isSamePaneStart, shouldFollowStream } from "../message-list-scroll";
import type { ReadonlyChatMessage } from "../state";
import { MarkdownView } from "./markdown-view";

const props = defineProps<{
  session: SessionSummary | null;
  messages: readonly ReadonlyChatMessage[];
  running: boolean;
  streamText: string;
  streamThinking: string;
  error: string | null;
}>();

const listEl = ref<HTMLElement | null>(null);

// Follow the stream only while the reader was at the bottom before the DOM
// changes. Once they scroll up to reread, every subsequent frame leaves their
// position alone.
watch(
  () => [props.messages.length, props.streamText, props.streamThinking],
  () => {
    const list = listEl.value;
    if (!list) return;
    const shouldFollow = shouldFollowStream(list.scrollHeight - list.scrollTop - list.clientHeight);
    if (!shouldFollow) return;
    void nextTick(() => {
      const current = listEl.value;
      if (current) current.scrollTo({ top: current.scrollHeight });
    });
  },
);

// Switching a turn or session starts at the top. A server refresh can replace
// an optimistic local prompt with its persisted counterpart; that is still the
// same pane view, so preserve the reader's scroll position.
let hasPreviousPane = false;
let previousSessionId: string | undefined;
let previousFirstMessage: ReadonlyChatMessage | undefined;
watch(
  () => [props.session?.id, props.messages[0]] as const,
  ([sessionId, firstMessage]) => {
    const shouldReset =
      !props.running &&
      (!hasPreviousPane ||
        sessionId !== previousSessionId ||
        !isSamePaneStart(previousFirstMessage, firstMessage));
    hasPreviousPane = true;
    previousSessionId = sessionId;
    previousFirstMessage = firstMessage;
    if (!shouldReset) return;
    void nextTick(() => {
      listEl.value?.scrollTo({ top: 0 });
    });
  },
);

const copiedId = ref<string | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

async function copyMessage(message: ReadonlyChatMessage): Promise<void> {
  try {
    await navigator.clipboard.writeText(message.text);
    copiedId.value = message.id;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copiedId.value = null;
    }, 1500);
  } catch {
    // Clipboard denied — the text is still selectable; nothing to recover to.
  }
}
</script>
