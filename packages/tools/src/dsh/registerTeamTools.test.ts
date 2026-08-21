/**
 * registerTeamTools 注册层测试:Given-When-Then(AGENTS.md §4 闸门)
 * 断言:无 core 服务时静默不注册(跨 profile 容错)、全部工具注册与 execute 转发、
 * parameters 为已编译 JSON Schema 且无 undefined 键(DSH lossless JSON 红线)、
 * team_setup 动作分支(init/bind/unbind/replace 成功与缺参拒绝)。
 */
import { describe, expect, it } from 'vitest'
import { registerTeamTools } from './registerTeamTools.js'

interface FakeTools {
  defs: Array<{ name: string; parameters: Record<string, unknown>; output: { render: (a: unknown, v: unknown) => unknown[] }; execute(args: unknown, exec: unknown): Promise<unknown> }>
  register(def: FakeTools['defs'][number]): () => void
}

function makeTools(): FakeTools {
  const defs: FakeTools['defs'] = []
  return {
    defs,
    register(def) {
      defs.push(def)
      return () => {}
    },
  }
}

/** 全方法 fake service(记录调用;可按需覆盖返回值) */
function makeService(overrides: Record<string, (...args: unknown[]) => unknown> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const service = {
    delegate(...args: unknown[]) { calls.push({ method: 'delegate', args }); return { ok: true, delegation: { id: 'dlg-1' } } },
    status(...args: unknown[]) { calls.push({ method: 'status', args }); return { positions: [] } },
    mailSend(...args: unknown[]) { calls.push({ method: 'mailSend', args }); return { ok: true } },
    mailRecv(...args: unknown[]) { calls.push({ method: 'mailRecv', args }); return [] },
    taskCreate(...args: unknown[]) { calls.push({ method: 'taskCreate', args }); return { ok: true } },
    taskClaim(...args: unknown[]) { calls.push({ method: 'taskClaim', args }); return { ok: true } },
    taskDone(...args: unknown[]) { calls.push({ method: 'taskDone', args }); return { ok: true } },
    runReport(...args: unknown[]) { calls.push({ method: 'runReport', args }); return { entries: [] } },
    memorySave(...args: unknown[]) { calls.push({ method: 'memorySave', args }); return { ok: true } },
    memoryList(...args: unknown[]) { calls.push({ method: 'memoryList', args }); return { entries: [] } },
    doctor(...args: unknown[]) { calls.push({ method: 'doctor', args }); return { checks: [] } },
    docList(...args: unknown[]) { calls.push({ method: 'docList', args }); return { ok: true, items: [] } },
    docGet(...args: unknown[]) { calls.push({ method: 'docGet', args }); return { ok: true, doc: {} } },
    docCreate(...args: unknown[]) { calls.push({ method: 'docCreate', args }); return { ok: true, ref: {} } },
    docUpdate(...args: unknown[]) { calls.push({ method: 'docUpdate', args }); return { ok: true, ref: {} } },
    docSearch(...args: unknown[]) { calls.push({ method: 'docSearch', args }); return { ok: true, items: [] } },
    setupInit(...args: unknown[]) { calls.push({ method: 'setupInit', args }); return { ok: true } },
    bindRoute(...args: unknown[]) { calls.push({ method: 'bindRoute', args }); return { ok: true } },
    unbindRoute(...args: unknown[]) { calls.push({ method: 'unbindRoute', args }); return { ok: true } },
    replaceOccupant(...args: unknown[]) { calls.push({ method: 'replaceOccupant', args }); return { ok: true } },
    ...overrides,
  }
  return { service, calls }
}

function registerAll(service: unknown): FakeTools {
  const tools = makeTools()
  registerTeamTools({ get: (k: string) => (k === 'teamService' ? service : undefined) }, tools)
  return tools
}

function def(tools: FakeTools, name: string): FakeTools['defs'][number] {
  const d = tools.defs.find((x) => x.name === name)
  if (!d) throw new Error(`tool not registered: ${name}`)
  return d
}

const EXEC = { agent: { id: 'orgos-member-coder-1' }, signal: new AbortController().signal }

describe('registerTeamTools(跨 profile 容错)', () => {
  it('GIVEN 无 teamService 服务 WHEN 注册 THEN 全部工具静默不注册', () => {
    const tools = makeTools()
    registerTeamTools({ get: () => undefined }, tools)
    expect(tools.defs.length).toBe(0)
  })
})

describe('registerTeamTools(全工具注册与 execute 转发)', () => {
  const { service, calls } = makeService()
  const tools = registerAll(service)

  it('GIVEN core 服务存在 WHEN 注册 THEN 17 个工具全部在列', () => {
    const names = tools.defs.map((d) => d.name).sort()
    expect(names).toEqual([
      'team_delegate', 'team_doc_create', 'team_doc_list', 'team_doc_read',
      'team_doc_search', 'team_doc_update', 'team_doctor', 'team_mail_recv',
      'team_mail_send', 'team_memory_recall', 'team_memory_save', 'team_run',
      'team_setup', 'team_status', 'team_task_claim', 'team_task_complete',
      'team_task_create',
    ])
  })

  it('GIVEN 注册表 WHEN 序列化全部 parameters THEN 无 undefined 键(DSH lossless 红线)', () => {
    for (const d of tools.defs) {
      expect(JSON.stringify(d.parameters).includes('undefined'), d.name).toBe(false)
    }
  })

  it('WHEN team_delegate execute THEN 转发 brief 且剥离 target;失败分支透传', async () => {
    calls.length = 0
    await def(tools, 'team_delegate').execute(
      { target: 'coder-1', task: '写模块', requirements: ['有接口'], acceptance: ['测试通过'] },
      EXEC,
    )
    expect(calls[0]?.method).toBe('delegate')
    expect(calls[0]?.args[0]).toBe('coder-1')
    expect(calls[0]?.args[1]).toBe('coder-1')
    expect((calls[0]?.args[2] as Record<string, unknown>).target).toBeUndefined()
    expect((calls[0]?.args[2] as Record<string, unknown>).task).toBe('写模块')
    // 失败分支
    const failService = makeService({ delegate: () => ({ ok: false, reason: 'BRIEF_INVALID', errors: [{ field: 'task', message: 'x' }] }) })
    const failTools = registerAll(failService.service)
    const r = await def(failTools, 'team_delegate').execute({ target: 'x', task: 'y' }, EXEC)
    expect(r).toEqual({ ok: false, reason: 'BRIEF_INVALID', errors: [{ field: 'task', message: 'x' }] })
  })

  it('WHEN 查询类工具 execute THEN 以岗位身份转发(缺省参数回退)', async () => {
    calls.length = 0
    await def(tools, 'team_status').execute({}, EXEC)
    await def(tools, 'team_mail_recv').execute({}, EXEC)
    await def(tools, 'team_run').execute({}, EXEC)
    await def(tools, 'team_memory_recall').execute({}, EXEC)
    await def(tools, 'team_doctor').execute({}, { agent: undefined, signal: EXEC.signal })
    expect(calls.map((c) => `${c.method}:${c.args[0]}`)).toEqual([
      'status:coder-1', 'mailRecv:coder-1', 'runReport:coder-1',
      'memoryList:coder-1', 'doctor:undefined',
    ])
    expect(calls[2]?.args[1]).toBe(50) // run 默认 limit
    expect(calls[3]?.args[1]).toBe(50) // memory recall 默认 limit
  })

  it('WHEN 任务类工具 execute THEN 转发(缺省 kind=note)', async () => {
    calls.length = 0
    await def(tools, 'team_mail_send').execute({ to: 'coder-1', body: 'hi' }, EXEC)
    await def(tools, 'team_task_create').execute({ teamId: 'team-front', title: 't', assignee: 'coder-1' }, EXEC)
    await def(tools, 'team_task_claim').execute({ taskId: 'task-1' }, EXEC)
    await def(tools, 'team_task_complete').execute({ taskId: 'task-1' }, EXEC)
    await def(tools, 'team_memory_save').execute({ level: 'team', content: 'x' }, EXEC)
    expect(calls.map((c) => c.method)).toEqual(['mailSend', 'taskCreate', 'taskClaim', 'taskDone', 'memorySave'])
    expect(calls[0]?.args[2]).toBe('note') // kind 缺省
    expect(calls[4]?.args[1]).toBe('team')
    expect(calls[4]?.args[2]).toBe('contribution') // kind 缺省
  })
})

describe('registerTeamTools(TeamToolDefs 单源一致性)', () => {
  it('GIVEN defs 驱动注册 WHEN 对比注册表 THEN 15 个 defs 全部在列且 parameters 逐字一致', async () => {
    const { TEAM_TOOL_DEFS } = await import('dsh-orgos-core/dsh/teamToolDefs')
    const tools = registerAll(makeService().service)
    for (const def of TEAM_TOOL_DEFS) {
      const registered = tools.defs.find((d) => d.name === def.name)
      expect(registered, def.name).toBeDefined()
      expect(registered?.parameters).toEqual(def.parameters)
    }
    expect(TEAM_TOOL_DEFS).toHaveLength(15)
  })

  it('GIVEN 远程化名单 WHEN 导出 THEN 13 个且治理类排除(与 team-rpc 白名单同源)', async () => {
    const { REMOTE_TOOL_DEFS } = await import('dsh-orgos-core/dsh/teamToolDefs')
    expect(REMOTE_TOOL_DEFS).toHaveLength(13)
    expect(REMOTE_TOOL_DEFS.map((d: { name: string }) => d.name)).not.toContain('team_setup')
    expect(REMOTE_TOOL_DEFS.map((d: { name: string }) => d.name)).not.toContain('team_delegate')
    expect(REMOTE_TOOL_DEFS.map((d: { name: string }) => d.name)).not.toContain('team_doctor')
  })
})

describe('registerTeamTools(文档工具)', () => {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const fakeService = {
    docList(...args: unknown[]) {
      calls.push({ method: 'docList', args })
      return { ok: true, items: [] }
    },
    docGet(...args: unknown[]) {
      calls.push({ method: 'docGet', args })
      return { ok: true, doc: {} }
    },
    docCreate(...args: unknown[]) {
      calls.push({ method: 'docCreate', args })
      return { ok: true, ref: {} }
    },
    docUpdate(...args: unknown[]) {
      calls.push({ method: 'docUpdate', args })
      return { ok: true, ref: {} }
    },
    docSearch(...args: unknown[]) {
      calls.push({ method: 'docSearch', args })
      return { ok: true, items: [] }
    },
  }

  function registerAllDoc(): FakeTools {
    const tools = makeTools()
    registerTeamTools({ get: (k: string) => (k === 'teamService' ? fakeService : undefined) }, tools)
    return tools
  }

  it('GIVEN core 服务存在 WHEN 注册 THEN 五个 team_doc_* 工具在列且 parameters 无 undefined', () => {
    const tools = registerAllDoc()
    for (const name of ['team_doc_list', 'team_doc_read', 'team_doc_create', 'team_doc_update', 'team_doc_search']) {
      const d = tools.defs.find((x) => x.name === name)
      expect(d, name).toBeDefined()
      expect(JSON.stringify(d?.parameters).includes('undefined'), name).toBe(false)
    }
  })

  it('GIVEN 成员会话 WHEN 文档工具 execute THEN 以岗位身份转发(缺省参数回退)', async () => {
    calls.length = 0
    const tools = registerAllDoc()
    await def(tools, 'team_doc_list').execute({}, EXEC)
    await def(tools, 'team_doc_read').execute({ docId: 'a.md' }, EXEC)
    await def(tools, 'team_doc_create').execute({ provider: 'git-wiki', title: 't' }, EXEC)
    await def(tools, 'team_doc_update').execute({ docId: 'a.md', body: 'x', expectedVersion: 'v1' }, EXEC)
    await def(tools, 'team_doc_search').execute({ query: '周报' }, EXEC)
    expect(calls.map((c) => `${c.method}:${c.args[0]}`)).toEqual([
      'docList:coder-1', 'docGet:coder-1', 'docCreate:coder-1',
      'docUpdate:coder-1', 'docSearch:coder-1',
    ])
    expect(calls[0]?.args[2]).toBe(50) // list 默认 limit
    expect(calls[2]?.args[3]).toBe('') // create body 默认空
    expect(calls[3]?.args[3]).toEqual({ title: undefined, body: 'x' }) // patch 形状
    expect(calls[3]?.args[4]).toBe('v1') // expectedVersion 透传
    expect(calls[4]?.args[3]).toBe(20) // search 默认 limit
  })

  it('GIVEN provider 未指定 WHEN team_doc_update execute THEN 以 undefined provider 转发(服务端消歧)', async () => {
    calls.length = 0
    const tools = registerAllDoc()
    await def(tools, 'team_doc_update').execute({ docId: 'd1', title: '新标题' }, EXEC)
    expect(calls[0]?.method).toBe('docUpdate')
    expect(calls[0]?.args[1]).toBeUndefined()
  })

  it('GIVEN STALE 冲突 WHEN team_doc_update THEN 服务端结果原样透传', async () => {
    const staleService = {
      docUpdate: () => ({ ok: false, reason: '文档已被他人修改(版本冲突)', code: 'STALE_DOCUMENT', currentVersion: 'v9' }),
    }
    const tools = makeTools()
    registerTeamTools({ get: (k: string) => (k === 'teamService' ? staleService : undefined) }, tools)
    const r = await def(tools, 'team_doc_update').execute({ docId: 'a.md' }, EXEC)
    expect(r).toEqual({ ok: false, reason: '文档已被他人修改(版本冲突)', code: 'STALE_DOCUMENT', currentVersion: 'v9' })
  })
})

describe('registerTeamTools(team_setup 动作分支)', () => {
  it('WHEN init 各规模 THEN 模板选择正确', async () => {
    const { service, calls } = makeService()
    const tools = registerAll(service)
    await def(tools, 'team_setup').execute({ action: 'init' }, EXEC)
    await def(tools, 'team_setup').execute({ action: 'init', scale: 'dept' }, EXEC)
    await def(tools, 'team_setup').execute({ action: 'init', scale: 'group' }, EXEC)
    const templates = calls.filter((c) => c.method === 'setupInit').map((c) => String(c.args[0]))
    expect(templates[0]).toContain('小组模板')
    expect(templates[1]).toContain('部门模板')
    expect(templates[2]).toContain('集团模板')
  })

  it('WHEN bind/unbind 缺参 THEN 拒绝;参数齐全 THEN 转发', async () => {
    const { service, calls } = makeService()
    const tools = registerAll(service)
    const setup = def(tools, 'team_setup')
    expect(await setup.execute({ action: 'bind' }, EXEC)).toEqual({ ok: false, reason: 'bind 需要 channel/peerId/target' })
    expect(await setup.execute({ action: 'unbind' }, EXEC)).toEqual({ ok: false, reason: 'unbind 需要 channel/peerId' })
    await setup.execute({ action: 'bind', channel: 'feishu-main', peerId: 'oc_1', target: 'coder-1' }, EXEC)
    await setup.execute({ action: 'unbind', channel: 'feishu-main', peerId: 'oc_1' }, EXEC)
    expect(calls.map((c) => c.method)).toEqual(['bindRoute', 'unbindRoute'])
  })

  it('WHEN replace 分支 THEN human/agent 缺参与转发齐全', async () => {
    const { service, calls } = makeService()
    const tools = registerAll(service)
    const setup = def(tools, 'team_setup')
    expect(await setup.execute({ action: 'replace' }, EXEC)).toEqual({ ok: false, reason: 'replace 需要 target(岗位 id)' })
    expect(await setup.execute({ action: 'replace', target: 'x', newKind: 'human' }, EXEC)).toEqual({ ok: false, reason: 'replace human 需要 newImChannel/newImUserId' })
    expect(await setup.execute({ action: 'replace', target: 'x', newKind: 'agent' }, EXEC)).toEqual({ ok: false, reason: 'replace agent 需要 newPreset' })
    expect(await setup.execute({ action: 'replace', target: 'x', newKind: 'galaxy' }, EXEC)).toEqual({ ok: false, reason: 'replace 需要 newKind: agent | human' })
    await setup.execute({ action: 'replace', target: 'coder-1', newKind: 'human', newImChannel: 'feishu', newImUserId: 'ou_1' }, EXEC)
    await setup.execute({ action: 'replace', target: 'coder-1', newKind: 'agent', newPreset: 'orgos-reviewer' }, EXEC)
    expect(calls.filter((c) => c.method === 'replaceOccupant')).toHaveLength(2)
    expect(calls[0]?.args[2]).toEqual({ kind: 'human', im: { channel: 'feishu', userId: 'ou_1' } })
    expect(calls[1]?.args[2]).toEqual({ kind: 'agent', preset: 'orgos-reviewer' })
  })

  it('WHEN 未知 action THEN 拒绝', async () => {
    const tools = registerAll(makeService().service)
    const r = await def(tools, 'team_setup').execute({ action: 'hack' }, EXEC)
    expect(r).toEqual({ ok: false, reason: 'unknown_action: hack' })
  })
})

describe('registerTeamTools(记忆工具)', () => {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const fakeService = {
    memorySave(...args: unknown[]) {
      calls.push({ method: 'memorySave', args })
      return { ok: true }
    },
    memoryList(...args: unknown[]) {
      calls.push({ method: 'memoryList', args })
      return { entries: [] }
    },
  }

  function registerAllMem(): FakeTools {
    const tools = makeTools()
    registerTeamTools({ get: (k: string) => (k === 'teamService' ? fakeService : undefined) }, tools)
    return tools
  }

  it('GIVEN core 服务存在 WHEN 注册 THEN 记忆工具在列且 parameters 是已编译 JSON Schema', () => {
    const tools = registerAllMem()
    const save = tools.defs.find((d) => d.name === 'team_memory_save')
    expect(save).toBeDefined()
    const schema = save?.parameters as { type: string; properties: Record<string, unknown>; required: string[] }
    expect(schema.type).toBe('object')
    expect(schema.required).toContain('level')
    expect(schema.required).toContain('content')
    expect(JSON.stringify(schema).includes('undefined')).toBe(false)
  })

  it('GIVEN 成员会话调用 WHEN team_memory_save execute THEN 按岗位身份转发', async () => {
    calls.length = 0
    const tools = registerAllMem()
    const save = tools.defs.find((d) => d.name === 'team_memory_save')
    await save?.execute(
      { level: 'team', kind: 'handover', content: '交接内容', digest: '摘要' },
      EXEC,
    )
    expect(calls[0]?.method).toBe('memorySave')
    expect(calls[0]?.args[0]).toBe('coder-1')
    expect(calls[0]?.args[1]).toBe('team')
    expect(calls[0]?.args[2]).toBe('handover')
  })

  it('GIVEN Web 会话调用 WHEN team_memory_recall execute THEN 以 web-root 身份查询', async () => {
    calls.length = 0
    const tools = registerAllMem()
    const recall = tools.defs.find((d) => d.name === 'team_memory_recall')
    await recall?.execute({ limit: 10 }, { agent: undefined, signal: EXEC.signal })
    expect(calls[0]?.method).toBe('memoryList')
    expect(calls[0]?.args[0]).toBe('web-root')
    expect(calls[0]?.args[1]).toBe(10)
  })
})
