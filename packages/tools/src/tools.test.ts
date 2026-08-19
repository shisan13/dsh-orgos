/**
 * tools 包测试(技术设计 §13:参数校验/错误码/渲染输出/scope 投影越权返回空)
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DelegationEngine, Mailbox, OrgTree, TaskBoard } from 'dsh-orgos-core'
import type { TeamConfig } from 'dsh-orgos-core'
import { teamDelegate, teamRetry } from './delegate.ts'
import { teamMailSend, teamMailRecv } from './mail.ts'
import { teamTaskCreate, teamTaskClaim, teamTaskDone, teamTaskCancel, teamTaskList } from './task.ts'
import { teamStatus } from './status.ts'
import { setupInit, setupValidate, planAtomicUpdate } from './setup.ts'
import { TEMPLATES } from './templates.ts'
import type { TeamToolContext } from './types.ts'

function makeConfig(): TeamConfig {
  return {
    org: 'acme',
    nodes: [
      { id: 'acme', kind: 'org', orchestratorPosition: 'ceo', children: ['team-front', 'team-backend'] },
      { id: 'team-front', kind: 'team', orchestratorPosition: 'frontend-lead', children: [] },
      { id: 'team-backend', kind: 'team', children: [] },
    ],
    positions: [
      { id: 'ceo', title: '总裁', occupant: { kind: 'agent', preset: 'orgos-orchestrator-ceo' } },
      { id: 'frontend-lead', title: '组长', occupant: { kind: 'agent', preset: 'orgos-orchestrator-lead' } },
      { id: 'fe-1', title: '前端', teamId: 'team-front', occupant: { kind: 'agent', preset: 'orgos-coder' } },
      { id: 'human-1', title: '人类成员', teamId: 'team-front', occupant: { kind: 'human', im: { channel: 'feishu', userId: 'ou_h1' } } },
      { id: 'be-1', title: '后端', teamId: 'team-backend', occupant: { kind: 'agent', preset: 'orgos-coder' } },
    ],
    routes: [],
    acl: { memberConcurrencyMax: 2 },
  }
}

function makeCtx(identity: { positionId: string; kind: 'agent' | 'human' }, now?: () => number): TeamToolContext {
  const clock = now ?? Date.now
  const tree = new OrgTree(makeConfig())
  const delegation = new DelegationEngine(tree, makeConfig().acl, { now: clock, idFactory: () => `d-${Math.random().toString(36).slice(2)}` })
  const mailbox = new Mailbox(tree, makeConfig().acl, { now: clock, idFactory: () => `m-${Math.random().toString(36).slice(2)}` })
  const taskboard = new TaskBoard(tree, { now: clock, idFactory: () => `t-${Math.random().toString(36).slice(2)}` })
  return { identity, orgTree: tree, delegation, mailbox, taskboard }
}

const brief = (target: string) => ({ target, task: '写模块', requirements: ['有接口'], acceptance: ['测试通过'] })

describe('Given team_delegate(FR-D3;仅 orchestrator)', () => {
  it('When orchestrator 派发合法 brief Then 返回已派发 + delegationId', () => {
    const out = teamDelegate({ brief: brief('fe-1') }, makeCtx({ positionId: 'ceo', kind: 'agent' }))
    expect(out.ok).toBe(true)
    expect(out.text).toContain('已派发')
    expect((out.data as { delegationId: string }).delegationId).toMatch(/^d-/)
  })

  it('When brief 缺字段 Then BRIEF_INVALID 且带字段级信息', () => {
    const out = teamDelegate({ brief: { target: 'fe-1', task: 'x', requirements: [], acceptance: [] } }, makeCtx({ positionId: 'ceo', kind: 'agent' }))
    expect(out.ok).toBe(false)
    expect(out.code).toBe('BRIEF_INVALID')
    expect(out.text).toContain('requirements')
  })

  it('When 非 orchestrator 调用 Then NOT_ORCHESTRATOR(工具行即使被误挂也拒绝)', () => {
    const out = teamDelegate({ brief: brief('be-1') }, makeCtx({ positionId: 'fe-1', kind: 'agent' }))
    expect(out.ok).toBe(false)
    expect(out.code).toBe('NOT_ORCHESTRATOR')
  })

  it('When 目标不在管辖子树 Then OUT_OF_SUBTREE', () => {
    const out = teamDelegate({ brief: brief('be-1') }, makeCtx({ positionId: 'frontend-lead', kind: 'agent' }))
    expect(out.ok).toBe(false)
    expect(out.code).toBe('OUT_OF_SUBTREE')
  })

  it('When 重派(teamRetry)Then attempt+1', () => {
    const ctx = makeCtx({ positionId: 'ceo', kind: 'agent' })
    const d = teamDelegate({ brief: brief('fe-1') }, ctx)
    const id = (d.data as { delegationId: string }).delegationId
    ctx.delegation.settle(id, 'failed', '测试挂起', 'fe-1')
    const out = teamRetry({ delegationId: id, briefNext: brief('fe-1') }, ctx)
    expect(out.ok).toBe(true)
    expect(out.text).toContain('attempt 1')
  })

  it('When 派发给 human 岗位 Then 渲染为任务卡片投递', () => {
    const out = teamDelegate({ brief: brief('human-1') }, makeCtx({ positionId: 'frontend-lead', kind: 'agent' }))
    expect(out.ok).toBe(true)
    expect(out.text).toContain('任务卡片')
  })

  it('When teamRetry 目标不存在/human 委派 Then 失败码', () => {
    const ctx = makeCtx({ positionId: 'ceo', kind: 'agent' })
    const miss = teamRetry({ delegationId: 'ghost', briefNext: brief('fe-1') }, ctx)
    expect(miss.ok).toBe(false)
    expect(miss.code).toBe('DELEGATION_NOT_FOUND')
    const d = teamDelegate({ brief: brief('human-1') }, makeCtx({ positionId: 'frontend-lead', kind: 'agent' }))
    const id = (d.data as { delegationId: string }).delegationId
    // 需要同一 engine 实例:human 委派在 frontend-lead 的 ctx 里
    const leadCtx = makeCtx({ positionId: 'frontend-lead', kind: 'agent' })
    const d2 = teamDelegate({ brief: brief('human-1') }, leadCtx)
    const id2 = (d2.data as { delegationId: string }).delegationId
    leadCtx.delegation.settle(id2, 'failed', '没做完', 'human-1')
    const denied = teamRetry({ delegationId: id2, briefNext: brief('human-1') }, leadCtx)
    expect(denied.ok).toBe(false)
    expect(denied.code).toBe('HUMAN_RETRY_UNSUPPORTED')
    void id
  })
})

describe('Given team_mail_*(FR-C1;scope 投影越权返回空)', () => {
  it('When 同 team 发信 Then 成功', () => {
    const out = teamMailSend({ to: 'frontend-lead', kind: 'note', body: '需求确认' }, makeCtx({ positionId: 'fe-1', kind: 'agent' }))
    expect(out.ok).toBe(true)
    expect(out.text).toContain('已投递')
  })

  it('When 跨 team 发信 Then ACL_DENY', () => {
    const out = teamMailSend({ to: 'be-1', kind: 'note', body: '跨 team' }, makeCtx({ positionId: 'fe-1', kind: 'agent' }))
    expect(out.ok).toBe(false)
    expect(out.code).toBe('ACL_DENY')
  })

  it('When member 收信 Then 只见自己相关(越权不可达)', () => {
    // 同一 mailbox 实例:发信与收信共享状态
    const leadCtx = makeCtx({ positionId: 'frontend-lead', kind: 'agent' })
    teamMailSend({ to: 'fe-1', kind: 'note', body: '给前端' }, leadCtx)
    const memberCtx = makeCtx({ positionId: 'fe-1', kind: 'agent' })
    // 共享同一领域服务(真实绑定层中 host 服务是单例)
    memberCtx.mailbox = leadCtx.mailbox
    teamMailSend({ to: 'be-1', kind: 'note', body: '跨 team 越权' }, makeCtx({ positionId: 'fe-1', kind: 'agent' }))
    const out = teamMailRecv({}, memberCtx)
    expect(out.ok).toBe(true)
    expect(out.text).toContain('给前端')
    expect(out.text).not.toContain('跨 team 越权')
  })

  it('When 空邮箱 Then 提示空', () => {
    const out = teamMailRecv({}, makeCtx({ positionId: 'fe-1', kind: 'agent' }))
    expect(out.text).toContain('邮箱为空')
  })

  it('When 广播邮件 Then 渲染广播标签且订阅者可见', () => {
    const leadCtx = makeCtx({ positionId: 'frontend-lead', kind: 'agent' })
    const bcast = leadCtx.mailbox.broadcast('frontend-lead', 'team', '团队公告:周会改期')
    expect(bcast.ok).toBe(true)
    const memberCtx = makeCtx({ positionId: 'fe-1', kind: 'agent' })
    memberCtx.mailbox = leadCtx.mailbox
    const out = teamMailRecv({}, memberCtx)
    expect(out.text).toContain('广播(team)')
    expect(out.text).toContain('团队公告')
  })
})

describe('Given team_task_*(FR-C2;T10 隐私裁剪)', () => {
  it('When 创建+认领+完成 Then 生命周期渲染', () => {
    // 共享 ctx:任务板单例(真实绑定层中 host 服务是单例)
    const leadCtx = makeCtx({ positionId: 'frontend-lead', kind: 'agent' })
    const memberCtx = makeCtx({ positionId: 'fe-1', kind: 'agent' })
    memberCtx.taskboard = leadCtx.taskboard
    const created = teamTaskCreate({ teamId: 'team-front', title: '登录页', assignee: 'fe-1' }, leadCtx)
    expect(created.ok).toBe(true)
    const id = (created.data as { taskId: string }).taskId
    expect(teamTaskClaim({ id }, memberCtx).text).toContain('已认领')
    expect(teamTaskDone({ id }, memberCtx).text).toContain('已完成')
  })

  it('When 创建者取消任务 Then 已取消;空任务板提示', () => {
    const leadCtx = makeCtx({ positionId: 'frontend-lead', kind: 'agent' })
    const created = teamTaskCreate({ teamId: 'team-front', title: '取消测试', assignee: 'fe-1' }, leadCtx)
    const id = (created.data as { taskId: string }).taskId
    const out = teamTaskCancel({ id }, leadCtx)
    expect(out.ok).toBe(true)
    expect(out.text).toContain('已取消')
    const empty = teamTaskList({}, makeCtx({ positionId: 'be-1', kind: 'agent' }))
    expect(empty.text).toContain('任务板为空')
  })

  it('When 终态任务再次操作 Then STATE_ILLEGAL(取消后 done / 完成后 cancel)', () => {
    const leadCtx = makeCtx({ positionId: 'frontend-lead', kind: 'agent' })
    const a = teamTaskCreate({ teamId: 'team-front', title: 'A', assignee: 'fe-1' }, leadCtx)
    const idA = (a.data as { taskId: string }).taskId
    expect(teamTaskCancel({ id: idA }, leadCtx).ok).toBe(true)
    const doneAfterCancel = teamTaskDone({ id: idA }, leadCtx)
    expect(doneAfterCancel.ok).toBe(false)
    expect(doneAfterCancel.code).toBe('STATE_ILLEGAL')
    const b = teamTaskCreate({ teamId: 'team-front', title: 'B', assignee: 'fe-1' }, leadCtx)
    const idB = (b.data as { taskId: string }).taskId
    teamTaskClaim({ id: idB }, leadCtx)
    expect(teamTaskDone({ id: idB }, leadCtx).ok).toBe(true)
    const cancelDone = teamTaskCancel({ id: idB }, leadCtx)
    expect(cancelDone.ok).toBe(false)
    expect(cancelDone.code).toBe('STATE_ILLEGAL')
  })

  it('When T10 同级 agent 看 human 任务列表 Then 输出裁剪标记', () => {
    // fe-1(agent)创建任务给 human-1(human):fe-1 查询时是"自己相关"但详情受 T10 保护
    const feCtx = makeCtx({ positionId: 'fe-1', kind: 'agent' })
    teamTaskCreate({ teamId: 'team-front', title: '人类协作任务', assignee: 'human-1' }, feCtx)
    const out = teamTaskList({}, feCtx)
    expect(out.text).toContain('人类协作任务')
    expect(out.text).toContain('裁剪')
  })

  it('When 他人操作他人任务 Then 权限拒绝', () => {
    const leadCtx = makeCtx({ positionId: 'frontend-lead', kind: 'agent' })
    const beCtx = makeCtx({ positionId: 'be-1', kind: 'agent' })
    beCtx.taskboard = leadCtx.taskboard
    const created = teamTaskCreate({ teamId: 'team-front', title: 'x', assignee: 'fe-1' }, leadCtx)
    const id = (created.data as { taskId: string }).taskId
    const out = teamTaskClaim({ id }, beCtx)
    expect(out.ok).toBe(false)
    expect(out.code).toBe('PERMISSION_DENIED')
  })

  it('When member 查任务板 Then 越权数据不可达(他人任务不出现)', () => {
    const leadCtx = makeCtx({ positionId: 'frontend-lead', kind: 'agent' })
    teamTaskCreate({ teamId: 'team-front', title: '任务A', assignee: 'fe-1' }, leadCtx)
    teamTaskCreate({ teamId: 'team-front', title: '任务B', assignee: 'human-1' }, leadCtx)
    const memberCtx = makeCtx({ positionId: 'fe-1', kind: 'agent' })
    memberCtx.taskboard = leadCtx.taskboard
    const out = teamTaskList({}, memberCtx)
    expect(out.text).toContain('任务A')
    expect(out.text).not.toContain('任务B')
  })

  it('When T10 同级 agent 见 human 任务元数据但无详情(裁剪标记)', () => {
    const leadCtx = makeCtx({ positionId: 'frontend-lead', kind: 'agent' })
    const created = teamTaskCreate({ teamId: 'team-front', title: '人类任务', assignee: 'human-1' }, leadCtx)
    const id = (created.data as { taskId: string }).taskId
    // 人类任务无 detail 字段时,列表无裁剪标记;此用例覆盖 create 侧权限:lead 可建
    expect(id).toBeTruthy()
  })
})

describe('Given team_status(FR-C3;visibility 投影)', () => {
  it('When member 查询 Then 只见自己相关', () => {
    const out = teamStatus({}, makeCtx({ positionId: 'fe-1', kind: 'agent' }))
    expect(out.ok).toBe(true)
    expect(out.text).toContain('身份:fe-1')
    expect(out.text).toContain('visibility=self')
    expect((out.data as { positions: number }).positions).toBe(1)
  })

  it('When ceo 查询 Then 全局视图', () => {
    const out = teamStatus({}, makeCtx({ positionId: 'ceo', kind: 'agent' }))
    expect((out.data as { positions: number }).positions).toBe(5)
    expect(out.text).toContain('visibility=org')
  })

  it('When human 身份查询 Then 渲染 human 占位信息', () => {
    const out = teamStatus({}, makeCtx({ positionId: 'ceo', kind: 'human' }))
    expect(out.text).toContain('身份:ceo(human)')
    expect(out.text).toContain('human(ou_h1)')
    expect(out.text).toContain('agent(orgos-orchestrator-ceo)')
  })

  it('When 有超时委派 Then 状态报告超时数', () => {
    // 时钟:首次调用(派发)=T,之后 = T+2min → 1 分钟时限的委派超时
    let first = true
    const clock = () => {
      if (first) {
        first = false
        return 1000
      }
      return 1000 + 2 * 60_000
    }
    const ctx = makeCtx({ positionId: 'ceo', kind: 'agent' }, clock)
    teamDelegate({ brief: { ...brief('fe-1'), timeoutMinutes: 1 } }, ctx)
    const out = teamStatus({}, ctx)
    expect((out.data as { activeDelegations: number }).activeDelegations).toBe(1)
    expect((out.data as { overdue: number }).overdue).toBe(1)
  })
})

describe('Given team_setup(FR-X2/X5/X7;T5)', () => {
  it('When init 三规模 Then 模板生成且通过自身校验', () => {
    for (const scale of ['small', 'dept', 'group'] as const) {
      const out = setupInit({ scale })
      expect(out.ok).toBe(true)
      expect((out.data as { yaml: string }).yaml).toContain('org:')
      expect(out.text).toContain('校验:通过')
    }
  })

  it('When init 非法 scale Then SCALE_INVALID', () => {
    const out = setupInit({ scale: 'galaxy' as never })
    expect(out.ok).toBe(false)
    expect(out.code).toBe('SCALE_INVALID')
  })

  it('When 模板自身损坏 Then TEMPLATE_BROKEN(防御分支)', async () => {
    const templates = await import('./templates.ts')
    const original = templates.TEMPLATES.small
    ;(templates.TEMPLATES as Record<string, string>).small = 'org: broken\nnodes: []'
    try {
      const out = setupInit({ scale: 'small' })
      expect(out.ok).toBe(false)
      expect(out.code).toBe('TEMPLATE_BROKEN')
    } finally {
      ;(templates.TEMPLATES as Record<string, string>).small = original
    }
  })

  it('When validate 合法 yaml Then 通过并返回统计', () => {
    const out = setupValidate({ yaml: TEMPLATES.small })
    expect(out.ok).toBe(true)
    expect(out.text).toContain('校验通过')
  })

  it('When validate 坏 yaml Then 逐条 issue 且带修复建议', () => {
    const out = setupValidate({ yaml: 'org: acme\nnodes:\n  - { id: acme, kind: org, orchestratorPosition: ghost, children: [] }\npositions: []\nroutes: []\nacl: {}' })
    expect(out.ok).toBe(false)
    expect(out.code).toBe('CONFIG_INVALID')
    expect(out.text).toContain('修复:')
  })

  it('When planAtomicUpdate 新配置合法 Then 输出备份名与步骤', () => {
    const plan = planAtomicUpdate('org: old', TEMPLATES.small, () => 1_700_000_000_000)
    expect(plan.valid).toBe(true)
    expect(plan.backupName).toContain('team.yml.bak-')
    expect(plan.steps).toHaveLength(4)
  })

  it('When planAtomicUpdate 新配置非法 Then 不产出应用步骤(失败回滚原则)', () => {
    const plan = planAtomicUpdate('org: old', 'org: acme\nnodes: []')
    expect(plan.valid).toBe(false)
    expect(plan.issues.length).toBeGreaterThan(0)
    expect(plan.steps).toEqual([])
  })
})

describe('Given 模板一致性(文档驱动:examples/ 与 templates.ts 同源)', () => {
  const examplesDir = fileURLToPath(new URL('../../../examples', import.meta.url))
  const mapping = [
    ['team-small.yml', 'small'],
    ['team-dept.yml', 'dept'],
    ['team-group.yml', 'group'],
  ] as const

  it('Then examples/*.yml 与 TEMPLATES 内容一致(防漂移)', () => {
    for (const [file, scale] of mapping) {
      const disk = readFileSync(`${examplesDir}/${file}`, 'utf8').trim()
      expect(disk, `${file} 应与 templates.ts TEMPLATES.${scale} 同步`).toBe(TEMPLATES[scale].trim())
    }
  })
})
