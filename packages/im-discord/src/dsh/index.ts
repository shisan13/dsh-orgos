/**
 * dsh-orgos-im-discord 绑定层(bundle 行:name 'dsh-orgos-im-discord/dsh')
 * 生产 transport:官方 @discordjs/ws(Gateway)+ @discordjs/rest(发送)。
 * 凭据格式:bot token(裸字符串)。
 */
export const name = 'dsh-orgos-im-discord'
export const inject = ['teamImGateway']

import { DiscordAdapter, type DiscordCredentials, type DiscordTransport } from 'dsh-orgos-im-discord'

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
      const botToken = rawCredential.trim()
      if (!botToken) throw new Error('discord 凭据应为 bot token')
      const credentials: DiscordCredentials = { botToken }
      return new DiscordAdapter({
        channel,
        credentials,
        transport: createDiscordTransport(credentials),
        onInbound: handlers.onInbound,
        onConnection: handlers.onConnection,
      })
    },
  })
}

/** 生产 transport:@discordjs/ws Gateway(运行时动态加载) */
function createDiscordTransport(credentials: DiscordCredentials): DiscordTransport {
  return {
    async connect(handlers) {
      const { WebSocketManager, WebSocketShardEvents } = await import('@discordjs/ws')
      const { REST } = await import('@discordjs/rest')
      const rest = new REST({ version: '10' }).setToken(credentials.botToken)
      const manager = new WebSocketManager({ token: credentials.botToken, intents: (1 << 9) | (1 << 0), rest })
      manager.on(WebSocketShardEvents.Dispatch, (payload) => {
        const d = (payload as { data?: unknown }).data as { type?: string; content?: string; channel_id?: string; author?: { id: string; bot?: boolean }; id?: string }
        if (d.type === 'MESSAGE_CREATE' && d.content !== undefined && d.channel_id !== undefined) {
          handlers.onEvent({ type: 'MESSAGE_CREATE', content: d.content, channelId: d.channel_id, authorId: d.author?.id, bot: d.author?.bot, id: d.id })
        }
      })
      await manager.connect()
      return {
        async disconnect() {
          manager.destroy()
        },
        selfId: () => undefined,
      }
    },
    async sendMessage(channelId, payload) {
      const { REST } = await import('@discordjs/rest')
      const { Routes } = await import('discord-api-types/v10')
      const rest = new REST({ version: '10' }).setToken(credentials.botToken)
      await rest.post(Routes.channelMessages(channelId), {
        body: { content: payload.content ?? '', ...(payload.embeds ? { embeds: payload.embeds } : {}), ...(payload.components ? { components: payload.components } : {}) },
      })
    },
  }
}
