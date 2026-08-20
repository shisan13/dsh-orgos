/**
 * dsh-orgos-im-wecom 绑定层(bundle 行:name 'dsh-orgos-im-wecom/dsh')
 * 生产 transport(出站):自建应用 access_token + message/send(零 SDK,HTTP API)。
 * 入站为自建应用回调(HTTP POST + AES 验签,需公网 URL;本地联调受限,
 * 公网部署时经 webserver 路由接入——TODO 与公网回调路由一并实装)。
 * 凭据格式(JSON):{"corpId","secret","agentId","token","encodingAESKey"}
 *   (secret 用于 access_token;token/encodingAESKey 用于入站验签)
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
    provider: 'wecom',
    build(channel: string, rawCredential: string, handlers: {
      onInbound(msg: unknown): void
      onConnection(state: 'connected' | 'disconnected', reason?: string): void
    }) {
      const parsed = JSON.parse(rawCredential) as WecomCredentials & { secret?: string }
      if (!parsed.corpId || !parsed.agentId || !parsed.secret) throw new Error('wecom 凭据 JSON 需含 corpId/secret/agentId')
      const credentials: WecomCredentials = {
        corpId: parsed.corpId,
        agentId: parsed.agentId,
        token: parsed.token,
        encodingAESKey: parsed.encodingAESKey,
      }
      return new WecomAdapter({
        channel,
        credentials,
        transport: createWecomTransport(credentials, parsed.secret),
        onInbound: handlers.onInbound,
        onConnection: handlers.onConnection,
      })
    },
  })
}

/** 生产 transport(出站):access_token 缓存 + message/send 文本消息 */
function createWecomTransport(credentials: WecomCredentials, secret: string): WecomSendTransport {
  let cachedToken = ''
  let cachedAt = 0
  async function accessToken(): Promise<string> {
    if (cachedToken && Date.now() - cachedAt < 7000_000) return cachedToken // 官方 7200s,提前刷新
    const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${credentials.corpId}&corpsecret=${secret}`)
    const data = (await res.json()) as { access_token?: string; errmsg?: string }
    if (!data.access_token) throw new Error(`wecom access_token: ${data.errmsg ?? res.status}`)
    cachedToken = data.access_token
    cachedAt = Date.now()
    return cachedToken
  }
  return {
    async sendText(userId, text, agentId) {
      const token = await accessToken()
      await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          touser: userId,
          msgtype: 'text',
          agentid: Number(agentId),
          text: { content: text },
        }),
      })
    },
    async sendCard(userId, card, agentId) {
      // 企业微信卡片消息(textcard):标题+内容+按钮跳转;审批按钮语义降级为文本说明
      const c = card as { title?: string; body?: string }
      const token = await accessToken()
      await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          touser: userId,
          msgtype: 'textcard',
          agentid: Number(agentId),
          textcard: { title: c.title ?? '审批请求', description: c.body ?? '', url: 'about:blank' },
        }),
      })
    },
  }
}
