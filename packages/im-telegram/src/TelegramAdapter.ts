/**
 * TelegramAdapter —— Telegram 长轮询适配器(ImAdapter seam 的实现)
 *
 * 纯网络协议层(harness-agnostic,零 DSH import):
 * - 长轮询循环:getUpdates(offset, timeout=30s) → 处理 → offset = max(update_id)+1;
 * - 轮询错误指数退避重连(§9.1);stop 幂等(进行中的轮询由 transport 层中止);
 * - 入站:update → 规范化 → 覆盖实例通道名 → 幂等去重 → onInbound(异常隔离);
 * - 出站:sendText 分段逐段发送;sendCard 渲染内联键盘;callback_query 需 answerCallbackQuery。
 */
import type { ImAdapter, NormalizedMessage, PeerRef } from 'dsh-orgos-im-gateway'
import { IdempotencySet, dedupKey, BackoffPolicy } from 'dsh-orgos-im-gateway'
import { telegramUpdateToMessage } from './events.ts'
import { renderCard, type AnyCard } from './cards.ts'
import { segmentText } from './format.ts'

/** 已解析的 bot 凭据(Pro 绑定层从 ctx.credentials 注入,不落盘) */
export interface TelegramCredentials {
  token: string
}

/** 传输层抽象(测试注入 fake;生产实现为 Bot API HTTP 客户端 + 长轮询) */
export interface TelegramTransport {
  /** 长轮询;timeout=轮询超时秒数;错误抛异常由 adapter 走退避重连 */
  getUpdates(params: { offset: number; timeout: number }): Promise<{ updates: unknown[] }>
  sendMessage(chatId: string, payload: { text: string; replyMarkup?: unknown }): Promise<void>
  /** 按钮回调确认(否则按钮转圈) */
  answerCallbackQuery(callbackQueryId: string): Promise<void>
}

export interface TelegramAdapterOptions {
  credentials: TelegramCredentials
  transport: TelegramTransport
  /** @bot 提及判定(群消息;不配则所有群文本按非提及处理) */
  botUsername?: string
  onInbound?: (msg: NormalizedMessage) => void | Promise<void>
  onConnection?: (state: 'connected' | 'disconnected', reason?: string) => void
  backoff?: BackoffPolicy
  /** 通道标识(多 bot 实例化时区分;默认 'telegram') */
  channel?: string
  /** 长轮询超时秒数(默认 30) */
  pollTimeoutSeconds?: number
}

export class TelegramAdapter implements ImAdapter {
  readonly channel: string

  private readonly opts: TelegramAdapterOptions
  private readonly seen = new IdempotencySet()
  private started = false
  private stopping = false
  private offset = 0
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private inflight = false

  constructor(opts: TelegramAdapterOptions) {
    this.channel = opts.channel ?? 'telegram'
    this.opts = opts
  }

  /** 建连(幂等):启动长轮询循环 */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.stopping = false
    this.opts.onConnection?.('connected')
    void this.pollLoop()
  }

  /** 停止(幂等):取消重连定时器,轮询循环在下次迭代退出 */
  async stop(): Promise<void> {
    this.stopping = true
    this.started = false
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
  }

  /** 文本出站:4096 分段逐段发送 */
  async sendText(target: PeerRef, text: string): Promise<void> {
    const segments = segmentText(text)
    for (const segment of segments) {
      await this.opts.transport.sendMessage(target.id, { text: segment.text })
    }
  }

  /** 卡片出站:内联键盘按钮 */
  async sendCard(target: PeerRef, card: AnyCard): Promise<void> {
    const payload = renderCard(card)
    await this.opts.transport.sendMessage(target.id, { text: payload.text, replyMarkup: payload.reply_markup })
  }

  isStarted(): boolean {
    return this.started
  }

  reconnectAttempts(): number {
    return this.reconnectAttempt
  }

  /** 长轮询循环:单飞(并发 start 只跑一个循环) */
  private async pollLoop(): Promise<void> {
    if (this.inflight) return
    this.inflight = true
    try {
      while (this.started && !this.stopping) {
        try {
          const timeout = this.opts.pollTimeoutSeconds ?? 30
          const { updates } = await this.opts.transport.getUpdates({ offset: this.offset, timeout })
          if (!this.started) break
          let maxId = this.offset
          for (const update of updates) {
            const id = (update as Record<string, unknown>)?.update_id
            if (typeof id === 'number' && id >= maxId) maxId = id + 1
            this.handleEvent(update)
          }
          this.offset = maxId
          this.reconnectAttempt = 0 // 轮询成功即视为连接健康
        } catch (err) {
          if (!this.started || this.stopping) break
          const backoff = await this.scheduleReconnect(err instanceof Error ? err.message : 'poll-failed')
          if (!backoff) break // 已耗尽或已停止
        }
      }
    } finally {
      this.inflight = false
    }
  }

  /** 退避等待;返回 false 表示放弃重连(已耗尽/已停止) */
  private async scheduleReconnect(reason: string): Promise<boolean> {
    if (!this.started || this.stopping) return false
    this.reconnectAttempt += 1
    const policy = this.opts.backoff ?? new BackoffPolicy()
    if (policy.exhausted(this.reconnectAttempt)) {
      this.opts.onConnection?.('disconnected', reason)
      return false
    }
    const delay = policy.delayFor(this.reconnectAttempt)
    this.opts.onConnection?.('disconnected', reason)
    await new Promise<void>((resolve) => {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined
        resolve()
      }, delay)
    })
    return this.started && !this.stopping
  }

  /** 入站:规范化 → 覆盖通道名 → 去重 → 回调(异常隔离) */
  private handleEvent(update: unknown): void {
    const result = telegramUpdateToMessage(update, this.opts.botUsername)
    if (!result.ok) return
    const msg = { ...result.msg, channel: this.channel }
    const key = dedupKey(msg)
    if (this.seen.seen(key)) return // 重放防护(T6)
    // 按钮回调:先确认再分发(生产 transport 内部可合并;此处交由回调方)
    void Promise.resolve()
      .then(() => this.opts.onInbound?.(msg))
      .catch((error: unknown) => this.opts.onConnection?.('disconnected', `inbound-error: ${String(error).slice(0, 120)}`))
  }
}
