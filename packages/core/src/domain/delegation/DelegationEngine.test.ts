/**
 * DelegationEngine 测试(§4.3 全链路 GWT:派发-完成 / 失败-重派-升级 / human 催办-升级-转交)
 * 组织:acme(ceo)→ bg-eng(cto)→ dept-web → team-front(frontend-lead)/ team-backend
 */
import { describe, expect, it } from 'vitest'
import { DelegationEngine, type EngineResult } from './DelegationEngine.ts'
import { OrgTree } from '../org/OrgTree.ts'
import type { AclConfig, BriefV1, TeamConfig } from '../types.ts'

function makeTree(): OrgTree {
  const cfg: TeamConfig = {
    org: 'acme',
    nodes: [
      { id: 'acme', kind: 'org', orchestratorPosition: 'ceo', children: ['bg-eng'] },
      { id: 'bg-eng', kind: 'bg', orchestratorPosition: 'cto', children: ['dept-web'] },
      { id: 'dept-web', kind: 'dept', children: ['team-front', 'team-backend'] },
      { id: 'team-front', kind: 'team', orchestratorPosition: 'frontend-lead', children: [] },
      { id: 'team-backend', kind: 'team', children: [] },
    ],
    positions: [
      { id: 'ceo', title: '总裁', occupant: { kind: 'agent', preset: 'p' } },
      { id: 'cto', title: 'CTO', occupant: { kind: 'agent', preset: 'p' } },
      { id: 'frontend-lead', title: '组长', occupant: { kind: 'human', im: { channel: 'feishu', userId: 'ou_lead' } } },
      { id: 'fe-1', title: '前端', teamId: 'team-front', occupant: { kind: 'agent', preset: 'orgos-coder' } },
      { id: 'be-1', title: '后端', teamId: 'team-backend', occupant: { kind: 'agent', preset: 'orgos-coder' } },
      { id: 'human-1', title: '人类成员', teamId: 'team-front', occupant: { kind: 'human', im: { channel: 'feishu', userId: 'ou_h1' } } },
      { id: 'shared-1', title: '公开助手', teamId: 'team-front', restricted: true, occupant: { kind: 'agent', preset: 'orgos-shared' } },
    ],
    routes: [],
    acl: { delegationDepthMax: 3, memberConcurrencyMax: 2 },
  }
  return new OrgTree(cfg)
}

let seq = 0
function makeEngine(acl?: AclConfig, opts?: Partial<ConstructorParameters<typeof DelegationEngine>[2]>): DelegationEngine {
  seq += 1
  const localSeq = seq
  let n = 0
  return new DelegationEngine(makeTree(), acl ?? {}, {
    now: () => 1000 + seq * 1000,
    idFactory: () => `dlg-${localSeq}-${++n}`,
    ...opts,
  })
}

function brief(target: string, overrides?: Partial<BriefV1>): BriefV1 {
  return { target, task: '写一个模块', requirements: ['有接口'], acceptance: ['测试通过'], ...overrides }
}

function expectOk<T>(r: EngineResult<T>): T {
  expect(r.ok).toBe(true)
  if (!r.ok) throw new Error(r.error.message)
  return r.value
}

describe('Given 派发校验', () => {
  it('When 非 orchestrator 派发 Then NOT_ORCHESTRATOR', () => {
    const e = makeEngine()
    const r = e.delegate('fe-1', brief('be-1'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('NOT_ORCHESTRATOR')
  })

  it('When brief 缺字段 Then BRIEF_INVALID 带字段级 details', () => {
    const e = makeEngine()
    const r = e.delegate('ceo', { target: 'fe-1', task: 'x', requirements: [], acceptance: [] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('BRIEF_INVALID')
    expect(r.error.details?.length).toBeGreaterThan(0)
  })

  it('When target 不存在 Then TARGET_NOT_FOUND', () => {
    const e = makeEngine()
    const r = e.delegate('ceo', brief('ghost'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('TARGET_NOT_FOUND')
  })

  it('When target=auto Then AUTO_UNSUPPORTED(M2 演进点)', () => {
    const e = makeEngine()
    const r = e.delegate('ceo', brief('auto'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('AUTO_UNSUPPORTED')
  })

  it('When 目标不在管辖子树 Then OUT_OF_SUBTREE(跨 BG 需上层中转)', () => {
    const cfg: TeamConfig = {
      org: 'acme',
      nodes: [
        { id: 'acme', kind: 'org', orchestratorPosition: 'ceo', children: ['bg-a', 'bg-b'] },
        { id: 'bg-a', kind: 'bg', orchestratorPosition: 'cto-a', children: ['team-a'] },
        { id: 'bg-b', kind: 'bg', children: ['team-b'] },
        { id: 'team-a', kind: 'team', children: [] },
        { id: 'team-b', kind: 'team', children: [] },
      ],
      positions: [
        { id: 'ceo', title: '总裁', occupant: { kind: 'agent', preset: 'p' } },
        { id: 'cto-a', title: 'A 主管', occupant: { kind: 'agent', preset: 'p' } },
        { id: 'm-a', title: 'A 成员', teamId: 'team-a', occupant: { kind: 'agent', preset: 'p' } },
        { id: 'm-b', title: 'B 成员', teamId: 'team-b', occupant: { kind: 'agent', preset: 'p' } },
      ],
      routes: [],
      acl: {},
    }
    const e = new DelegationEngine(new OrgTree(cfg), {}, { now: () => 1, idFactory: () => 'd' })
    const r = e.delegate('cto-a', brief('m-b'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('OUT_OF_SUBTREE')
  })

  it('When 委派深度超过上限 Then DEPTH_EXCEEDED', () => {
    const e = makeEngine({ delegationDepthMax: 1 })
    // ceo(0) → fe-1 所在 team-front(3):深度 3 > 1
    const r = e.delegate('ceo', brief('fe-1'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('DEPTH_EXCEEDED')
  })

  it('When 向 restricted 岗位派发 Then ACL_DENY', () => {
    const e = makeEngine()
    const r = e.delegate('ceo', brief('shared-1'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('ACL_DENY')
  })

  it('When 目标并发满 Then CONCURRENCY_EXCEEDED', () => {
    const e = makeEngine({ memberConcurrencyMax: 2 })
    expectOk(e.delegate('ceo', brief('fe-1')))
    expectOk(e.delegate('ceo', brief('fe-1')))
    const r = e.delegate('ceo', brief('fe-1'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('CONCURRENCY_EXCEEDED')
  })

  it('When 向自己派发 Then OUT_OF_SUBTREE', () => {
    const e = makeEngine()
    const r = e.delegate('ceo', brief('ceo'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('OUT_OF_SUBTREE')
  })
})

describe('Given 派发-完成主链路(US1 的机器化)', () => {
  it('When ceo 派发给 fe-1 Then 状态 dispatched 且信息完整', () => {
    const e = makeEngine()
    const d = expectOk(e.delegate('ceo', brief('fe-1')))
    expect(d.status).toBe('dispatched')
    expect(d.fromPositionId).toBe('ceo')
    expect(d.toPositionId).toBe('fe-1')
    expect(d.toOccupantKind).toBe('agent')
    expect(d.briefVersion).toBe(1)
    expect(d.attempt).toBe(0)
    expect(d.timeline).toHaveLength(2)
  })

  it('When 成员完成回执 Then completed 且报告保留', () => {
    const e = makeEngine()
    const d = expectOk(e.delegate('ceo', brief('fe-1')))
    const done = expectOk(e.settle(d.id, 'completed', '已修复,测试通过'))
    expect(done.status).toBe('completed')
    expect(done.report).toBe('已修复,测试通过')
    expect(done.timeline.at(-1)?.type).toBe('complete')
  })

  it('When 回执缺报告 Then STATE_ILLEGAL', () => {
    const e = makeEngine()
    const d = expectOk(e.delegate('ceo', brief('fe-1')))
    const r = e.settle(d.id, 'completed', '  ')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('STATE_ILLEGAL')
  })

  it('When 对不存在委派操作 Then DELEGATION_NOT_FOUND', () => {
    const e = makeEngine()
    expect(e.settle('ghost', 'completed', 'x').ok).toBe(false)
    expect(e.retry('ghost', brief('fe-1')).ok).toBe(false)
    expect(e.nudge('ghost').ok).toBe(false)
    expect(e.reassign('ghost', 'be-1').ok).toBe(false)
    expect(e.cancel('ghost').ok).toBe(false)
    expect(e.markTimeout('ghost').ok).toBe(false)
    expect(e.get('ghost')).toBeUndefined()
  })
})

describe('Given 失败-重派-升级(agent,openclaw 铁律)', () => {
  it('When 失败且未达上限 Then failed,可 retry 重派(attempt+1, briefVersion+1)', () => {
    const e = makeEngine()
    const d = expectOk(e.delegate('ceo', brief('fe-1')))
    const failed = expectOk(e.settle(d.id, 'failed', '测试挂起', 'fe-1'))
    expect(failed.status).toBe('failed')
    const retried = expectOk(e.retry(failed.id, brief('fe-1', { task: '修复后重试' }), 'ceo'))
    expect(retried.status).toBe('dispatched')
    expect(retried.attempt).toBe(1)
    expect(retried.briefVersion).toBe(2)
    expect(retried.brief.task).toBe('修复后重试')
  })

  it('When 重派 3 次后仍失败 Then failed-final → 自动 escalated 且升级目标是父链最近 orchestrator 节点', () => {
    const e = makeEngine({}, { maxAttempts: 3 })
    // cto 派发到 team-front 的 fe-1:cto 节点 bg-eng 的父链 = [acme],acme 有 ceo
    const d = expectOk(e.delegate('cto', brief('fe-1')))
    let cur = d
    for (let i = 0; i < 4; i++) {
      cur = expectOk(e.settle(cur.id, 'failed', `第 ${i + 1} 次失败`, 'fe-1'))
      if (cur.status === 'escalated') break
      // 失败 → 诊断改 brief 重派(≤3 次)
      cur = expectOk(e.retry(cur.id, brief('fe-1', { task: `重派 v${i + 2}` }), 'cto'))
    }
    expect(cur.status).toBe('escalated')
    expect(cur.escalationToNodeId).toBe('acme')
    const failEvents = cur.timeline.filter((t) => t.type === 'fail')
    expect(failEvents).toHaveLength(4)
    const retryEvents = cur.timeline.filter((t) => t.type === 'retry')
    expect(retryEvents).toHaveLength(3)
    expect(cur.timeline.some((t) => t.type === 'escalate' && t.note?.includes('仍失败'))).toBe(true)
  })

  it('When human 岗位失败 Then retry 返回 HUMAN_RETRY_UNSUPPORTED', () => {
    const e = makeEngine()
    const d = expectOk(e.delegate('frontend-lead', brief('human-1')))
    const failed = expectOk(e.settle(d.id, 'failed', '没做完', 'human-1'))
    const r = e.retry(failed.id, brief('human-1'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('HUMAN_RETRY_UNSUPPORTED')
  })
})

describe('Given human 跟踪语义(§4.7.2:催办→升级→转交)', () => {
  it('When 派发给 human 成员 Then 可 nudge 且状态不变、时间线记录', () => {
    const e = makeEngine()
    const d = expectOk(e.delegate('frontend-lead', brief('human-1')))
    expect(d.toOccupantKind).toBe('human')
    const nudged = expectOk(e.nudge(d.id, 'frontend-lead'))
    expect(nudged.status).toBe('dispatched')
    expect(nudged.timeline.at(-1)?.type).toBe('nudge')
  })

  it('When 对 agent 岗位 nudge Then AGENT_NUDGE_UNSUPPORTED', () => {
    const e = makeEngine()
    const d = expectOk(e.delegate('ceo', brief('fe-1')))
    const r = e.nudge(d.id)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('AGENT_NUDGE_UNSUPPORTED')
  })

  it('When 终态/排队态 nudge Then STATE_ILLEGAL', () => {
    const e = makeEngine()
    const d = expectOk(e.delegate('frontend-lead', brief('human-1')))
    expectOk(e.settle(d.id, 'completed', '完成了', 'human-1'))
    const r = e.nudge(d.id)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('STATE_ILLEGAL')
  })

  it('When human 任务停滞 → reassign 转交 Then 状态 dispatched 且目标岗位更新', () => {
    const e = makeEngine()
    const d = expectOk(e.delegate('frontend-lead', brief('human-1')))
    const r = expectOk(e.reassign(d.id, 'fe-1', 'frontend-lead'))
    expect(r.status).toBe('dispatched')
    expect(r.toPositionId).toBe('fe-1')
    expect(r.reassignedToPositionId).toBe('fe-1')
    expect(r.toOccupantKind).toBe('agent')
  })

  it('When 对 agent 岗位 reassign Then AGENT_REASSIGN_UNSUPPORTED', () => {
    const e = makeEngine()
    const d = expectOk(e.delegate('ceo', brief('fe-1')))
    const r = e.reassign(d.id, 'be-1')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('AGENT_REASSIGN_UNSUPPORTED')
  })
})

describe('Given 超时路径(§4.3 timeout → failed)', () => {
  it('When agent 超时且未达上限 Then timeout → failed(供重派)', () => {
    const e = makeEngine()
    const d = expectOk(e.delegate('ceo', brief('fe-1', { timeoutMinutes: 1 })))
    // 时间推进到超时
    const timed = expectOk(e.markTimeout(d.id))
    expect(timed.status).toBe('failed')
    expect(timed.timeline.some((t) => t.type === 'timeout')).toBe(true)
  })

  it('When agent 超时且重派次数已满 Then 直接 escalated 到父链最近 orchestrator 节点', () => {
    const e = makeEngine({}, { maxAttempts: 1 })
    // cto(节点 bg-eng)派发:父链 [acme] 有 ceo → 升级目标 acme
    const d = expectOk(e.delegate('cto', brief('fe-1', { timeoutMinutes: 1 })))
    // 首次超时 → failed(尚可重派 1 次)
    const failed = expectOk(e.markTimeout(d.id))
    expect(failed.status).toBe('failed')
    const retried = expectOk(e.retry(failed.id, brief('fe-1', { task: '重派' }), 'cto'))
    expect(retried.attempt).toBe(1)
    // 重派后再超时 → 已无重派空间 → 直接升级
    const timed = expectOk(e.markTimeout(retried.id))
    expect(timed.status).toBe('escalated')
    expect(timed.escalationToNodeId).toBe('acme')
    // 根 orchestrator 派发的委派无父可升 → escalationToNodeId 缺省(升级事件通知人类用户)
    const d2 = expectOk(e.delegate('ceo', brief('fe-1', { timeoutMinutes: 1 })))
    const t2 = expectOk(e.markTimeout(d2.id))
    expect(t2.status).toBe('failed')
  })

  it('When human 超时 Then 仅记录 timeout 事件,状态不变(等待催办/升级决策)', () => {
    const e = makeEngine()
    const d = expectOk(e.delegate('frontend-lead', brief('human-1', { timeoutMinutes: 1 })))
    const timed = expectOk(e.markTimeout(d.id))
    expect(timed.status).toBe('dispatched')
    expect(timed.timeline.at(-1)?.type).toBe('timeout')
  })

  it('When timeoutOverdue Then 只返回超过时限的进行中委派', () => {
    const e = makeEngine()
    const d1 = expectOk(e.delegate('ceo', brief('fe-1', { timeoutMinutes: 1 })))
    expectOk(e.delegate('ceo', brief('be-1', { timeoutMinutes: 60 })))
    // 以 d1 的 updatedAt 为基准推进 2 分钟:d1 超时、d2 未超时
    const overdue = e.timeoutOverdue(d1.updatedAt + 2 * 60_000)
    expect(overdue.map((d) => d.id)).toEqual([d1.id])
    // 已完成委派不计入超时
    expectOk(e.settle(d1.id, 'completed', '完成了', 'fe-1'))
    expect(e.timeoutOverdue(d1.updatedAt + 2 * 60_000)).toHaveLength(0)
  })
})

describe('Given 取消与快照', () => {
  it('When cancel 进行中委派 Then cancelled', () => {
    const e = makeEngine()
    const d = expectOk(e.delegate('ceo', brief('fe-1')))
    const c = expectOk(e.cancel(d.id, 'ceo'))
    expect(c.status).toBe('cancelled')
  })

  it('Then snapshot 返回全量只读副本(修改副本不影响引擎)', () => {
    const e = makeEngine()
    expectOk(e.delegate('ceo', brief('fe-1')))
    const snap = e.snapshot()
    expect(snap).toHaveLength(1)
    snap[0]!.status = 'completed'
    expect(e.snapshot()[0]?.status).toBe('dispatched')
  })
})
