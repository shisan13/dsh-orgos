/**
 * dsh-orgos-im-dingtalk 绑定层(bundle 行:name 'dsh-orgos-im-dingtalk/dsh')
 * 生产 transport:官方 dingtalk-stream SDK(Stream Mode WS 长连接)。
 * 凭据格式(JSON 字符串):{"appKey":"...","appSecret":"...","robotCode":"..."}
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
      const parsed = JSON.parse(rawCredential) as { appKey: string; appSecret: string; robotCode?: string }
      if (!parsed.appKey || !parsed.appSecret) throw new Error('dingtalk 凭据 JSON 需含 appKey/appSecret(可选 robotCode)')
      const credentials: DingtalkCredentials = { appKey: parsed.appKey, appSecret: parsed.appSecret }
      return new DingtalkAdapter({
        channel,
        credentials,
        transport: createDingtalkTransport(credentials, parsed.robotCode),
        onInbound: handlers.onInbound,
        onConnection: handlers.onConnection,
      })
    },
  })
}

/** 生产 transport:dingtalk-stream SDK + 机器人单聊发消息(官方 API) */
function createDingtalkTransport(credentials: DingtalkCredentials, robotCode?: string): DingtalkTransport {
  return {
    async connect(handlers) {
      const { DWClient, TOPIC_ROBOT } = await import('dingtalk-stream')
      const client = new DWClient({
        clientId: credentials.appKey,
        clientSecret: credentials.appSecret,
        keepAlive: true,
      })
      client.registerCallbackListener(TOPIC_ROBOT, (downstream: { headers?: { eventType?: string }; data?: unknown }) => {
        handlers.onEvent({ eventType: downstream.headers?.eventType, data: downstream.data })
      })
      await client.connect()
      return {
        async disconnect() {
          client.disconnect()
        },
        selfId: () => undefined,
      }
    },
    async sendMessage(conversationId, payload) {
      const token = await fetchDingtalkToken(credentials)
      const msg = payload as { text?: string }
      await fetch('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-acs-dingtalk-access-token': token,
        },
        body: JSON.stringify({
          robotCode: robotCode ?? credentials.appKey,
          userIds: [conversationId],
          msgKey: 'sampleText',
          msgParam: JSON.stringify({ content: msg.text ?? '' }),
        }),
      })
    },
  }
}

/** 钉钉企业 access_token(官方 oauth2 接口) */
async function fetchDingtalkToken(credentials: DingtalkCredentials): Promise<string> {
  const res = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey: credentials.appKey, appSecret: credentials.appSecret }),
  })
  const data = (await res.json()) as { accessToken?: string; message?: string }
  if (!data.accessToken) throw new Error(`dingtalk access_token: ${data.message ?? res.status}`)
  return data.accessToken
}
