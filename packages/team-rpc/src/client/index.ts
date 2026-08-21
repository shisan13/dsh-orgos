/**
 * dsh-orgos-team-rpc 客户端行(成员子进程组合挂载:name 'dsh-orgos-team-rpc/client')
 *
 * 在 SDK/ACP 成员子进程内注册远程化的 team_* 工具(与中央 dsh-orgos-tools 行
 * 同 schema、同描述,由 TeamToolDefs 单源驱动),execute 经 HTTP 转发中央实例
 * RPC 端点。身份三要素经子进程 env 注入(父进程 memberEnv 生成):
 *   DSH_ORGOS_RPC_URL / DSH_ORGOS_RPC_POSITION / DSH_ORGOS_RPC_TOKEN
 * 子进程组合行 config(!!js 读 env):
 *   { baseUrl, positionId, token, timeoutMs? }
 *
 * fail-closed:三要素任一缺失 → 行停用(成员退化为无团队工具,父代理路径兜底);
 * 转发失败返回 { ok:false, reason:'rpc_unreachable: ...' }(不吞不抛)。
 */
export const name = 'dsh-orgos-team-rpc/client'

export const inject = ['tools']

import { failRpc, type RpcResponse } from '../index.js'
import { REMOTE_TOOL_DEFS } from 'dsh-orgos-core/dsh/teamToolDefs'

interface ToolDefLike {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: { type: string }
    render(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }>
  }
  execute(args: unknown): Promise<unknown>
}

interface ToolsLike {
  register(def: ToolDefLike): () => void
}

interface Ctx {
  tools: ToolsLike
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void }
}

interface ClientConfig {
  /** 中央实例 RPC 端点(如 http://127.0.0.1:3081/api/orgos/rpc) */
  baseUrl?: string
  /** 成员岗位 id(env 注入) */
  positionId?: string
  /** 成员 RPC token(env 注入,父进程签发) */
  token?: string
  /** fetch 超时(默认 30s) */
  timeoutMs?: number
}

const JSON_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> => [
    { type: 'text', text: JSON.stringify(value, null, 2) },
  ],
}

export function apply(ctx: Ctx, config: ClientConfig = {}): void {
  const { baseUrl, positionId, token } = config
  if (!baseUrl || !positionId || !token) {
    ctx.logger.warn('[dsh-orgos-team-rpc/client] baseUrl/positionId/token 缺失,行停用(团队工具远程化不启用)')
    return
  }
  const timeoutMs = Math.max(1_000, config.timeoutMs ?? 30_000)
  for (const def of REMOTE_TOOL_DEFS) {
    ctx.tools.register({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      output: JSON_OUTPUT,
      async execute(args) {
        try {
          const res = await fetch(baseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ positionId, token, method: def.method, args: args ?? {} }),
            signal: AbortSignal.timeout(timeoutMs),
          })
          const body = (await res.json()) as RpcResponse
          if (body.ok) return body.result
          return failRpc(body.code, body.reason)
        } catch (error) {
          return { ok: false, reason: `rpc_unreachable: ${String(error).slice(0, 150)}` }
        }
      },
    })
  }
  ctx.logger.info(`[dsh-orgos-team-rpc/client] 已注册 ${REMOTE_TOOL_DEFS.length} 个远程化团队工具(→ ${baseUrl})`)
}
