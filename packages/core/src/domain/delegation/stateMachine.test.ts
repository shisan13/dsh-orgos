/**
 * 委派状态机测试(技术设计 §4.3 全路径;GWT)
 */
import { describe, expect, it } from 'vitest'
import { transition, validateBrief, DelegationStateError, type Delegation } from './stateMachine.ts'
import type { BriefV1 } from '../types.ts'

function makeDelegation(overrides?: Partial<Delegation>): Delegation {
  return {
    id: 'dlg-1',
    fromNodeId: 'acme',
    fromPositionId: 'ceo',
    toPositionId: 'coder-1',
    toOccupantKind: 'agent',
    brief: { target: 'coder-1', task: '修 bug', requirements: ['复现'], acceptance: ['通过'] },
    briefVersion: 1,
    attempt: 0,
    status: 'queued',
    timeline: [{ at: 1000, type: 'delegate', by: 'ceo' }],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

function brief(overrides?: Partial<BriefV1>): BriefV1 {
  return { target: 'coder-1', task: '修 bug', requirements: ['复现'], acceptance: ['通过'], ...overrides }
}

describe('Given 一条 queued 委派', () => {
  it('When dispatch Then 状态 dispatched 且时间线追加', () => {
    const next = transition(makeDelegation(), 'dispatch', 2000)
    expect(next.status).toBe('dispatched')
    expect(next.timeline).toHaveLength(2)
    expect(next.updatedAt).toBe(2000)
  })

  it('When cancel Then 状态 cancelled', () => {
    const next = transition(makeDelegation(), 'cancel', 2000)
    expect(next.status).toBe('cancelled')
  })

  it('When 非法事件 Then 抛 DelegationStateError', () => {
    expect(() => transition(makeDelegation(), 'claim', 2000)).toThrow(DelegationStateError)
  })
})

describe('Given 一条 dispatched 委派', () => {
  const d = () => transition(makeDelegation(), 'dispatch', 2000)

  it('When claim Then running', () => {
    expect(transition(d(), 'claim', 3000).status).toBe('running')
  })

  it('When timeout Then timeout', () => {
    expect(transition(d(), 'timeout', 3000).status).toBe('timeout')
  })
})

describe('Given 一条 running 委派', () => {
  const d = () => transition(transition(makeDelegation(), 'dispatch', 2000), 'claim', 3000)

  it('When complete Then completed 且报告入状态', () => {
    const next = transition(d(), 'complete', 4000, { report: '已修复,验证通过' })
    expect(next.status).toBe('completed')
    expect(next.report).toBe('已修复,验证通过')
  })

  it('When fail Then failed', () => {
    expect(transition(d(), 'fail', 4000).status).toBe('failed')
  })
})

describe('Given 一条 failed 委派(agent)', () => {
  const d = () => transition(transition(transition(makeDelegation(), 'dispatch', 2000), 'claim', 3000), 'fail', 4000)

  it('When retry Then dispatched 且 attempt+1', () => {
    const next = transition(d(), 'retry', 5000, { attempt: 1 })
    expect(next.status).toBe('dispatched')
    expect(next.attempt).toBe(1)
  })

  it('When reassign Then dispatched 且换岗位', () => {
    const next = transition(d(), 'reassign', 5000, { toPositionId: 'coder-2' })
    expect(next.status).toBe('dispatched')
    expect(next.toPositionId).toBe('coder-2')
  })

  it('When escalate Then escalated', () => {
    const next = transition(d(), 'escalate', 5000, { escalationToNodeId: 'dept-web' })
    expect(next.status).toBe('escalated')
    expect(next.escalationToNodeId).toBe('dept-web')
  })
})

describe('Given 一条 failed-final 委派', () => {
  const d = () => transition(transition(transition(makeDelegation(), 'dispatch', 2000), 'claim', 3000), 'fail', 4000)

  it('When escalate Then escalated(唯一出口)', () => {
    const next = transition({ ...d(), status: 'failed-final' }, 'escalate', 5000)
    expect(next.status).toBe('escalated')
    expect(() => transition({ ...d(), status: 'failed-final' }, 'retry', 5000)).toThrow(DelegationStateError)
  })
})

describe('Given 终态委派(completed/escalated/cancelled)', () => {
  it('Then 任何事件都抛错', () => {
    for (const status of ['completed', 'escalated', 'cancelled'] as const) {
      const d = makeDelegation({ status })
      expect(() => transition(d, 'retry', 5000)).toThrow(DelegationStateError)
      expect(() => transition(d, 'cancel', 5000)).toThrow(DelegationStateError)
    }
  })
})

describe('Given Brief V1 校验(技术设计 §10.1;FR-D2)', () => {
  it('When 合法 brief Then 无 issue', () => {
    expect(validateBrief(brief())).toEqual([])
    expect(validateBrief(brief({ timeoutMinutes: 30 }))).toEqual([])
  })

  it('When 缺 target/task/requirements/acceptance Then 逐字段 issue', () => {
    const issues = validateBrief({})
    expect(issues.map((i) => i.field).sort()).toEqual(['acceptance', 'requirements', 'target', 'task'])
  })

  it('When requirements 为空数组 Then issue', () => {
    expect(validateBrief(brief({ requirements: [] }))).toEqual([{ field: 'requirements', message: expect.any(String) }])
  })

  it('When requirements 含空串 Then issue', () => {
    const issues = validateBrief(brief({ requirements: ['', 'ok'] }))
    expect(issues.some((i) => i.field === 'requirements')).toBe(true)
  })

  it('When timeoutMinutes 非法 Then issue', () => {
    expect(validateBrief(brief({ timeoutMinutes: 0 })).some((i) => i.field === 'timeoutMinutes')).toBe(true)
    expect(validateBrief(brief({ timeoutMinutes: -1 })).some((i) => i.field === 'timeoutMinutes')).toBe(true)
  })

  it('When 非对象 Then 报 $ issue', () => {
    expect(validateBrief(null)).toEqual([{ field: '$', message: 'brief 必须是对象' }])
    expect(validateBrief('x')).toEqual([{ field: '$', message: 'brief 必须是对象' }])
  })
})
