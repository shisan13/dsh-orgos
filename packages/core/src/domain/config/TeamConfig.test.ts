/**
 * TeamConfig 解析校验测试(FR-X5:结构/连通/ACL/引用完整性,友好可修复)
 */
import { describe, expect, it } from 'vitest'
import { parseTeamConfig, validateTeamConfig } from './TeamConfig.ts'
import { OrgTree } from '../org/OrgTree.ts'

const VALID_YAML = `
org: acme
nodes:
  - id: acme
    kind: org
    orchestratorPosition: ceo
    children: [bg-eng]
  - id: bg-eng
    kind: bg
    orchestratorPosition: cto
    children: [dept-web]
  - id: dept-web
    kind: dept
    children: [team-front, team-backend]
  - id: team-front
    kind: team
    orchestratorPosition: frontend-lead
  - id: team-backend
    kind: team
routes:
  - channel: feishu
    peerId: oc_group_code
    target: team-front
acl:
  allowCrossTeam:
    - from: team-front
      to: team-backend
      scopes: [note, result]
  block:
    - to: shared
  delegationDepthMax: 3
  memberConcurrencyMax: 2
positions:
  - id: ceo
    title: 集团总裁
    occupant: { kind: agent, preset: orgos-orchestrator-ceo }
  - id: cto
    title: CTO
    occupant: { kind: agent, preset: orgos-orchestrator-bg }
  - id: frontend-lead
    title: 前端组长
    occupant: { kind: human, im: { channel: feishu, userId: ou_lead } }
  - id: fe-1
    title: 前端工程师
    teamId: team-front
    capabilityProfile: [frontend, react]
    occupant: { kind: agent, preset: orgos-coder }
  - id: reviewer-1
    title: 评审
    teamId: team-front
    occupant: { kind: human, im: { channel: feishu, userId: ou_rev } }
  - id: be-1
    title: 后端工程师
    teamId: team-backend
    occupant: { kind: agent, preset: orgos-coder }
  - id: shared
    title: 公开助手
    teamId: team-front
    restricted: true
    occupant: { kind: agent, preset: orgos-shared }
`

describe('Given 一份合法的 team.yml', () => {
  const result = parseTeamConfig(VALID_YAML)

  it('Then 解析成功且无 issue', () => {
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.org).toBe('acme')
    expect(result.config.nodes).toHaveLength(5)
    expect(result.config.positions).toHaveLength(7)
    expect(result.config.routes).toHaveLength(1)
    expect(result.config.acl.delegationDepthMax).toBe(3)
  })

  it('Then 可构造 OrgTree 且 human 占位保留', () => {
    if (!result.ok) return
    const tree = new OrgTree(result.config)
    expect(tree.occupantKind('reviewer-1')).toBe('human')
    expect(tree.isRestricted('shared')).toBe(true)
    expect(tree.nodeOfPosition('fe-1')).toBe('team-front')
  })
})

describe('Given 语法/结构错误的 team.yml', () => {
  it('When YAML 语法错误 Then 返回单条语法 issue 且带 fix', () => {
    const r = parseTeamConfig('org: acme\n  nodes: [')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues[0]?.message).toMatch(/YAML 语法错误/)
    expect(r.issues[0]?.fix).toBeTruthy()
  })

  it('When 顶层不是对象 Then 返回结构 issue', () => {
    const r = parseTeamConfig('- a\n- b')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues[0]?.message).toMatch(/顶层必须是对象/)
  })

  it('When 缺 org Then 报错并给出 fix', () => {
    const r = parseTeamConfig('nodes: []\npositions: []\nroutes: []\nacl: {}')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues.some((i) => i.path === 'org')).toBe(true)
  })

  it('When 节点 kind 非法 Then 报错', () => {
    const r = parseTeamConfig('org: acme\nnodes:\n  - id: acme\n    kind: galaxy\n    children: []')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues.some((i) => i.message.includes('kind'))).toBe(true)
  })
})

describe('Given 引用完整性被破坏的 team.yml', () => {
  it('When orchestratorPosition 悬空 Then 报错可修复', () => {
    const r = parseTeamConfig(`org: acme
nodes:
  - { id: acme, kind: org, orchestratorPosition: ghost, children: [] }
positions: []
routes: []
acl: {}
`)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues.some((i) => i.message.includes('orchestratorPosition'))).toBe(true)
    expect(r.issues[0]?.fix).toBeTruthy()
  })

  it('When 树成环 Then 报错(不静默通过)', () => {
    const r = parseTeamConfig(`org: acme
nodes:
  - { id: acme, kind: org, children: [bg] }
  - { id: bg, kind: bg, children: [acme] }
positions: []
routes: []
acl: {}
`)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues.some((i) => i.message.includes('父节点') || i.message.includes('孤儿'))).toBe(true)
  })

  it('When 岗位 teamId 悬空 Then 报错', () => {
    const r = parseTeamConfig(`org: acme
nodes:
  - { id: acme, kind: org, children: [] }
positions:
  - { id: p1, title: x, teamId: ghost-team, occupant: { kind: agent, preset: p } }
routes: []
acl: {}
`)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues.some((i) => i.message.includes('teamId'))).toBe(true)
  })

  it('When routes.target 悬空 Then 报错', () => {
    const r = parseTeamConfig(`org: acme
nodes:
  - { id: acme, kind: org, children: [] }
positions: []
routes:
  - { channel: feishu, peerId: oc_x, target: nobody }
acl: {}
`)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues.some((i) => i.path.startsWith('routes[') && i.message.includes('不存在'))).toBe(true)
  })

  it('When 岗位 id 重复 Then 报错', () => {
    const r = parseTeamConfig(`org: acme
nodes:
  - { id: acme, kind: org, children: [] }
positions:
  - { id: p1, title: x, occupant: { kind: agent, preset: p } }
  - { id: p1, title: y, occupant: { kind: agent, preset: p } }
routes: []
acl: {}
`)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues.some((i) => i.message.includes('重复'))).toBe(true)
  })
})

describe('Given ACL 配置问题', () => {
  it('When allowCrossTeam.from 引用不存在的 team Then 报错', () => {
    const r = parseTeamConfig(`org: acme
nodes:
  - { id: acme, kind: org, children: [] }
positions: []
routes: []
acl:
  allowCrossTeam:
    - { from: ghost-team, to: acme, scopes: [note] }
`)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues.some((i) => i.message.includes('不存在的 team'))).toBe(true)
  })

  it('When scopes 非法取值 Then 报错并列出合法取值', () => {
    const r = parseTeamConfig(`org: acme
nodes:
  - { id: acme, kind: org, children: [] }
positions: []
routes: []
acl:
  allowCrossTeam:
    - { from: acme, to: acme, scopes: [hack] }
`)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues.some((i) => i.message.includes('非法协作类型'))).toBe(true)
  })

  it('When delegationDepthMax 非法 Then 报错', () => {
    const r = parseTeamConfig(`org: acme
nodes:
  - { id: acme, kind: org, children: [] }
positions: []
routes: []
acl:
  delegationDepthMax: 0
`)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues.some((i) => i.message.includes('delegationDepthMax'))).toBe(true)
  })
})

describe('Given roles 覆盖', () => {
  it('When roles 合法 Then 解析进 config', () => {
    const r = parseTeamConfig(`org: acme
nodes:
  - { id: acme, kind: org, children: [] }
positions: []
routes: []
acl: {}
roles:
  orgos-coder:
    visibility: self
    authority: self
    memory: [private, team]
    subscription: [self]
`)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config.roles?.orgosCoder).toBeUndefined()
    expect(r.config.roles?.['orgos-coder']?.visibility).toBe('self')
  })

  it('When roles 取值非法 Then 报错', () => {
    const r = parseTeamConfig(`org: acme
nodes:
  - { id: acme, kind: org, children: [] }
positions: []
routes: []
acl: {}
roles:
  orgos-coder:
    visibility: galaxy
`)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues.some((i) => i.message.includes('visibility'))).toBe(true)
  })
})

describe('Given 已解析配置二次把关(validateTeamConfig)', () => {
  it('Then 合法配置返回空 issue 列表', () => {
    const r = parseTeamConfig(VALID_YAML)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(validateTeamConfig(r.config)).toEqual([])
  })

  it('Then 坏配置返回问题(不改写配置对象)', () => {
    const r = parseTeamConfig(VALID_YAML)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const bad = { ...r.config, acl: { ...r.config.acl, delegationDepthMax: -1 } }
    const issues = validateTeamConfig(bad)
    expect(issues.some((i) => i.message.includes('delegationDepthMax'))).toBe(true)
  })
})
