/**
 * dsh-orgos-im-telegram 绑定层(bundle 行:name 'dsh-orgos-im-telegram/dsh')
 *
 * 生产 transport:Bot API HTTP 客户端 + 长轮询(getUpdates),零 SDK 自实现。
 * 凭据格式:bot token(裸字符串)。
 * 代理:config.proxyUrl(http:// 或 socks5:// 前缀,如 http://127.0.0.1:7890)可选;
 * 配置后所有 Bot API 请求统一经代理(undici ProxyAgent 作为 fetch dispatcher,
 * 原生支持 http/https 与 socks5);未配置则零代理直连,行为与旧版完全一致。
 */
export const name = 'dsh-orgos-im-telegram'

// 硬依赖:网关服务由 team-im-gateway 行提供(官方模式)
export const inject = ['teamImGateway']

import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { TelegramAdapter, type TelegramCredentials, type TelegramTransport } from 'dsh-orgos-im-telegram'

/** 请求头超时与建连超时(含代理 CONNECT):undici 的 CONNECT 超时固定 10s 且
 *  只接受 fetch init 的 connect.timeout(headersTimeout 不控制它,实测验证);
 *  慢速代理节点(V2Ray 等)建连可能 >10s,统一放宽到 60s。 */
const REQUEST_HEADERS_TIMEOUT_MS = 60_000
const REQUEST_CONNECT_TIMEOUT_MS = 60_000

type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<Response>

/** undici fetch 的 init 超时选项(undici 扩展,不在 DOM RequestInit 类型内) */
interface UndiciInit extends RequestInit {
  headersTimeout?: number
  connect?: { timeout: number }
}

/** dsh 行配置:proxyUrl 为可选代理(不落盘、不进日志) */
export interface TelegramDshConfig {
  /** 代理 URL,http:// 或 socks5:// 前缀;不配置则直连 Telegram Bot API */
  proxyUrl?: string
}

interface Ctx {
  teamImGateway: { registerAdapter(factory: unknown): void }
  get(key: string): unknown
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void }
}

export function apply(ctx: Ctx, config: TelegramDshConfig = {}): void {
  const { proxyUrl } = config
  ctx.teamImGateway.registerAdapter({
    provider: 'telegram',
    build(channel: string, rawCredential: string, handlers: {
      onInbound(msg: unknown): void
      onConnection(state: 'connected' | 'disconnected', reason?: string): void
    }) {
      const token = rawCredential.trim()
      if (!token) throw new Error('telegram 凭据应为 bot token')
      const credentials: TelegramCredentials = { token }
      return new TelegramAdapter({
        channel,
        credentials,
        transport: createTelegramTransport(token, proxyUrl),
        onInbound: handlers.onInbound,
        onConnection: handlers.onConnection,
      })
    },
  })
}

/** 代理 dispatcher:undici ProxyAgent(http/https 与 socks5 原生支持) */
function createProxyDispatcher(proxyUrl: string): RequestInit['dispatcher'] {
  // 类型桥接:undici npm 包类型与 @types/node 内置的 undici-types 是两份类型副本
  // (compose 签名略有差异);运行时同为 undici Dispatcher(dispatch(opts, handler)),
  // fetch 按 duck-typing 调用,两者完全兼容,此处仅做边界断言。
  return new ProxyAgent(proxyUrl) as unknown as RequestInit['dispatcher']
}

/** 生产 transport:官方 Bot API(HTTP + 长轮询),失败由 adapter 退避重连。
 *  fetchImpl 默认 undici 自带 fetch(放宽建连超时,兼容慢代理);测试注入 fake。 */
export function createTelegramTransport(
  token: string,
  proxyUrl?: string,
  fetchImpl: FetchLike = undiciFetch as unknown as FetchLike,
): TelegramTransport {
  const api = `https://api.telegram.org/bot${token}`
  // 未配置 proxyUrl 时 dispatcher 为 undefined(零代理直连,仅多放宽超时,行为语义不变)。
  const dispatcher = proxyUrl ? createProxyDispatcher(proxyUrl) : undefined
  const request = (url: string, init?: UndiciInit): Promise<Response> =>
    fetchImpl(url, {
      ...init,
      ...(dispatcher !== undefined ? { dispatcher } : {}),
      headersTimeout: REQUEST_HEADERS_TIMEOUT_MS,
      connect: { timeout: REQUEST_CONNECT_TIMEOUT_MS },
    })
  return {
    async getUpdates(params) {
      const url = `${api}/getUpdates?offset=${params.offset}&timeout=${params.timeout}`
      const res = await request(url)
      const data = (await res.json()) as { ok: boolean; result?: unknown[]; description?: string }
      if (!data.ok) throw new Error(`telegram getUpdates: ${data.description ?? res.status}`)
      return { updates: data.result ?? [] }
    },
    async sendMessage(chatId, payload) {
      const res = await request(`${api}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: payload.text,
          ...(payload.replyMarkup !== undefined ? { reply_markup: payload.replyMarkup } : {}),
        }),
      })
      const data = (await res.json()) as { ok: boolean; description?: string }
      if (!data.ok) throw new Error(`telegram sendMessage: ${data.description ?? res.status}`)
    },
    async answerCallbackQuery(callbackQueryId) {
      await request(`${api}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId }),
      })
    },
  }
}
