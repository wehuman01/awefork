<template>
  <section class="message-list" ref="listEl">
    <slot name="context" />
    <article v-for="message in messages" :key="message.id" class="message" :class="message.role">
      <template v-if="message.role === 'user'">
        <div class="message-row user-row">
          <div class="user-body">
            <p class="message-text">{{ message.text }}</p>
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
import type { ReadonlyChatMessage } from "../state";
import { MarkdownView } from "./markdown-view";

const props = defineProps<{
  session: SessionSummary | null;
  messages: readonly ReadonlyChatMessage[];
  running: boolean;
  streamText: string;
  error: string | null;
}>();

const listEl = ref<HTMLElement | null>(null);

// Follow the stream only while the reader sits at the bottom; scrolling up
// to reread must survive the next streamed frame. Measured pre-render, so
// "near the bottom" means near the bottom of what the reader last saw.
const STICK_DISTANCE_PX = 40;

watch(
  () => [props.messages.length, props.streamText],
  () => {
    const list = listEl.value;
    if (!list) return;
    if (list.scrollHeight - list.scrollTop - list.clientHeight > STICK_DISTANCE_PX) return;
    void nextTick(() => {
      listEl.value?.scrollTo({ top: listEl.value.scrollHeight });
    });
  },
);

// Jumping to another turn (or session) swaps the whole list's content; the
// old scroll position is meaningless there, so the pane starts back at the
// top. Keyed on the first row's id: appending a prompt keeps it stable, so
// the stick-to-bottom logic above still owns in-place growth.
watch(
  () => [props.session?.id, props.messages[0]?.id],
  () => {
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
}
