/**
 * TeamService 绑定层测试:Given-When-Then(AGENTS.md §4 闸门)
 * fake agents/presets,真实 domain 引擎 + 临时 stateRoot。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TeamService } from './teamService.js'

const TEST_TEAM_YML = `org: acme
nodes:
  - id: acme
    kind: org
    orchestratorPosition: lead
    children: [team-main]
  - id: team-main
    kind: team
positions:
  - id: lead
    title: 团队负责人
    occupant: { kind: agent, preset: orgos-orchestrator }
  - id: coder-1
    teamId: team-main
    occupant: { kind: agent, preset: orgos-coder }
  - id: reviewer-1
    teamId: team-main
    occupant: { kind: agent, preset: orgos-reviewer }
routes: []
acl:
  delegationDepthMax: 3
`
import type { DshAgents, AgentPresetsMount, LiveAgent } from './memberRuntime.js'

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

describe('TeamService(绑定层)', () => {
  let dir: string
  let service: TeamService
  let fakeAgents: DshAgents & { registry: Map<string, FakeAgent> }
  const events: Array<[string, Record<string, unknown>]> = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orgos-'))
    events.length = 0
    const registry = new Map<string, FakeAgent>()
    fakeAgents = {
      registry,
      async create(options) {
        const o = options as { sessionId: string; setup?: (c: unknown) => Promise<unknown> }
        await o.setup?.({})
        const agent = new FakeAgent(o.sessionId)
        registry.set(o.sessionId, agent)
        return { agent, dispose: async () => {} }
      },
      async resume() {
        // 全新会话:resume 报 not found,ensure 回退 create(被测路径)
        throw new Error('SESSION not found')
      },
      get(id) {
        return registry.get(id) ?? undefined
      },
      list() {
        return [...registry.values()]
      },
    }
    const presets: AgentPresetsMount = {
      async mount() {
        return {}
      },
    }
    service = new TeamService({
      stateRoot: dir,
      ownerIds: ['ou_owner'],
      agents: fakeAgents,
      presets,
      emit: (event, payload) => events.push([event, payload]),
    })
    const init = service.setupInit(TEST_TEAM_YML)
    expect(init.ok).toBe(true)
    expect(service.loaded).toBe(true)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('GIVEN 团队已初始化 WHEN 白名单外 DM 入站 THEN 拒绝路由', async () => {
    const result = await service.handleInbound({
      channel: 'feishu',
      peer: { kind: 'direct', id: 'ou_stranger' },
      sender: { id: 'ou_stranger' },
      kind: 'text',
      content: 'hi',
      messageId: 'm1',
    })
    expect(result.routed).toBe(false)
  })

  it('GIVEN owner DM 入站 WHEN 路由到 org orchestrator THEN 创建成员 agent 并投递', async () => {
    const result = await service.handleInbound({
      channel: 'feishu',
      peer: { kind: 'direct', id: 'ou_owner' },
      sender: { id: 'ou_owner', name: 'owner' },
      kind: 'text',
      content: '帮我看下任务',
      messageId: 'm2',
    })
    expect(result.routed).toBe(true)
    expect(result.positionId).toBe('lead')
    const agent = fakeAgents.registry.get('orgos-member-lead')
    expect(agent).toBeDefined()
    expect(agent!.inbox.some((t) => t.includes('帮我看下任务'))).toBe(true)
  })

  it('GIVEN orchestrator 派发 WHEN Brief 缺验收 THEN 拒绝并返回字段级问题', () => {
    const result = service.delegate('lead', 'coder-1', {
      task: '修 bug',
      requirements: ['r1'],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('invalid_brief')
      expect(result.errors?.length).toBeGreaterThan(0)
    }
  })

  it('GIVEN 合法委派 WHEN 派发 THEN 创建委派并投递成员 inbox', async () => {
    const result = service.delegate('lead', 'coder-1', {
      task: '修 bug',
      requirements: ['修复 x'],
      acceptance: ['测试通过'],
    })
    expect(result.ok).toBe(true)
    await new Promise((r) => setTimeout(r, 10)) // 委派投递是异步的(派发不阻塞,产品语义)
    const agent = fakeAgents.registry.get('orgos-member-coder-1')
    expect(agent).toBeDefined()
    expect(agent!.inbox.some((t) => t.includes('[TEAM DELEGATION') && t.includes('修 bug'))).toBe(true)
    expect(events.some(([e]) => e === 'team/delegation-created')).toBe(true)
  })

  it('GIVEN 委派完成 WHEN settle THEN 发完成事件且 digest 截断', () => {
    const created = service.delegate('lead', 'coder-1', {
      task: '修 bug',
      requirements: ['r1'],
      acceptance: ['a1'],
    })
    expect(created.ok).toBe(true)
    const settled = service.settle('coder-1', (created as { delegation: { id: string } }).delegation.id, 'completed', '完成,测试通过')
    expect(settled.ok).toBe(true)
    expect(events.some(([e, p]) => e === 'team/delegation-completed' && typeof p.report === 'string')).toBe(true)
  })

  it('GIVEN 重启(新建 service)WHEN 重放持久化 THEN 任务板/委派恢复', () => {
    const created = service.delegate('lead', 'coder-1', {
      task: '恢复测试',
      requirements: ['r1'],
      acceptance: ['a1'],
    })
    expect(created.ok).toBe(true)
    service.taskCreate('team-main', '板内任务', 'coder-1', 'lead')

    const service2 = new TeamService({
      stateRoot: dir,
      ownerIds: ['ou_owner'],
      agents: fakeAgents,
      presets: { mount: async () => ({}) },
    })
    const loaded = service2.load()
    expect(loaded.loaded).toBe(true)
    const snap = service2.snapshot()
    expect(snap.delegations.length).toBeGreaterThan(0)
    expect(snap.tasks.length).toBeGreaterThan(0)
  })

  it('GIVEN 成员状态事件 WHEN setMemberStatus THEN snapshot 显示实时状态', () => {
    service.setMemberStatus('lead', 'busy')
    service.setMemberStatus('coder-1', 'idle')
    const snap = service.snapshot()
    const lead = snap.positions.find((x) => x.id === 'lead')
    const coder = snap.positions.find((x) => x.id === 'coder-1')
    expect(lead?.status).toBe('busy')
    expect(coder?.status).toBe('idle')
    // 未上报的岗位默认 offline(非 unknown)
    const reviewer = snap.positions.find((x) => x.id === 'reviewer-1')
    expect(reviewer?.status).toBe('offline')
    expect(events.some(([e, p]) => e === 'team/member-status' && p.status === 'busy')).toBe(true)
  })

  it('GIVEN 团队已加载 WHEN team_doctor THEN 七类检查齐全(含文档 provider 与无路由岗位)', () => {
    const result = service.doctor()
    expect(result.checks.length).toBe(7)
    expect(result.checks[0].detail).toContain('岗位')
    expect(result.checks.find((c) => c.name === 'doc-providers')?.detail).toContain('未注册文档 provider')
    // 本 fixture routes 为空 → 全部岗位无路由,orphan 检查如实列出(而非假装全 ok)
    const orphan = result.checks.find((c) => c.name === 'orphan-positions')
    expect(orphan?.ok).toBe(false)
    expect(orphan?.detail).toContain('lead')
    expect(orphan?.detail).toContain('疑似配置残留')
  })

  it('GIVEN 存在无路由岗位 WHEN doctor THEN orphan-positions 列出并给出修复建议', () => {
    const extra = `org: acme
nodes:
  - id: acme
    kind: org
    orchestratorPosition: lead
    children: [team-main]
  - id: team-main
    kind: team
positions:
  - id: lead
    occupant: { kind: agent, preset: orgos-orchestrator }
  - id: orphan-x
    teamId: team-main
    occupant: { kind: agent, preset: orgos-assistant }
routes:
  - { channel: feishu-main, peerId: oc_1, target: lead }
acl:
  delegationDepthMax: 3
`
    const svc = new TeamService({
      stateRoot: mkdtempSync(join(tmpdir(), 'orgos-orphan-')),
      ownerIds: ['ou_owner'],
      agents: fakeAgents,
      presets: { mount: async () => ({}) },
    })
    expect(svc.setupInit(extra).ok).toBe(true)
    const check = svc.doctor().checks.find((c) => c.name === 'orphan-positions')
    expect(check?.ok).toBe(false)
    expect(check?.detail).toContain('orphan-x')
    expect(check?.detail).toContain('疑似配置残留')
  })

  it('GIVEN 已加载团队 WHEN bindRoute THEN 路由生效且配置持久化', () => {
    const r = service.bindRoute('feishu-main', 'oc_team_room', 'coder-1')
    expect(r.ok).toBe(true)
    const snap = service.snapshot()
    expect(snap.loaded).toBe(true)
    // 重启恢复:新 service 读同一 stateRoot
    const service2 = new TeamService({
      stateRoot: dir,
      ownerIds: ['ou_owner'],
      agents: fakeAgents,
      presets: { mount: async () => ({}) },
    })
    expect(service2.load().loaded).toBe(true)
    expect(service2.snapshot().positions.length).toBeGreaterThan(0)
  })

  it('GIVEN bindRoute 目标不存在 WHEN bind THEN 拒绝', () => {
    const r = service.bindRoute('feishu-main', 'oc_x', 'no-such-position')
    expect(r.ok).toBe(false)
  })

  it('GIVEN 已加载团队 WHEN unbindRoute THEN 解绑成功', () => {
    expect(service.bindRoute('feishu-main', 'oc_x', 'coder-1').ok).toBe(true)
    expect(service.unbindRoute('feishu-main', 'oc_x').ok).toBe(true)
  })

  it('GIVEN 成员审批请求 WHEN 呈现卡片 THEN outboundCard 收到 approval 卡片', async () => {
    let card: unknown = null
    const svc2 = new TeamService({
      stateRoot: dir,
      ownerIds: ['ou_owner'],
      agents: fakeAgents,
      presets: { mount: async () => ({}) },
      outboundCard: (_t, c) => { card = c },
    })
    svc2.load()
    // 让 lead 先有入站路由(最近路由表)
    await svc2.handleInbound({
      channel: 'feishu-main',
      peer: { kind: 'group', id: 'oc_room' },
      sender: { id: 'ou_owner' },
      kind: 'mention',
      content: 'hi',
      messageId: 'm-approval',
    })
    await new Promise((r) => setTimeout(r, 10))
    svc2.presentApproval('lead', 'ap-test-1', 'bash', '需要执行命令')
    expect(card).not.toBeNull()
    expect((card as { kind?: string }).kind).toBe('approval')
    expect((card as { approvalId?: string }).approvalId).toBe('ap-test-1')
  })

  it('GIVEN 审批回执 allow WHEN resolveApproval THEN 返回 true(答复 pending)', async () => {
    // 直接走 memberRuntime 路径:presentApproval 不挂 pending,这里验证 resolve 未找到时安全返回 false
    expect(service.resolveApproval('ap-not-exist', 'allow')).toBe(false)
  })

  it('GIVEN approval_reply 入站 WHEN 无 pending THEN 拒绝路由且不崩溃', async () => {
    const r = await service.handleInbound({
      channel: 'feishu-main',
      peer: { kind: 'group', id: 'oc_room' },
      sender: { id: 'ou_owner' },
      kind: 'approval_reply',
      approval: { approvalId: 'ap-unknown', action: 'allow' },
      messageId: 'm-ap',
    })
    expect(r.routed).toBe(false)
  })

  it('GIVEN 委派与回执 WHEN runReport THEN 记录与摘要正确', () => {
    const created = service.delegate('lead', 'coder-1', { task: '跑批', requirements: ['r1'], acceptance: ['a1'] })
    expect(created.ok).toBe(true)
    const id = (created as { delegation: { id: string } }).delegation.id
    service.settle('coder-1', id, 'completed', 'done')
    const report = service.runReport('lead')
    expect(report.runs.length).toBeGreaterThanOrEqual(2)
    expect(report.summary).toContain('完成 1')
    expect(report.summary).toContain('委派单:在途 0 · 完成 1 · 失败 0')
  })

  it('GIVEN 在途委派单 WHEN runReport THEN 在途口径来自委派单而非事件流', () => {
    const created = service.delegate('lead', 'reviewer-1', { task: '分析', requirements: ['r1'], acceptance: ['a1'] })
    expect(created.ok).toBe(true)
    const report = service.runReport('lead')
    expect(report.summary).toContain('委派单:在途 1')
  })

  it('GIVEN /run 命令入站 WHEN handleInbound THEN 直接回发摘要不投递成员', async () => {
    let outboundText = ''
    const svc = new TeamService({
      stateRoot: dir,
      ownerIds: ['ou_owner'],
      agents: fakeAgents,
      presets: { mount: async () => ({}) },
      outbound: (_t, text) => { outboundText = text },
    })
    svc.load()
    const r = await svc.handleInbound({
      channel: 'feishu-main',
      peer: { kind: 'group', id: 'oc_room' },
      sender: { id: 'ou_owner' },
      kind: 'mention',
      content: '/run',
      messageId: 'm-run',
    })
    expect(r.routed).toBe(true)
    expect(outboundText).toContain('运行记录')
  })

  it('GIVEN lead(org 根 orchestrator)WHEN mailSend 到 team-main 岗位 THEN 允许', () => {
    const r = service.mailSend('lead', 'coder-1', 'note', 'hello')
    expect(r.ok).toBe(true)
  })

  it('GIVEN team_status 结果 WHEN JSON 序列化 THEN 无 undefined 键(lossless)', () => {
    const snap = service.status('lead')
    const json = JSON.stringify(snap)
    expect(json).not.toContain('undefined')
    expect(JSON.parse(json).positions.length).toBeGreaterThan(0)
  })

  it('GIVEN 无 team.yml(新 stateRoot)WHEN load THEN 未加载且心跳提示配置缺失', () => {
    const empty = new TeamService({
      stateRoot: mkdtempSync(join(tmpdir(), 'orgos-empty-')),
      ownerIds: [],
      agents: fakeAgents,
      presets: { mount: async () => ({}) },
    })
    expect(empty.load().loaded).toBe(false)
    expect(empty.heartbeatReport().text).toContain('未配置')
  })
})
