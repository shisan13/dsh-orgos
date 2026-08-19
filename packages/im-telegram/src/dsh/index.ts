/**
 * dsh-orgos-im-telegram 绑定层(bundle 行:name 'dsh-orgos-im-telegram/dsh')
 *
 * 生产 transport:Bot API HTTP 客户端 + 长轮询(getUpdates),零 SDK 自实现。
 * 凭据格式:bot token(裸字符串)。
 */
export const name = 'dsh-orgos-im-telegram'

// 硬依赖:网关服务由 team-im-gateway 行提供(官方模式)
export const inject = ['teamImGateway']

import { TelegramAdapter, type TelegramCredentials, type TelegramTransport } from 'dsh-orgos-im-telegram'

interface Ctx {
  teamImGateway: { registerAdapter(factory: unknown): void }
  get(key: string): unknown
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void }
}

export function apply(ctx: Ctx): void {
  ctx.teamImGateway.registerAdapter({
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
        transport: createTelegramTransport(token),
        onInbound: handlers.onInbound,
        onConnection: handlers.onConnection,
      })
    },
  })
}

/** 生产 transport:官方 Bot API(HTTP + 长轮询),失败由 adapter 退避重连 */
function createTelegramTransport(token: string): TelegramTransport {
  const api = `https://api.telegram.org/bot${token}`
  return {
    async getUpdates(params) {
      const res = await fetch(`${api}/getUpdates?offset=${params.offset}&timeout=${params.timeout}`)
      const data = (await res.json()) as { ok: boolean; result?: unknown[]; description?: string }
      if (!data.ok) throw new Error(`telegram getUpdates: ${data.description ?? res.status}`)
      return { updates: data.result ?? [] }
    },
    async sendMessage(chatId, payload) {
      const res = await fetch(`${api}/sendMessage`, {
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
      await fetch(`${api}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId }),
      })
    },
  }
}
