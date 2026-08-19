/**
 * dsh-orgos-im-wecom 绑定层(bundle 行:name 'dsh-orgos-im-wecom/dsh')
 * 凭据格式(JSON 字符串):{"corpId":"...","agentId":"...","token":"...","encodingAESKey":"..."}
 * 入站:企业微信智能机器人回调(HTTP POST,需公网 URL;AES 验签由包内 crypto 提供)。
 * 生产 transport 实装 TODO(公网回调地址 + 应用消息 send API)。
 */
export const name = 'dsh-orgos-im-wecom'
export const inject = ['teamImGateway']

import { WecomAdapter, type WecomCredentials, type WecomSendTransport } from 'dsh-orgos-im-wecom'

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
      const credentials = JSON.parse(rawCredential) as WecomCredentials
      if (!credentials.corpId || !credentials.agentId) throw new Error('wecom 凭据 JSON 需含 corpId/agentId/token/encodingAESKey')
      return new WecomAdapter({
        channel,
        credentials,
        transport: createWecomTransport(credentials),
        onInbound: handlers.onInbound,
        onConnection: handlers.onConnection,
      })
    },
  })
}

/** 生产 transport 占位(TODO:应用消息 send API + 公网回调路由接入) */
function createWecomTransport(_credentials: WecomCredentials): WecomSendTransport {
  return {
    async sendText() {
      throw new Error('wecom 生产 transport 未实装')
    },
    async sendCard() {
      throw new Error('wecom 生产 transport 未实装')
    },
  }
}
