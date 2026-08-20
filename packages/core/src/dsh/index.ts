/**
 * dsh-orgos-core —— host 侧 cordis 插件入口(bundle 行:name 'dsh-orgos-core/dsh')
 *
 * 提供跨会话服务 ctx.teamService(TeamService),负责:
 * - team.yml 加载/热重载(team_setup 变更后 re-load)
 * - 成员运行时(member-session 后端,懒激活)
 * - 团队心跳(interval 扫描,注入 orchestrator 成员)
 *
 * 两平面原则:本行属于 host composition(bundle patch),服务进程级单实例;
 * 工具注册在角色 preset 的 dsh-orgos-tools 行(agent 平面)。
 *
 * 硬依赖:agents / agentPresets(member-session 后端需要)。
 * 可选:credentials(IM 凭据由 im-gateway 行消费)。
 */
export const name = 'dsh-orgos-core'

// 硬依赖:成员运行时需要的官方服务,注入保证就绪(官方模式);
// credentials 供 member-dsh-sdk 子进程凭据注入(注入跨 bundle 边界,ctx.get 不可见)
export const inject = ['agents', 'agentPresets', 'credentials']

export interface TeamCoreConfig {
  stateRoot: string
  ownerIds: string[]
  allowlist?: string[]
  heartbeatIntervalMinutes?: number
  /** member-dsh-sdk 后端(C 阶段):配置后 agent 成员以官方 SDK 子进程常驻运行 */
  memberDshSdk?: {
    /** 官方 SDK 客户端模块绝对路径(如 checkout 的 packages/sdk/client/lib/index.js) */
    sdkClientEntry: string
    launch: { command: string; args: string[]; cwd?: string; env?: Record<string, string> }
    provider?: string
    model?: string
    maxTokens?: number
  }
}

// 本地轻量 cordis 形状(运行时结构兼容;TS 编译零依赖)
interface Ctx {
  get(key: string): unknown
  provide(key: string, value: unknown, immediate?: boolean): void
  on(event: string, listener: (...args: never[]) => void): () => void
  effect(fn: () => () => void): void
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void }
  agents: unknown
  agentPresets: unknown
  credentials: { resolve(ref: string): Promise<{ value: string } | undefined> }
}

import { join } from 'node:path'
import { TeamService, type TeamServiceOptions } from './teamService.js'
import { makeUserMessage } from './memberRuntime.js'
import { seedPresets } from './seeder.js'
import { marker } from './store.js'

export async function apply(ctx: Ctx, config: TeamCoreConfig): Promise<void> {
  marker(config.stateRoot, 'core', 'apply')
  const agents = ctx.agents
  const presets = ctx.agentPresets

  // member-dsh-sdk 子进程 env:官方 SDK 客户端按"整体替换"语义接管子环境
  // (scrubbed parent env 不含凭据),因此必须显式携带可执行解析所需的 PATH/HOME,
  // 并经父进程 credentials 服务解析 DEEPSEEK_API_KEY 注入(密钥零落配置/日志)。
  if (config.memberDshSdk !== undefined) {
    const launchEnv: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '',
      ...(config.memberDshSdk.launch.env ?? {}),
    }
    if (launchEnv.DEEPSEEK_API_KEY === undefined) {
      // inject 注入的 credentials 跨 bundle 边界可见(ctx.get 在 bundle 域内不可见);
      // 解析结果只记状态 marker,密钥零落盘/日志
      const resolved = await ctx.credentials.resolve('DEEPSEEK_API_KEY')
      if (resolved?.value !== undefined && resolved.value !== '') launchEnv.DEEPSEEK_API_KEY = resolved.value
      marker(config.stateRoot, 'core', 'sdk-cred', launchEnv.DEEPSEEK_API_KEY === undefined ? 'resolve-empty' : 'ok')
    }
    config.memberDshSdk.launch.env = launchEnv
  }
  const options: TeamServiceOptions = {
    stateRoot: config.stateRoot,
    ownerIds: config.ownerIds ?? [],
    allowlist: config.allowlist,
    agents: agents as never,
    presets: presets as never,
    ...(config.memberDshSdk ? { sdkMember: config.memberDshSdk } : {}),
    defaultModel: (ctx.get('agentDefaultModel') ?? undefined) as never,
    emit: (event, payload) => {
      try {
        ;(ctx as unknown as { emit(event: string, payload: unknown): void }).emit(`team/${event.replace(/^team\//, '')}`, payload)
      } catch {
        /* 事件发射失败不阻塞业务 */
      }
    },
    // 出站回路:回复/任务卡经 IM 网关回送(网关行可能稍后激活,延迟获取)
    outbound: (target, text) => {
      try {
        const gateway = ctx.get('teamImGateway') as
          | { sendText(channel: string, peer: unknown, text: string): Promise<void> }
          | undefined
        if (gateway) void gateway.sendText(target.channel, target.peer, text)
        else marker(config.stateRoot, 'core', 'outbound', 'gateway-unavailable')
      } catch (error) {
        marker(config.stateRoot, 'core', 'outbound', 'ERROR ' + String(error).slice(0, 150))
      }
    },
    outboundCard: (target, card) => {
      try {
        const gateway = ctx.get('teamImGateway') as
          | { sendCard(channel: string, peer: unknown, card: unknown): Promise<void> }
          | undefined
        if (gateway) void gateway.sendCard(target.channel, target.peer, card)
        else marker(config.stateRoot, 'core', 'outbound-card', 'gateway-unavailable')
      } catch (error) {
        marker(config.stateRoot, 'core', 'outbound-card', 'ERROR ' + String(error).slice(0, 150))
      }
    },
  }
  const service = new TeamService(options)
  const loaded = service.load()
  marker(config.stateRoot, 'core', 'load', JSON.stringify(loaded))
  ctx.provide('teamService', service)

  // 断线补偿:把路由中的群列表推给 IM 网关(setWatchChats),适配器重连后拉取最近窗口补投;
  // bind/unbind/init 变更时(routes-changed 事件)重推。
  const pushWatchChats = (): void => {
    const gw = ctx.get('teamImGateway') as { setWatchChats?(channel: string, chatIds: string[]): void } | undefined
    if (gw?.setWatchChats === undefined) return
    for (const { channel, chatIds } of service.watchChatsByChannel()) {
      if (chatIds.length > 0) gw.setWatchChats(channel, chatIds)
    }
  }
  pushWatchChats()
  ctx.on('team/routes-changed', pushWatchChats)

  // 诊断:preset roster(含 broken 原因)
  void Promise.resolve()
    .then(() => (presets as { list(): Promise<Array<{ id: string; broken?: string; path?: string }>> }).list())
    .then((list) => marker(config.stateRoot, 'core', 'presets', JSON.stringify(list.map((p) => ({ id: p.id, broken: p.broken ?? null })))))
    .catch((e) => marker(config.stateRoot, 'core', 'presets', 'ERROR ' + String(e).slice(0, 200)))

  // team-ui 数据源:HTTP 只读快照(根视角;scope 投影在工具层强制,面板供 Web 根用户)
  const webServer = ctx.get('webServer') as
    | { register(route: { kind: 'exact'; path: string; handler(req: unknown, res: { statusCode: number; setHeader(k: string, v: string): void; end(body: string): void }): void }): () => void }
    | undefined
  if (webServer) {
    webServer.register({
      kind: 'exact',
      path: '/api/orgos/snapshot',
      handler: (_req, res) => {
        try {
          const body = JSON.stringify({
            ...service.snapshot(),
            run: service.runReport('web-root', 20).summary,
            doctor: service.doctor(),
          })
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json')
          res.end(body)
        } catch (error) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(error) }))
        }
      },
    })
  }

  // 成员状态折叠:agent/status(全局 emit)→ 岗位状态(M1 收尾①)
  // 官方事件签名 = 单参数 { agent, status }(scoped emit 注入 agent;rc.7 起即此形态,
  // 此前两参数解构致状态永不更新——实跑暴露)
  ctx.on('agent/status', ((payload: { agent?: { id?: string }; status?: string }) => {
    const agentId = payload?.agent?.id
    const status = payload?.status
    if (!agentId?.startsWith('orgos-member-')) return
    const positionId = agentId.slice('orgos-member-'.length)
    service.setMemberStatus(positionId, status === 'running' ? 'busy' : 'idle')
  }) as never)

  // 角色 preset 自动播种(ADR-003:只写用户 root 自有命名空间,绝不覆盖已有)
  if (process.env.DSH_HOME) {
    const seeded = seedPresets(join(process.env.DSH_HOME, '.agent-presets'), (msg) => ctx.logger.info(msg))
    if (seeded.errors.length > 0) {
      for (const err of seeded.errors) ctx.logger.warn(`[dsh-orgos] 预设播种失败: ${err}`)
    }
  }

  // 团队心跳:周期扫描,向各层 orchestrator 成员注入心跳摘要(技术设计 §10.3)
  const intervalMinutes = config.heartbeatIntervalMinutes ?? 10
  const timer = setInterval(() => {
    try {
      if (!service.loaded) return
      const report = service.heartbeatReport()
      const agentsSvc = agents as { list(): Array<{ id: string; inject(msg: unknown): void }> }
      for (const agent of agentsSvc.list()) {
        if (agent.id.startsWith('orgos-member-')) {
          agent.inject(makeUserMessage(report.text, { kind: 'plugin', plugin: 'dsh-orgos', form: 'heartbeat' }))
        }
      }
    } catch (error) {
      ctx.logger.warn('[dsh-orgos-core] 心跳扫描失败:', String(error))
    }
  }, intervalMinutes * 60_000)
  ctx.effect(() => () => clearInterval(timer))
  // 服务停止:回收成员后端(dsh-sdk 子进程 dispose 阶梯;session 句柄释放)
  ctx.effect(() => () => {
    void service.disposeMemberBackends()
  })
}
