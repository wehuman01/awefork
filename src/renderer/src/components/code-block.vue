<template>
  <div class="md-codeblock">
    <div class="md-cb-bar">
      <span class="md-cb-lang">{{ lang || "text" }}</span>
      <button type="button" class="md-cb-copy" :class="{ ok: copied }" @click="copy">
        {{ copied ? "✓ 已复制" : "⧉ 复制" }}
      </button>
    </div>
    <pre><code>{{ code }}</code></pre>
  </div>
</template>

<script setup lang="ts">
import { onUnmounted, ref } from "vue";

const props = defineProps<{
  lang: string;
  code: string;
}>();

const copied = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.code);
    copied.value = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch {
    // Clipboard denied — the text is still selectable; nothing to recover to.
  }
}

// A streaming reply swaps code blocks wholesale; drop the pending reset so
// the timer can't flip `copied` on a block that no longer exists.
onUnmounted(() => {
  if (timer) clearTimeout(timer);
});
</script>
