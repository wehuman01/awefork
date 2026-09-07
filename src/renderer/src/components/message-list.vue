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
            <p v-if="message.toolNames.length > 0 || message.modelId" class="tool-row">
              <span v-if="message.modelId" class="tool-chip model">{{ message.modelId }}</span>
              <span v-for="(name, i) in message.toolNames" :key="name" class="tool-chip" :class="{ lav: i % 2 === 1 }">{{ name }}</span>
            </p>
            <p v-if="message.text" class="message-text pre-wrap">{{ message.text }}</p>
          </div>
        </div>
      </template>
    </article>
    <article v-if="running" class="message assistant">
      <div class="message-row">
        <span class="avatar bot">✨</span>
        <div class="message-body">
          <p class="tool-row"><span class="tool-chip running">running…</span></p>
          <p v-if="streamText" class="message-text pre-wrap stream">{{ streamText }}</p>
        </div>
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
