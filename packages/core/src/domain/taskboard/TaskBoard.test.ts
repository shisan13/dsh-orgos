/**
 * TaskBoard 并发正确性测试:CAS(expectedRevision)/tombstone 删除/DAG 依赖
 * (借官方 experimental agent-team 的 task-board 设计;GWT)
 */
import { describe, expect, it } from 'vitest'
import { TaskBoard } from './TaskBoard.ts'
import { OrgTree } from '../org/OrgTree.ts'
import type { TeamConfig } from '../types.ts'

function makeTree(): OrgTree {
  const cfg: TeamConfig = {
    org: 'acme',
    nodes: [
      { id: 'acme', kind: 'org', orchestratorPosition: 'ceo', children: ['team-front', 'team-backend'] },
      { id: 'team-front', kind: 'team', orchestratorPosition: 'frontend-lead', children: [] },
      { id: 'team-backend', kind: 'team', children: [] },
    ],
    positions: [
      { id: 'ceo', title: '总裁', occupant: { kind: 'agent', preset: 'p' } },
      { id: 'frontend-lead', title: '组长', occupant: { kind: 'agent', preset: 'p' } },
      { id: 'fe-1', title: '前端', teamId: 'team-front', occupant: { kind: 'agent', preset: 'orgos-coder' } },
      { id: 'be-1', title: '后端', teamId: 'team-backend', occupant: { kind: 'agent', preset: 'orgos-coder' } },
    ],
    routes: [],
    acl: {},
  }
  return new OrgTree(cfg)
}

let seq = 0
function makeBoard(): TaskBoard {
  seq += 1
  const local = seq
  let n = 0
  return new TaskBoard(makeTree(), {
    now: () => 1000 + local * 1000,
    idFactory: () => `t-${local}-${++n}`,
  })
}

function createOk(tb: TaskBoard, overrides?: Partial<Parameters<TaskBoard['create']>[0]>): ReturnType<TaskBoard['create']> extends { ok: true; item: infer T } ? { ok: true; item: T } : never {
  const r = tb.create({
    teamId: 'team-front',
    title: '任务',
    assignee: 'fe-1',
    createdBy: 'frontend-lead',
    ...overrides,
  })
  expect(r.ok).toBe(true)
  if (!r.ok) throw new Error(r.message)
  return r
}

describe('Given CAS 并发控制(expectedRevision)', () => {
  it('When 创建任务 Then revision 从 1 起', () => {
    const tb = makeBoard()
    const r = createOk(tb)
    expect(r.item.revision).toBe(1)
  })

  it('When claim 携带正确 revision Then 成功且 revision+1;done 再 +1', () => {
    const tb = makeBoard()
    const created = createOk(tb)
    const claimed = tb.claim(created.item.id, 'fe-1', { expectedRevision: created.item.revision })
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) return
    expect(claimed.item.status).toBe('claimed')
    expect(claimed.item.revision).toBe(2)
    const done = tb.done(created.item.id, 'fe-1', { expectedRevision: claimed.item.revision })
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(done.item.status).toBe('done')
    expect(done.item.revision).toBe(3)
  })

  it('When claim 携带陈旧 revision Then STALE_REVISION 且 message 含当前 revision、状态不变', () => {
    const tb = makeBoard()
    const created = createOk(tb)
    const r = tb.claim(created.item.id, 'fe-1', { expectedRevision: 99 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('STALE_REVISION')
    expect(r.message).toContain('当前 1')
    // 陈旧操作不改变任务
    expect(tb.get(created.item.id)?.revision).toBe(1)
    expect(tb.get(created.item.id)?.status).toBe('open')
  })

  it('When done/cancel/remove 携带陈旧 revision Then STALE_REVISION', () => {
    const tb = makeBoard()
    const created = createOk(tb)
    tb.claim(created.item.id, 'fe-1') // revision → 2
    expect((tb.done(created.item.id, 'fe-1', { expectedRevision: 1 }) as { ok: false }).code).toBe('STALE_REVISION')
    expect((tb.cancel(created.item.id, 'fe-1', { expectedRevision: 1 }) as { ok: false }).code).toBe('STALE_REVISION')
    expect((tb.remove(created.item.id, 'fe-1', { expectedRevision: 1 }) as { ok: false }).code).toBe('STALE_REVISION')
  })

  it('When 未提供 expectedRevision Then 宽松语义(向后兼容)', () => {
    const tb = makeBoard()
    const created = createOk(tb)
    const claimed = tb.claim(created.item.id, 'fe-1')
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) return
    expect(claimed.item.revision).toBe(2)
  })

  it('When 操作不存在任务 Then TASK_NOT_FOUND(带 expectedRevision 亦然)', () => {
    const tb = makeBoard()
    expect((tb.claim('ghost', 'fe-1', { expectedRevision: 1 }) as { ok: false }).code).toBe('TASK_NOT_FOUND')
  })
})

describe('Given tombstone 删除(remove)', () => {
  it('When remove Then status=cancelled 且 deletedAt 置位、revision+1', () => {
    const tb = makeBoard()
    const created = createOk(tb)
    const r = tb.remove(created.item.id, 'fe-1')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.item.status).toBe('cancelled')
    expect(r.item.deletedAt).toBe(1000 + seq * 1000)
    expect(r.item.revision).toBe(2)
  })

  it('When remove 后 list 不含该任务、get 返回带 deletedAt 的对象、listAll 可见', () => {
    const tb = makeBoard()
    const a = createOk(tb)
    const b = createOk(tb)
    tb.remove(a.item.id, 'fe-1')
    expect(tb.list().map((t) => t.id)).toEqual([b.item.id])
    expect(tb.get(a.item.id)?.deletedAt).toBeDefined()
    expect(tb.listAll().map((t) => t.id)).toContain(a.item.id)
  })

  it('When 对已删除任务 claim/done/cancel/remove Then TASK_DELETED', () => {
    const tb = makeBoard()
    const created = createOk(tb)
    tb.remove(created.item.id, 'fe-1')
    for (const op of ['claim', 'done', 'cancel', 'remove'] as const) {
      const r = tb[op](created.item.id, 'fe-1') as { ok: false }
      expect(r.ok).toBe(false)
      expect(r.code).toBe('TASK_DELETED')
    }
  })

  it('When remove 不存在任务 Then TASK_NOT_FOUND', () => {
    const tb = makeBoard()
    expect((tb.remove('ghost', 'fe-1') as { ok: false }).code).toBe('TASK_NOT_FOUND')
  })

  it('When 他人 remove Then PERMISSION_DENIED;创建者/组长 remove Then 允许', () => {
    const tb = makeBoard()
    const created = createOk(tb)
    expect((tb.remove(created.item.id, 'be-1') as { ok: false }).code).toBe('PERMISSION_DENIED')
    expect(tb.remove(created.item.id, 'frontend-lead').ok).toBe(true)
    const created2 = createOk(tb)
    expect(tb.remove(created2.item.id, 'frontend-lead').ok).toBe(true)
  })

  it('When remove 携带正确 revision Then 成功;陈旧 Then STALE_REVISION', () => {
    const tb = makeBoard()
    const created = createOk(tb)
    expect(tb.remove(created.item.id, 'fe-1', { expectedRevision: created.item.revision }).ok).toBe(true)
    const created2 = createOk(tb)
    expect((tb.remove(created2.item.id, 'fe-1', { expectedRevision: 5 }) as { ok: false }).code).toBe('STALE_REVISION')
  })
})

describe('Given DAG 依赖(deps)', () => {
  it('When create 带 deps 指向未删除任务 Then 成功且 deps 入任务', () => {
    const tb = makeBoard()
    const base = createOk(tb)
    const r = tb.create({ teamId: 'team-front', title: '子任务', assignee: 'fe-1', createdBy: 'frontend-lead', deps: [base.item.id] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.item.deps).toEqual([base.item.id])
    expect(r.item.revision).toBe(1)
  })

  it('When deps 指向不存在/已删除任务 Then TASK_NOT_FOUND', () => {
    const tb = makeBoard()
    const ghost = tb.create({ teamId: 'team-front', title: 'x', assignee: 'fe-1', createdBy: 'frontend-lead', deps: ['ghost'] })
    expect(ghost.ok).toBe(false)
    if (ghost.ok) return
    expect(ghost.code).toBe('TASK_NOT_FOUND')
    // 已删除依赖
    const base = createOk(tb)
    tb.remove(base.item.id, 'fe-1')
    const onDeleted = tb.create({ teamId: 'team-front', title: 'y', assignee: 'fe-1', createdBy: 'frontend-lead', deps: [base.item.id] })
    expect((onDeleted as { ok: false }).code).toBe('TASK_NOT_FOUND')
  })

  it('When create 自依赖 Then DEPENDENCY_CYCLE', () => {
    // 固定 idFactory:任务自身 id 可知,可精确构造自依赖
    const tb = new TaskBoard(makeTree(), { now: () => 1, idFactory: () => 'self-task' })
    const r = tb.create({ teamId: 'team-front', title: '自依赖', assignee: 'fe-1', createdBy: 'frontend-lead', deps: ['self-task'] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('DEPENDENCY_CYCLE')
  })

  it('Then 重复 deps 被去重(宽容处理)', () => {
    const tb = makeBoard()
    const base = createOk(tb)
    const r = createOk(tb, { deps: [base.item.id, base.item.id] })
    expect(r.item.deps).toEqual([base.item.id])
  })

  it('When 依赖链合法 Then 多层依赖允许(deps 不阻塞认领/完成)', () => {
    const tb = makeBoard()
    const base = createOk(tb)
    const mid = createOk(tb, { deps: [base.item.id] })
    const top = createOk(tb, { deps: [mid.item.id] })
    expect(top.item.deps).toEqual([mid.item.id])
    // 依赖仅用于有序工作:被依赖任务的 claim/done 不因有后继而阻塞
    expect(tb.claim(base.item.id, 'fe-1').ok).toBe(true)
    expect(tb.done(base.item.id, 'fe-1').ok).toBe(true)
  })

  it('When remove 被未删除任务依赖的任务 Then TASK_HAS_DEPENDENTS', () => {
    const tb = makeBoard()
    const base = createOk(tb)
    createOk(tb, { deps: [base.item.id] })
    const r = tb.remove(base.item.id, 'fe-1')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('TASK_HAS_DEPENDENTS')
    expect(r.message).toContain('依赖')
  })
})

describe('Given 既有语义回归(与 Mailbox.test.ts 生命周期块一致)', () => {
  it('Then 完成闭环后 cancel 仍 STATE_ILLEGAL;取消后 claim 仍 STATE_ILLEGAL', () => {
    const tb = makeBoard()
    const created = createOk(tb)
    tb.claim(created.item.id, 'fe-1')
    expect(tb.done(created.item.id, 'fe-1').ok).toBe(true)
    expect((tb.cancel(created.item.id, 'fe-1') as { ok: false }).code).toBe('STATE_ILLEGAL')
    const created2 = createOk(tb)
    expect(tb.cancel(created2.item.id, 'frontend-lead').ok).toBe(true)
    expect((tb.claim(created2.item.id, 'fe-1') as { ok: false }).code).toBe('STATE_ILLEGAL')
  })
})
