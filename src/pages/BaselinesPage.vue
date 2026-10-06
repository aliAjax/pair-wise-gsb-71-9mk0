<script setup lang="ts">
import { computed, ref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { getBaselineConflicts, getBaselines, getProjects } from '@/api/http'

const projectId = ref('')
const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: getProjects })
const { data: baselines, isLoading } = useQuery({
  queryKey: ['baselines', projectId],
  queryFn: () => getBaselines(projectId.value || undefined),
})
const { data: conflicts } = useQuery({
  queryKey: ['baseline-conflicts'],
  queryFn: getBaselineConflicts,
})

const projectName = (id: string) => projects.value?.find((project) => project.id === id)?.name ?? id

const duplicateTargets = computed(
  () => new Set((conflicts.value?.duplicates ?? []).map((item) => item.targetKey)),
)

const targetOf = (baseline: {
  projectId: string
  page: string
  device: string
  theme: string
}) => [baseline.projectId, baseline.page, baseline.device, baseline.theme].join('|')
</script>

<template>
  <section class="page-intro compact">
    <div>
      <h2>历史基线与批准证据</h2>
      <p>每条基线冻结批准当时的截图摘要与规则指纹；规则后变不影响已批准快照。</p>
    </div>
    <a-select v-model="projectId" allow-clear placeholder="全部项目" style="width: 220px">
      <a-option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</a-option>
    </a-select>
  </section>

  <a-alert
    v-for="group in conflicts?.duplicates ?? []"
    :key="group.targetKey"
    type="error"
    style="margin-bottom: 10px"
  >
    目标 {{ group.targetKey.split('|').slice(1).join(' · ') }} 当前存在
    {{ group.baselines.length }} 条有效基线，其中 {{ group.packages.length }} 个冲突草稿待
    <router-link to="/approvals">前往审批队列化解</router-link>。
  </a-alert>

  <div class="baseline-layout">
    <a-card class="table-panel" :bordered="false">
      <a-table :data="baselines" :loading="isLoading" :pagination="false" row-key="id">
        <template #columns>
          <a-table-column title="项目 / 页面" :width="200">
            <template #cell="{ record }">
              <div class="primary-cell">
                <strong>{{ record.page }}</strong>
                <span>{{ projectName(record.projectId) }}</span>
              </div>
            </template>
          </a-table-column>
          <a-table-column title="基线版本" :width="170">
            <template #cell="{ record }"><code>{{ record.version }}</code></template>
          </a-table-column>
          <a-table-column title="设备 / 主题" :width="160">
            <template #cell="{ record }">{{ record.device }} · {{ record.theme === 'light' ? '浅色' : '深色' }}</template>
          </a-table-column>
          <a-table-column title="批准时快照" :width="200">
            <template #cell="{ record }">
              <div v-if="record.snapshot" class="snapshot-cell" :title="`截图摘要 ${record.snapshot.digestHash}&#10;规则指纹 ${record.snapshot.rulesHash}`">
                <code>摘 {{ record.snapshot.digestHash.slice(0, 8) }}</code>
                <code>规 {{ record.snapshot.rulesHash.slice(0, 8) }}</code>
                <small>{{ record.snapshot.verdictCount }} 区结论</small>
              </div>
              <span v-else class="muted">历史基线无快照</span>
            </template>
          </a-table-column>
          <a-table-column title="批准人" data-index="approvedBy" :width="90" />
          <a-table-column title="状态" :width="120">
            <template #cell="{ record }">
              <a-space direction="vertical" :size="2">
                <a-tag :color="record.active ? 'green' : 'gray'">{{ record.active ? '有效' : '已停用' }}</a-tag>
                <a-tag v-if="record.active && duplicateTargets.has(targetOf(record))" color="red" size="small">
                  同页重复有效
                </a-tag>
              </a-space>
            </template>
          </a-table-column>
          <a-table-column title="操作" :width="100">
            <template #cell="{ record }"><router-link :to="`/runs/${record.runId}`">追溯运行</router-link></template>
          </a-table-column>
        </template>
      </a-table>
    </a-card>

    <aside class="history-panel">
      <div class="panel-title">
        <div><h3>基线变更时间线</h3><span>快照在批准瞬间冻结，不再随规则回改</span></div>
      </div>
      <a-timeline>
        <a-timeline-item v-for="baseline in baselines?.slice(0, 5)" :key="baseline.id" :dot-color="baseline.active ? 'green' : 'gray'">
          <strong>{{ baseline.page }} · {{ baseline.version }}</strong>
          <p>{{ baseline.reason }}</p>
          <small>{{ baseline.approvedBy }} · {{ baseline.approvedAt.slice(0, 16).replace('T', ' ') }}</small>
        </a-timeline-item>
      </a-timeline>
    </aside>
  </div>
</template>
