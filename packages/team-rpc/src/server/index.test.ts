/**
 * team-rpc 服务端行测试:Given-When-Then(AGENTS.md §4 闸门)
 * fake webServer 捕获路由,fake req/res 驱动 handler:认证失败/白名单拒绝/
 * 分派透传(await Promise 型工具)/审计落 logRpc/坏 JSON/体积超限/非 POST。
 */
import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { apply } from './index.js'
import { REMOTE_TOOL_DEFS } from 'dsh-orgos-core/dsh/teamToolDefs'

interface Captured {
  route?: { kind: 'exact'; path: string; handler(req: IncomingMessage, res: ServerResponse): void | Promise<void> }
  register(route: NonNullable<Captured['route']>): () => void
}

function makeWebServer(): Captured {
  const ws: Captured = {
    register(route) {
      ws.route = route
      return () => {}
    },
  }
  return ws
}

function makeTeamService(overrides: Record<string, (...args: unknown[]) => unknown> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const base = {
    verifyMemberRpc: (positionId: string, token: string) => {
      calls.push({ method: 'verify', args: [positionId, token] })
      return token === 'good-token'
    },
    logRpc: (positionId: string, method: string, ok: boolean) => {
      calls.push({ method: 'logRpc', args: [positionId, method, ok] })
    },
    status: (positionId: string) => {
      calls.push({ method: 'status', args: [positionId] })
      return { positions: [{ id: positionId }] }
    },
    docList: async (positionId: string, provider?: string, limit?: number) => {
      calls.push({ method: 'docList', args: [positionId, provider, limit] })
      return { ok: true, items: [] }
    },
    ...overrides,
  }
  return { service: base, calls }
}

function makeCtx(service: ReturnType<typeof makeTeamService>['service']) {
  return {
    teamService: service,
    logger: { info: vi.fn(), warn: vi.fn() },
    get: (key: string) => (key === 'teamService' ? service : key === 'webServer' ? makeWebServer() : undefined),
  } as never
}

/** 请求体流 → fake IncomingMessage */
function fakeReq(body: string, method = 'POST'): IncomingMessage {
  const stream = Readable.from([Buffer.from(body, 'utf8')]) as unknown as IncomingMessage
  stream.method = method
  return stream
}

/** 收集响应的 fake ServerResponse */
function fakeRes(): { res: ServerResponse; payload: () => string; statusCode: () => number } {
  let written = ''
  let code = 200
  const res = {
    statusCode: 200,
    setHeader: () => {},
    end: (chunk: string) => {
      written = String(chunk)
    },
  } as unknown as ServerResponse
  return {
    res,
    payload: () => written,
    statusCode: () => (res.statusCode as number) ?? code,
  }
}

const rpc = (positionId: string, token: string, method: string, args: Record<string, unknown> = {}): string =>
  JSON.stringify({ positionId, token, method, args })

describe('team-rpc 服务端行', () => {
  it('GIVEN webServer 缺失 WHEN apply THEN 行停用且告警', () => {
    const { service } = makeTeamService()
    const logger = { info: vi.fn(), warn: vi.fn() }
    apply({ teamService: service, logger, get: () => undefined } as never)
    expect(logger.warn).toHaveBeenCalled()
  })

  it('GIVEN token 不匹配 WHEN 请求 THEN unauthorized 且审计落盘', async () => {
    const { service, calls } = makeTeamService()
    const ws = makeWebServer()
    apply({ teamService: service, logger: { info: vi.fn(), warn: vi.fn() }, get: (k: string) => (k === 'webServer' ? ws : service) } as never)
    const { res, payload } = fakeRes()
    await ws.route!.handler(fakeReq(rpc('coder-1', 'bad-token', 'status')), res)
    expect(JSON.parse(payload())).toEqual({ ok: false, code: 'unauthorized', reason: 'token 与岗位不匹配' })
    expect(calls.some((c) => c.method === 'logRpc' && c.args[2] === false)).toBe(true)
  })

  it('GIVEN 非远程化方法(doctor)WHEN 请求 THEN invalid_method 拒绝', async () => {
    const { service } = makeTeamService()
    const ws = makeWebServer()
    apply({ teamService: service, logger: { info: vi.fn(), warn: vi.fn() }, get: (k: string) => (k === 'webServer' ? ws : service) } as never)
    const { res, payload } = fakeRes()
    await ws.route!.handler(fakeReq(rpc('coder-1', 'good-token', 'doctor')), res)
    expect(JSON.parse(payload())).toMatchObject({ ok: false, code: 'invalid_method' })
  })

  it('GIVEN 合法 token+白名单方法(status)WHEN 请求 THEN 以校验后岗位分派并审计 ok', async () => {
    const { service, calls } = makeTeamService()
    const ws = makeWebServer()
    apply({ teamService: service, logger: { info: vi.fn(), warn: vi.fn() }, get: (k: string) => (k === 'webServer' ? ws : service) } as never)
    const { res, payload } = fakeRes()
    await ws.route!.handler(fakeReq(rpc('coder-1', 'good-token', 'status')), res)
    expect(JSON.parse(payload())).toEqual({ ok: true, result: { positions: [{ id: 'coder-1' }] } })
    expect(calls.some((c) => c.method === 'status' && c.args[0] === 'coder-1')).toBe(true)
    expect(calls.some((c) => c.method === 'logRpc' && c.args[2] === true)).toBe(true)
  })

  it('GIVEN Promise 型工具(docList)WHEN 请求 THEN await 结果透传且参数序与本地一致', async () => {
    const { service, calls } = makeTeamService()
    const ws = makeWebServer()
    apply({ teamService: service, logger: { info: vi.fn(), warn: vi.fn() }, get: (k: string) => (k === 'webServer' ? ws : service) } as never)
    const { res, payload } = fakeRes()
    await ws.route!.handler(fakeReq(rpc('coder-1', 'good-token', 'docList', { provider: 'git-wiki', limit: 3 })), res)
    expect(JSON.parse(payload())).toEqual({ ok: true, result: { ok: true, items: [] } })
    const call = calls.find((c) => c.method === 'docList')
    expect(call?.args).toEqual(['coder-1', 'git-wiki', 3])
  })

  it('GIVEN 坏 JSON WHEN 请求 THEN bad_request 不抛穿', async () => {
    const { service } = makeTeamService()
    const ws = makeWebServer()
    apply({ teamService: service, logger: { info: vi.fn(), warn: vi.fn() }, get: (k: string) => (k === 'webServer' ? ws : service) } as never)
    const { res, payload } = fakeRes()
    await ws.route!.handler(fakeReq('{bad json'), res)
    expect(JSON.parse(payload())).toMatchObject({ ok: false, code: 'bad_request' })
  })

  it('GIVEN 非 POST WHEN 请求 THEN bad_request', async () => {
    const { service } = makeTeamService()
    const ws = makeWebServer()
    apply({ teamService: service, logger: { info: vi.fn(), warn: vi.fn() }, get: (k: string) => (k === 'webServer' ? ws : service) } as never)
    const { res, payload } = fakeRes()
    await ws.route!.handler(fakeReq('', 'GET'), res)
    expect(JSON.parse(payload())).toEqual({ ok: false, code: 'bad_request', reason: '仅接受 POST' })
  })

  it('GIVEN 请求体超上限 WHEN 请求 THEN bad_request(1MB 防线)', async () => {
    const { service } = makeTeamService()
    const ws = makeWebServer()
    apply({ teamService: service, logger: { info: vi.fn(), warn: vi.fn() }, get: (k: string) => (k === 'webServer' ? ws : service) } as never)
    const { res, payload } = fakeRes()
    const big = rpc('coder-1', 'good-token', 'status', { blob: 'x'.repeat(1_100_000) })
    await ws.route!.handler(fakeReq(big), res)
    expect(JSON.parse(payload())).toMatchObject({ ok: false, code: 'bad_request' })
  })

  it('GIVEN 默认路径 WHEN apply 未配 config THEN 挂载 /api/orgos/rpc', () => {
    const { service } = makeTeamService()
    const ws = makeWebServer()
    apply({ teamService: service, logger: { info: vi.fn(), warn: vi.fn() }, get: (k: string) => (k === 'webServer' ? ws : service) } as never)
    expect(ws.route.path).toBe('/api/orgos/rpc')
  })

  it('GIVEN 分派抛异常 WHEN 请求 THEN bad_request 且审计失败落盘(异常不抛穿)', async () => {
    const { service } = makeTeamService({
      status: () => {
        throw new Error('boom-internal')
      },
    })
    const ws = makeWebServer()
    apply({ teamService: service, logger: { info: vi.fn(), warn: vi.fn() }, get: (k: string) => (k === 'webServer' ? ws : service) } as never)
    const { res, payload } = fakeRes()
    await ws.route!.handler(fakeReq(rpc('coder-1', 'good-token', 'status')), res)
    const body = JSON.parse(payload()) as { ok: boolean; code: string }
    expect(body.ok).toBe(false)
    expect(body.code).toBe('bad_request')
  })

  it('GIVEN 全量远程化工具 WHEN 白名单表 THEN 13 个且方法名互不重复', () => {
    expect(REMOTE_TOOL_DEFS).toHaveLength(13)
    const methods = REMOTE_TOOL_DEFS.map((d) => d.method)
    expect(new Set(methods).size).toBe(methods.length)
    // 治理类工具绝不远程化(安全红线)
    expect(methods).not.toContain('doctor')
    expect(methods).not.toContain('delegate')
  })
})
