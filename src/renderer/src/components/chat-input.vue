<template>
  <form class="chat-input" @submit.prevent="submit">
    <textarea
      v-model="text"
      :placeholder="running ? 'Agent is running…' : '继续这条分支…'"
      :disabled="running"
      rows="2"
      @keydown.enter.exact.prevent="submit"
    ></textarea>
    <div class="chat-input-foot">
      <span class="hint">⏎ 发送</span>
      <button v-if="!running" type="submit" class="send" :disabled="!text.trim()">发送 ➤</button>
      <button v-else type="button" class="abort" @click="$emit('abort')">■ 停止</button>
    </div>
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
