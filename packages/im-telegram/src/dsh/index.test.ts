/**
 * im-telegram dsh 绑定层测试:apply 装配 + createTelegramTransport(fake 全局 fetch 捕获)
 *
 * 覆盖:build 后长轮询 URL 形状(token/offset/timeout)、代理 dispatcher 注入与零代理、
 * 凭据校验、出站请求形状(getUpdates/sendMessage/answerCallbackQuery)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProxyAgent } from 'undici'
import { apply, createTelegramTransport } from './index.ts'

/** fake 全局 fetch:记录 (input, init),固定返回 Telegram ok 响应;hangAfter 指定前 N 次后挂起(防长轮询空转) */
interface FetchCall {
  input: string
  init?: RequestInit
}

function installFakeFetch(opts?: { hangAfter?: number }): { calls: FetchCall[] } {
  const calls: FetchCall[] = []
  let count = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input: String(input), init })
    count += 1
    if (opts?.hangAfter !== undefined && count > opts.hangAfter) {
      return new Promise<Response>(() => {}) // 挂起:模拟长轮询阻塞,避免 pollLoop 微任务饿死事件循环
    }
    return new Response(JSON.stringify({ ok: true, result: [] }))
  }))
  return { calls }
}

afterEach(() => vi.unstubAllGlobals())

/** 触发若干轮事件循环(pollLoop 的异步迭代) */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}

interface BuiltAdapter {
  start(): Promise<void>
  stop(): Promise<void>
}

interface FactoryLike {
  build(channel: string, rawCredential: string, handlers: unknown): BuiltAdapter
}

/** 捕获 apply 注册的 factory;proxyUrl 省略时以无参 apply(默认 config)装配 */
function captureFactory(proxyUrl?: string): FactoryLike {
  let factory: FactoryLike | undefined
  const ctx = {
    teamImGateway: {
      registerAdapter: (f: unknown) => {
        factory = f as FactoryLike
      },
    },
    get: () => undefined,
    logger: { info() {}, warn() {} },
  }
  if (proxyUrl === undefined) apply(ctx)
  else apply(ctx, { proxyUrl })
  if (!factory) throw new Error('factory 未注册')
  return factory
}

const TOKEN = '123456:TEST_TOKEN' // 占位符,非真实凭据
const handlers = { onInbound() {}, onConnection() {} }

describe('Given im-telegram dsh apply 装配', () => {
  it('When build 后启动长轮询 Then getUpdates 请求路径含 token 与 offset/timeout', async () => {
    const { calls } = installFakeFetch({ hangAfter: 1 })
    const adapter = captureFactory().build('telegram', TOKEN, handlers)
    await adapter.start()
    await flush()
    const up = calls.find((c) => c.input.includes('/getUpdates'))
    expect(up).toBeTruthy()
    const url = new URL(up!.input)
    expect(url.pathname).toBe(`/bot${TOKEN}/getUpdates`)
    expect(url.searchParams.get('offset')).toBe('0')
    expect(url.searchParams.get('timeout')).toBe('30')
    expect(up!.init?.dispatcher).toBeUndefined()
    await adapter.stop()
  })

  it('When token 为空白 Then build 抛错(凭据应为 bot token)', () => {
    expect(() => captureFactory().build('telegram', '   ', handlers)).toThrow(/bot token/)
  })
})

describe('Given createTelegramTransport 代理注入', () => {
  it('When 未配置 proxyUrl Then 零代理:所有请求 init.dispatcher 为 undefined', async () => {
    const { calls } = installFakeFetch()
    const transport = createTelegramTransport(TOKEN)
    await transport.getUpdates({ offset: 0, timeout: 30 })
    await transport.sendMessage('111', { text: 'hi' })
    await transport.answerCallbackQuery('cq_1')
    expect(calls).toHaveLength(3)
    for (const c of calls) expect(c.init?.dispatcher).toBeUndefined()
  })

  it('When 配置 http proxyUrl Then 所有请求统一注入 dispatcher(非 undefined)', async () => {
    const { calls } = installFakeFetch()
    const transport = createTelegramTransport(TOKEN, 'http://127.0.0.1:7890')
    await transport.getUpdates({ offset: 1, timeout: 30 })
    await transport.sendMessage('111', { text: 'hi' })
    await transport.answerCallbackQuery('cq_1')
    expect(calls).toHaveLength(3)
    for (const c of calls) expect(c.init?.dispatcher).toBeDefined()
  })

  it('When 配置 socks5 proxyUrl Then dispatcher 为 undici ProxyAgent', async () => {
    const { calls } = installFakeFetch()
    const transport = createTelegramTransport(TOKEN, 'socks5://127.0.0.1:7891')
    await transport.getUpdates({ offset: 0, timeout: 30 })
    expect(calls[0]!.init?.dispatcher).toBeInstanceOf(ProxyAgent)
  })
})

describe('Given createTelegramTransport 出站请求形状', () => {
  it('When sendMessage Then POST /sendMessage 且 body 含 chat_id/text/reply_markup', async () => {
    const { calls } = installFakeFetch()
    const transport = createTelegramTransport(TOKEN)
    await transport.sendMessage('111', { text: '你好', replyMarkup: { inline_keyboard: [] } })
    const call = calls[0]!
    expect(call.input).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`)
    expect(call.init?.method).toBe('POST')
    expect(call.init?.headers?.['Content-Type']).toBe('application/json')
    const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>
    expect(body.chat_id).toBe('111')
    expect(body.text).toBe('你好')
    expect(body.reply_markup).toEqual({ inline_keyboard: [] })
  })

  it('When sendMessage 无 replyMarkup Then body 不含 reply_markup', async () => {
    const { calls } = installFakeFetch()
    const transport = createTelegramTransport(TOKEN)
    await transport.sendMessage('111', { text: 'hi' })
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>
    expect(body).not.toHaveProperty('reply_markup')
  })

  it('When answerCallbackQuery Then POST /answerCallbackQuery 且 body 含 callback_query_id', async () => {
    const { calls } = installFakeFetch()
    const transport = createTelegramTransport(TOKEN)
    await transport.answerCallbackQuery('cq_1')
    const call = calls[0]!
    expect(call.input).toBe(`https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`)
    expect(call.init?.method).toBe('POST')
    const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>
    expect(body.callback_query_id).toBe('cq_1')
  })

  it('When Bot API 返回 ok=false Then getUpdates/sendMessage 抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, description: 'unauthorized' }))))
    const transport = createTelegramTransport(TOKEN)
    await expect(transport.getUpdates({ offset: 0, timeout: 30 })).rejects.toThrow('telegram getUpdates: unauthorized')
    await expect(transport.sendMessage('111', { text: 'hi' })).rejects.toThrow('telegram sendMessage: unauthorized')
  })

  it('When Bot API 返回 ok=false 且无 description Then 错误含 HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false }))))
    const transport = createTelegramTransport(TOKEN)
    await expect(transport.getUpdates({ offset: 0, timeout: 30 })).rejects.toThrow('telegram getUpdates: 200')
    await expect(transport.sendMessage('111', { text: 'hi' })).rejects.toThrow('telegram sendMessage: 200')
  })

  it('When Bot API 返回 ok 但无 result Then updates 为 []', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }))))
    const transport = createTelegramTransport(TOKEN)
    await expect(transport.getUpdates({ offset: 0, timeout: 30 })).resolves.toEqual({ updates: [] })
  })
})
