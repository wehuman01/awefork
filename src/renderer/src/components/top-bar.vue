<template>
  <header class="topbar">
    <div class="brand">
      <span class="logo">🍑</span>
      <span class="brand-name">awefork</span>
      <span class="brand-sub">分支工作台</span>
    </div>
    <div v-if="directories.length > 0" class="project-wrap">
      <button type="button" class="project-pill" @click.stop="toggleOpen">
        <span>📁</span>
        <b>{{ shortPath(currentDirectory) }}</b>
        <span class="chev">{{ open ? "⌃" : "⌄" }}</span>
      </button>
      <div v-if="open" class="project-menu">
        <button
          v-for="directory in directories"
          :key="directory"
          type="button"
          class="project-item"
          :class="{ active: directory === currentDirectory }"
          :title="directory"
          @click="pick(directory)"
        >
          📁 {{ shortPath(directory) }}
        </button>
      </div>
    </div>
    <div class="topbar-status" :class="connectionError ? 'bad' : 'ok'">
      <span class="status-dot"></span>
      {{ connectionError ? "opencode 未连接" : "opencode 已连接" }}
    </div>
    <button
      type="button"
      class="icon-btn cmdk-btn"
      title="命令面板（⌘K / Ctrl+K）"
      @click="togglePalette()"
    >⌘K</button>
  </header>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { togglePalette } from "../layout";
import { directories, store, switchDirectory } from "../state";

const open = ref(false);
const currentDirectory = computed(() => store.selectedDirectory ?? "");
const connectionError = computed(() => store.connectionError);

function toggleOpen(): void {
  open.value = !open.value;
}

async function pick(directory: string): Promise<void> {
  open.value = false;
  await switchDirectory(directory);
}

function shortPath(directory: string): string {
  const parts = directory.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || directory || "…";
}

function closeOnOutsideClick(): void {
  open.value = false;
}

onMounted(() => document.addEventListener("click", closeOnOutsideClick));
onUnmounted(() => document.removeEventListener("click", closeOnOutsideClick));
</script>
