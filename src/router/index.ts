import { createRouter, createWebHistory } from 'vue-router'
import AppLayout from '@/layouts/AppLayout.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      component: AppLayout,
      children: [
        { path: '', name: 'dashboard', component: () => import('@/pages/DashboardPage.vue') },
        { path: 'runs', name: 'runs', component: () => import('@/pages/RunsPage.vue') },
        { path: 'runs/:id', name: 'run-detail', component: () => import('@/pages/RunDetailPage.vue') },
        { path: 'approvals', name: 'approvals', component: () => import('@/pages/ApprovalsPage.vue') },
        { path: 'baselines', name: 'baselines', component: () => import('@/pages/BaselinesPage.vue') },
        { path: 'rules', name: 'rules', component: () => import('@/pages/RulesPage.vue') },
        { path: 'reports', name: 'reports', component: () => import('@/pages/ReportsPage.vue') },
      ],
    },
  ],
})

export default router
