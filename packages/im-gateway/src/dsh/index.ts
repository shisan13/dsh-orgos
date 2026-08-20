/**
 * dsh-orgos-im-gateway 绑定层 —— IM seam 聚合(bundle 行:name 'dsh-orgos-im-gateway/dsh')
 *
 * - 多通道多 bot:config.channels 的每个 key = 一个通道实例(channel 名即 key),
 *   每个通道一个凭据引用(credentialId,值格式 appId:appSecret);
 * - 入站:adapter.onInbound → emit team/inbound-message → teamService.handleInbound(路由+投递);
 * - 出站:teamService 的 outbound 回调 → 按 channel 找适配器 → sendText。
 * - fail-closed:凭据缺失/格式错 → 适配器拒启并日志,不阻塞其余通道。
 */
import { appendFileSync } from 'node:fs'

export const name = 'dsh-orgos-im-gateway'

// 硬依赖:credentials 文档为异步 init,注入保证其就绪后才激活本行(官方模式)
export const inject = ['credentials']

export interface ImGatewayConfig {
  /** 通道配置:通道名(即路由 channel)→ { credentialId, provider? }。
   *  provider 标识该通道属于哪个 IM(feishu/telegram/...);
   *  声明了 provider 的 adapter factory 只为同 provider 的通道 build,
   *  避免多 IM 包互相用对方的凭据构建适配器(实测曾致 telegram 404 交叉污染)。 */
  channels?: Record<string, { credentialId: string; provider?: string }>
}

interface Ctx {
  get(key: string): unknown
  provide(key: string, value: unknown): void
  on(event: string, listener: (payload: never) => void): () => void
  effect(fn: () => () => void): void
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void }
  credentials: CredentialsLike
}

interface CredentialsLike {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

interface AdapterLike {
  channel: string
  start(): Promise<void>
  stop(): Promise<void>
  sendText(target: unknown, text: string): Promise<void>
  setWatchChats?(chatIds: string[]): void
}

interface AdapterFactory {
  /** 该 factory 服务的 IM 标识(与 channels[channel].provider 匹配;缺省 = 服务所有通道,兼容旧配置) */
  provider?: string
  /** 为一个通道实例构建适配器(channel 即 config.channels 的 key) */
  build(channel: string, rawCredential: string, handlers: {
    onInbound(msg: unknown): void
    onConnection(state: 'connected' | 'disconnected', reason?: string): void
  }): AdapterLike
}

export interface TeamImGateway {
  registerAdapter(factory: AdapterFactory): void
  sendText(channel: string, target: { kind: 'group' | 'direct'; id: string }, text: string): Promise<void>
  sendCard(channel: string, target: { kind: 'group' | 'direct'; id: string }, card: unknown): Promise<void>
  /** 设置通道需补偿关注的群(断线/重启窗口消息补投);adapter 未启动时缓存,启动后补推 */
  setWatchChats(channel: string, chatIds: string[]): void
}

export function apply(ctx: Ctx, config: ImGatewayConfig): void {
  const markerFile = '/tmp/orgos-gateway.markers.log'
  const mark = (event: string, detail?: string) => {
    try {
      appendFileSync(markerFile, `${new Date().toISOString()} ${event}${detail ? ' ' + detail : ''}\n`)
    } catch { /* ignore */ }
  }
  mark('gateway:apply channels=' + JSON.stringify(Object.keys(config.channels ?? {})))
  const factories: AdapterFactory[] = []
  const adapters = new Map<string, AdapterLike>()
  /** adapter 未启动前的 watch 缓存(channel → chatIds) */
  const pendingWatch = new Map<string, string[]>()
  const credentials = ctx.credentials

  const gateway: TeamImGateway = {
    registerAdapter(factory) {
      factories.push(factory)
      for (const [channel, channelCfg] of Object.entries(config.channels ?? {})) {
        // provider 匹配:声明了 provider 的 factory 只为同 provider 通道构建
        if (factory.provider !== undefined && channelCfg.provider !== factory.provider) continue
        void startChannel(factory, channel, channelCfg.credentialId)
      }
    },
    async sendText(channel, target, text) {
      const adapter = adapters.get(channel)
      mark(`sendText ${channel} adapter=${adapter !== undefined}`)
      if (!adapter) return
      try {
        await adapter.sendText(target, text)
        mark(`sendText ${channel} ok`)
      } catch (e) {
        mark(`sendText ${channel} FAIL ${String(e).slice(0, 150)}`)
      }
    },
    async sendCard(channel, target, card) {
      const adapter = adapters.get(channel) as (AdapterLike & { sendCard?(target: unknown, card: unknown): Promise<void> }) | undefined
      mark(`sendCard ${channel} adapter=${adapter !== undefined}`)
      if (!adapter || !adapter.sendCard) return
      try {
        await adapter.sendCard(target, card)
        mark(`sendCard ${channel} ok`)
      } catch (e) {
        mark(`sendCard ${channel} FAIL ${String(e).slice(0, 150)}`)
      }
    },
    setWatchChats(channel, chatIds) {
      const adapter = adapters.get(channel)
      if (adapter && adapter.setWatchChats) {
        adapter.setWatchChats(chatIds)
        mark(`watch ${channel} chats=${chatIds.length}`)
      } else {
        pendingWatch.set(channel, chatIds)
        mark(`watch ${channel} pending chats=${chatIds.length}`)
      }
    },
  }

  async function startChannel(factory: AdapterFactory, channel: string, credentialId: string): Promise<void> {
    try {
      mark(`channel:${channel} resolving ${credentialId}`)
      const resolved = await credentials.resolve(credentialId)
      mark(`channel:${channel} resolved=${resolved !== undefined}`)
      if (!resolved) {
        ctx.logger.warn(`[dsh-orgos-im] 通道 ${channel} 凭据未配置(credentialId=${credentialId}),fail-closed 拒启`)
        return
      }
      mark(`channel:${channel} building adapter`)
      const adapter = factory.build(channel, String(resolved.value), {
        onInbound(msg) {
          try {
            const m = msg as { channel?: string; peer?: { kind?: string; id?: string }; sender?: { id?: string }; kind?: string; content?: string }
            mark(`inbound ${m.channel} ${m.peer?.kind}@${m.peer?.id} sender=${m.sender?.id} kind=${m.kind} content=${String(m.content ?? '').slice(0, 40)}`)
            ;(ctx as unknown as { emit(event: string, payload: unknown): void }).emit('team/inbound-message', msg)
            const service = ctx.get('teamService') as { handleInbound(m: unknown): Promise<unknown> } | undefined
            void service?.handleInbound(msg)
              .then((r: unknown) => mark(`inbound-result ${JSON.stringify(r)}`))
              .catch((e: unknown) => mark(`inbound-FAIL ${String(e).slice(0, 200)}`))
          } catch (error) {
            mark('inbound ERROR ' + String(error).slice(0, 200))
            ctx.logger.warn('[dsh-orgos-im] 入站处理失败:', String(error))
          }
        },
        onConnection(state, reason) {
          mark(`channel:${channel} conn=${state}${reason ? ' ' + reason : ''}`)
          try {
            ;(ctx as unknown as { emit(event: string, payload: unknown): void }).emit(
              state === 'connected' ? 'team/im-connected' : 'team/im-disconnected',
              { channel, reason },
            )
          } catch {
            /* 事件发射失败不阻塞 */
          }
        },
      })
      mark(`channel:${channel} starting`)
      await adapter.start()
      adapters.set(channel, adapter)
      mark(`channel:${channel} started`)
      // 启动前的 watch 缓存补推(重连补偿窗口在 adapter 内部生效)
      const pending = pendingWatch.get(channel)
      if (pending !== undefined && adapter.setWatchChats) {
        adapter.setWatchChats(pending)
        mark(`watch ${channel} applied chats=${pending.length}`)
        pendingWatch.delete(channel)
      }
      ctx.logger.info(`[dsh-orgos-im] 通道 ${channel} 已连接`)
    } catch (error) {
      mark(`channel:${channel} FAIL ${String(error).slice(0, 200)}`)
      ctx.logger.warn(`[dsh-orgos-im] 通道 ${channel} 启动失败:`, String(error))
    }
  }

  ctx.provide('teamImGateway', gateway)
  ctx.effect(() => () => {
    for (const adapter of adapters.values()) void adapter.stop().catch(() => {})
  })
}
