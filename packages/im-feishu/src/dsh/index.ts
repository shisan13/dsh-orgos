/**
 * dsh-orgos-im-feishu 绑定层 —— 适配器注册行(bundle 行:name 'dsh-orgos-im-feishu/dsh')
 *
 * 依赖 host 的 teamImGateway(dsh-orgos-im-gateway/dsh 提供):注册 FeishuAdapter factory。
 * 生产 transport 用 @larksuiteoapi/node-sdk 的 WSClient(官方 WebSocket 长连接);
 * 测试仍用 fake transport(Flash 已交付 fixture 测试)。
 */
import { appendFileSync } from 'node:fs'

export const name = 'dsh-orgos-im-feishu'

// 硬依赖:网关服务由 team-im-gateway 行提供,静态注入保证激活顺序(官方模式)
export const inject = ['teamImGateway']

import { FeishuAdapter, type FeishuCredentials, type FeishuTransport } from 'dsh-orgos-im-feishu'

interface Ctx {
  teamImGateway: ImGatewayLike
  get(key: string): unknown
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void }
}

interface ImGatewayLike {
  registerAdapter(factory: unknown): void
}

export function apply(ctx: Ctx): void {
  try {
    appendFileSync('/tmp/orgos-gateway.markers.log', `${new Date().toISOString()} feishu:apply inject-resolved teamImGateway=${ctx.teamImGateway !== undefined}\n`)
  } catch { /* ignore */ }
  const gateway = ctx.teamImGateway

  gateway.registerAdapter({
    provider: 'feishu',
    build(channel: string, rawCredential: string, handlers: {
      onInbound(msg: unknown): void
      onConnection(state: 'connected' | 'disconnected', reason?: string): void
    }) {
      // 飞书凭据格式:appId:appSecret
      const [appId, appSecret] = rawCredential.split(':')
      if (!appId || !appSecret) throw new Error('飞书凭据格式应为 appId:appSecret')
      const credentials: FeishuCredentials = { appId, appSecret }
      return new FeishuAdapter({
        channel,
        credentials,
        transport: createLarkTransport(credentials),
        onInbound: handlers.onInbound,
        onConnection: handlers.onConnection,
        onDebug: (message) => {
          try {
            appendFileSync('/tmp/orgos-gateway.markers.log', `${new Date().toISOString()} adapter-debug ${message}\n`)
          } catch { /* ignore */ }
        },
      })
    },
  })
}

/** 生产 transport:@larksuiteoapi/node-sdk WSClient(运行时动态加载,避免测试环境膨胀)。导出供测试与未来复用。 */
export function createLarkTransport(credentials: FeishuCredentials): FeishuTransport {
  return {
    async connect(cb) {
      const lark = await import('@larksuiteoapi/node-sdk')
      const base = { appId: credentials.appId, appSecret: credentials.appSecret }
      const wsClient = new lark.WSClient({ ...base, loggerLevel: 0 })
      const dispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': (data: unknown) => {
          // SDK EventDispatcher 已把 header/event 拍平;规范化器(larkEventToMessage)
          // 期望 v2 信封结构,此处重组信封后交给 FeishuAdapter 规范化。
          const flat = (data ?? {}) as Record<string, unknown>
          const envelope = {
            header: { event_type: String(flat.event_type ?? flat.type ?? '') },
            event: flat,
          }
          try {
            appendFileSync('/tmp/orgos-gateway.markers.log',
              `${new Date().toISOString()} sdk-event type=${envelope.header.event_type} hasMessage=${flat.message !== undefined} hasSender=${flat.sender !== undefined}\n`)
          } catch { /* ignore */ }
          cb.onEvent(envelope)
        },
        // 卡片按钮回调:审批/任务/决策卡的点击答复(200672 修复核心——
        // 此前未注册该事件,按钮点击无人处理)
        'card.action.trigger': (data: unknown) => {
          const flat = (data ?? {}) as Record<string, unknown>
          const envelope = {
            header: { event_type: 'card.action.trigger' },
            event: flat,
          }
          try {
            appendFileSync('/tmp/orgos-gateway.markers.log',
              `${new Date().toISOString()} sdk-card-value RAW=${String((flat.action as Record<string, unknown> | undefined)?.value)}
`)
          } catch { /* ignore */ }
          cb.onEvent(envelope)
        },
      })
      await wsClient.start({ eventDispatcher: dispatcher })
      const botOpenId = await fetchBotOpenId(credentials)
      return {
        async disconnect() {
          wsClient.close()
        },
        selfOpenId: () => botOpenId,
      }
    },
    async sendText(chatId, text) {
      const lark = await import('@larksuiteoapi/node-sdk')
      const client = new lark.Client({
        appId: credentials.appId,
        appSecret: credentials.appSecret,
      })
      await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      })
    },
    async sendCard(chatId, card) {
      const lark = await import('@larksuiteoapi/node-sdk')
      const client = new lark.Client({
        appId: credentials.appId,
        appSecret: credentials.appSecret,
      })
      await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      })
    },
    // 断线补偿:拉取群最近消息(im/v1/messages;需 im:message:readonly 权限)。
    // 返回形状对齐 WS 事件 event 字段,便于复用同一条规范化+幂等链路。
    async fetchRecentMessages(chatId, startTimeMs, limit = 50) {
      const token = await fetchTenantToken(credentials)
      const res = await fetch(
        `https://open.feishu.cn/open-apis/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(chatId)}&start_time=${Math.floor(startTimeMs / 1000)}&page_size=${Math.min(limit, 50)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      const body = (await res.json()) as { code?: number; msg?: string; data?: { items?: Array<Record<string, unknown>> } }
      if (!res.ok || (body.code !== undefined && body.code !== 0)) {
        throw new Error(`飞书拉取历史消息失败:code=${String(body.code)} msg=${body.msg ?? ''}`)
      }
      // items[].message_id/chat_id/chat_type/msg_type/content/mentions/create_time + 顶层 sender。
      // 对齐 WS 事件 event 形状:{ sender: { sender_id, sender_type }, message: {...} }
      return (body.data?.items ?? []).map((item) => {
        const sender = item.sender as { id?: { open_id?: string }; sender_type?: string } | undefined
        return {
          sender: { sender_id: sender?.id ?? {}, sender_type: sender?.sender_type },
          message: item,
        }
      })
    },
  }
}

/** 获取 tenant_access_token(补偿拉取/自检共用;失败抛出由上层降级) */
export async function fetchTenantToken(credentials: FeishuCredentials): Promise<string> {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: credentials.appId, app_secret: credentials.appSecret }),
  })
  const body = (await res.json()) as { tenant_access_token?: string }
  if (!body.tenant_access_token) throw new Error('飞书 tenant_access_token 获取失败')
  return body.tenant_access_token
}

/** 获取 bot 自身 open_id(用于群 @提及判定;失败返回 undefined 不阻塞连接) */
export async function fetchBotOpenId(credentials: FeishuCredentials): Promise<string | undefined> {
  try {
    const tokRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: credentials.appId, app_secret: credentials.appSecret }),
    })
    const token = (await tokRes.json() as { tenant_access_token?: string }).tenant_access_token
    if (!token) return undefined
    const botRes = await fetch('https://open.feishu.cn/open-apis/bot/v3/info', {
      headers: { Authorization: `Bearer ${token}` },
    })
    return ((await botRes.json()) as { bot?: { open_id?: string } }).bot?.open_id
  } catch {
    return undefined
  }
}
