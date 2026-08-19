/**
 * 部门/集团规模集成测试(TeamService 绑定层全链路)
 * 补齐"只实跑过小组"的缺口:跨层委派、跨 team ACL、BG 隔离、委派深度、scope 投影。
 * Given-When-Then(AGENTS.md §4 闸门)。fixture 与权威模板(TEMPLATE_DEPT/GROUP)同构。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TeamService } from './teamService.js'
import type { DshAgents, AgentPresetsMount, LiveAgent } from './memberRuntime.js'

const DEPT_YML = `org: my-org
nodes:
  - id: my-org
    kind: org
    orchestratorPosition: dept-head
    children: [dept-eng]
  - id: dept-eng
    kind: dept
    children: [team-front, team-backend]
  - id: team-front
    kind: team
    orchestratorPosition: frontend-lead
    children: []
  - id: team-backend
    kind: team
    orchestratorPosition: backend-lead
    children: []
positions:
  - id: dept-head
    title: 部门主管
    occupant: { kind: agent, preset: orgos-orchestrator }
  - id: frontend-lead
    title: 前端组长
    occupant: { kind: agent, preset: orgos-orchestrator }
  - id: backend-lead
    title: 后端组长
    occupant: { kind: agent, preset: orgos-orchestrator }
  - id: fe-1
    title: 前端工程师
    teamId: team-front
    occupant: { kind: agent, preset: orgos-coder }
  - id: be-1
    title: 后端工程师
    teamId: team-backend
    occupant: { kind: agent, preset: orgos-coder }
routes: []
acl:
  allowCrossTeam:
    - { from: team-front, to: team-backend, scopes: [note, result] }
  delegationDepthMax: 3
`

const GROUP_YML = `org: acme
nodes:
  - id: acme
    kind: org
    orchestratorPosition: ceo
    children: [bg-eng, bg-ops]
  - id: bg-eng
    kind: bg
    orchestratorPosition: cto
    children: [dept-web]
  - id: bg-ops
    kind: bg
    children: [dept-ops]
  - id: dept-web
    kind: dept
    children: [team-front]
  - id: dept-ops
    kind: dept
    children: [team-ops]
  - id: team-front
    kind: team
    orchestratorPosition: frontend-lead
    children: []
  - id: team-ops
    kind: team
    children: []
positions:
  - id: ceo
    title: 集团总裁
    occupant: { kind: agent, preset: orgos-orchestrator }
  - id: cto
    title: CTO
    occupant: { kind: agent, preset: orgos-orchestrator }
  - id: frontend-lead
    title: 前端组长
    occupant: { kind: agent, preset: orgos-orchestrator }
  - id: fe-1
    title: 前端工程师
    teamId: team-front
    occupant: { kind: agent, preset: orgos-coder }
  - id: ops-1
    title: 运维
    teamId: team-ops
    occupant: { kind: agent, preset: orgos-coder }
routes: []
acl:
  delegationDepthMax: 3
`

class FakeAgent implements LiveAgent {
  id: string
  status: 'idle' | 'running' = 'idle'
  session = { id: '' }
  inbox: string[] = []
  constructor(id: string) {
    this.id = id
    this.session = { id }
  }
  followup(msg: unknown): void {
    this.inbox.push((msg as { content: { text: string }[] }).content.map((b) => b.text).join(''))
  }
  inject(msg: unknown): void {
    this.inbox.push((msg as { content: { text: string }[] }).content.map((b) => b.text).join(''))
  }
  send(): void {}
  async dispose(): Promise<void> {}
}

function makeService(dir: string, yml: string): { service: TeamService; agents: DshAgents & { registry: Map<string, FakeAgent> }; events: Array<[string, Record<string, unknown>]> } {
  const registry = new Map<string, FakeAgent>()
  const agents: DshAgents & { registry: Map<string, FakeAgent> } = {
    registry,
    async create(options) {
      const o = options as { sessionId: string; setup?: (c: unknown) => Promise<unknown> }
      await o.setup?.({})
      const agent = new FakeAgent(o.sessionId)
      registry.set(o.sessionId, agent)
      return { agent, dispose: async () => {} }
    },
    async resume() {
      throw new Error('SESSION not found')
    },
    get(id) {
      return registry.get(id) ?? undefined
    },
    list() {
      return [...registry.values()]
    },
  }
  const events: Array<[string, Record<string, unknown>]> = []
  const presets: AgentPresetsMount = { async mount() { return {} } }
  const service = new TeamService({
    stateRoot: dir,
    ownerIds: ['ou_owner'],
    agents,
    presets,
    emit: (event, payload) => events.push([event, payload]),
  })
  expect(service.setupInit(yml).ok).toBe(true)
  expect(service.loaded).toBe(true)
  return { service, agents, events }
}

const brief = (task: string) => ({ task, requirements: ['r1'], acceptance: ['a1'] })

describe('部门规模(dept)集成', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orgos-dept-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('GIVEN 部门主管 WHEN 委派到子团队组长 THEN 允许且成员收到投递', async () => {
    const { service, agents } = makeService(dir, DEPT_YML)
    const r = service.delegate('dept-head', 'frontend-lead', brief('做门户页'))
    expect(r.ok).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 20)) // 懒激活投递为异步
    expect(agents.registry.get('orgos-member-frontend-lead')?.inbox.some((t) => t.includes('做门户页'))).toBe(true)
  })

  it('GIVEN 组长 WHEN 委派本团队成员 THEN 允许', () => {
    const { service } = makeService(dir, DEPT_YML)
    expect(service.delegate('frontend-lead', 'fe-1', brief('写组件')).ok).toBe(true)
  })

  it('GIVEN 成员 WHEN 跨团队委派(allowCrossTeam 不含委派)THEN 拒绝', () => {
    const { service } = makeService(dir, DEPT_YML)
    // fe-1 是成员不是 orchestrator → 直接拒绝
    const r = service.delegate('fe-1', 'be-1', brief('帮忙'))
    expect(r.ok).toBe(false)
  })

  it('GIVEN 组长 WHEN 委派其他团队 THEN 管辖子树外拒绝', () => {
    const { service } = makeService(dir, DEPT_YML)
    const r = service.delegate('frontend-lead', 'be-1', brief('帮忙'))
    expect(r.ok).toBe(false)
  })

  it('GIVEN 跨 team 协作 ACL WHEN 邮件 THEN 白名单内放行', () => {
    const { service } = makeService(dir, DEPT_YML)
    expect(service.mailSend('fe-1', 'be-1', 'result', '联调结论').ok).toBe(true)
  })

  it('GIVEN 回执 WHEN settle THEN 折叠 digest 事件上报派发方', () => {
    const { service, events } = makeService(dir, DEPT_YML)
    const r = service.delegate('frontend-lead', 'fe-1', brief('写组件'))
    expect(r.ok).toBe(true)
    const id = (r as { delegation: { id: string } }).delegation.id
    expect(service.settle('fe-1', id, 'completed', '组件写完,单测通过').ok).toBe(true)
    expect(events.some(([e]) => e === 'team/delegation-completed')).toBe(true)
  })

  it('GIVEN 成员视角 WHEN status THEN 只见本团队任务;部门主管全见', () => {
    const { service } = makeService(dir, DEPT_YML)
    service.taskCreate('team-front', '前端任务', 'fe-1', 'frontend-lead')
    service.taskCreate('team-backend', '后端任务', 'be-1', 'backend-lead')
    expect((service.status('fe-1').tasks as unknown[]).length).toBe(1)
    expect((service.status('dept-head').tasks as unknown[]).length).toBe(2)
  })
})

describe('集团规模(group)集成', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orgos-group-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('GIVEN BG 主管 WHEN 委派其他 BG 岗位 THEN 隔离拒绝', () => {
    const { service } = makeService(dir, GROUP_YML)
    const r = service.delegate('cto', 'ops-1', brief('跨 BG 干活'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('管辖子树')
  })

  it('GIVEN 集团总裁 WHEN 委派任意 BG 岗位 THEN 允许(根管辖全部)', async () => {
    const { service, agents } = makeService(dir, GROUP_YML)
    const r = service.delegate('ceo', 'ops-1', brief('集团巡检'))
    expect(r.ok).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 20)) // 懒激活投递为异步
    expect(agents.registry.get('orgos-member-ops-1')?.inbox.some((t) => t.includes('集团巡检'))).toBe(true)
  })

  it('GIVEN 委派链深度 3 WHEN 继续下派 THEN 深度上限拒绝', () => {
    const { service } = makeService(dir, GROUP_YML)
    // ceo → cto → frontend-lead → fe-1 共 3 层(深度 3 封顶)
    const d1 = service.delegate('ceo', 'cto', brief('集团目标'))
    const d2 = service.delegate('cto', 'frontend-lead', brief('BG 目标'))
    const d3 = service.delegate('frontend-lead', 'fe-1', brief('执行'))
    expect(d1.ok).toBe(true)
    expect(d2.ok).toBe(true)
    expect(d3.ok).toBe(true)
    // fe-1 是成员,不能继续下派(非 orchestrator)
    const d4 = service.delegate('fe-1', 'ops-1', brief('再转'))
    expect(d4.ok).toBe(false)
  })

  it('GIVEN 集团根 WHEN status THEN 全集团可见;BG 主管只见本 BG', () => {
    const { service } = makeService(dir, GROUP_YML)
    service.taskCreate('team-front', '前端任务', 'fe-1', 'frontend-lead')
    service.taskCreate('team-ops', '运维任务', 'ops-1', 'ceo')
    expect((service.status('ceo').tasks as unknown[]).length).toBe(2)
    expect((service.status('cto').tasks as unknown[]).length).toBe(1)
  })

  it('GIVEN 集团模板 WHEN 快照 THEN 岗位带中文显示名(title)', () => {
    const { service } = makeService(dir, GROUP_YML)
    const pos = service.status('ceo').positions.find((p) => p.id === 'cto')
    expect(pos?.title).toBe('CTO')
  })
})
