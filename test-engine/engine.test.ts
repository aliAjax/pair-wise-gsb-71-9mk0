import assert from 'node:assert/strict'
import {
  applyOps,
  attachLegacyDigest,
  buildVerdicts,
  computeDigest,
  createTakeover,
  findDuplicateActiveBaselines,
  markStaleByRules,
  prepareCommit,
  recomputeTakeover,
  recoverPreparedBatches,
  resolveCommit,
  rulesFingerprint,
  targetKeyOf,
  type MinimalDb,
} from '../src/utils/takeover'
import type {
  Baseline,
  DifferenceRegion,
  IgnoreRule,
  RegionVerdict,
  ReviewPayload,
  ScreenshotRun,
  Takeover,
  WriteBatch,
} from '../src/types'

let pass = 0
const check = (name: string, fn: () => void) => {
  fn()
  pass += 1
  console.log(`  ✓ ${name}`)
}

const T = '2026-10-06T10:00:00+08:00'
const review = (reason = '设计稿 DS-401 已确认改版'): ReviewPayload => ({
  category: 'design-change',
  decision: 'approved',
  reviewer: '林默',
  reason,
})

const regions = (): DifferenceRegion[] => [
  { id: 'r1', x: 10, y: 10, width: 20, height: 10, severity: 'high', pixels: 1000, kind: 'layout', ignored: false },
  { id: 'r2', x: 40, y: 40, width: 12, height: 8, severity: 'low', pixels: 200, kind: 'environment', ignored: true, ruleId: 'rule-time' },
]

const makeRun = (overrides: Partial<ScreenshotRun> = {}): ScreenshotRun => ({
  id: 'run-A',
  name: '结算页回归',
  projectId: 'p-commerce',
  page: '订单结算页',
  device: 'Desktop 1440',
  theme: 'light',
  build: 'release/6.18.0',
  status: 'pending',
  mismatchRate: 3.5,
  capturedAt: T,
  baselineVersion: 'v6.17.4-baseline',
  currentVersion: 'v6.18.0-rc2',
  regions: regions(),
  ...overrides,
})

const makeRules = (enabled = true): IgnoreRule[] => [
  {
    id: 'rule-time',
    name: '动态时间区域',
    projectId: 'all',
    selector: '[data-time]',
    pagePattern: '*',
    devicePattern: '*',
    maxDelta: 12,
    enabled,
    createdAt: T,
  },
]

const makeBaseline = (id: string, active: boolean, runId = 'run-old'): Baseline => ({
  id,
  projectId: 'p-commerce',
  page: '订单结算页',
  device: 'Desktop 1440',
  theme: 'light',
  version: 'v6.17.4-baseline',
  approvedBy: '沈宁',
  reason: '上一版基线',
  approvedAt: T,
  runId,
  active,
  snapshot: { digestHash: 'old-digest', rulesHash: 'old-rules', verdictCount: 2, frozenAt: T },
})

const makeDb = (baselines: Baseline[] = []): MinimalDb => ({
  runs: [makeRun()],
  baselines,
  packages: [],
  takeovers: [],
})

const openTakeover = (rules: IgnoreRule[], run = makeRun(), clientId = 'win-1') =>
  createTakeover({ id: `takeover-${clientId}`, run, rules, clientId, now: T })

console.log('1) 接管单记录基准版本、截图摘要和逐区结论')
check('锁定基准版本并生成确定性摘要', () => {
  const tk = openTakeover(makeRules())
  assert.equal(tk.baselineVersion, 'v6.17.4-baseline')
  assert.equal(tk.targetKey, 'p-commerce|订单结算页|Desktop 1440|light')
  assert.match(tk.digest.digestHash, /^[0-9a-f]{13}$/)
  assert.equal(tk.digest.regionHashes.length, 2)
})
check('相同输入在两个窗口得到相同摘要（可复算）', () => {
  const a = openTakeover(makeRules(), makeRun(), 'win-1')
  const b = openTakeover(makeRules(), makeRun(), 'win-2')
  assert.equal(a.digest.digestHash, b.digest.digestHash)
  assert.equal(a.rulesHash, b.rulesHash)
})
check('逐区结论：启用规则命中区域默认忽略，其余采纳', () => {
  const tk = openTakeover(makeRules())
  const byId = Object.fromEntries(tk.regionVerdicts.map((v) => [v.regionId, v]))
  assert.equal(byId.r1.decision, 'accept')
  assert.equal(byId.r2.decision, 'ignore')
  assert.equal(byId.r2.ruleId, 'rule-time')
})

console.log('2) 两窗口同目标并发：先到启用，后到留冲突草稿')
check('先到者 activate 并停用旧基线', () => {
  const run = makeRun()
  const old = makeBaseline('base-old', true)
  const tk1 = openTakeover(makeRules(), run, 'win-1')
  tk1.baselineId = 'base-old'
  const res1 = resolveCommit(tk1, [old])
  assert.equal(res1.outcome, 'activate')
  assert.equal(res1.deactivateBaselineId, 'base-old')
})
check('后到者（旧基线已被停用、出现新版本）得到 conflict 草稿', () => {
  const run = makeRun()
  const tk1 = openTakeover(makeRules(), run, 'win-1')
  tk1.baselineId = 'base-old'
  const winnerBaseline = makeBaseline(`base-tk1`, true, 'run-A')
  // 窗口2仍锁定 base-old，此刻有效基线已是窗口1的
  const tk2 = openTakeover(makeRules(), run, 'win-2')
  tk2.baselineId = 'base-old'
  const res2 = resolveCommit(tk2, [winnerBaseline])
  assert.equal(res2.outcome, 'conflict')
  assert.equal(res2.reason, 'newer-baseline')
  assert.deepEqual(res2.conflictWith, [winnerBaseline.id])
})
check('prepareCommit 编码为完整批次：后到包为 draft-conflict 且不生成基线', () => {
  const run = makeRun()
  const tk2 = openTakeover(makeRules(), run, 'win-2')
  tk2.baselineId = 'base-old'
  const winnerBaseline = makeBaseline('base-tk1', true, 'run-A')
  const prepared = prepareCommit({
    batchId: 'batch-2',
    packageId: 'pkg-2',
    takeover: tk2,
    run,
    review: review(),
    activeBaselines: [winnerBaseline],
    rulesHash: rulesFingerprint(makeRules()),
    now: T,
  })
  assert.equal(prepared.pkg.status, 'draft-conflict')
  assert.equal(prepared.baseline, undefined)
  assert.ok(prepared.batch.ops.every((op) => op.type !== 'create-baseline'))
})
check('同页两条有效基线（duplicate-active）也会拦截为冲突草稿', () => {
  const run = makeRun()
  const tk = openTakeover(makeRules(), run)
  const res = resolveCommit(tk, [makeBaseline('b1', true), makeBaseline('b2', true)])
  assert.equal(res.outcome, 'conflict')
  assert.equal(res.reason, 'duplicate-active')
  assert.deepEqual(res.conflictWith.sort(), ['b1', 'b2'])
  const dupes = findDuplicateActiveBaselines([
    ...[makeBaseline('b1', true), makeBaseline('b2', true)],
    makeBaseline('b3', false),
  ])
  assert.equal(dupes.size, 1)
})

console.log('3) 规则/摘要变化：未确认接管失效重算；已批准基线保留快照')
check('规则阈值变化 → stale(rules-changed)', () => {
  const run = makeRun()
  const tk = openTakeover(makeRules(), run)
  const changedRules = makeRules()
  changedRules[0].maxDelta = 99
  const result = recomputeTakeover(tk, run, changedRules, T)
  assert.equal(result.changed, true)
  assert.equal(result.reason, 'rules-changed')
  assert.equal(tk.status, 'stale')
})
check('规则开关变化同样改变指纹并使接管失效', () => {
  const run = makeRun({ regions: regions().map((region) => ({ ...region })) })
  run.regions[1] = { ...run.regions[1], ignored: false }
  const tk = openTakeover(makeRules(), run)
  assert.equal(tk.regionVerdicts.find((v) => v.regionId === 'r2')?.decision, 'ignore')
  const off = makeRules(false)
  const result = recomputeTakeover(tk, run, off, T)
  assert.equal(result.reason, 'rules-changed')
  // 规则关闭且无人工忽略标记，原先由规则折叠的区域回到采纳
  assert.equal(tk.regionVerdicts.find((v) => v.regionId === 'r2')?.decision, 'accept')
})
check('截图摘要变化（当前图/差异率/区域几何）→ stale(digest-changed)', () => {
  const run = makeRun()
  const tk = openTakeover(makeRules(), run)
  const changedRun = makeRun({ mismatchRate: 8.2 })
  const result = recomputeTakeover(tk, changedRun, makeRules(), T)
  assert.equal(result.reason, 'digest-changed')
  assert.equal(tk.digest.mismatchRate, 8.2)
})
check('忽略切换不进摘要，不会导致 digest-changed', () => {
  const run = makeRun()
  const d1 = computeDigest(run, T)
  const toggled = makeRun()
  toggled.regions[0].ignored = true
  const d2 = computeDigest(toggled, T)
  assert.equal(d1.digestHash, d2.digestHash)
})
check('重算保留未变区域的人工结论，内容变化的区域回默认', () => {
  const run = makeRun()
  const tk = openTakeover(makeRules(), run)
  tk.regionVerdicts = buildVerdicts(run, makeRules(), {
    r1: { regionId: 'r1', decision: 'reject', source: 'manual', severity: 'high', pixels: 1000, note: '人工驳回' },
  })
  const changedRun = makeRun({ regions: regions() })
  changedRun.regions[1].pixels = 999 // r2 内容变化
  changedRun.regions[0] // r1 几何不变
  recomputeTakeover(tk, changedRun, makeRules(), T)
  const r1 = tk.regionVerdicts.find((v) => v.regionId === 'r1')
  assert.equal(r1?.decision, 'reject')
  assert.equal(r1?.note, '人工驳回')
})
check('已提交（committed）接管不被重算改动', () => {
  const run = makeRun()
  const tk = openTakeover(makeRules(), run)
  tk.status = 'committed'
  const hashBefore = tk.digest.digestHash
  const result = recomputeTakeover(tk, makeRun({ mismatchRate: 9 }), makeRules(false), T)
  assert.equal(result.changed, false)
  assert.equal(tk.digest.digestHash, hashBefore)
})
check('已批准基线快照在规则变化后保持不变', () => {
  const baseline = makeBaseline('base-frozen', true)
  const snapshotHash = baseline.snapshot!.digestHash
  markStaleByRules([] as Takeover[], makeRules(false), T)
  assert.equal(baseline.snapshot!.digestHash, snapshotHash)
  assert.equal(baseline.active, true)
})
check('规则变更联动只作废 preparing 接管，不影响 draft', () => {
  const preparing = openTakeover(makeRules())
  preparing.status = 'preparing'
  const draft = openTakeover(makeRules())
  draft.status = 'draft'
  const newRules = makeRules(false)
  markStaleByRules([preparing, draft], newRules, T)
  assert.equal(preparing.status, 'stale')
  assert.equal(draft.status, 'draft')
})

console.log('4) 写入失败：从完整批次恢复，重放幂等不重复生成基线')
check('激活批次包含 停用旧基线/创建基线/包/运行/接管 全部操作', () => {
  const run = makeRun()
  const old = makeBaseline('base-old', true)
  const tk = openTakeover(makeRules(), run)
  tk.baselineId = 'base-old'
  const prepared = prepareCommit({
    batchId: 'batch-1',
    packageId: 'pkg-1',
    takeover: tk,
    run,
    review: review(),
    activeBaselines: [old],
    rulesHash: rulesFingerprint(makeRules()),
    now: T,
  })
  const types = prepared.batch.ops.map((op) => op.type)
  assert.deepEqual(types, [
    'deactivate-baseline',
    'create-baseline',
    'upsert-package',
    'update-run-review',
    'set-takeover-status',
  ])
  assert.equal(prepared.baseline!.active, true)
  assert.equal(prepared.baseline!.snapshot!.digestHash, tk.digest.digestHash)
})
check('applyOps 后重放同一批次：基线不重复、旧基线不被再次停用', () => {
  const db = makeDb([makeBaseline('base-old', true)])
  const run = db.runs[0]
  const tk = openTakeover(makeRules(), run)
  tk.baselineId = 'base-old'
  const prepared = prepareCommit({
    batchId: 'b',
    packageId: 'p',
    takeover: tk,
    run,
    review: review(),
    activeBaselines: db.baselines,
    rulesHash: rulesFingerprint(makeRules()),
    now: T,
  })
  db.takeovers.push(tk)
  const first = applyOps(db, prepared.batch.ops)
  assert.ok(first.applied >= 4)
  assert.equal(db.baselines.filter((b) => b.id === 'base-p').length, 1)
  assert.equal(db.baselines.find((b) => b.id === 'base-old')!.active, false)
  assert.equal(db.runs[0].status, 'approved')
  assert.equal(tk.status, 'committed')

  // 模拟恢复：再次应用同一批 ops
  const second = applyOps(db, prepared.batch.ops)
  assert.equal(second.applied, 0)
  assert.equal(db.baselines.filter((b) => b.id === 'base-p').length, 1)
  assert.equal(db.packages.length, 1)
})
check('recoverPreparedBatches 只恢复 prepared 批次且幂等', () => {
  const db = makeDb([makeBaseline('base-old', true)])
  const run = db.runs[0]
  const tk = openTakeover(makeRules(), run)
  tk.baselineId = 'base-old'
  db.takeovers.push(tk)
  const prepared = prepareCommit({
    batchId: 'b-recover',
    packageId: 'p-recover',
    takeover: tk,
    run,
    review: review(),
    activeBaselines: db.baselines,
    rulesHash: rulesFingerprint(makeRules()),
    now: T,
  })
  const committed: WriteBatch = { ...prepared.batch, id: 'b-done', status: 'committed' }
  const withBatches = Object.assign(db, { batches: [prepared.batch, committed] })
  const r1 = recoverPreparedBatches(withBatches, T)
  assert.equal(r1.recovered, 1)
  assert.equal(prepared.batch.status, 'committed')
  const r2 = recoverPreparedBatches(withBatches, T)
  assert.equal(r2.recovered, 0)
  assert.equal(db.baselines.filter((b) => b.id === 'base-p-recover').length, 1)
})
check('驳回批次不生成任何基线', () => {
  const db = makeDb([makeBaseline('base-old', true)])
  const run = db.runs[0]
  const tk = openTakeover(makeRules(), run)
  db.takeovers.push(tk)
  const prepared = prepareCommit({
    batchId: 'b-reject',
    packageId: 'p-reject',
    takeover: tk,
    run,
    review: { ...review(), decision: 'rejected' as const, reason: '渲染异常阻断发布' },
    activeBaselines: db.baselines,
    rulesHash: rulesFingerprint(makeRules()),
    now: T,
  })
  applyOps(db, prepared.batch.ops)
  assert.equal(db.baselines.length, 1)
  assert.equal(db.baselines[0].active, true)
  assert.equal(db.runs[0].status, 'rejected')
  assert.equal(prepared.pkg.status, 'rejected')
})

console.log('5) 旧审批包缺摘要 → 先待核')
check('缺摘要包为 needs-verification；补齐后才有摘要', () => {
  const pkg = {
    id: 'pkg-legacy',
    takeoverId: 'tk-legacy',
    runId: 'run-A',
    clientId: 'old-win',
    targetKey: targetKeyOf(makeRun()),
    baselineVersion: 'v1',
    currentVersion: 'v2',
    review: review(),
    digest: null,
    regionVerdicts: [] as RegionVerdict[],
    status: 'needs-verification' as const,
    conflictWith: [],
    submittedAt: T,
  }
  assert.equal(pkg.status, 'needs-verification')
  const verified = attachLegacyDigest(pkg, makeRun(), makeRules(), T)
  assert.ok(verified.digest)
  assert.equal(verified.regionVerdicts.length, 2)
  assert.equal(verified.status, 'draft-conflict')
})

console.log(`\n全部 ${pass} 项领域引擎断言通过`)
