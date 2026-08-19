/**
 * RouterResolver 测试(技术设计 §6 全路径;安全设计 T1/T2)
 * 场景:acme → bg-eng → dept-web → team-front / team-backend;治理岗位 ceo/cto/frontend-lead。
 */
import { describe, expect, it } from 'vitest'
import { RouterResolver } from './RouterResolver.ts'
import { OrgTree } from '../org/OrgTree.ts'
import type { RouteRule, TeamConfig } from '../types.ts'

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
      { id: 'ceo', title: '集团总裁', occupant: { kind: 'agent', preset: 'orgos-orchestrator-ceo' } },
      { id: 'cto', title: 'CTO', occupant: { kind: 'agent', preset: 'orgos-orchestrator-bg' } },
      { id: 'frontend-lead', title: '前端组长', occupant: { kind: 'human', im: { channel: 'feishu', userId: 'ou_lead' } } },
      { id: 'fe-1', title: '前端工程师', teamId: 'team-front', occupant: { kind: 'agent', preset: 'orgos-coder' } },
      { id: 'be-1', title: '后端工程师', teamId: 'team-backend', occupant: { kind: 'agent', preset: 'orgos-coder' } },
      { id: 'shared-1', title: '公开助手', teamId: 'team-front', restricted: true, occupant: { kind: 'agent', preset: 'orgos-shared' } },
    ],
    routes: [],
    acl: {},
  }
  return new OrgTree(cfg)
}

function resolver(extra?: Partial<ConstructorParameters<typeof RouterResolver>[2]>): RouterResolver {
  const routes: RouteRule[] = [
    { channel: 'feishu', peerId: 'oc_group_code', target: 'team-front' },
    { channel: 'feishu', peerId: 'oc_group_backend', target: 'be-1' },
    { channel: 'feishu', peerId: 'oc_shared_room', target: 'shared-1' },
    { channel: 'feishu', peerId: 'oc_dm_lead', target: 'frontend-lead' },
  ]
  return new RouterResolver(makeTree(), routes, {
    ownerIds: ['ou_owner'],
    allowlist: ['ou_alice'],
    ...extra,
  })
}

describe('Given 路由表精确匹配(§6-1)', () => {
  it('When (channel, peer) 命中执行岗位 Then 路由到岗位', () => {
    const r = resolver().resolve({ channel: 'feishu', peer: { kind: 'group', id: 'oc_group_backend' }, sender: { id: 'ou_owner' }, kind: 'mention' })
    expect(r).toEqual({ action: 'route', target: { kind: 'position', id: 'be-1' }, })
  })

  it('When 命中治理节点(team 群) Then 路由到该层 orchestrator 岗位', () => {
    const r = resolver().resolve({ channel: 'feishu', peer: { kind: 'group', id: 'oc_group_code' }, sender: { id: 'ou_owner' }, kind: 'mention' })
    expect(r).toEqual({ action: 'route', target: { kind: 'position', id: 'frontend-lead' }, })
  })

  it('When 命中受限岗位 Then 路由并标记 restricted', () => {
    const r = resolver().resolve({ channel: 'feishu', peer: { kind: 'group', id: 'oc_shared_room' }, sender: { id: 'ou_owner' }, kind: 'mention' })
    expect(r.action).toBe('route')
    expect(r.restricted).toBe(true)
  })

  it('When 命中直接绑定岗位的 DM Then 路由(每 peer 独立会话)', () => {
    const r = resolver().resolve({ channel: 'feishu', peer: { kind: 'direct', id: 'oc_dm_lead' }, sender: { id: 'ou_alice' }, kind: 'text' })
    expect(r.target?.id).toBe('frontend-lead')
  })
})

describe('Given 未绑定群(§6-2a:main 兜底)', () => {
  it('When 群内 @ 提及 Then 回退到 org 根 orchestrator', () => {
    const r = resolver().resolve({ channel: 'feishu', peer: { kind: 'group', id: 'oc_unknown_group' }, sender: { id: 'ou_owner' }, kind: 'mention' })
    expect(r).toEqual({ action: 'route', target: { kind: 'position', id: 'ceo' }, })
  })

  it('When 群内非 @ 提及 Then 静默(requireMention)', () => {
    const r = resolver().resolve({ channel: 'feishu', peer: { kind: 'group', id: 'oc_unknown_group' }, sender: { id: 'ou_owner' }, kind: 'text' })
    expect(r.action).toBe('silent')
    expect(r.reason).toBe('group-require-mention')
  })

  it('When requireMentionInGroup=false Then 群内普通文本也路由', () => {
    const r = resolver({ requireMentionInGroup: false }).resolve({ channel: 'feishu', peer: { kind: 'group', id: 'oc_unknown_group' }, sender: { id: 'ou_owner' }, kind: 'text' })
    expect(r.action).toBe('route')
  })

  it('When defaultEntryNodeId 指向无 orchestrator 的中间节点 Then 沿父链上抛到最近 orchestrator', () => {
    const cfg: TeamConfig = {
      org: 'acme',
      nodes: [
        { id: 'acme', kind: 'org', orchestratorPosition: 'ceo', children: ['bg-eng'] },
        { id: 'bg-eng', kind: 'bg', children: ['team-x'] },
        { id: 'team-x', kind: 'team', orchestratorPosition: 'lead-x', children: [] },
      ],
      positions: [
        { id: 'ceo', title: '总裁', occupant: { kind: 'agent', preset: 'p' } },
        { id: 'lead-x', title: '组长', occupant: { kind: 'agent', preset: 'p' } },
        { id: 'm-1', title: '成员', teamId: 'team-x', occupant: { kind: 'agent', preset: 'p' } },
      ],
      routes: [],
      acl: {},
    }
    const r = new RouterResolver(new OrgTree(cfg), [], { ownerIds: ['u1'], defaultEntryNodeId: 'bg-eng' }).resolve({
      channel: 'feishu', peer: { kind: 'group', id: 'g1' }, sender: { id: 'u1' }, kind: 'mention',
    })
    // bg-eng 无 orchestrator → 上抛父 acme → ceo
    expect(r).toEqual({ action: 'route', target: { kind: 'position', id: 'ceo' }, })
  })
})

describe('Given 未绑定 DM 与白名单(§6-2b/2c;T1)', () => {
  it('When owner 私聊 Then 路由到默认入口(org orchestrator)', () => {
    const r = resolver().resolve({ channel: 'feishu', peer: { kind: 'direct', id: 'dm_1' }, sender: { id: 'ou_owner' }, kind: 'text' })
    expect(r.target?.id).toBe('ceo')
  })

  it('When allowlist 用户私聊 Then 路由', () => {
    const r = resolver().resolve({ channel: 'feishu', peer: { kind: 'direct', id: 'dm_2' }, sender: { id: 'ou_alice' }, kind: 'text' })
    expect(r.target?.id).toBe('ceo')
  })

  it('When 白名单外用户私聊 Then 拒绝并给出原因(不泄露团队结构)', () => {
    const r = resolver().resolve({ channel: 'feishu', peer: { kind: 'direct', id: 'dm_3' }, sender: { id: 'ou_stranger' }, kind: 'text' })
    expect(r.action).toBe('reject')
    expect(r.reason).toBe('not-whitelisted')
  })

  it('When 群消息来自白名单外用户且群已绑定 Then 仍路由(群级绑定以 peer 为准)', () => {
    const r = resolver().resolve({ channel: 'feishu', peer: { kind: 'group', id: 'oc_group_code' }, sender: { id: 'ou_stranger' }, kind: 'mention' })
    expect(r.action).toBe('route')
  })
})

describe('Given 治理链上抛(§6-4)', () => {
  it('When 命中无 orchestrator 的节点 Then 上抛父节点', () => {
    const cfg: TeamConfig = {
      org: 'acme',
      nodes: [
        { id: 'acme', kind: 'org', orchestratorPosition: 'ceo', children: ['bg-eng'] },
        { id: 'bg-eng', kind: 'bg', children: ['dept-web'] },
        { id: 'dept-web', kind: 'dept', children: [] },
      ],
      positions: [{ id: 'ceo', title: '总裁', occupant: { kind: 'agent', preset: 'p' } }],
      routes: [{ channel: 'feishu', peerId: 'oc_dept', target: 'dept-web' }],
      acl: {},
    }
    const r = new RouterResolver(new OrgTree(cfg), cfg.routes, { ownerIds: ['u1'] }).resolve({
      channel: 'feishu', peer: { kind: 'group', id: 'oc_dept' }, sender: { id: 'u1' }, kind: 'mention',
    })
    expect(r).toEqual({ action: 'route', target: { kind: 'position', id: 'ceo' }, })
  })

  it('When 全链无 orchestrator Then 拒绝 no-orchestrator-on-chain', () => {
    const cfg: TeamConfig = {
      org: 'acme',
      nodes: [
        { id: 'acme', kind: 'org', children: ['bg-eng'] },
        { id: 'bg-eng', kind: 'bg', children: [] },
      ],
      positions: [],
      routes: [{ channel: 'feishu', peerId: 'oc_bg', target: 'bg-eng' }],
      acl: {},
    }
    const r = new RouterResolver(new OrgTree(cfg), cfg.routes, { ownerIds: ['u1'] }).resolve({
      channel: 'feishu', peer: { kind: 'group', id: 'oc_bg' }, sender: { id: 'u1' }, kind: 'mention',
    })
    expect(r.action).toBe('reject')
    expect(r.reason).toBe('no-orchestrator-on-chain')
  })
})

describe('Given 路由表运行期维护', () => {
  it('When upsertRoute 目标不存在 Then 抛错', () => {
    expect(() => resolver().upsertRoute({ channel: 'feishu', peerId: 'x', target: 'ghost' })).toThrow(/不存在/)
  })

  it('When upsertRoute/removeRoute Then 路由生效/失效', () => {
    const r = resolver()
    r.upsertRoute({ channel: 'feishu', peerId: 'oc_new', target: 'fe-1' })
    expect(r.resolve({ channel: 'feishu', peer: { kind: 'group', id: 'oc_new' }, sender: { id: 'u' }, kind: 'mention' }).target?.id).toBe('fe-1')
    expect(r.removeRoute('feishu', 'oc_new')).toBe(true)
    expect(r.resolve({ channel: 'feishu', peer: { kind: 'group', id: 'oc_new' }, sender: { id: 'ou_owner' }, kind: 'mention' }).target?.id).toBe('ceo')
  })

  it('Then routeList 返回当前全部规则', () => {
    expect(resolver().routeList()).toHaveLength(4)
  })

  it('When defaultEntryNodeId 不存在 Then 抛错', () => {
    expect(() => resolver({ defaultEntryNodeId: 'ghost' }).resolve({ channel: 'feishu', peer: { kind: 'group', id: 'g' }, sender: { id: 'u' }, kind: 'mention' })).toThrow(/defaultEntryNodeId/)
  })
})
