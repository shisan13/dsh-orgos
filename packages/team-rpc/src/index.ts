/**
 * dsh-orgos-team-rpc —— 协议层(M3.2 团队工具远程化)
 *
 * 成员子进程(RPC 客户端)与中央实例(RPC 服务端)之间的最小 JSON 契约:
 * - 请求:{ positionId, token, method, args };method = TeamToolDef.method(白名单),
 *   args = 用户参数(不含身份,身份永远由服务端经 token 校验后注入);
 * - 响应:业务结果一律 HTTP 200 + envelope(错误不进 HTTP 状态码语义);
 * - 本文件纯类型与纯函数,零 IO(测试与服务端/客户端两行共用)。
 */
import { REMOTE_TOOL_DEFS, toolDefByName, type TeamToolDef } from 'dsh-orgos-core/dsh/teamToolDefs'

export interface RpcRequest {
  positionId: string
  token: string
  method: string
  args: Record<string, unknown>
}

export type RpcErrorCode = 'unauthorized' | 'invalid_method' | 'bad_request' | 'internal'

export type RpcResponse = { ok: true; result: unknown } | { ok: false; code: RpcErrorCode; reason?: string }

/** 请求体大小上限(1MB;超限按 bad_request 拒绝,防内存滥用) */
export const MAX_RPC_BODY_BYTES = 1_000_000

export function okRpc(result: unknown): RpcResponse {
  return { ok: true, result }
}

export function failRpc(code: RpcErrorCode, reason?: string): RpcResponse {
  return { ok: false, code, reason }
}

/** 白名单方法 → 远程化工具定义(不反射调用,非法 method 返回 undefined) */
export function remoteDefByMethod(method: string): TeamToolDef | undefined {
  return REMOTE_TOOL_DEFS.find((d) => d.method === method)
}

/** 远程化工具名(与 TeamToolDefs 同源;工具名→method 的防漂移断言用) */
export function remoteToolNames(): string[] {
  return REMOTE_TOOL_DEFS.map((d) => d.name)
}

export { toolDefByName }
