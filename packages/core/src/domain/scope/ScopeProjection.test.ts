/**
 * ScopeProjection 测试(FR-S1~S5;T10 人类隐私;安全设计 §8 人类隐私投影用例)
 * 组织:acme(ceo)→ bg-eng(cto)→ dept-web → team-front(frontend-lead, 人类)/ team-backend
 */
import { describe, expect, it } from 'vitest'
import { projectMail, projectTasks, projectDelegations, projectMemory, roleScope, visibilityGeometry } from './ScopeProjection.ts'
import { OrgTree } from '../org/OrgTree.ts'
import type { TeamConfig } from '../types.ts'

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
      { id: 'ceo', title: '总裁', occupant: { kind: 'agent', preset: 'orgos-orchestrator-ceo' } },
      { id: 'cto', title: 'CTO', occupant: { kind: 'agent', preset: 'orgos-orchestrator-bg' } },
      { id: 'frontend-lead', title: '组长', occupant: { kind: 'human', im: { channel: 'feishu', userId: 'ou_lead' } } },
      { id: 'fe-1', title: '前端', teamId: 'team-front', occupant: { kind: 'agent', preset: 'orgos-coder' } },
      { id: 'human-1', title: '人类成员', teamId: 'team-front', occupant: { kind: 'human', im: { channel: 'feishu', userId: 'ou_h1' } } },
      { id: 'be-1', title: '后端', teamId: 'team-backend', occupant: { kind: 'agent', preset: 'orgos-coder' } },
      { id: 'shared-1', title: '公开助手', teamId: 'team-front', restricted: true, occupant: { kind: 'agent', preset: 'orgos-shared' } },
    ],
    routes: [],
    acl: {},
  }
  return new OrgTree(cfg)
}

const tree = makeTree()
const ctx = (viewer: string, roles?: TeamConfig['roles']) => ({ tree, viewerPositionId: viewer, roles })

function task(id: string, teamId: string, assignee: string, extra?: Record<string, unknown>): Record<string, unknown> & { id: string; teamId: string; assignee: string } {
  return { id, teamId, assignee, title: `任务${id}`, detail: { report: `${id} 的汇报正文` }, ...extra }
}

describe('Given 五维 scope 推导(§4.6.2 默认表)', () => {
  it('Then 执行岗位默认 self/self/private+team/self+team', () => {
    const s = roleScope(tree, 'fe-1')
    expect(s.visibility).toBe('self')
    expect(s.authority).toBe('self')
    expect(s.memory).toEqual(['private', 'team'])
    expect(s.subscription).toEqual(['self', 'team'])
  })

  it('Then team orchestrator 默认 team/team', () => {
    const s = roleScope(tree, 'frontend-lead')
    expect(s.visibility).toBe('team')
    expect(s.authority).toBe('team')
    expect(s.memory).toContain('team')
  })

  it('Then bg/org orchestrator 逐级放大', () => {
    expect(roleScope(tree, 'cto').visibility).toBe('bg')
    expect(roleScope(tree, 'ceo').visibility).toBe('org')
  })

  it('Then 受限岗位默认 memory 仅 private、subscription 仅 self', () => {
    const s = roleScope(tree, 'shared-1')
    expect(s.memory).toEqual(['private'])
    expect(s.subscription).toEqual(['self'])
  })

  it('Then roles 覆盖生效(团队级收紧,不可放宽由 preset 层约束)', () => {
    const s = roleScope(tree, 'fe-1', { 'orgos-coder': { visibility: 'team', authority: 'self', memory: [], subscription: [] } })
    expect(s.visibility).toBe('team')
    expect(s.authority).toBe('self')
    // 空数组视为"不覆盖",回落默认
    expect(s.memory).toEqual(['private', 'team'])
  })
})

describe('Given visibilityGeometry(可见范围几何)', () => {
  it('Then member 只见所属 team 节点且 selfOnly', () => {
    const g = visibilityGeometry(tree, 'fe-1', roleScope(tree, 'fe-1'))
    expect(g.selfOnly).toBe(true)
    expect([...g.nodeIds]).toEqual(['team-front'])
  })

  it('Then team lead 覆盖整个 team 子树', () => {
    const g = visibilityGeometry(tree, 'frontend-lead', roleScope(tree, 'frontend-lead'))
    expect(g.selfOnly).toBe(false)
    expect([...g.nodeIds]).toEqual(['team-front'])
  })

  it('Then dept orchestrator 覆盖全部子 team', () => {
    // dept-web 无 orchestrator,用 cto(bg 层)验证跨 dept 覆盖
    const g = visibilityGeometry(tree, 'cto', roleScope(tree, 'cto'))
    expect([...g.nodeIds]).toEqual(['bg-eng', 'dept-web', 'team-front', 'team-backend'])
  })
})

describe('Given 任务板投影(FR-S1)', () => {
  const tasks = [
    task('t1', 'team-front', 'fe-1'),
    task('t2', 'team-front', 'human-1'),
    task('t3', 'team-backend', 'be-1'),
  ]

  it('When member 查询 Then 只返回自己相关任务(self)', () => {
    const out = projectTasks(tasks, ctx('fe-1'))
    expect(out.map((t) => t.meta.id)).toEqual(['t1'])
  })

  it('When 治理岗位查询 Then 返回管辖子树全量', () => {
    const out = projectTasks(tasks, ctx('ceo'))
    expect(out.map((t) => t.meta.id).sort()).toEqual(['t1', 't2', 't3'])
  })

  it('When dept 层无 orchestrator 的子树由 bg 覆盖 Then 跨 dept 可见', () => {
    const out = projectTasks(tasks, ctx('cto'))
    expect(out).toHaveLength(3)
  })

  it('Then 越权数据不可达(team-backend 任务对 team-front 成员不可见)', () => {
    const out = projectTasks(tasks, ctx('fe-1'))
    expect(out.some((t) => t.meta.id === 't3')).toBe(false)
  })
})

describe('Given T10 人类任务隐私(安全设计 §8)', () => {
  const tasks = [task('t2', 'team-front', 'human-1', { detail: { report: '人类成员汇报正文', body: '私人内容' }, createdBy: 'fe-1' })]

  it('When 同级 agent 查询人类成员任务(自己创建) Then 只返回元数据且标记 filtered', () => {
    const out = projectTasks(tasks, ctx('fe-1'))
    expect(out).toHaveLength(1)
    expect(out[0]?.meta.id).toBe('t2')
    expect(out[0]?.detail).toBeUndefined()
    expect(out[0]?.filtered).toMatch(/human-privacy/)
  })

  it('When 上级 orchestrator(agent)查询 Then 可下钻详情', () => {
    // ceo 管辖 team-front,是 human-1 的上级
    const out = projectTasks(tasks, ctx('ceo'))
    expect(out[0]?.detail?.report).toBe('人类成员汇报正文')
  })

  it('When 人类成员查询自己任务 Then 可见详情', () => {
    const out = projectTasks(tasks, ctx('human-1'))
    expect(out[0]?.detail?.report).toBe('人类成员汇报正文')
  })
})

describe('Given 邮件投影(FR-S1 邮箱维度)', () => {
  const mails = [
    { id: 'm1', from: 'fe-1', to: 'human-1' },
    { id: 'm2', from: 'ceo', to: { broadcast: true, scope: 'team' as const } },
    { id: 'm3', from: 'ceo', to: { broadcast: true, scope: 'org' as const } },
  ]

  it('When member 查询 Then 只见自己相关邮件 + 订阅的 team 广播', () => {
    const out = projectMail(mails, ctx('fe-1'))
    expect(out.map((m) => m.item.id)).toEqual(['m1', 'm2'])
  })

  it('When org 层查询 Then 可见全部 + org 广播', () => {
    const out = projectMail(mails, ctx('ceo'))
    expect(out.map((m) => m.item.id)).toEqual(['m1', 'm2', 'm3'])
  })

  it('When 跨 team 无关邮件对成员不可见', () => {
    const out = projectMail([{ id: 'x', from: 'fe-1', to: 'human-1' }], ctx('be-1'))
    expect(out).toHaveLength(0)
  })

  it('When shared 成员 Then 只见自己相关(订阅仅 self)', () => {
    const out = projectMail([{ id: 's1', from: 'shared-1', to: 'fe-1' }, { id: 's2', from: 'ceo', to: { broadcast: true, scope: 'team' as const } }], ctx('shared-1'))
    expect(out.map((m) => m.item.id)).toEqual(['s1'])
  })
})

describe('Given 委派视图投影(FR-R3)', () => {
  const delegations = [
    { fromPositionId: 'ceo', toPositionId: 'fe-1' },
    { fromPositionId: 'ceo', toPositionId: 'be-1' },
  ]

  it('When member 查询 Then 只见与自己相关的委派', () => {
    const out = projectDelegations(delegations, ctx('fe-1'))
    expect(out).toHaveLength(1)
    expect(out[0]?.toPositionId).toBe('fe-1')
  })

  it('When org 层查询 Then 全量', () => {
    expect(projectDelegations(delegations, ctx('ceo'))).toHaveLength(2)
  })
})

describe('Given 记忆流投影(§4.6.3)', () => {
  const memories = [
    { id: 'm1', level: 'team', teamId: 'team-front', author: 'fe-1', content: '前端规范' },
    { id: 'm2', level: 'team', teamId: 'team-backend', author: 'be-1', content: '后端规范' },
    { id: 'm3', level: 'org', teamId: undefined, author: 'ceo', content: '集团战略' },
  ]

  it('When 执行岗位查询 Then 只见本 team 记忆(org 层不可见)', () => {
    const out = projectMemory(memories, ctx('fe-1'))
    expect(out.map((m) => m.id)).toEqual(['m1'])
  })

  it('When dept 上层查询 Then 见管辖子树内 team 记忆但 org 层仍不可见', () => {
    const out = projectMemory(memories, ctx('frontend-lead'))
    expect(out.map((m) => m.id)).toEqual(['m1'])
  })

  it('When 根 orchestrator 查询 Then team(管辖全部)+ org 全可见', () => {
    const out = projectMemory(memories, ctx('ceo'))
    expect(out.map((m) => m.id).sort()).toEqual(['m1', 'm2', 'm3'])
  })

  it('When 受限岗位查询 Then 记忆不可见(memory 仅 private)', () => {
    const out = projectMemory(memories, ctx('shared-1'))
    expect(out).toEqual([])
  })
})
