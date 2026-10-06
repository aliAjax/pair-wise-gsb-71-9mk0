export type ReviewCategory = 'design-change' | 'render-error' | 'environment-noise'
export type RunStatus = 'pending' | 'approved' | 'rejected' | 'merged'
export type Severity = 'high' | 'medium' | 'low'

export interface Project {
  id: string
  name: string
  code: string
  owner: string
  pageCount: number
}

export interface DifferenceRegion {
  id: string
  x: number
  y: number
  width: number
  height: number
  severity: Severity
  pixels: number
  kind: 'layout' | 'content' | 'color' | 'environment'
  ignored: boolean
  ruleId?: string
}

export interface ReviewRecord {
  category: ReviewCategory
  decision: 'approved' | 'rejected'
  reviewer: string
  reason: string
  reviewedAt: string
}

export interface ScreenshotRun {
  id: string
  name: string
  projectId: string
  page: string
  device: string
  theme: 'light' | 'dark'
  build: string
  status: RunStatus
  mismatchRate: number
  capturedAt: string
  baselineVersion: string
  currentVersion: string
  baselineImage?: string
  currentImage?: string
  regions: DifferenceRegion[]
  review?: ReviewRecord
  mergedRunIds?: string[]
}

export interface Baseline {
  id: string
  projectId: string
  page: string
  device: string
  theme: 'light' | 'dark'
  version: string
  approvedBy: string
  reason: string
  approvedAt: string
  runId: string
  active: boolean
  /** 批准时刻冻结的摘要与规则指纹；历史基线可能为空 */
  snapshot?: BaselineSnapshot
}

export interface IgnoreRule {
  id: string
  name: string
  projectId: string
  selector: string
  pagePattern: string
  devicePattern: string
  maxDelta: number
  enabled: boolean
  createdAt: string
}

export interface DashboardData {
  pendingReview: number
  approvedToday: number
  highRisk: number
  activeBaselines: number
  trend: Array<{ date: string; total: number; failed: number }>
}

export interface RunFilters {
  projectId?: string
  page?: string
  device?: string
  theme?: string
  build?: string
  status?: string
  keyword?: string
}

export interface ReviewPayload {
  category: ReviewCategory
  decision: 'approved' | 'rejected'
  reviewer: string
  reason: string
}

export type RegionDecision = 'accept' | 'ignore' | 'reject'

/** 截图摘要：对审批包所依据截图内容的稳定指纹，规则或截图变化都会使其失效 */
export interface ScreenshotDigest {
  algorithm: string
  digestHash: string
  currentImageHash: string
  baselineImageHash?: string
  mismatchRate: number
  regionHashes: Array<{ regionId: string; hash: string }>
  computedAt: string
}

/** 逐区结论：接管单和审批包都携带，随当时规则一并冻结 */
export interface RegionVerdict {
  regionId: string
  decision: RegionDecision
  /** rule=规则自动折叠，manual=人工结论；重算时只保留 manual 结论 */
  source: 'rule' | 'manual'
  severity: Severity
  pixels: number
  ruleId?: string
  note?: string
}

/** 已批准基线在批准时刻冻结的快照，之后规则或截图变化都不回改 */
export interface BaselineSnapshot {
  digestHash: string
  rulesHash: string
  verdictCount: number
  frozenAt: string
}

export type TakeoverStatus = 'preparing' | 'stale' | 'committed' | 'draft'
export type PackageStatus =
  | 'needs-verification'
  | 'draft-conflict'
  | 'active'
  | 'rejected'
  | 'superseded'

/**
 * 续作接管单：评审窗口接手运行时锁定基准版本、截图摘要和逐区结论；
 * 规则或截图摘要一变，未确认（preparing/stale）的接管单立即失效重算。
 */
export interface Takeover {
  id: string
  runId: string
  clientId: string
  targetKey: string
  baselineId: string | null
  baselineVersion: string
  digest: ScreenshotDigest
  rulesHash: string
  regionVerdicts: RegionVerdict[]
  status: TakeoverStatus
  staleReason?: 'rules-changed' | 'digest-changed'
  packageId?: string
  conflictWith?: string[]
  createdAt: string
  updatedAt: string
}

export type ConflictReason = 'concurrent-window' | 'newer-baseline' | 'duplicate-active'

/**
 * 审批包：回传的完整批准载体。两个窗口提交同一目标时，先到者变为 active，
 * 后到者保留为 draft-conflict 并并列冲突；旧包缺摘要时先进入 needs-verification。
 */
export interface ApprovalPackage {
  id: string
  takeoverId: string
  runId: string
  clientId: string
  targetKey: string
  baselineVersion: string
  currentVersion: string
  review: ReviewPayload | null
  digest: ScreenshotDigest | null
  regionVerdicts: RegionVerdict[]
  status: PackageStatus
  conflictWith: string[]
  conflictReason?: ConflictReason
  activatedBaselineId?: string
  submittedAt: string
  committedAt?: string
}

export type WriteOpType =
  | 'deactivate-baseline'
  | 'create-baseline'
  | 'upsert-package'
  | 'update-run-review'
  | 'set-takeover-status'

export interface WriteOp {
  type: WriteOpType
  /** 确定性效应标识，重放时据此判重，保证不重复生成基线 */
  id: string
  payload?: unknown
}

/** 完整接管批次：先落 prepared 再应用，写入失败后可整体幂等重放 */
export interface WriteBatch {
  id: string
  takeoverId: string
  packageId: string
  targetKey: string
  ops: WriteOp[]
  status: 'prepared' | 'committed'
  attempts: number
  preparedAt: string
  committedAt?: string
  lastError?: string
}

export interface ImportRunPayload {
  projectId: string
  page: string
  device: string
  theme: 'light' | 'dark'
  build: string
  baselineVersion: string
  currentVersion: string
  files: Array<{ name: string; size: number; dataUrl: string }>
  baselineImage?: string
}
