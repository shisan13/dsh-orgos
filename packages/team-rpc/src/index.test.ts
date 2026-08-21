/**
 * team-rpc 协议层测试:Given-When-Then
 * 覆盖 okRpc/failRpc/白名单查表/远程化名单(与 core TeamToolDefs 同源断言)。
 */
import { describe, expect, it } from 'vitest'
import { failRpc, okRpc, remoteDefByMethod, remoteToolNames, toolDefByName, MAX_RPC_BODY_BYTES } from './index.js'

describe('team-rpc 协议层', () => {
  it('GIVEN 任意值 WHEN okRpc/failRpc THEN envelope 形状稳定', () => {
    expect(okRpc({ a: 1 })).toEqual({ ok: true, result: { a: 1 } })
    expect(failRpc('unauthorized', 'x')).toEqual({ ok: false, code: 'unauthorized', reason: 'x' })
    expect(failRpc('internal')).toEqual({ ok: false, code: 'internal', reason: undefined })
  })

  it('GIVEN 方法名 WHEN remoteDefByMethod THEN 白名单命中/未命中语义正确', () => {
    expect(remoteDefByMethod('docCreate')?.name).toBe('team_doc_create')
    expect(remoteDefByMethod('doctor')).toBeUndefined() // 非远程化方法不在白名单
    expect(remoteDefByMethod('nonexistent')).toBeUndefined()
  })

  it('GIVEN 名单 WHEN remoteToolNames/toolDefByName THEN 与 core defs 同源一致', () => {
    expect(remoteToolNames()).toHaveLength(13)
    expect(remoteToolNames()).toContain('team_doc_update')
    expect(remoteToolNames()).not.toContain('team_setup')
    expect(toolDefByName('team_status')?.method).toBe('status')
    expect(toolDefByName('team_setup')).toBeUndefined()
  })

  it('GIVEN 体积上限 WHEN 读取常量 THEN 1MB', () => {
    expect(MAX_RPC_BODY_BYTES).toBe(1_000_000)
  })
})
