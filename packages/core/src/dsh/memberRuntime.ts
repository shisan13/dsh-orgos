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
 * 成员后端统一门面(TeamService 只依赖此形状):
 * member-session(常驻父进程 session)与 member-dsh-sdk(P1 进程常驻子运行时)
 * 两个实现互插(ADR-002 预留的 MemberBackend seam)。
 */
export interface MemberRuntimeFacade {
  ensure(member: MemberDef): Promise<MemberRuntime>
  /** 投递一条成员消息(内部自行 ensure);不可投递返回 false(如 agent 句柄缺失/后端已关闭) */
  deliver(member: MemberDef, text: string, opts: { wake: boolean; source?: { kind: 'user' } | { kind: 'plugin'; plugin: string; form?: string; summary?: string } }): Promise<boolean>
  /** 释放成员句柄(岗位替换;可选 boot note 注入下次 ensure) */
  release(positionId: string, bootNote?: string): void
  /** 审批卡片回执(session 后端支持;dsh-sdk 子进程无审批链路,恒 false) */
  resolveApproval(approvalId: string, action: 'allow' | 'deny'): boolean
  /** 服务停止:回收全部成员资源(session 句柄/dsh-sdk 子进程) */
  disposeAll(): Promise<void>
}

/** member-dsh-sdk 后端选项(P1 进程常驻;C 阶段 M2 尾验证) */
export interface DshSdkMemberOptions {
  /** 官方 SDK 客户端模块(绝对路径或部署可解析 specifier);延迟 import,core 零静态依赖 */
  sdkClientEntry: string
  /** 子运行时启动规格(spawn 命令 + 子进程 cordis.yml 路径) */
  launch: { command: string; args: string[]; cwd?: string; env?: Record<string, string> }
  /** 写入子进程 initialize 的模型路由(缺省由子进程组合兜底) */
  provider?: string
  model?: string
  maxTokens?: number
  /** 仅列出的岗位走 dsh-sdk 后端(缺省 = 全部 agent 岗位);用于渐进迁移验证 */
  positions?: string[]
}

/** 官方 SDK 客户端结构形状(运行时 Duck-typing,零 DSH import) */
export interface SdkHarnessLike {
  /** 打开/复用子进程内会话句柄(sessionId 稳定复用 = 常驻人格/记忆) */
  session(sessionId?: string): { run(input: string): Promise<{ finalResponse: string }> }
  close(): Promise<void>
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

  /** 门面投递:内部 ensure 后注入/唤醒;agent 句柄缺失返回 false(调用方按不可用处理) */
  async deliver(member: MemberDef, text: string, opts: { wake: boolean; source?: { kind: 'user' } | { kind: 'plugin'; plugin: string; form?: string; summary?: string } }): Promise<boolean> {
    const runtime = await this.ensure(member)
    const agent = this.agents.get(runtime.sessionId ?? '')
    if (!agent) return false
    const msg = makeUserMessage(text, opts.source)
    if (opts.wake && agent.status === 'idle') {
      agent.followup(msg)
    } else {
      agent.inject(msg)
    }
    return true
  }

  /** 服务停止:释放全部成员句柄(懒激活语义下多数为 no-op) */
  async disposeAll(): Promise<void> {
    await Promise.all([...this.handles.values()].map((h) => Promise.resolve().then(() => h.dispose()).catch(() => {})))
    this.handles.clear()
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

/**
 * member-dsh-sdk 后端(P1 进程常驻;C 阶段 M2 尾验证):
 * 每个成员一个官方 DeepSeekHarness 子进程(完整对等 DSH 运行时,组合/会话/模型自持),
 * 成员会话 = 子进程内按 sessionId 稳定复用的 SDK session——跨委派轮次保持人格与历史,
 * 语义与 member-session 常驻同构。官方 SDK 事实(本会话核实,rc.8 checkout):
 * - DeepSeekHarness:start/initialize 握手 memoize;子进程跨 run() 常驻,close() 才回收;
 * - session(id?) 打开命名会话句柄,run(input, { sessionId }) 跨轮次复用同一会话;
 * - 无中途取消:一个轮次只能等其 idle,放弃轮次 = 关闭整个子进程(Known Limitation)。
 *
 * 协作面边界(方案 C.3):子进程组合不挂 team_* 工具(团队协作经父进程代理:
 * 成员产出 → finalResponse → onAssistant 回送 → 父侧回执流/邮箱登记)。
 * 审批链路子进程侧不在 M2 尾验证范围(resolveApproval 恒 false)。
 */
export class DshSdkMemberRuntime implements MemberRuntimeFacade {
  /** positionId → 常驻子进程句柄 */
  private readonly members = new Map<string, { harness: SdkHarnessLike; sessionId: string; busy: boolean; queue: string[]; failed?: string }>()
  private readonly bootNotes = new Map<string, string>()
  private modulePromise: Promise<{ DeepSeekHarness?: new (options: unknown) => SdkHarnessLike }> | undefined
  private closed = false

  constructor(
    private readonly options: DshSdkMemberOptions,
    private readonly onStatus?: (positionId: string, status: MemberRuntime['status']) => void,
    /** 成员 assistant 最终输出回送(positionId, text)—— 父侧登记回执/回送 IM */
    private readonly onAssistant?: (positionId: string, text: string) => void,
    /** 可观测事件(诊断用):ensure/deliver/run-ok/run-error/closed */
    private readonly onEvent?: (positionId: string, event: string, detail: string) => void,
    /** M3.2:每成员子进程 env 覆盖(team-rpc 的 URL/岗位/token 注入点) */
    private readonly memberEnv?: (positionId: string) => Record<string, string>,
  ) {}

  /** 懒加载 SDK 客户端模块(每成员进程常驻;模块只 import 一次) */
  private async sdkModule(): Promise<{ DeepSeekHarness?: new (options: unknown) => SdkHarnessLike }> {
    this.modulePromise ??= import(this.options.sdkClientEntry) as Promise<{ DeepSeekHarness?: new (options: unknown) => SdkHarnessLike }>
    return this.modulePromise
  }

  async ensure(member: MemberDef): Promise<MemberRuntime> {
    const existing = this.members.get(member.positionId)
    if (existing) return this.snapshot(member.positionId, existing)
    const mod = await this.sdkModule()
    if (mod.DeepSeekHarness === undefined) throw new Error(`sdkClientEntry ${this.options.sdkClientEntry} 未导出 DeepSeekHarness`)
    // 每成员独立子进程:模型路由走 initialize,组合由子进程 cordis.yml 决定;
    // M3.2:每成员 env 覆盖(team-rpc 凭据)合并进 launch.env(官方 env 整体替换语义)
    const launch =
      this.memberEnv === undefined
        ? this.options.launch
        : { ...this.options.launch, env: { ...(this.options.launch.env ?? {}), ...this.memberEnv(member.positionId) } }
    const harness = new mod.DeepSeekHarness({
      launch,
      ...(this.options.provider === undefined ? {} : { provider: this.options.provider }),
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
      ...(this.options.maxTokens === undefined ? {} : { maxTokens: this.options.maxTokens }),
    })
    const entry = { harness, sessionId: this.sessionIdFor(member.positionId), busy: false, queue: [] as string[] }
    this.members.set(member.positionId, entry)
    this.onEvent?.(member.positionId, 'ensure', `spawn ${String(this.options.launch.command)} ${String(this.options.launch.args?.[0])}`)
    this.onStatus?.(member.positionId, 'idle')
    return this.snapshot(member.positionId, entry)
  }

  /** 门面投递:入队后串行 pump(子进程单轮次语义;排队期间 busy 折叠) */
  async deliver(member: MemberDef, text: string, _opts: { wake: boolean; source?: { kind: 'user' } | { kind: 'plugin'; plugin: string; form?: string; summary?: string } }): Promise<boolean> {
    if (this.closed) return false
    const entry = await this.ensure(member).then((_r) => this.members.get(member.positionId))
    if (entry === undefined) return false
    if (entry.failed !== undefined) return false // 失败态需 release 重建,拒绝继续投递
    const note = this.bootNotes.get(member.positionId)
    this.bootNotes.delete(member.positionId)
    entry.queue.push(note === undefined ? text : `[HANDOVER FRAMING]\n${note}\n\n${text}`)
    this.onEvent?.(member.positionId, 'deliver', `queue=${entry.queue.length}`)
    void this.pump(member.positionId, entry)
    return true
  }

  /** 串行消费队列:一次 run 一消息,结束后 onAssistant 回送最终文本 */
  private async pump(positionId: string, entry: { harness: SdkHarnessLike; sessionId: string; busy: boolean; queue: string[]; failed?: string }): Promise<void> {
    if (entry.busy) return
    entry.busy = true
    this.onStatus?.(positionId, 'busy')
    try {
      while (entry.queue.length > 0) {
        const text = entry.queue.shift() ?? ''
        const result = await entry.harness.session(entry.sessionId).run(text)
        const final = String(result.finalResponse ?? '').trim()
        this.onEvent?.(positionId, 'run-ok', `final=${final.length}chars`)
        if (final.length > 0) this.onAssistant?.(positionId, final)
      }
      this.onStatus?.(positionId, 'idle')
    } catch (error) {
      entry.failed = String(error).slice(0, 300)
      this.onEvent?.(positionId, 'run-error', entry.failed)
      this.onStatus?.(positionId, 'failed')
    } finally {
      entry.busy = false
    }
  }

  /** 岗位替换/重建:关闭该成员子进程(幂等),boot note 注入下次 ensure 后的首条消息 */
  release(positionId: string, bootNote?: string): void {
    const entry = this.members.get(positionId)
    if (entry) {
      this.members.delete(positionId)
      void Promise.resolve().then(() => entry.harness.close()).catch(() => {})
    }
    if (bootNote !== undefined && bootNote.trim().length > 0) this.bootNotes.set(positionId, bootNote)
  }

  /** dsh-sdk 子进程无审批链路(M2 尾验证范围外);恒 false */
  resolveApproval(_approvalId: string, _action: 'allow' | 'deny'): boolean {
    return false
  }

  /** 服务停止:回收全部成员子进程(官方 dispose 阶梯,幂等) */
  async disposeAll(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.members.values()].map((e) => e.harness.close()))
    this.members.clear()
  }

  private snapshot(positionId: string, entry: { busy: boolean; failed?: string }): MemberRuntime {
    return {
      positionId,
      kind: 'agent',
      status: entry.failed !== undefined ? 'failed' : entry.busy ? 'busy' : 'idle',
      sessionId: this.sessionIdFor(positionId),
    }
  }

  private sessionIdFor(positionId: string): string {
    return `orgos-member-${positionId}`
  }
}

/** 混合成员后端:按岗位分流 session / dsh-sdk(渐进迁移期;默认全 session) */
export class HybridMemberRuntime implements MemberRuntimeFacade {
  constructor(
    private readonly session: MemberRuntimeFacade,
    private readonly sdk: DshSdkMemberRuntime | undefined,
    private readonly sdkPositions: ReadonlySet<string>,
  ) {}

  private for(member: MemberDef): MemberRuntimeFacade {
    return this.sdk !== undefined && this.sdkPositions.has(member.positionId) ? this.sdk : this.session
  }

  ensure(member: MemberDef): Promise<MemberRuntime> {
    return this.for(member).ensure(member)
  }

  deliver(member: MemberDef, text: string, opts: { wake: boolean; source?: { kind: 'user' } | { kind: 'plugin'; plugin: string; form?: string; summary?: string } }): Promise<boolean> {
    return this.for(member).deliver(member, text, opts)
  }

  release(positionId: string, bootNote?: string): void {
    // 两后端各自幂等:仅持有该岗位句柄的一侧生效
    this.session.release(positionId, bootNote)
    this.sdk?.release(positionId, bootNote)
  }

  resolveApproval(approvalId: string, action: 'allow' | 'deny'): boolean {
    return this.session.resolveApproval(approvalId, action)
  }

  async disposeAll(): Promise<void> {
    await Promise.allSettled([this.session.disposeAll(), this.sdk?.disposeAll()])
  }
}
