<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Message } from '@arco-design/web-vue'
import {
  attachTakeoverSummary,
  confirmTakeoverOrder,
  getRuns,
  getScreenshotSummary,
  getTakeoverBatches,
  getTakeovers,
  recoverTakeoverBatch,
  recomputeTakeoverOrder,
  submitPackage,
} from '@/api/http'
import type { ScreenshotRun, TakeoverOrder, TakeoverStatus } from '@/types'

const queryClient = useQueryClient()

const { data: takeovers, isLoading } = useQuery({
  queryKey: ['takeovers'],
  queryFn: getTakeovers,
})
const { data: runs } = useQuery({ queryKey: ['runs'], queryFn: () => getRuns() })
const { data: batches } = useQuery({
  queryKey: ['takeover-batches'],
  queryFn: getTakeoverBatches,
})

const refresh = async () => {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['takeovers'] }),
    queryClient.invalidateQueries({ queryKey: ['takeover-batches'] }),
    queryClient.invalidateQueries({ queryKey: ['runs'] }),
    queryClient.invalidateQueries({ queryKey: ['baselines'] }),
    queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
  ])
}

// --- 状态映射 ---------------------------------------------------------------
const statusMap: Record<TakeoverStatus, { label: string; color: string; hint: string }> = {
  active: { label: '先到·已启用', color: 'green', hint: '首个提交，已创建基线' },
  'draft-conflict': { label: '草稿·并列冲突', color: 'orange', hint: '同页已有先到者，等待人工确认' },
  stale: { label: '失效·待重算', color: 'red', hint: '规则或截图摘要变化，未确认接管失效' },
  'pending-verification': { label: '旧包·待核', color: 'purple', hint: '审批包缺少截图摘要，先待核' },
  verified: { label: '已补核·待确认', color: 'cyan', hint: '旧包已补传摘要并核为一致，确认后启用' },
  superseded: { label: '已被取代', color: 'gray', hint: '冲突仲裁后由后确认的接管单取代' },
  rejected: { label: '已驳回', color: 'red', hint: '审批包结论为驳回，保留原基线' },
}

const verdictLabel: Record<string, string> = {
  'design-change': '设计变更',
  'render-error': '渲染异常',
  'environment-noise': '环境噪声',
}

const runById = (id: string): ScreenshotRun | undefined =>
  runs.value?.find((run) => run.id === id)

// --- 模拟两窗口提交同一目标 --------------------------------------------------
const simulatorVisible = ref(false)
const simulator = reactive({
  runId: '',
  decision: 'approved' as 'approved' | 'rejected',
  includeSummary: true,
  failFirstActivation: false,
  reviewer: '林默',
})

const pendingRuns = computed(() => runs.value?.filter((run) => run.status === 'pending') ?? [])

const openSimulator = (run?: ScreenshotRun) => {
  simulator.runId =
    run?.id ?? pendingRuns.value[0]?.id ?? runs.value?.[0]?.id ?? ''
  simulator.decision = 'approved'
  simulator.includeSummary = true
  simulator.failFirstActivation = false
  simulatorVisible.value = true
}

const submitMutation = useMutation({
  mutationFn: (variables: { window: string; simulateFailure?: boolean }) => {
    const run = runById(simulator.runId)
    if (!run) throw new Error('请先选择运行')
    return getScreenshotSummary(run.id).then((summary) =>
      submitPackage({
        packageId: `pkg-${run.id}-${variables.window}`,
        runId: run.id,
        decision: simulator.decision,
        reviewer: simulator.reviewer,
        reason:
          variables.window === 'A'
            ? `窗口 A 回传审批包：${run.page} 变化已核对设计稿与验收单。`
            : `窗口 B 同时回传审批包：${run.page} 复核通过，申请接管基线。`,
        screenshotSummary: simulator.includeSummary ? summary : null,
        simulateActivationWriteFailure: variables.simulateFailure,
      }),
    )
  },
  onSuccess: async (result, variables) => {
    const label =
      result.order.status === 'active'
        ? `窗口 ${variables.window} 先到，已启用并生成基线 ${result.order.baselineId ?? ''}`
        : result.order.status === 'draft-conflict'
          ? `窗口 ${variables.window} 后到，留草稿并列冲突（冲突于 ${result.order.conflictWith}）`
          : result.order.status === 'stale'
            ? `窗口 ${variables.window} 接管失效，需重算：${result.order.staleReasons.join('；')}`
            : `窗口 ${variables.window} 审批包已待核（${result.order.status}）`
    Message.info(label)
    await refresh()
  },
  onError: async (error: Error) => {
    Message.error(error.message)
    await refresh()
  },
})

// --- 恢复 / 重算 / 确认 ------------------------------------------------------
const recoverMutation = useMutation({
  mutationFn: (batchId: string) => recoverTakeoverBatch(batchId),
  onSuccess: async (result) => {
    const generated = result.activations.filter((item) => item.applied).length
    Message.success(
      result.recovered
        ? `批次 ${result.batchId} 恢复完成，补生成 ${generated} 条基线，重放未重复`
        : `批次 ${result.batchId} 重放完成，基线已存在，未重复生成`,
    )
    await refresh()
  },
  onError: (error: Error) => Message.error(error.message),
})

const recomputeMutation = useMutation({
  mutationFn: recomputeTakeoverOrder,
  onSuccess: async (order) => {
    Message[order.status === 'stale' ? 'warning' : 'success'](
      order.status === 'stale'
        ? `重算后仍不一致：${order.staleReasons.join('；')}`
        : '截图摘要与规则已重新一致，接管单回到待确认状态',
    )
    await refresh()
  },
  onError: (error: Error) => Message.error(error.message),
})

const confirmMutation = useMutation({
  mutationFn: confirmTakeoverOrder,
  onSuccess: async (result) => {
    Message.success(
      `接管单 ${result.order.id} 已确认启用，基线 ${result.order.baselineId ?? ''} 按确认当时快照留痕`,
    )
    await refresh()
  },
  onError: (error: Error) => Message.error(error.message),
})

const attachSummaryMutation = useMutation({
  mutationFn: attachTakeoverSummary,
  onSuccess: async (order) => {
    Message.success(
      order.status === 'verified'
        ? '截图摘要已补传并核为一致，可人工确认接管'
        : '截图摘要已补传，当前与运行不一致，接管单已置为失效',
    )
    await refresh()
  },
  onError: (error: Error) => Message.error(error.message),
})

const needsRecovery = (order: TakeoverOrder): boolean =>
  order.status === 'active' && !order.baselineId

const batchesFor = (order: TakeoverOrder) =>
  batches.value?.filter((batch) => batch.orderIds.includes(order.id)) ?? []
</script>

<template>
  <section class="page-intro compact">
    <div>
      <h2>续作接管</h2>
      <p>
        运行、审批包、基线与忽略规则在同一接管单中续作：先到者启用、后到者留草稿并列冲突；
        规则或截图摘要一变，未确认接管失效重算，已批准基线永久保留当时快照。
      </p>
    </div>
    <a-space>
      <a-button @click="openSimulator()"><icon-sync /> 模拟两窗口回传</a-button>
    </a-space>
  </section>

  <a-alert type="info" style="margin-bottom: 16px">
    同页目标按「项目 / 页面 / 设备 / 主题」仲裁。完整接管批次先落库，启用写入失败后可重放恢复，重放幂等、不重复生成基线。
  </a-alert>

  <a-card class="table-panel" :bordered="false">
    <template #title>接管单</template>
    <a-table :data="takeovers" :loading="isLoading" :pagination="false" row-key="id">
      <template #columns>
        <a-table-column title="审批包 / 运行" :width="250">
          <template #cell="{ record }">
            <div class="primary-cell">
              <strong>{{ record.packageId }}</strong>
              <span>
                <router-link :to="`/runs/${record.runId}`">{{ record.runId }}</router-link>
                · {{ record.page }}
              </span>
            </div>
          </template>
        </a-table-column>
        <a-table-column title="目标（项目/页面/设备/主题）" :width="170">
          <template #cell="{ record }">
            <span class="muted">{{ record.targetKey }}</span>
          </template>
        </a-table-column>
        <a-table-column title="基准版本 / 截图摘要" :width="210">
          <template #cell="{ record }">
            <div class="summary-cell">
              <code>{{ record.baselineVersion }}</code>
              <span v-if="record.screenshotSummary">
                区域 {{ record.screenshotSummary.regionCount }} · 待判定
                {{ record.screenshotSummary.unignoredPixels.toLocaleString() }}px ·
                {{ record.screenshotSummary.digest }}
              </span>
              <a-tag v-else color="purpledot" size="small">缺摘要 · 待核</a-tag>
            </div>
          </template>
        </a-table-column>
        <a-table-column title="逐区结论" :width="190">
          <template #cell="{ record }">
            <a-space wrap :size="4">
              <a-tag
                v-for="conclusion in record.regionConclusions"
                :key="conclusion.regionId"
                size="small"
                :color="conclusion.ignored ? 'gray' : conclusion.verdict === 'render-error' ? 'red' : 'arcoblue'"
              >
                {{ conclusion.regionId.replace(/^.*-r(\d+)$/, 'R$1') }}：
                {{ conclusion.ignored ? '已忽略' : verdictLabel[conclusion.verdict] }}
              </a-tag>
            </a-space>
          </template>
        </a-table-column>
        <a-table-column title="状态" :width="140">
          <template #cell="{ record }">
            <a-tooltip :mini-content="statusMap[record.status as TakeoverStatus].hint">
              <a-tag :color="statusMap[record.status as TakeoverStatus].color">
                {{ statusMap[record.status as TakeoverStatus].label }}
              </a-tag>
            </a-tooltip>
            <div v-if="record.conflictReason" class="conflict-reason">{{ record.conflictReason }}</div>
            <div v-for="reason in record.staleReasons" :key="reason" class="stale-reason">{{ reason }}</div>
          </template>
        </a-table-column>
        <a-table-column title="启用基线" :width="150">
          <template #cell="{ record }">
            <a-tag v-if="record.baselineId" color="green" size="small">{{ record.baselineId }}</a-tag>
            <a-tag v-else-if="needsRecovery(record)" color="red" size="small">写入失败待恢复</a-tag>
            <span v-else class="muted">—</span>
          </template>
        </a-table-column>
        <a-table-column title="操作" :width="230" fixed="right">
          <template #cell="{ record }">
            <a-space :size="4" wrap>
              <a-button
                v-if="needsRecovery(record)"
                type="primary"
                size="mini"
                status="danger"
                @click="batchesFor(record).forEach((batch) => recoverMutation.mutate(batch.id))"
              >
                从批次恢复
              </a-button>
              <a-button
                v-if="record.status === 'pending-verification'"
                type="outline"
                size="mini"
                :loading="attachSummaryMutation.isPending.value"
                @click="attachSummaryMutation.mutate(record.id)"
              >
                补传摘要核
              </a-button>
              <a-button
                v-if="record.status === 'stale'"
                size="mini"
                :loading="recomputeMutation.isPending.value"
                @click="recomputeMutation.mutate(record.id)"
              >
                重算摘要
              </a-button>
              <a-button
                v-if="record.status === 'draft-conflict' || record.status === 'verified'"
                type="primary"
                size="mini"
                :loading="confirmMutation.isPending.value"
                @click="confirmMutation.mutate(record.id)"
              >
                {{ record.status === 'verified' ? '确认启用' : '确认接管' }}
              </a-button>
              <router-link v-if="record.baselineId" :to="`/baselines`">查看快照</router-link>
            </a-space>
          </template>
        </a-table-column>
      </template>
    </a-table>
  </a-card>

  <a-card class="table-panel" :bordered="false" style="margin-top: 16px">
    <template #title>完整接管批次（恢复 / 重放凭证）</template>
    <a-table :data="batches" :pagination="false" row-key="id" size="small">
      <template #columns>
        <a-table-column title="批次" data-index="id" :width="240" />
        <a-table-column title="审批包" :width="260">
          <template #cell="{ record }">{{ record.packageIds.join('，') }}</template>
        </a-table-column>
        <a-table-column title="接管单" :width="260">
          <template #cell="{ record }">{{ record.orderIds.join('，') }}</template>
        </a-table-column>
        <a-table-column title="批次状态" :width="110">
          <template #cell="{ record }">
            <a-tag :color="record.status === 'applied' ? 'green' : record.status === 'failed' ? 'red' : 'orange'">
              {{ record.status === 'applied' ? '已应用' : record.status === 'failed' ? '失败' : '已准备' }}
            </a-tag>
            <div v-if="record.error" class="stale-reason">{{ record.error }}</div>
          </template>
        </a-table-column>
        <a-table-column title="操作" :width="160">
          <template #cell="{ record }">
            <a-button
              size="mini"
              :loading="recoverMutation.isPending.value"
              @click="recoverMutation.mutate(record.id)"
            >
              重放恢复（幂等）
            </a-button>
          </template>
        </a-table-column>
      </template>
    </a-table>
  </a-card>

  <a-modal v-model:visible="simulatorVisible" title="模拟两窗口同时回传审批包" width="640px">
    <a-form :model="simulator" layout="vertical">
      <a-alert type="info" style="margin-bottom: 16px">
        先用「窗口 A 提交」启用目标，再用「窗口 B 提交」复现后到者留草稿并列冲突；勾选写入失败可验证批次恢复与幂等重放。
      </a-alert>
      <a-form-item label="选择运行（同页目标）">
        <a-select v-model="simulator.runId" allow-search>
          <a-option v-for="run in runs" :key="run.id" :value="run.id">
            {{ run.id }} · {{ run.page }} · {{ run.device }} · {{ run.status }}
          </a-option>
        </a-select>
      </a-form-item>
      <a-grid :cols="2" :col-gap="16">
        <a-grid-item>
          <a-form-item label="审批结论">
            <a-radio-group v-model="simulator.decision" type="button">
              <a-radio value="approved">批准</a-radio>
              <a-radio value="rejected">驳回</a-radio>
            </a-radio-group>
          </a-form-item>
        </a-grid-item>
        <a-grid-item>
          <a-form-item label="批准人">
            <a-input v-model="simulator.reviewer" />
          </a-form-item>
        </a-grid-item>
      </a-grid>
      <a-form-item label="审批包是否携带截图摘要（模拟旧系统缺摘要）">
        <a-switch v-model="simulator.includeSummary" />
      </a-form-item>
      <a-form-item label="窗口 A 启用时模拟 localStorage 写入失败（验证批次恢复）">
        <a-switch v-model="simulator.failFirstActivation" />
      </a-form-item>
      <template #footer>
        <a-space>
          <a-button
            type="primary"
            :loading="submitMutation.isPending.value"
            @click="submitMutation.mutate({ window: 'A', simulateFailure: simulator.failFirstActivation })"
          >
            窗口 A 提交
          </a-button>
          <a-button
            :loading="submitMutation.isPending.value"
            @click="submitMutation.mutate({ window: 'B' })"
          >
            窗口 B 提交
          </a-button>
        </a-space>
      </template>
    </a-form>
  </a-modal>
</template>
