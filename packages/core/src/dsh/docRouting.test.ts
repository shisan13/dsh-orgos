/**
 * 文档路由(docList/docGet/docCreate/docUpdate/docSearch)测试:Given-When-Then
 * 覆盖:多 provider 合并与过滤、scope 投影(成员只见本 team)、get/update 歧义消解、
 * create 必须显式 provider、CAS STALE 透传、单 provider 故障隔离、team_doctor 观测。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TeamService } from './teamService.js'
import type { DocumentProvider } from './extensions.js'
import type { DshAgents, AgentPresetsMount, LiveAgent } from './memberRuntime.js'

const TEST_TEAM_YML = `org: acme
nodes:
  - id: acme
    kind: org
    orchestratorPosition: lead
    children: [team-main, team-b]
  - id: team-main
    kind: team
  - id: team-b
    kind: team
positions:
  - id: lead
    occupant: { kind: agent, preset: orgos-orchestrator }
  - id: coder-1
    teamId: team-main
    occupant: { kind: agent, preset: orgos-coder }
  - id: coder-b
    teamId: team-b
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

describe('TeamService 文档路由(team_doc_* 服务端)', () => {
  let dir: string
  let service: TeamService

  const ref = (id: string, title: string, teamId?: string) => ({ id, title, teamId })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orgos-docroute-'))
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

  it('GIVEN 未注册 provider WHEN docList/docSearch THEN 返回空列表而非报错', async () => {
    await expect(service.docList('coder-1', undefined)).resolves.toEqual({ ok: true, items: [] })
    await expect(service.docSearch('coder-1', undefined, 'x')).resolves.toEqual({ ok: true, items: [] })
    const r = await service.docCreate('coder-1', 'git-wiki', 't', 'b')
    expect(r.ok).toBe(false)
  })

  it('GIVEN 显式 providerId 未注册 WHEN docList/docGet THEN 返回未注册原因', async () => {
    const list = await service.docList('coder-1', 'ghost')
    expect(list).toEqual({ ok: false, reason: '文档 provider 未注册:ghost' })
    const get = await service.docGet('coder-1', 'ghost', 'd1')
    expect(get).toEqual({ ok: false, reason: '文档 provider 未注册:ghost' })
  })

  it('GIVEN 两个 provider 各有一篇 WHEN docList 省略 provider THEN 合并且附 provider 标识', async () => {
    register('git-wiki', {
      listDocuments: async () => [ref('a.md', 'A')],
      searchDocuments: async () => [],
    })
    register('feishu-docs', {
      listDocuments: async () => [ref('d-1', 'B')],
      searchDocuments: async () => [],
    })
    const r = await service.docList('coder-1', undefined)
    expect(r).toEqual({
      ok: true,
      items: [
        { id: 'a.md', title: 'A', provider: 'git-wiki' },
        { id: 'd-1', title: 'B', provider: 'feishu-docs' },
      ],
    })
    const filtered = await service.docList('coder-1', 'git-wiki')
    expect(filtered).toEqual({ ok: true, items: [{ id: 'a.md', title: 'A', provider: 'git-wiki' }] })
  })

  it('GIVEN ref 标注 teamId 属其它团队 WHEN 成员 docList THEN 被投影剔除(成员只见本 team)', async () => {
    register('git-wiki', {
      listDocuments: async () => [ref('a.md', '本队', 'team-main'), ref('b.md', '他队', 'team-b')],
      searchDocuments: async () => [],
    })
    const r = await service.docList('coder-1', 'git-wiki')
    expect(r).toEqual({ ok: true, items: [{ id: 'a.md', title: '本队', teamId: 'team-main', provider: 'git-wiki' }] })
    // orchestrator(org 根)可见全部管辖层
    const lead = await service.docList('lead', 'git-wiki')
    expect(lead).toEqual({
      ok: true,
      items: [
        { id: 'a.md', title: '本队', teamId: 'team-main', provider: 'git-wiki' },
        { id: 'b.md', title: '他队', teamId: 'team-b', provider: 'git-wiki' },
      ],
    })
  })

  it('GIVEN provider 抛异常 WHEN docList 多 provider THEN 故障隔离不阻断其它', async () => {
    register('boom', {
      listDocuments: async () => {
        throw new Error('boom')
      },
      searchDocuments: async () => [],
    })
    register('git-wiki', {
      listDocuments: async () => [ref('a.md', 'A')],
      searchDocuments: async () => [],
    })
    const r = await service.docList('coder-1', undefined)
    expect(r).toEqual({ ok: true, items: [{ id: 'a.md', title: 'A', provider: 'git-wiki' }] })
  })

  it('GIVEN 单 provider 有文档 WHEN docGet 按 id 定位 THEN 返回内容与 provider', async () => {
    register('git-wiki', {
      getDocument: async (r) => (r.id === 'a.md' ? { ref: ref('a.md', 'A'), body: '正文' } : undefined),
    })
    const r = await service.docGet('coder-1', undefined, 'a.md')
    expect(r).toEqual({ ok: true, doc: { ref: { id: 'a.md', title: 'A' }, body: '正文', provider: 'git-wiki' }, ambiguous: undefined })
  })

  it('GIVEN 两个 provider 命中同一 id WHEN docGet/docUpdate 无 provider THEN 返回歧义', async () => {
    register('git-wiki', {
      getDocument: async () => ({ ref: ref('d1', 'A'), body: 'g' }),
      updateDocument: async () => ({ ok: true, ref: ref('d1', 'A') }),
    })
    register('feishu-docs', {
      getDocument: async () => ({ ref: ref('d1', 'A'), body: 'f' }),
      updateDocument: async () => ({ ok: true, ref: ref('d1', 'A') }),
    })
    const get = await service.docGet('coder-1', undefined, 'd1')
    expect(get).toMatchObject({ ok: true, ambiguous: ['feishu-docs'] })
    const update = await service.docUpdate('coder-1', undefined, 'd1', { body: 'x' })
    expect(update).toEqual({ ok: false, reason: '文档 d1 在多个 provider 存在(git-wiki/feishu-docs),请显式指定 provider' })
    const ok = await service.docUpdate('coder-1', 'git-wiki', 'd1', { body: 'x' })
    expect(ok).toEqual({ ok: true, ref: { id: 'd1', title: 'A', provider: 'git-wiki' } })
  })

  it('GIVEN 文档不存在 WHEN docGet/docUpdate THEN 返回不存在', async () => {
    register('git-wiki', { getDocument: async () => undefined })
    expect(await service.docGet('coder-1', undefined, 'nope')).toEqual({ ok: false, reason: '文档不存在:nope' })
    expect(await service.docUpdate('coder-1', 'git-wiki', 'nope', { body: 'x' })).toEqual({ ok: false, reason: '文档不存在:nope' })
  })

  it('GIVEN create 缺 provider WHEN docCreate THEN 拒绝并列出可用 provider', async () => {
    register('git-wiki', {})
    const r = await service.docCreate('coder-1', '', 't', 'b')
    expect(r).toEqual({ ok: false, reason: 'create 必须显式 provider(可选:git-wiki)' })
  })

  it('GIVEN provider 就绪 WHEN docCreate THEN 携带调用方 team scope 转发', async () => {
    const seen: Array<{ scope: { teamId?: string }; doc: { title: string; body: string } }> = []
    register('git-wiki', {
      createDocument: async (scope, doc) => {
        seen.push({ scope, doc })
        return ref('new.md', doc.title, scope.teamId)
      },
    })
    const r = await service.docCreate('coder-1', 'git-wiki', '新文档', '内容')
    expect(r).toEqual({ ok: true, ref: { id: 'new.md', title: '新文档', teamId: 'team-main', provider: 'git-wiki' } })
    expect(seen[0]).toEqual({ scope: { teamId: 'team-main' }, doc: { title: '新文档', body: '内容' } })
  })

  it('GIVEN provider 判定版本冲突 WHEN docUpdate THEN STALE 透传且带 currentVersion', async () => {
    register('git-wiki', {
      getDocument: async () => ({ ref: { id: 'a.md', title: 'A', version: 'v1' }, body: 'old' }),
      updateDocument: async () => ({ ok: false, code: 'STALE_DOCUMENT', currentVersion: 'v2' }),
    })
    const r = await service.docUpdate('coder-1', 'git-wiki', 'a.md', { body: 'new' }, 'v1')
    expect(r).toEqual({ ok: false, reason: '文档已被他人修改(版本冲突)', code: 'STALE_DOCUMENT', currentVersion: 'v2' })
  })

  it('GIVEN 更新成功 WHEN docUpdate 传 expectedVersion THEN provider 收到 opts 且返回新 ref', async () => {
    const updateDocument = vi.fn(async () => ({ ok: true, ref: { id: 'a.md', title: 'A2', version: 'v2' } }))
    register('git-wiki', {
      getDocument: async () => ({ ref: { id: 'a.md', title: 'A', version: 'v1' }, body: 'old' }),
      updateDocument,
    })
    const r = await service.docUpdate('coder-1', 'git-wiki', 'a.md', { title: 'A2' }, 'v1')
    expect(r).toEqual({ ok: true, ref: { id: 'a.md', title: 'A2', version: 'v2', provider: 'git-wiki' } })
    expect(updateDocument).toHaveBeenCalledWith({ id: 'a.md', title: 'A', version: 'v1' }, { title: 'A2' }, { expectedVersion: 'v1' })
  })

  it('GIVEN 多 provider 可搜索 WHEN docSearch THEN 合并、投影并限条数', async () => {
    register('git-wiki', {
      searchDocuments: async () => [ref('a.md', 'A'), ref('b.md', 'B', 'team-b')],
    })
    register('feishu-docs', { searchDocuments: async () => [ref('d1', 'A 云文档')] })
    const r = await service.docSearch('coder-1', undefined, 'A', 10)
    expect(r).toEqual({
      ok: true,
      items: [
        { id: 'a.md', title: 'A', provider: 'git-wiki' },
        { id: 'd1', title: 'A 云文档', provider: 'feishu-docs' },
      ],
    })
  })

  it('GIVEN provider 已注册 WHEN team_doctor THEN doc-providers 检查可观测', () => {
    register('git-wiki', {})
    const check = service.doctor().checks.find((c) => c.name === 'doc-providers')
    expect(check?.detail).toContain('git-wiki')
    expect(check?.detail).toContain('1 个')
  })

  /** 用最小 provider 注册辅助(缺省方法全部安全 no-op) */
  function register(id: string, impl: Partial<DocumentProvider> & { label?: string }): void {
    service.registerDocumentProvider({
      id,
      label: impl.label ?? id,
      listDocuments: impl.listDocuments ?? (async () => []),
      getDocument: impl.getDocument ?? (async () => undefined),
      createDocument: impl.createDocument ?? (async () => ({ id: 'x', title: 'x' })),
      updateDocument: impl.updateDocument ?? (async () => ({ ok: true, ref: { id: 'x', title: 'x' } })),
      searchDocuments: impl.searchDocuments ?? (async () => []),
    })
  }
})
