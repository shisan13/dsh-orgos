/**
 * FeishuAdapter —— 飞书/Lark WebSocket 适配器(ImAdapter seam 的实现)
 *
 * 分层纪律:本包是纯网络协议层(harness-agnostic),不接触 DSH 契约;
 * 事件发射(team/* 事件)由 Pro 绑定层以 InboundHandler 形式接入。
 *
 * - start/stop 幂等;连接失败经 BackoffPolicy 指数退避重连,耗尽后回调
 *   connectionHandler('disconnected')(技术设计 §9.1);
 * - 入站:transport 原始事件 → larkEventToMessage 规范化 → 幂等去重 → inboundHandler;
 * - 出站:sendText 长消息分段逐段发送;sendCard 渲染为飞书卡片;
 * - 凭据:credentialId 由绑定层解析后注入(本层只接收已解析的凭据对象,不落盘)。
 */
import type { ImAdapter, NormalizedMessage, PeerRef } from 'dsh-orgos-im-gateway'
import { IdempotencySet, dedupKey } from 'dsh-orgos-im-gateway'
import { larkEventToMessage } from './events.ts'
import { renderCard, type AnyCard } from './cards.ts'
import { segmentText } from './format.ts'
import { BackoffPolicy } from './backoff.ts'

/** 断线补偿窗口与单群拉取上限 */
const COMPENSATE_WINDOW_MS = 5 * 60_000
const COMPENSATE_LIMIT = 50

/** 已解析的飞书凭据(Pro 绑定层从 ctx.credentials 读取后注入;日志脱敏由绑定层负责) */
export interface FeishuCredentials {
  appId: string
  appSecret: string
}

/** 传输层抽象(测试注入 fake;生产实现包 @larksuiteoapi/node-sdk WS 客户端) */
export interface FeishuTransport {
  connect(handlers: {
    onEvent(payload: unknown): void
    onError(err: unknown): void
    onClose(reason?: string): void
  }): Promise<{ disconnect(): Promise<void>; selfOpenId(): string | undefined }>
  sendText(chatId: string, text: string): Promise<void>
  sendCard(chatId: string, card: unknown): Promise<void>
  /** 拉取群最近消息(断线补偿用):返回 WS 事件 event 形状的数组(含 message 字段) */
  fetchRecentMessages?(chatId: string, startTimeMs: number, limit?: number): Promise<Array<Record<string, unknown>>>
}

export interface FeishuAdapterOptions {
  credentials: FeishuCredentials
  transport: FeishuTransport
  /** 入站消息回调(Pro 绑定层接 team/inbound-message) */
  onInbound?: (msg: NormalizedMessage) => void | Promise<void>
  /** 连接状态回调(可观测/运维) */
  onConnection?: (state: 'connected' | 'disconnected', reason?: string) => void
  /** 重连策略(默认 base 1s / max 60s / 5 次) */
  backoff?: BackoffPolicy
  /** 通道标识(多 bot 实例化时区分;默认 'feishu') */
  channel?: string
  /** 可观测调试钩子(规范化失败/去重等,绑定层写 marker 用) */
  onDebug?: (message: string) => void
}

export class FeishuAdapter implements ImAdapter {
  readonly channel: string

  private readonly opts: FeishuAdapterOptions
  private readonly seen = new IdempotencySet()
  private started = false
  private disconnect: (() => Promise<void>) | undefined
  private selfOpenIdValue: string | undefined
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private stopping = false
  /** 需要补偿关注的群(绑定层 setWatchChats;断线/重启窗口内飞书不补发,重连后主动拉取) */
  private watchChats: string[] = []

  constructor(opts: FeishuAdapterOptions) {
    this.channel = opts.channel ?? 'feishu'
    this.opts = opts
  }

  /** 建连(幂等);失败按退避策略重连 */
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

  /** 文本出站:长消息分段逐段发送(§9.1 长消息分段) */
  async sendText(target: PeerRef, text: string): Promise<void> {
    const segments = segmentText(text)
    for (const segment of segments) {
      await this.opts.transport.sendText(target.id, segment.text)
    }
  }

  /** 卡片出站:渲染为飞书卡片 JSON */
  async sendCard(target: PeerRef, card: AnyCard): Promise<void> {
    await this.opts.transport.sendCard(target.id, renderCard(card))
  }

  /** 已启动状态(测试/运维查询) */
  isStarted(): boolean {
    return this.started
  }

  /** 当前重连尝试计数(测试/运维查询) */
  reconnectAttempts(): number {
    return this.reconnectAttempt
  }

  /** 设置需补偿关注的群(绑定层在 routes 就绪后调用;已启动则立即补拉一次,幂等去重兜底) */
  setWatchChats(chatIds: string[]): void {
    this.watchChats = [...chatIds]
    this.opts.onDebug?.(`watch-chats set: ${this.watchChats.join(',')}`)
    if (this.started) void this.compensateMissed()
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
      this.selfOpenIdValue = handle.selfOpenId()
      this.reconnectAttempt = 0
      this.opts.onConnection?.('connected')
      // 断线补偿:飞书 WS 断线期间事件不补发,重连后拉取最近窗口群消息补投
      // (handleEvent 内幂等去重,已处理的消息安全跳过)
      void this.compensateMissed()
    } catch (err) {
      this.scheduleReconnect(err instanceof Error ? err.message : 'connect-failed')
    }
  }

  /** 拉取关注群的最近窗口消息补投(单群失败不阻塞其余;未配置 fetchRecentMessages 时跳过) */
  private async compensateMissed(): Promise<void> {
    const fetchRecent = this.opts.transport.fetchRecentMessages
    if (fetchRecent === undefined || this.watchChats.length === 0) return
    const since = Date.now() - COMPENSATE_WINDOW_MS
    for (const chatId of this.watchChats) {
      try {
        const events = await fetchRecent(chatId, since, COMPENSATE_LIMIT)
        this.opts.onDebug?.(`compensate chat=${chatId} fetched=${events.length}`)
        for (const event of events) {
          this.handleEvent({ header: { event_type: 'im.message.receive_v1' }, event })
        }
      } catch (error) {
        // 拉取失败(如未开通 im:message:readonly 权限)降级:仅记录,不影响 WS 主链路
        this.opts.onDebug?.(`compensate-failed chat=${chatId}: ${String(error).slice(0, 120)}`)
      }
    }
  }

  /** 重连调度:指数退避;耗尽后发 disconnected */
  private scheduleReconnect(reason: string): void {
    if (!this.started || this.stopping) return
    if (this.reconnectTimer !== undefined) return // 已有定时器等待中
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

  /** 入站:规范化 → 覆盖实例通道名 → 去重 → 回调(回调异常隔离,不冲垮 SDK 事件循环) */
  private handleEvent(payload: unknown): void {
    const result = larkEventToMessage(payload, this.selfOpenId())
    if (!result.ok) {
      this.opts.onDebug?.(`normalize-fail: ${result.reason}`)
      return
    }
    // 多通道实例:规范化器默认 channel='feishu',覆盖为实例通道名(feishu-main 等),
    // 否则路由精确匹配与回送寻址都会错位(实测回退命中+adapter=false)。
    const msg = { ...result.msg, channel: this.channel }
    const key = dedupKey(msg)
    if (this.seen.seen(key)) return // 重放防护(T6)
    void Promise.resolve()
      .then(() => this.opts.onInbound?.(msg))
      .catch((error: unknown) => this.opts.onConnection?.('disconnected', `inbound-error: ${String(error).slice(0, 120)}`))
  }

  private selfOpenId(): string | undefined {
    return this.selfOpenIdValue
  }
}
