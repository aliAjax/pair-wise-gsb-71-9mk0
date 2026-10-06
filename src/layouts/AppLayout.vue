<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const route = useRoute()
const router = useRouter()

const menuItems = [
  { key: '/', label: '运行概览', icon: 'icon-dashboard' },
  { key: '/runs', label: '回归运行', icon: 'icon-apps' },
  { key: '/approvals', label: '审批队列', icon: 'icon-check-circle' },
  { key: '/baselines', label: '历史基线', icon: 'icon-history' },
  { key: '/rules', label: '忽略规则', icon: 'icon-filter' },
  { key: '/reports', label: '结果与导出', icon: 'icon-download' },
]

const activeKey = computed(() => {
  if (route.path.startsWith('/runs')) return '/runs'
  return route.path
})

const pageTitle = computed(() => {
  const map: Record<string, string> = {
    '/': '运行概览',
    '/runs': '视觉回归运行',
    '/approvals': '审批队列',
    '/baselines': '历史基线',
    '/rules': '忽略规则',
    '/reports': '结果与导出',
  }
  return route.name === 'run-detail' ? '差异定位评审' : map[route.path] ?? '视觉基线评审台'
})

const navigate = (key: string) => {
  void router.push(key)
}
</script>

<template>
  <a-layout class="app-shell">
    <a-layout-sider class="app-sider" :width="228" collapsible breakpoint="lg">
      <div class="brand">
        <div class="brand-mark">VR</div>
        <div>
          <strong>视觉基线评审台</strong>
          <span>Visual Review Console</span>
        </div>
      </div>
      <a-menu class="app-menu" :selected-keys="[activeKey]" @menu-item-click="navigate">
        <a-menu-item v-for="item in menuItems" :key="item.key">
          <template #icon><component :is="item.icon" /></template>
          {{ item.label }}
        </a-menu-item>
      </a-menu>
      <div class="sider-foot">
        <span class="online-dot" />
        <div>
          <strong>对照服务正常</strong>
          <small>最近同步 09:42</small>
        </div>
      </div>
    </a-layout-sider>

    <a-layout>
      <a-layout-header class="app-header">
        <div>
          <a-breadcrumb>
            <a-breadcrumb-item>质量工程</a-breadcrumb-item>
            <a-breadcrumb-item>{{ pageTitle }}</a-breadcrumb-item>
          </a-breadcrumb>
          <h1>{{ pageTitle }}</h1>
        </div>
        <a-space :size="12">
          <a-tag color="arcoblue">桌面端 1440</a-tag>
          <a-avatar :size="32" style="background: #165dff">林</a-avatar>
          <div class="reviewer">
            <strong>林默</strong>
            <span>视觉评审人</span>
          </div>
        </a-space>
      </a-layout-header>
      <a-layout-content class="app-content">
        <router-view />
      </a-layout-content>
    </a-layout>
  </a-layout>
</template>
