/**
 * im-feishu 绑定层测试(生产 transport 构建/凭据校验/租户 token/bot open_id/历史补偿拉取;
 * 网络面用 fetch stub,不真连飞书)
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, fetchBotOpenId, fetchTenantToken } from './index.ts'
import type { FeishuAdapter, FeishuTransport } from '../FeishuAdapter.ts'

// 虚拟 SDK 模块(connect 链路测试;不真连飞书)
const wsStartMock = vi.fn()
const wsCloseMock = vi.fn()
vi.mock('@larksuiteoapi/node-sdk', () => ({
  WSClient: class {
    start = wsStartMock
    close = wsCloseMock
  },
  EventDispatcher: class {
    register(map: Record<string, (data: unknown) => void>) {
      globalThis.__larkRegistered = map
      return this
    }
  },
  Client: class {
    im = { v1: { message: { create: vi.fn(async () => ({})) } } }
  },
}))
declare global {
  // eslint-disable-next-line no-var
  var __larkRegistered: Record<string, (data: unknown) => void>
}

interface FakeGateway {
  factories: Array<{ provider: string; build(...args: unknown[]): unknown }>
  registerAdapter(factory: unknown): void
}

function makeGateway(): FakeGateway {
  const factories: FakeGateway['factories'] = []
  return {
    factories,
    registerAdapter(factory) {
      this.factories.push(factory as never)
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Given 适配器注册 apply', () => {
  it('When 凭据格式错误 Then build 抛错(fail-closed)', () => {
    const gateway = makeGateway()
    apply({ teamImGateway: gateway as never, get: () => undefined, logger: { info: () => {}, warn: () => {} } } as never)
    const factory = gateway.factories[0]!
    expect(factory.provider).toBe('feishu')
    expect(() => factory.build('feishu-main', 'onlyappid', { onInbound: () => {}, onConnection: () => {} })).toThrow(/appId:appSecret/)
  })

  it('When 凭据正确 Then 返回 FeishuAdapter 且通道名透传', () => {
    const gateway = makeGateway()
    apply({ teamImGateway: gateway as never, get: () => undefined, logger: { info: () => {}, warn: () => {} } } as never)
    const factory = gateway.factories[0]!
    const adapter = factory.build('feishu-main', 'cli_app:cli_secret', {
      onInbound: () => {},
      onConnection: () => {},
    }) as FeishuAdapter
    expect(adapter).toBeDefined()
    expect(adapter.channel).toBe('feishu-main')
    expect(adapter.isStarted()).toBe(false)
  })
})

describe('Given 生产 transport 构建(createLarkTransport 经 build 获取)', () => {
  function transportOf(): FeishuTransport {
    const gateway = makeGateway()
    apply({ teamImGateway: gateway as never, get: () => undefined, logger: { info: () => {}, warn: () => {} } } as never)
    const adapter = gateway.factories[0]!.build('feishu-main', 'a:b', { onInbound: () => {}, onConnection: () => {} }) as unknown as {
      opts: { transport: FeishuTransport }
    }
    return adapter.opts.transport
  }

  it('When fetchRecentMessages 成功 Then 重组为 WS 事件 event 形状', async () => {
    const t = transportOf()
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.includes('tenant_access_token')) {
        return new Response(JSON.stringify({ tenant_access_token: 't-recent' }), { status: 200 })
      }
      return new Response(JSON.stringify({
        code: 0,
        data: { items: [{ message_id: 'om_1', chat_id: 'oc_1', chat_type: 'group', sender: { id: { open_id: 'ou_1' } } }] },
      }), { status: 200 })
    }))
    const items = await t.fetchRecentMessages?.('oc_1', 1720000000000, 50)
    expect(items).toHaveLength(1)
    expect(items?.[0]).toEqual({ sender: { sender_id: { open_id: 'ou_1' }, sender_type: undefined }, message: expect.objectContaining({ message_id: 'om_1' }) })
  })

  it('When fetchRecentMessages 失败 Then 抛错', async () => {
    const t = transportOf()
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.includes('tenant_access_token')) {
        return new Response(JSON.stringify({ tenant_access_token: 't-fail' }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 99991, msg: 'permission denied' }), { status: 400 })
    }))
    await expect(t.fetchRecentMessages?.('oc_1', 0, 10)).rejects.toThrow(/拉取历史消息失败/)
  })
})

describe('Given 租户 token 与 bot open_id(降级不阻塞)', () => {
  it('When tenant_token 成功 Then 返回 token;失败则抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ tenant_access_token: 't-1' }), { status: 200 })))
    expect(await fetchTenantToken({ appId: 'a', appSecret: 's' })).toBe('t-1')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })))
    await expect(fetchTenantToken({ appId: 'a', appSecret: 's' })).rejects.toThrow(/tenant_access_token/)
  })

  it('When bot info 获取失败 THEN 返回 undefined 不阻塞', async () => {
    // token 成功、bot info 失败 → undefined
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 500 })))
    expect(await fetchBotOpenId({ appId: 'a', appSecret: 's' })).toBeUndefined()
    // 整个链路抛异常(网络炸) → catch → undefined
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    expect(await fetchBotOpenId({ appId: 'a', appSecret: 's' })).toBeUndefined()
  })

  it('When bot info 成功 Then 返回 open_id', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const url = String(_url)
      if (url.includes('tenant_access_token')) {
        return new Response(JSON.stringify({ tenant_access_token: 't-2' }), { status: 200 })
      }
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer t-2')
      return new Response(JSON.stringify({ bot: { open_id: 'ou_bot' } }), { status: 200 })
    }))
    expect(await fetchBotOpenId({ appId: 'a', appSecret: 's' })).toBe('ou_bot')
  })
})

describe('Given 生产 transport connect 链路(虚拟 SDK,不真连)', () => {
  it('When connect THEN 注册两类事件、start 启动、事件回调重组信封、disconnect 关闭', async () => {
    wsStartMock.mockClear()
    wsCloseMock.mockClear()
    // token 提供 bot open_id
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.includes('tenant_access_token')) {
        return new Response(JSON.stringify({ tenant_access_token: 't-c' }), { status: 200 })
      }
      return new Response(JSON.stringify({ bot: { open_id: 'ou_bot_9' } }), { status: 200 })
    }))
    const { createLarkTransport } = await import('./index.ts')
    const events: unknown[] = []
    const t = createLarkTransport({ appId: 'a', appSecret: 's' })
    const handle = await t.connect({ onEvent: (p) => events.push(p), onError: () => {}, onClose: () => {} })
    expect(wsStartMock).toHaveBeenCalled()
    expect(handle.selfOpenId()).toBe('ou_bot_9')
    // 消息事件 → 信封重组
    globalThis.__larkRegistered['im.message.receive_v1']?.({ message_id: 'om_x', chat_id: 'oc_x', event_type: 'im.message.receive_v1' })
    expect(events).toHaveLength(1)
    expect((events[0] as { header: { event_type: string } }).header.event_type).toBe('im.message.receive_v1')
    // 卡片事件 → 信封重组
    globalThis.__larkRegistered['card.action.trigger']?.({ action: { value: 'v1' } })
    expect(events).toHaveLength(2)
    expect((events[1] as { header: { event_type: string } }).header.event_type).toBe('card.action.trigger')
    await handle.disconnect()
    expect(wsCloseMock).toHaveBeenCalled()
  })
})
