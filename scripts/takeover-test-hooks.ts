import type { Database } from '../src/mocks/db'
import { setPersister, type PersistMeta } from '../src/utils/takeover'

export type MemoryDatabase = Database

const makeDb = (): MemoryDatabase => {
  const regions = [
    { id: 'r1', x: 1, y: 1, width: 2, height: 2, severity: 'high' as const, pixels: 100, kind: 'layout' as const, ignored: false },
    { id: 'r2', x: 3, y: 3, width: 2, height: 2, severity: 'low' as const, pixels: 20, kind: 'environment' as const, ignored: true, ruleId: 'rule-x' },
  ]
  const baseRun = {
    id: 'run-x',
    name: '测试运行',
    projectId: 'p1',
    page: '页面A',
    device: 'Desktop',
    theme: 'light' as const,
    build: 'b1',
    status: 'pending' as const,
    mismatchRate: 3.2,
    capturedAt: '2026-10-06T10:00:00+08:00',
    baselineVersion: 'v-base-1',
    currentVersion: 'v-cur-1',
    regions,
  }
  return {
    projects: [{ id: 'p1', name: '项目一', code: 'P1', owner: 'owner', pageCount: 1 }],
    runs: [
      { ...baseRun, regions: baseRun.regions.map((r) => ({ ...r })) },
      {
        ...baseRun,
        id: 'run-y',
        page: '页面B',
        regions: regions.map((r) => ({ ...r, id: `${r.id}-y` })),
      },
    ],
    baselines: [
      {
        id: 'base-old-a',
        projectId: 'p1',
        page: '页面A',
        device: 'Desktop',
        theme: 'light',
        version: 'v-base-1',
        approvedBy: '前任',
        reason: '旧基线',
        approvedAt: '2026-09-01T10:00:00+08:00',
        runId: 'run-old',
        active: true,
      },
      {
        id: 'base-old-b',
        projectId: 'p1',
        page: '页面B',
        device: 'Desktop',
        theme: 'light',
        version: 'v-base-1',
        approvedBy: '前任',
        reason: '旧基线',
        approvedAt: '2026-09-01T10:00:00+08:00',
        runId: 'run-old-2',
        active: true,
      },
    ],
    rules: [
      {
        id: 'rule-x',
        name: '时间',
        projectId: 'all',
        selector: '.time',
        pagePattern: '*',
        devicePattern: '*',
        maxDelta: 10,
        enabled: true,
        createdAt: '2026-09-01T00:00:00+08:00',
      },
    ],
    takeovers: [],
    batches: [],
  }
}

/** 激活内存持久化，返回当前 db 与 reset；每次 reset 得到两个目标各一条有效基线 */
export const activateTestHooks = () => {
  const db = makeDb()
  setPersister((next: MemoryDatabase, meta: PersistMeta) => {
    if (meta.phase === 'commit' && meta.fault) {
      // 模拟原子存储提交失败：活动内存回滚到阶段一快照，随后抛出可恢复错误
      if (meta.preparedSnapshot && meta.rollback) {
        meta.rollback(meta.preparedSnapshot)
      }
      throw new Error('localStorage 写入失败（模拟）')
    }
    db.projects = next.projects
    db.runs = next.runs
    db.baselines = next.baselines
    db.rules = next.rules
    db.takeovers = next.takeovers
    db.batches = next.batches
  })
  const reset = () => {
    const fresh = makeDb()
    db.projects = fresh.projects
    db.runs = fresh.runs
    db.baselines = fresh.baselines
    db.rules = fresh.rules
    db.takeovers = fresh.takeovers
    db.batches = fresh.batches
    return db
  }
  return { db, reset }
}
