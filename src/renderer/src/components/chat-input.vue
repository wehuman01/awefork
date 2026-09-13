<template>
  <form
    class="chat-input"
    :class="{ dragging: dragOver && allowAttachments }"
    @submit.prevent="submit"
    @dragover.prevent="onDragOver"
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
      v-if="!previewing"
      ref="textareaEl"
      v-model="text"
      :placeholder="inputPlaceholder"
      :disabled="running"
      rows="2"
      @keydown.enter.exact="onEnterKey"
      @keydown.tab.prevent="onTabKey"
      @paste="onPaste"
    ></textarea>
    <div v-else class="chat-input-preview">
      <MarkdownView v-if="text.trim()" :source="text" user />
      <p v-else class="chat-input-preview-empty">输入内容后，这里显示发送后的 Markdown 效果</p>
    </div>
    <div class="chat-input-foot">
      <input
        ref="fileInputEl"
        type="file"
        multiple
        hidden
        :accept="ATTACHMENT_ACCEPT"
        @change="onFilePicked"
      />
      <button
        v-if="allowAttachments"
        type="button"
        class="attach"
        title="添加附件（图片、文档、文本）"
        @click="fileInputEl?.click()"
      >
        📎
      </button>
      <button
        type="button"
        class="preview"
        :class="{ on: previewing }"
        :title="previewing ? '回到编辑' : '预览发送后的 Markdown 效果'"
        @click="togglePreview"
      >{{ previewing ? "✎ 编辑" : "👁 预览" }}</button>
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
import { ATTACHMENT_ACCEPT } from "../../../shared/attachment-kinds";
import type { ModelChoice, ModelOption, PromptAttachment } from "../../../shared/types";
import { type DraftAttachment, readAttachments, toPromptAttachments } from "../attachments";
import {
  indentLines,
  looksLikeCode,
  outdentLines,
  type TextEdit,
  wrapCodeFence,
} from "../input-editing";
import { MarkdownView } from "./markdown-view";
import ModelPicker from "./model-picker.vue";
import VariantPicker from "./variant-picker.vue";

const props = withDefaults(
  defineProps<{
    running: boolean;
    model: ModelChoice | null;
    models: readonly ModelOption[];
    /** Backend capability gate: codex takes no attachments at all. */
    allowAttachments?: boolean;
  }>(),
  { allowAttachments: true },
);
const emit = defineEmits<{
  send: [text: string, attachments: PromptAttachment[]];
  abort: [];
  "set-model": [model: ModelChoice | null];
}>();

const text = ref("");
const textareaEl = ref<HTMLTextAreaElement | null>(null);
const fileInputEl = ref<HTMLInputElement | null>(null);
const attachments = ref<DraftAttachment[]>([]);
const dragOver = ref(false);
const notice = ref("");
const previewing = ref(false);
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
  if (!props.allowAttachments) {
    flashNotice("当前后端不支持附件");
    return;
  }
  const notes: string[] = [];
  let list = [...files];
  // The attachment capability flags media input (images); plain-text
  // attachments ride along with any model.
  if (!canAttach.value) {
    if (list.some((f) => f.type.startsWith("image/"))) {
      list = list.filter((f) => !f.type.startsWith("image/"));
      notes.push("当前模型不支持图片附件，已跳过图片");
    }
  }
  if (list.length === 0) {
    if (notes.length > 0) flashNotice(notes.join("；"));
    return;
  }
  void readAttachments(list).then(({ staged, notes: stageNotes }) => {
    if (staged.length > 0) attachments.value = [...attachments.value, ...staged];
    flashNotice([...notes, ...stageNotes].join("；"));
  });
}

function onFilePicked(event: Event): void {
  const input = event.target as HTMLInputElement;
  if (input.files && input.files.length > 0) addFiles(input.files);
  input.value = ""; // so picking the same file again still fires change
}

function removeAttachment(id: string): void {
  attachments.value = attachments.value.filter((a) => a.id !== id);
}

function onPaste(event: ClipboardEvent): void {
  const data = event.clipboardData;
  const files = data?.files;
  if (files && files.length > 0) {
    // Swallow the paste either way: a pasted file would otherwise land as
    // nothing (or garbage) in the textarea once we refuse it.
    event.preventDefault();
    addFiles(files);
    return;
  }
  const el = textareaEl.value;
  const pasted = data?.getData("text/plain") ?? "";
  if (!el || !looksLikeCode(pasted)) return;
  // An odd number of ``` markers above the caret means the user is already
  // typing inside their own fence — placing the code there verbatim.
  const fences = (text.value.slice(0, el.selectionStart).match(/```/g) ?? []).length;
  if (fences % 2 === 1) return;
  event.preventDefault();
  insertAtCaret(el, wrapCodeFence(pasted));
  flashNotice("识别到多行代码，已包成 ``` 围栏（⌘Z 可撤销）");
}

/** Splice an edit in through insertText so it stays on the undo stack. */
function applyTextEdit(el: HTMLTextAreaElement, edit: TextEdit): void {
  el.focus();
  el.setSelectionRange(edit.from, edit.to);
  if (document.execCommand("insertText", false, edit.insert)) {
    el.setSelectionRange(edit.start, edit.end);
    return;
  }
  text.value = text.value.slice(0, edit.from) + edit.insert + text.value.slice(edit.to);
  void nextTick(() => el.setSelectionRange(edit.start, edit.end));
}

/** execCommand-less fallback path for insertText; caret lands after the text. */
function insertAtCaret(el: HTMLTextAreaElement, insert: string): void {
  el.focus();
  if (document.execCommand("insertText", false, insert)) return;
  const from = el.selectionStart;
  const to = el.selectionEnd;
  text.value = text.value.slice(0, from) + insert + text.value.slice(to);
}

function onTabKey(event: KeyboardEvent): void {
  const el = textareaEl.value;
  if (!el || event.isComposing) return;
  const edit = event.shiftKey
    ? outdentLines(text.value, el.selectionStart, el.selectionEnd)
    : indentLines(text.value, el.selectionStart, el.selectionEnd);
  applyTextEdit(el, edit);
}

function togglePreview(): void {
  previewing.value = !previewing.value;
  if (!previewing.value) void nextTick(() => textareaEl.value?.focus());
}

function onDragOver(): void {
  if (props.allowAttachments) dragOver.value = true;
}

function onDrop(event: DragEvent): void {
  dragOver.value = false;
  if (!props.allowAttachments) return;
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
  previewing.value = false;
}

/** Pane host pulls this after 新增对话 so the first prompt starts typing at once. */
function focus(): void {
  textareaEl.value?.focus();
}

defineExpose({ focus });
</script>
