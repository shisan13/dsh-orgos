/**
 * dsh-orgos-im-dingtalk 绑定层(bundle 行:name 'dsh-orgos-im-dingtalk/dsh')
 * 凭据格式:appKey:appSecret。
 * 生产 transport:钉钉 Stream Mode WS 客户端——实装 TODO(官方 SDK 接入,
 * 接口形状已由 adapter 的 DingtalkTransport 锁定)。
 */
export const name = 'dsh-orgos-im-dingtalk'
export const inject = ['teamImGateway']

import { DingtalkAdapter, type DingtalkCredentials, type DingtalkTransport } from 'dsh-orgos-im-dingtalk'

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
      const [appKey, appSecret] = rawCredential.split(':')
      if (!appKey || !appSecret) throw new Error('dingtalk 凭据格式应为 appKey:appSecret')
      const credentials: DingtalkCredentials = { appKey, appSecret }
      return new DingtalkAdapter({
        channel,
        credentials,
        transport: createDingtalkTransport(credentials),
        onInbound: handlers.onInbound,
        onConnection: handlers.onConnection,
      })
    },
  })
}

/** 生产 transport 占位:抛明确错误(fail-closed),TODO 接官方 Stream SDK */
function createDingtalkTransport(_credentials: DingtalkCredentials): DingtalkTransport {
  return {
    async connect() {
      throw new Error('dingtalk 生产 transport 未实装(官方 Stream SDK 接入 TODO)')
    },
    async sendMessage() {
      throw new Error('dingtalk 生产 transport 未实装')
    },
  }
}
