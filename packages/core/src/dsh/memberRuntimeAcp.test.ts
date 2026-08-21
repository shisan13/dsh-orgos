/**
 * AcpMemberRuntime(member-acp 后端,M3.3:ACP 子进程 P1 常驻 + 跨轮次会话复用)测试:Given-When-Then
 * sdkClientEntry 指向临时 fake ACP 模块(@agentclientprotocol/sdk 结构形状:ClientSideConnection/
 * ndJsonStream/PROTOCOL_VERSION)+ fake spawn(node:stream PassThrough 包 stdin/stdout),
 * 断言:ensure 握手序列/跨轮次同 sessionId 复用/队列串行/文本累积回送/stopReason 分派/
 * 心跳上下文合并/裁剪/bootNote/release 重建/disposeAll/审批两分支/memberEnv/缺导出抛错/
 * Hybrid 四元分流/TeamService 接入。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AcpMemberRuntime, DshSdkMemberRuntime, HybridMemberRuntime, type AcpClientLike, type AcpSpawnImpl, type MemberDef } from './memberRuntime.js'
import { TeamService } from './teamService.js'
import type { DshAgents, AgentPresetsMount } from './memberRuntime.js'

/** fake ACP 客户端模块源码:记录连接/initialize/newSession/prompt 序列,可编程失败与 stopReason */
function fakeAcpModuleSource(): string {
  return `
export const state = {
  connections: [],
  failInitialize: null,
  failNewSession: null,
  failPrompt: null,
  stopReasons: [],
  silent: false,
  promptGate: null,
  noSessionId: false,
  inFlight: 0,
  maxInFlight: 0,
}
export function __reset() {
  state.connections.length = 0
  state.failInitialize = null
  state.failNewSession = null
  state.failPrompt = null
  state.stopReasons.length = 0
  state.silent = false
  state.promptGate = null
  state.noSessionId = false
  state.inFlight = 0
  state.maxInFlight = 0
}
export function __setFailInitialize(message) { state.failInitialize = message }
export function __setFailNewSession(message) { state.failNewSession = message }
export function __setFailPrompt(message) { state.failPrompt = message }
export function __setStopReason(...reasons) { state.stopReasons.push(...reasons) }
export function __setSilent(v) { state.silent = v }
export function __setPromptGate(gate) { state.promptGate = gate }
export function __setNoSessionId(v) { state.noSessionId = v }
export const PROTOCOL_VERSION = 1
class FakeClientSideConnection {
  constructor(toClient, stream) {
    this.stream = stream
    this.client = toClient({})
    this.initialized = undefined
    this.newSessions = []
    this.prompts = []
    this.canceled = []
    state.connections.push(this)
  }
  async initialize(params) {
    this.initialized = params
    if (state.failInitialize !== null) { const m = state.failInitialize; state.failInitialize = null; throw new Error(m) }
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] }
  }
  async newSession(params) {
    this.newSessions.push(params)
    if (state.failNewSession !== null) { const m = state.failNewSession; state.failNewSession = null; throw new Error(m) }
    if (state.noSessionId) return {}
    return { sessionId: 'acp-sess-' + String(this.newSessions.length) }
  }
  async prompt(params) {
    this.prompts.push(params)
    state.inFlight += 1
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
    try {
      if (state.promptGate !== null) await state.promptGate
      if (state.failPrompt !== null) { const m = state.failPrompt; state.failPrompt = null; throw new Error(m) }
      if (!state.silent) {
        const text = String(params?.prompt?.[0]?.text ?? '')
        await this.client.sessionUpdate({ sessionId: params?.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACP-REPLY:' + text.split('\\n')[0] } } })
      }
      const reason = state.stopReasons.length > 0 ? state.stopReasons.shift() : 'end_turn'
      return { stopReason: reason }
    } finally {
      state.inFlight -= 1
    }
  }
  async cancel(params) { this.canceled.push(params) }
}
export const ClientSideConnection = FakeClientSideConnection
export function ndJsonStream(output, input) { return { writable: output, readable: input } }
`
}

/** fake SDK 客户端模块源码(仅 Hybrid 分流测试用,复用既有 DshSdkMemberRuntime) */
function fakeSdkModuleSource(): string {
  return `
export const instances = []
class FakeHarness {
  constructor(options) {
    this.options = options
    this.closed = false
    this.runs = []
    instances.push(this)
  }
  session(id) {
    return { run: async (input) => { this.runs.push({ id, input }); return { finalResponse: 'SDK-REPLY:' + input.split('\\n')[0] } } }
  }
  async close() { this.closed = true }
}
export const DeepSeekHarness = FakeHarness
`
}

const member = (positionId = 'coder-1'): MemberDef => ({
  positionId,
  kind: 'agent',
  presetId: 'orgos-coder',
})

describe('AcpMemberRuntime(member-acp 后端,ACP 子进程 P1 常驻)', () => {
  let dir: string
  let acpEntry: string
  let mod: {
    state: {
      connections: Array<{
        initialized?: unknown
        newSessions: Array<{ cwd: string; mcpServers: unknown[] }>
        prompts: Array<{ sessionId: string; prompt: Array<{ type: string; text: string }> }>
        canceled: unknown[]
        client: AcpClientLike
      }>
      maxInFlight: number
    }
    __setFailInitialize(message: string): void
    __setFailNewSession(message: string): void
    __setFailPrompt(message: string): void
    __setStopReason(...reasons: string[]): void
    __setSilent(v: boolean): void
    __setPromptGate(g: Promise<void> | null): void
    __setNoSessionId(v: boolean): void
  }
  /** spawn 注入记录:每次 ensure 的 spawn spec 与句柄 */
  const spawnSpecs: Array<{ argv: string[]; cwd: string; env?: Record<string, string> }> = []
  const spawnProcs: Array<{ stdin: PassThrough; stdout: PassThrough; kills: string[]; stdinEnded: boolean }> = []
  const spawnImpl: AcpSpawnImpl = (spec) => {
    spawnSpecs.push(spec)
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const proc = {
      stdin,
      stdout,
      kills: [] as string[],
      stdinEnded: false,
    }
    const origEnd = stdin.end.bind(stdin)
    ;(stdin as { end(): unknown }).end = ((..._args: unknown[]) => {
      proc.stdinEnded = true
      return origEnd()
    }) as never
    spawnProcs.push(proc)
    return {
      stdin,
      stdout,
      kill: (signal?: string) => {
        proc.kills.push(signal ?? 'SIGTERM')
      },
    }
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'orgos-acp-'))
    writeFileSync(join(dir, 'fake-acp.mjs'), fakeAcpModuleSource())
    acpEntry = pathToFileURL(join(dir, 'fake-acp.mjs')).href
    mod = (await import(acpEntry)) as never
    spawnSpecs.length = 0
    spawnProcs.length = 0
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function makeRuntime(
    opts: { launch?: { command: string; args: string[]; cwd?: string; env?: Record<string, string> }; permission?: 'reject' | 'allow' } = {},
    onStatus?: (positionId: string, status: string) => void,
    onAssistant?: (positionId: string, text: string) => void,
    onEvent?: (positionId: string, event: string, detail: string) => void,
    memberEnv?: (positionId: string) => Record<string, string>,
  ): AcpMemberRuntime {
    return new AcpMemberRuntime(
      {
        sdkClientEntry: acpEntry,
        launch: opts.launch ?? { command: 'node', args: ['acp-agent.mjs', 'member-acp.cordis.yml'] },
        ...(opts.permission === undefined ? {} : { permission: opts.permission }),
      },
      onStatus,
      onAssistant,
      onEvent,
      memberEnv,
      spawnImpl,
    )
  }

  it('GIVEN 首次 ensure WHEN 成员激活 THEN 握手序列 initialize→newSession 且参数完整(懒:仅激活成员才 spawn)', async () => {
    const runtime = makeRuntime()
    const snap = await runtime.ensure(member())
    expect(spawnSpecs).toHaveLength(1)
    expect(spawnSpecs[0]).toMatchObject({ argv: ['node', 'acp-agent.mjs', 'member-acp.cordis.yml'], cwd: process.cwd() })
    expect(mod.state.connections).toHaveLength(1)
    const conn = mod.state.connections[0]
    expect(conn.initialized).toMatchObject({ protocolVersion: 1, clientCapabilities: {} })
    expect(conn.newSessions).toHaveLength(1)
    // newSession:绝对 cwd(无岗位/launch cwd → 进程 cwd)+ mcpServers 空
    expect(conn.newSessions[0]?.cwd).toBe(process.cwd())
    expect(conn.newSessions[0]?.mcpServers).toEqual([])
    expect(snap).toMatchObject({ positionId: 'coder-1', kind: 'agent', status: 'idle', sessionId: 'orgos-member-acp-coder-1' })
  })

  it('GIVEN 连续两条消息 WHEN deliver THEN 队列串行 prompt 且复用同一服务端 sessionId(子进程不重启,跨轮次会话)', async () => {
    const runtime = makeRuntime()
    await runtime.deliver(member(), '第一轮', { wake: true })
    await viWait()
    await runtime.deliver(member(), '第二轮', { wake: true })
    await viWait()
    expect(spawnProcs).toHaveLength(1) // 子进程不重启
    expect(mod.state.connections).toHaveLength(1)
    const conn = mod.state.connections[0]
    // newSession 返回服务端 sessionId('acp-sess-1'),跨轮次 prompt 复用同一 id(常驻会话)
    expect(conn.newSessions).toHaveLength(1)
    expect(conn.prompts.map((p) => p.sessionId)).toEqual(['acp-sess-1', 'acp-sess-1'])
    expect(conn.prompts.map((p) => p.prompt[0]?.text)).toEqual(['第一轮', '第二轮'])
  })

  it('GIVEN 两条消息背靠背入队 WHEN deliver THEN 无并发(单轮次语义 maxInFlight=1)且顺序消费', async () => {
    const runtime = makeRuntime()
    await runtime.deliver(member(), '甲', { wake: true })
    await runtime.deliver(member(), '乙', { wake: true })
    await viWait()
    const conn = mod.state.connections[0]
    expect(conn.prompts.map((p) => p.prompt[0]?.text)).toEqual(['甲', '乙'])
    expect(mod.state.maxInFlight).toBe(1)
  })

  it('GIVEN agent_message_chunk 累积 WHEN prompt 结束 THEN onAssistant 回送最终文本(仅 text 块,过滤噪音)', async () => {
    const replies: string[] = []
    const runtime = makeRuntime({}, undefined, (_p, t) => replies.push(t))
    await runtime.ensure(member()) // 先完成握手,连接就绪
    const conn = mod.state.connections[0]!
    mod.__setSilent(true)
    let releaseGate: () => void = () => {}
    mod.__setPromptGate(new Promise((r) => (releaseGate = r)))
    const delivering = runtime.deliver(member(), '任务', { wake: true })
    await new Promise((r) => setTimeout(r, 5)) // pump 进入 prompt 并挂起在 gate 上
    // 此刻 prompt 未返回:注入噪音与文本块 —— 只有 text 块被累积
    await conn.client.sessionUpdate({ sessionId: 'acp-sess-1', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'NOISE-THOUGHT' } } })
    await conn.client.sessionUpdate({ sessionId: 'acp-sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', text: 'NOISE-IMAGE' } } })
    await conn.client.sessionUpdate({ sessionId: 'acp-sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 123 as never } } })
    await conn.client.sessionUpdate({ sessionId: 'acp-sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK-TEXT' } } })
    releaseGate()
    await delivering
    await viWait()
    expect(replies).toEqual(['OK-TEXT'])
    expect(replies.join('')).not.toContain('NOISE')
  })

  it('GIVEN stopReason 分派 WHEN prompt 结束 THEN 正常轮次回送文本;refusal 无文本 → failed 且拒绝继续投递', async () => {
    const statuses: string[] = []
    const events: string[] = []
    const runtime = makeRuntime({}, (_p, s) => statuses.push(s), undefined, (_p, e, d) => events.push(`${e}:${d}`))
    // refusal 且无文本(静默)→ failed
    mod.__setStopReason('refusal')
    mod.__setSilent(true)
    await runtime.deliver(member(), '会拒绝的任务', { wake: true })
    await viWait()
    expect(statuses[statuses.length - 1]).toBe('failed')
    expect(events.some((x) => x.startsWith('run-error:'))).toBe(true)
    expect(events.some((x) => x.includes('stopReason=refusal'))).toBe(true)
    expect(await runtime.deliver(member(), '再试', { wake: true })).toBe(false)
    const snap = await runtime.ensure(member())
    expect(snap.status).toBe('failed')
  })

  it('GIVEN stopReason 分派边界 WHEN refusal 但有文本 / 静默 end_turn THEN 不 failed,有文本照常回送', async () => {
    const statuses: string[] = []
    const replies: string[] = []
    const runtime = makeRuntime({}, (_p, s) => statuses.push(s), (_p, t) => replies.push(t))
    // 静默 end_turn:无文本 → 不回送、不 failed,状态 idle
    mod.__setSilent(true)
    await runtime.deliver(member(), '静默任务', { wake: true })
    await viWait()
    expect(replies).toEqual([])
    expect(statuses[statuses.length - 1]).toBe('idle')
    // refusal 但有文本(auto-emit):部分产出也算产出 → 不回 failed,回送文本
    mod.__setSilent(false)
    mod.__setStopReason('refusal')
    await runtime.deliver(member(), '半成品', { wake: true })
    await viWait()
    expect(statuses[statuses.length - 1]).toBe('idle')
    expect(replies).toEqual(['ACP-REPLY:半成品'])
  })

  it('GIVEN wake:false 心跳 WHEN deliver THEN 只存上下文不 spawn;下一条真实消息合并为前缀只跑一轮', async () => {
    const events: string[] = []
    const runtime = makeRuntime({}, undefined, undefined, (_p, e) => events.push(e))
    const ok = await runtime.deliver(member(), '[心跳] 团队摘要...', { wake: false })
    expect(ok).toBe(true)
    expect(spawnProcs).toHaveLength(0) // 未 spawn
    expect(events).toContain('context')
    await runtime.deliver(member(), '[心跳] A', { wake: false })
    await runtime.deliver(member(), '[心跳] B', { wake: false })
    await runtime.deliver(member(), '真实任务', { wake: true })
    await viWait()
    expect(spawnProcs).toHaveLength(1)
    const conn = mod.state.connections[0]
    expect(conn.prompts).toHaveLength(1) // 心跳不产生独立轮次
    const input = conn.prompts[0]?.prompt[0]?.text ?? ''
    expect(input).toContain('[CONTEXT INJECT]')
    expect(input).toContain('[心跳] 团队摘要...')
    expect(input).toContain('[心跳] B')
    expect(input).toContain('真实任务')
  })

  it('GIVEN 心跳超 3 条 WHEN 合并 THEN 只保留最近 3 条(防无界增长)', async () => {
    const runtime = makeRuntime()
    for (let i = 0; i < 5; i++) await runtime.deliver(member(), `心跳-${i}`, { wake: false })
    await runtime.deliver(member(), '任务', { wake: true })
    await viWait()
    const input = mod.state.connections[0]?.prompts[0]?.prompt[0]?.text ?? ''
    expect(input).not.toContain('心跳-0')
    expect(input).not.toContain('心跳-1')
    expect(input).toContain('心跳-4')
  })

  it('GIVEN release 带 boot note WHEN 再次 deliver THEN 新子进程首条消息带 HANDOVER FRAMING', async () => {
    const runtime = makeRuntime()
    await runtime.deliver(member(), '原始消息', { wake: true })
    await viWait()
    runtime.release('coder-1', '交接:关注接口 x')
    await viWait(120)
    await runtime.deliver(member(), '新消息', { wake: true })
    await viWait()
    expect(spawnProcs).toHaveLength(2) // release 回收旧子进程,重建新子进程
    expect(mod.state.connections).toHaveLength(2)
    const input = mod.state.connections[1]?.prompts[0]?.prompt[0]?.text ?? ''
    expect(input).toContain('[HANDOVER FRAMING]')
    expect(input).toContain('交接:关注接口 x')
    expect(input).toContain('新消息')
  })

  it('GIVEN release WHEN 释放成员 THEN stdin end(EOF 探测)+ SIGTERM 升级(简化 disposeAcpChild 阶梯)', async () => {
    const runtime = makeRuntime()
    await runtime.deliver(member(), 'a', { wake: true })
    await viWait()
    const proc1 = spawnProcs[0]
    runtime.release('coder-1')
    await viWait(120)
    expect(proc1?.stdinEnded).toBe(true)
    expect(proc1?.kills).toEqual(['SIGTERM'])
    await runtime.deliver(member(), 'b', { wake: true })
    await viWait()
    expect(spawnProcs).toHaveLength(2)
  })

  it('GIVEN 两个成员 WHEN disposeAll THEN 全部子进程回收且后续 deliver 返回 false(closed 拒绝)', async () => {
    const runtime = makeRuntime()
    await runtime.deliver(member('coder-1'), 'a', { wake: true })
    await runtime.deliver(member('coder-2'), 'b', { wake: true })
    await viWait()
    expect(spawnProcs).toHaveLength(2)
    await runtime.disposeAll()
    expect(spawnProcs.every((p) => p.stdinEnded && p.kills.includes('SIGTERM'))).toBe(true)
    expect(await runtime.deliver(member('coder-1'), 'c', { wake: true })).toBe(false)
    expect(await runtime.deliver(member('coder-1'), '心跳', { wake: false })).toBe(false)
  })

  it('GIVEN requestPermission 回调 WHEN 审批请求 THEN 默认 fail-closed cancelled;allow 策略选第一个 allow 类 option', async () => {
    const rejectRuntime = makeRuntime()
    await rejectRuntime.ensure(member())
    const rejectConn = mod.state.connections[0]
    const rejected = await rejectConn.client.requestPermission({
      sessionId: 'acp-sess-1',
      options: [{ kind: 'allow_once', optionId: 'a1' }, { kind: 'allow_always', optionId: 'a2' }],
      toolCall: {},
    })
    expect(rejected).toEqual({ outcome: { outcome: 'cancelled' } })
    // allow 策略:选第一个 allow_once/allow_always option(跳过 reject 类)
    const allowRuntime = makeRuntime({ permission: 'allow' })
    await allowRuntime.ensure(member())
    const allowConn = mod.state.connections[1]
    const selected = await allowConn.client.requestPermission({
      sessionId: 'acp-sess-2',
      options: [{ kind: 'reject_once', optionId: 'r1' }, { kind: 'allow_always', optionId: 'a2' }, { kind: 'allow_once', optionId: 'a1' }],
      toolCall: {},
    })
    expect(selected).toEqual({ outcome: { outcome: 'selected', optionId: 'a2' } })
    // allow 策略但无 allow 类 option → 回落 cancelled
    const noAllow = await allowConn.client.requestPermission({
      sessionId: 'acp-sess-2',
      options: [{ kind: 'reject_once', optionId: 'r1' }],
      toolCall: {},
    })
    expect(noAllow).toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('GIVEN memberEnv 回调 WHEN ensure THEN 每成员 env 覆盖合并进 spawn env(M3.2 RPC 注入点复用)', async () => {
    const runtime = makeRuntime(
      { launch: { command: 'node', args: ['bin.mjs'], env: { PATH: '/usr/bin', BASE: 'x' } } },
      undefined,
      undefined,
      undefined,
      (positionId) => ({ DSH_ORGOS_RPC_URL: 'http://127.0.0.1:3081/api/orgos/rpc', DSH_ORGOS_RPC_POSITION: positionId, DSH_ORGOS_RPC_TOKEN: `tok-${positionId}` }),
    )
    await runtime.ensure(member('coder-1'))
    expect(spawnSpecs[0]?.env).toMatchObject({
      PATH: '/usr/bin',
      BASE: 'x',
      DSH_ORGOS_RPC_URL: 'http://127.0.0.1:3081/api/orgos/rpc',
      DSH_ORGOS_RPC_POSITION: 'coder-1',
      DSH_ORGOS_RPC_TOKEN: 'tok-coder-1',
    })
  })

  it('GIVEN 会话 cwd 解析 WHEN ensure THEN 岗位 cwd > launch.cwd > 进程 cwd;相对路径拒绝', async () => {
    // launch.cwd 兜底(岗位无 cwd)
    const runtime1 = makeRuntime({ launch: { command: 'node', args: [], cwd: '/tmp/acp-root' } })
    await runtime1.ensure(member('coder-1'))
    expect(spawnSpecs[0]?.cwd).toBe('/tmp/acp-root')
    expect(mod.state.connections[0]?.newSessions[0]?.cwd).toBe('/tmp/acp-root')
    // 岗位 cwd 优先
    const runtime2 = makeRuntime()
    await runtime2.ensure({ ...member('coder-2'), cwd: '/tmp/member-root' })
    expect(mod.state.connections[1]?.newSessions[0]?.cwd).toBe('/tmp/member-root')
    // 相对路径 → 拒绝且不 spawn
    const runtime3 = makeRuntime()
    await expect(runtime3.ensure({ ...member('coder-3'), cwd: 'relative/path' })).rejects.toThrow(/绝对路径/)
    expect(spawnSpecs).toHaveLength(2)
  })

  it('GIVEN newSession 抛错 WHEN ensure THEN 拒绝且已 spawn 子进程被回收(自清理);失败不残留,可重新握手', async () => {
    const runtime = makeRuntime()
    mod.__setFailNewSession('session boom')
    await expect(runtime.deliver(member(), 'x', { wake: true })).rejects.toThrow(/session boom/)
    await viWait(120)
    expect(spawnProcs).toHaveLength(1)
    expect(spawnProcs[0]?.stdinEnded).toBe(true)
    expect(spawnProcs[0]?.kills).toContain('SIGTERM')
    // 失败后该成员不残留条目(下次 deliver 重新握手 → 新子进程)
    await runtime.deliver(member(), 'y', { wake: true })
    await viWait()
    expect(spawnProcs).toHaveLength(2)
  })

  it('GIVEN newSession 未返回 sessionId WHEN ensure THEN 拒绝且子进程被回收(服务端契约缺失)', async () => {
    const runtime = makeRuntime()
    mod.__setNoSessionId(true)
    await expect(runtime.ensure(member())).rejects.toThrow(/未返回 sessionId/)
    await viWait(120)
    expect(spawnProcs).toHaveLength(1)
    expect(spawnProcs[0]?.kills).toContain('SIGTERM')
  })

  it('GIVEN sdkClientEntry 缺导出 WHEN deliver THEN 校验 ClientSideConnection/ndJsonStream/PROTOCOL_VERSION 抛错', async () => {
    writeFileSync(join(dir, 'bad-conn.mjs'), 'export const nope = 1\n')
    writeFileSync(join(dir, 'bad-stream.mjs'), 'export const ClientSideConnection = class {}\nexport const PROTOCOL_VERSION = 1\n')
    writeFileSync(join(dir, 'bad-version.mjs'), 'export const ClientSideConnection = class {}\nexport const ndJsonStream = () => ({})\n')
    const r1 = new AcpMemberRuntime({ sdkClientEntry: pathToFileURL(join(dir, 'bad-conn.mjs')).href, launch: { command: 'node', args: [] } }, undefined, undefined, undefined, undefined, spawnImpl)
    await expect(r1.deliver(member(), 'x', { wake: true })).rejects.toThrow(/ClientSideConnection/)
    const r2 = new AcpMemberRuntime({ sdkClientEntry: pathToFileURL(join(dir, 'bad-stream.mjs')).href, launch: { command: 'node', args: [] } }, undefined, undefined, undefined, undefined, spawnImpl)
    await expect(r2.deliver(member(), 'x', { wake: true })).rejects.toThrow(/ndJsonStream/)
    const r3 = new AcpMemberRuntime({ sdkClientEntry: pathToFileURL(join(dir, 'bad-version.mjs')).href, launch: { command: 'node', args: [] } }, undefined, undefined, undefined, undefined, spawnImpl)
    await expect(r3.deliver(member(), 'x', { wake: true })).rejects.toThrow(/PROTOCOL_VERSION/)
  })

  it('GIVEN 审批回执 WHEN resolveApproval THEN 恒 false(ACP 子进程审批走自动应答,无父侧链路)', () => {
    expect(makeRuntime().resolveApproval('ap-1', 'allow')).toBe(false)
  })

  it('GIVEN 失败态 WHEN 继续 deliver THEN 拒绝(需 release 重建)', async () => {
    const runtime = makeRuntime()
    mod.__setFailPrompt('transport closed')
    await runtime.deliver(member(), '会炸的任务', { wake: true })
    await viWait()
    expect(await runtime.deliver(member(), '再试', { wake: true })).toBe(false)
    runtime.release('coder-1', '重建')
    await viWait(120)
    await runtime.deliver(member(), '新进程任务', { wake: true })
    await viWait()
    expect(spawnProcs).toHaveLength(2) // 重建成功(旧 failed 条目已清除)
  })
})

describe('HybridMemberRuntime(四元分流:acp 优先 > sdk > session)', () => {
  it('GIVEN acp/sdk positions 并存 WHEN deliver THEN acp 岗位走 ACP、sdk 岗位走 SDK、其余走 session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orgos-acp-hybrid-'))
    writeFileSync(join(dir, 'fake-acp.mjs'), fakeAcpModuleSource())
    writeFileSync(join(dir, 'fake-sdk.mjs'), fakeSdkModuleSource())
    const acpEntry = pathToFileURL(join(dir, 'fake-acp.mjs')).href
    const sdkEntry = pathToFileURL(join(dir, 'fake-sdk.mjs')).href
    const acpMod = (await import(acpEntry)) as never as { state: { connections: Array<{ prompts: Array<{ prompt: Array<{ text: string }> }> }> } }
    const sdkMod = (await import(sdkEntry)) as never as { instances: Array<{ closed: boolean; runs: Array<{ id: string; input: string }> }> }
    const spawnSpecs: unknown[] = []
    const spawnImpl: AcpSpawnImpl = (spec) => {
      spawnSpecs.push(spec)
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      return { stdin, stdout, kill: () => {} }
    }
    const sessionCalls: string[] = []
    const sessionFacade = {
      ensure: async (m: MemberDef) => ({ positionId: m.positionId, kind: 'agent' as const, status: 'idle' as const }),
      deliver: async (m: MemberDef) => {
        sessionCalls.push(m.positionId)
        return true
      },
      release: () => {},
      resolveApproval: () => false,
      disposeAll: async () => {},
    }
    const acpRuntime = new AcpMemberRuntime({ sdkClientEntry: acpEntry, launch: { command: 'node', args: ['acp.mjs'] } }, undefined, undefined, undefined, undefined, spawnImpl)
    const sdkRuntime = new DshSdkMemberRuntime({ sdkClientEntry: sdkEntry, launch: { command: 'node', args: [] } })
    const hybrid = new HybridMemberRuntime(sessionFacade, sdkRuntime, new Set(['sdk-1']), acpRuntime, new Set(['acp-1']))
    await hybrid.deliver(member('acp-1'), 'a', { wake: true })
    await hybrid.deliver(member('sdk-1'), 'b', { wake: true })
    await hybrid.deliver(member('lead'), 'c', { wake: true })
    await viWait()
    expect(sessionCalls).toEqual(['lead'])
    // ensure/resolveApproval 透传门面(覆盖四元组各方法)
    const snap = await hybrid.ensure(member('lead'))
    expect(snap.positionId).toBe('lead')
    expect(hybrid.resolveApproval('ap-1', 'allow')).toBe(false)
    expect(acpMod.state.connections).toHaveLength(1) // 仅 acp-1 spawn ACP 子进程
    expect(acpMod.state.connections[0]?.prompts[0]?.prompt[0]?.text).toBe('a')
    expect(sdkMod.instances).toHaveLength(1) // 仅 sdk-1 spawn SDK 子进程
    expect(sdkMod.instances[0]?.runs.map((r) => r.id)).toEqual(['orgos-member-sdk-1'])
    // release 幂等覆盖三后端:acp 岗位带 boot note 重建
    hybrid.release('acp-1', '交接')
    await viWait(120)
    await hybrid.deliver(member('acp-1'), '新', { wake: true })
    await viWait()
    expect(acpMod.state.connections).toHaveLength(2)
    expect(acpMod.state.connections[1]?.prompts[0]?.prompt[0]?.text).toContain('[HANDOVER FRAMING]')
    await hybrid.disposeAll()
    expect(sdkMod.instances.every((i) => i.closed)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('TeamService acpMember 接入(M3.3)', () => {
  it('GIVEN acpMember 配置 WHEN 心跳注入 THEN acp 岗位走 deliver wake:false(上下文合并,不 spawn)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orgos-acp-ts-'))
    writeFileSync(join(dir, 'fake-acp.mjs'), fakeAcpModuleSource())
    const acpEntry = pathToFileURL(join(dir, 'fake-acp.mjs')).href
    const acpMod = (await import(acpEntry)) as never as { state: { connections: unknown[] } }
    const liveAgents: Array<{ id: string; inject(msg: unknown): void }> = [
      {
        id: 'orgos-member-lead',
        inject() {},
      },
    ]
    const agents: DshAgents = {
      async create(o: unknown) {
        const opts = o as { sessionId: string }
        return { agent: { id: opts.sessionId, status: 'idle', session: { id: opts.sessionId }, followup() {}, inject() {}, send() {}, dispose: async () => {} }, dispose: async () => {} }
      },
      async resume() {
        throw new Error('SESSION not found')
      },
      get: () => undefined,
      list: () => liveAgents as never,
    }
    const presets: AgentPresetsMount = { async mount() { return {} } }
    const service = new TeamService({
      stateRoot: dir,
      ownerIds: ['ou_owner'],
      agents,
      presets,
      acpMember: { sdkClientEntry: acpEntry, launch: { command: 'node', args: [] }, positions: ['acp-1'] },
    })
    expect(service.setupInit(TEST_ACP_YML).ok).toBe(true)
    service.heartbeatInject()
    // 远程(acp)成员:不 spawn 子进程(仅存上下文,下一轮合并)
    expect(acpMod.state.connections).toHaveLength(0)
    // acp 成员上下文事件已落 runs 流(acp-member 观测)
    const runs = service.store.readAll('runs') as Array<{ op: string; positionId?: string; event?: string }>
    expect(runs.some((r) => r.op === 'acp-member' && r.positionId === 'acp-1' && r.event === 'context')).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})

const TEST_ACP_YML = `org: acme
nodes:
  - id: acme
    kind: org
    orchestratorPosition: lead
    children: [team-main]
  - id: team-main
    kind: team
positions:
  - id: lead
    occupant: { kind: agent, preset: orgos-orchestrator }
  - id: acp-1
    teamId: team-main
    occupant: { kind: agent, preset: orgos-coder }
routes: []
acl:
  delegationDepthMax: 3
`

/** 等待 pump/teardown 异步链落定(无真实时钟依赖,微任务+定时器排空) */
async function viWait(ms = 40): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
