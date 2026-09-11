<template>
  <div v-if="request" class="interaction-backdrop" role="presentation">
    <section class="interaction-dialog" role="dialog" aria-modal="true" :aria-label="request.title">
      <p class="interaction-kicker">Codex 正在等待你的决定</p>
      <h2>{{ request.title }}</h2>
      <p v-if="request.detail" class="interaction-detail">{{ request.detail }}</p>

      <template v-if="request.kind === 'command-approval'">
        <pre class="interaction-command">{{ request.command }}</pre>
        <p v-if="request.cwd" class="interaction-meta">运行目录：{{ request.cwd }}</p>
      </template>
      <template v-else-if="request.kind === 'file-approval'">
        <p v-if="request.grantRoot" class="interaction-meta">请求写入：{{ request.grantRoot }}</p>
      </template>
      <template v-else-if="request.kind === 'permission-approval'">
        <ul class="interaction-list"><li v-for="item in request.requested" :key="item">{{ item }}</li></ul>
      </template>
      <template v-else-if="request.kind === 'mcp-elicitation'">
        <p class="interaction-meta">服务：{{ request.serverName }}</p>
      </template>
      <template v-else-if="request.kind === 'user-input'">
        <label v-for="question in request.questions" :key="question.id" class="interaction-question">
          <b>{{ question.header }}</b>
          <span>{{ question.question }}</span>
          <select v-if="question.options?.length" v-model="answers[question.id]">
            <option disabled value="">请选择</option>
            <option v-for="option in question.options" :key="option.label" :value="option.label">{{ option.label }}</option>
          </select>
          <input v-else v-model="answers[question.id]" :type="question.isSecret ? 'password' : 'text'" />
        </label>
      </template>

      <div class="interaction-actions">
        <button type="button" class="interaction-deny" @click="deny">拒绝</button>
        <button v-if="request.kind === 'user-input'" type="button" class="interaction-allow" @click="submitAnswers">提交</button>
        <button v-else type="button" class="interaction-allow" @click="allow">允许本次</button>
      </div>
      <p class="interaction-timeout">{{ secondsLeft }} 秒内未响应将自动拒绝</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, type DeepReadonly, onUnmounted, reactive, ref, watch } from "vue";
import type { AgentInteractionRequest } from "../../../shared/types";
import { INTERACTION_TIMEOUT_MS, respondInteraction, store } from "../state";

const request = computed<DeepReadonly<AgentInteractionRequest> | null>(
  () => store.interactions[store.activeBackend]?.[0] ?? null,
);
const answers = reactive<Record<string, string>>({});

// Ticks only while a dialog is up, so the auto-deny countdown reads live.
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | null = null;

function stopTicker(): void {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

watch(
  request,
  (value) => {
    for (const key of Object.keys(answers)) delete answers[key];
    for (const question of value?.kind === "user-input" ? value.questions : []) {
      answers[question.id] = "";
    }
    stopTicker();
    if (value) ticker = setInterval(() => (now.value = Date.now()), 1000);
  },
  { immediate: true },
);

onUnmounted(stopTicker);

const secondsLeft = computed(() => {
  if (!request.value) return INTERACTION_TIMEOUT_MS / 1000;
  const deadline = store.interactionDeadlines[`${store.activeBackend}:${request.value.requestId}`];
  if (!deadline) return 0;
  return Math.max(0, Math.ceil((deadline - now.value) / 1000));
});

function deny(): void {
  if (request.value) respondInteraction(request.value, { decision: "deny" });
}

function allow(): void {
  if (request.value) respondInteraction(request.value, { decision: "allow" });
}

function submitAnswers(): void {
  if (request.value?.kind !== "user-input") return;
  respondInteraction(request.value, { decision: "answers", answers: { ...answers } });
}
</script>
