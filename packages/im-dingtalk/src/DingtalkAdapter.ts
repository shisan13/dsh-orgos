/**
 * DingtalkAdapter —— 钉钉 Stream Mode 适配器(ImAdapter seam 的实现)
 *
 * 纯网络协议层(harness-agnostic):
 * - transport 抽象与飞书同构:connect(handlers) → { disconnect, selfId };
 *   Stream 协议(建连/心跳/重连)由生产 transport 实现,adapter 只管事件;
 * - 入站:信封 → 规范化 → 覆盖通道名 → 幂等去重 → onInbound(异常隔离);
 * - 出站:sendText 分段;sendCard 渲染 interactive 模板卡片。
 */
import type { ImAdapter, NormalizedMessage, PeerRef } from 'dsh-orgos-im-gateway'
import { IdempotencySet, dedupKey, BackoffPolicy } from 'dsh-orgos-im-gateway'
import { dingtalkEnvelopeToMessage } from './events.ts'
import { renderCard, type AnyCard } from './cards.ts'
import { segmentText } from './format.ts'

/** 已解析凭据(Pro 绑定层从 ctx.credentials 注入;不落盘) */
export interface DingtalkCredentials {
  appKey: string
  appSecret: string
}

/** 传输层抽象(生产实现:gateway/connections/open + WS 长连接 + 心跳) */
export interface DingtalkTransport {
  connect(handlers: {
    onEvent(payload: unknown): void
    onError(err: unknown): void
    onClose(reason?: string): void
  }): Promise<{ disconnect(): Promise<void>; selfId(): string | undefined }>
  sendMessage(conversationId: string, payload: unknown): Promise<void>
}

export interface DingtalkAdapterOptions {
  credentials: DingtalkCredentials
  transport: DingtalkTransport
  /** 群 @ 判定补充(bot 名称;isInAtList 优先) */
  botName?: string
  onInbound?: (msg: NormalizedMessage) => void | Promise<void>
  onConnection?: (state: 'connected' | 'disconnected', reason?: string) => void
  backoff?: BackoffPolicy
  /** 通道标识(默认 'dingtalk') */
  channel?: string
}

export class DingtalkAdapter implements ImAdapter {
  readonly channel: string

  private readonly opts: DingtalkAdapterOptions
  private readonly seen = new IdempotencySet()
  private started = false
  private disconnect: (() => Promise<void>) | undefined
  private selfIdValue: string | undefined
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private stopping = false

  constructor(opts: DingtalkAdapterOptions) {
    this.channel = opts.channel ?? 'dingtalk'
    this.opts = opts
  }

  /** 建连(幂等);失败按退避策略重连(§9.1) */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.stopping = false
    await this.connectOnce()
  }

  /** 停止(幂等):断开 + 取消重连定时器 */
  async stop(): Promise<void> {
    this.stopping = true
    this.started = false
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    const disconnect = this.disconnect
    this.disconnect = undefined
    if (disconnect) await disconnect()
  }

  /** 文本出站:分段逐段发送 */
  async sendText(target: PeerRef, text: string): Promise<void> {
    const segments = segmentText(text)
    for (const segment of segments) {
      await this.opts.transport.sendMessage(target.id, { msgtype: 'text', text: { content: segment.text } })
    }
  }

  /** 卡片出站:interactive 模板卡片 */
  async sendCard(target: PeerRef, card: AnyCard): Promise<void> {
    await this.opts.transport.sendMessage(target.id, renderCard(card))
  }

  isStarted(): boolean {
    return this.started
  }

  reconnectAttempts(): number {
    return this.reconnectAttempt
  }

  private async connectOnce(): Promise<void> {
    if (!this.started || this.stopping) return
    try {
      const handle = await this.opts.transport.connect({
        onEvent: (payload) => this.handleEvent(payload),
        onError: () => this.scheduleReconnect('transport-error'),
        onClose: (reason) => this.scheduleReconnect(reason ?? 'transport-close'),
      })
      if (!this.started) {
        await handle.disconnect()
        return
      }
      this.disconnect = handle.disconnect
      this.selfIdValue = handle.selfId()
      this.reconnectAttempt = 0
      this.opts.onConnection?.('connected')
    } catch (err) {
      this.scheduleReconnect(err instanceof Error ? err.message : 'connect-failed')
    }
  }

  private scheduleReconnect(reason: string): void {
    if (!this.started || this.stopping) return
    if (this.reconnectTimer !== undefined) return
    this.reconnectAttempt += 1
    const policy = this.opts.backoff ?? new BackoffPolicy()
    if (policy.exhausted(this.reconnectAttempt)) {
      this.opts.onConnection?.('disconnected', reason)
      return
    }
    const delay = policy.delayFor(this.reconnectAttempt)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.connectOnce()
    }, delay)
  }

  /** 入站:信封 → 规范化 → 覆盖通道名 → 去重 → 回调(异常隔离) */
  private handleEvent(payload: unknown): void {
    const result = dingtalkEnvelopeToMessage(payload, this.opts.botName)
    if (!result.ok) return
    const msg = { ...result.msg, channel: this.channel }
    const key = dedupKey(msg)
    if (this.seen.seen(key)) return
    void Promise.resolve()
      .then(() => this.opts.onInbound?.(msg))
      .catch((error: unknown) => this.opts.onConnection?.('disconnected', `inbound-error: ${String(error).slice(0, 120)}`))
  }

  /** bot 自身 id(用于提及判定扩展;当前由规范化器按 isInAtList/text 前缀判定) */
  selfId(): string | undefined {
    return this.selfIdValue
  }
}
