/**
 * dsh-orgos-im-slack 绑定层(bundle 行:name 'dsh-orgos-im-slack/dsh')
 * 生产 transport:官方 @slack/socket-mode + @slack/web-api(Socket Mode,无需公网)。
 * 凭据格式:botToken:appToken(冒号分隔)。
 */
export const name = 'dsh-orgos-im-slack'
export const inject = ['teamImGateway']

import { SlackAdapter, type SlackCredentials, type SlackTransport } from 'dsh-orgos-im-slack'

interface Ctx {
  teamImGateway: { registerAdapter(factory: unknown): void }
  get(key: string): unknown
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void }
}

export function apply(ctx: Ctx): void {
  ctx.teamImGateway.registerAdapter({
    provider: 'slack',
    build(channel: string, rawCredential: string, handlers: {
      onInbound(msg: unknown): void
      onConnection(state: 'connected' | 'disconnected', reason?: string): void
    }) {
      const [botToken, appToken] = rawCredential.split(':')
      if (!botToken || !appToken) throw new Error('slack 凭据格式应为 botToken:appToken')
      const credentials: SlackCredentials = { botToken, appToken }
      return new SlackAdapter({
        channel,
        credentials,
        transport: createSlackTransport(credentials),
        onInbound: handlers.onInbound,
        onConnection: handlers.onConnection,
      })
    },
  })
}

/** 生产 transport:Socket Mode WS(@slack/socket-mode,运行时动态加载) */
function createSlackTransport(credentials: SlackCredentials): SlackTransport {
  return {
    async connect(handlers) {
      const { SocketModeClient } = await import('@slack/socket-mode')
      const socket = new SocketModeClient({ appToken: credentials.appToken })
      socket.on('slack_event', (packet: { body?: { event?: { type?: string; text?: string; channel?: string; user?: string; ts?: string; bot_id?: string } } }) => {
        const e = packet.body?.event
        if (e?.type === 'message' && e.text !== undefined && e.channel !== undefined) {
          handlers.onEvent({ type: 'message', text: e.text, channel: e.channel, user: e.user, ts: e.ts, botId: e.bot_id })
        }
      })
      await socket.start()
      return {
        async disconnect() {
          await socket.disconnect()
        },
        selfId: () => undefined,
      }
    },
    async sendMessage(channelId, payload) {
      const { WebClient } = await import('@slack/web-api')
      const web = new WebClient(credentials.botToken)
      await web.chat.postMessage({ channel: channelId, text: payload.text ?? '', ...(payload.blocks ? { blocks: payload.blocks as never } : {}) })
    },
  }
}
