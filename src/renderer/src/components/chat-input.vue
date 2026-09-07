<template>
  <form class="chat-input" @submit.prevent="submit">
    <textarea
      v-model="text"
      :placeholder="inputPlaceholder"
      :disabled="running"
      rows="2"
      @keydown.enter.exact.prevent="submit"
    ></textarea>
    <div class="chat-input-foot">
      <ModelPicker
        :model-value="model"
        :models="models"
        title="用哪个模型继续这条分支"
        @update:model-value="(choice) => emit('set-model', choice)"
      />
      <span class="hint">⏎ 发送</span>
      <button v-if="!running" type="submit" class="send" :disabled="!text.trim()">发送 ➤</button>
      <button v-else type="button" class="abort" @click="$emit('abort')">■ 停止</button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { ModelChoice, ModelOption } from "../../../shared/types";
import ModelPicker from "./model-picker.vue";

const props = defineProps<{
  running: boolean;
  model: ModelChoice | null;
  models: readonly ModelOption[];
}>();
const emit = defineEmits<{
  send: [text: string];
  abort: [];
  "set-model": [model: ModelChoice | null];
}>();

const text = ref("");

const inputPlaceholder = computed(() => {
  if (props.running) return "Agent is running…";
  return "继续这条分支…";
});

function submit(): void {
  const value = text.value.trim();
  if (!value || props.running) return;
  emit("send", value);
  text.value = "";
}
</script>
