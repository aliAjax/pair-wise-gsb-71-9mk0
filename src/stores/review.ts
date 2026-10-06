import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

export const useReviewStore = defineStore('review', () => {
  const selectedRunIds = ref<string[]>([])
  const differenceFilter = ref<'all' | 'high' | 'medium' | 'low'>('all')
  const zoom = ref(100)
  const sidebarCollapsed = ref(false)

  const selectedCount = computed(() => selectedRunIds.value.length)

  const toggleRun = (id: string) => {
    const index = selectedRunIds.value.indexOf(id)
    if (index >= 0) selectedRunIds.value.splice(index, 1)
    else selectedRunIds.value.push(id)
  }

  const clearSelection = () => {
    selectedRunIds.value = []
  }

  const setDifferenceFilter = (value: 'all' | 'high' | 'medium' | 'low') => {
    differenceFilter.value = value
  }

  const setZoom = (value: number) => {
    zoom.value = Math.min(200, Math.max(50, value))
  }

  return {
    selectedRunIds,
    selectedCount,
    differenceFilter,
    zoom,
    sidebarCollapsed,
    toggleRun,
    clearSelection,
    setDifferenceFilter,
    setZoom,
  }
})
