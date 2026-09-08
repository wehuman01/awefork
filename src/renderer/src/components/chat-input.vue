<template>
  <form
    class="chat-input"
    :class="{ dragging: dragOver }"
    @submit.prevent="submit"
    @dragover.prevent="dragOver = true"
    @dragleave="dragOver = false"
    @drop.prevent="onDrop"
  >
    <div v-if="attachments.length > 0 || notice" class="chat-input-atts">
      <span v-for="a in attachments" :key="a.id" class="att-chip">
        <img v-if="a.mime.startsWith('image/')" :src="a.dataUrl" class="att-thumb" alt="" />
        <span v-else class="att-ico">📎</span>
        <span class="att-name" :title="a.name">{{ a.name }}</span>
        <button type="button" class="att-x" title="移除" @click="removeAttachment(a.id)">✕</button>
      </span>
      <span v-if="notice" class="att-notice">{{ notice }}</span>
    </div>
    <textarea
      ref="textareaEl"
      v-model="text"
      :placeholder="inputPlaceholder"
      :disabled="running"
      rows="2"
      @keydown.enter.exact="onEnterKey"
      @paste="onPaste"
    ></textarea>
    <div class="chat-input-foot">
      <ModelPicker
        :model-value="model"
        :models="models"
        title="用哪个模型继续这条分支"
        @update:model-value="onModelPicked"
      />
      <VariantPicker :model="model" :models="models" @select="onVariantPicked" />
      <button v-if="!running" type="submit" class="send" :disabled="!text.trim()">发送 ➤</button>
      <button v-else type="button" class="abort" @click="$emit('abort')">■ 停止</button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import type { ModelChoice, ModelOption, PromptAttachment } from "../../../shared/types";
import {
  countImages,
  type DraftAttachment,
  readAttachments,
  toPromptAttachments,
} from "../attachments";
import ModelPicker from "./model-picker.vue";
import VariantPicker from "./variant-picker.vue";

const props = defineProps<{
  running: boolean;
  model: ModelChoice | null;
  models: readonly ModelOption[];
}>();
const emit = defineEmits<{
  send: [text: string, attachments: PromptAttachment[]];
  abort: [];
  "set-model": [model: ModelChoice | null];
}>();

const text = ref("");
const textareaEl = ref<HTMLTextAreaElement | null>(null);
const attachments = ref<DraftAttachment[]>([]);
const dragOver = ref(false);
const notice = ref("");
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

// Grow the box with the draft instead of scrolling inside it; two rows is the
// floor and roughly a half pane the ceiling.
const MAX_INPUT_HEIGHT_PX = 200;

function fitTextarea(): void {
  const el = textareaEl.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT_PX)}px`;
}

watch(text, () => {
  void nextTick(fitTextarea);
});
onMounted(fitTextarea);

const inputPlaceholder = computed(() => {
  if (props.running) return "Agent is running…";
  return "继续这条分支…";
});

/** The selected model's capability, when the catalog already knows it. */
const canAttach = computed(() => {
  if (!props.model) return true;
  const option = props.models.find(
    (m) => m.providerId === props.model?.providerId && m.modelId === props.model?.modelId,
  );
  return option ? option.attachment : true;
});

function flashNotice(message: string): void {
  notice.value = message;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.value = "";
  }, 2500);
}

function addFiles(files: FileList | File[]): void {
  if (!canAttach.value) {
    flashNotice("当前模型不支持附件");
    return;
  }
  const total = [...files].length;
  const images = countImages(files);
  if (images === 0) {
    flashNotice("先只支持图片附件");
    return;
  }
  if (images < total) flashNotice("先只支持图片附件，已跳过其他文件");
  void readAttachments(files).then((staged) => {
    attachments.value = [...attachments.value, ...staged];
  });
}

function removeAttachment(id: string): void {
  attachments.value = attachments.value.filter((a) => a.id !== id);
}

function onPaste(event: ClipboardEvent): void {
  const files = event.clipboardData?.files;
  if (!files || files.length === 0) return;
  event.preventDefault();
  addFiles(files);
}

function onDrop(event: DragEvent): void {
  dragOver.value = false;
  const files = event.dataTransfer?.files;
  if (!files || files.length === 0) return;
  addFiles(files);
}

onUnmounted(() => {
  if (noticeTimer) clearTimeout(noticeTimer);
});

/** Keep the effort level across a model switch when the new model has it too. */
function onModelPicked(choice: ModelChoice | null): void {
  const previous = props.model?.variant ?? null;
  if (choice && previous) {
    const supported =
      props.models.find((m) => m.providerId === choice.providerId && m.modelId === choice.modelId)
        ?.variants ?? [];
    if (supported.includes(previous)) {
      emit("set-model", { ...choice, variant: previous });
      return;
    }
  }
  emit("set-model", choice);
}

function onVariantPicked(variant: string | null): void {
  if (!props.model) return;
  emit("set-model", { ...props.model, variant });
}

/**
 * 组输入（中文输入法）期间的回车在确认候选词，不是发送；keyCode 229 兜住
 * Safari——它在提交流的那次 keydown 上不设 isComposing。
 */
function onEnterKey(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  submit();
}

function submit(): void {
  const value = text.value.trim();
  if (!value || props.running) return;
  emit("send", value, toPromptAttachments(attachments.value));
  text.value = "";
  attachments.value = [];
}
</script>
