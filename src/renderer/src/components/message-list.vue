<template>
  <section class="message-list" ref="listEl">
    <div v-if="error" class="banner banner-error">{{ error }}</div>
    <article v-for="message in messages" :key="message.id" class="message" :class="message.role">
      <template v-if="message.role === 'user'">
        <div class="message-body user-body">
          <p class="message-text">{{ message.text }}</p>
          <button type="button" class="fork-button" title="Fork a new branch after this turn" @click="$emit('fork', message.id)">⎇ fork here</button>
        </div>
      </template>
      <template v-else>
        <div class="message-body">
          <p v-if="message.toolNames.length > 0" class="tool-row">
            <span v-for="name in message.toolNames" :key="name" class="tool-chip">{{ name }}</span>
          </p>
          <p class="message-text pre-wrap">{{ message.text || "(no text output)" }}</p>
        </div>
      </template>
    </article>
    <article v-if="running" class="message assistant">
      <div class="message-body">
        <p class="tool-row"><span class="tool-chip running">running…</span></p>
        <p v-if="streamText" class="message-text pre-wrap stream">{{ streamText }}</p>
      </div>
    </article>
  </section>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import type { SessionSummary } from "../../../shared/types";
import type { ReadonlyChatMessage } from "../state";

const props = defineProps<{
  session: SessionSummary | null;
  messages: readonly ReadonlyChatMessage[];
  running: boolean;
  streamText: string;
  error: string | null;
}>();

defineEmits<{ fork: [messageId: string] }>();

const listEl = ref<HTMLElement | null>(null);

watch(
  () => [props.messages.length, props.streamText],
  () => {
    void nextTick(() => {
      listEl.value?.scrollTo({ top: listEl.value.scrollHeight });
    });
  },
);
</script>
