<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Message } from '@arco-design/web-vue'
import DiffCanvas from '@/components/DiffCanvas.vue'
import StatusTag from '@/components/StatusTag.vue'
import {
  commitTakeoverApi,
  getRun,
  openTakeover,
  recomputeTakeoverApi,
  saveVerdicts,
} from '@/api/http'
import { useReviewStore } from '@/stores/review'
import type { DifferenceRegion, ReviewCategory, RegionDecision, RegionVerdict } from '@/types'

interface ReviewForm {
  category: ReviewCategory
  decision: 'approved' | 'rejected'
  reviewer: string
  reason: string
}

const route = useRoute()
const router = useRouter()
const queryClient = useQueryClient()
const reviewStore = useReviewStore()
const runId = computed(() => String(route.params.id))
const localVerdicts = ref<RegionVerdict[]>([])
const verdictsDirty = ref(false)

const clientKey = computed(() => `takeover-client:${runId.value}`)
const clientId =
  sessionStorage.getItem(clientKey.value) ??
  `window-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`
sessionStorage.setItem(clientKey.value, clientId)

const form = reactive<ReviewForm>({
  category: 'design-change',
  decision: 'approved',
  reviewer: '林默',
  reason: '',
})

const { data: run, isLoading } = useQuery({
  queryKey: computed(() => ['run', runId.value]),
  queryFn: () => getRun(runId.value),
})

const { data: takeover, isLoading: takeoverLoading, refetch: refetchTakeover } = useQuery({
  queryKey: computed(() => ['takeover', runId.value, clientId]),
  queryFn: () => openTakeover(runId.value, clientId),
})

watch(
  takeover,
  (value) => {
    if (value) {
      localVerdicts.value = value.regionVerdicts.map((verdict) => ({ ...verdict }))
      verdictsDirty.value = false
      reviewStore.setDifferenceFilter('all')
    }
  },
  { immediate: true },
)

const verdictOf = (regionId: string): RegionVerdict | undefined =>
  localVerdicts.value.find((item) => item.regionId === regionId)

const visibleRegions = computed(() =>
  (run.value?.regions ?? []).filter(
    (region) =>
      reviewStore.differenceFilter === 'all' || region.severity === reviewStore.differenceFilter,
  ),
)

const suspiciousPixels = computed(() =>
  localVerdicts.value
    .filter((verdict) => verdict.decision !== 'ignore')
    .reduce((total, verdict) => total + verdict.pixels, 0),
)

const isStale = computed(() => takeover.value?.status === 'stale')
const isDraft = computed(() => takeover.value?.status === 'draft')

const invalidateReviewData = async () => {
  await queryClient.invalidateQueries({ queryKey: ['run', runId.value] })
  await queryClient.invalidateQueries({ queryKey: ['takeover'] })
  await queryClient.invalidateQueries({ queryKey: ['runs'] })
  await queryClient.invalidateQueries({ queryKey: ['baselines'] })
  await queryClient.invalidateQueries({ queryKey: ['packages'] })
  await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  await queryClient.invalidateQueries({ queryKey: ['baseline-conflicts'] })
}

const commitMutation = useMutation({
  mutationFn: () => commitTakeoverApi(takeover.value!.id, { ...form }),
  onSuccess: async (result) => {
    if (result.package.status === 'draft-conflict') {
      Message.warning('另一窗口已先批准同一目标，本次提交保留为冲突草稿，请前往审批队列化解')
    } else if (result.package.status === 'rejected') {
      Message.success('已驳回归并保留原基线快照')
    } else {
      Message.success('接管已确认，新基线携带当时摘要快照启用')
    }
    await invalidateReviewData()
    await router.push('/approvals')
  },
  onError: (error: Error) => {
    if (error.message.startsWith('STALE_TAKEOVER')) {
      Message.warning('接管依据已变化：请先重算摘要并重新确认逐区结论')
      void refetchTakeover()
    } else {
      Message.error(error.message.replace('WRITE_FAILED:', ''))
    }
    void invalidateReviewData()
  },
})

const verdictsMutation = useMutation({
  mutationFn: () => saveVerdicts(takeover.value!.id, localVerdicts.value),
  onSuccess: async (value) => {
    Message.success('逐区结论已写入接管单')
    localVerdicts.value = value.regionVerdicts.map((verdict) => ({ ...verdict }))
    verdictsDirty.value = false
    await queryClient.invalidateQueries({ queryKey: ['takeover'] })
  },
  onError: (error: Error) => Message.error(error.message),
})

const recomputeMutation = useMutation({
  mutationFn: () => recomputeTakeoverApi(takeover.value!.id),
  onSuccess: async (result) => {
    localVerdicts.value = result.takeover.regionVerdicts.map((verdict) => ({ ...verdict }))
    verdictsDirty.value = false
    await queryClient.invalidateQueries({ queryKey: ['takeover'] })
    Message.success(
      result.changed
        ? `已按最新${result.reason === 'digest-changed' ? '截图摘要' : '忽略规则'}重算，未变区域保留人工结论`
        : '依据未变化，接管单恢复为待确认',
    )
  },
  onError: (error: Error) => Message.error(error.message),
})

const cycleVerdict = (region: DifferenceRegion) => {
  const verdict = verdictOf(region.id)
  if (!verdict) return
  const order: RegionDecision[] = ['accept', 'ignore', 'reject']
  verdict.decision = order[(order.indexOf(verdict.decision) + 1) % order.length]
  verdict.source = 'manual'
  verdict.ruleId = verdict.decision === 'ignore' ? verdict.ruleId : undefined
  verdict.note =
    verdict.decision === 'ignore' && !verdict.note ? '本窗口人工忽略' : verdict.note
  verdictsDirty.value = true
}

const handleDifferenceFilter = (value: string | number | boolean) => {
  const allowed = ['all', 'high', 'medium', 'low']
  if (allowed.includes(String(value))) {
    reviewStore.setDifferenceFilter(String(value) as 'all' | 'high' | 'medium' | 'low')
  }
}

const decisionLabel = (decision: RegionDecision) =>
  decision === 'accept' ? '采纳变化' : decision === 'ignore' ? '忽略' : '驳回区域'

const submitReview = async () => {
  if (!form.reason.trim()) {
    Message.warning('请填写审批原因')
    return
  }
  if (isStale.value) {
    Message.warning('接管单已失效，请先点击“按最新依据重算”')
    return
  }
  if (verdictsDirty.value) {
    await verdictsMutation.mutateAsync()
  }
  commitMutation.mutate()
}
</script>

<template>
  <a-spin :loading="isLoading || takeoverLoading" style="width: 100%">
    <template v-if="run && takeover">
      <section class="detail-heading">
        <div>
          <a-space>
            <h2>{{ run.name }}</h2>
            <StatusTag :status="run.status" />
          </a-space>
          <p>{{ run.page }} · {{ run.device }} · {{ run.theme === 'light' ? '浅色主题' : '深色主题' }}</p>
        </div>
        <a-space>
          <a-button @click="router.push('/runs')"><icon-left /> 返回列表</a-button>
          <a-button
            type="primary"
            :loading="commitMutation.isPending.value"
            :disabled="isStale"
            @click="submitReview"
          >
            <icon-check /> 提交审批包
          </a-button>
        </a-space>
      </section>

      <a-alert v-if="isStale" type="error" style="margin-bottom: 12px">
        <template #title>
          接管依据已变化（{{ takeover.staleReason === 'digest-changed' ? '截图摘要' : '忽略规则' }}）：未确认接管已失效，已批准基线仍保留当时快照。请重算并重新确认逐区结论。
        </template>
        <a-button size="small" type="primary" style="margin-top: 8px" :loading="recomputeMutation.isPending.value" @click="recomputeMutation.mutate()">
          <icon-refresh /> 按最新依据重算
        </a-button>
      </a-alert>
      <a-alert v-else-if="isDraft" type="warning" style="margin-bottom: 12px">
        <template #title>
          本窗口提交较晚，审批包已保留为冲突草稿，可在审批队列查看冲突并化解。
        </template>
      </a-alert>

      <div class="run-facts">
        <div><span>差异率</span><strong :class="{ danger: run.mismatchRate >= 5 }">{{ run.mismatchRate.toFixed(2) }}%</strong></div>
        <div><span>待判定像素</span><strong>{{ suspiciousPixels.toLocaleString() }}</strong></div>
        <div><span>接管单</span><strong class="mono">{{ takeover.id.slice(-10) }}</strong></div>
        <div><span>基准 → 当前</span><strong>{{ takeover.baselineVersion }} → {{ run.currentVersion }}</strong></div>
      </div>

      <div class="takeover-strip">
        <div class="takeover-item">
          <span>基准版本锁定</span>
          <code>{{ takeover.baselineVersion }}</code>
        </div>
        <div class="takeover-item">
          <span>截图摘要</span>
          <code :title="takeover.digest.digestHash">{{ takeover.digest.digestHash.slice(0, 10) }}…</code>
        </div>
        <div class="takeover-item">
          <span>规则指纹</span>
          <code :title="takeover.rulesHash">{{ takeover.rulesHash.slice(0, 10) }}…</code>
        </div>
        <div class="takeover-item">
          <span>接管状态</span>
          <a-tag :color="isStale ? 'red' : isDraft ? 'orange' : takeover.status === 'committed' ? 'green' : 'arcoblue'">
            {{ isStale ? '已失效待重算' : isDraft ? '冲突草稿' : takeover.status === 'committed' ? '已确认' : '待确认' }}
          </a-tag>
        </div>
        <div class="takeover-item">
          <span>窗口标识</span>
          <code :title="clientId">{{ clientId.slice(0, 12) }}…</code>
        </div>
      </div>

      <div class="review-workspace">
        <div class="comparison-area">
          <div class="compare-toolbar">
            <a-space>
              <span class="toolbar-label">差异筛选</span>
              <a-radio-group
                type="button"
                :model-value="reviewStore.differenceFilter"
                size="small"
                @change="handleDifferenceFilter"
              >
                <a-radio value="all">全部</a-radio>
                <a-radio value="high">高</a-radio>
                <a-radio value="medium">中</a-radio>
                <a-radio value="low">低</a-radio>
              </a-radio-group>
            </a-space>
            <a-space>
              <a-button-group size="small">
                <a-button @click="reviewStore.setZoom(reviewStore.zoom - 10)"><icon-zoom-out /></a-button>
                <a-button>{{ reviewStore.zoom }}%</a-button>
                <a-button @click="reviewStore.setZoom(reviewStore.zoom + 10)"><icon-zoom-in /></a-button>
              </a-button-group>
              <a-button size="small" @click="reviewStore.setZoom(100)"><icon-refresh /> 复位</a-button>
            </a-space>
          </div>
          <div class="canvas-grid">
            <DiffCanvas :run="run" side="baseline" :zoom="reviewStore.zoom" :regions="visibleRegions" />
            <DiffCanvas :run="run" side="current" :zoom="reviewStore.zoom" :regions="visibleRegions" />
          </div>
        </div>

        <aside class="review-panel">
          <div class="panel-title">
            <div>
              <h3>逐区结论</h3>
              <span>随接管单冻结进审批包，点击区域循环切换</span>
            </div>
            <a-space>
              <a-tag color="red">{{ localVerdicts.filter((item) => item.decision === 'reject').length }} 驳回</a-tag>
              <a-button size="mini" :loading="verdictsMutation.isPending.value" :disabled="!verdictsDirty || isStale" @click="verdictsMutation.mutate()">
                保存结论
              </a-button>
            </a-space>
          </div>
          <div class="region-list">
            <button
              v-for="region in visibleRegions"
              :key="region.id"
              class="region-item"
              :class="{ ignored: verdictOf(region.id)?.decision === 'ignore' }"
              @click="cycleVerdict(region)"
            >
              <span class="region-severity" :class="region.severity">{{ region.severity.toUpperCase() }}</span>
              <span class="region-copy">
                <strong>{{ region.kind === 'layout' ? '布局位移' : region.kind === 'color' ? '色彩变化' : region.kind === 'content' ? '内容变更' : '环境噪声' }}</strong>
                <small>区域 {{ region.x }}%, {{ region.y }}% · {{ region.pixels.toLocaleString() }} px</small>
                <small v-if="verdictOf(region.id)?.ruleId" class="sub-text">命中规则 {{ verdictOf(region.id)?.ruleId }}</small>
              </span>
              <span class="ignore-action" :class="`verdict-${verdictOf(region.id)?.decision}`">
                {{ decisionLabel(verdictOf(region.id)?.decision ?? 'accept') }}
              </span>
            </button>
          </div>

          <a-divider />

          <div class="panel-title">
            <div>
              <h3>评审结论</h3>
              <span>原因、批准人与基准版本会随审批包留痕</span>
            </div>
          </div>
          <a-form :model="form" layout="vertical" @submit-success="submitReview">
            <a-form-item field="category" label="变化类型" :rules="[{ required: true, message: '请选择变化类型' }]">
              <a-select v-model="form.category">
                <a-option value="design-change">设计变更</a-option>
                <a-option value="render-error">渲染异常</a-option>
                <a-option value="environment-noise">环境噪声</a-option>
              </a-select>
            </a-form-item>
            <a-form-item field="decision" label="审批结论" :rules="[{ required: true, message: '请选择审批结论' }]">
              <a-radio-group v-model="form.decision" type="button">
                <a-radio value="approved">回传批准包</a-radio>
                <a-radio value="rejected">回传驳回包</a-radio>
              </a-radio-group>
            </a-form-item>
            <a-form-item field="reviewer" label="批准人" :rules="[{ required: true, message: '请填写批准人' }]">
              <a-input v-model="form.reviewer" />
            </a-form-item>
            <a-form-item
              field="reason"
              label="审批原因"
              :rules="[
                { required: true, message: '请填写审批原因' },
                { minLength: 8, message: '审批原因至少 8 个字符' },
              ]"
            >
              <a-textarea
                v-model="form.reason"
                :auto-size="{ minRows: 4, maxRows: 7 }"
                placeholder="说明业务需求、设计稿或异常依据"
              />
            </a-form-item>
            <a-alert v-if="form.decision === 'approved'" type="warning" style="margin-bottom: 16px">
              同一目标若两个窗口同时提交，先到者启用新基线；本窗口若后到将自动保留为冲突草稿，不覆盖对方基线。
            </a-alert>
            <a-button
              html-type="submit"
              type="primary"
              long
              :loading="commitMutation.isPending.value"
              :disabled="isStale"
            >
              {{ isStale ? '接管已失效，请先重算' : '确认回传审批包' }}
            </a-button>
          </a-form>

          <div v-if="run.review" class="review-record">
            <h4>最近一次审批</h4>
            <dl>
              <dt>结论</dt><dd>{{ run.review.decision === 'approved' ? '已批准' : '已驳回' }}</dd>
              <dt>类型</dt><dd>{{ run.review.category }}</dd>
              <dt>人员</dt><dd>{{ run.review.reviewer }}</dd>
              <dt>时间</dt><dd>{{ run.review.reviewedAt.slice(0, 16).replace('T', ' ') }}</dd>
            </dl>
            <p>{{ run.review.reason }}</p>
          </div>
        </aside>
      </div>
    </template>
  </a-spin>
</template>
