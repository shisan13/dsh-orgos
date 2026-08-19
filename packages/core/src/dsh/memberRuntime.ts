/**
 * dsh-orgos-core 绑定层 —— 成员运行时(member-session 后端,ADR-002/004)
 *
 * 官方契约依据(本会话核实):
 * - ctx.agents.create({ sessionId, meta: { cwd, agentPreset? }, agentOptions: { provider, model }, setup(agentCtx) })
 *   → AgentHandle { agent, dispose() }
 * - ctx.agents.resume({ resumeSessionId, agentOptions, setup })
 * - ctx.agentPresets.mount(agentCtx, presetId):agent factory 的 setup 钩子是唯一支持的挂载点
 * - agent.send(msg, target, wakeup) / agent.followup(msg)(唤醒)/ agent.inject(msg)(不唤醒)
 * - UserMessage ≈ { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin, ... } }
 *   (官方 createUserMessage,本文件用本地轻量形状构造,不 import DSH 以保持零构建依赖)
 *
 * 成员身份 = 岗位 Position;agent 占位者由 role preset 组成;human 占位者走 IM 投递。
 * 心跳/系统通知使用 source { kind: 'plugin', plugin: 'dsh-orgos' }。
 */
import { randomUUID } from 'node:crypto'

/** 本地轻量 DSH 契约形状(运行时结构,零 import;TS 只作注释级约束) */
export interface DshAgents {
  create(options: unknown): Promise<{ agent: LiveAgent; dispose(): Promise<void> }>
  resume(options: unknown): Promise<{ agent: LiveAgent; dispose(): Promise<void> }>
  get(id: string): LiveAgent | undefined
  list(): LiveAgent[]
}
export interface LiveAgent {
  id: string
  status: 'idle' | 'running'
  session: { id: string }
  followup(message: unknown): void
  inject(message: unknown): void
  send(message: unknown, target: unknown, wakeup: boolean): void
  dispose(): Promise<void>
}
export interface AgentPresetsMount {
  mount(agentCtx: unknown, presetId?: string): Promise<unknown>
}
export interface AgentDefaultModelLike {
  currentSelection(): { provider: string; model: string; reasoningEffort?: string }
}
export interface MemberDef {
  positionId: string
  kind: 'agent' | 'human'
  /** 岗位显示名(team.yml title,团队室/IM 文案用;缺省回落 id) */
  title?: string
  presetId?: string
  cwd?: string
  model?: { provider: string; model: string }
  im?: { channel: string; userId: string }
}

export function makeUserMessage(text: string, source?: { kind: 'user' } | { kind: 'plugin'; plugin: string; form?: string; summary?: string }): unknown {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: source ?? { kind: 'plugin', plugin: 'dsh-orgos' },
  }
}

/** 成员运行状态投影 */
export interface MemberRuntime {
  positionId: string
  kind: 'agent' | 'human'
  status: 'offline' | 'idle' | 'busy' | 'failed'
  sessionId?: string
  presetId?: string
}

/**
 * member-session 后端:常驻 DSH 根 session。
 * 懒激活:首条投递时 create/resume;空闲由 DSH 自身管理(agent 保持 idle 可回收句柄)。
 */
export class SessionMemberRuntime {
  private handles = new Map<string, { agent: LiveAgent; dispose(): Promise<void> }>()
  /** 岗位启动注入(交接 framing 等):ensure 成功时一次性 inject 并清除 */
  private readonly bootNotes = new Map<string, string>()

  constructor(
    private readonly agents: DshAgents,
    private readonly presets: AgentPresetsMount,
    private readonly defaultModel?: AgentDefaultModelLike,
    private readonly onStatus?: (positionId: string, status: MemberRuntime['status']) => void,
    /** 成员 assistant 输出回送(positionId, text)—— 挂在成员 agent ctx 上(session/event 是 scope-filtered) */
    private readonly onAssistant?: (positionId: string, text: string) => void,
    /** 审批请求呈现(positionId, approvalId, toolName, reason)—— 挂成员 ctx 监听后经此发 IM 卡片 */
    private readonly onApproval?: (positionId: string, approvalId: string, toolName: string, reason?: string) => void,
  ) {}

  private readonly pendingApprovals = new Map<string, { resolve: (outcome: 'allowed-once' | 'rejected') => void; timer: ReturnType<typeof setTimeout> }>()

  /** 成员 agent ctx 审批监听(approval/request 为 scope-filtered waterfall;卡片回执经 resolveApproval 答复) */
  private installApprovalListener(agentCtx: unknown, positionId: string): void {
    if (!this.onApproval) return
    try {
      ;(agentCtx as {
        on(event: string, listener: (req: { toolName?: string; reason?: string }, next: () => Promise<string>) => Promise<string>, options?: { prepend?: boolean }): unknown
      }).on('approval/request', (req, next) => {
        if (!this.onApproval) return next()
        const approvalId = `ap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        this.onApproval(positionId, approvalId, req.toolName ?? 'tool', req.reason)
        return new Promise<string>((resolve) => {
          // fail-closed:默认 10 分钟超时拒绝(安全设计 P5)
          const timer = setTimeout(() => {
            this.pendingApprovals.delete(approvalId)
            resolve('rejected')
          }, 10 * 60_000)
          this.pendingApprovals.set(approvalId, { resolve, timer })
        })
      }, { prepend: true })
    } catch {
      /* 审批链路失败不影响成员运行(卡片走 next 默认 unavailable) */
    }
  }

  /** 审批卡片回执(IM approval_reply)→ 答复 pending waterfall */
  resolveApproval(approvalId: string, action: 'allow' | 'deny'): boolean {
    const pending = this.pendingApprovals.get(approvalId)
    if (!pending) return false
    clearTimeout(pending.timer)
    this.pendingApprovals.delete(approvalId)
    // DSH ApprovalOutcome 词汇:'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
    // 曾误用 'approved'(非词汇值)→ 被服务 normalize 为 'unavailable' → 工具层误拒。
    pending.resolve(action === 'allow' ? 'allowed-once' : 'rejected')
    return true
  }

  /** 成员 agent 上下文监听(session/event 按 scope 投递,必须在 agent ctx 注册) */
  private installReplyListener(agentCtx: unknown, positionId: string): void {
    if (!this.onAssistant) return
    try {
      ;(agentCtx as {
        on(event: string, listener: (session: { id: string }, event: { type?: string; data?: { message?: { content?: Array<{ type?: string; text?: string }> } } }) => void): unknown
      }).on('session/event', (_session, event) => {
        if (event?.type !== 'assistant/message') return
        const text = (event.data?.message?.content ?? [])
          .filter((b) => b?.type === 'text')
          .map((b) => b.text ?? '')
          .join('')
        if (text.trim().length > 0) this.onAssistant?.(positionId, text)
      })
    } catch {
      /* 回送失败不影响成员运行 */
    }
  }

  /** 岗位替换:释放当前成员句柄(下次 ensure 重新恢复/创建,注入 boot note) */
  release(positionId: string, bootNote?: string): void {
    const handle = this.handles.get(positionId)
    if (handle) {
      void handle.dispose()
      this.handles.delete(positionId)
    }
    if (bootNote !== undefined && bootNote.trim().length > 0) this.bootNotes.set(positionId, bootNote)
  }

  private injectBootNote(positionId: string, agent: LiveAgent): void {
    const note = this.bootNotes.get(positionId)
    if (note === undefined) return
    this.bootNotes.delete(positionId)
    agent.inject(makeUserMessage(`[HANDOVER FRAMING]\n${note}`))
  }

  async ensure(member: MemberDef): Promise<MemberRuntime> {
    const existing = this.handles.get(member.positionId)
    if (existing) return this.snapshot(member, existing.agent)

    const sessionId = this.sessionIdFor(member.positionId)
    const live = this.agents.get(sessionId)
    if (!live) {
      // 冷启动:会话已持久化则 resume,否则 create。
      // resume 优先:DSH 恢复保留历史;不存在的会话 resume 失败后回退 create。
      try {
        const resumed = await this.agents.resume(this.resumeOptions(member, sessionId))
        this.handles.set(member.positionId, resumed)
        this.injectBootNote(member.positionId, resumed.agent)
        this.onStatus?.(member.positionId, resumed.agent.status === 'running' ? 'busy' : 'idle')
        return this.snapshot(member, resumed.agent)
      } catch (error) {
        if (String(error).includes('not found') || String(error).includes('SESSION')) {
          // 全新会话:走 create
        } else {
          throw error
        }
      }
    }
    const handle = live
      ? { agent: live, dispose: async () => {} } // 非本运行时装出的 agent 不持有 dispose 权
      : await this.agents.create(this.createOptions(member, sessionId))
    this.handles.set(member.positionId, handle)
    this.injectBootNote(member.positionId, handle.agent)
    this.onStatus?.(member.positionId, handle.agent.status === 'running' ? 'busy' : 'idle')
    return this.snapshot(member, handle.agent)
  }

  deliver(handle: { agent: LiveAgent }, text: string, opts: { wake: boolean; source?: { kind: 'user' } | { kind: 'plugin'; plugin: string; form?: string; summary?: string } }): void {
    const msg = makeUserMessage(text, opts.source)
    if (opts.wake && handle.agent.status === 'idle') {
      handle.agent.followup(msg)
    } else {
      handle.agent.inject(msg)
    }
  }

  snapshot(member: MemberDef, agent: LiveAgent): MemberRuntime {
    return {
      positionId: member.positionId,
      kind: 'agent',
      status: agent.status === 'running' ? 'busy' : 'idle',
      sessionId: agent.id,
      presetId: member.presetId,
    }
  }

  private resumeOptions(member: MemberDef, sessionId: string): unknown {
    return {
      resumeSessionId: sessionId,
      ...(this.modelSelection(member) ? { agentOptions: this.modelSelection(member) } : {}),
      // 官方契约:setup 返回值必须是 AgentSetupCommit 或 undefined
      setup: async (agentCtx: unknown) => {
        await this.presets.mount(agentCtx, member.presetId)
        this.installReplyListener(agentCtx, member.positionId)
        this.installApprovalListener(agentCtx, member.positionId)
        return undefined
      },
    }
  }

  private createOptions(member: MemberDef, sessionId: string): unknown {
    return {
      sessionId,
      meta: {
        cwd: member.cwd,
        agentPreset: member.presetId,
      },
      ...(this.modelSelection(member)
        ? { agentOptions: this.modelSelection(member) }
        : {}),
      // 官方契约:setup 返回值必须是 AgentSetupCommit 或 undefined;
      // mount 的返回(AgentPreset)曾被当作 commit 致 fatal,显式 void。
      setup: async (agentCtx: unknown) => {
        await this.presets.mount(agentCtx, member.presetId)
        this.installReplyListener(agentCtx, member.positionId)
        this.installApprovalListener(agentCtx, member.positionId)
        return undefined
      },
    }
  }

  /** 成员模型:岗位配置 > 部署默认(agentDefaultModel)> 无(由官方 agent/request 瀑布兜底) */
  private modelSelection(member: MemberDef): { provider: string; model: string } | undefined {
    if (member.model) return { provider: member.model.provider, model: member.model.model }
    const fallback = this.defaultModel?.currentSelection()
    if (fallback) return { provider: fallback.provider, model: fallback.model }
    return undefined
  }

  private sessionIdFor(positionId: string): string {
    return `orgos-member-${positionId}`
  }
}
