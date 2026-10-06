<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { getDashboard, getRuns } from '@/api/http'
import MetricPanel from '@/components/MetricPanel.vue'
import StatusTag from '@/components/StatusTag.vue'

const { data: dashboard, isLoading } = useQuery({
  queryKey: ['dashboard'],
  queryFn: getDashboard,
})

const { data: runs } = useQuery({
  queryKey: ['runs', 'dashboard'],
  queryFn: () => getRuns(),
})
</script>

<template>
  <a-spin :loading="isLoading" style="width: 100%">
    <section class="page-intro">
      <div>
        <h2>今日视觉回归态势</h2>
        <p>聚合运行差异、审批积压和高风险页面，优先处理阻断发布的视觉变化。</p>
      </div>
      <router-link to="/runs">
        <a-button type="primary"><icon-upload /> 新建批量运行</a-button>
      </router-link>
    </section>

    <div class="metric-grid">
      <MetricPanel label="待审批运行" :value="dashboard?.pendingReview ?? 0" note="其中 2 条影响发布" tone="orange" />
      <MetricPanel label="今日已批准" :value="dashboard?.approvedToday ?? 0" note="均记录批准原因" tone="green" />
      <MetricPanel label="高风险差异" :value="dashboard?.highRisk ?? 0" note="差异率高于 5%" tone="red" />
      <MetricPanel label="有效基线" :value="dashboard?.activeBaselines ?? 0" note="覆盖 6 个关键页面" tone="blue" />
    </div>

    <div class="dashboard-grid">
      <a-card class="work-panel" :bordered="false">
        <template #title>近七日运行趋势</template>
        <template #extra><span class="muted">失败率受差异阈值控制</span></template>
        <div class="trend-chart">
          <div v-for="point in dashboard?.trend" :key="point.date" class="trend-column">
            <div class="trend-bars">
              <span class="trend-total" :style="{ height: `${point.total * 2.2}px` }" />
              <span class="trend-failed" :style="{ height: `${point.failed * 2.2}px` }" />
            </div>
            <b>{{ point.failed }}/{{ point.total }}</b>
            <small>{{ point.date }}</small>
          </div>
        </div>
        <div class="legend">
          <span><i class="total" />运行总量</span>
          <span><i class="failed" />差异失败</span>
        </div>
      </a-card>

      <a-card class="work-panel" :bordered="false">
        <template #title>发布阻断项</template>
        <template #extra><router-link to="/approvals">查看队列</router-link></template>
        <div class="blocker-list">
          <div v-for="run in runs?.filter((item) => item.status === 'pending').slice(0, 4)" :key="run.id" class="blocker-row">
            <div class="severity-line" :class="{ high: run.mismatchRate >= 5 }" />
            <div class="blocker-main">
              <strong>{{ run.page }}</strong>
              <span>{{ run.device }} · {{ run.build }}</span>
            </div>
            <b class="mismatch">{{ run.mismatchRate.toFixed(2) }}%</b>
            <StatusTag :status="run.status" />
            <router-link :to="`/runs/${run.id}`">定位差异</router-link>
          </div>
        </div>
      </a-card>
    </div>

    <a-card class="work-panel" :bordered="false">
      <template #title>最近同步的回归运行</template>
      <a-table :data="runs?.slice(0, 5)" :pagination="false" row-key="id" size="small">
        <template #columns>
          <a-table-column title="运行" data-index="name" />
          <a-table-column title="页面" data-index="page" />
          <a-table-column title="设备 / 主题" data-index="device" />
          <a-table-column title="构建" data-index="build" />
          <a-table-column title="差异率">
            <template #cell="{ record }">{{ record.mismatchRate.toFixed(2) }}%</template>
          </a-table-column>
          <a-table-column title="状态">
            <template #cell="{ record }"><StatusTag :status="record.status" /></template>
          </a-table-column>
          <a-table-column title="操作">
            <template #cell="{ record }"><router-link :to="`/runs/${record.id}`">打开评审</router-link></template>
          </a-table-column>
        </template>
      </a-table>
    </a-card>
  </a-spin>
</template>
