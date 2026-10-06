<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Message } from '@arco-design/web-vue'
import {
  getBaselineConflicts,
  getBaselines,
  getBatches,
  getPackages,
  getRuns,
  mergeRuns,
  recoverBatches,
  resolveConflictPackage,
  verifyLegacyPackage,
} from '@/api/http'
import StatusTag from '@/components/StatusTag.vue'
import type { ApprovalPackage } from '@/types'

const queryClient = useQueryClient()
const selectedKeys = ref<string[]>([])

const { data: runs, isLoading } = useQuery({
  queryKey: ['runs', { status: 'pending' }],
  queryFn: () => getRuns({ status: 'pending' }),
})

const { data: packages } = useQuery({
  queryKey: ['packages', 'approval-queue'],
  queryFn: () => getPackages(),
})

const { data: conflicts } = useQuery({
  queryKey: ['baseline-conflicts'],
  queryFn: getBaselineConflicts,
})

const { data: batches } = useQuery({ queryKey: ['batches'], queryFn: getBatches })

const refreshAll = async () => {
  await queryClient.invalidateQueries({ queryKey: ['packages'] })
  await queryClient.invalidateQueries({ queryKey: ['baseline-conflicts'] })
  await queryClient.invalidateQueries({ queryKey: ['batches'] })
  await queryClient.invalidateQueries({ queryKey: ['baselines'] })
  await queryClient.invalidateQueries({ queryKey: ['runs'] })
}

const mergeMutation = useMutation({
  mutationFn: mergeRuns,
  onSuccess: async () => {
    Message.success('重复运行已合并，并保留每次执行来源')
    selectedKeys.value = []
    await queryClient.invalidateQueries({ queryKey: ['runs'] })
  },
  onError: (error: Error) => Message.error(error.message),
})

const verifyMutation = useMutation({
  mutationFn: verifyLegacyPackage,
  onSuccess: async (pkg) => {
    Message.success(
      pkg.conflictWith.length > 0
        ? '旧包已补齐摘要，转为冲突草稿等待化解'
        : '旧包已补齐摘要，可重新提交接管',
    )
    await refreshAll()
  },
  onError: (error: Error) => Message.error(error.message),
})

const resolveMutation = useMutation({
  mutationFn: ({
    packageId,
    payload,
  }: {
    packageId: string
    payload: { mode: 'keep-existing' | 'activate-package'; keepBaselineId?: string }
  }) => resolveConflictPackage(packageId, payload),
  onSuccess: async (pkg) => {
    Message.success(pkg.status === 'active' ? '冲突已化解，该审批包基线启用' : '冲突已化解，该审批包标记为被取代')
    await refreshAll()
  },
  onError: (error: Error) => Message.error(error.message),
})

const recoverMutation = useMutation({
  mutationFn: recoverBatches,
  onSuccess: async (result) => {
    if (result.recovered === 0) Message.info('没有待恢复的批次')
    else Message.success(`已恢复 ${result.recovered} 个批次，重放跳过重复基线，未重复生成`)
    await refreshAll()
  },
  onError: (error: Error) => Message.error(error.message),
})

const unignoredCount = (run: { regions: Array<{ ignored: boolean }> }) =>
  run.regions.filter((region) => !region.ignored).length

const pendingVerify = computed(
  () => packages.value?.filter((pkg) => pkg.status === 'needs-verification') ?? [],
)
const draftConflicts = computed(
  () => packages.value?.filter((pkg) => pkg.status === 'draft-conflict') ?? [],
)
const pendingBatches = computed(() => batches.value?.filter((batch) => batch.status === 'prepared') ?? [])

const baselinesForConflict = (pkg: ApprovalPackage) => {
  const duplicated = conflicts.value?.duplicates.find((item) => item.targetKey === pkg.targetKey)
  if (duplicated) return duplicated.baselines
  // newer-baseline：冲突对方是当前唯一有效基线，候选由 packages 接口附带的冲突 id 给出
  return allBaselines.value?.filter((baseline) => pkg.conflictWith.includes(baseline.id)) ?? []
}

const { data: allBaselines } = useQuery({
  queryKey: ['baselines', 'conflict-resolution'],
  queryFn: () => getBaselines(),
})

const shortTarget = (targetKey: string) => targetKey.split('|').slice(1, 3).join(' · ')
</script>

<template>
  <section class="page-intro compact">
    <div>
      <h2>待审批队列</h2>
      <p>两窗口同时批准同一目标时，先到者启用、后到者留冲突草稿；旧包缺摘要先待核。</p>
    </div>
    <a-space>
      <a-button
        v-if="pendingBatches.length > 0"
        status="warning"
        :loading="recoverMutation.isPending.value"
        @click="recoverMutation.mutate()"
      >
        <icon-history /> 恢复中断批次（{{ pendingBatches.length }}）
      </a-button>
      <a-button :disabled="selectedKeys.length < 2" @click="mergeMutation.mutate(selectedKeys)">
        <icon-merge /> 合并重复运行
      </a-button>
    </a-space>
  </section>

  <a-alert
    v-for="batch in pendingBatches"
    :key="batch.id"
    type="warning"
    closable
    style="margin-bottom: 10px"
  >
    批次 {{ batch.id }} 在写入后中断，审批包与基线操作已完整保留，重放不会重复生成基线。
  </a-alert>

  <div v-if="pendingVerify.length > 0" class="handoff-section">
    <div class="handoff-heading">
      <h3><icon-exclamation-circle-fill class="tone-warning" /> 旧审批包待核（{{ pendingVerify.length }}）</h3>
      <span>回传时缺少截图摘要，补齐前不允许启用</span>
    </div>
    <a-card v-for="pkg in pendingVerify" :key="pkg.id" class="handoff-card" :bordered="false">
      <div class="handoff-main">
        <strong>{{ shortTarget(pkg.targetKey) }}</strong>
        <span>运行 {{ pkg.runId }} · 版本 {{ pkg.currentVersion }} · {{ pkg.review?.reviewer }}</span>
        <p>{{ pkg.review?.reason }}</p>
      </div>
      <a-button type="primary" size="small" :loading="verifyMutation.isPending.value" @click="verifyMutation.mutate(pkg.id)">
        补齐截图摘要并核
      </a-button>
    </a-card>
  </div>

  <div v-if="draftConflicts.length > 0" class="handoff-section">
    <div class="handoff-heading">
      <h3><icon-swap class="tone-danger" /> 冲突草稿（{{ draftConflicts.length }}）</h3>
      <span>另一窗口已先批准同一目标，需人工选择保留哪条基线</span>
    </div>
    <a-card v-for="pkg in draftConflicts" :key="pkg.id" class="handoff-card" :bordered="false">
      <div class="handoff-main">
        <strong>{{ shortTarget(pkg.targetKey) }} · {{ pkg.currentVersion }}</strong>
        <span>
          运行 {{ pkg.runId }} ·
          {{ pkg.conflictReason === 'duplicate-active' ? '同页已有两条有效基线' : '基准版本已被新窗口推进' }}
        </span>
        <div class="conflict-baselines">
          <button
            v-for="baseline in baselinesForConflict(pkg)"
            :key="baseline.id"
            class="conflict-choice"
            :class="{ winner: baseline.runId === pkg.runId }"
            @click="
              resolveMutation.mutate({
                packageId: pkg.id,
                payload: { mode: 'keep-existing', keepBaselineId: baseline.id },
              })
            "
          >
            <code>{{ baseline.version }}</code>
            <span>{{ baseline.approvedBy }} · {{ baseline.approvedAt.slice(0, 10) }}</span>
            <b>{{ baseline.runId === pkg.runId ? '保留本包基线' : '保留对方基线' }}</b>
          </button>
          <button
            class="conflict-choice activate-self"
            @click="
              resolveMutation.mutate({ packageId: pkg.id, payload: { mode: 'activate-package' } })
            "
          >
            <code>{{ pkg.currentVersion }}</code>
            <span>按本审批包摘要补建并启用</span>
            <b>强制启用本包</b>
          </button>
        </div>
      </div>
    </a-card>
  </div>

  <div class="queue-summary">
    <div>
      <span>当前待审批</span>
      <strong>{{ runs?.length ?? 0 }}</strong>
    </div>
    <div>
      <span>高风险运行</span>
      <strong class="danger">{{ runs?.filter((run) => run.mismatchRate >= 5).length ?? 0 }}</strong>
    </div>
    <div>
      <span>冲突草稿</span>
      <strong class="danger">{{ draftConflicts.length }}</strong>
    </div>
    <div>
      <span>旧包待核</span>
      <strong class="tone-warning">{{ pendingVerify.length }}</strong>
    </div>
  </div>

  <a-card class="table-panel" :bordered="false">
    <a-table
      v-model:selected-keys="selectedKeys"
      :data="runs"
      :loading="isLoading"
      :pagination="false"
      row-key="id"
      :row-selection="{ type: 'checkbox', showCheckedAll: true }"
    >
      <template #columns>
        <a-table-column title="优先队列" :width="260">
          <template #cell="{ record }">
            <div class="primary-cell">
              <router-link :to="`/runs/${record.id}`">{{ record.page }}</router-link>
              <span>{{ record.name }} · {{ record.id }}</span>
            </div>
          </template>
        </a-table-column>
        <a-table-column title="风险" :width="130">
          <template #cell="{ record }">
            <a-tag :color="record.mismatchRate >= 5 ? 'red' : record.mismatchRate >= 2 ? 'orange' : 'gray'">
              {{ record.mismatchRate.toFixed(2) }}%
            </a-tag>
          </template>
        </a-table-column>
        <a-table-column title="差异区域" :width="150">
          <template #cell="{ record }">{{ unignoredCount(record) }} 处待判定</template>
        </a-table-column>
        <a-table-column title="构建" data-index="build" :width="180" />
        <a-table-column title="提交时间" :width="150">
          <template #cell="{ record }">{{ record.capturedAt.slice(5, 16).replace('T', ' ') }}</template>
        </a-table-column>
        <a-table-column title="状态" :width="100">
          <template #cell="{ record }"><StatusTag :status="record.status" /></template>
        </a-table-column>
        <a-table-column title="操作" :width="100" fixed="right">
          <template #cell="{ record }"><router-link :to="`/runs/${record.id}`">开始评审</router-link></template>
        </a-table-column>
      </template>
    </a-table>
  </a-card>
</template>
