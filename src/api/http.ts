import axios, { type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios'
import { readDb, writeDb } from '@/mocks/db'
import type {
  ApprovalPackage,
  Baseline,
  DashboardData,
  IgnoreRule,
  ImportRunPayload,
  Project,
  RegionVerdict,
  ReviewPayload,
  RunFilters,
  ScreenshotRun,
  Takeover,
  WriteBatch,
} from '@/types'
import {
  applyOps,
  attachLegacyDigest,
  buildBaseline,
  createTakeover,
  findDuplicateActiveBaselines,
  markStaleByRules,
  prepareCommit,
  recomputeTakeover,
  recoverPreparedBatches,
  resolveCommit,
  rulesFingerprint,
  targetKeyOf,
} from '@/utils/takeover'

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

const nowIso = () => new Date().toISOString()

const findRunOrThrow = (runs: ScreenshotRun[], id: string): ScreenshotRun => {
  const run = runs.find((item) => item.id === id)
  if (!run) throw new Error('运行记录不存在')
  return run
}

const activeBaselinesFor = (baselines: Baseline[], run: ScreenshotRun): Baseline[] =>
  baselines.filter(
    (item) =>
      item.active &&
      item.projectId === run.projectId &&
      item.page === run.page &&
      item.device === run.device &&
      item.theme === run.theme,
  )

interface CommitBody extends ReviewPayload {
  clientId?: string
  /** 故障注入：批次落库后、应用前模拟写入失败，用于恢复演示 */
  simulateWriteFailure?: boolean
}

/**
 * 接管提交核心：先落完整批次（prepared），再幂等应用。
 * 两窗口同一目标并发时，先完成落库者启用，后到者拿到冲突草稿。
 */
const commitTakeover = (
  db: ReturnType<typeof readDb>,
  takeoverId: string,
  body: CommitBody,
): { batch: WriteBatch; pkg: ApprovalPackage; takeover: Takeover } => {
  const takeover = db.takeovers.find((item) => item.id === takeoverId)
  if (!takeover) throw new Error('接管单不存在，请重新打开运行建立接管')
  const run = findRunOrThrow(db.runs, takeover.runId)

  if (body.decision === 'approved') {
    const precheck = resolveCommit(takeover, activeBaselinesFor(db.baselines, run))
    if (precheck.outcome === 'stale') {
      throw new Error('STALE_TAKEOVER:接管依据已变化，请重算并重新确认逐区结论后再提交')
    }
  }

  const batchId = `batch-${takeover.id}-${Date.now()}`
  const packageId = `pkg-${takeover.id}-${Date.now()}`
  const prepared = prepareCommit({
    batchId,
    packageId,
    takeover,
    run,
    review: {
      category: body.category,
      decision: body.decision,
      reviewer: body.reviewer,
      reason: body.reason,
    },
    activeBaselines: activeBaselinesFor(db.baselines, run),
    rulesHash: rulesFingerprint(db.rules),
    now: nowIso(),
  })

  db.batches.unshift(prepared.batch)
  // WAL 先持久化完整批次；此后即便应用阶段失败，也能从批次完整恢复
  writeDb(db)

  if (body.simulateWriteFailure) {
    throw new Error('WRITE_FAILED:写入中断，完整接管批次已保留，可从批次恢复')
  }

  applyOps(db, prepared.batch.ops)
  prepared.batch.status = 'committed'
  prepared.batch.attempts += 1
  prepared.batch.committedAt = nowIso()
  writeDb(db)

  const refreshed = db.takeovers.find((item) => item.id === takeover.id) ?? takeover
  return { batch: prepared.batch, pkg: prepared.pkg, takeover: refreshed }
}

/**
 * 冲突化解：人工选择保留哪条有效基线。
 * mode=activate-package 时把冲突草稿转为基线（若尚未生成）并启用。
 */
const resolveConflict = (
  db: ReturnType<typeof readDb>,
  pkg: ApprovalPackage,
  mode: 'keep-existing' | 'activate-package',
  baselineIdToKeep?: string,
): ApprovalPackage => {
  if (mode === 'activate-package') {
    const run = findRunOrThrow(db.runs, pkg.runId)
    db.baselines.forEach((baseline) => {
      if (targetKeyOf(baseline) === pkg.targetKey) baseline.active = false
    })
    const existing = pkg.activatedBaselineId
      ? db.baselines.find((item) => item.id === pkg.activatedBaselineId)
      : undefined
    if (existing) {
      existing.active = true
    } else {
      const baseline = buildBaseline({
        id: `base-${pkg.id}`,
        run,
        pkg,
        active: true,
        rulesHash: rulesFingerprint(db.rules),
        now: nowIso(),
      })
      db.baselines.unshift(baseline)
      pkg.activatedBaselineId = baseline.id
    }
    run.status = 'approved'
    if (pkg.review) run.review = { ...pkg.review, reviewedAt: nowIso() }
    pkg.status = 'active'
    pkg.committedAt = nowIso()
    writeDb(db)
    return pkg
  }

  const keep = db.baselines.find((item) => item.id === baselineIdToKeep)
  if (!keep) throw new Error('指定保留的基线不存在')
  db.baselines.forEach((baseline) => {
    if (targetKeyOf(baseline) === pkg.targetKey && baseline.id !== baselineIdToKeep) {
      baseline.active = false
    }
  })
  keep.active = true
  pkg.status = keep.runId === pkg.runId ? 'active' : 'superseded'
  pkg.committedAt = nowIso()
  writeDb(db)
  return pkg
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

  const takeoverMatch = path.match(/^\/runs\/([^/]+)\/takeover$/)
  if ((method === 'post' || method === 'get') && takeoverMatch) {
    const run = findRunOrThrow(db.runs, takeoverMatch[1])
    const clientId =
      method === 'post'
        ? (parseBody<{ clientId?: string }>(config).clientId ?? `client-${Date.now()}`)
        : String(config.params?.clientId ?? '')
    // 同一窗口重复进入复用未确认接管；已提交则新开续作接管
    const existing = db.takeovers.find(
      (item) =>
        item.runId === run.id &&
        item.clientId === clientId &&
        (item.status === 'preparing' || item.status === 'stale'),
    )
    if (existing) {
      const { changed } = recomputeTakeover(existing, run, db.rules, nowIso())
      if (changed) writeDb(db)
      return respond(config, existing, method === 'post' ? 201 : 200)
    }
    if (method === 'get') {
      return respond(config, null, 200)
    }
    const activeBaseline = activeBaselinesFor(db.baselines, run)[0]
    const takeover = createTakeover({
      id: `takeover-${run.id}-${Date.now()}`,
      run,
      rules: db.rules,
      clientId,
      now: nowIso(),
    })
    takeover.baselineId = activeBaseline?.id ?? null
    db.takeovers.unshift(takeover)
    writeDb(db)
    return respond(config, takeover, 201)
  }

  const takeoverVerdictsMatch = path.match(/^\/takeovers\/([^/]+)\/verdicts$/)
  if (method === 'put' && takeoverVerdictsMatch) {
    const takeover = db.takeovers.find((item) => item.id === takeoverVerdictsMatch[1])
    if (!takeover) throw new Error('接管单不存在')
    const body = parseBody<{ verdicts: RegionVerdict[] }>(config)
    if (!Array.isArray(body.verdicts)) throw new Error('逐区结论格式不正确')
    takeover.regionVerdicts = body.verdicts
    takeover.updatedAt = nowIso()
    writeDb(db)
    return respond(config, takeover)
  }

  const takeoverRecomputeMatch = path.match(/^\/takeovers\/([^/]+)\/recompute$/)
  if (method === 'post' && takeoverRecomputeMatch) {
    const takeover = db.takeovers.find((item) => item.id === takeoverRecomputeMatch[1])
    if (!takeover) throw new Error('接管单不存在')
    const run = findRunOrThrow(db.runs, takeover.runId)
    const result = recomputeTakeover(takeover, run, db.rules, nowIso())
    writeDb(db)
    return respond(config, { takeover: result.takeover, changed: result.changed, reason: result.reason })
  }

  const takeoverCommitMatch = path.match(/^\/takeovers\/([^/]+)\/commit$/)
  if (method === 'post' && takeoverCommitMatch) {
    const body = parseBody<CommitBody>(config)
    const result = commitTakeover(db, takeoverCommitMatch[1], body)
    return respond(
      config,
      {
        batch: result.batch,
        package: result.pkg,
        takeover: result.takeover,
        duplicates: [...findDuplicateActiveBaselines(db.baselines).keys()],
      },
      201,
    )
  }

  if (method === 'get' && path === '/packages') {
    const targetKey = config.params?.targetKey as string | undefined
    const status = config.params?.status as string | undefined
    const data = db.packages.filter(
      (pkg) =>
        (!targetKey || pkg.targetKey === targetKey) && (!status || pkg.status === status),
    )
    return respond(config, data)
  }

  const legacyVerifyMatch = path.match(/^\/packages\/([^/]+)\/verify$/)
  if (method === 'post' && legacyVerifyMatch) {
    const pkg = db.packages.find((item) => item.id === legacyVerifyMatch[1])
    if (!pkg) throw new Error('审批包不存在')
    if (pkg.status !== 'needs-verification') throw new Error('该审批包无需补核')
    const run = findRunOrThrow(db.runs, pkg.runId)
    // 旧包缺摘要先待核：补齐截图摘要后转为冲突草稿，重新走接管裁决
    attachLegacyDigest(pkg, run, db.rules, nowIso())
    pkg.conflictWith = activeBaselinesFor(db.baselines, run).map((baseline) => baseline.id)
    if (pkg.conflictWith.length > 0) pkg.conflictReason = 'newer-baseline'
    writeDb(db)
    return respond(config, pkg)
  }

  const packageResolveMatch = path.match(/^\/packages\/([^/]+)\/resolve$/)
  if (method === 'post' && packageResolveMatch) {
    const pkg = db.packages.find((item) => item.id === packageResolveMatch[1])
    if (!pkg) throw new Error('审批包不存在')
    if (pkg.status !== 'draft-conflict') throw new Error('只有冲突草稿可以化解')
    const body = parseBody<{ mode?: 'keep-existing' | 'activate-package'; keepBaselineId?: string }>(
      config,
    )
    const resolved = resolveConflict(
      db,
      pkg,
      body.mode === 'activate-package' ? 'activate-package' : 'keep-existing',
      body.keepBaselineId,
    )
    return respond(config, resolved)
  }

  if (method === 'get' && path === '/batches') {
    return respond(config, db.batches)
  }

  if (method === 'post' && path === '/batches/recover') {
    const result = recoverPreparedBatches(db, nowIso())
    writeDb(db)
    return respond(config, result, 201)
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
    // 规则一变，未确认接管立即失效重算
    markStaleByRules(db.takeovers, db.rules, nowIso())
    writeDb(db)
    return respond(config, rule, 201)
  }

  const ruleMatch = path.match(/^\/rules\/([^/]+)$/)
  if (method === 'patch' && ruleMatch) {
    const payload = parseBody<Partial<IgnoreRule>>(config)
    const rule = db.rules.find((item) => item.id === ruleMatch[1])
    if (!rule) throw new Error('规则不存在')
    Object.assign(rule, payload)
    markStaleByRules(db.takeovers, db.rules, nowIso())
    writeDb(db)
    return respond(config, rule)
  }
  if (method === 'delete' && ruleMatch) {
    const index = db.rules.findIndex((item) => item.id === ruleMatch[1])
    if (index < 0) throw new Error('规则不存在')
    db.rules.splice(index, 1)
    markStaleByRules(db.takeovers, db.rules, nowIso())
    writeDb(db)
    return respond(config, { success: true })
  }

  if (method === 'get' && path === '/takeovers') {
    const runId = config.params?.runId as string | undefined
    const data = db.takeovers.filter((takeover) => !runId || takeover.runId === runId)
    return respond(config, data)
  }

  if (method === 'get' && path === '/baseline-conflicts') {
    const duplicates = [...findDuplicateActiveBaselines(db.baselines)].map(([targetKey, list]) => ({
      targetKey,
      baselines: list,
      packages: db.packages.filter(
        (pkg) => pkg.targetKey === targetKey && pkg.status === 'draft-conflict',
      ),
    }))
    const pendingBatches = db.batches.filter((batch) => batch.status === 'prepared').length
    return respond(config, { duplicates, pendingBatches })
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
export const getTakeovers = async (runId?: string): Promise<Takeover[]> =>
  (await api.get<Takeover[]>('/takeovers', { params: { runId } })).data
export const openTakeover = async (runId: string, clientId: string): Promise<Takeover> =>
  (await api.post<Takeover>(`/runs/${runId}/takeover`, { clientId })).data
export const saveVerdicts = async (
  takeoverId: string,
  verdicts: RegionVerdict[],
): Promise<Takeover> =>
  (await api.put<Takeover>(`/takeovers/${takeoverId}/verdicts`, { verdicts })).data
export const recomputeTakeoverApi = async (
  takeoverId: string,
): Promise<{ takeover: Takeover; changed: boolean; reason?: string }> =>
  (await api.post<{ takeover: Takeover; changed: boolean; reason?: string }>(
    `/takeovers/${takeoverId}/recompute`,
    {},
  )).data

export interface CommitTakeoverResponse {
  batch: WriteBatch
  package: ApprovalPackage
  takeover: Takeover
  duplicates: string[]
}

export const commitTakeoverApi = async (
  takeoverId: string,
  payload: ReviewPayload & { simulateWriteFailure?: boolean },
): Promise<CommitTakeoverResponse> =>
  (
    await api.post<CommitTakeoverResponse>(`/takeovers/${takeoverId}/commit`, payload)
  ).data
export const getPackages = async (filters?: {
  targetKey?: string
  status?: string
}): Promise<ApprovalPackage[]> =>
  (await api.get<ApprovalPackage[]>('/packages', { params: filters })).data
export const verifyLegacyPackage = async (packageId: string): Promise<ApprovalPackage> =>
  (await api.post<ApprovalPackage>(`/packages/${packageId}/verify`, {})).data
export const resolveConflictPackage = async (
  packageId: string,
  payload: { mode: 'keep-existing' | 'activate-package'; keepBaselineId?: string },
): Promise<ApprovalPackage> =>
  (await api.post<ApprovalPackage>(`/packages/${packageId}/resolve`, payload)).data
export const getBatches = async (): Promise<WriteBatch[]> =>
  (await api.get<WriteBatch[]>('/batches')).data
export const recoverBatches = async (): Promise<{
  recovered: number
  results: Array<{ batchId: string; applied: number; skipped: number }>
}> => (await api.post('/batches/recover', {})).data
export const getBaselineConflicts = async (): Promise<{
  duplicates: Array<{ targetKey: string; baselines: Baseline[]; packages: ApprovalPackage[] }>
  pendingBatches: number
}> => (await api.get('/baseline-conflicts')).data
export const mergeRuns = async (ids: string[]): Promise<ScreenshotRun> =>
  (await api.post<ScreenshotRun>('/runs/merge', ids)).data
export const importRuns = async (payload: ImportRunPayload): Promise<ScreenshotRun[]> =>
  (await api.post<ScreenshotRun[]>('/runs/import', payload)).data
export const getBaselines = async (projectId?: string): Promise<Baseline[]> =>
  (await api.get<Baseline[]>('/baselines', { params: { projectId } })).data
export const getRules = async (): Promise<IgnoreRule[]> =>
  (await api.get<IgnoreRule[]>('/rules')).data
export const createRule = async (
  payload: Omit<IgnoreRule, 'id' | 'createdAt'>,
): Promise<IgnoreRule> => (await api.post<IgnoreRule>('/rules', payload)).data
export const toggleRule = async (id: string, enabled: boolean): Promise<IgnoreRule> =>
  (await api.patch<IgnoreRule>(`/rules/${id}`, { enabled })).data
export const deleteRule = async (id: string): Promise<{ success: boolean }> =>
  (await api.delete<{ success: boolean }>(`/rules/${id}`)).data
