<script setup lang="ts">
import { computed, ref } from 'vue'
import { Message } from '@arco-design/web-vue'
import { useQuery } from '@tanstack/vue-query'
import { getBaselines, getRuns } from '@/api/http'
import StatusTag from '@/components/StatusTag.vue'

const dateRange = ref('last-7-days')
const { data: runs } = useQuery({ queryKey: ['runs', 'reports'], queryFn: () => getRuns() })
const { data: baselines } = useQuery({ queryKey: ['baselines', 'reports'], queryFn: () => getBaselines() })

const summary = computed(() => ({
  total: runs.value?.length ?? 0,
  failed: runs.value?.filter((run) => run.mismatchRate > 0).length ?? 0,
  approved: runs.value?.filter((run) => run.status === 'approved').length ?? 0,
  baselines: baselines.value?.length ?? 0,
}))

const escapeCsv = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`

const exportCsv = () => {
  const rows = [
    ['运行ID', '页面', '设备', '主题', '构建', '状态', '差异率', '差异区域', '审批人', '审批原因'],
    ...(runs.value ?? []).map((run) => [
      run.id,
      run.page,
      run.device,
      run.theme,
      run.build,
      run.status,
      run.mismatchRate.toFixed(2),
      run.regions.length,
      run.review?.reviewer ?? '',
      run.review?.reason ?? '',
    ]),
  ]
  const csv = `\uFEFF${rows.map((row) => row.map(escapeCsv).join(',')).join('\n')}`
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `visual-regression-report-${new Date().toISOString().slice(0, 10)}.csv`
  link.click()
  URL.revokeObjectURL(url)
  Message.success('结果 CSV 已导出')
}
</script>

<template>
  <section class="page-intro compact">
    <div>
      <h2>结果汇总与导出</h2>
      <p>导出运行、差异和审批证据，作为发布质量记录或后续复盘输入。</p>
    </div>
    <a-space>
      <a-select v-model="dateRange" style="width: 150px">
        <a-option value="last-7-days">最近 7 天</a-option>
        <a-option value="last-30-days">最近 30 天</a-option>
        <a-option value="current-release">当前发布周期</a-option>
      </a-select>
      <a-button type="primary" @click="exportCsv"><icon-download /> 导出 CSV</a-button>
    </a-space>
  </section>

  <div class="metric-grid report-metrics">
    <div class="metric-panel tone-blue"><div class="metric-label">总运行</div><div class="metric-value">{{ summary.total }}</div><div class="metric-note">当前筛选范围</div></div>
    <div class="metric-panel tone-orange"><div class="metric-label">存在差异</div><div class="metric-value">{{ summary.failed }}</div><div class="metric-note">含已忽略区域</div></div>
    <div class="metric-panel tone-green"><div class="metric-label">批准运行</div><div class="metric-value">{{ summary.approved }}</div><div class="metric-note">均包含审批原因</div></div>
    <div class="metric-panel tone-red"><div class="metric-label">基线版本</div><div class="metric-value">{{ summary.baselines }}</div><div class="metric-note">历史版本可追溯</div></div>
  </div>

  <a-card class="table-panel" :bordered="false">
    <template #title>发布质量明细</template>
    <template #extra><span class="muted">导出字段包含审批最终状态</span></template>
    <a-table :data="runs" :pagination="{ pageSize: 10 }" row-key="id">
      <template #columns>
        <a-table-column title="运行" data-index="name" :width="220" />
        <a-table-column title="页面 / 设备" :width="210">
          <template #cell="{ record }">{{ record.page }} · {{ record.device }}</template>
        </a-table-column>
        <a-table-column title="构建" data-index="build" :width="180" />
        <a-table-column title="差异率" :width="100">
          <template #cell="{ record }">{{ record.mismatchRate.toFixed(2) }}%</template>
        </a-table-column>
        <a-table-column title="状态" :width="100">
          <template #cell="{ record }"><StatusTag :status="record.status" /></template>
        </a-table-column>
        <a-table-column title="审批证据" :width="300">
          <template #cell="{ record }">
            <div v-if="record.review" class="evidence-cell">
              <strong>{{ record.review.reviewer }} · {{ record.review.reviewedAt.slice(0, 10) }}</strong>
              <span>{{ record.review.reason }}</span>
            </div>
            <span v-else class="muted">尚未审批</span>
          </template>
        </a-table-column>
      </template>
    </a-table>
  </a-card>
</template>
