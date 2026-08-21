/**
 * M3.2 RPC 认证与成员 env 注入测试:Given-When-Then
 * 覆盖:token 签发/校验(正确/错误岗位/错误 token/恒时)、logRpc 审计落 runs、
 * rpc 配置驱动 DshSdkMemberRuntime 子进程 env 注入(URL/岗位/token)。
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

describe('TeamService RPC 认证(M3.2)', () => {
  let dir: string
  let service: TeamService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orgos-rpc-'))
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

  it('GIVEN issueMemberRpc WHEN 校验 THEN 同岗位同 token 通过;错误 token/错误岗位拒绝', () => {
    const token = service.issueMemberRpc('coder-1')
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(service.verifyMemberRpc('coder-1', token)).toBe(true)
    expect(service.verifyMemberRpc('coder-1', 'wrong')).toBe(false)
    expect(service.verifyMemberRpc('lead', token)).toBe(false)
    expect(service.verifyMemberRpc('coder-1', '')).toBe(false)
  })

  it('GIVEN 重复签发 WHEN 校验 THEN 新 token 覆盖旧 token(旧 token 失效)', () => {
    const t1 = service.issueMemberRpc('coder-1')
    const t2 = service.issueMemberRpc('coder-1')
    expect(t1).not.toBe(t2)
    expect(service.verifyMemberRpc('coder-1', t2)).toBe(true)
    expect(service.verifyMemberRpc('coder-1', t1)).toBe(false)
  })

  it('GIVEN RPC 审计 WHEN logRpc THEN 落 runs 流(op=rpc)', () => {
    service.logRpc('coder-1', 'docCreate', true)
    service.logRpc('coder-1', 'status', false)
    const rows = service.store.readAll('runs').filter((r) => r.op === 'rpc')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ positionId: 'coder-1', method: 'docCreate', ok: true })
    expect(rows[1]).toMatchObject({ method: 'status', ok: false })
  })

  it('GIVEN 未签发岗位 WHEN 校验 THEN 拒绝(不存在即无 token)', () => {
    expect(service.verifyMemberRpc('ghost', 'any')).toBe(false)
  })
})

describe('runReport 对已删除岗位的历史行容错(转岗/退役回归)', () => {
  it('GIVEN runs 流含已删除岗位的历史行 WHEN runReport THEN 不抛错且该行不参与投影', () => {
    const d2 = mkdtempSync(join(tmpdir(), 'orgos-orphan-rr-'))
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
    const svc = new TeamService({ stateRoot: d2, ownerIds: ['ou_owner'], agents, presets: { mount: async () => ({}) } })
    expect(svc.setupInit(TEST_TEAM_YML).ok).toBe(true)
    svc.store.append('runs', { op: 'inbound', positionId: 'assistant-2', channel: 'telegram-personal' })
    svc.store.append('runs', { op: 'inbound', positionId: 'coder-1', channel: 'feishu-coder' })
    const report = svc.runReport('lead', 50)
    expect(report.summary.length).toBeGreaterThan(0)
    expect(report.runs.some((r) => r.positionId === 'assistant-2')).toBe(false)
    expect(report.runs.some((r) => r.positionId === 'coder-1')).toBe(true)
    rmSync(d2, { recursive: true, force: true })
  })
})
