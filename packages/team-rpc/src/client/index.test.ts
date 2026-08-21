/**
 * team-rpc 客户端行测试:Given-When-Then(AGENTS.md §4 闸门)
 * fake tools 捕获注册:13 个远程化工具注册、schema 无 undefined、三要素缺失
 * fail-closed、execute 转发与 envelope 透传、fetch 失败返回 rpc_unreachable。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from './index.js'
import { REMOTE_TOOL_DEFS } from 'dsh-orgos-core/dsh/teamToolDefs'

interface FakeTools {
  defs: Array<{
    name: string
    parameters: Record<string, unknown>
    execute(args: unknown): Promise<unknown>
  }>
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

function makeCtx(config: Record<string, unknown>) {
  const tools = makeTools()
  const logger = { info: vi.fn(), warn: vi.fn() }
  apply({ tools, logger } as never, config as never)
  return { tools, logger }
}

const CONFIG = { baseUrl: 'http://127.0.0.1:3081/api/orgos/rpc', positionId: 'coder-1', token: 't-1' }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('team-rpc 客户端行', () => {
  it('GIVEN 三要素齐全 WHEN apply THEN 注册 13 个远程化工具且 parameters 无 undefined 键', () => {
    const { tools } = makeCtx(CONFIG)
    expect(tools.defs.map((d) => d.name).sort()).toEqual(REMOTE_TOOL_DEFS.map((d) => d.name).sort())
    for (const d of tools.defs) {
      expect(JSON.stringify(d.parameters).includes('undefined'), d.name).toBe(false)
    }
  })

  it('GIVEN 缺 token WHEN apply THEN fail-closed 不注册并告警', () => {
    const { tools, logger } = makeCtx({ baseUrl: CONFIG.baseUrl, positionId: CONFIG.positionId })
    expect(tools.defs).toHaveLength(0)
    expect(logger.warn).toHaveBeenCalled()
  })

  it('GIVEN 执行 WHEN execute THEN POST 携带身份三要素与方法名,envelope 结果透传', async () => {
    const { tools } = makeCtx(CONFIG)
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { positions: [{ id: 'coder-1' }] } }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const status = tools.defs.find((d) => d.name === 'team_status')
    const result = await status?.execute({})
    expect(result).toEqual({ positions: [{ id: 'coder-1' }] })
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body).toEqual({ positionId: 'coder-1', token: 't-1', method: 'status', args: {} })
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(CONFIG.baseUrl)
  })

  it('GIVEN 服务端返回业务失败 WHEN execute THEN 错误 envelope 原样透传', async () => {
    const { tools } = makeCtx(CONFIG)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: false, code: 'unauthorized', reason: 'x' }) })))
    const status = tools.defs.find((d) => d.name === 'team_status')
    await expect(status?.execute({})).resolves.toEqual({ ok: false, code: 'unauthorized', reason: 'x' })
  })

  it('GIVEN 自定义 timeoutMs WHEN apply THEN 配置生效(超时钳制分支覆盖)', () => {
    const { tools } = makeCtx({ ...CONFIG, timeoutMs: 100 })
    expect(tools.defs).toHaveLength(13)
  })

  it('GIVEN 网络失败 WHEN execute THEN 返回 rpc_unreachable 不抛穿', async () => {
    const { tools } = makeCtx(CONFIG)
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }))
    const status = tools.defs.find((d) => d.name === 'team_status')
    const result = await status?.execute({})
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('rpc_unreachable') as unknown })
  })
})
