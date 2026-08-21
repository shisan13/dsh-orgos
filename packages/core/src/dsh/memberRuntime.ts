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
import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'

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
  /** 待合并上下文(wake:false 注入,如心跳):不触发独立轮次,并入下一条真实消息前缀 */
  private readonly pendingContext = new Map<string, string[]>()
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

  /** 门面投递:wake=true 入队串行 pump(子进程单轮次语义,排队期间 busy 折叠);
   *  wake=false(心跳等)只合并进待注入上下文,不 spawn、不触发轮次。 */
  async deliver(member: MemberDef, text: string, opts: { wake: boolean; source?: { kind: 'user' } | { kind: 'plugin'; plugin: string; form?: string; summary?: string } }): Promise<boolean> {
    if (this.closed) return false
    if (!opts.wake) {
      const ctx = this.pendingContext.get(member.positionId) ?? []
      ctx.push(text)
      if (ctx.length > 3) ctx.shift() // 只保留最近 3 条,防无界增长
      this.pendingContext.set(member.positionId, ctx)
      this.onEvent?.(member.positionId, 'context', `pending=${ctx.length}`)
      return true
    }
    const entry = await this.ensure(member).then((_r) => this.members.get(member.positionId))
    if (entry === undefined) return false
    if (entry.failed !== undefined) return false // 失败态需 release 重建,拒绝继续投递
    const pending = this.pendingContext.get(member.positionId) ?? []
    this.pendingContext.delete(member.positionId)
    const merged = pending.length > 0 ? `[CONTEXT INJECT]
${pending.join('\n---\n')}\n\n${text}` : text
    const note = this.bootNotes.get(member.positionId)
    this.bootNotes.delete(member.positionId)
    entry.queue.push(note === undefined ? merged : `[HANDOVER FRAMING]\n${note}\n\n${merged}`)
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

/** member-acp 后端选项(M3.3:ACP 子进程 P1 常驻 + 跨轮次会话复用) */
export interface AcpMemberOptions {
  /** 官方 ACP 客户端模块(@agentclientprotocol/sdk 或其等价,绝对路径或部署可解析 specifier);延迟 import,core 零静态依赖 */
  sdkClientEntry: string
  /** 子进程启动规格(spawn 命令 + 官方 acp-agent 组合路径;stdout 为纯净 ACP JSON-RPC 协议通道) */
  launch: { command: string; args: string[]; cwd?: string; env?: Record<string, string> }
  /** 审批策略:reject(默认,fail-closed 一律 cancelled)| allow(选第一个 allow_once/allow_always option) */
  permission?: 'reject' | 'allow'
  /** 每成员子进程 env 覆盖(team-rpc 的 URL/岗位/token 注入点,与 dsh-sdk 共用同一回调) */
  memberEnv?: (positionId: string) => Record<string, string>
  /** 仅列出的岗位走 member-acp 后端(缺省 = 空集合,不路由;用于渐进迁移验证,与 sdkMember.positions 同语义) */
  positions?: string[]
}

/** 官方 ACP 客户端连接结构形状(运行时 Duck-typing,零 DSH import) */
export interface AcpConnectionLike {
  initialize(params: unknown): Promise<unknown>
  newSession(params: unknown): Promise<{ sessionId?: string }>
  prompt(params: unknown): Promise<{ stopReason?: string }>
  cancel?(params: unknown): Promise<void>
}

/** ACP Client 回调形状(官方 Client 接口必需项:sessionUpdate + requestPermission) */
export interface AcpClientLike {
  sessionUpdate(params: { sessionId?: string; update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } }): Promise<void>
  requestPermission(params: { sessionId?: string; options?: Array<{ kind?: string; optionId?: string }>; toolCall?: unknown }): Promise<unknown>
}

/** 官方 ACP SDK 模块导出形状(命名导出缺一即抛错) */
export interface AcpSdkModuleLike {
  ClientSideConnection?: new (toClient: (agent: unknown) => unknown, stream: unknown) => AcpConnectionLike
  ndJsonStream?: (output: unknown, input: unknown) => unknown
  PROTOCOL_VERSION?: number
}

/** 子进程句柄形状(spawn 注入点;默认 child_process.spawn + node:stream toWeb 包装进 ndJsonStream) */
export interface AcpProcLike {
  stdin: NodeJS.WritableStream
  stdout: NodeJS.ReadableStream
  kill(signal?: NodeJS.Signals): void
}

/** spawn 结构注入(测试用 fake;默认 child_process.spawn,stdio ['pipe','pipe','inherit']) */
export type AcpSpawnImpl = (spec: { argv: string[]; cwd: string; env?: Record<string, string> }) => AcpProcLike

/** 模块级 memoize:sdkClientEntry → 模块加载 Promise(校验 ClientSideConnection/ndJsonStream/PROTOCOL_VERSION,缺则抛错) */
const acpModuleCache = new Map<string, Promise<AcpSdkModuleLike>>()
function loadAcpModule(entry: string): Promise<AcpSdkModuleLike> {
  let promise = acpModuleCache.get(entry)
  if (promise === undefined) {
    promise = import(entry).then((mod) => {
      const m = mod as AcpSdkModuleLike
      if (typeof m.ClientSideConnection !== 'function') throw new Error(`sdkClientEntry ${entry} 未导出 ClientSideConnection`)
      if (typeof m.ndJsonStream !== 'function') throw new Error(`sdkClientEntry ${entry} 未导出 ndJsonStream`)
      if (m.PROTOCOL_VERSION === undefined) throw new Error(`sdkClientEntry ${entry} 未导出 PROTOCOL_VERSION`)
      return m
    })
    acpModuleCache.set(entry, promise)
  }
  return promise
}

/** 默认 spawn:child_process.spawn(stdio ['pipe','pipe','inherit'];stderr 直通父进程,stdout 纯净协议通道) */
function defaultAcpSpawn(spec: { argv: string[]; cwd: string; env?: Record<string, string> }): AcpProcLike {
  const command = spec.argv[0] ?? ''
  const child = spawn(command, spec.argv.slice(1), {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  return {
    stdin: child.stdin as NodeJS.WritableStream,
    stdout: child.stdout as NodeJS.ReadableStream,
    kill: (signal?: NodeJS.Signals) => {
      child.kill(signal)
    },
  }
}

/** 简化拆卸的 stdin EOF 宽限期(ms):官方 disposeAcpChild 用 6s 等子进程协作式停稳,此处收敛为短等待 */
export const ACP_DISPOSE_EOF_GRACE_MS = 50

/** 每成员 ACP 会话条目(进程存活期内 sessionId 稳定复用 = 跨轮次人格/历史) */
interface AcpMemberEntry {
  conn: AcpConnectionLike
  proc: AcpProcLike
  /** 服务端会话 id(newSession 返回;跨轮次 prompt 复用同一 id) */
  sessionId: string
  busy: boolean
  queue: string[]
  /** 本轮 assistant 文本累积(agent_message_chunk 回调写入;prompt resolve 后清空回送) */
  accumulator: string
  failed?: string
}

/**
 * member-acp 后端(M3.3:ACP 子进程 P1 常驻 + 跨轮次会话复用):
 * 每个成员一个官方 ACP 子进程(官方 acp-agent 组合:acp-agent/llm-deepseek/sandbox/
 * bash/approval/fs/持久化行),stdout 为纯净 ACP JSON-RPC 通道;成员会话 = newSession
 * 返回的 sessionId,进程存活期内多次 prompt 复用(官方服务端支持,每 session 同时仅 1 个 in-flight)。
 *
 * 官方 ACP 事实(本会话核实,@agentclientprotocol/sdk v0.25.1):
 * - ClientSideConnection((agent) => client, ndJsonStream(Writable.toWeb(stdin), Readable.toWeb(stdout)))
 * - initialize({ protocolVersion, clientCapabilities }) → newSession({ cwd, mcpServers: [] }) → { sessionId }
 * - prompt({ sessionId, prompt: [{ type: 'text', text }] }) → { stopReason }(await resolve = 整轮结束)
 * - 助手文本:sessionUpdate 回调 agent_message_chunk + content.type==='text' 累积(官方只发 committed 整块)
 * - requestPermission 回调:返回 selected(optionId) 或 cancelled;本后端 fail-closed(默认一律拒绝)
 *
 * 协作面边界(同 dsh-sdk):子进程组合不挂 team_* 工具,团队协作经父进程代理;
 * 审批链路子进程侧走自动应答策略,resolveApproval 恒 false。
 */
export class AcpMemberRuntime implements MemberRuntimeFacade {
  /** positionId → ACP 连接 + 子进程句柄(每成员一个子进程,成员隔离) */
  private readonly members = new Map<string, AcpMemberEntry>()
  /** 待合并上下文(wake:false 注入,如心跳):不触发独立轮次,并入下一条真实消息前缀 */
  private readonly pendingContext = new Map<string, string[]>()
  private readonly bootNotes = new Map<string, string>()
  private readonly permission: 'reject' | 'allow'
  private readonly memberEnv?: (positionId: string) => Record<string, string>
  private readonly spawnImpl: AcpSpawnImpl
  private closed = false

  constructor(
    private readonly options: AcpMemberOptions,
    private readonly onStatus?: (positionId: string, status: MemberRuntime['status']) => void,
    /** 成员 assistant 最终输出回送(positionId, text)—— 父侧登记回执/回送 IM */
    private readonly onAssistant?: (positionId: string, text: string) => void,
    /** 可观测事件(诊断用):ensure/deliver/context/run-ok/run-error */
    private readonly onEvent?: (positionId: string, event: string, detail: string) => void,
    /** 每成员子进程 env 覆盖(team-rpc 的 URL/岗位/token 注入点,与 dsh-sdk 共用) */
    memberEnv?: (positionId: string) => Record<string, string>,
    /** spawn 结构注入(测试用);缺省 child_process.spawn + node:stream toWeb 包装 */
    spawnImpl?: AcpSpawnImpl,
  ) {
    this.permission = options.permission ?? 'reject'
    this.memberEnv = memberEnv ?? options.memberEnv
    this.spawnImpl = spawnImpl ?? defaultAcpSpawn
  }

  async ensure(member: MemberDef): Promise<MemberRuntime> {
    const existing = this.members.get(member.positionId)
    if (existing) return this.snapshot(member.positionId, existing)
    const mod = await loadAcpModule(this.options.sdkClientEntry)
    // 每成员独立子进程(成员隔离,与 dsh-sdk 一致);M3.3:memberEnv 覆盖合并进 launch.env
    // (官方 env 整体替换语义,与 dsh-sdk 的 M3.2 注入一致)
    const launch =
      this.memberEnv === undefined
        ? this.options.launch
        : { ...this.options.launch, env: { ...(this.options.launch.env ?? {}), ...this.memberEnv(member.positionId) } }
    const sessionCwd = this.resolveSessionCwd(member)
    const proc = this.spawnImpl({
      argv: [this.options.launch.command, ...this.options.launch.args],
      cwd: launch.cwd ?? process.cwd(),
      env: launch.env,
    })
    const entry: AcpMemberEntry = {
      conn: undefined as unknown as AcpConnectionLike,
      proc,
      sessionId: '',
      busy: false,
      queue: [],
      accumulator: '',
    }
    // 客户端回调闭包写 entry.accumulator(每成员连接独立,天然隔离);conn 创建后回填
    const client: AcpClientLike = {
      // 官方只发 committed 整块(非逐 token):agent_message_chunk + text 累积为本轮最终文本
      sessionUpdate: async (params) => {
        const update = params?.update
        if (update?.sessionUpdate !== 'agent_message_chunk') return
        if (update.content?.type !== 'text') return
        const text = update.content.text
        if (typeof text === 'string') entry.accumulator += text
      },
      // 审批 fail-closed:一律 cancelled(reject);permission='allow' 时选第一个 allow 类 option
      // (与官方 subagent-acp 的自动应答策略一致)
      requestPermission: async (params) => {
        if (this.permission === 'allow') {
          const allow = (params?.options ?? []).find((o) => o.kind === 'allow_once' || o.kind === 'allow_always')
          if (allow !== undefined) return { outcome: { outcome: 'selected', optionId: allow.optionId } }
        }
        return { outcome: { outcome: 'cancelled' } }
      },
    }
    const stream = mod.ndJsonStream!(NodeWritable.toWeb(proc.stdin as unknown as NodeWritable), NodeReadable.toWeb(proc.stdout as unknown as NodeReadable))
    entry.conn = new mod.ClientSideConnection!(() => client, stream)
    try {
      await entry.conn.initialize({ protocolVersion: mod.PROTOCOL_VERSION, clientCapabilities: {} })
      const session = await entry.conn.newSession({ cwd: sessionCwd, mcpServers: [] })
      const serverSessionId = session?.sessionId
      if (typeof serverSessionId !== 'string' || serverSessionId.length === 0) {
        throw new Error('ACP 子进程未返回 sessionId(newSession 响应缺 sessionId)')
      }
      entry.sessionId = serverSessionId
    } catch (error) {
      // 握手失败:回收已 spawn 的子进程(进程属本后端所有,失败必须自清理),再向上抛
      void this.teardown(entry).catch(() => {})
      throw error
    }
    this.members.set(member.positionId, entry)
    this.onEvent?.(member.positionId, 'ensure', `spawn ${String(this.options.launch.command)} ${String(this.options.launch.args?.[0])}`)
    this.onStatus?.(member.positionId, 'idle')
    return this.snapshot(member.positionId, entry)
  }

  /** 门面投递:wake=true 入队串行 pump(子进程单轮次语义,排队期间 busy 折叠);
   *  wake=false(心跳等)只合并进待注入上下文,不 spawn、不触发轮次(同 dsh-sdk)。 */
  async deliver(member: MemberDef, text: string, opts: { wake: boolean; source?: { kind: 'user' } | { kind: 'plugin'; plugin: string; form?: string; summary?: string } }): Promise<boolean> {
    if (this.closed) return false
    if (!opts.wake) {
      const ctx = this.pendingContext.get(member.positionId) ?? []
      ctx.push(text)
      if (ctx.length > 3) ctx.shift() // 只保留最近 3 条,防无界增长
      this.pendingContext.set(member.positionId, ctx)
      this.onEvent?.(member.positionId, 'context', `pending=${ctx.length}`)
      return true
    }
    const entry = await this.ensure(member).then((_r) => this.members.get(member.positionId))
    if (entry === undefined) return false
    if (entry.failed !== undefined) return false // 失败态需 release 重建,拒绝继续投递
    const pending = this.pendingContext.get(member.positionId) ?? []
    this.pendingContext.delete(member.positionId)
    const merged = pending.length > 0 ? `[CONTEXT INJECT]
${pending.join('\n---\n')}\n\n${text}` : text
    const note = this.bootNotes.get(member.positionId)
    this.bootNotes.delete(member.positionId)
    entry.queue.push(note === undefined ? merged : `[HANDOVER FRAMING]\n${note}\n\n${merged}`)
    this.onEvent?.(member.positionId, 'deliver', `queue=${entry.queue.length}`)
    void this.pump(member.positionId, entry)
    return true
  }

  /** 串行消费队列:一次 prompt 一轮(await resolve = 整轮结束),结束后回送累积文本 */
  private async pump(positionId: string, entry: AcpMemberEntry): Promise<void> {
    if (entry.busy) return
    entry.busy = true
    this.onStatus?.(positionId, 'busy')
    try {
      while (entry.queue.length > 0) {
        const text = entry.queue.shift() ?? ''
        entry.accumulator = '' // 每轮清空累积,防串轮次
        const result = await entry.conn.prompt({ sessionId: entry.sessionId, prompt: [{ type: 'text', text }] })
        const final = entry.accumulator.trim()
        const reason = result?.stopReason ?? 'end_turn'
        // 非正常终止(官方 acpStopReason 映射:refusal/cancelled/max_turn_requests 均非干净结束)
        // 且无任何助手文本 → 记 failed(需 release 重建);有文本则照常回送(部分产出也算产出)
        if (reason !== 'end_turn' && reason !== 'max_tokens' && final.length === 0) {
          entry.failed = `turn ended with stopReason=${reason}`
          this.onEvent?.(positionId, 'run-error', entry.failed)
          this.onStatus?.(positionId, 'failed')
          return
        }
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

  /** 岗位替换/重建:关闭该成员子进程(简化拆卸阶梯,注释与官方 disposeAcpChild 对齐:
   *  stdin EOF 协作退出 → 短宽限 → SIGTERM 升级),boot note 注入下次 ensure 后的首条消息 */
  release(positionId: string, bootNote?: string): void {
    const entry = this.members.get(positionId)
    if (entry) {
      this.members.delete(positionId)
      void Promise.resolve().then(() => this.teardown(entry)).catch(() => {})
    }
    if (bootNote !== undefined && bootNote.trim().length > 0) this.bootNotes.set(positionId, bootNote)
  }

  /** 子进程拆卸阶梯:stdin end(EOF 协作退出探测)→ 短暂等待 → kill('SIGTERM')
   *  (官方 disposeAcpChild:stdin.end → eofGraceMs 等退出 → terminate 的 SIGTERM→SIGKILL 升级;此处简化) */
  private async teardown(entry: AcpMemberEntry): Promise<void> {
    try {
      entry.proc.stdin.end()
    } catch {
      /* stdin 已关闭/损坏等情形忽略 */
    }
    await new Promise((resolve) => setTimeout(resolve, ACP_DISPOSE_EOF_GRACE_MS))
    try {
      entry.proc.kill('SIGTERM')
    } catch {
      /* 进程已退出等情形忽略 */
    }
  }

  /** ACP 子进程审批走自动应答策略(无父侧审批链路);恒 false */
  resolveApproval(_approvalId: string, _action: 'allow' | 'deny'): boolean {
    return false
  }

  /** 服务停止:回收全部成员子进程(幂等) */
  async disposeAll(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.members.values()].map((e) => this.teardown(e)))
    this.members.clear()
  }

  /** ACP 会话 cwd:岗位 cwd > launch.cwd > 进程 cwd;必须为绝对路径(官方 newSession 契约) */
  private resolveSessionCwd(member: MemberDef): string {
    const cwd = member.cwd ?? this.options.launch.cwd ?? process.cwd()
    if (!isAbsolute(cwd)) throw new Error(`ACP 会话 cwd 必须是绝对路径:${cwd}`)
    return cwd
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
    // 命名空间区分 dsh-sdk(orgos-member-<id>):ACP 成员用 orgos-member-acp-<id>
    return `orgos-member-acp-${positionId}`
  }
}

/** 混合成员后端:按岗位分流 session / dsh-sdk / member-acp(渐进迁移期;默认全 session) */
export class HybridMemberRuntime implements MemberRuntimeFacade {
  constructor(
    private readonly session: MemberRuntimeFacade,
    private readonly sdk: DshSdkMemberRuntime | undefined,
    private readonly sdkPositions: ReadonlySet<string>,
    private readonly acp?: AcpMemberRuntime,
    private readonly acpPositions?: ReadonlySet<string>,
  ) {}

  /** 岗位分流:acp 优先 > sdk > session(同名岗位在两类远程后端中时 ACP 优先) */
  private for(member: MemberDef): MemberRuntimeFacade {
    if (this.acp !== undefined && this.acpPositions !== undefined && this.acpPositions.has(member.positionId)) return this.acp
    return this.sdk !== undefined && this.sdkPositions.has(member.positionId) ? this.sdk : this.session
  }

  ensure(member: MemberDef): Promise<MemberRuntime> {
    return this.for(member).ensure(member)
  }

  deliver(member: MemberDef, text: string, opts: { wake: boolean; source?: { kind: 'user' } | { kind: 'plugin'; plugin: string; form?: string; summary?: string } }): Promise<boolean> {
    return this.for(member).deliver(member, text, opts)
  }

  release(positionId: string, bootNote?: string): void {
    // 三后端各自幂等:仅持有该岗位句柄的一侧生效
    this.session.release(positionId, bootNote)
    this.sdk?.release(positionId, bootNote)
    this.acp?.release(positionId, bootNote)
  }

  resolveApproval(approvalId: string, action: 'allow' | 'deny'): boolean {
    return this.session.resolveApproval(approvalId, action)
  }

  async disposeAll(): Promise<void> {
    await Promise.allSettled([this.session.disposeAll(), this.sdk?.disposeAll(), this.acp?.disposeAll()])
  }
}
