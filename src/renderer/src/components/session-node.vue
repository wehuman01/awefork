<template>
  <div>
    <button
      type="button"
      class="session-row"
      :class="{ selected: node.session.id === selectedId, fork: node.session.origin === 'fork' }"
      :style="{ paddingLeft: `${8 + depth * 14}px` }"
      :title="node.session.title"
      @click="$emit('select', node.session.id)"
    >
      <span class="fork-mark" v-if="node.session.origin === 'fork'">⎇</span>
      <span class="session-title">{{ node.session.title || "(untitled)" }}</span>
    </button>
    <SessionNode
      v-for="child in node.children"
      :key="child.session.id"
      :node="child"
      :depth="depth + 1"
      :selected-id="selectedId"
      @select="$emit('select', $event)"
    />
  </div>
</template>

<script setup lang="ts">
import type { SessionTreeNode } from "../../../shared/session-tree";

defineProps<{
  node: SessionTreeNode;
  depth: number;
  selectedId: string | null;
}>();

defineEmits<{ select: [sessionId: string] }>();
</script>
