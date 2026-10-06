<script setup lang="ts">
defineProps<{
  label: string
  value: number | string
  note: string
  tone?: 'blue' | 'orange' | 'red' | 'green'
}>()
</script>

<template>
  <div class="metric-panel" :class="`tone-${tone ?? 'blue'}`">
    <div class="metric-label">{{ label }}</div>
    <div class="metric-value">{{ value }}</div>
    <div class="metric-note">{{ note }}</div>
  </div>
</template>
