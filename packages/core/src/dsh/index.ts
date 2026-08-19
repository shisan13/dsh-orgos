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

// 硬依赖:成员运行时需要的官方服务,注入保证就绪(官方模式)
export const inject = ['agents', 'agentPresets']

export interface TeamCoreConfig {
  stateRoot: string
  ownerIds: string[]
  allowlist?: string[]
  heartbeatIntervalMinutes?: number
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
}

import { join } from 'node:path'
import { TeamService, type TeamServiceOptions } from './teamService.js'
import { makeUserMessage } from './memberRuntime.js'
import { seedPresets } from './seeder.js'
import { marker } from './store.js'

export function apply(ctx: Ctx, config: TeamCoreConfig): void {
  marker(config.stateRoot, 'core', 'apply')
  const agents = ctx.agents
  const presets = ctx.agentPresets

  const options: TeamServiceOptions = {
    stateRoot: config.stateRoot,
    ownerIds: config.ownerIds ?? [],
    allowlist: config.allowlist,
    agents: agents as never,
    presets: presets as never,
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
  ctx.on('agent/status', ((agent: { id: string }, status: string) => {
    if (!agent?.id?.startsWith('orgos-member-')) return
    const positionId = agent.id.slice('orgos-member-'.length)
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
}
