import type {
  ApprovalPackagePayload,
  Baseline,
  DifferenceRegion,
  IgnoreRule,
  RegionConclusion,
  ReviewCategory,
  ReviewRecord,
  ScreenshotRun,
  ScreenshotSummary,
  TakeoverActivation,
  TakeoverBatch,
  TakeoverOrder,
} from '@/types'
import { writeDb, type Database } from '@/mocks/db'

export interface PersistMeta {
  /** prepare：完整批次/接管单先落库；commit：启用结果（基线）提交 */
  phase: 'prepare' | 'commit' | 'sync'
  /** 模拟本次提交写入失败（仅 commit 阶段有意义） */
  fault?: boolean
  /**
   * 提交失败时回滚到阶段一已提交快照。
   * 存储为原子写（localStorage.setItem）：失败时调用方内存状态需同步回到已落库快照。
   */
  rollback?: (snapshot: Database) => void
  /** 阶段一已提交快照 */
  preparedSnapshot?: Database
}

type Persister = (db: Database, meta: PersistMeta) => void

const defaultPersister: Persister = (db, meta) => {
  if (meta.phase === 'commit' && meta.fault) {
    // 模拟存储原子提交失败：内存回滚到阶段一已提交快照后抛出，存储保持阶段一内容
    if (meta.preparedSnapshot && meta.rollback) {
      meta.rollback(meta.preparedSnapshot)
    }
    throw new Error('localStorage 写入失败（模拟）')
  }
  writeDb(db)
}

let persistImpl: Persister = defaultPersister

/** 注入持久化实现（测试环境使用内存写入，浏览器默认写 localStorage） */
export const setPersister = (writer: Persister): void => {
  persistImpl = writer
}

const cloneDb = (source: Database): Database => ({
  projects: JSON.parse(JSON.stringify(source.projects)),
  runs: JSON.parse(JSON.stringify(source.runs)),
  baselines: JSON.parse(JSON.stringify(source.baselines)),
  rules: JSON.parse(JSON.stringify(source.rules)),
  takeovers: JSON.parse(JSON.stringify(source.takeovers)),
  batches: JSON.parse(JSON.stringify(source.batches)),
})

const replaceDb = (target: Database, source: Database): void => {
  target.projects = source.projects
  target.runs = source.runs
  target.baselines = source.baselines
  target.rules = source.rules
  target.takeovers = source.takeovers
  target.batches = source.batches
}

const persist = (db: Database, meta: PersistMeta = { phase: 'sync' }) => persistImpl(db, meta)

/** 同页目标键：项目 + 页面 + 设备 + 主题，两窗口提交同一目标据此判定 */
export const targetKeyOf = (
  target: Pick<ScreenshotRun, 'projectId' | 'page' | 'device' | 'theme'>,
): string => `${target.projectId}|${target.page}|${target.device}|${target.theme}`

const stableHash = (input: string): string => {
  let hash = 5381
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 规则指纹：任一启用状态、选择器或阈值变化都会改变 */
export const ruleFingerprint = (rules: IgnoreRule[]): string => {
  const canonical = rules
    .map((rule) =>
      [
        rule.id,
        rule.projectId,
        rule.selector,
        rule.pagePattern,
        rule.devicePattern,
        rule.maxDelta,
        rule.enabled ? 1 : 0,
      ].join('~'),
    )
    .sort()
    .join('||')
  return stableHash(canonical)
}

/** 由运行当前差异区域与规则计算截图摘要 */
export const computeScreenshotSummary = (
  run: ScreenshotRun,
  rules: IgnoreRule[],
): ScreenshotSummary => {
  const fingerprint = ruleFingerprint(rules)
  const totalPixels = run.regions.reduce((sum, region) => sum + region.pixels, 0)
  const unignoredPixels = run.regions
    .filter((region) => !region.ignored)
    .reduce((sum, region) => sum + region.pixels, 0)
  const regionDigest = run.regions
    .map((region) =>
      [region.id, region.kind, region.severity, region.pixels, region.ignored ? 1 : 0, region.ruleId ?? ''].join(':'),
    )
    .join('|')
  return {
    regionCount: run.regions.length,
    totalPixels,
    unignoredPixels,
    mismatchRate: run.mismatchRate,
    ruleFingerprint: fingerprint,
    digest: stableHash(`${regionDigest}#${run.mismatchRate}#${fingerprint}`),
  }
}

const verdictOf = (region: DifferenceRegion, category?: ReviewCategory): RegionConclusion['verdict'] => {
  if (region.ignored || region.kind === 'environment') return 'environment-noise'
  if (category) return category
  if (region.kind === 'layout' && region.severity === 'high') return 'render-error'
  return 'design-change'
}

/** 审批包未携带逐区结论时，由运行区域补齐默认结论 */
export const deriveConclusions = (
  run: ScreenshotRun,
  category?: ReviewCategory,
): RegionConclusion[] =>
  run.regions.map((region) => ({
    regionId: region.id,
    kind: region.kind,
    severity: region.severity,
    pixels: region.pixels,
    verdict: verdictOf(region, category),
    ignored: region.ignored,
    ruleId: region.ruleId,
  }))

const nowIso = (): string => new Date().toISOString()

/** 单调序号：同毫秒内多次落库（提交、确认、恢复）也不会产生重复 ID */
let sequence = 0
const seqSuffix = (): string => {
  sequence = (sequence + 1) % 0xfffff
  return sequence.toString(36).padStart(3, '0')
}

const appendReason = (reasons: string[], reason: string) => {
  if (!reasons.includes(reason)) reasons.push(reason)
}

/**
 * 幂等启用：同一审批包重放不会重复生成基线。
 * 停用同页旧基线后，以批准当时快照创建唯一有效基线。
 */
const activateOrder = (db: Database, order: TakeoverOrder, run: ScreenshotRun): Baseline => {
  const existing = db.baselines.find((baseline) => baseline.snapshot?.packageId === order.packageId)
  if (existing) {
    order.baselineId = existing.id
    order.snapshot = existing.snapshot
    return existing
  }

  db.baselines.forEach((baseline) => {
    if (
      baseline.active &&
      baseline.projectId === run.projectId &&
      baseline.page === run.page &&
      baseline.device === run.device &&
      baseline.theme === run.theme
    ) {
      baseline.active = false
    }
  })

  const baseline: Baseline = {
    id: `base-${Date.now()}-${seqSuffix()}-${stableHash(order.packageId).slice(0, 4)}`,
    projectId: run.projectId,
    page: run.page,
    device: run.device,
    theme: run.theme,
    version: run.currentVersion,
    approvedBy: order.reviewer,
    reason: order.reason,
    approvedAt: order.receivedAt,
    runId: run.id,
    active: true,
    snapshot: {
      baselineVersion: order.baselineVersion,
      screenshotSummary: order.screenshotSummary,
      ruleFingerprint: order.ruleFingerprint,
      regionConclusions: order.regionConclusions,
      packageId: order.packageId,
      activatedBy: order.reviewer,
      activatedAt: nowIso(),
    },
  }
  db.baselines.unshift(baseline)
  order.baselineId = baseline.id
  order.snapshot = baseline.snapshot
  order.resolvedAt = nowIso()
  return baseline
}

const stampRunReview = (run: ScreenshotRun, order: TakeoverOrder) => {
  const record: ReviewRecord = {
    category: order.regionConclusions.find((item) => !item.ignored)?.verdict ?? 'design-change',
    decision: order.decision,
    reviewer: order.reviewer,
    reason: order.reason,
    reviewedAt: order.receivedAt,
  }
  run.review = record
}

export interface SubmitOptions {
  /** 模拟启用阶段写入失败，用于验证完整批次恢复 */
  simulateActivationWriteFailure?: boolean
}

export interface SubmitResult {
  order: TakeoverOrder
  batch: TakeoverBatch
  recovered?: boolean
}

const findBatchOfOrder = (db: Database, orderId: string): TakeoverBatch | undefined =>
  db.batches.find((batch) => batch.orderIds.includes(orderId))

/**
 * 审批包回传：续作接管的统一入口（审批窗口与接管页面都走这里）。
 * 先到者启用并生成基线；后到者留草稿并列冲突；旧包缺摘要先待核。
 */
export const submitApprovalPackage = (
  db: Database,
  input: ApprovalPackagePayload,
  options: SubmitOptions = {},
): SubmitResult => {
  const run = db.runs.find((item) => item.id === input.runId)
  if (!run) throw new Error('运行记录不存在，无法接管审批包')

  const packageId = input.packageId ?? `pkg-${Date.now()}-${seqSuffix()}-${stableHash(run.id).slice(0, 4)}`

  // 同一审批包重复提交：直接回到恢复路径，绝不重复启用
  const known = db.takeovers.find((order) => order.packageId === packageId)
  if (known) {
    const knownBatch = findBatchOfOrder(db, known.id)
    if (known.status === 'active' && !known.baselineId && knownBatch) {
      return { ...recoverBatch(db, knownBatch.id), recovered: true }
    }
    if (knownBatch) return { order: known, batch: knownBatch, recovered: true }
  }

  const receivedAt = input.receivedAt ?? nowIso()
  const fingerprint = ruleFingerprint(db.rules)
  // 旧审批包显式缺摘要（null/undefined）时先待核，绝不拿运行现态冒充包摘要
  const providedSummary =
    input.screenshotSummary === undefined
      ? computeScreenshotSummary(run, db.rules)
      : input.screenshotSummary ?? null
  const conclusions =
    input.regionConclusions && input.regionConclusions.length > 0
      ? input.regionConclusions
      : deriveConclusions(run, input.category)

  const orderId = `takeover-${Date.now()}-${seqSuffix()}-${stableHash(packageId).slice(0, 5)}`
  const batchId = `batch-${Date.now()}-${seqSuffix()}-${stableHash(packageId).slice(0, 5)}`
  const staleReasons: string[] = []

  const order: TakeoverOrder = {
    id: orderId,
    packageId,
    runId: run.id,
    projectId: run.projectId,
    page: run.page,
    device: run.device,
    theme: run.theme,
    targetKey: targetKeyOf(run),
    baselineVersion: run.baselineVersion,
    screenshotSummary: providedSummary,
    regionConclusions: conclusions,
    decision: input.decision,
    reviewer: input.reviewer,
    reason: input.reason,
    status: 'pending-verification',
    staleReasons,
    ruleFingerprint: fingerprint,
    batchId,
    receivedAt,
  }

  const batch: TakeoverBatch = {
    id: batchId,
    packageIds: [packageId],
    orderIds: [orderId],
    status: 'prepared',
    preparedAt: receivedAt,
  }

  if (!providedSummary) {
    appendReason(staleReasons, '旧审批包缺少截图摘要，先待核，补传摘要后再启用')
    order.status = 'pending-verification'
  } else {
    const fresh = computeScreenshotSummary(run, db.rules)
    if (providedSummary.ruleFingerprint !== fresh.ruleFingerprint) {
      appendReason(staleReasons, '忽略规则已变化，接管单记录的规则指纹失效，需重算')
    }
    if (providedSummary.digest !== fresh.digest) {
      appendReason(staleReasons, '截图摘要与当前运行不一致（区域、像素或差异率已变化），需重算')
    }

    if (staleReasons.length > 0) {
      order.status = 'stale'
    } else if (input.decision === 'rejected') {
      order.status = 'rejected'
      run.status = 'rejected'
      stampRunReview(run, order)
    } else {
      // 同页目标只允许一个先到者启用（以已落库的 active 接管单为准）
      const winner = db.takeovers.find(
        (item) => item.targetKey === order.targetKey && item.status === 'active',
      )
      if (winner) {
        order.status = 'draft-conflict'
        order.conflictWith = winner.id
        order.conflictReason = `同一目标已由先到审批包 ${winner.packageId} 启用，本包留草稿并列冲突`
      } else {
        // 先到者：第一阶段只落接管单与完整批次，第二阶段才生成基线
        order.status = 'active'
      }
    }
  }

  db.takeovers.unshift(order)
  db.batches.unshift(batch)
  // 阶段一：完整接管批次先持久化，后续写入失败可凭它恢复
  persist(db, { phase: 'prepare' })
  const preparedSnapshot = cloneDb(db)

  if (order.status === 'active') {
    try {
      activateOrder(db, order, run)
      run.status = 'approved'
      stampRunReview(run, order)
      batch.status = 'applied'
      batch.appliedAt = nowIso()
      // 阶段二：启用结果提交；写入失败时回滚到阶段一快照，可从完整批次恢复
      persist(db, {
        phase: 'commit',
        fault: options.simulateActivationWriteFailure,
        preparedSnapshot,
        rollback: (snapshot) => replaceDb(db, snapshot),
      })
      return { order, batch }
    } catch (error) {
      // 启用写入失败：批次与接管单已在阶段一落库，等待恢复重放
      const message = error instanceof Error ? error.message : '未知写入错误'
      throw new Error(`接管批次 ${batchId} 启用写入失败（${message}），可从完整批次恢复`)
    }
  }

  batch.status = 'applied'
  batch.appliedAt = nowIso()
  persist(db, { phase: 'sync' })
  return { order, batch }
}

/** 写入失败后从完整接管批次恢复；重放幂等，不重复生成基线 */
export const recoverBatch = (
  db: Database,
  batchId: string,
): { batch: TakeoverBatch; order: TakeoverOrder; activations: TakeoverActivation[] } => {
  const batch = db.batches.find((item) => item.id === batchId)
  if (!batch) throw new Error('接管批次不存在，无法恢复')

  const activations: TakeoverActivation[] = []
  for (const orderId of batch.orderIds) {
    const order = db.takeovers.find((item) => item.id === orderId)
    if (!order) {
      batch.status = 'failed'
      batch.error = `接管单 ${orderId} 缺失，批次无法完整恢复`
      persist(db)
      throw new Error(batch.error)
    }

    if (order.status === 'active') {
      const already = db.baselines.find(
        (baseline) => baseline.snapshot?.packageId === order.packageId,
      )
      if (order.baselineId && already) {
        activations.push({
          targetKey: order.targetKey,
          runId: order.runId,
          packageId: order.packageId,
          orderId: order.id,
          baselineId: already.id,
          applied: false,
        })
        continue
      }
      const run = db.runs.find((item) => item.id === order.runId)
      if (!run) {
        batch.status = 'failed'
        batch.error = `运行 ${order.runId} 缺失，接管基线无法生成`
        persist(db)
        throw new Error(batch.error)
      }
      const baseline = activateOrder(db, order, run)
      run.status = 'approved'
      stampRunReview(run, order)
      activations.push({
        targetKey: order.targetKey,
        runId: order.runId,
        packageId: order.packageId,
        orderId: order.id,
        baselineId: baseline.id,
        applied: true,
      })
    }
  }

  batch.status = 'applied'
  batch.error = undefined
  batch.appliedAt = nowIso()
  persist(db)
  const order = db.takeovers.find((item) => item.id === batch.orderIds[0]) as TakeoverOrder
  return { batch, order, activations }
}

/** 规则或截图变化后重算单个接管单；重新一致则回到待确认/冲突草稿，否则置为失效 */
export const recomputeTakeover = (db: Database, orderId: string): TakeoverOrder => {
  const order = db.takeovers.find((item) => item.id === orderId)
  if (!order) throw new Error('接管单不存在')
  const run = db.runs.find((item) => item.id === order.runId)
  if (!run) throw new Error('关联运行不存在，无法重算')

  if (!order.screenshotSummary) {
    return order
  }

  const reasons: string[] = []
  const fresh = computeScreenshotSummary(run, db.rules)
  if (order.screenshotSummary.ruleFingerprint !== fresh.ruleFingerprint) {
    appendReason(reasons, '忽略规则已变化，接管单记录的规则指纹失效，需重算')
  }
  if (order.screenshotSummary.digest !== fresh.digest) {
    appendReason(reasons, '截图摘要与当前运行不一致（区域、像素或差异率已变化），需重算')
  }

  order.staleReasons = reasons
  if (reasons.length > 0) {
    // 已批准（active）基线的接管单受快照保护，不降级；仅未确认单失效
    if (order.status !== 'active') order.status = 'stale'
  } else if (order.status === 'stale') {
    // 重算后恢复一致：有冲突指向回到冲突草稿，否则进入已补核·待确认
    order.status = order.conflictWith ? 'draft-conflict' : 'verified'
  }
  persist(db)
  return order
}

export interface ConfirmResult {
  order: TakeoverOrder
  batch: TakeoverBatch
}

/** 人工确认未接管成功的草稿/已补核单：重算一致后取代当前先到者并启用 */
export const confirmTakeover = (db: Database, orderId: string): ConfirmResult => {
  const order = db.takeovers.find((item) => item.id === orderId)
  if (!order) throw new Error('接管单不存在')

  if (order.status === 'pending-verification' || !order.screenshotSummary) {
    throw new Error('旧审批包缺少截图摘要，请先补传摘要完成待核')
  }
  if (order.status === 'stale') {
    throw new Error('接管单已因规则或截图摘要变化失效，请先重算一致后再确认')
  }
  if (order.status !== 'draft-conflict' && order.status !== 'verified') {
    throw new Error(`当前状态（${order.status}）无需人工确认或不允许确认`)
  }

  const run = db.runs.find((item) => item.id === order.runId)
  if (!run) throw new Error('关联运行不存在，无法确认接管')

  const fresh = computeScreenshotSummary(run, db.rules)
  if (order.screenshotSummary.digest !== fresh.digest) {
    order.status = 'stale'
    appendReason(order.staleReasons, '截图摘要与当前运行不一致（区域、像素或差异率已变化），需重算')
    persist(db)
    throw new Error('接管单与当前截图/规则不一致，已置为失效，请重算后重新提交审批包')
  }

  const batch: TakeoverBatch = {
    id: `batch-${Date.now()}-${seqSuffix()}-${stableHash(order.packageId).slice(0, 5)}`,
    packageIds: [order.packageId],
    orderIds: [order.id],
    status: 'prepared',
    preparedAt: nowIso(),
  }

  // 后到者经人工确认后取得启用权：原先进到的接管单转为被取代，其基线快照保留
  const winner = db.takeovers.find(
    (item) => item.targetKey === order.targetKey && item.status === 'active' && item.id !== order.id,
  )
  if (winner) {
    winner.status = 'superseded'
    winner.resolvedAt = nowIso()
  }
  order.status = 'active'
  order.batchId = batch.id
  order.staleReasons = []

  db.batches.unshift(batch)
  persist(db)

  activateOrder(db, order, run)
  run.status = 'approved'
  stampRunReview(run, order)
  batch.status = 'applied'
  batch.appliedAt = nowIso()
  persist(db)
  return { order, batch }
}

/**
 * 规则增删改后调用：仅波及未确认接管单（待核/冲突草稿/失效）。
 * 已批准基线与其接管单不动，快照永久保留。
 */
export const invalidateTakeoversForRule = (
  db: Database,
  rule: Pick<IgnoreRule, 'id' | 'name' | 'projectId'>,
  action: '创建' | '更新' | '删除' | '启停',
): number => {
  let affected = 0
  for (const order of db.takeovers) {
    if (order.status === 'active' || order.status === 'superseded' || order.status === 'rejected') {
      continue
    }
    const inScope = rule.projectId === 'all' || rule.projectId === order.projectId
    if (!inScope) continue
    affected += 1
    order.status = 'stale'
    appendReason(
      order.staleReasons,
      `忽略规则“${rule.name}”已${action}，规则指纹变化，接管失效需重算`,
    )
  }
  return affected
}
