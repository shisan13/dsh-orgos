/**
 * snapshotTree(组织树聚合,P1 团队室树视图)测试:Given-When-Then
 * 覆盖:树形状与 parentId、岗位挂节点、状态聚合闭包和、委派/任务数聚合、治理岗位归属。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TeamService } from './teamService.js'
import type { DshAgents, AgentPresetsMount, LiveAgent } from './memberRuntime.js'

const TEST_TEAM_YML = `org: acme
nodes:
  - id: acme
    kind: org
    orchestratorPosition: lead
    children: [team-main, team-tg]
  - id: team-main
    kind: team
  - id: team-tg
    kind: team
    orchestratorPosition: tg-lead
positions:
  - id: lead
    occupant: { kind: agent, preset: orgos-orchestrator }
  - id: coder-1
    teamId: team-main
    occupant: { kind: agent, preset: orgos-coder }
  - id: assistant-1
    teamId: team-main
    restricted: true
    occupant: { kind: agent, preset: orgos-assistant }
  - id: tg-lead
    occupant: { kind: agent, preset: orgos-orchestrator }
  - id: tg-assistant-1
    teamId: team-tg
    occupant: { kind: agent, preset: orgos-assistant }
routes:
  - { channel: feishu-main, peerId: oc_1, target: lead }
  - { channel: feishu-coder, peerId: oc_2, target: coder-1 }
  - { channel: feishu-personal, peerId: oc_3, target: assistant-1 }
  - { channel: telegram-main, peerId: g1, target: tg-lead }
  - { channel: telegram-personal, peerId: g1, target: tg-assistant-1 }
acl:
  delegationDepthMax: 3
`

class FakeAgent implements LiveAgent {
  id: string
  status: 'idle' | 'running' = 'idle'
  session = { id: '' }
  constructor(id: string) {
    this.id = id
    this.session = { id }
  }
  followup(): void {}
  inject(): void {}
  send(): void {}
  async dispose(): Promise<void> {}
}

describe('snapshotTree(组织树聚合)', () => {
  let dir: string
  let service: TeamService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orgos-tree-'))
    const agents: DshAgents = {
      async create(o: unknown) {
        const opts = o as { sessionId: string }
        return { agent: new FakeAgent(opts.sessionId), dispose: async () => {} }
      },
      async resume() {
        throw new Error('SESSION not found')
      },
      get: () => undefined,
      list: () => [],
    }
    const presets: AgentPresetsMount = { async mount() { return {} } }
    service = new TeamService({ stateRoot: dir, ownerIds: ['ou_owner'], agents, presets })
    expect(service.setupInit(TEST_TEAM_YML).ok).toBe(true)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('GIVEN 团队已加载 WHEN snapshotTree THEN nodes 层级与 parentId 正确且治理岗位挂其节点', () => {
    const tree = service.snapshotTree()
    expect(tree).toBeDefined()
    const byId = new Map(tree?.nodes.map((n) => [n.id, n]))
    expect(byId.get('acme')?.parentId).toBeNull()
    expect(byId.get('team-main')?.parentId).toBe('acme')
    expect(byId.get('team-tg')?.parentId).toBe('acme')
    expect(byId.get('acme')?.orchestratorPosition).toBe('lead')
    expect(byId.get('team-tg')?.orchestratorPosition).toBe('tg-lead')
    // 执行岗位挂 team;team 治理岗位挂其治理的 team(展示更直观);org 治理岗位挂 org 根
    expect(tree?.positionsByNode['team-main']?.map((p) => p.id).sort()).toEqual(['assistant-1', 'coder-1'])
    expect(tree?.positionsByNode['team-tg']?.map((p) => p.id).sort()).toEqual(['tg-assistant-1', 'tg-lead'])
    expect(tree?.positionsByNode['acme']?.map((p) => p.id)).toEqual(['lead'])
  })

  it('GIVEN 状态与委派 WHEN 聚合 THEN 闭包和正确(org 根 = 全量)', () => {
    service.setMemberStatus('coder-1', 'busy')
    service.setMemberStatus('assistant-1', 'idle')
    service.setMemberStatus('tg-lead', 'failed')
    service.delegate('lead', 'coder-1', { task: '写模块', requirements: ['r'], acceptance: ['a'] })
    const tree = service.snapshotTree()
    const main = tree?.aggregates['team-main']
    expect(main).toMatchObject({ positionCount: 2, busy: 1, idle: 1, offline: 0, failed: 0, openDelegations: 1, openTasks: 0 })
    const tg = tree?.aggregates['team-tg']
    expect(tg).toMatchObject({ positionCount: 2, failed: 1, offline: 1 })
    const root = tree?.aggregates['acme']
    expect(root).toMatchObject({ positionCount: 5, busy: 1, idle: 1, offline: 2, failed: 1, openDelegations: 1 })
  })

  it('GIVEN 岗位行 WHEN 状态与委派/任务 THEN 行内附计数且 restricted 透传', () => {
    service.setMemberStatus('coder-1', 'busy')
    service.delegate('lead', 'coder-1', { task: 't', requirements: ['r'], acceptance: ['a'] })
    service.taskCreate('team-main', '写接口', 'coder-1', 'lead')
    const tree = service.snapshotTree()
    const coder = tree?.positionsByNode['team-main']?.find((p) => p.id === 'coder-1')
    expect(coder?.status).toBe('busy')
    expect(coder?.preset).toBe('orgos-coder')
    expect((coder as { openDelegations?: number }).openDelegations).toBe(1)
    expect((coder as { openTasks?: number }).openTasks).toBe(1)
    const assistant = tree?.positionsByNode['team-main']?.find((p) => p.id === 'assistant-1')
    expect((assistant as { restricted?: boolean }).restricted).toBe(true)
    // 聚合同步任务数
    expect(tree?.aggregates['team-main']?.openTasks).toBe(1)
  })

  it('GIVEN 未加载团队 WHEN snapshotTree THEN undefined(UI 降级扁平列表)', () => {
    const bare = new TeamService({
      stateRoot: mkdtempSync(join(tmpdir(), 'orgos-tree-bare-')),
      ownerIds: [],
      agents: { create: async () => ({ agent: new FakeAgent('x'), dispose: async () => {} }), resume: async () => { throw new Error('no') }, get: () => undefined, list: () => [] },
      presets: { mount: async () => ({}) },
    })
    expect(bare.snapshotTree()).toBeUndefined()
  })

  it('GIVEN team 成员 viewer WHEN snapshotTree(viewer) THEN 裁剪到其所属 team 子树', () => {
    const tree = service.snapshotTree('coder-1')
    const ids = tree?.nodes.map((n) => n.id).sort()
    expect(ids).toEqual(['team-main'])
    expect(tree?.positionsByNode['team-main']?.map((p) => p.id).sort()).toEqual(['assistant-1', 'coder-1'])
    expect(tree?.positionsByNode['team-tg']).toBeUndefined()
    expect(tree?.aggregates['team-main']?.positionCount).toBe(2)
    expect(tree?.aggregates['acme']).toBeUndefined()
  })

  it('GIVEN org 根治理岗 viewer WHEN snapshotTree(viewer) THEN 全树可见', () => {
    const tree = service.snapshotTree('lead')
    expect(tree?.nodes.map((n) => n.id).sort()).toEqual(['acme', 'team-main', 'team-tg'])
  })

  it('GIVEN 未识别 viewer(web-root)WHEN snapshotTree THEN 回退根视角全树', () => {
    const tree = service.snapshotTree('web-root')
    expect(tree?.nodes).toHaveLength(3)
  })
})
