/**
 * OrgTree 测试(关键路径 Given-When-Then)
 * 场景:集团级组织树 org=acme → bg-eng → dept-web → team-front / team-backend,
 * 治理岗位 ceo/cto/frontend-lead,执行岗位若干(agent + human 混合)。
 */
import { describe, expect, it } from 'vitest'
import { OrgTree, OrgTreeError } from './OrgTree.ts'
import type { TeamConfig } from '../types.ts'

function makeConfig(overrides?: Partial<TeamConfig>): TeamConfig {
  return {
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
      { id: 'reviewer-1', title: '评审', teamId: 'team-front', occupant: { kind: 'human', im: { channel: 'feishu', userId: 'ou_rev' } } },
    ],
    routes: [],
    acl: {},
    ...overrides,
  }
}

describe('Given 一棵集团级组织树', () => {
  const tree = new OrgTree(makeConfig())

  it('Then 根/深度/父链正确', () => {
    expect(tree.root()).toBe('acme')
    expect(tree.depth('acme')).toBe(0)
    expect(tree.depth('bg-eng')).toBe(1)
    expect(tree.depth('dept-web')).toBe(2)
    expect(tree.depth('team-front')).toBe(3)
    expect(tree.pathToRoot('team-front')).toEqual(['dept-web', 'bg-eng', 'acme'])
  })

  it('Then 子树与管辖判断正确(isAncestor 含自身)', () => {
    expect(tree.subtree('dept-web')).toEqual(['dept-web', 'team-front', 'team-backend'])
    expect(tree.isAncestor('acme', 'team-front')).toBe(true)
    expect(tree.isAncestor('team-front', 'team-backend')).toBe(false)
    expect(tree.isAncestor('team-front', 'team-front')).toBe(true)
  })

  it('Then orchestrator 反向索引正确(治理岗位归属其节点)', () => {
    expect(tree.orchestratorOf('acme')).toBe('ceo')
    expect(tree.hasOrchestrator('team-backend')).toBe(false)
    expect(tree.isOrchestrator('cto')).toBe(true)
    expect(tree.isOrchestrator('fe-1')).toBe(false)
    expect(tree.nodeOfPosition('ceo')).toBe('acme')
    expect(tree.nodeOfPosition('fe-1')).toBe('team-front')
  })

  it('Then 执行岗位归属 team 节点、占位者类型可查', () => {
    expect(tree.nodeOfPosition('reviewer-1')).toBe('team-front')
    expect(tree.occupantKind('reviewer-1')).toBe('human')
    expect(tree.occupantKind('fe-1')).toBe('agent')
  })

  it('Then 受限岗位标记可查', () => {
    const cfg = makeConfig({
      positions: [
        ...makeConfig().positions,
        { id: 'shared-1', title: '公开助手', teamId: 'team-front', restricted: true, occupant: { kind: 'agent', preset: 'orgos-shared' } },
      ],
    })
    const t = new OrgTree(cfg)
    expect(t.isRestricted('shared-1')).toBe(true)
    expect(t.isRestricted('fe-1')).toBe(false)
  })
})

describe('Given 非法组织配置', () => {
  it('When children 引用不存在的节点 Then 构造抛错', () => {
    const cfg = makeConfig()
    cfg.nodes[1] = { id: 'bg-eng', kind: 'bg', children: ['ghost'] }
    expect(() => new OrgTree(cfg)).toThrow(OrgTreeError)
  })

  it('When 节点有多个父 Then 构造抛错(不是树)', () => {
    const cfg = makeConfig()
    cfg.nodes[0] = { id: 'acme', kind: 'org', children: ['bg-eng', 'team-front'] }
    expect(() => new OrgTree(cfg)).toThrow(/多个父节点/)
  })

  it('When 根存在父链 Then 构造抛错(成环)', () => {
    const cfg = makeConfig()
    cfg.nodes[0] = { id: 'acme', kind: 'org', children: ['bg-eng'] }
    cfg.nodes[1] = { id: 'bg-eng', kind: 'bg', children: ['acme'] }
    expect(() => new OrgTree(cfg)).toThrow(/成环|多个父节点/)
  })

  it('When orchestratorPosition 引用不存在的岗位 Then 构造抛错', () => {
    const cfg = makeConfig()
    cfg.nodes[0] = { id: 'acme', kind: 'org', orchestratorPosition: 'nobody', children: ['bg-eng'] }
    expect(() => new OrgTree(cfg)).toThrow(/orchestratorPosition/)
  })

  it('When 岗位 teamId 引用不存在节点 Then 构造抛错', () => {
    const cfg = makeConfig()
    cfg.positions[3] = { id: 'fe-1', title: 'x', teamId: 'ghost-team', occupant: { kind: 'agent', preset: 'p' } }
    expect(() => new OrgTree(cfg)).toThrow(/teamId/)
  })

  it('When 同一岗位同时是执行岗位与治理岗位 Then 构造抛错', () => {
    const cfg = makeConfig()
    cfg.positions[2] = { id: 'frontend-lead', title: 'x', teamId: 'team-front', occupant: { kind: 'human', im: { channel: 'feishu', userId: 'ou_lead' } } }
    expect(() => new OrgTree(cfg)).toThrow(/同时是执行岗位与治理岗位/)
  })

  it('When 查询未知节点/岗位 Then 抛错', () => {
    const tree = new OrgTree(makeConfig())
    expect(() => tree.node('ghost')).toThrow(OrgTreeError)
    expect(() => tree.position('ghost')).toThrow(OrgTreeError)
    expect(() => tree.nodeOfPosition('ghost')).toThrow(OrgTreeError)
    expect(() => tree.depth('ghost')).toThrow(/不在树内/)
  })
})
