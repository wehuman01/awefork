<template>
  <header class="topbar">
    <div class="brand">
      <img class="logo" :src="logoUrl" alt="" />
      <span class="brand-name">awefork</span>
      <span class="brand-sub">分支工作台</span>
    </div>
    <div v-if="backendList.length > 1" class="backend-switch" role="group" aria-label="Agent 后端">
      <button
        v-for="entry in backendList"
        :key="entry.id"
        type="button"
        class="backend-btn"
        :class="{ active: entry.id === activeBackend }"
        :disabled="!entry.installed"
        :title="
          entry.installed ? `切换到 ${entry.label}` : `未在 PATH 上找到 ${entry.label} CLI`
        "
        @click="pickBackend(entry.id)"
      >
        {{ entry.label }}
      </button>
      <!-- The install probe's compat check: a CLI version outside the tested
           range still runs, but never silently — the full text sits in the
           title so one hover explains a misbehaving run. -->
      <span
        v-if="activeVersionWarning"
        class="backend-warn"
        :title="activeVersionWarning"
        role="status"
        >⚠</span
      >
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
      {{ connectionError ? `${activeLabel} 未连接` : `${activeLabel} 已连接` }}
    </div>
    <button
      type="button"
      class="icon-btn cmdk-btn"
      title="命令面板（⌘K / Ctrl+K）"
      @click="togglePalette()"
    >⌘K</button>
    <div class="version-wrap" @click.stop>
      <button type="button" class="version-btn" @click="toggleVersionMenu">
        <span>{{ versionLabel }}</span>
        <span class="version-chev">▾</span>
      </button>
      <div v-if="versionOpen" class="version-menu">
        <button type="button" class="version-item" @click="runManualCheck">Check for updates</button>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { BackendId } from "../../../shared/backend";
import logoUrl from "../assets/logo.svg";
import { shortPath } from "../format";
import { togglePalette } from "../layout";
import { checkForUpdates, directories, store, switchBackend, switchDirectory } from "../state";

const open = ref(false);
const versionOpen = ref(false);
const currentDirectory = computed(() => store.selectedDirectory ?? "");
const connectionError = computed(() => store.connectionError);
const backendList = computed(() => store.backendList);
const activeBackend = computed(() => store.activeBackend);
const activeVersionWarning = computed(
  () => backendList.value.find((entry) => entry.id === activeBackend.value)?.versionWarning ?? null,
);
const activeLabel = computed(
  () =>
    backendList.value.find((entry) => entry.id === activeBackend.value)?.label ??
    activeBackend.value,
);
// The version button is always there (so manual checks stay reachable); a
// placeholder stands in until the first check fills the real version in.
const versionLabel = computed(() => `v${store.currentVersion ?? "—"}`);

function toggleOpen(): void {
  open.value = !open.value;
}

function toggleVersionMenu(): void {
  versionOpen.value = !versionOpen.value;
}

async function pickBackend(backend: BackendId): Promise<void> {
  await switchBackend(backend);
}

async function pick(directory: string): Promise<void> {
  open.value = false;
  await switchDirectory(directory);
}

async function runManualCheck(): Promise<void> {
  versionOpen.value = false;
  await checkForUpdates("manual");
}

function closeOnOutsideClick(): void {
  open.value = false;
  versionOpen.value = false;
}

onMounted(() => document.addEventListener("click", closeOnOutsideClick));
onUnmounted(() => document.removeEventListener("click", closeOnOutsideClick));
</script>
