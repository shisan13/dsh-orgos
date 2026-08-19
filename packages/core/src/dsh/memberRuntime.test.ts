/**
 * SessionMemberRuntime 绑定层测试:Given-When-Then(AGENTS.md §4 闸门)
 * fake agents/presets/agentCtx,覆盖 ensure(resume/create 分支)、deliver、
 * 审批监听 fail-closed、回送监听、模型选择。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionMemberRuntime, makeUserMessage } from './memberRuntime.js'
import type { DshAgents, LiveAgent, AgentPresetsMount } from './memberRuntime.js'

class FakeAgent implements LiveAgent {
  id = ''
  status: 'idle' | 'running' = 'idle'
  session = { id: '' }
  followupCalls: unknown[] = []
  injectCalls: unknown[] = []
  sendCalls: Array<[unknown, unknown, boolean]> = []
  constructor(id: string, status: 'idle' | 'running' = 'idle') {
    this.id = id
    this.session = { id }
    this.status = status
  }
  followup(msg: unknown): void {
    this.followupCalls.push(msg)
  }
  inject(msg: unknown): void {
    this.injectCalls.push(msg)
  }
  send(msg: unknown, target: unknown, wakeup: boolean): void {
    this.sendCalls.push([msg, target, wakeup])
  }
  async dispose(): Promise<void> {}
}

type OnCapture = (event: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }) => void

class FakeAgentCtx {
  onCalls: Array<{ event: string; listener: (...args: never[]) => unknown; options?: { prepend?: boolean } }> = []
  on = ((event: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }) => {
    this.onCalls.push({ event, listener, options })
  }) as OnCapture
  listenerFor(event: string): ((...args: never[]) => unknown) | undefined {
    return this.onCalls.find((c) => c.event === event)?.listener
  }
}

describe('makeUserMessage', () => {
  it('GIVEN 无 source WHEN 构造 THEN 默认 plugin 来源', () => {
    const msg = makeUserMessage('hi') as { role: string; content: Array<{ type: string; text: string }>; source: { kind: string; plugin: string } }
    expect(msg.role).toBe('user')
    expect(msg.content).toEqual([{ type: 'text', text: 'hi' }])
    expect(msg.source.kind).toBe('plugin')
    expect(msg.source.plugin).toBe('dsh-orgos')
  })

  it('GIVEN user 来源 WHEN 构造 THEN 保留来源', () => {
    const msg = makeUserMessage('hi', { kind: 'user' }) as { source: { kind: string } }
    expect(msg.source.kind).toBe('user')
  })
})

describe('SessionMemberRuntime(绑定层)', () => {
  let agents: DshAgents & {
    createCalls: unknown[]
    resumeCalls: unknown[]
    registry: Map<string, FakeAgent>
    failResume: Error | null
    resumeResult: { agent: FakeAgent; dispose(): Promise<void> } | null
  }
  let mountCalls: Array<[unknown, string | undefined]>
  let presets: AgentPresetsMount
  let statusEvents: Array<[string, string]>
  let assistantEvents: Array<[string, string]>
  let approvalEvents: Array<[string, string, string, string | undefined]>
  let runtime: SessionMemberRuntime

  beforeEach(() => {
    mountCalls = []
    statusEvents = []
    assistantEvents = []
    approvalEvents = []
    const registry = new Map<string, FakeAgent>()
    agents = {
      registry,
      createCalls: [],
      resumeCalls: [],
      failResume: null,
      resumeResult: null,
      async create(options) {
        const o = options as { sessionId: string; setup?: (c: unknown) => Promise<unknown> }
        agents.createCalls.push(options)
        await o.setup?.(new FakeAgentCtx())
        const agent = new FakeAgent(o.sessionId)
        registry.set(o.sessionId, agent)
        return { agent, dispose: async () => {} }
      },
      async resume(options) {
        const o = options as { resumeSessionId: string; setup?: (c: unknown) => Promise<unknown> }
        agents.resumeCalls.push(options)
        if (agents.failResume) throw agents.failResume
        // 默认冷启动:持久化会话不存在(failResume/resumeResult 未显式设置时)
        if (!agents.resumeResult) throw new Error('SESSION not found')
        const agent = agents.resumeResult.agent
        await o.setup?.(new FakeAgentCtx())
        registry.set(o.resumeSessionId, agent)
        return { agent, dispose: async () => {} }
      },
      get(id) {
        return registry.get(id) ?? undefined
      },
      list() {
        return [...registry.values()]
      },
    }
    presets = {
      async mount(agentCtx, presetId) {
        mountCalls.push([agentCtx, presetId])
        return {}
      },
    }
    runtime = new SessionMemberRuntime(
      agents,
      presets,
      { currentSelection: () => ({ provider: 'deepseek', model: 'chat' }) },
      (p, s) => statusEvents.push([p, s]),
      (p, t) => assistantEvents.push([p, t]),
      (p, a, tool, reason) => approvalEvents.push([p, a, tool, reason ?? '']),
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const member = (over: Partial<Parameters<SessionMemberRuntime['ensure']>[0]> = {}) => ({
    positionId: 'coder-1',
    kind: 'agent' as const,
    presetId: 'orgos-coder',
    cwd: '/work',
    ...over,
  })

  it('GIVEN 冷启动无会话 WHEN ensure THEN create 且 setup 挂载 preset/监听器', async () => {
    const rt = await runtime.ensure(member())
    expect(rt.sessionId).toBe('orgos-member-coder-1')
    expect(rt.status).toBe('idle')
    expect(rt.presetId).toBe('orgos-coder')
    expect(agents.createCalls.length).toBe(1)
    const opts = agents.createCalls[0] as { sessionId: string; meta: { cwd?: string; agentPreset?: string }; agentOptions?: { provider: string; model: string } }
    expect(opts.meta).toEqual({ cwd: '/work', agentPreset: 'orgos-coder' })
    expect(opts.agentOptions).toEqual({ provider: 'deepseek', model: 'chat' })
    expect(mountCalls.length).toBe(1)
    expect(mountCalls[0]?.[1]).toBe('orgos-coder')
    expect(statusEvents).toContainEqual(['coder-1', 'idle'])
  })

  it('GIVEN 已持有句柄 WHEN 再次 ensure THEN 命中缓存不重复 create', async () => {
    await runtime.ensure(member())
    await runtime.ensure(member())
    expect(agents.createCalls.length).toBe(1)
  })

  it('GIVEN 会话可 resume WHEN ensure THEN resume 优先于 create', async () => {
    agents.resumeResult = { agent: new FakeAgent('orgos-member-coder-1', 'running'), dispose: async () => {} }
    const rt = await runtime.ensure(member())
    expect(agents.resumeCalls.length).toBe(1)
    expect(agents.createCalls.length).toBe(0)
    expect(rt.status).toBe('busy')
  })

  it('GIVEN resume 抛 not found WHEN ensure THEN 回退 create', async () => {
    agents.failResume = new Error('SESSION not found')
    const rt = await runtime.ensure(member())
    expect(agents.resumeCalls.length).toBe(1)
    expect(agents.createCalls.length).toBe(1)
    expect(rt.sessionId).toBe('orgos-member-coder-1')
  })

  it('GIVEN resume 抛其他错误 WHEN ensure THEN 直接抛出', async () => {
    agents.failResume = new Error('BOOM')
    await expect(runtime.ensure(member())).rejects.toThrow('BOOM')
    expect(agents.createCalls.length).toBe(0)
  })

  it('GIVEN 外部已有 agent 句柄 WHEN ensure THEN 直接复用', async () => {
    const live = new FakeAgent('orgos-member-coder-1', 'running')
    agents.registry.set('orgos-member-coder-1', live)
    const rt = await runtime.ensure(member())
    expect(rt.status).toBe('busy')
    expect(agents.createCalls.length).toBe(0)
    expect(agents.resumeCalls.length).toBe(0)
  })

  it('GIVEN 岗位模型配置 WHEN ensure THEN 优先岗位模型', async () => {
    await runtime.ensure(member({ model: { provider: 'p1', model: 'm1' } }))
    const opts = agents.createCalls[0] as { agentOptions?: { provider: string; model: string } }
    expect(opts.agentOptions).toEqual({ provider: 'p1', model: 'm1' })
  })

  it('GIVEN 无部署默认模型 WHEN ensure THEN 不注入 agentOptions', async () => {
    const bare = new SessionMemberRuntime(agents, presets, undefined)
    await bare.ensure(member())
    const opts = agents.createCalls[0] as { agentOptions?: unknown }
    expect(opts.agentOptions).toBeUndefined()
  })

  it('GIVEN wake 且 idle WHEN deliver THEN followup 唤醒', async () => {
    const rt = await runtime.ensure(member())
    const agent = agents.registry.get('orgos-member-coder-1') as FakeAgent
    runtime.deliver({ agent }, '开工', { wake: true, source: { kind: 'user' } })
    expect(agent.followupCalls.length).toBe(1)
    expect(agent.injectCalls.length).toBe(0)
    const msg = agent.followupCalls[0] as { source: { kind: string } }
    expect(msg.source.kind).toBe('user')
    void rt
  })

  it('GIVEN wake 但 running WHEN deliver THEN inject 不唤醒', async () => {
    agents.registry.set('orgos-member-coder-1', new FakeAgent('orgos-member-coder-1', 'running'))
    const rt = await runtime.ensure(member())
    const agent = agents.registry.get('orgos-member-coder-1') as FakeAgent
    runtime.deliver({ agent }, '继续', { wake: true })
    expect(agent.followupCalls.length).toBe(0)
    expect(agent.injectCalls.length).toBe(1)
    void rt
  })

  it('GIVEN wake=false WHEN deliver THEN inject', async () => {
    const rt = await runtime.ensure(member())
    const agent = agents.registry.get('orgos-member-coder-1') as FakeAgent
    runtime.deliver({ agent }, '通知', { wake: false })
    expect(agent.injectCalls.length).toBe(1)
    void rt
  })

  describe('审批监听(fail-closed)', () => {
    it('GIVEN 成员 agentCtx 挂载 WHEN 审批请求 THEN 呈现并等待回执', async () => {
      const ctx = new FakeAgentCtx()
      // 直接经 create 的 setup 已验证挂载;此处取挂载到的 ctx 断言监听注册
      await runtime.ensure(member())
      const opts = agents.createCalls[0] as { setup?: (c: FakeAgentCtx) => Promise<unknown> }
      await opts.setup?.(ctx)
      const listener = ctx.listenerFor('approval/request')
      expect(listener).toBeDefined()
      expect(ctx.onCalls.find((c) => c.event === 'approval/request')?.options?.prepend).toBe(true)
      const req = { toolName: 'bash', reason: '执行命令' }
      let resolved = ''
      const promise = (listener as (req: typeof req, next: () => Promise<string>) => Promise<string>)(req, async () => 'unavailable')
      void promise.then((v) => {
        resolved = v
      })
      expect(approvalEvents.length).toBe(1)
      expect(approvalEvents[0]?.[0]).toBe('coder-1')
      expect(approvalEvents[0]?.[2]).toBe('bash')
      const approvalId = approvalEvents[0]?.[1] ?? ''
      expect(approvalId.startsWith('ap-')).toBe(true)
      expect(runtime.resolveApproval(approvalId, 'allow')).toBe(true)
      await promise
      expect(resolved).toBe('allowed-once')
    })

    it('GIVEN deny 回执 WHEN resolveApproval THEN rejected', async () => {
      const ctx = new FakeAgentCtx()
      await runtime.ensure(member())
      const opts = agents.createCalls[0] as { setup?: (c: FakeAgentCtx) => Promise<unknown> }
      await opts.setup?.(ctx)
      const listener = ctx.listenerFor('approval/request') as (req: { toolName?: string }, next: () => Promise<string>) => Promise<string>
      let resolved = ''
      const promise = listener({ toolName: 'write' }, async () => 'unavailable')
      void promise.then((v) => {
        resolved = v
      })
      const approvalId = approvalEvents[0]?.[1] ?? ''
      runtime.resolveApproval(approvalId, 'deny')
      await promise
      expect(resolved).toBe('rejected')
      // 已答复的审批再次回执 → false
      expect(runtime.resolveApproval(approvalId, 'allow')).toBe(false)
    })

    it('GIVEN 未知审批 id WHEN resolveApproval THEN false', () => {
      expect(runtime.resolveApproval('ap-ghost', 'allow')).toBe(false)
    })

    it('GIVEN 10 分钟无回执 WHEN 超时 THEN fail-closed rejected', async () => {
      vi.useFakeTimers()
      const ctx = new FakeAgentCtx()
      await runtime.ensure(member())
      const opts = agents.createCalls[0] as { setup?: (c: FakeAgentCtx) => Promise<unknown> }
      await opts.setup?.(ctx)
      const listener = ctx.listenerFor('approval/request') as (req: { toolName?: string }, next: () => Promise<string>) => Promise<string>
      let resolved = ''
      const promise = listener({ toolName: 'bash' }, async () => 'unavailable')
      void promise.then((v) => {
        resolved = v
      })
      vi.advanceTimersByTime(10 * 60_000)
      await promise
      expect(resolved).toBe('rejected')
    })
  })

  describe('回送监听', () => {
    it('GIVEN assistant/message 事件 WHEN session/event THEN 回送文本', async () => {
      const ctx = new FakeAgentCtx()
      await runtime.ensure(member())
      const opts = agents.createCalls[0] as { setup?: (c: FakeAgentCtx) => Promise<unknown> }
      await opts.setup?.(ctx)
      const listener = ctx.listenerFor('session/event') as (s: { id: string }, e: { type?: string; data?: { message?: { content?: Array<{ type?: string; text?: string }> } } }) => void
      listener({ id: 's1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '已' }, { type: 'text', text: '完成' }, { type: 'tool', text: 'x' }] } } })
      expect(assistantEvents).toContainEqual(['coder-1', '已完成'])
    })

    it('GIVEN 非 assistant/message 事件 WHEN session/event THEN 忽略', async () => {
      const ctx = new FakeAgentCtx()
      await runtime.ensure(member())
      const opts = agents.createCalls[0] as { setup?: (c: FakeAgentCtx) => Promise<unknown> }
      await opts.setup?.(ctx)
      const listener = ctx.listenerFor('session/event') as (s: { id: string }, e: { type?: string }) => void
      listener({ id: 's1' }, { type: 'agent/status' })
      expect(assistantEvents.length).toBe(0)
    })

    it('GIVEN 无 onAssistant 回调 WHEN 构造 THEN 监听不注册', async () => {
      const bare = new SessionMemberRuntime(agents, presets)
      const ctx = new FakeAgentCtx()
      await bare.ensure(member())
      const opts = agents.createCalls[0] as { setup?: (c: FakeAgentCtx) => Promise<unknown> }
      await opts.setup?.(ctx)
      expect(ctx.listenerFor('session/event')).toBeUndefined()
      expect(ctx.listenerFor('approval/request')).toBeUndefined()
    })
  })
})
