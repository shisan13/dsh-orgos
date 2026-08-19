/**
 * Mailbox + TaskBoard 测试(FR-C1/C2;安全设计 §4.2 ACL 判定顺序)
 */
import { describe, expect, it } from 'vitest'
import { Mailbox } from './Mailbox.ts'
import { TaskBoard } from '../taskboard/TaskBoard.ts'
import { OrgTree } from '../org/OrgTree.ts'
import type { AclConfig, TeamConfig } from '../types.ts'

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
      { id: 'shared-1', title: '公开助手', teamId: 'team-front', restricted: true, occupant: { kind: 'agent', preset: 'orgos-shared' } },
    ],
    routes: [],
    acl: {},
  }
  return new OrgTree(cfg)
}

let seq = 0
function makeMailbox(acl?: AclConfig): Mailbox {
  seq += 1
  let n = 0
  return new Mailbox(makeTree(), acl ?? {}, { now: () => seq * 1000, idFactory: () => `mail-${seq}-${++n}` })
}

describe('Given Mailbox 定向投递(ACL 判定顺序 block → allowCrossTeam → 同 team → deny)', () => {
  it('When 同 team 互发 Then 允许', () => {
    const mb = makeMailbox()
    const r = mb.send('fe-1', 'frontend-lead', 'note', '需求确认')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.item.kind).toBe('note')
      expect(r.item.refs).toEqual([])
      expect(mb.list()).toHaveLength(1)
    }
  })

  it('When 跨 team 未授权 Then ACL_DENY', () => {
    const mb = makeMailbox()
    const r = mb.send('fe-1', 'be-1', 'note', '跨 team 协作')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('ACL_DENY')
  })

  it('When 跨 team 显式声明且 scope 匹配 Then 允许', () => {
    const mb = makeMailbox({ allowCrossTeam: [{ from: 'team-front', to: 'team-backend', scopes: ['note', 'result'] }] })
    expect(mb.send('fe-1', 'be-1', 'note', 'hi').ok).toBe(true)
    // scope 不匹配仍拒绝
    const r = mb.send('fe-1', 'be-1', 'task', '派活')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('ACL_DENY')
  })

  it('When block 命中 Then 拒绝(block 优先于 allowCrossTeam)', () => {
    const mb = makeMailbox({
      allowCrossTeam: [{ from: 'team-front', to: 'team-backend', scopes: ['note'] }],
      block: [{ to: 'team-backend' }],
    })
    const r = mb.send('fe-1', 'be-1', 'note', 'hi')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('ACL_DENY')
  })

  it('When 向 restricted 岗位投递 Then 拒绝(T7 shared 排除)', () => {
    const mb = makeMailbox()
    const r = mb.send('fe-1', 'shared-1', 'note', 'hello')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('ACL_DENY')
  })

  it('When 发件/收件岗位不存在 Then 对应错误码', () => {
    const mb = makeMailbox()
    expect(mb.send('ghost', 'fe-1', 'note', 'x').ok).toBe(false)
    expect(mb.send('fe-1', 'ghost', 'note', 'x').ok).toBe(false)
  })

  it('When 空正文 Then EMPTY_BODY', () => {
    const mb = makeMailbox()
    const r = mb.send('fe-1', 'frontend-lead', 'note', '   ')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('EMPTY_BODY')
  })

  it('When escalation 类型跨 team 无声明 Then 拒绝(升级走父链,不借协作白名单)', () => {
    const mb = makeMailbox()
    const r = mb.send('fe-1', 'be-1', 'escalation', '升级')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('ACL_DENY')
  })
})

describe('Given Mailbox 公告广播(FR-F4)', () => {
  it('When org 根 orchestrator 发 org 广播 Then 允许', () => {
    const mb = makeMailbox()
    const r = mb.broadcast('ceo', 'org', '集团公告:新季度目标')
    expect(r.ok).toBe(true)
  })

  it('When 非根 orchestrator 发 org 广播 Then BROADCAST_FORBIDDEN', () => {
    const mb = makeMailbox()
    const r = mb.broadcast('frontend-lead', 'org', '越权公告')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('BROADCAST_FORBIDDEN')
  })

  it('When team orchestrator 发 team 广播 Then 允许', () => {
    const mb = makeMailbox()
    const r = mb.broadcast('frontend-lead', 'team', '团队公告')
    expect(r.ok).toBe(true)
  })

  it('When 普通成员发 team 广播 Then BROADCAST_FORBIDDEN', () => {
    const mb = makeMailbox()
    const r = mb.broadcast('fe-1', 'team', '成员公告')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('BROADCAST_FORBIDDEN')
  })

  it('Then recipientsOf 展开:team 广播 = 同 team 岗位(排除受限)+ 上层 orchestrator', () => {
    const mb = makeMailbox()
    const r = mb.broadcast('frontend-lead', 'team', '团队公告')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const recips = mb.recipientsOf(r.item)
    expect(recips).toContain('fe-1')
    expect(recips).not.toContain('shared-1')
    expect(recips).not.toContain('be-1')
    expect(recips).toContain('ceo')
  })

  it('Then recipientsOf 展开:org 广播 = 全部非受限岗位', () => {
    const mb = makeMailbox()
    const r = mb.broadcast('ceo', 'org', '集团公告')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const recips = mb.recipientsOf(r.item)
    expect(recips).toContain('fe-1')
    expect(recips).toContain('be-1')
    expect(recips).not.toContain('shared-1')
  })
})

describe('Given TaskBoard 生命周期(create/claim/done/cancel)', () => {
  const tb = new TaskBoard(makeTree(), { now: () => 1, idFactory: () => `t${++seq}` })

  it('When 创建任务 Then open 且字段完整', () => {
    const r = tb.create({ teamId: 'team-front', title: '实现登录页', assignee: 'fe-1', createdBy: 'frontend-lead' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.item.status).toBe('open')
      expect(r.item.teamId).toBe('team-front')
    }
  })

  it('When 创建参数非法 Then 错误码', () => {
    expect(tb.create({ teamId: 'ghost', title: 'x', assignee: 'fe-1', createdBy: 'ceo' }).ok).toBe(false)
    expect(tb.create({ teamId: 'team-front', title: 'x', assignee: 'ghost', createdBy: 'ceo' }).ok).toBe(false)
    expect(tb.create({ teamId: 'team-front', title: '  ', assignee: 'fe-1', createdBy: 'ceo' }).ok).toBe(false)
  })

  it('When assignee 认领 Then claimed;再次认领 STATE_ILLEGAL', () => {
    const r = tb.create({ teamId: 'team-front', title: '认领测试', assignee: 'fe-1', createdBy: 'frontend-lead' })
    if (!r.ok) throw new Error('create failed')
    const claim = tb.claim(r.item.id, 'fe-1')
    expect(claim.ok).toBe(true)
    if (claim.ok) expect(claim.item.status).toBe('claimed')
    const again = tb.claim(r.item.id, 'fe-1')
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.code).toBe('STATE_ILLEGAL')
  })

  it('When 他人认领 Then PERMISSION_DENIED', () => {
    const r = tb.create({ teamId: 'team-front', title: '权限测试', assignee: 'fe-1', createdBy: 'frontend-lead' })
    if (!r.ok) throw new Error('create failed')
    const claim = tb.claim(r.item.id, 'be-1')
    expect(claim.ok).toBe(false)
    if (!claim.ok) expect(claim.code).toBe('PERMISSION_DENIED')
  })

  it('When team orchestrator 可代操作 Then 允许', () => {
    const r = tb.create({ teamId: 'team-front', title: '组长代操作', assignee: 'fe-1', createdBy: 'frontend-lead' })
    if (!r.ok) throw new Error('create failed')
    expect(tb.claim(r.item.id, 'frontend-lead').ok).toBe(true)
  })

  it('When 完成闭环 Then done;取消已 done 任务 STATE_ILLEGAL', () => {
    const r = tb.create({ teamId: 'team-front', title: '完成测试', assignee: 'fe-1', createdBy: 'frontend-lead' })
    if (!r.ok) throw new Error('create failed')
    expect(tb.claim(r.item.id, 'fe-1').ok).toBe(true)
    const done = tb.done(r.item.id, 'fe-1')
    expect(done.ok).toBe(true)
    if (done.ok) expect(done.item.status).toBe('done')
    const cancel = tb.cancel(r.item.id, 'fe-1')
    expect(cancel.ok).toBe(false)
    if (!cancel.ok) expect(cancel.code).toBe('STATE_ILLEGAL')
  })

  it('When 创建者可取消 Then 允许;取消后不可再认领', () => {
    const r = tb.create({ teamId: 'team-front', title: '取消测试', assignee: 'fe-1', createdBy: 'frontend-lead' })
    if (!r.ok) throw new Error('create failed')
    expect(tb.cancel(r.item.id, 'frontend-lead').ok).toBe(true)
    const claim = tb.claim(r.item.id, 'fe-1')
    expect(claim.ok).toBe(false)
    if (!claim.ok) expect(claim.code).toBe('STATE_ILLEGAL')
  })

  it('When 操作不存在的任务 Then TASK_NOT_FOUND', () => {
    const r = tb.claim('ghost', 'fe-1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('TASK_NOT_FOUND')
  })
})
