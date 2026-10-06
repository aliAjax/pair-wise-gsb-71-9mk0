import type {
  ApprovalPackage,
  Baseline,
  ConflictReason,
  DifferenceRegion,
  IgnoreRule,
  PackageStatus,
  RegionVerdict,
  ReviewPayload,
  ScreenshotDigest,
  ScreenshotRun,
  Takeover,
  WriteBatch,
  WriteOp,
} from '../types'

/**
 * 续作接管领域引擎：纯函数，不依赖 localStorage / axios / DOM。
 * 负责截图摘要、规则指纹、逐区结论、并发冲突裁决和批次幂等重放。
 */

export interface TakeoverTarget {
  projectId: string
  page: string
  device: string
  theme: 'light' | 'dark'
}

export const targetKeyOf = (target: TakeoverTarget): string =>
  [target.projectId, target.page, target.device, target.theme].join('|')

/* ------------------------------------------------------------------ *
 * 稳定哈希（cyrb53），同一输入在任何窗口、任何重放中得到同一摘要
 * ------------------------------------------------------------------ */

export const cyrb53 = (input: string, seed = 0): string => {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const combined = 2097152n * BigInt(h2 >>> 0) + BigInt(h1 >>> 0)
  return combined.toString(16).padStart(13, '0')
}

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
  return `{${entries.join(',')}}`
}

const stableHash = (value: unknown, seed = 0): string => cyrb53(stableStringify(value), seed)

/* ------------------------------------------------------------------ *
 * 规则：规则指纹与匹配
 * ------------------------------------------------------------------ */

export const globMatch = (pattern: string, value: string): boolean => {
  if (!pattern || pattern === '*') return true
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(value)
}

export const ruleMatchesTarget = (rule: IgnoreRule, target: TakeoverTarget): boolean =>
  (rule.projectId === 'all' || rule.projectId === target.projectId) &&
  globMatch(rule.pagePattern, target.page) &&
  globMatch(rule.devicePattern, target.device)

/** 规则集合指纹：任一规则（含启用开关、色差阈值）变化都会改变指纹 */
export const rulesFingerprint = (rules: IgnoreRule[]): string =>
  stableHash(
    rules
      .map((rule) => ({
        id: rule.id,
        projectId: rule.projectId,
        selector: rule.selector,
        pagePattern: rule.pagePattern,
        devicePattern: rule.devicePattern,
        maxDelta: rule.maxDelta,
        enabled: rule.enabled,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    7,
  )

/* ------------------------------------------------------------------ *
 * 截图摘要
 * ------------------------------------------------------------------ */

const regionStableHash = (region: DifferenceRegion): string =>
  stableHash(
    {
      x: region.x,
      y: region.y,
      w: region.width,
      h: region.height,
      s: region.severity,
      px: region.pixels,
      k: region.kind,
    },
    11,
  )

/**
 * 依据运行的当前图、基准图、差异率和区域几何生成摘要。
 * 忽略标记属于人工结论，不参与摘要，因此切换忽略不会让截图摘要失效。
 */
export const computeDigest = (run: ScreenshotRun, now: string): ScreenshotDigest => {
  const regionHashes = run.regions
    .map((region) => ({ regionId: region.id, hash: regionStableHash(region) }))
    .sort((a, b) => (a.regionId < b.regionId ? -1 : 1))
  const currentImageHash = cyrb53(run.currentImage ?? `render:${run.id}:${run.currentVersion}`, 23)
  const baselineImageHash = run.baselineImage ? cyrb53(run.baselineImage, 29) : undefined
  const digestHash = stableHash(
    {
      run: run.id,
      baseline: run.baselineVersion,
      current: run.currentVersion,
      mismatchRate: run.mismatchRate,
      currentImageHash,
      baselineImageHash,
      regionHashes,
    },
    31,
  )
  return {
    algorithm: 'cyrb53:v1',
    digestHash,
    currentImageHash,
    baselineImageHash,
    mismatchRate: run.mismatchRate,
    regionHashes,
    computedAt: now,
  }
}

/* ------------------------------------------------------------------ *
 * 逐区结论
 * ------------------------------------------------------------------ */

const defaultVerdict = (region: DifferenceRegion, rules: IgnoreRule[]): RegionVerdict => {
  const rule = region.ruleId ? rules.find((item) => item.id === region.ruleId) : undefined
  if (rule?.enabled) {
    return {
      regionId: region.id,
      decision: 'ignore',
      source: 'rule',
      severity: region.severity,
      pixels: region.pixels,
      ruleId: rule.id,
      note: `命中启用规则「${rule.name}」`,
    }
  }
  if (region.ignored) {
    return {
      regionId: region.id,
      decision: 'ignore',
      source: 'manual',
      severity: region.severity,
      pixels: region.pixels,
      ruleId: region.ruleId,
      note: '沿用上一轮人工忽略',
    }
  }
  return {
    regionId: region.id,
    decision: 'accept',
    source: 'manual',
    severity: region.severity,
    pixels: region.pixels,
  }
}

export const buildVerdicts = (
  run: ScreenshotRun,
  rules: IgnoreRule[],
  overrides: Record<string, RegionVerdict> = {},
): RegionVerdict[] =>
  run.regions.map((region) => {
    const preserved = overrides[region.id]
    if (preserved) return { ...preserved, severity: region.severity, pixels: region.pixels }
    return defaultVerdict(region, rules)
  })

/* ------------------------------------------------------------------ *
 * 接管单
 * ------------------------------------------------------------------ */

export interface NewTakeoverInput {
  id: string
  run: ScreenshotRun
  rules: IgnoreRule[]
  clientId: string
  now: string
}

export const createTakeover = ({
  id,
  run,
  rules,
  clientId,
  now,
}: NewTakeoverInput): Takeover => {
  const activeBaselineHint = run.baselineVersion
  return {
    id,
    runId: run.id,
    clientId,
    targetKey: targetKeyOf(run),
    baselineId: null,
    baselineVersion: activeBaselineHint,
    digest: computeDigest(run, now),
    rulesHash: rulesFingerprint(rules),
    regionVerdicts: buildVerdicts(run, rules),
    status: 'preparing',
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * 重算接管单：规则或截图摘要变化时，未确认接管失效。
 * 内容未变的区域保留人工结论，区域内容变化的部分回到默认结论。
 */
export const recomputeTakeover = (
  takeover: Takeover,
  run: ScreenshotRun,
  rules: IgnoreRule[],
  now: string,
): { changed: boolean; reason?: 'rules-changed' | 'digest-changed'; takeover: Takeover } => {
  if (takeover.status === 'committed') {
    return { changed: false, takeover }
  }
  const digest = computeDigest(run, now)
  const rulesHash = rulesFingerprint(rules)
  const digestChanged = digest.digestHash !== takeover.digest.digestHash
  const rulesChanged = rulesHash !== takeover.rulesHash
  if (!digestChanged && !rulesChanged) {
    if (takeover.status === 'stale') {
      takeover.status = 'preparing'
      takeover.staleReason = undefined
      takeover.updatedAt = now
    }
    return { changed: false, takeover }
  }
  const previousHashes = new Map(takeover.digest.regionHashes.map((item) => [item.regionId, item.hash]))
  const manual = new Map(
    takeover.regionVerdicts
      .filter((verdict) => verdict.source === 'manual')
      .map((verdict) => [verdict.regionId, verdict]),
  )
  const overrides: Record<string, RegionVerdict> = {}
  digest.regionHashes.forEach((item) => {
    const manualVerdict = manual.get(item.regionId)
    if (manualVerdict && previousHashes.get(item.regionId) === item.hash) {
      overrides[item.regionId] = manualVerdict
    }
  })
  takeover.digest = digest
  takeover.rulesHash = rulesHash
  takeover.regionVerdicts = buildVerdicts(run, rules, overrides)
  takeover.status = 'stale'
  takeover.staleReason = digestChanged ? 'digest-changed' : 'rules-changed'
  takeover.updatedAt = now
  return { changed: true, reason: takeover.staleReason, takeover }
}

/** 规则变更联动：所有未确认接管（不含冲突草稿与已提交）失效 */
export const markStaleByRules = (
  takeovers: Takeover[],
  rules: IgnoreRule[],
  now: string,
): Takeover[] => {
  const hash = rulesFingerprint(rules)
  takeovers.forEach((takeover) => {
    if (takeover.status === 'preparing' && takeover.rulesHash !== hash) {
      takeover.status = 'stale'
      takeover.staleReason = 'rules-changed'
      takeover.rulesHash = hash
      takeover.updatedAt = now
    }
  })
  return takeovers
}

/* ------------------------------------------------------------------ *
 * 冲突裁决：两窗口同时提交同一目标
 * ------------------------------------------------------------------ */

export type CommitOutcome = 'activate' | 'conflict' | 'stale'

export interface CommitResolution {
  outcome: CommitOutcome
  reason?: ConflictReason
  conflictWith: string[]
  /** activate 时需要停用的旧基线（可能为空，例如目标此前没有有效基线） */
  deactivateBaselineId?: string
  newBaselineActive: boolean
}

export const resolveCommit = (
  takeover: Takeover,
  activeBaselines: Baseline[],
): CommitResolution => {
  if (takeover.status === 'stale') {
    return { outcome: 'stale', conflictWith: [], newBaselineActive: false }
  }
  if (activeBaselines.length >= 2) {
    return {
      outcome: 'conflict',
      reason: 'duplicate-active',
      conflictWith: activeBaselines.map((baseline) => baseline.id),
      newBaselineActive: false,
    }
  }
  if (activeBaselines.length === 0) {
    return { outcome: 'activate', conflictWith: [], newBaselineActive: true }
  }
  const [current] = activeBaselines
  if (takeover.baselineId && current.id === takeover.baselineId) {
    return {
      outcome: 'activate',
      deactivateBaselineId: current.id,
      conflictWith: [],
      newBaselineActive: true,
    }
  }
  return {
    outcome: 'conflict',
    reason: 'newer-baseline',
    conflictWith: [current.id],
    newBaselineActive: false,
  }
}

/** 找出同页（项目+页面+设备+主题）存在多条有效基线的目标 */
export const findDuplicateActiveBaselines = (baselines: Baseline[]): Map<string, Baseline[]> => {
  const groups = new Map<string, Baseline[]>()
  baselines
    .filter((baseline) => baseline.active)
    .forEach((baseline) => {
      const key = targetKeyOf(baseline)
      const list = groups.get(key) ?? []
      list.push(baseline)
      groups.set(key, list)
    })
  return new Map([...groups].filter(([, list]) => list.length >= 2))
}

/* ------------------------------------------------------------------ *
 * 审批包与基线
 * ------------------------------------------------------------------ */

export interface BuildPackageInput {
  id: string
  takeover: Takeover
  run: ScreenshotRun
  review: ReviewPayload | null
  now: string
}

export const buildPackage = ({
  id,
  takeover,
  run,
  review,
  now,
}: BuildPackageInput): ApprovalPackage => ({
  id,
  takeoverId: takeover.id,
  runId: run.id,
  clientId: takeover.clientId,
  targetKey: takeover.targetKey,
  baselineVersion: takeover.baselineVersion,
  currentVersion: run.currentVersion,
  review,
  digest: takeover.digest,
  regionVerdicts: takeover.regionVerdicts.map((verdict) => ({ ...verdict })),
  status: 'needs-verification',
  conflictWith: [],
  submittedAt: now,
})

export interface BuildBaselineInput {
  id: string
  run: ScreenshotRun
  pkg: ApprovalPackage
  active: boolean
  rulesHash: string
  now: string
}

export const buildBaseline = ({
  id,
  run,
  pkg,
  active,
  rulesHash,
  now,
}: BuildBaselineInput): Baseline => ({
  id,
  projectId: run.projectId,
  page: run.page,
  device: run.device,
  theme: run.theme,
  version: run.currentVersion,
  approvedBy: pkg.review?.reviewer ?? '未知评审人',
  reason: pkg.review?.reason ?? '接管审批包回传',
  approvedAt: now,
  runId: run.id,
  active,
  snapshot: {
    digestHash: pkg.digest?.digestHash ?? 'missing',
    rulesHash,
    verdictCount: pkg.regionVerdicts.length,
    frozenAt: now,
  },
})

/* ------------------------------------------------------------------ *
 * 写入批次（WAL）：先 prepared，再幂等应用
 * ------------------------------------------------------------------ */

export interface MinimalDb {
  runs: ScreenshotRun[]
  baselines: Baseline[]
  packages: ApprovalPackage[]
  takeovers: Takeover[]
}

export interface PreparedCommit {
  batch: WriteBatch
  pkg: ApprovalPackage
  baseline?: Baseline
  resolution: CommitResolution
}

export interface PrepareCommitInput {
  batchId: string
  packageId: string
  takeover: Takeover
  run: ScreenshotRun
  review: ReviewPayload | null
  activeBaselines: Baseline[]
  rulesHash: string
  now: string
}

/**
 * 组装完整接管批次：同一目标下先到者生成 active 基线并停用旧基线，
 * 后到者只落冲突草稿；驳回不生成基线。所有副作用都编码为幂等 WriteOp。
 */
export const prepareCommit = ({
  batchId,
  packageId,
  takeover,
  run,
  review,
  activeBaselines,
  rulesHash,
  now,
}: PrepareCommitInput): PreparedCommit => {
  const pkg = buildPackage({ id: packageId, takeover, run, review, now })
  const resolution = resolveCommit(takeover, activeBaselines)
  const ops: WriteOp[] = []
  let baseline: Baseline | undefined

  if (review?.decision === 'rejected') {
    pkg.status = 'rejected'
    pkg.committedAt = now
    ops.push(
      { type: 'upsert-package', id: `package:${pkg.id}`, payload: pkg },
      {
        type: 'update-run-review',
        id: `review:${run.id}:${pkg.id}`,
        payload: { runId: run.id, status: 'rejected', review: { ...review, reviewedAt: now } },
      },
      {
        type: 'set-takeover-status',
        id: `takeover:${takeover.id}:${pkg.id}`,
        payload: { takeoverId: takeover.id, status: 'committed', packageId: pkg.id, conflictWith: [] },
      },
    )
  } else if (resolution.outcome === 'conflict') {
    pkg.status = 'draft-conflict'
    pkg.conflictWith = resolution.conflictWith
    pkg.conflictReason = resolution.reason
    ops.push({ type: 'upsert-package', id: `package:${pkg.id}`, payload: pkg })
    ops.push({
      type: 'set-takeover-status',
      id: `takeover:${takeover.id}:${pkg.id}`,
      payload: {
        takeoverId: takeover.id,
        status: 'draft',
        packageId: pkg.id,
        conflictWith: resolution.conflictWith,
      },
    })
  } else if (resolution.outcome === 'stale') {
    // 由调用方在落批次前拦截，这里仅兜底
    pkg.status = 'draft-conflict'
    pkg.conflictReason = 'newer-baseline'
    ops.push({ type: 'upsert-package', id: `package:${pkg.id}`, payload: pkg })
  } else {
    if (resolution.deactivateBaselineId) {
      ops.push({
        type: 'deactivate-baseline',
        id: `deactivate:${resolution.deactivateBaselineId}:${pkg.id}`,
        payload: { baselineId: resolution.deactivateBaselineId },
      })
    }
    baseline = buildBaseline({
      id: `base-${pkg.id}`,
      run,
      pkg,
      active: true,
      rulesHash,
      now,
    })
    pkg.status = 'active'
    pkg.activatedBaselineId = baseline.id
    pkg.committedAt = now
    ops.push(
      { type: 'create-baseline', id: `create:${baseline.id}`, payload: baseline },
      { type: 'upsert-package', id: `package:${pkg.id}`, payload: pkg },
      {
        type: 'update-run-review',
        id: `review:${run.id}:${pkg.id}`,
        payload: { runId: run.id, status: 'approved', review: { ...review, reviewedAt: now } },
      },
      {
        type: 'set-takeover-status',
        id: `takeover:${takeover.id}:${pkg.id}`,
        payload: { takeoverId: takeover.id, status: 'committed', packageId: pkg.id, conflictWith: [] },
      },
    )
  }

  const batch: WriteBatch = {
    id: batchId,
    takeoverId: takeover.id,
    packageId: pkg.id,
    targetKey: takeover.targetKey,
    ops,
    status: 'prepared',
    attempts: 0,
    preparedAt: now,
  }
  return { batch, pkg, baseline, resolution }
}

export interface ApplyResult {
  applied: number
  skipped: number
}

/** 幂等应用批次操作；重复重放不会重复生成基线 */
export const applyOps = (db: MinimalDb, ops: WriteOp[]): ApplyResult => {
  let applied = 0
  let skipped = 0
  ops.forEach((op) => {
    const payload = (op.payload ?? {}) as Record<string, unknown>
    switch (op.type) {
      case 'deactivate-baseline': {
        const target = db.baselines.find((item) => item.id === payload.baselineId)
        if (target && target.active) {
          target.active = false
          applied += 1
        } else {
          skipped += 1
        }
        break
      }
      case 'create-baseline': {
        const candidate = payload as unknown as Baseline
        if (db.baselines.some((item) => item.id === candidate.id)) {
          skipped += 1
        } else {
          db.baselines.unshift(candidate)
          applied += 1
        }
        break
      }
      case 'upsert-package': {
        const candidate = payload as unknown as ApprovalPackage
        const index = db.packages.findIndex((item) => item.id === candidate.id)
        if (index >= 0) {
          if (JSON.stringify(db.packages[index]) === JSON.stringify(candidate)) {
            skipped += 1
          } else {
            db.packages[index] = candidate
            applied += 1
          }
        } else {
          db.packages.unshift(candidate)
          applied += 1
        }
        break
      }
      case 'update-run-review': {
        const target = db.runs.find((item) => item.id === payload.runId)
        if (!target) {
          skipped += 1
          break
        }
        const nextStatus = payload.status as ScreenshotRun['status']
        const nextReview = payload.review as ScreenshotRun['review']
        const alreadyLanded =
          target.status === nextStatus && JSON.stringify(target.review) === JSON.stringify(nextReview)
        target.status = nextStatus
        target.review = nextReview
        if (alreadyLanded) skipped += 1
        else applied += 1
        break
      }
      case 'set-takeover-status': {
        const target = db.takeovers.find((item) => item.id === payload.takeoverId)
        if (!target) {
          skipped += 1
          break
        }
        const nextStatus = payload.status as Takeover['status']
        const nextPackageId = payload.packageId as string | undefined
        const nextConflictWith = payload.conflictWith as string[] | undefined
        const alreadyLanded =
          target.status === nextStatus &&
          target.packageId === nextPackageId &&
          JSON.stringify(target.conflictWith ?? []) === JSON.stringify(nextConflictWith ?? [])
        target.status = nextStatus
        target.packageId = nextPackageId
        target.conflictWith = nextConflictWith
        if (target.status === 'committed') target.staleReason = undefined
        if (alreadyLanded) skipped += 1
        else applied += 1
        break
      }
    }
  })
  return { applied, skipped }
}

/** 从所有 prepared 批次恢复；重放幂等，已落库的基线不会再生成一次 */
export const recoverPreparedBatches = (
  db: MinimalDb & { batches?: WriteBatch[] },
  now: string,
): { recovered: number; results: Array<{ batchId: string } & ApplyResult> } => {
  const results: Array<{ batchId: string } & ApplyResult> = []
  const pending = (db.batches ?? []).filter((batch) => batch.status === 'prepared')
  pending.forEach((batch) => {
    const result = applyOps(db, batch.ops)
    batch.status = 'committed'
    batch.attempts += 1
    batch.committedAt = now
    results.push({ batchId: batch.id, ...result })
  })
  return { recovered: pending.length, results }
}

/** 旧审批包补齐摘要：旧包缺摘要先待核，补齐后回到正常接管提交路径 */
export const attachLegacyDigest = (
  pkg: ApprovalPackage,
  run: ScreenshotRun,
  rules: IgnoreRule[],
  now: string,
): ApprovalPackage => {
  pkg.digest = computeDigest(run, now)
  pkg.regionVerdicts = buildVerdicts(run, rules)
  pkg.status = 'draft-conflict'
  pkg.committedAt = undefined
  return pkg
}

export const packageStatusOf = (pkg: ApprovalPackage): PackageStatus => pkg.status
