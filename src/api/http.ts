import axios, { type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios'
import { readDb, writeDb } from '@/mocks/db'
import {
  computeScreenshotSummary,
  confirmTakeover,
  invalidateTakeoversForRule,
  recoverBatch,
  recomputeTakeover,
  submitApprovalPackage,
} from '@/utils/takeover'
import type {
  ApprovalPackagePayload,
  Baseline,
  DashboardData,
  IgnoreRule,
  ImportRunPayload,
  Project,
  ReviewPayload,
  RunFilters,
  ScreenshotRun,
  TakeoverBatch,
  TakeoverOrder,
  TakeoverRecoveryResult,
} from '@/types'

export const api = axios.create({
  baseURL: '/mock-api',
  timeout: 8000,
  headers: { 'Content-Type': 'application/json' },
})

const respond = <T>(config: InternalAxiosRequestConfig, data: T, status = 200) => ({
  data,
  status,
  statusText: status === 200 ? 'OK' : 'Created',
  headers: {},
  config,
})

const parseBody = <T>(config: InternalAxiosRequestConfig): T => {
  if (typeof config.data === 'string') return JSON.parse(config.data) as T
  return config.data as T
}

const mockAdapter: AxiosAdapter = async (config) => {
  await new Promise((resolve) => window.setTimeout(resolve, 180))
  const db = readDb()
  const method = (config.method ?? 'get').toLowerCase()
  const path = config.url ?? ''

  if (method === 'get' && path === '/projects') {
    return respond<Project[]>(config, db.projects)
  }

  if (method === 'get' && path === '/dashboard') {
    const dashboard: DashboardData = {
      pendingReview: db.runs.filter((run) => run.status === 'pending').length,
      approvedToday: db.runs.filter(
        (run) => run.review?.decision === 'approved' && run.review.reviewedAt.startsWith('2026-09-29'),
      ).length,
      highRisk: db.runs.filter((run) => run.mismatchRate >= 5 && run.status !== 'merged').length,
      activeBaselines: db.baselines.filter((baseline) => baseline.active).length,
      trend: [
        { date: '09-23', total: 36, failed: 7 },
        { date: '09-24', total: 42, failed: 4 },
        { date: '09-25', total: 39, failed: 9 },
        { date: '09-26', total: 47, failed: 6 },
        { date: '09-27', total: 44, failed: 5 },
        { date: '09-28', total: 52, failed: 11 },
        { date: '09-29', total: 29, failed: 8 },
      ],
    }
    return respond(config, dashboard)
  }

  if (method === 'get' && path === '/runs') {
    const filters = (config.params ?? {}) as RunFilters
    const keyword = filters.keyword?.trim().toLowerCase()
    const data = db.runs.filter((run) => {
      return (
        (!filters.projectId || run.projectId === filters.projectId) &&
        (!filters.page || run.page === filters.page) &&
        (!filters.device || run.device === filters.device) &&
        (!filters.theme || run.theme === filters.theme) &&
        (!filters.build || run.build === filters.build) &&
        (!filters.status || run.status === filters.status) &&
        (!keyword ||
          run.name.toLowerCase().includes(keyword) ||
          run.page.toLowerCase().includes(keyword) ||
          run.id.toLowerCase().includes(keyword))
      )
    })
    return respond(config, data)
  }

  const runMatch = path.match(/^\/runs\/([^/]+)$/)
  if (method === 'get' && runMatch) {
    const run = db.runs.find((item) => item.id === runMatch[1])
    if (!run) throw new Error('运行记录不存在')
    return respond(config, run)
  }

  const reviewMatch = path.match(/^\/runs\/([^/]+)\/review$/)
  if (method === 'patch' && reviewMatch) {
    const payload = parseBody<ReviewPayload>(config)
    const run = db.runs.find((item) => item.id === reviewMatch[1])
    if (!run) throw new Error('运行记录不存在')
    // 评审提交统一走续作接管：同页两窗口同时提交时，先到者启用、后到者留草稿并列冲突
    const packagePayload: ApprovalPackagePayload = {
      runId: run.id,
      decision: payload.decision,
      reviewer: payload.reviewer,
      reason: payload.reason,
      category: payload.category,
    }
    const result = submitApprovalPackage(db, packagePayload)
    const updatedRun = db.runs.find((item) => item.id === run.id) as ScreenshotRun
    return respond(config, { run: updatedRun, takeover: result.order })
  }

  if (method === 'post' && path === '/runs/merge') {
    const ids = parseBody<string[]>(config)
    const selected = db.runs.filter((run) => ids.includes(run.id))
    if (selected.length < 2) throw new Error('至少选择两条运行记录进行合并')
    const [first, ...rest] = selected
    first.mergedRunIds = selected.map((run) => run.id)
    first.status = 'merged'
    first.mismatchRate =
      selected.reduce((sum, run) => sum + run.mismatchRate, 0) / Math.max(selected.length, 1)
    first.regions = rest.flatMap((run) => run.regions).slice(0, 8)
    writeDb(db)
    return respond(config, first, 201)
  }

  if (method === 'post' && path === '/runs/import') {
    const payload = parseBody<ImportRunPayload>(config)
    if (
      !payload.projectId ||
      !payload.page.trim() ||
      !payload.device.trim() ||
      !payload.build.trim() ||
      payload.files.length === 0
    ) {
      throw new Error('项目、页面、设备、构建版本和截图文件不能为空')
    }
    const imported = payload.files.map((file, index) => {
      const runId = `run-${Date.now()}-${index + 1}`
      const mismatchRate = Number((0.8 + ((file.name.length + index * 3) % 58) / 10).toFixed(2))
      const severity = mismatchRate >= 5 ? 'high' : mismatchRate >= 2 ? 'medium' : 'low'
      const run: ScreenshotRun = {
        id: runId,
        name: `${payload.page} ${payload.device}回归`,
        projectId: payload.projectId,
        page: payload.page.trim(),
        device: payload.device.trim(),
        theme: payload.theme,
        build: payload.build.trim(),
        status: 'pending',
        mismatchRate,
        capturedAt: new Date().toISOString(),
        baselineVersion: payload.baselineVersion.trim() || '当前有效基线',
        currentVersion: payload.currentVersion.trim() || payload.build.trim(),
        baselineImage: payload.baselineImage,
        currentImage: file.dataUrl,
        regions: [
          {
            id: `${runId}-r1`,
            x: 12 + index * 3,
            y: 22 + index * 2,
            width: 24,
            height: 14,
            severity,
            pixels: Math.round(file.size / 8 || 620),
            kind: 'layout',
            ignored: false,
          },
          {
            id: `${runId}-r2`,
            x: 58,
            y: 52,
            width: 16,
            height: 10,
            severity: severity === 'high' ? 'medium' : 'low',
            pixels: Math.round(file.size / 18 || 180),
            kind: 'color',
            ignored: false,
          },
        ],
      }
      return run
    })
    db.runs.unshift(...imported)
    writeDb(db)
    return respond(config, imported, 201)
  }

  if (method === 'get' && path === '/baselines') {
    const projectId = config.params?.projectId as string | undefined
    return respond(
      config,
      db.baselines.filter((baseline) => !projectId || baseline.projectId === projectId),
    )
  }

  if (method === 'get' && path === '/rules') {
    return respond<IgnoreRule[]>(config, db.rules)
  }

  if (method === 'post' && path === '/rules') {
    const input = parseBody<Omit<IgnoreRule, 'id' | 'createdAt'>>(config)
    const rule: IgnoreRule = {
      ...input,
      id: `rule-${Date.now()}`,
      createdAt: new Date().toISOString(),
    }
    db.rules.unshift(rule)
    // 规则一变，未确认接管失效重算；已批准基线保留当时快照
    invalidateTakeoversForRule(db, rule, '创建')
    writeDb(db)
    return respond(config, rule, 201)
  }

  const ruleMatch = path.match(/^\/rules\/([^/]+)$/)
  if (method === 'patch' && ruleMatch) {
    const payload = parseBody<Partial<IgnoreRule>>(config)
    const rule = db.rules.find((item) => item.id === ruleMatch[1])
    if (!rule) throw new Error('规则不存在')
    Object.assign(rule, payload)
    invalidateTakeoversForRule(db, rule, '更新')
    writeDb(db)
    return respond(config, rule)
  }
  if (method === 'delete' && ruleMatch) {
    const index = db.rules.findIndex((item) => item.id === ruleMatch[1])
    if (index < 0) throw new Error('规则不存在')
    const [removed] = db.rules.splice(index, 1)
    invalidateTakeoversForRule(db, removed, '删除')
    writeDb(db)
    return respond(config, { success: true })
  }

  if (method === 'get' && path === '/takeovers') {
    return respond<TakeoverOrder[]>(config, db.takeovers)
  }

  if (method === 'get' && path === '/takeovers/batches') {
    return respond<TakeoverBatch[]>(config, db.batches)
  }

  const summaryMatch = path.match(/^\/runs\/([^/]+)\/screenshot-summary$/)
  if (method === 'get' && summaryMatch) {
    const targetRun = db.runs.find((item) => item.id === summaryMatch[1])
    if (!targetRun) throw new Error('运行记录不存在')
    return respond(
      config,
      computeScreenshotSummary(targetRun, db.rules),
    )
  }

  if (method === 'post' && path === '/takeovers/packages') {
    const body = parseBody<{ payload: ApprovalPackagePayload; simulateActivationWriteFailure?: boolean }>(
      config,
    )
    const result = submitApprovalPackage(db, body.payload, {
      simulateActivationWriteFailure: body.simulateActivationWriteFailure,
    })
    return respond(config, result, 201)
  }

  const takeoverActionMatch = path.match(/^\/takeovers\/([^/]+)\/(recompute|confirm|attach-summary)$/)
  if (method === 'post' && takeoverActionMatch) {
    const [, id, action] = takeoverActionMatch
    let order: TakeoverOrder
    if (action === 'recompute') {
      order = recomputeTakeover(db, id)
    } else if (action === 'confirm') {
      order = confirmTakeover(db, id).order
    } else {
      const target = db.takeovers.find((item) => item.id === id)
      if (!target) throw new Error('接管单不存在')
      const targetRun = db.runs.find((item) => item.id === target.runId)
      if (!targetRun) throw new Error('关联运行不存在，无法补核摘要')
      // 旧包补传截图摘要：以当前运行与规则现算摘要并写入，随后判定一致/失效
      const summary = computeScreenshotSummary(targetRun, db.rules)
      target.screenshotSummary = summary
      target.ruleFingerprint = summary.ruleFingerprint
      target.staleReasons = target.staleReasons.filter(
        (reason) => !reason.includes('缺少截图摘要'),
      )
      if (summary.digest !== computeScreenshotSummary(targetRun, db.rules).digest) {
        target.status = 'stale'
      } else {
        // 补核一致：进入「已补核·待确认」，人工确认后才接管启用
        target.status = 'verified'
      }
      writeDb(db)
      order = target
    }
    return respond(config, order)
  }

  const batchRecoverMatch = path.match(/^\/takeovers\/batches\/([^/]+)\/recover$/)
  if (method === 'post' && batchRecoverMatch) {
    const recovery = recoverBatch(db, batchRecoverMatch[1])
    const result: TakeoverRecoveryResult = {
      batchId: recovery.batch.id,
      recovered: recovery.activations.some((item) => item.applied),
      activations: recovery.activations,
      order: recovery.order,
    }
    return respond(config, result, 201)
  }

  throw new Error(`Mock API 未实现：${method.toUpperCase()} ${path}`)
}

api.defaults.adapter = mockAdapter

export const getProjects = async (): Promise<Project[]> => (await api.get<Project[]>('/projects')).data
export const getDashboard = async (): Promise<DashboardData> =>
  (await api.get<DashboardData>('/dashboard')).data
export const getRuns = async (filters: RunFilters = {}): Promise<ScreenshotRun[]> =>
  (await api.get<ScreenshotRun[]>('/runs', { params: filters })).data
export const getRun = async (id: string): Promise<ScreenshotRun> =>
  (await api.get<ScreenshotRun>(`/runs/${id}`)).data
export const reviewRun = async (
  id: string,
  payload: ReviewPayload,
): Promise<{ run: ScreenshotRun; takeover: TakeoverOrder }> =>
  (await api.patch(`/runs/${id}/review`, payload)).data
export const mergeRuns = async (ids: string[]): Promise<ScreenshotRun> =>
  (await api.post<ScreenshotRun>('/runs/merge', ids)).data
export const importRuns = async (payload: ImportRunPayload): Promise<ScreenshotRun[]> =>
  (await api.post<ScreenshotRun[]>('/runs/import', payload)).data
export const getBaselines = async (projectId?: string): Promise<Baseline[]> =>
  (await api.get<Baseline[]>('/baselines', { params: { projectId } })).data
export const getTakeovers = async (): Promise<TakeoverOrder[]> =>
  (await api.get<TakeoverOrder[]>('/takeovers')).data
export const getTakeoverBatches = async (): Promise<TakeoverBatch[]> =>
  (await api.get<TakeoverBatch[]>('/takeovers/batches')).data
export const getScreenshotSummary = async (
  runId: string,
): Promise<import('@/types').ScreenshotSummary> =>
  (await api.get(`/runs/${runId}/screenshot-summary`)).data
export const submitPackage = async (
  payload: ApprovalPackagePayload & { simulateActivationWriteFailure?: boolean },
): Promise<{ order: TakeoverOrder; batch: TakeoverBatch }> => {
  const { simulateActivationWriteFailure, ...approvalPayload } = payload
  return (
    await api.post('/takeovers/packages', {
      payload: approvalPayload,
      simulateActivationWriteFailure,
    })
  ).data
}
export const recomputeTakeoverOrder = async (id: string): Promise<TakeoverOrder> =>
  (await api.post<TakeoverOrder>(`/takeovers/${id}/recompute`)).data
export const attachTakeoverSummary = async (id: string): Promise<TakeoverOrder> =>
  (await api.post<TakeoverOrder>(`/takeovers/${id}/attach-summary`)).data
export const confirmTakeoverOrder = async (
  id: string,
): Promise<{ order: TakeoverOrder; batch: TakeoverBatch }> =>
  (await api.post(`/takeovers/${id}/confirm`)).data
export const recoverTakeoverBatch = async (
  batchId: string,
): Promise<TakeoverRecoveryResult> =>
  (await api.post<TakeoverRecoveryResult>(`/takeovers/batches/${batchId}/recover`)).data
export const getRules = async (): Promise<IgnoreRule[]> =>
  (await api.get<IgnoreRule[]>('/rules')).data
export const createRule = async (
  payload: Omit<IgnoreRule, 'id' | 'createdAt'>,
): Promise<IgnoreRule> => (await api.post<IgnoreRule>('/rules', payload)).data
export const toggleRule = async (id: string, enabled: boolean): Promise<IgnoreRule> =>
  (await api.patch<IgnoreRule>(`/rules/${id}`, { enabled })).data
export const deleteRule = async (id: string): Promise<{ success: boolean }> =>
  (await api.delete<{ success: boolean }>(`/rules/${id}`)).data
