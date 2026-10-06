// 端到端：真实 axios mock adapter + localStorage，模拟两个窗口并发提交同一目标
import assert from 'node:assert/strict'
import {
  api,
  openTakeover,
  commitTakeoverApi,
  getPackages,
  verifyLegacyPackage,
  getBaselines,
  recoverBatches,
  getBatches,
  getBaselineConflicts,
  saveVerdicts,
  toggleRule,
  resolveConflictPackage,
  getRun,
} from '../src/api/http'

const STORAGE_KEY = 'visual-regression-platform-v1'
void STORAGE_KEY

class MemoryStorage {
  map: Map<string, string>
  constructor() {
    this.map = new Map()
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value))
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  clear(): void {
    this.map.clear()
  }
}

const storage = new MemoryStorage()
;(globalThis as Record<string, unknown>).localStorage = storage
;(globalThis as Record<string, unknown>).window = { setTimeout: (fn: () => void) => setTimeout(fn, 1) }

let pass = 0
const check = (name: string, fn: () => void) => {
  fn()
  pass += 1
  console.log(`  ✓ ${name}`)
}
const okReview = {
  category: 'design-change' as const,
  decision: 'approved' as const,
  reviewer: '林默',
  reason: '设计稿 DS-401 已确认的按钮改版上线',
}

const runId = 'run-1048' // 订单结算页 Desktop 1440 light，已有有效基线 base-commerce-checkout
const reset = () => storage.clear()

const main = async () => {
  console.log('A. 两个窗口并发提交同一目标：先到启用 / 后到冲突草稿')
  reset()
  {
    const tkA = await openTakeover(runId, 'window-A')
    const tkB = await openTakeover(runId, 'window-B')
    assert.equal(tkA.status, 'preparing')
    assert.equal(tkA.baselineId, 'base-commerce-checkout')
    assert.equal(tkB.baselineId, 'base-commerce-checkout')
    assert.notEqual(tkA.id, tkB.id)

    const resA = await commitTakeoverApi(tkA.id, okReview)
    assert.equal(resA.package.status, 'active')
    assert.ok(resA.package.activatedBaselineId)

    const resB = await commitTakeoverApi(tkB.id, okReview)
    assert.equal(resB.package.status, 'draft-conflict')
    assert.equal(resB.package.conflictReason, 'newer-baseline')
    assert.ok(!resB.package.activatedBaselineId)

    const baselines = await getBaselines('p-commerce')
    const target = baselines.filter((b) => b.page === '订单结算页' && b.device === 'Desktop 1440')
    const active = target.filter((b) => b.active)
    assert.equal(active.length, 1, '先到者唯一启用，未产生双有效基线')
    assert.equal(active[0].id, resA.package.activatedBaselineId)
    // 已批准基线冻结了当时摘要与规则快照
    assert.equal(active[0].snapshot?.digestHash, tkA.digest.digestHash)
    assert.equal(active[0].snapshot?.verdictCount, 3)

    const runA = await getRun(runId)
    assert.equal(runA.status, 'approved')
  }
  check('先到窗口激活基线、后到窗口落 draft-conflict，同页只有一条有效基线', () => {})

  console.log('B. 规则变化后未确认接管失效，提交被拒；已批准基线快照不变')
  reset()
  {
    const tk = await openTakeover('run-1047', 'window-X')
    await toggleRule('rule-time', false) // 全局规则变化
    await assert.rejects(
      () => commitTakeoverApi(tk.id, okReview),
      /STALE_TAKEOVER/,
      '失效接管必须先重算才能提交',
    )
    const baselines = await getBaselines('p-commerce')
    const list = baselines.find((b) => b.id === 'base-commerce-list')
    assert.equal(list?.snapshot?.digestHash, 'legacy-unknown', '历史基线快照不被规则变化回改')
  }
  check('规则变更后提交返回 STALE_TAKEOVER，既有基线快照保持', () => {})

  console.log('C. 写入失败 → 从完整批次恢复，重放不重复生成基线')
  reset()
  {
    const tk = await openTakeover(runId, 'window-recover')
    await assert.rejects(
      () => commitTakeoverApi(tk.id, { ...okReview, simulateWriteFailure: true }),
      /WRITE_FAILED/,
    )
    // 批次已 prepared，但基线尚未应用
    let baselines = await getBaselines('p-commerce')
    const old = baselines.find((b) => b.id === 'base-commerce-checkout')
    assert.equal(old?.active, true, '应用前旧基线仍有效')
    let batches = await getBatches()
    assert.equal(batches[0].status, 'prepared')

    const recoverResult = await recoverBatches()
    assert.equal(recoverResult.recovered, 1)
    baselines = await getBaselines('p-commerce')
    const newOnes = baselines.filter((b) => b.runId === runId)
    assert.equal(newOnes.length, 1)
    assert.equal(newOnes[0].active, true)

    // 再恢复一次：没有 prepared 批次，绝不重复
    const second = await recoverBatches()
    assert.equal(second.recovered, 0)
    baselines = await getBaselines('p-commerce')
    assert.equal(baselines.filter((b) => b.runId === runId).length, 1)
    batches = await getBatches()
    assert.equal(batches[0].status, 'committed')
  }
  check('prepared 批次恢复后基线启用，重复恢复不生成第二条基线', () => {})

  console.log('D. 旧审批包缺摘要先待核，补齐后转冲突草稿')
  reset()
  {
    let packages = await getPackages()
    const legacy = packages.find((p) => p.id === 'pkg-legacy-961')
    assert.equal(legacy?.status, 'needs-verification')
    assert.equal(legacy?.digest, null)

    const verified = await verifyLegacyPackage('pkg-legacy-961')
    assert.ok(verified.digest, '补齐摘要')
    assert.equal(verified.regionVerdicts.length, 3)
    assert.equal(verified.status, 'draft-conflict')
    assert.equal(verified.conflictReason, 'newer-baseline')

    packages = await getPackages()
    assert.equal(packages.find((p) => p.id === 'pkg-legacy-961')?.status, 'draft-conflict')
  }
  check('旧包 needs-verification → verify 补齐摘要与逐区结论 → draft-conflict', () => {})

  console.log('E. 冲突化解：强制启用后到包，同页回到唯一有效基线')
  reset()
  {
    const tkA = await openTakeover(runId, 'A')
    const tkB = await openTakeover(runId, 'B')
    await commitTakeoverApi(tkA.id, okReview)
    const resB = await commitTakeoverApi(tkB.id, okReview)
    assert.equal(resB.package.status, 'draft-conflict')

    const resolved = await resolveConflictPackage(resB.package.id, { mode: 'activate-package' })
    assert.equal(resolved.status, 'active')
    const conflicts = (await getBaselineConflicts()).duplicates
    assert.equal(conflicts.length, 0)
    const baselines = await getBaselines('p-commerce')
    const active = baselines.filter((b) => b.page === '订单结算页' && b.active)
    assert.equal(active.length, 1)
    assert.equal(active[0].runId, runId)
  }
  check('activate-package 化解冲突：补建草稿基线并唯一启用', () => {})

  console.log('F. 逐区结论随审批包冻结')
  reset()
  {
    const tk = await openTakeover(runId, 'verdict-win')
    const verdicts = tk.regionVerdicts.map((v, i) =>
      i === 0
        ? { ...v, decision: 'reject' as const, source: 'manual' as const, note: '人工驳回测试' }
        : v,
    )
    await saveVerdicts(tk.id, verdicts)
    const res = await commitTakeoverApi(tk.id, okReview)
    assert.equal(res.package.regionVerdicts[0].decision, 'reject')
    assert.equal(res.package.regionVerdicts[0].note, '人工驳回测试')
    assert.equal(res.package.regionVerdicts[0].source, 'manual')
  }
  check('人工逐区结论写入接管单并冻结进审批包', () => {})

  void api
  console.log(`\n全部 ${pass} 项 adapter 端到端断言通过`)
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error)
    process.exit(1)
  },
)
