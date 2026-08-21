/**
 * DshSdkMemberRuntime(member-dsh-sdk 后端,P1 进程常驻)测试:Given-When-Then
 * sdkClientEntry 指向临时 fake 模块(导出 DeepSeekHarness 构造器 + 实例注册表),
 * 断言:懒 spawn/会话复用/一成员一子进程/队列串行/状态折叠/失败态/boot note/disposeAll。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DshSdkMemberRuntime, HybridMemberRuntime } from './memberRuntime.js'
import type { MemberDef } from './memberRuntime.js'

/** fake SDK 客户端模块源码:记录构造参数/会话/run 序列,可编程失败 */
function fakeModuleSource(): string {
  return `
export const instances = []
let failOn = null
export function __setFailOn(message) { failOn = message }
class FakeHarness {
  constructor(options) {
    this.options = options
    this.closed = false
    this.runs = []
    instances.push(this)
  }
  session(id) {
    return {
      run: async (input) => {
        this.runs.push({ id, input })
        if (failOn !== null) { const m = failOn; failOn = null; throw new Error(m) }
        return { finalResponse: 'SDK-REPLY:' + input.split('\\n')[0] }
      },
    }
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

describe('DshSdkMemberRuntime(member-dsh-sdk 后端)', () => {
  let dir: string
  let sdkEntry: string
  let mod: {
    instances: Array<{ options: unknown; closed: boolean; runs: Array<{ id: string; input: string }> }>
    __setFailOn(message: string): void
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'orgos-sdk-'))
    writeFileSync(join(dir, 'fake-sdk.mjs'), fakeModuleSource())
    sdkEntry = pathToFileURL(join(dir, 'fake-sdk.mjs')).href
    mod = (await import(sdkEntry)) as never
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function makeRuntime(onStatus?: (positionId: string, status: string) => void, onAssistant?: (positionId: string, text: string) => void): DshSdkMemberRuntime {
    return new DshSdkMemberRuntime(
      {
        sdkClientEntry: sdkEntry,
        launch: { command: 'node', args: ['bin.js', 'member.cordis.yml'] },
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        maxTokens: 16384,
      },
      onStatus,
      onAssistant,
    )
  }

  it('GIVEN 首次 ensure WHEN 成员激活 THEN spawn 子进程且 initialize 参数完整(懒:仅激活成员才 spawn)', async () => {
    const runtime = makeRuntime()
    await runtime.ensure(member())
    expect(mod.instances.length).toBe(1)
    await runtime.deliver(member(), '第一条任务', { wake: true })
    await viWait()
    expect(mod.instances.length).toBe(1)
    expect(mod.instances[0]?.options).toMatchObject({
      launch: { command: 'node', args: ['bin.js', 'member.cordis.yml'] },
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      maxTokens: 16384,
    })
  })

  it('GIVEN 连续两条消息 WHEN deliver THEN 队列串行 run 且复用同一会话 id(常驻人格)', async () => {
    const runtime = makeRuntime()
    await runtime.deliver(member(), '第一轮', { wake: true })
    await runtime.deliver(member(), '第二轮', { wake: true })
    await viWait()
    expect(mod.instances.length).toBe(1) // 子进程不重启
    expect(mod.instances[0]?.runs.map((r) => r.input)).toEqual(['第一轮', '第二轮'])
    expect(mod.instances[0]?.runs.map((r) => r.id)).toEqual(['orgos-member-coder-1', 'orgos-member-coder-1'])
  })

  it('GIVEN run 完成 WHEN 状态折叠 THEN busy→idle 且 onAssistant 收到最终文本', async () => {
    const statuses: string[] = []
    const replies: string[] = []
    const runtime = makeRuntime((_p, s) => statuses.push(s), (_p, t) => replies.push(t))
    await runtime.deliver(member(), '写周报', { wake: true })
    await viWait()
    expect(statuses.filter((s) => s === 'busy').length).toBeGreaterThanOrEqual(1)
    expect(statuses[statuses.length - 1]).toBe('idle')
    expect(replies).toEqual(['SDK-REPLY:写周报'])
  })

  it('GIVEN 两个成员 WHEN deliver THEN 每成员独立子进程(进程隔离)', async () => {
    const runtime = makeRuntime()
    await runtime.deliver(member('coder-1'), 'a', { wake: true })
    await runtime.deliver(member('coder-2'), 'b', { wake: true })
    await viWait()
    expect(mod.instances.length).toBe(2)
    expect(mod.instances[0]?.runs.map((r) => r.id)).toEqual(['orgos-member-coder-1'])
    expect(mod.instances[1]?.runs.map((r) => r.id)).toEqual(['orgos-member-coder-2'])
  })

  it('GIVEN release 带 boot note WHEN 再次 deliver THEN 新子进程首条消息带 HANDOVER FRAMING', async () => {
    const runtime = makeRuntime()
    await runtime.deliver(member(), '原始消息', { wake: true })
    await viWait()
    runtime.release('coder-1', '交接:关注接口 x')
    await runtime.deliver(member(), '新消息', { wake: true })
    await viWait()
    expect(mod.instances.length).toBe(2) // release 回收旧子进程,重建新子进程
    expect(mod.instances[0]?.closed).toBe(true)
    expect(mod.instances[1]?.runs[0]?.input).toContain('[HANDOVER FRAMING]')
    expect(mod.instances[1]?.runs[0]?.input).toContain('新消息')
  })

  it('GIVEN run 抛错 WHEN pump THEN 状态 failed 且后续 deliver 被拒', async () => {
    const statuses: string[] = []
    const runtime = makeRuntime((_p, s) => statuses.push(s))
    mod.__setFailOn('transport closed')
    await runtime.deliver(member(), '会炸的任务', { wake: true })
    await viWait()
    expect(statuses[statuses.length - 1]).toBe('failed')
    const retry = await runtime.deliver(member(), '再试', { wake: true })
    expect(retry).toBe(false)
    const snap = await runtime.ensure(member())
    expect(snap.status).toBe('failed')
  })

  it('GIVEN disposeAll WHEN 服务停止 THEN 全部子进程 close 且后续 deliver 返回 false', async () => {
    const runtime = makeRuntime()
    await runtime.deliver(member('coder-1'), 'a', { wake: true })
    await runtime.deliver(member('coder-2'), 'b', { wake: true })
    await viWait()
    await runtime.disposeAll()
    expect(mod.instances.every((i) => i.closed)).toBe(true)
    expect(await runtime.deliver(member('coder-1'), 'c', { wake: true })).toBe(false)
  })

  it('GIVEN 审批回执 WHEN resolveApproval THEN 恒 false(sdk 子进程无审批链路)', () => {
    expect(makeRuntime().resolveApproval('ap-1', 'allow')).toBe(false)
  })

  it('GIVEN memberEnv 回调 WHEN ensure THEN 每成员 env 覆盖合并进 launch.env(M3.2 RPC 注入点)', async () => {
    const runtime = new DshSdkMemberRuntime(
      {
        sdkClientEntry: sdkEntry,
        launch: { command: 'node', args: ['bin.js', 'm.yml'], env: { PATH: '/usr/bin', BASE: 'x' } },
      },
      undefined,
      undefined,
      undefined,
      (positionId) => ({ DSH_ORGOS_RPC_URL: 'http://127.0.0.1:3081/api/orgos/rpc', DSH_ORGOS_RPC_POSITION: positionId, DSH_ORGOS_RPC_TOKEN: `tok-${positionId}` }),
    )
    await runtime.ensure(member('coder-1'))
    expect(mod.instances[0]?.options).toMatchObject({
      launch: {
        command: 'node',
        env: {
          PATH: '/usr/bin',
          BASE: 'x',
          DSH_ORGOS_RPC_URL: 'http://127.0.0.1:3081/api/orgos/rpc',
          DSH_ORGOS_RPC_POSITION: 'coder-1',
          DSH_ORGOS_RPC_TOKEN: 'tok-coder-1',
        },
      },
    })
  })

  it('GIVEN sdkClientEntry 缺 DeepSeekHarness 导出 WHEN deliver THEN ensure 抛错', async () => {
    writeFileSync(join(dir, 'bad.mjs'), 'export const nope = 1\n')
    const runtime = new DshSdkMemberRuntime({ sdkClientEntry: pathToFileURL(join(dir, 'bad.mjs')).href, launch: { command: 'node', args: [] } })
    await expect(runtime.deliver(member(), 'x', { wake: true })).rejects.toThrow(/DeepSeekHarness/)
  })
})

/** 等待 pump 异步链落定(无真实时钟依赖,微任务排空) */
async function viWait(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

describe('HybridMemberRuntime(按岗位分流)', () => {
  it('GIVEN positions 列出 coder-1 WHEN deliver THEN sdk 岗位走子进程、其余走 session', async () => {
    const hdir = mkdtempSync(join(tmpdir(), 'orgos-sdk-h-'))
    writeFileSync(join(hdir, 'fake-sdk.mjs'), fakeModuleSource())
    const hEntry = pathToFileURL(join(hdir, 'fake-sdk.mjs')).href
    const hmod = (await import(hEntry)) as never as {
      instances: Array<{ closed: boolean; runs: Array<{ id: string; input: string }> }>
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
    const runtime = new DshSdkMemberRuntime({ sdkClientEntry: hEntry, launch: { command: 'node', args: [] } })
    const hybrid = new HybridMemberRuntime(sessionFacade, runtime, new Set(['coder-1']))
    await hybrid.deliver(member('coder-1'), 'a', { wake: true })
    await hybrid.deliver(member('lead'), 'b', { wake: true })
    await viWait()
    expect(sessionCalls).toEqual(['lead'])
    expect(hmod.instances.length).toBe(1) // 仅 coder-1 spawn 子进程
    expect(hmod.instances[0]?.runs.map((r) => r.id)).toEqual(['orgos-member-coder-1'])
    await hybrid.disposeAll()
    rmSync(hdir, { recursive: true, force: true })
  })
})
