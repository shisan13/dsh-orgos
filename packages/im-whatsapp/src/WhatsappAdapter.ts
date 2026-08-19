/**
 * WhatsappAdapter —— WhatsApp Business API webhook 适配器(ImAdapter seam 的实现)
 *
 * 纯网络协议层(harness-agnostic):
 * - webhook 被动模式:绑定层把 HTTP POST 交给 handleWebhook;
 * - 入站:验签(X-Hub-Signature-256,安全设计 §6)→ 解包 → 规范化(逐条)→ 去重 → onInbound;
 * - 出站:sendText 分段;sendCard 渲染 interactive buttons。
 */
import type { ImAdapter, NormalizedMessage, PeerRef } from 'dsh-orgos-im-gateway'
import { IdempotencySet, dedupKey } from 'dsh-orgos-im-gateway'
import { verifyWebhookSignature } from './verify.ts'
import { whatsappWebhookToMessages } from './events.ts'
import { renderCard, type AnyCard } from './cards.ts'
import { segmentText } from './format.ts'

/** 已解析凭据(Pro 绑定层从 ctx.credentials 注入;不落盘) */
export interface WhatsappCredentials {
  /** Business API 凭据 */
  phoneNumberId: string
  accessToken: string
  /** webhook 验签密钥 */
  appSecret: string
}

/** 入站 webhook 请求(绑定层适配 Koa/Express 等路由;rawBody 必须为原始字节文本) */
export interface WhatsappWebhookRequest {
  rawBody: string
  /** X-Hub-Signature-256 头 */
  signature?: string
}

export interface WhatsappWebhookResponse {
  status: number
  body: string
}

/** 出站发送抽象(Business API messages 接口) */
export interface WhatsappSendTransport {
  sendMessage(to: string, payload: unknown): Promise<void>
}

export interface WhatsappAdapterOptions {
  credentials: WhatsappCredentials
  transport: WhatsappSendTransport
  onInbound?: (msg: NormalizedMessage) => void | Promise<void>
  onConnection?: (state: 'connected' | 'disconnected', reason?: string) => void
  /** 通道标识(默认 'whatsapp') */
  channel?: string
}

export class WhatsappAdapter implements ImAdapter {
  readonly channel: string

  private readonly opts: WhatsappAdapterOptions
  private readonly seen = new IdempotencySet()
  private started = false

  constructor(opts: WhatsappAdapterOptions) {
    this.channel = opts.channel ?? 'whatsapp'
    this.opts = opts
  }

  /** webhook 模式:无长连接,start 幂等标记在线 */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.opts.onConnection?.('connected')
  }

  async stop(): Promise<void> {
    this.started = false
  }

  /**
   * 处理 webhook(绑定层挂到 HTTP 路由):
   * - 验签失败 → 401(fail-closed,安全设计 §6);
   * - 成功 → 规范化逐条入站 → 200 'OK'(Meta 协议约定)。
   */
  async handleWebhook(req: WhatsappWebhookRequest): Promise<WhatsappWebhookResponse> {
    if (!verifyWebhookSignature(this.opts.credentials.appSecret, req.rawBody, req.signature)) {
      return { status: 401, body: 'signature mismatch' }
    }
    let payload: unknown
    try {
      payload = JSON.parse(req.rawBody)
    } catch {
      return { status: 400, body: 'invalid json' }
    }
    const result = whatsappWebhookToMessages(payload)
    if (!result.ok) {
      return { status: 200, body: 'OK' } // 非消息变更(状态回执等)正常回 OK
    }
    for (const msg of result.messages) {
      this.handleMessage(msg)
    }
    return { status: 200, body: 'OK' }
  }

  /** 文本出站:分段逐段发送 */
  async sendText(target: PeerRef, text: string): Promise<void> {
    const segments = segmentText(text)
    for (const segment of segments) {
      await this.opts.transport.sendMessage(target.id, { messaging_product: 'whatsapp', recipient_type: 'individual', type: 'text', text: { body: segment.text } })
    }
  }

  /** 卡片出站:interactive buttons */
  async sendCard(target: PeerRef, card: AnyCard): Promise<void> {
    await this.opts.transport.sendMessage(target.id, renderCard(card))
  }

  isStarted(): boolean {
    return this.started
  }

  /** 入站:覆盖通道名 → 去重 → 回调(异常隔离) */
  private handleMessage(msg: NormalizedMessage): void {
    const normalized = { ...msg, channel: this.channel }
    const key = dedupKey(normalized)
    if (this.seen.seen(key)) return // 重放防护(T6)
    void Promise.resolve()
      .then(() => this.opts.onInbound?.(normalized))
      .catch((error: unknown) => this.opts.onConnection?.('disconnected', `inbound-error: ${String(error).slice(0, 120)}`))
  }
}
