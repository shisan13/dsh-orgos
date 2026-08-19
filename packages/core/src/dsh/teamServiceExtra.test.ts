/**
 * TeamService 补充路径测试(邮箱/任务板/心跳/human 投递/replay/序列化/三层记忆)
 * Given-When-Then(AGENTS.md §4 闸门)。fixture 与 teamService.test.ts 保持同构。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TeamService, serializeTeamConfig, teamServiceRouteFor } from './teamService.js'
import { createFileTeamStore } from './store.js'
import type { DshAgents, AgentPresetsMount, LiveAgent } from './memberRuntime.js'

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
  - id: human-1
    teamId: team-main
    occupant: { kind: human, im: { channel: feishu, userId: ou_human } }
routes:
  - { channel: feishu, peerId: oc_room, target: coder-1 }
  - { channel: feishu, peerId: ou_human, target: human-1 }
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

interface OutCall {
  target: unknown
  text: string
}

describe('TeamService 补充路径(邮箱/任务板/human/replay/记忆)', () => {
  let dir: string
  let service: TeamService
  let fakeAgents: DshAgents & { registry: Map<string, FakeAgent> }
  const events: Array<[string, Record<string, unknown>]> = []
  const outs: OutCall[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orgos-extra-'))
    events.length = 0
    outs.length = 0
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
        throw new Error('SESSION not found')
      },
      get(id) {
        return registry.get(id) ?? undefined
      },
      list() {
        return [...registry.values()]
      },
    }
    const presets: AgentPresetsMount = { async mount() { return {} } }
    service = new TeamService({
      stateRoot: dir,
      ownerIds: ['ou_owner'],
      agents: fakeAgents,
      presets,
      emit: (event, payload) => events.push([event, payload]),
      outbound: (target, text) => outs.push({ target, text }),
    })
    expect(service.setupInit(TEST_TEAM_YML).ok).toBe(true)
    expect(service.loaded).toBe(true)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('GIVEN owner DM 入站 human 岗位 WHEN handleInbound THEN 直接转发不建 agent', async () => {
    const r = await service.handleInbound({
      channel: 'feishu',
      peer: { kind: 'direct', id: 'ou_human' },
      sender: { id: 'ou_owner' },
      kind: 'text',
      content: '你好真人',
      messageId: 'm-human',
    })
    expect(r.routed).toBe(true)
    expect(r.positionId).toBe('human-1')
    expect(outs.length).toBe(1)
    expect(outs[0]?.text).toContain('你好真人')
    expect(fakeAgents.registry.size).toBe(0)
  })

  it('GIVEN 委派给 human 岗位 WHEN deliverDelegation THEN outbound 发任务卡', () => {
    const created = service.delegate('lead', 'human-1', { task: '出个差', requirements: ['r1'], acceptance: ['a1'] })
    expect(created.ok).toBe(true)
    expect(outs.some((o) => o.text.includes('出个差'))).toBe(true)
    expect(events.some(([e]) => e === 'team/delegation-created')).toBe(true)
  })

  it('GIVEN 邮箱发送 WHEN mailSend THEN 成功落流且可读回', () => {
    const r = service.mailSend('lead', 'coder-1', 'note', '备忘')
    expect(r.ok).toBe(true)
    const mails = service.mailRecv('coder-1')
    expect(mails.length).toBe(1)
    expect(events.some(([e]) => e === 'team/mailbox-sent')).toBe(true)
  })

  it('GIVEN 任务创建/认领/完成 WHEN 三动作 THEN 状态推进', () => {
    const created = service.taskCreate('team-main', '修 bug', 'coder-1', 'lead')
    expect(created.ok).toBe(true)
    const task = created.task as { id: string }
    expect(service.taskClaim('coder-1', task.id).ok).toBe(true)
    expect(service.taskDone('coder-1', task.id).ok).toBe(true)
    expect(events.some(([e]) => e === 'team/taskboard-changed')).toBe(true)
  })

  it('GIVEN 有任务与委派 WHEN heartbeatReport THEN 汇总数字正确', () => {
    service.taskCreate('team-main', '修 bug', 'coder-1', 'lead')
    const created = service.delegate('lead', 'coder-1', { task: '跑批', requirements: ['r1'], acceptance: ['a1'] })
    expect(created.ok).toBe(true)
    const text = service.heartbeatReport().text
    expect(text).toContain('成员:3 岗位')
    expect(text).toContain('任务:1(进行中 0)')
    expect(text).toContain('委派:1(失败 0)')
  })

  it('GIVEN 绑定/解绑路由 WHEN bind/unbind THEN 热重载生效', () => {
    expect(service.bindRoute('feishu', 'oc_new', 'lead').ok).toBe(true)
    expect(service.bindRoute('feishu', 'oc_new', 'ghost').ok).toBe(false)
    expect(service.unbindRoute('feishu', 'oc_new').ok).toBe(true)
  })

  it('GIVEN 成员状态更新 WHEN setMemberStatus THEN 发出状态事件', () => {
    service.setMemberStatus('coder-1', 'busy')
    expect(events.some(([e, p]) => e === 'team/member-status' && p.positionId === 'coder-1' && p.status === 'busy')).toBe(true)
  })

  it('GIVEN 成员回复文本 WHEN deliverAssistantText THEN 回发最近入站路由', async () => {
    await service.handleInbound({
      channel: 'feishu',
      peer: { kind: 'group', id: 'oc_room' },
      sender: { id: 'ou_owner' },
      kind: 'text',
      content: 'hello',
      messageId: 'm1',
    })
    expect(teamServiceRouteFor(service, 'coder-1')?.peer.id).toBe('oc_room')
    service.deliverAssistantText('coder-1', '收到')
    expect(outs.some((o) => o.text === '收到')).toBe(true)
  })

  it('GIVEN 持久化操作记录 WHEN 冷启动 load THEN 重放恢复邮箱/任务板/委派', () => {
    service.mailSend('lead', 'coder-1', 'note', '备忘')
    const created = service.taskCreate('team-main', '修 bug', 'coder-1', 'lead')
    const task = created.task as { id: string }
    service.taskClaim('coder-1', task.id)
    const dlg = service.delegate('lead', 'coder-1', { task: '跑批', requirements: ['r1'], acceptance: ['a1'] })
    expect(dlg.ok).toBe(true)
    const dlgId = (dlg as { delegation: { id: string } }).delegation.id
    service.settle('coder-1', dlgId, 'completed', 'done')

    const service2 = new TeamService({
      stateRoot: dir,
      ownerIds: ['ou_owner'],
      agents: fakeAgents,
      presets: { async mount() { return {} } },
    })
    const loaded = service2.load()
    expect(loaded.loaded).toBe(true)
    expect(service2.mailRecv('coder-1').length).toBe(1)
    const snap = service2.status('lead')
    expect(snap.tasks.length).toBe(1)
    expect((snap.delegations as Array<{ status: string }>).some((d) => d.status === 'completed')).toBe(true)
  })

  it('GIVEN 未加载服务 WHEN 各工具 THEN 全部 fail-safe 返回', () => {
    const empty = new TeamService({
      stateRoot: mkdtempSync(join(tmpdir(), 'orgos-empty-')),
      ownerIds: ['ou_owner'],
      agents: fakeAgents,
      presets: { async mount() { return {} } },
    })
    expect(empty.mailSend('lead', 'coder-1', 'note', 'x').ok).toBe(false)
    expect(empty.taskCreate('team-main', 't', 'coder-1', 'lead').ok).toBe(false)
    expect(empty.bindRoute('feishu', 'oc', 'lead').ok).toBe(false)
    expect(empty.unbindRoute('feishu', 'oc').ok).toBe(false)
    expect(empty.delegate('lead', 'coder-1', { task: 'x' }).ok).toBe(false)
    expect(empty.settle('coder-1', 'dlg-x', 'completed', 'x').ok).toBe(false)
    expect(empty.heartbeatReport().text).toContain('未配置')
    expect(empty.memorySave('lead', 'team', 'contribution', 'x').ok).toBe(false)
    expect(empty.memoryList('lead').entries).toEqual([])
  })

  describe('三层记忆流(memorySave/memoryList,§4.6.3)', () => {
    it('GIVEN 成员写 team 层 WHEN memorySave THEN 落本 team 且本人可读回', () => {
      const r = service.memorySave('coder-1', 'team', 'contribution', '修复构建脚本', '一句话摘要')
      expect(r.ok).toBe(true)
      const entry = (r as { entry: { teamId?: string } }).entry
      expect(entry.teamId).toBe('team-main')
      const list = service.memoryList('coder-1')
      expect(list.entries.length).toBe(1)
      expect(list.entries[0]?.content).toBe('修复构建脚本')
      expect(events.some(([e]) => e === 'team/memory-saved')).toBe(true)
    })

    it('GIVEN 成员写 org 层 WHEN memorySave THEN 越权拒绝', () => {
      const r = service.memorySave('coder-1', 'org', 'insight', '越权提炼')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain('越权')
    })

    it('GIVEN 成员指定非本 team 的 teamId WHEN memorySave THEN 拒绝', () => {
      const r = service.memorySave('coder-1', 'team', 'contribution', 'x', undefined, 'ghost-team')
      expect(r.ok).toBe(false)
    })

    it('GIVEN 根 orchestrator 写 org 层 WHEN memoryList 按 scope 投影 THEN 成员不可见 org 条目', () => {
      expect(service.memorySave('lead', 'org', 'decision', '集团战略').ok).toBe(true)
      expect(service.memorySave('coder-1', 'team', 'contribution', '成员贡献').ok).toBe(true)
      const leadList = service.memoryList('lead')
      expect(leadList.entries.length).toBe(2)
      const coderList = service.memoryList('coder-1')
      expect(coderList.entries.length).toBe(1)
      expect(coderList.entries[0]?.level).toBe('team')
    })

    it('GIVEN 记忆已持久化 WHEN 冷启动 load THEN 重放恢复', () => {
      service.memorySave('coder-1', 'team', 'handover', '交接记录')
      service.memorySave('lead', 'org', 'insight', '集团洞察')
      const service2 = new TeamService({
        stateRoot: dir,
        ownerIds: ['ou_owner'],
        agents: fakeAgents,
        presets: { async mount() { return {} } },
      })
      expect(service2.load().loaded).toBe(true)
      expect(service2.memoryList('lead').entries.length).toBe(2)
    })
  })
})

describe('serializeTeamConfig(确定性序列化)', () => {
  it('GIVEN roles/handover/restricted/allowCrossTeam 配置 WHEN 序列化 THEN 全字段还原', () => {
    const text = serializeTeamConfig({
      org: 'acme',
      nodes: [
        { id: 'acme', kind: 'org', orchestratorPosition: 'lead', children: ['team-main'] },
        { id: 'team-main', kind: 'team', title: '主队' },
      ],
      positions: [
        { id: 'lead', occupant: { kind: 'agent', preset: 'orgos-orchestrator' } },
        {
          id: 'guest-1',
          teamId: 'team-main',
          restricted: true,
          capabilityProfile: ['code'],
          occupant: { kind: 'agent', preset: 'orgos-coder' },
          handover: { inheritMemory: 'team', reassignOpenTasks: 'transfer' },
        },
        { id: 'human-1', teamId: 'team-main', occupant: { kind: 'human', im: { channel: 'feishu', userId: 'ou_1' } } },
      ],
      routes: [{ channel: 'feishu', peerId: 'oc_1', target: 'lead' }],
      acl: {
        delegationDepthMax: 3,
        allowCrossTeam: [{ from: 'team-main', to: 'team-main', scopes: ['note'] }],
        block: [{ to: 'guest-1' }],
      },
      roles: { 'orgos-guest': { visibility: 'team', authority: 'self', memory: ['private', 'team'], subscription: ['team', 'self'] } },
    })
    expect(text).toContain('restricted: true')
    expect(text).toContain('capabilityProfile: [code]')
    expect(text).toContain('handover: { inheritMemory: team, reassignOpenTasks: transfer }')
    expect(text).toContain('occupant: { kind: human, im: { channel: feishu, userId: ou_1 } }')
    expect(text).toContain('allowCrossTeam:')
    expect(text).toContain('block:')
    expect(text).toContain('memory: [private, team]')
  })
})

describe('createFileTeamStore 写入后 readAll(与 replay 联动的快照检查)', () => {
  it('GIVEN 空目录 store WHEN readAll THEN 空数组(不建文件)', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'orgos-ro-'))
    try {
      const store = createFileTeamStore(dir2)
      expect(store.readAll('runs')).toEqual([])
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }
  })
})
