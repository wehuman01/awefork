<template>
  <div ref="rootEl" class="vp">
    <button
      ref="btnEl"
      type="button"
      class="vp-btn"
      :class="{ off: disabled }"
      :title="title"
      :disabled="disabled"
      @click="toggle"
    >
      <span class="vp-label">{{ label }}</span>
      <span v-if="!disabled" class="vp-chev">{{ open ? "⌃" : "⌄" }}</span>
    </button>
    <!-- teleport 出去：面板和画布 viewport 都有 overflow:hidden / transform，
         弹层留在组件树里会被裁剪或跟着缩放 -->
    <Teleport to="body">
      <div v-if="open" ref="popEl" class="vp-pop" :style="popStyle" tabindex="-1" @keydown="onPopKeydown">
        <button
          type="button"
          class="vp-item"
          :class="{ hl: highlighted === -1 }"
          @click="pick(null)"
        >
          <span class="vp-name">默认</span>
          <span class="vp-sub">模型自带的档位</span>
        </button>
        <button
          v-for="(v, i) in variants"
          :key="v"
          type="button"
          class="vp-item"
          :class="{ hl: highlighted === i }"
          @click="pick(v)"
        >
          <span class="vp-name">{{ v }}</span>
        </button>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import type { ModelChoice, ModelOption } from "../../../shared/types";

const props = defineProps<{
  /** Current model choice; its variant drives the label and highlight. */
  model: ModelChoice | null;
  models: readonly ModelOption[];
  /** Whether the host composer can offer variant switching at all. */
  title?: string;
}>();
const emit = defineEmits<{ select: [variant: string | null] }>();

const open = ref(false);
/** -1 = the "默认" row; otherwise an index into `variants`. */
const highlighted = ref(-1);
const rootEl = ref<HTMLElement | null>(null);
const btnEl = ref<HTMLButtonElement | null>(null);
const popEl = ref<HTMLElement | null>(null);

/** 弹层是 fixed 定位（teleport 到 body），坐标在打开时按按钮位置算。 */
const POP_WIDTH = 190;
const SCREEN_EDGE = 8;
const popStyle = ref<{ left: string; top?: string; bottom?: string }>({
  left: "0px",
  bottom: "0px",
});

const variants = computed(() => {
  const model = props.model;
  if (!model) return [];
  return (
    props.models.find((m) => m.providerId === model.providerId && m.modelId === model.modelId)
      ?.variants ?? []
  );
});

const disabled = computed(() => variants.value.length === 0);

const title = computed(() => {
  if (!props.model) return "选择具体模型后可调思考强度";
  if (disabled.value) return "该模型没有思考档位";
  return props.title ?? "这次运行用多大思考强度";
});

const label = computed(() => {
  const variant = props.model?.variant;
  return variant ? `思考 · ${variant}` : "思考";
});

function toggle(): void {
  open.value ? close() : show();
}

function place(): void {
  const btn = btnEl.value;
  if (!btn) return;
  const r = btn.getBoundingClientRect();
  const left = Math.min(Math.max(SCREEN_EDGE, r.left), window.innerWidth - POP_WIDTH - SCREEN_EDGE);
  popStyle.value = { left: `${left}px`, bottom: `${window.innerHeight - r.top + SCREEN_EDGE}px` };
}

function show(): void {
  place();
  open.value = true;
  highlighted.value = props.model?.variant
    ? Math.max(variants.value.indexOf(props.model.variant), 0)
    : -1;
  void nextTick(() => {
    // 按钮离窗口顶部太近、向上放不下时翻到按钮下方
    const pop = popEl.value;
    if (pop && pop.getBoundingClientRect().top < SCREEN_EDGE) {
      const r = btnEl.value?.getBoundingClientRect();
      if (r) popStyle.value = { left: popStyle.value.left, top: `${r.bottom + SCREEN_EDGE}px` };
    }
    popEl.value?.focus();
  });
}

function close(): void {
  open.value = false;
}

function pick(variant: string | null): void {
  emit("select", variant || null);
  close();
}

function onPopKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const size = variants.value.length + 1; // + the 默认 row at -1
    const current = highlighted.value + 1; // 0 = 默认 row
    const step = event.key === "ArrowDown" ? 1 : -1;
    highlighted.value = ((current + step + size) % size) - 1;
  } else if (event.key === "Enter") {
    event.preventDefault();
    pick(highlighted.value >= 0 ? (variants.value[highlighted.value] ?? null) : null);
  } else if (event.key === "Escape") {
    close();
  }
}

function onDocMousedown(event: MouseEvent): void {
  if (!open.value) return;
  const target = event.target as Node;
  if (rootEl.value?.contains(target) || popEl.value?.contains(target)) return;
  close();
}

onMounted(() => document.addEventListener("mousedown", onDocMousedown));
onUnmounted(() => document.removeEventListener("mousedown", onDocMousedown));
</script>

<style scoped>
.vp {
  position: relative;
  flex: 0 0 auto;
}

.vp-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--line);
  background: var(--card);
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--primary-deep);
}

.vp-btn:hover:not(:disabled) {
  border-color: var(--primary-border);
}

.vp-btn:disabled {
  color: var(--ink-faint);
  cursor: not-allowed;
}

.vp-label {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.vp-chev {
  color: var(--ink-faint);
  font-size: 10px;
  flex: 0 0 auto;
}

.vp-pop {
  position: fixed;
  width: 190px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: var(--shadow-lift);
  padding: 6px;
  z-index: 70;
  display: flex;
  flex-direction: column;
  gap: 2px;
  outline: none;
}

.vp-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 10px;
  border-radius: 9px;
}

.vp-item.hl {
  background: var(--primary-soft);
}

.vp-name {
  display: block;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.vp-sub {
  display: block;
  font-size: 10.5px;
  color: var(--ink-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
