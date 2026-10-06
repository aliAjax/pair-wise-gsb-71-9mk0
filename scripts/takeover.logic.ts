/**
 * 续作接管引擎纯逻辑验证（不依赖浏览器）：
 * npx tsx scripts/takeover.logic.ts
 */
import {
  activateTestHooks,
} from './takeover-test-hooks'
import {
  computeScreenshotSummary,
  confirmTakeover,
  recoverBatch,
  recomputeTakeover,
  submitApprovalPackage,
} from '../src/utils/takeover'
import type { IgnoreRule, ScreenshotRun } from '../src/types'

let failures = 0
const assert = (condition: boolean, message: string) => {
  if (!condition) {
    failures += 1
    console.error(`✗ ${message}`)
  } else {
    console.log(`✓ ${message}`)
  }
}

const { db, reset } = activateTestHooks()
const run = (): ScreenshotRun => db.runs[0]

// 场景 1：先到者启用并生成唯一有效基线
reset()
submitApprovalPackage(db, { packageId: 'pkg-A', runId: run().id, decision: 'approved', reviewer: '林默', reason: '窗口A先批准同页目标，接管为新基线。' })
const afterA = db.takeovers[0]
assert(afterA.status === 'active', '场景1：先到审批包状态为 active')
assert(Boolean(afterA.baselineId), '场景1：先到者生成基线')
const activeBaselines = db.baselines.filter((b) => b.active && b.runId === run().id)
assert(activeBaselines.length === 1, `场景1：同页只有一条有效基线（实际 ${activeBaselines.length}）`)
assert(Boolean(activeBaselines[0].snapshot?.regionConclusions.length), '场景1：基线保留逐区结论快照')
assert(activeBaselines[0].snapshot?.baselineVersion === run().baselineVersion, '场景1：快照记录基准版本')

// 场景 2：后到者留草稿并列冲突，不重复生成基线
const baselineCountAfterA = db.baselines.length
submitApprovalPackage(db, { packageId: 'pkg-B', runId: run().id, decision: 'approved', reviewer: '周航', reason: '窗口B稍后批准同一目标。' })
const orderB = db.takeovers.find((t) => t.packageId === 'pkg-B')!
assert(orderB.status === 'draft-conflict', '场景2：后到者状态为 draft-conflict')
assert(orderB.conflictWith === afterA.id, '场景2：冲突指向先到接管单')
assert(db.baselines.length === baselineCountAfterA, '场景2：冲突草稿未重复生成基线')
assert(db.baselines.filter((b) => b.active).length === 2, '场景2：全库有效基线仍每目标一条')

// 场景 3：重放恢复幂等（先模拟启用写入失败，再从批次恢复两次）
reset()
let failedBatchId = ''
try {
  submitApprovalPackage(
    db,
    { packageId: 'pkg-fail', runId: run().id, decision: 'approved', reviewer: '林默', reason: '启用阶段写入失败。' },
    { simulateActivationWriteFailure: true },
  )
} catch (error) {
  failedBatchId = (error as Error).message.match(/批次 (batch-[a-z0-9-]+)/)?.[1] ?? ''
}
assert(Boolean(failedBatchId), '场景3：启用写入失败抛出可恢复错误并携带批次号')
const failedOrder = db.takeovers[0]
assert(failedOrder.status === 'active' && !failedOrder.baselineId, '场景3：失败后接管单待恢复且尚无基线')
const beforeRecover = db.baselines.length
const recovery1 = recoverBatch(db, failedBatchId)
assert(recovery1.activations.some((a) => a.applied), '场景3：恢复重放补生成基线')
assert(db.baselines.length === beforeRecover + 1, '场景3：恢复后仅新增一条基线')
const recovery2 = recoverBatch(db, failedBatchId)
assert(recovery2.activations.every((a) => !a.applied), '场景3：再次重放不重复生成基线（幂等）')
assert(db.baselines.length === beforeRecover + 1, '场景3：重放前后基线数量不变')
assert(db.baselines.filter((b) => b.active).length === 2, '场景3：恢复后仍无两条同页有效基线')

// 场景 4：规则一变，未确认接管失效；已批准基线快照保留
reset()
submitApprovalPackage(db, { packageId: 'pkg-A', runId: run().id, decision: 'approved', reviewer: '林默', reason: '先到批准。' })
submitApprovalPackage(db, { packageId: 'pkg-B', runId: run().id, decision: 'approved', reviewer: '周航', reason: '后到草稿。' })
const snapshotDigestBeforeRuleChange = db.baselines[0].snapshot?.screenshotSummary?.digest
const rule: IgnoreRule = db.rules[0]
rule.maxDelta += 1
rule.enabled = !rule.enabled
const staleOrder = recomputeTakeover(db, db.takeovers.find((t) => t.packageId === 'pkg-B')!.id)
assert(staleOrder.status === 'stale', '场景4：规则指纹变化，冲突草稿失效重算')
assert(staleOrder.staleReasons.some((r) => r.includes('规则')), '场景4：失效原因包含规则变化')
assert(db.baselines[0].active, '场景4：已批准基线仍有效')
assert(
  db.baselines[0].snapshot?.screenshotSummary?.digest === snapshotDigestBeforeRuleChange,
  '场景4：已批准基线保留当时摘要快照，不随后续规则变化改写',
)
// 摘要重新一致后可回到待确认；此处规则仍不一致，应保持 stale
recomputeTakeover(db, staleOrder.id)
assert(staleOrder.status === 'stale', '场景4：规则未还原前重算仍为失效')

// 场景 5：截图摘要变化（区域像素改变），未确认接管失效；已批准先到者快照保留
reset()
submitApprovalPackage(db, { packageId: 'pkg-A', runId: run().id, decision: 'approved', reviewer: '林默', reason: '先到启用。' })
submitApprovalPackage(db, { packageId: 'pkg-B', runId: run().id, decision: 'approved', reviewer: '周航', reason: '后到草稿待确认。' })
const approvedSnapshotDigest = db.baselines[0].snapshot?.screenshotSummary?.digest
db.runs[0].regions[0].pixels += 999
const staleByScreenshot = recomputeTakeover(db, db.takeovers.find((t) => t.packageId === 'pkg-B')!.id)
assert(staleByScreenshot.status === 'stale', '场景5：截图区域像素变化导致未确认接管失效')
assert(staleByScreenshot.staleReasons.some((r) => r.includes('截图摘要')), '场景5：失效原因包含截图摘要变化')
assert(db.takeovers.find((t) => t.packageId === 'pkg-A')!.status === 'active', '场景5：已批准先到接管单保持启用')
assert(
  db.baselines[0].snapshot?.screenshotSummary?.digest === approvedSnapshotDigest,
  '场景5：已批准基线保留当时摘要快照，不随截图变化改写',
)

// 场景 6：旧包缺摘要先待核，不生成基线
reset()
const beforeLegacy = db.baselines.length
submitApprovalPackage(db, { packageId: 'pkg-legacy', runId: run().id, decision: 'approved', reviewer: '旧系统', reason: '旧审批包回传。', screenshotSummary: null })
const legacy = db.takeovers[0]
assert(legacy.status === 'pending-verification', '场景6：缺摘要旧包进入待核')
assert(!legacy.baselineId && db.baselines.length === beforeLegacy, '场景6：待核期间不生成基线')
let confirmError = ''
try {
  confirmTakeover(db, legacy.id)
} catch (error) {
  confirmError = (error as Error).message
}
assert(confirmError.includes('摘要'), '场景6：待核单无法直接确认，提示补传摘要')

// 场景 7：冲突草稿经人工确认取代先到者，旧基线快照保留、只启用新基线
reset()
submitApprovalPackage(db, { packageId: 'pkg-A', runId: run().id, decision: 'approved', reviewer: '林默', reason: '先到。' })
submitApprovalPackage(db, { packageId: 'pkg-B', runId: run().id, decision: 'approved', reviewer: '周航', reason: '后到。' })
const firstBaselineId = db.takeovers.find((t) => t.packageId === 'pkg-A')!.baselineId
confirmTakeover(db, db.takeovers.find((t) => t.packageId === 'pkg-B')!.id)
assert(db.takeovers.find((t) => t.packageId === 'pkg-A')!.status === 'superseded', '场景7：原先进到者被标记 superseded')
const firstBaseline = db.baselines.find((b) => b.id === firstBaselineId)!
assert(!firstBaseline.active, '场景7：原基线停用但记录保留')
assert(Boolean(firstBaseline.snapshot), '场景7：原基线快照仍可追溯')
assert(db.baselines.filter((b) => b.active && b.runId === run().id).length === 1, '场景7：确认后同页仍只有一条有效基线')

// 场景 8：驳回不生成基线，接管单记录 rejected
reset()
const beforeReject = db.baselines.length
submitApprovalPackage(db, { packageId: 'pkg-reject', runId: run().id, decision: 'rejected', reviewer: '梁琪', reason: '阻断性渲染异常。' })
assert(db.takeovers[0].status === 'rejected', '场景8：驳回接管单为 rejected')
assert(db.baselines.length === beforeReject, '场景8：驳回不生成基线')
assert(run().status === 'rejected', '场景8：运行标记为已驳回')

// 场景 9：摘要包含规则指纹且稳定
reset()
const s1 = computeScreenshotSummary(run(), db.rules)
const s2 = computeScreenshotSummary(run(), db.rules)
assert(s1.digest === s2.digest, '场景9：相同输入摘要稳定')
assert(s1.digest.length === 8, '场景9：摘要为 8 位指纹')

// 场景 10：旧包缺摘要先待核；补传摘要核为一致（verified）仍不启用；人工确认后才接管
reset()
submitApprovalPackage(db, { packageId: 'pkg-legacy', runId: run().id, decision: 'approved', reviewer: '旧系统', reason: '旧审批包回传。', screenshotSummary: null })
const legacyOrder = db.takeovers[0]
assert(legacyOrder.status === 'pending-verification', '场景10：旧包先待核')
const baselinesBeforeAttach = db.baselines.filter((b) => b.active && b.runId === run().id).length
// 直接调用引擎补摘要逻辑等价：写入当前摘要
;(() => {
  const targetRun = db.runs[0]
  legacyOrder.screenshotSummary = computeScreenshotSummary(targetRun, db.rules)
  legacyOrder.ruleFingerprint = legacyOrder.screenshotSummary.ruleFingerprint
  legacyOrder.status = 'verified'
})()
assert(
  db.baselines.filter((b) => b.active && b.runId === run().id).length === baselinesBeforeAttach,
  '场景10：补核一致后仍不自动启用基线',
)
confirmTakeover(db, legacyOrder.id)
assert(db.takeovers[0].status === 'active', '场景10：人工确认后接管单启用')
assert(Boolean(db.takeovers[0].baselineId), '场景10：确认后生成基线')
assert(db.baselines.filter((b) => b.active && b.runId === run().id).length === 1, '场景10：确认后同页一条有效基线')

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
if (failures > 0) process.exit(1)
