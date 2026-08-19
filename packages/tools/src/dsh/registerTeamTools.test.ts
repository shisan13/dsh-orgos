/**
 * registerTeamTools 注册层测试:Given-When-Then(AGENTS.md §4 闸门)
 * 断言:无 core 服务时静默不注册(跨 profile 容错)、记忆工具注册与转发、
 * parameters 为已编译 JSON Schema 且无 undefined 键(DSH lossless JSON 红线)。
 */
import { describe, expect, it } from 'vitest'
import { registerTeamTools } from './registerTeamTools.js'

interface FakeTools {
  defs: Array<{ name: string; parameters: Record<string, unknown>; execute(args: unknown, exec: unknown): Promise<unknown> }>
  register(def: { name: string; parameters: Record<string, unknown>; execute(args: unknown, exec: unknown): Promise<unknown> }): () => void
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

describe('registerTeamTools(跨 profile 容错)', () => {
  it('GIVEN 无 teamService 服务 WHEN 注册 THEN 全部工具静默不注册', () => {
    const tools = makeTools()
    registerTeamTools({ get: () => undefined }, tools)
    expect(tools.defs.length).toBe(0)
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

  function registerAll(): FakeTools {
    const tools = makeTools()
    registerTeamTools({ get: (k: string) => (k === 'teamService' ? fakeService : undefined) }, tools)
    return tools
  }

  it('GIVEN core 服务存在 WHEN 注册 THEN 记忆工具在列且 parameters 是已编译 JSON Schema', () => {
    const tools = registerAll()
    const save = tools.defs.find((d) => d.name === 'team_memory_save')
    const recall = tools.defs.find((d) => d.name === 'team_memory_recall')
    expect(save).toBeDefined()
    expect(recall).toBeDefined()
    const schema = save?.parameters as { type: string; properties: Record<string, unknown>; required: string[] }
    expect(schema.type).toBe('object')
    expect(schema.required).toContain('level')
    expect(schema.required).toContain('content')
    // DSH lossless JSON 红线:序列化不产生 undefined
    expect(JSON.stringify(schema).includes('undefined')).toBe(false)
  })

  it('GIVEN 成员会话调用 WHEN team_memory_save execute THEN 按岗位身份转发', async () => {
    calls.length = 0
    const tools = registerAll()
    const save = tools.defs.find((d) => d.name === 'team_memory_save')
    await save?.execute(
      { level: 'team', kind: 'handover', content: '交接内容', digest: '摘要' },
      { agent: { id: 'orgos-member-coder-1' }, signal: new AbortController().signal },
    )
    expect(calls[0]?.method).toBe('memorySave')
    expect(calls[0]?.args[0]).toBe('coder-1')
    expect(calls[0]?.args[1]).toBe('team')
    expect(calls[0]?.args[2]).toBe('handover')
  })

  it('GIVEN Web 会话调用 WHEN team_memory_recall execute THEN 以 web-root 身份查询', async () => {
    calls.length = 0
    const tools = registerAll()
    const recall = tools.defs.find((d) => d.name === 'team_memory_recall')
    await recall?.execute({ limit: 10 }, { agent: undefined, signal: new AbortController().signal })
    expect(calls[0]?.method).toBe('memoryList')
    expect(calls[0]?.args[0]).toBe('web-root')
    expect(calls[0]?.args[1]).toBe(10)
  })
})
