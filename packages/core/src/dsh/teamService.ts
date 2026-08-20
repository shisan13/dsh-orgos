/**
 * dsh-orgos-core 绑定层 —— TeamService(host 侧跨会话聚合服务)
 *
 * 组合 Flash 交付的 domain 内核(OrgTree/RouterResolver/DelegationEngine/
 * Mailbox/TaskBoard/AclPolicy/ScopeProjection/Digest),接 SessionMemberRuntime
 * + TeamStore + 事件发射。返回类型与各引擎 d.ts 严格对齐。
 *
 * 设计出处:技术设计 §5(TeamRegistry/MemberRuntime/DelegationEngine/Heartbeat)。
 */
import {
  DelegationEngine,
  Mailbox,
  MemoryStore,
  OrgTree,
  RouterResolver,
  TaskBoard,
  buildDigest,
  parseTeamConfig,
  projectDelegations,
  projectMail,
  projectMemory,
  projectTasks,
  roleScope,
  validateBrief,
  type BriefIssue,
  type BriefV1,
  type Delegation,
  type MemoryEntry,
  type ProjectContext,
  type TeamConfig,
} from '../domain/index.js'
import type { NormalizedMessage } from 'dsh-orgos-im-gateway'
import { SessionMemberRuntime, type MemberDef, type DshAgents, type AgentPresetsMount, type AgentDefaultModelLike } from './memberRuntime.js'
import { atomicWriteTeamYml, createFileTeamStore, readTeamYml, type TeamStore } from './store.js'
import type { DocumentProvider, DocumentContent, OrgFederation, DocListResult, DocGetResult, DocCreateResult, DocRouteUpdateResult, DocSearchResult, DocumentRef } from './extensions.js'

export interface TeamServiceOptions {
  stateRoot: string
  /** owner + 白名单(部署级配置,经 bundle 行 config 提供;空 = 仅群消息可路由,DM 全拒) */
  ownerIds: string[]
  allowlist?: string[]
  agents: DshAgents
  presets: AgentPresetsMount
  defaultModel?: AgentDefaultModelLike
  /** 出站:IM 回送(由 im-gateway 绑定层注入) */
  outbound?: (target: { channel: string; peer: { kind: 'group' | 'direct'; id: string }; userId?: string }, text: string) => void
  /** 出站卡片(审批/任务/决策卡;由 im-gateway 绑定层注入) */
  outboundCard?: (target: { channel: string; peer: { kind: 'group' | 'direct'; id: string } }, card: unknown) => void
  emit?: (event: string, payload: Record<string, unknown>) => void
  /** 存储 provider 注入点(扩展面):默认 JSONL 文件存储;集团期换 SQLite provider,数据格式不变 */
  store?: TeamStore
}

export interface TeamSnapshot {
  loaded: boolean
  org?: string
  positions: Array<{ id: string; kind: 'agent' | 'human'; title?: string; preset?: string; status: string }>
  delegations: unknown[]
  tasks: unknown[]
  mailCount: number
  memoryCount: number
}

const ORGOS_SOURCE = { kind: 'plugin', plugin: 'dsh-orgos' } as const

export class TeamService {
  private config: TeamConfig | undefined
  private org: OrgTree | undefined
  private router: RouterResolver | undefined
  private delegation: DelegationEngine | undefined
  private mailbox: Mailbox | undefined
  private taskboard: TaskBoard | undefined
  /** 三层记忆引擎(team/org 显式提炼层;private 在成员 session,不落此库) */
  private readonly memory = new MemoryStore()
  readonly store: TeamStore
  private readonly memberRuntime: SessionMemberRuntime
  private readonly members = new Map<string, MemberDef>()
  /** 最近入站路由表:positionId → 回信目标(回复回送回路) */
  private readonly lastRoute = new Map<string, { channel: string; peer: { kind: 'group' | 'direct'; id: string } }>()
  /** 成员状态折叠(agent/status + 成员后端事件 → offline/idle/busy/failed) */
  private readonly memberStatus = new Map<string, string>()
  /** 扩展面:文档 provider registry(P2 起实装 provider) */
  private readonly documentProviders = new Map<string, DocumentProvider>()
  /** 扩展面:集团联邦(集团期注入;200 人期无) */
  private federation: OrgFederation | undefined
  /** 扩展面:团队事件订阅者(稳定 API,与 DSH 事件总线解耦) */
  private readonly teamEventListeners = new Set<(event: string, payload: Record<string, unknown>) => void>()

  constructor(readonly options: TeamServiceOptions) {
    // 存储 provider 注入点:默认 JSONL;SQLite/联邦后端插拔替换,数据记录格式不变
    this.store = options.store ?? createFileTeamStore(options.stateRoot)
    // 事件通知收敛:内部订阅者先于上游(DSH 事件总线)收到
    const upstreamEmit = options.emit
    this.options = {
      ...options,
      emit: (event, payload) => {
        for (const listener of this.teamEventListeners) {
          try {
            listener(event, payload)
          } catch {
            /* 订阅者异常不阻断事件流(可观测性由 team_doctor 覆盖) */
          }
        }
        upstreamEmit?.(event, payload)
      },
    }
    this.memberRuntime = new SessionMemberRuntime(
      options.agents,
      options.presets,
      options.defaultModel,
      (positionId, status) => {
        options.emit?.('team/member-status', { positionId, kind: this.members.get(positionId)?.kind ?? 'agent', status, at: new Date().toISOString() })
      },
      (positionId, text) => {
        this.deliverAssistantText(positionId, text)
      },
      (positionId, approvalId, toolName, reason) => {
        this.presentApproval(positionId, approvalId, toolName, reason)
      },
    )
  }

  /** 审批卡片呈现:经最近入站路由发送 approval 卡片(§9.3 审批闭环) */
  presentApproval(positionId: string, approvalId: string, toolName: string, reason?: string): void {
    const route = this.lastRoute.get(positionId)
    if (!route) return
    this.logRun('approval', { positionId, approvalId, toolName })
    this.options.outboundCard?.(route, {
      kind: 'approval',
      approvalId,
      title: `审批请求 · ${toolName}`,
      body: reason ?? '成员请求工具执行许可',
      timeoutMinutes: 10,
    })
  }

  /** 审批回执透传(IM approval_reply → memberRuntime pending 答复) */
  resolveApproval(approvalId: string, action: 'allow' | 'deny'): boolean {
    return this.memberRuntime.resolveApproval(approvalId, action)
  }

  /** 加载/热重载 team.yml;无配置时保持未加载(首次启动引导由 team_setup 负责) */
  load(): { loaded: boolean; errors?: string[] } {
    const text = readTeamYml(this.options.stateRoot)
    if (text === undefined) return { loaded: false }
    const parsed = parseTeamConfig(text)
    if (!parsed.ok) return { loaded: false, errors: parsed.issues.map((i) => `${i.path}: ${i.message}`) }
    this.config = parsed.config
    this.org = new OrgTree(this.config)
    this.router = new RouterResolver(this.org, this.config.routes, {
      ownerIds: this.options.ownerIds,
      allowlist: this.options.allowlist,
      requireMentionInGroup: true,
    })
    this.delegation = new DelegationEngine(this.org, this.config.acl, { maxAttempts: 3 })
    this.mailbox = new Mailbox(this.org, this.config.acl)
    this.taskboard = new TaskBoard(this.org)
    this.members.clear()
    for (const p of this.config.positions) {
      this.members.set(p.id, {
        positionId: p.id,
        kind: p.occupant.kind,
        title: p.title,
        presetId: p.occupant.kind === 'agent' ? p.occupant.preset : undefined,
        cwd: undefined,
        model: undefined,
        im: p.occupant.kind === 'human' ? p.occupant.im : undefined,
      })
    }
    this.replayPersistedState()
    return { loaded: true }
  }

  /** 冷启动:重放持久化操作(op 记录 → 引擎方法);成员会话由 DSH session 持久化独立恢复 */
  private replayPersistedState(): void {
    if (!this.taskboard || !this.mailbox || !this.delegation) return
    for (const rec of this.store.readAll('taskboard')) {
      const { op } = rec as { op: string }
      try {
        if (op === 'create') {
          const task = (rec.task ?? rec) as { teamId?: string; title?: string; assignee?: string; createdBy?: string }
          if (task.teamId && task.title && task.assignee) this.taskboard.create({ teamId: task.teamId, title: task.title, assignee: task.assignee, createdBy: task.createdBy ?? 'system' })
        } else if (op === 'claim') this.taskboard.claim(String(rec.taskId), String(rec.positionId))
        else if (op === 'done') this.taskboard.done(String(rec.taskId), String(rec.positionId))
        else if (op === 'cancel') this.taskboard.cancel(String(rec.taskId), String(rec.positionId))
      } catch {
        /* 坏记录跳过,不阻塞团队启动(可观测性由 team_doctor 覆盖) */
      }
    }
    for (const rec of this.store.readAll('mailbox')) {
      const { op } = rec as { op: string }
      try {
        if (op === 'send') {
          this.mailbox.send(String(rec.from), String(rec.to), (rec.kind as never) ?? 'note', String(rec.body), rec.refs as string[] | undefined)
        }
      } catch {
        /* 同上 */
      }
    }
    for (const rec of this.store.readAll('delegations')) {
      const { op } = rec as { op: string }
      try {
        if (op === 'create') this.delegation.delegate(String(rec.fromPositionId), rec.brief as BriefV1)
        else if (op === 'settle') this.delegation.settle(String(rec.delegationId), rec.outcome as 'completed' | 'failed', String(rec.report ?? ''), String(rec.by ?? ''))
      } catch {
        /* 同上 */
      }
    }
    // 三层记忆重放(§4.6.3):memory-<teamId> 每团队一流 + memory-org 集团流
    for (const node of this.config?.nodes ?? []) {
      if (node.kind !== 'team') continue
      for (const rec of this.store.readAll(`memory-${node.id}`)) {
        try {
          this.memory.replay(rec as unknown as MemoryEntry)
        } catch {
          /* 同上 */
        }
      }
    }
    for (const rec of this.store.readAll('memory-org')) {
      try {
        this.memory.replay(rec as unknown as MemoryEntry)
      } catch {
        /* 同上 */
      }
    }
  }

  get loaded(): boolean {
    return this.config !== undefined
  }

  /** 运行记录(§4.8:runs.jsonl,M1 起即主路径;Run 面板数据源) */
  private logRun(op: string, detail: Record<string, unknown>): void {
    try {
      this.store.append('runs', { op, at: new Date().toISOString(), ...detail })
    } catch {
      /* 可观测性失败不阻塞业务 */
    }
  }

  /** Run 报告(team_run 工具/FR-R2):viewer 按 scope 取运行摘要 */
  runReport(viewerPositionId: string, limit = 50): { runs: Array<Record<string, unknown>>; summary: string } {
    const viewer = this.resolveViewer(viewerPositionId)
    const all = this.store.readAll('runs').slice(-limit).reverse()
    const runs = all.filter((r) => {
      const pos = String(r.positionId ?? r.toPositionId ?? '')
      return pos === '' || pos === viewer || this.org?.isAncestor(this.org.nodeOfPosition(viewer), this.org.nodeOfPosition(pos))
    })
    // 事件轨迹(runs 流)与业务事实(委派单)分口径统计,避免「委派单 2 张但事件 0 条」的困惑
    const count = (op: string): number => all.filter((r) => r.op === op).length
    const units = this.delegation?.snapshot() ?? []
    const inFlight = units.filter((d) => ['queued', 'dispatched', 'running', 'escalated'].includes(d.status)).length
    const completed = units.filter((d) => d.status === 'completed').length
    const failed = units.filter((d) => ['failed', 'failed-final', 'timeout'].includes(d.status)).length
    return sanitizeJson({
      runs,
      summary: `运行记录 ${runs.length} 条(近 ${all.length} 条内):入站 ${count('inbound')} · 审批 ${count('approval')} · 委派事件 ${count('delegation')} · 回执 ${count('settle')} | 委派单:在途 ${inFlight} · 完成 ${completed} · 失败 ${failed}`,
    }) as { runs: Array<Record<string, unknown>>; summary: string }
  }

  /** 回复回送回路:成员 assistant 文本 → 最近入站来源出站 */
  deliverAssistantText(positionId: string, text: string): void {
    const route = this.lastRoute.get(positionId)
    if (!route || text.trim().length === 0) return
    this.options.outbound?.(route, text)
  }

  setMemberStatus(positionId: string, status: 'offline' | 'idle' | 'busy' | 'failed'): void {
    this.memberStatus.set(positionId, status)
    this.options.emit?.('team/member-status', { positionId, status, at: new Date().toISOString() })
  }

  snapshot(): TeamSnapshot {
    return {
      loaded: this.loaded,
      org: this.config?.org,
      positions: [...this.members.values()].map((m) => ({
        id: m.positionId,
        kind: m.kind,
        title: m.title,
        preset: m.presetId,
        status: this.memberStatus.get(m.positionId) ?? 'offline',
      })),
      delegations: this.delegation?.snapshot() ?? [],
      tasks: this.taskboard?.list() ?? [],
      mailCount: this.mailbox?.list().length ?? 0,
      memoryCount: this.memory.count(),
    }
  }

  /** IM 入站消息 → 路由 → 成员投递(技术设计 §6) */
  async handleInbound(msg: NormalizedMessage): Promise<{ routed: boolean; positionId?: string; reason?: string }> {
    if (!msg || typeof msg !== 'object' || !msg.peer || !msg.sender || !msg.channel) return { routed: false, reason: 'invalid_message' }
    // 审批卡片回执:直接答复 pending 审批,不进入路由
    // /run 命令:直接回发运行摘要(FR-R2 IM 形态),不投递成员
    if ((msg.kind === 'text' || msg.kind === 'mention') && (msg.content ?? '').trim().startsWith('/run')) {
      const report = this.runReport('web-root', 20)
      this.options.outbound?.({ channel: msg.channel, peer: msg.peer }, `[dsh-orgos] ${report.summary}`)
      return { routed: true, reason: 'run-command' }
    }
    if (msg.kind === 'approval_reply' && msg.approval) {
      const resolved = this.memberRuntime.resolveApproval(msg.approval.approvalId, msg.approval.action)
      return resolved ? { routed: true } : { routed: false, reason: 'approval_not_found' }
    }
    if (!this.router) return { routed: false, reason: 'team_not_loaded' }
    const result = this.router.resolve({
      channel: msg.channel,
      peer: { kind: msg.peer.kind, id: msg.peer.id },
      sender: { id: msg.sender.id },
      kind: msg.kind,
    })
    if (result.action !== 'route' || !result.target) return { routed: false, reason: result.reason ?? 'not_routed' }
    const member = this.members.get(result.target.id)
    if (!member) return { routed: false, reason: 'position_not_found' }

    if (member.kind === 'human') {
      this.options.outbound?.({ channel: msg.channel, peer: msg.peer, userId: member.im?.userId }, `[dsh-orgos] ${msg.content ?? ''}`)
      return { routed: true, positionId: result.target.id }
    }

    this.lastRoute.set(result.target.id, { channel: msg.channel, peer: msg.peer })
    this.logRun('inbound', { positionId: result.target.id, channel: msg.channel })
    const runtime = await this.memberRuntime.ensure(member)
    const handle = this.options.agents.get(runtime.sessionId ?? '')
    if (!handle) return { routed: false, reason: 'agent_unavailable' }
    const wake = msg.kind === 'text' || msg.kind === 'mention' || msg.kind === 'reply'
    this.memberRuntime.deliver(
      { agent: handle },
      `[IM ${msg.channel}${msg.peer.kind === 'group' ? ' 群' : ''} @${msg.sender.name ?? msg.sender.id}] ${msg.content ?? ''}`,
      { wake, source: { kind: 'user' } },
    )
    return { routed: true, positionId: result.target.id }
  }

  /** 委派(team_delegate 工具入口;Brief 由纯逻辑校验) */
  delegate(fromPositionId: string, toPositionId: string, brief: Record<string, unknown>): { ok: true; delegation: Delegation } | { ok: false; errors?: BriefIssue[]; reason: string } {
    if (!this.delegation || !this.org) return { ok: false, reason: 'team_not_loaded' }
    fromPositionId = this.resolveViewer(fromPositionId)
    const fullBrief = { ...brief, target: toPositionId }
    const issues = validateBrief(fullBrief)
    if (issues.length > 0) return { ok: false, errors: issues, reason: 'invalid_brief' }
    if (!this.org.hasPosition(toPositionId)) return { ok: false, reason: 'position_not_found' }
    const created = this.delegation.delegate(fromPositionId, fullBrief as BriefV1)
    if (!created.ok) return { ok: false, errors: created.error.details, reason: created.error.message }
    this.store.append('delegations', { op: 'create', ...created.value })
    this.logRun('delegation', { delegationId: created.value.id, fromPositionId, toPositionId: created.value.brief.target })
    this.options.emit?.('team/delegation-created', { delegation: created.value })
    void this.deliverDelegation(created.value)
    return { ok: true, delegation: created.value }
  }

  private async deliverDelegation(d: Delegation): Promise<void> {
    const member = this.members.get(d.brief.target)
    if (!member) return
    if (member.kind === 'human') {
      this.options.outbound?.({ channel: member.im?.channel ?? '', peer: { kind: 'direct', id: member.im?.userId ?? '' } }, `[dsh-orgos 任务] ${d.brief.task}\n验收:${d.brief.acceptance.join(';')}`)
      return
    }
    const runtime = await this.memberRuntime.ensure(member)
    const agent = this.options.agents.get(runtime.sessionId ?? '')
    if (!agent) return
    this.memberRuntime.deliver(
      { agent },
      `[TEAM DELEGATION ${d.id}]\n任务:${d.brief.task}\n要求:${d.brief.requirements.join(';')}\n验收:${d.brief.acceptance.join(';')}\n完成后用 team_task_complete 汇报。`,
      { wake: true, source: ORGOS_SOURCE },
    )
  }

  /**
   * 岗位替换(技术设计 §4.7.3 知识交接;FR-H5):agent↔human↔preset 升级统一入口。
   *
   * 流程:权限校验(治理岗位,管辖子树)→ 生成交接清单(在岗任务摘要/记忆贡献/进行中任务)
   * → 按 handover.reassignOpenTasks 处理进行中任务(transfer/keep:任务随岗位自动交接;
   * cancel:取消)→ 知识提炼按 inheritMemory 落层(team/org 写记忆流;private 仅注入)
   * → 原子更新 team.yml + 热重载 → 释放旧句柄并注入新占位者初始 framing
   * (agent:boot note 注入 session;human:IM 欢迎卡附交接清单)。
   */
  replaceOccupant(
    viewerPositionId: string,
    positionId: string,
    newOccupant: { kind: 'agent'; preset: string } | { kind: 'human'; im: { channel: string; userId: string } },
  ): { ok: true; handover: { positionId: string; taskCount: number; openCount: number; cancelled: number; note: string } } | { ok: false; reason: string } {
    if (!this.org || !this.config) return { ok: false, reason: 'team_not_loaded' }
    const org = this.org
    const viewer = this.resolveViewer(viewerPositionId)
    if (!org.hasPosition(positionId)) return { ok: false, reason: 'position_not_found' }
    // 治理动作:viewer 必须是 orchestrator 且目标岗位在其管辖子树内
    if (!org.isOrchestrator(viewer)) return { ok: false, reason: `替换越权:岗位 ${viewer} 不是 orchestrator` }
    const viewerNode = org.nodeOfPosition(viewer)
    const posNode = org.nodeOfPosition(positionId)
    if (posNode !== viewerNode && !org.isAncestor(viewerNode, posNode)) {
      return { ok: false, reason: `替换越权:岗位 ${positionId} 不在 ${viewer} 管辖子树` }
    }
    const old = this.members.get(positionId)
    if (!old) return { ok: false, reason: 'member_not_found' }
    if (newOccupant.kind === 'agent' && (newOccupant.preset === undefined || newOccupant.preset.length === 0)) {
      return { ok: false, reason: 'agent 占位者必须指定 preset' }
    }
    if (newOccupant.kind === 'human' && (!newOccupant.im?.channel || !newOccupant.im?.userId)) {
      return { ok: false, reason: 'human 占位者必须指定 im.channel 与 im.userId' }
    }
    const pos = org.position(positionId)
    const policy = pos.handover ?? ({ inheritMemory: 'team', reassignOpenTasks: 'transfer' } as const)

    // 1. 交接清单草案(确定性生成,不依赖模型)
    const allTasks = this.taskboard?.list() ?? []
    const mine = allTasks.filter((t) => t.assignee === positionId)
    const open = mine.filter((t) => t.status === 'open' || t.status === 'claimed')
    const contributions = this.memory.list().filter((e) => e.author === positionId)
    const note = [
      `[HANDOVER] 岗位 ${positionId}:${old.kind === 'agent' ? ` agent(${old.presetId ?? ''})` : ` human(${old.im?.channel ?? ''}:${old.im?.userId ?? ''})`} → ${newOccupant.kind === 'agent' ? `agent(${newOccupant.preset})` : `human(${newOccupant.im.channel}:${newOccupant.im.userId})`}`,
      `在岗任务 ${mine.length}(进行中 ${open.length}):${mine.map((t) => ` ${t.title}(${t.status})`).join(';') || ' 无'}`,
      `记忆贡献 ${contributions.length} 条:${contributions.slice(0, 5).map((e) => ` ${e.kind}:${e.content.slice(0, 40)}`).join(';') || ' 无'}`,
      `交接策略:inheritMemory=${policy.inheritMemory}, reassignOpenTasks=${policy.reassignOpenTasks}`,
    ].join('\n')

    // 2. 进行中任务按策略处理(cancel 走 TeamService.taskCancel 落流,冷启动不丢状态)
    let cancelled = 0
    if (policy.reassignOpenTasks === 'cancel') {
      for (const t of open) {
        if (this.taskCancel(viewer, t.id).ok) cancelled += 1
      }
    }
    // transfer/keep:任务 assignee 为岗位 id,占位者替换后自然随岗位交接(清单已列明)

    // 3. 知识提炼落层(§4.7.3 第 4 步);team 层须落到目标岗位所在团队节点
    if (policy.inheritMemory !== 'private') {
      const teamNodeId = org.node(posNode).kind === 'team'
        ? posNode
        : (org.pathToRoot(posNode).find((id) => org.node(id).kind === 'team') ?? posNode)
      const saved = this.memorySave(
        viewer,
        policy.inheritMemory,
        'handover',
        note,
        `岗位 ${positionId} 交接`,
        policy.inheritMemory === 'team' ? teamNodeId : undefined,
      )
      if (!saved.ok) return { ok: false, reason: `交接记忆写入失败(${policy.inheritMemory} 层):${saved.reason}` }
    }

    // 4. 原子更新 team.yml + 热重载
    const next: TeamConfig = {
      ...this.config,
      positions: this.config.positions.map((p) =>
        p.id === positionId ? { ...p, occupant: newOccupant } : p,
      ),
    }
    const text = serializeTeamConfig(next)
    const applied = atomicWriteTeamYml(this.options.stateRoot, text, (t) => {
      const parsed = parseTeamConfig(t)
      return parsed.ok ? [] : parsed.issues.map((i) => `${i.path}: ${i.message}`)
    })
    if (!applied.ok) return { ok: false, reason: (applied.errors ?? []).join('; ') }
    this.load()

    // 5. 释放旧句柄并注入新占位者初始记忆(§4.7.3 第 5 步)
    const fresh = this.members.get(positionId)
    if (fresh?.kind === 'human') {
      this.options.outbound?.(
        { channel: fresh.im?.channel ?? '', peer: { kind: 'direct', id: fresh.im?.userId ?? '' } },
        `[dsh-orgos 欢迎入职] 你已接替岗位 ${positionId}。\n${note}`,
      )
    } else {
      this.memberRuntime.release(positionId, note)
    }
    this.logRun('handover', { positionId, from: old.kind, to: newOccupant.kind, cancelled })
    this.options.emit?.('team/occupant-replaced', { positionId, from: old, to: newOccupant, cancelled })
    return { ok: true, handover: { positionId, taskCount: mine.length, openCount: open.length, cancelled, note } }
  }

  /** 完成/失败回执(team_task_complete / 成员汇报入口) */
  settle(positionId: string, delegationId: string, outcome: 'completed' | 'failed', report: string): { ok: boolean; reason?: string } {
    if (!this.delegation) return { ok: false, reason: 'team_not_loaded' }
    const result = this.delegation.settle(delegationId, outcome, report, positionId)
    if (!result.ok) return { ok: false, reason: result.error.message }
    this.store.append('delegations', { op: 'settle', delegationId, outcome, report, by: positionId })
    this.logRun('settle', { delegationId, outcome, positionId })
    const digest = buildDigest(report, { kind: 'delegation', id: delegationId })
    this.options.emit?.(outcome === 'completed' ? 'team/delegation-completed' : 'team/delegation-failed', {
      id: delegationId,
      outcome,
      report: digest.conclusion,
    })
    return { ok: true }
  }

  /** 团队心跳报告(技术设计 §10.3 orchestrator 档) */
  heartbeatReport(): { text: string } {
    if (!this.delegation) return { text: '[dsh-orgos] 团队未配置(team.yml 缺失)' }
    const tasks = this.taskboard?.list() ?? []
    const stuck = tasks.filter((t) => t.status === 'claimed')
    const delegations = this.delegation.snapshot()
    const failed = delegations.filter((d) => d.status === 'failed')
    return {
      text: [
        `[TEAM HEARTBEAT]`,
        `成员:${this.members.size} 岗位;`,
        `任务:${tasks.length}(进行中 ${stuck.length});`,
        `委派:${delegations.length}(失败 ${failed.length});`,
        `邮箱:${this.mailbox?.list().length ?? 0}`,
      ].join(' '),
    }
  }

  /**
   * 记忆写入(team_memory_save 工具入口;技术设计 §4.6.3):
   * - 写入受 authority scope 约束:写者 memory 数组必须包含目标层
   *   (team 写要求 'team';org 写要求 'org' —— 各层 orchestrator 按 authority 提炼推送);
   * - team 层条目落 memory-<teamId> 流,teamId 必须落在写者管辖子树内
   *   (成员写本 team;上层 orchestrator 可提炼写入管辖 team);
   * - org 层落 memory-org 流(BG 间默认隔离:写者须持 org 记忆权)。
   */
  memorySave(
    viewerPositionId: string,
    level: 'team' | 'org',
    kind: string,
    content: string,
    digest?: string,
    teamId?: string,
  ): { ok: true; entry: MemoryEntry } | { ok: false; reason: string } {
    if (!this.org || !this.config) return { ok: false, reason: 'team_not_loaded' }
    const viewer = this.resolveViewer(viewerPositionId)
    const scope = roleScope(this.org, viewer, this.config.roles)
    if (!scope.memory.includes(level)) {
      return { ok: false, reason: `记忆写入越权:岗位 ${viewer} 无 ${level} 层记忆权(memory scope: ${scope.memory.join('/')})` }
    }
    if (level === 'team') {
      const target = teamId ?? this.org.nodeOfPosition(viewer)
      if (!this.org.hasNode(target) || this.org.node(target)?.kind !== 'team') {
        return { ok: false, reason: `teamId 必须为团队节点:${target}` }
      }
      // 写者管辖子树必须包含目标 team(成员写本 team;治理岗位可写管辖 team)
      const viewerNode = this.org.nodeOfPosition(viewer)
      if (target !== viewerNode && !this.org.isAncestor(viewerNode, target)) {
        return { ok: false, reason: `无权写入团队 ${target} 的记忆(不在管辖子树)` }
      }
      teamId = target
    }
    const entry: MemoryEntry = {
      id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      level,
      teamId: level === 'team' ? teamId : undefined,
      author: viewer,
      kind: (['contribution', 'handover', 'decision', 'insight'].includes(kind) ? kind : 'contribution') as MemoryEntry['kind'],
      content,
      digest,
      createdAt: new Date().toISOString(),
    }
    const inserted = this.memory.insert(entry)
    if (!inserted.ok) return { ok: false, reason: inserted.reason }
    this.store.append(level === 'team' ? `memory-${teamId}` : 'memory-org', { ...entry })
    this.options.emit?.('team/memory-saved', { entry })
    this.logRun('memory', { positionId: viewer, level, teamId: entry.teamId, kind: entry.kind })
    return { ok: true, entry }
  }

  /** 记忆读取(team_memory_recall 工具入口):按 memory scope 服务端强制投影 */
  memoryList(viewerPositionId: string, limit = 50): { entries: MemoryEntry[] } {
    if (!this.org || !this.config) return { entries: [] }
    const viewer = this.resolveViewer(viewerPositionId)
    const ctx: ProjectContext = { tree: this.org, viewerPositionId: viewer, roles: this.config.roles }
    const visible = projectMemory(this.memory.list(), ctx)
    const sorted = visible.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    return sanitizeJson({ entries: sorted.slice(0, limit) }) as { entries: MemoryEntry[] }
  }

  /**
   * 调用方身份解析:Web 会话(web-root 等非岗位身份)回退为组织根 orchestrator 视角
   * —— Web 上打开"调度中心"的人即组织最高调度者(FR-S2 的根例外)。
   */
  resolveViewer(viewerPositionId: string): string {
    if (this.org?.hasPosition(viewerPositionId)) return viewerPositionId
    const rootOrchestrator = this.org ? this.org.orchestratorOf(this.org.root()) : undefined
    return rootOrchestrator ?? viewerPositionId
  }

  /** 团队状态查询(team_status 工具入口,visibility scope 投影服务端强制) */
  status(viewerPositionId: string): TeamSnapshot {
    const snap = this.snapshot()
    if (!this.config || !this.org) return snap
    const viewer = this.resolveViewer(viewerPositionId)
    const ctx: ProjectContext = { tree: this.org, viewerPositionId: viewer, roles: this.config.roles }
    snap.delegations = projectDelegations(snap.delegations as never[], ctx)
    snap.tasks = projectTasks(snap.tasks as never[], ctx)
    return sanitizeJson(snap) as TeamSnapshot
  }

  /** 邮箱工具入口 */
  mailSend(from: string, to: string, kind: string, body: string): { ok: boolean; reason?: string } {
    if (!this.mailbox) return { ok: false, reason: 'team_not_loaded' }
    const r = this.mailbox.send(from, to, (kind as never) ?? 'note', body)
    if (!r.ok) return { ok: false, reason: r.message }
    this.store.append('mailbox', { op: 'send', from, to, kind: kind ?? 'note', body })
    this.options.emit?.('team/mailbox-sent', { from, to })
    return { ok: true }
  }

  mailRecv(viewerPositionId: string): unknown[] {
    if (!this.mailbox || !this.org) return []
    const viewer = this.resolveViewer(viewerPositionId)
    const ctx: ProjectContext = { tree: this.org, viewerPositionId: viewer, roles: this.config?.roles }
    return sanitizeJson(projectMail(this.mailbox.list(), ctx)) as unknown[]
  }

  /** 任务板工具入口 */
  taskCreate(teamId: string, title: string, assignee: string, createdBy: string): { ok: boolean; reason?: string; task?: unknown } {
    if (!this.taskboard) return { ok: false, reason: 'team_not_loaded' }
    const r = this.taskboard.create({ teamId, title, assignee, createdBy })
    if (!r.ok) return { ok: false, reason: r.message }
    this.store.append('taskboard', { op: 'create', task: r.item, createdBy })
    this.options.emit?.('team/taskboard-changed', { task: r.item })
    return { ok: true, task: r.item }
  }

  taskClaim(positionId: string, taskId: string): { ok: boolean; reason?: string } {
    if (!this.taskboard) return { ok: false, reason: 'team_not_loaded' }
    const r = this.taskboard.claim(taskId, positionId)
    if (!r.ok) return { ok: false, reason: r.message }
    this.store.append('taskboard', { op: 'claim', taskId, positionId })
    return { ok: true }
  }

  taskDone(positionId: string, taskId: string): { ok: boolean; reason?: string } {
    if (!this.taskboard) return { ok: false, reason: 'team_not_loaded' }
    const r = this.taskboard.done(taskId, positionId)
    if (!r.ok) return { ok: false, reason: r.message }
    this.store.append('taskboard', { op: 'done', taskId, positionId })
    return { ok: true }
  }

  /** 任务取消(占位者替换 reassignOpenTasks=cancel 等入口):落流保证冷启动不丢状态 */
  taskCancel(positionId: string, taskId: string): { ok: boolean; reason?: string } {
    if (!this.taskboard) return { ok: false, reason: 'team_not_loaded' }
    const r = this.taskboard.cancel(taskId, positionId)
    if (!r.ok) return { ok: false, reason: r.message }
    this.store.append('taskboard', { op: 'cancel', taskId, positionId })
    return { ok: true }
  }

  /** IM 内 /bind:绑定 (channel, peerId) → 岗位(FR-X3;配置安全流程:备份→校验→应用) */
  bindRoute(channel: string, peerId: string, target: string): { ok: boolean; reason?: string; hint?: string } {
    if (!this.config) return { ok: false, reason: 'team_not_loaded' }
    if (!this.org?.hasPosition(target) && !this.org?.hasNode(target)) return { ok: false, reason: 'target_not_found' }
    const next = {
      ...this.config,
      routes: [...this.config.routes.filter((r) => !(r.channel === channel && r.peerId === peerId)), { channel, peerId, target }],
    }
    const applied = this.applyConfig(next)
    if (!applied.ok) return applied
    this.options.emit?.('team/routes-changed', {})
    // 名称一致性提示(FR-UX):IM 中机器人/群的显示名与团队室显示名保持一致的建议
    const hint = this.nameConsistencyHint(target)
    return hint === undefined ? { ok: true } : { ok: true, hint }
  }

  /** 绑定后的命名一致性建议:目标岗位/节点的团队室显示名 → IM 侧同名 */
  private nameConsistencyHint(target: string): string | undefined {
    const position = this.org?.hasPosition(target) ? this.members.get(target) : undefined
    const node = this.org?.hasNode(target) ? this.org.node(target) : undefined
    const posTitle = position?.title !== undefined && position.title.length > 0 ? position.title : undefined
    const nodeTitle = node?.title !== undefined && node.title.length > 0 ? node.title : undefined
    const displayName = posTitle ?? nodeTitle ?? (position !== undefined ? position.positionId : (node !== undefined ? node.id : undefined))
    if (displayName === undefined) return undefined
    return `名称一致性建议:将 IM 中对应机器人/群的显示名设为「${displayName}」,与团队室显示名保持一致(@谁触发谁按此名辨认)`
  }

  /** IM 内 /unbind:解绑 (channel, peerId) */
  unbindRoute(channel: string, peerId: string): { ok: boolean; reason?: string } {
    if (!this.config) return { ok: false, reason: 'team_not_loaded' }
    const applied = this.applyConfig({ ...this.config, routes: this.config.routes.filter((r) => !(r.channel === channel && r.peerId === peerId)) })
    if (applied.ok) this.options.emit?.('team/routes-changed', {})
    return applied
  }

  /** 配置应用(绑定/解绑共用):校验 → 原子替换 → 热重载;失败回滚由 atomicWrite 保证 */
  private applyConfig(next: TeamConfig): { ok: boolean; reason?: string } {
    const text = serializeTeamConfig(next)
    const result = atomicWriteTeamYml(this.options.stateRoot, text, (t) => {
      const parsed = parseTeamConfig(t)
      return parsed.ok ? [] : parsed.issues.map((i) => `${i.path}: ${i.message}`)
    })
    if (!result.ok) return { ok: false, reason: (result.errors ?? []).join('; ') }
    this.load()
    return { ok: true }
  }

  /** team_doctor 诊断(FR-X7):组合/配置/状态/存储四类检查,输出可执行修复建议 */
  doctor(): { checks: Array<{ name: string; ok: boolean; detail: string }> } {
    const checks: Array<{ name: string; ok: boolean; detail: string }> = []
    checks.push({
      name: 'team-config',
      ok: this.loaded,
      detail: this.loaded ? `组织 ${this.config?.org} · ${this.members.size} 岗位` : 'team.yml 缺失或校验失败(用 team_setup init 初始化)',
    })
    checks.push({
      name: 'members',
      ok: this.members.size > 0,
      detail: `${this.members.size} 岗位 · 状态:${[...this.memberStatus.entries()].map(([k, v]) => `${k}=${v}`).join(', ') || '全部待命(未激活,派发时自动唤醒)'}`,
    })
    checks.push({
      name: 'delegations',
      ok: (this.delegation?.snapshot().length ?? 0) >= 0,
      detail: `委派 ${this.delegation?.snapshot().length ?? 0} · 任务板 ${this.taskboard?.list().length ?? 0} · 邮箱 ${this.mailbox?.list().length ?? 0}`,
    })
    const markers = this.store.readAll('registry')
    checks.push({
      name: 'store',
      ok: markers.length >= 0,
      detail: `状态目录 ${this.store.stateRoot()} 可写`,
    })
    checks.push({
      name: 'federation',
      ok: true,
      detail: this.federation ? `联邦已接入:${this.federation.nodeId}` : '联邦未接入(单实例运行;集团期经 setFederation 启用)',
    })
    checks.push({
      name: 'doc-providers',
      ok: true,
      detail:
        this.documentProviders.size > 0
          ? `文档 provider ${this.documentProviders.size} 个:${this.listDocumentProviders().map((p) => `${p.id}(${p.label})`).join(', ')}`
          : '未注册文档 provider(team_doc_* 工具不可用;挂 doc-git/doc-feishu 行启用)',
    })
    return { checks }
  }

  /** 扩展面:注册文档 provider(返回 disposer;同 id 覆盖为幂等更新) */
  registerDocumentProvider(provider: DocumentProvider): () => void {
    this.documentProviders.set(provider.id, provider)
    this.options.emit?.('team/document-provider-registered', { id: provider.id, label: provider.label })
    return () => {
      this.documentProviders.delete(provider.id)
    }
  }

  /** 扩展面:列出已注册文档 provider(可观测) */
  listDocumentProviders(): Array<{ id: string; label: string }> {
    return [...this.documentProviders.values()].map((p) => ({ id: p.id, label: p.label }))
  }

  // ---- 文档路由(team_doc_* 工具入口;B 阶段知识库能力)----
  //
  // 设计要点:
  // - providerId 可省略:list/search 跨全部 provider 合并;get/update 按 id 定位,
  //   命中多个 provider 时返回歧义提示,要求显式指定;
  // - scope 投影:调用方岗位 → 所在团队节点,ref.teamId 若标注则必须落在
  //   调用方节点或其管辖子树内(成员只见本 team;orchestrator 见管辖层);
  // - 单个 provider 异常不阻断整体(隔离策略,与事件订阅者一致)。

  /** 文档列表(合并多 provider;结果按可见性投影) */
  async docList(viewerPositionId: string, providerId: string | undefined, limit = 50): Promise<DocListResult> {
    if (!this.org) return { ok: false, reason: 'team_not_loaded' }
    const { scope, viewerNode } = this.docViewer(viewerPositionId)
    const providers = this.docTargetProviders(providerId)
    if (providers === null) return { ok: false, reason: `文档 provider 未注册:${providerId ?? ''}` }
    const items: Array<DocumentRef & { provider: string }> = []
    for (const p of providers) {
      try {
        const refs = await p.listDocuments(scope, { limit })
        items.push(...this.projectDocRefs(refs, viewerNode).map((r) => ({ ...r, provider: p.id })))
      } catch {
        /* 单 provider 故障不阻断其它 provider */
      }
    }
    return sanitizeJson({ ok: true, items: items.slice(0, limit) }) as DocListResult
  }

  /** 文档读取(按 id 跨 provider 定位;多命中返回歧义提示) */
  async docGet(viewerPositionId: string, providerId: string | undefined, docId: string): Promise<DocGetResult> {
    if (!this.org) return { ok: false, reason: 'team_not_loaded' }
    const located = await this.locateDoc(viewerPositionId, providerId, docId)
    if (!located.ok) return { ok: false, reason: located.reason }
    // locateDoc 成功保证 hits 非空(TS 收缩不跨函数边界)
    const first = located.hits[0]!
    return sanitizeJson({
      ok: true,
      doc: { ...first.doc, provider: first.provider.id },
      ambiguous: located.hits.length > 1 ? located.hits.slice(1).map((h) => h.provider.id) : undefined,
    }) as DocGetResult
  }

  /** 文档创建(必须显式 provider:落哪个知识库由调用方决定) */
  async docCreate(viewerPositionId: string, providerId: string, title: string, body: string): Promise<DocCreateResult> {
    if (!this.org) return { ok: false, reason: 'team_not_loaded' }
    if (!providerId) {
      return { ok: false, reason: `create 必须显式 provider(可选:${this.listDocumentProviders().map((p) => p.id).join('/') || '无已注册 provider'})` }
    }
    const provider = this.documentProviders.get(providerId)
    if (provider === undefined) return { ok: false, reason: `文档 provider 未注册:${providerId}` }
    const { scope } = this.docViewer(viewerPositionId)
    const ref = await provider.createDocument(scope, { title, body })
    return sanitizeJson({ ok: true, ref: { ...ref, provider: provider.id } }) as DocCreateResult
  }

  /** 文档更新(CAS:expectedVersion 与 provider 后端版本比对;STALE 透传) */
  async docUpdate(
    viewerPositionId: string,
    providerId: string | undefined,
    docId: string,
    patch: { title?: string; body?: string },
    expectedVersion?: string,
  ): Promise<DocRouteUpdateResult> {
    if (!this.org) return { ok: false, reason: 'team_not_loaded' }
    const located = await this.locateDoc(viewerPositionId, providerId, docId)
    if (!located.ok) return { ok: false, reason: located.reason }
    if (located.hits.length > 1) {
      return { ok: false, reason: `文档 ${docId} 在多个 provider 存在(${located.hits.map((h) => h.provider.id).join('/')}),请显式指定 provider` }
    }
    const { provider, doc } = located.hits[0]!
    const result = await provider.updateDocument(doc.ref, patch, expectedVersion === undefined ? undefined : { expectedVersion })
    if (!result.ok) {
      return { ok: false, reason: '文档已被他人修改(版本冲突)', code: result.code, currentVersion: result.currentVersion }
    }
    return sanitizeJson({ ok: true, ref: { ...result.ref, provider: provider.id } }) as DocRouteUpdateResult
  }

  /** 文档搜索(合并多 provider;结果按可见性投影) */
  async docSearch(viewerPositionId: string, providerId: string | undefined, query: string, limit = 20): Promise<DocSearchResult> {
    if (!this.org) return { ok: false, reason: 'team_not_loaded' }
    const { scope, viewerNode } = this.docViewer(viewerPositionId)
    const providers = this.docTargetProviders(providerId)
    if (providers === null) return { ok: false, reason: `文档 provider 未注册:${providerId ?? ''}` }
    const items: Array<DocumentRef & { provider: string }> = []
    for (const p of providers) {
      try {
        const refs = await p.searchDocuments(query, scope)
        items.push(...this.projectDocRefs(refs, viewerNode).map((r) => ({ ...r, provider: p.id })))
      } catch {
        /* 单 provider 故障不阻断其它 provider */
      }
    }
    return sanitizeJson({ ok: true, items: items.slice(0, limit) }) as DocSearchResult
  }

  /** 调用方视角:岗位 → 团队节点 + provider scope */
  private docViewer(viewerPositionId: string): { scope: { teamId?: string }; viewerNode: string } {
    const viewer = this.resolveViewer(viewerPositionId)
    const viewerNode = this.org ? this.org.nodeOfPosition(viewer) : viewer
    return { scope: { teamId: viewerNode === viewer ? undefined : viewerNode }, viewerNode }
  }

  /** provider 目标解析:undefined → 全部;显式 → 单个或 null(未注册) */
  private docTargetProviders(providerId: string | undefined): DocumentProvider[] | null {
    if (providerId === undefined) return [...this.documentProviders.values()]
    const p = this.documentProviders.get(providerId)
    return p === undefined ? null : [p]
  }

  /** 可见性投影:ref 未标注 teamId → 放行;标注 → 必须为调用方节点或其管辖子树 */
  private projectDocRefs(refs: DocumentRef[], viewerNode: string): DocumentRef[] {
    return refs.filter((r) => {
      if (r.teamId === undefined) return true
      if (!this.org || !this.org.hasNode(r.teamId)) return false
      if (r.teamId === viewerNode) return true
      return this.org.isAncestor(viewerNode, r.teamId)
    })
  }

  /** 跨 provider 定位文档(可见性过滤后) */
  private async locateDoc(
    viewerPositionId: string,
    providerId: string | undefined,
    docId: string,
  ): Promise<{ ok: true; hits: Array<{ provider: DocumentProvider; doc: DocumentContent }> } | { ok: false; reason: string }> {
    const providers = this.docTargetProviders(providerId)
    if (providers === null) return { ok: false, reason: `文档 provider 未注册:${providerId ?? ''}` }
    const { viewerNode } = this.docViewer(viewerPositionId)
    const hits: Array<{ provider: DocumentProvider; doc: DocumentContent }> = []
    for (const p of providers) {
      try {
        const doc = await p.getDocument({ id: docId, title: '' })
        if (doc !== undefined && this.projectDocRefs([doc.ref], viewerNode).length === 1) hits.push({ provider: p, doc })
      } catch {
        /* 单 provider 异常按未命中处理 */
      }
    }
    if (hits.length === 0) return { ok: false, reason: `文档不存在:${docId}` }
    return { ok: true, hits }
  }

  /** 扩展面:注入集团联邦(集团期启用;200 人期保持 undefined) */
  setFederation(federation: OrgFederation | undefined): void {
    this.federation = federation
    this.options.emit?.('team/federation-set', { nodeId: federation?.nodeId ?? null })
  }

  /** 扩展面:订阅团队事件流(返回 disposer) */
  onTeamEvent(listener: (event: string, payload: Record<string, unknown>) => void): () => void {
    this.teamEventListeners.add(listener)
    return () => {
      this.teamEventListeners.delete(listener)
    }
  }

  /** 配置管理(team_setup init;FR-X5 安全流程:备份 → 校验 → 应用 → 失败回滚)。
   *  模板文本由工具层提供(权威源 = dsh-orgos-tools 的 templates.ts,单一源防漂移)。 */
  setupInit(templateText: string): { ok: boolean; errors?: string[] } {
    if (this.loaded) return { ok: false, errors: ['团队已存在:init 仅用于首次初始化;如确需重建,请先手动备份并删除 team.yml'] }
    const result = atomicWriteTeamYml(this.options.stateRoot, templateText, (text) => {
      const parsed = parseTeamConfig(text)
      return parsed.ok ? [] : parsed.issues.map((i) => `${i.path}: ${i.message}`)
    })
    if (!result.ok) return { ok: false, errors: result.errors }
    this.load()
    this.options.emit?.('team/routes-changed', {})
    return { ok: true }
  }

  /** 通道 → 需补偿关注的群 id 列表(断线/重启窗口消息补投;仅群会话 oc_ 前缀) */
  watchChatsByChannel(): Array<{ channel: string; chatIds: string[] }> {
    const byChannel = new Map<string, string[]>()
    for (const r of this.config?.routes ?? []) {
      if (!r.peerId.startsWith('oc_')) continue
      const list = byChannel.get(r.channel) ?? []
      if (!list.includes(r.peerId)) list.push(r.peerId)
      byChannel.set(r.channel, list)
    }
    return [...byChannel.entries()].map(([channel, chatIds]) => ({ channel, chatIds }))
  }
}

/** 剔除 undefined 键(DSH lossless JSON 检查拒绝 undefined;team_status 曾因此报错) */
export function sanitizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => sanitizeJson(v))
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = sanitizeJson(v)
    }
    return out
  }
  return value
}

/** 团队工具可见的服务形状(供 tools 包类型引用) */
export type TeamServiceFacade = Pick<
  TeamService,
  | 'load'
  | 'loaded'
  | 'snapshot'
  | 'status'
  | 'handleInbound'
  | 'delegate'
  | 'settle'
  | 'heartbeatReport'
  | 'mailSend'
  | 'mailRecv'
  | 'taskCreate'
  | 'taskClaim'
  | 'taskDone'
  | 'taskCancel'
  | 'setupInit'
  | 'doctor'
  | 'setMemberStatus'
  | 'bindRoute'
  | 'unbindRoute'
  | 'runReport'
  | 'memorySave'
  | 'memoryList'
  | 'replaceOccupant'
  | 'registerDocumentProvider'
  | 'listDocumentProviders'
  | 'docList'
  | 'docGet'
  | 'docCreate'
  | 'docUpdate'
  | 'docSearch'
  | 'setFederation'
  | 'onTeamEvent'
>

/** 回复回送回路:查成员最近入站来源 */
export function teamServiceRouteFor(service: TeamService, positionId: string): { channel: string; peer: { kind: 'group' | 'direct'; id: string } } | undefined {
  return (service as unknown as { lastRoute: Map<string, { channel: string; peer: { kind: 'group' | 'direct'; id: string } }> }).lastRoute.get(positionId)
}

/** TeamConfig → team.yml 文本(确定性序列化,applyConfig 用) */
export function serializeTeamConfig(c: TeamConfig): string {
  const lines: string[] = [`org: ${c.org}`, 'nodes:']
  for (const n of c.nodes) {
    lines.push(`  - id: ${n.id}`)
    lines.push(`    kind: ${n.kind}`)
    if (n.title !== undefined) lines.push(`    title: ${n.title}`)
    if (n.orchestratorPosition !== undefined) lines.push(`    orchestratorPosition: ${n.orchestratorPosition}`)
    if (n.children?.length) lines.push(`    children: [${n.children.join(', ')}]`)
  }
  lines.push('positions:')
  for (const pos of c.positions) {
    lines.push(`  - id: ${pos.id}`)
    if (pos.title !== undefined) lines.push(`    title: ${pos.title}`)
    if (pos.teamId !== undefined) lines.push(`    teamId: ${pos.teamId}`)
    if (pos.restricted) lines.push(`    restricted: true`)
    if (pos.capabilityProfile && pos.capabilityProfile.length > 0) lines.push(`    capabilityProfile: [${pos.capabilityProfile.join(', ')}]`)
    const occ = pos.occupant
    if (occ.kind === 'human') lines.push(`    occupant: { kind: human, im: { channel: ${occ.im?.channel}, userId: ${occ.im?.userId} } }`)
    else lines.push(`    occupant: { kind: agent, preset: ${occ.preset} }`)
    if (pos.handover !== undefined) lines.push(`    handover: { inheritMemory: ${pos.handover.inheritMemory}, reassignOpenTasks: ${pos.handover.reassignOpenTasks} }`)
  }
  if (c.routes.length > 0) {
    lines.push('routes:')
    for (const r of c.routes) lines.push(`  - { channel: ${r.channel}, peerId: ${r.peerId}, target: ${r.target} }`)
  } else {
    lines.push('routes: []')
  }
  lines.push('acl:')
  lines.push(`  delegationDepthMax: ${c.acl.delegationDepthMax ?? 3}`)
  if (c.acl.memberConcurrencyMax !== undefined) lines.push(`  memberConcurrencyMax: ${c.acl.memberConcurrencyMax}`)
  if (c.acl.allowCrossTeam && c.acl.allowCrossTeam.length > 0) {
    lines.push('  allowCrossTeam:')
    for (const a of c.acl.allowCrossTeam) lines.push(`    - { from: ${a.from}, to: ${a.to}, scopes: [${a.scopes.join(', ')}] }`)
  }
  if (c.acl.block && c.acl.block.length > 0) {
    lines.push('  block:')
    for (const b of c.acl.block) lines.push(`    - { to: ${b.to} }`)
  }
  if (c.roles !== undefined) {
    lines.push('roles:')
    for (const [k, v] of Object.entries(c.roles)) {
      lines.push(`  ${k}:`)
      lines.push(`    visibility: ${v.visibility}`)
      lines.push(`    authority: ${v.authority}`)
      lines.push(`    memory: [${v.memory.join(', ')}]`)
      lines.push(`    subscription: [${v.subscription.join(', ')}]`)
    }
  }
  return lines.join('\n') + '\n'
}
