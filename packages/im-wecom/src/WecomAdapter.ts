/**
 * WecomAdapter —— 企业微信智能机器人回调适配器(ImAdapter seam 的实现)
 *
 * 纯网络协议层(harness-agnostic):
 * - webhook 被动模式:绑定层把 HTTP 请求交给 handleRequest;
 * - GET = URL 验证:验签 + 解密 echostr → 回显加密 XML(安全设计 §6 AES 验签);
 * - POST = 消息回调:验签 → 解密密文 → 明文 XML → 规范化 → 去重 → onInbound;
 * - 出站:sendText/sendCard 走应用消息发送接口(transport 抽象)。
 */
import type { ImAdapter, NormalizedMessage, PeerRef } from 'dsh-orgos-im-gateway'
import { IdempotencySet, dedupKey } from 'dsh-orgos-im-gateway'
import { verifySignature, decrypt, encrypt, signature, WecomCryptoError, type WecomCryptoConfig } from './crypto.ts'
import { wrapVerifyXml, parseXmlTags } from './xml.ts'
import { wecomXmlToMessage } from './events.ts'
import { renderCard, type AnyCard } from './cards.ts'
import { segmentText } from './format.ts'

/** 已解析凭据(Pro 绑定层从 ctx.credentials 注入;不落盘) */
export interface WecomCredentials {
  /** 应用 agentId(数字字符串) */
  agentId: string
  corpId: string
  token: string
  encodingAESKey: string
}

/** 入站 HTTP 请求(绑定层适配 Koa/Express 等路由) */
export interface WecomWebhookRequest {
  method: string
  query: Record<string, string | undefined>
  body: string
}

export interface WecomWebhookResponse {
  status: number
  body: string
}

/** 出站发送抽象(应用消息 API;生产实现为 access_token + send 接口) */
export interface WecomSendTransport {
  sendText(userId: string, text: string, agentId: string): Promise<void>
  sendCard(userId: string, card: unknown, agentId: string): Promise<void>
}

export interface WecomAdapterOptions {
  credentials: WecomCredentials
  transport: WecomSendTransport
  /** 群 @ 判定(bot 名称;缺省时以文本 @ 前缀判定) */
  botName?: string
  onInbound?: (msg: NormalizedMessage) => void | Promise<void>
  onConnection?: (state: 'connected' | 'disconnected', reason?: string) => void
  /** 通道标识(默认 'wecom') */
  channel?: string
}

export class WecomAdapter implements ImAdapter {
  readonly channel: string

  private readonly opts: WecomAdapterOptions
  private readonly seen = new IdempotencySet()
  private started = false

  constructor(opts: WecomAdapterOptions) {
    this.channel = opts.channel ?? 'wecom'
    this.opts = opts
  }

  /** webhook 模式:无长连接,start 幂等标记在线(连接状态由绑定层 HTTP 路由健康检查) */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.opts.onConnection?.('connected')
  }

  async stop(): Promise<void> {
    this.started = false
  }

  /**
   * 处理回调请求(绑定层挂到 HTTP 路由):
   * - GET + echostr → URL 验证,返回 200 + 加密 XML;
   * - POST → 消息回调,返回 200 + 'success'(微信协议约定);
   * - 验签失败/解密失败 → 400 + 错误原因(fail-closed,T3 凭据缺失拒启)。
   */
  async handleRequest(req: WecomWebhookRequest): Promise<WecomWebhookResponse> {
    const query = req.query
    const signatureParam = query.msg_signature
    const timestamp = query.timestamp
    const nonce = query.nonce
    if (typeof signatureParam !== 'string' || typeof timestamp !== 'string' || typeof nonce !== 'string') {
      return { status: 400, body: '缺少 msg_signature/timestamp/nonce' }
    }
    const cryptoConfig: WecomCryptoConfig = {
      token: this.opts.credentials.token,
      encodingAESKey: this.opts.credentials.encodingAESKey,
      corpId: this.opts.credentials.corpId,
    }
    if (req.method === 'GET') {
      const echostr = query.echostr
      if (typeof echostr !== 'string') {
        return { status: 400, body: '缺少 echostr' }
      }
      try {
        const plain = this.decryptEcho(cryptoConfig, timestamp, nonce, echostr, signatureParam)
        const encrypted = encrypt(cryptoConfig, plain)
        const msgSignature = signatureOf(cryptoConfig, timestamp, nonce, encrypted)
        return { status: 200, body: wrapVerifyXml(encrypted, timestamp, nonce, msgSignature) }
      } catch (err) {
        return { status: 400, body: this.errorMessage(err) }
      }
    }
    // POST:消息回调
    try {
      const envelope = parseXmlTags(req.body)
      const encryptBase64 = envelope.get('Encrypt')
      if (encryptBase64 === undefined) {
        return { status: 400, body: '缺少 Encrypt 字段' }
      }
      if (!verifySignature(cryptoConfig, timestamp, nonce, encryptBase64, signatureParam)) {
        return { status: 400, body: '签名不匹配' }
      }
      const plain = decrypt(cryptoConfig, encryptBase64)
      this.handlePlain(plain)
      return { status: 200, body: 'success' }
    } catch (err) {
      return { status: 400, body: this.errorMessage(err) }
    }
  }

  /** 文本出站(分段) */
  async sendText(target: PeerRef, text: string): Promise<void> {
    const segments = segmentText(text)
    for (const segment of segments) {
      await this.opts.transport.sendText(target.id, segment.text, this.opts.credentials.agentId)
    }
  }

  /** 卡片出站(template_card) */
  async sendCard(target: PeerRef, card: AnyCard): Promise<void> {
    const payload = renderCard(card)
    await this.opts.transport.sendCard(target.id, payload, this.opts.credentials.agentId)
  }

  isStarted(): boolean {
    return this.started
  }

  private decryptEcho(config: WecomCryptoConfig, timestamp: string, nonce: string, echostr: string, msgSignature: string): string {
    if (!verifySignature(config, timestamp, nonce, echostr, msgSignature)) {
      throw new WecomCryptoError('URL 验证签名不匹配')
    }
    return decrypt(config, echostr)
  }

  /** 明文回调:规范化 → 覆盖通道名 → 去重 → 回调(异常隔离) */
  private handlePlain(xml: string): void {
    const result = wecomXmlToMessage(xml, this.opts.botName)
    if (!result.ok) return
    const msg = { ...result.msg, channel: this.channel }
    const key = dedupKey(msg)
    if (this.seen.seen(key)) return // 重放防护(T6)
    void Promise.resolve()
      .then(() => this.opts.onInbound?.(msg))
      .catch((error: unknown) => this.opts.onConnection?.('disconnected', `inbound-error: ${String(error).slice(0, 120)}`))
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message.slice(0, 200) : String(err)
  }
}

/** 响应信封签名(验签同构) */
export function signatureOf(config: WecomCryptoConfig, timestamp: string, nonce: string, encryptBase64: string): string {
  return signature(config.token, timestamp, nonce, encryptBase64)
}
