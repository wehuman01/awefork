<template>
  <div class="app">
    <TopBar />
    <div class="shell">
      <SideBar />
      <SessionCanvas />
      <BranchContext />
    </div>
    <div
      v-if="store.actionError"
      class="toast banner-error"
      role="alert"
      @click="dismissActionError"
    >
      {{ store.actionError }}（点击关闭）
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from "vue";
import BranchContext from "./components/branch-context.vue";
import SessionCanvas from "./components/session-canvas.vue";
import SideBar from "./components/side-bar.vue";
import TopBar from "./components/top-bar.vue";
import { dismissActionError, init, store } from "./state";

onMounted(() => {
  void init();
});
</script>
