<template>
  <nav class="session-tree">
    <section v-for="group in groups" :key="group.directory" class="session-group">
      <h2 class="group-title" :title="group.directory">{{ shortPath(group.directory) }}</h2>
      <SessionNode
        v-for="node in group.roots"
        :key="node.session.id"
        :node="node"
        :depth="0"
        :selected-id="selectedId"
        @select="$emit('select', $event)"
      />
      <p v-if="group.roots.length === 0" class="group-empty">(no sessions)</p>
    </section>
    <p v-if="groups.length === 0" class="group-empty">No sessions yet.</p>
  </nav>
</template>

<script setup lang="ts">
import type { SessionGroup } from "../../../shared/session-tree";
import SessionNode from "./session-node.vue";

defineProps<{
  groups: SessionGroup[];
  selectedId: string | null;
}>();

defineEmits<{ select: [sessionId: string] }>();

function shortPath(directory: string): string {
  const parts = directory.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || directory;
}
</script>
