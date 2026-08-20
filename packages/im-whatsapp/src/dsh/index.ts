/**
 * dsh-orgos-im-whatsapp 绑定层(bundle 行:name 'dsh-orgos-im-whatsapp/dsh')
 * 凭据格式(JSON 字符串):{"phoneNumberId":"...","accessToken":"...","appSecret":"..."}
 * 入站:Business API webhook(POST,需公网 URL;X-Hub-Signature 验签由包内 verify 提供)。
 * 生产 transport 实装 TODO(webhook 路由接入 + Cloud API send)。
 */
export const name = 'dsh-orgos-im-whatsapp'
export const inject = ['teamImGateway']

import { WhatsappAdapter, type WhatsappCredentials, type WhatsappSendTransport } from 'dsh-orgos-im-whatsapp'

interface Ctx {
  teamImGateway: { registerAdapter(factory: unknown): void }
  get(key: string): unknown
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void }
}

export function apply(ctx: Ctx): void {
  ctx.teamImGateway.registerAdapter({
    provider: 'whatsapp',
    build(channel: string, rawCredential: string, handlers: {
      onInbound(msg: unknown): void
      onConnection(state: 'connected' | 'disconnected', reason?: string): void
    }) {
      const credentials = JSON.parse(rawCredential) as WhatsappCredentials
      if (!credentials.phoneNumberId || !credentials.accessToken) throw new Error('whatsapp 凭据 JSON 需含 phoneNumberId/accessToken/appSecret')
      return new WhatsappAdapter({
        channel,
        credentials,
        transport: createWhatsappTransport(credentials),
        onInbound: handlers.onInbound,
        onConnection: handlers.onConnection,
      })
    },
  })
}

/** 生产 transport 占位(TODO:Cloud API send + webhook 路由接入) */
function createWhatsappTransport(_credentials: WhatsappCredentials): WhatsappSendTransport {
  return {
    async sendMessage() {
      throw new Error('whatsapp 生产 transport 未实装')
    },
  }
}
