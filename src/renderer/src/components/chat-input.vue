<template>
  <form class="chat-input" @submit.prevent="submit">
    <textarea
      v-model="text"
      :placeholder="running ? 'Agent is running…' : 'Continue this branch…'"
      :disabled="running"
      rows="3"
      @keydown.enter.exact.prevent="submit"
    ></textarea>
    <button v-if="!running" type="submit" :disabled="!text.trim()">Send</button>
    <button v-else type="button" class="abort" @click="$emit('abort')">Stop</button>
  </form>
</template>

<script setup lang="ts">
import { ref } from "vue";

const props = defineProps<{ running: boolean }>();
const emit = defineEmits<{ send: [text: string]; abort: [] }>();

const text = ref("");

function submit(): void {
  const value = text.value.trim();
  if (!value || props.running) return;
  emit("send", value);
  text.value = "";
}
</script>
