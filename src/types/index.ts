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
  /** 批准当时的基准版本、截图摘要与逐区结论快照，永不随后续变化而改写 */
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

// ---------------------------------------------------------------------------
// 续作接管（Approval Package Handoff）
// ---------------------------------------------------------------------------

export type RegionVerdict = 'design-change' | 'render-error' | 'environment-noise'

/** 逐区结论：审批包回传时，对每个差异区域给出的判定 */
export interface RegionConclusion {
  regionId: string
  kind: DifferenceRegion['kind']
  severity: Severity
  pixels: number
  verdict: RegionVerdict
  ignored: boolean
  ruleId?: string
}

/**
 * 截图摘要：从运行的差异区域中稳定计算得到。
 * 摘要一旦变化（区域、像素、差异率或规则指纹变化），未确认接管立即失效重算。
 */
export interface ScreenshotSummary {
  regionCount: number
  totalPixels: number
  unignoredPixels: number
  mismatchRate: number
  ruleFingerprint: string
  digest: string
}

export type TakeoverStatus =
  | 'active' // 先到者：已启用，基线已创建
  | 'draft-conflict' // 后到者：留草稿并列冲突
  | 'stale' // 规则或截图摘要变化，接管失效待重算
  | 'pending-verification' // 旧包缺摘要：先待核
  | 'verified' // 旧包已补传摘要并核为一致，等待人工确认启用
  | 'superseded' // 冲突解决后被新的已启用接管单取代
  | 'rejected' // 审批包结论为驳回

/** 基线快照：基线批准那一刻的基准版本、规则指纹、截图摘要与逐区结论 */
export interface BaselineSnapshot {
  baselineVersion: string
  screenshotSummary: ScreenshotSummary | null
  ruleFingerprint: string
  regionConclusions: RegionConclusion[]
  packageId?: string
  activatedBy: string
  activatedAt: string
}

/** 审批包回传载荷 */
export interface ApprovalPackagePayload {
  packageId?: string
  runId: string
  decision: 'approved' | 'rejected'
  reviewer: string
  reason: string
  category?: ReviewCategory
  /** 旧版本审批包可能没有摘要；缺摘要时进入待核而不是自动启用 */
  screenshotSummary?: ScreenshotSummary | null
  regionConclusions?: RegionConclusion[]
  receivedAt?: string
}

/** 接管单：把运行、审批包、基线和忽略规则续作接管的审计记录 */
export interface TakeoverOrder {
  id: string
  packageId: string
  runId: string
  projectId: string
  page: string
  device: string
  theme: 'light' | 'dark'
  /** 同页目标键：project/page/device/theme */
  targetKey: string
  baselineVersion: string
  screenshotSummary: ScreenshotSummary | null
  regionConclusions: RegionConclusion[]
  decision: 'approved' | 'rejected'
  reviewer: string
  reason: string
  status: TakeoverStatus
  conflictWith?: string
  conflictReason?: string
  staleReasons: string[]
  /** 接管单创建时记录的规则指纹，与当前规则比对判断规则是否变化 */
  ruleFingerprint: string
  baselineId?: string
  snapshot?: BaselineSnapshot
  batchId: string
  receivedAt: string
  resolvedAt?: string
}

/** 一次完整接管批次，用于写入失败后恢复、重放 */
export interface TakeoverBatch {
  id: string
  packageIds: string[]
  orderIds: string[]
  status: 'prepared' | 'applied' | 'failed'
  error?: string
  preparedAt: string
  appliedAt?: string
}

/** 启用动作：完整批次里的幂等步骤，重放时按 targetKey/runId 判重，不重复生成基线 */
export interface TakeoverActivation {
  targetKey: string
  runId: string
  packageId: string
  orderId: string
  baselineId?: string
  applied: boolean
}

export interface TakeoverRecoveryResult {
  batchId: string
  recovered: boolean
  activations: TakeoverActivation[]
  order: TakeoverOrder
}
