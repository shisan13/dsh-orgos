/**
 * 扩展面(Orgos Extension API)测试:Given-When-Then(AGENTS.md §4 闸门)
 * 覆盖:存储 provider 注入、文档 provider registry、集团联邦注入、团队事件订阅。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TeamService } from './teamService.js'
import type { TeamStore } from './store.js'
import type { DocumentProvider, OrgFederation } from './extensions.js'
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
    occupant: { kind: agent, preset: orgos-orchestrator }
  - id: coder-1
    teamId: team-main
    occupant: { kind: agent, preset: orgos-coder }
routes: []
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

/** 内存 TeamStore fake(验证 provider 注入点) */
function memoryStore(): TeamStore {
  const rows = new Map<string, Record<string, unknown>[]>()
  const append = (stream: string, record: Record<string, unknown>) => {
    rows.set(stream, [...(rows.get(stream) ?? []), record])
  }
  return {
    append,
    readAll: (stream) => rows.get(stream) ?? [],
    saveSnapshot: (stream, state) => append(`snap:${stream}`, state),
    loadSnapshot: () => undefined,
    stateRoot: () => ':memory:',
  }
}

describe('扩展面(Orgos Extension API)', () => {
  let dir: string
  let service: TeamService
  const upstreamEvents: Array<[string, Record<string, unknown>]> = []

  const makeService = (extra: { store?: TeamStore } = {}): TeamService => {
    const agents: DshAgents = {
      async create(o: unknown) {
        const opts = o as { sessionId: string; setup?: (c: unknown) => Promise<unknown> }
        await opts.setup?.({})
        const agent = new FakeAgent(opts.sessionId)
        return { agent, dispose: async () => {} }
      },
      async resume() {
        throw new Error('SESSION not found')
      },
      get: () => undefined,
      list: () => [],
    }
    const presets: AgentPresetsMount = { async mount() { return {} } }
    return new TeamService({
      stateRoot: dir,
      ownerIds: ['ou_owner'],
      agents,
      presets,
      emit: (event, payload) => upstreamEvents.push([event, payload]),
      store: extra.store,
    })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orgos-ext-'))
    upstreamEvents.length = 0
    service = makeService()
    expect(service.setupInit(TEST_TEAM_YML).ok).toBe(true)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('GIVEN 注入自定义 store provider WHEN 构造 THEN 服务使用注入实例(插拔存储)', () => {
    const store = memoryStore()
    const svc = makeService({ store })
    expect(svc.store).toBe(store)
    expect(svc.store.stateRoot()).toBe(':memory:')
    // 团队数据走注入的存储:mailSend 落流后可读回
    expect(svc.setupInit(TEST_TEAM_YML).ok).toBe(true)
    expect(svc.mailSend('lead', 'coder-1', 'note', '走注入存储').ok).toBe(true)
    expect(store.readAll('mailbox').length).toBe(1)
  })

  it('GIVEN 文档 provider 注册 WHEN register/list/dispose THEN 生命周期完整', () => {
    const provider: DocumentProvider = {
      id: 'feishu-bitable',
      label: '飞书多维表格',
      listDocuments: async () => [],
      getDocument: async () => undefined,
      createDocument: async () => ({ id: 'd1', title: 't' }),
      updateDocument: async () => {},
      searchDocuments: async () => [],
    }
    const dispose = service.registerDocumentProvider(provider)
    expect(service.listDocumentProviders()).toEqual([{ id: 'feishu-bitable', label: '飞书多维表格' }])
    expect(upstreamEvents.some(([e]) => e === 'team/document-provider-registered')).toBe(true)
    dispose()
    expect(service.listDocumentProviders()).toEqual([])
  })

  it('GIVEN 注入集团联邦 WHEN doctor THEN 联邦状态可观测', () => {
    expect(service.doctor().checks.find((c) => c.name === 'federation')?.detail).toContain('未接入')
    const fed: OrgFederation = {
      nodeId: 'bg-shanghai',
      dispatchDelegation: async () => ({ ok: true }),
      reportHeartbeat: async () => {},
      escalate: async () => {},
    }
    service.setFederation(fed)
    expect(service.doctor().checks.find((c) => c.name === 'federation')?.detail).toContain('bg-shanghai')
    expect(upstreamEvents.some(([e, p]) => e === 'team/federation-set' && p.nodeId === 'bg-shanghai')).toBe(true)
    service.setFederation(undefined)
    expect(service.doctor().checks.find((c) => c.name === 'federation')?.detail).toContain('未接入')
  })

  it('GIVEN 团队事件订阅 WHEN 内部事件发出 THEN 稳定 API 收到且 disposer 生效', () => {
    const received: Array<[string, Record<string, unknown>]> = []
    const dispose = service.onTeamEvent((event, payload) => received.push([event, payload]))
    service.mailSend('lead', 'coder-1', 'note', '订阅事件')
    expect(received.some(([e]) => e === 'team/mailbox-sent')).toBe(true)
    dispose()
    service.mailSend('lead', 'coder-1', 'note', '第二条')
    expect(received.filter(([e]) => e === 'team/mailbox-sent').length).toBe(1)
  })

  it('GIVEN 订阅者抛异常 WHEN 事件发出 THEN 上游事件总线不受影响', () => {
    service.onTeamEvent(() => {
      throw new Error('boom')
    })
    expect(service.mailSend('lead', 'coder-1', 'note', '隔离').ok).toBe(true)
    expect(upstreamEvents.some(([e]) => e === 'team/mailbox-sent')).toBe(true)
  })
})
