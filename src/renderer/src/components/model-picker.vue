<template>
  <div ref="rootEl" class="mp">
    <button type="button" class="mp-btn" :title="title" @click="toggle">
      <span class="mp-label">{{ label }}</span>
      <span class="mp-chev">{{ open ? "⌃" : "⌄" }}</span>
    </button>
    <div v-if="open" class="mp-pop">
      <input
        ref="searchEl"
        v-model="query"
        class="mp-search"
        type="text"
        placeholder="搜索模型…"
        @keydown="onSearchKeydown"
      />
      <div class="mp-list">
        <button
          type="button"
          class="mp-item"
          :class="{ hl: highlighted === -1 }"
          @click="pick(null)"
        >
          <span class="mp-name">默认模型</span>
          <span class="mp-sub">agent 配置的默认</span>
        </button>
        <button
          v-for="(m, i) in filtered"
          :key="`${m.providerId}:${m.modelId}`"
          type="button"
          class="mp-item"
          :class="{ hl: highlighted === i }"
          @click="pickChoice(m)"
        >
          <span class="mp-name">{{ m.modelName }}</span>
          <span class="mp-sub">{{ m.providerName }} / {{ m.modelId }}</span>
        </button>
        <p v-if="filtered.length === 0" class="mp-empty">没有匹配的模型</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import type { ModelChoice, ModelOption } from "../../../shared/types";

const props = defineProps<{
  modelValue: ModelChoice | null;
  models: readonly ModelOption[];
  title?: string;
}>();
const emit = defineEmits<{ "update:modelValue": [model: ModelChoice | null] }>();

const open = ref(false);
const query = ref("");
/** -1 = the "agent default" row; otherwise an index into `filtered`. */
const highlighted = ref(-1);
const rootEl = ref<HTMLElement | null>(null);
const searchEl = ref<HTMLInputElement | null>(null);

const label = computed(() => {
  const model = props.modelValue;
  if (!model) return "默认模型";
  return (
    props.models.find((m) => m.providerId === model.providerId && m.modelId === model.modelId)
      ?.modelName ?? model.modelId
  );
});

const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return props.models;
  return props.models.filter((m) =>
    `${m.modelName} ${m.modelId} ${m.providerName}`.toLowerCase().includes(needle),
  );
});

function toggle(): void {
  open.value ? close() : show();
}

function show(): void {
  open.value = true;
  query.value = "";
  highlighted.value = props.modelValue ? 0 : -1;
  void nextTick(() => searchEl.value?.focus());
}

function close(): void {
  open.value = false;
}

function pick(model: ModelChoice | null): void {
  emit("update:modelValue", model);
  close();
}

function pickChoice(m: ModelOption): void {
  pick({ providerId: m.providerId, modelId: m.modelId });
}

function onSearchKeydown(event: KeyboardEvent): void {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const size = filtered.value.length + 1; // + the default row at -1
    const current = highlighted.value + 1; // 0 = default row
    const step = event.key === "ArrowDown" ? 1 : -1;
    highlighted.value = ((current + step + size) % size) - 1;
  } else if (event.key === "Enter") {
    event.preventDefault();
    const hit = highlighted.value >= 0 ? filtered.value[highlighted.value] : undefined;
    pick(hit ? { providerId: hit.providerId, modelId: hit.modelId } : null);
  } else if (event.key === "Escape") {
    close();
  }
}

function onDocMousedown(event: MouseEvent): void {
  if (open.value && rootEl.value && !rootEl.value.contains(event.target as Node)) close();
}

onMounted(() => document.addEventListener("mousedown", onDocMousedown));
onUnmounted(() => document.removeEventListener("mousedown", onDocMousedown));
</script>

<style scoped>
.mp {
  position: relative;
  min-width: 0;
}

.mp-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  border: 1px solid var(--line);
  background: var(--card);
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--primary-deep);
}

.mp-btn:hover {
  border-color: var(--primary-border);
}

.mp-label {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.mp-chev {
  color: var(--ink-faint);
  font-size: 10px;
  flex: 0 0 auto;
}

.mp-pop {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  width: 300px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: var(--shadow-lift);
  padding: 6px;
  z-index: 70;
}

.mp-search {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 7px 10px;
  font-size: 12.5px;
  outline: none;
  margin-bottom: 6px;
}

.mp-search:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-soft);
}

.mp-list {
  max-height: 260px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mp-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 10px;
  border-radius: 9px;
}

.mp-item.hl {
  background: var(--primary-soft);
}

.mp-name {
  display: block;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mp-sub {
  display: block;
  font-size: 10.5px;
  color: var(--ink-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mp-empty {
  padding: 10px;
  font-size: 12px;
  color: var(--ink-faint);
  text-align: center;
}
</style>
