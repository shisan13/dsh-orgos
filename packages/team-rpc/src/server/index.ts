/**
 * dsh-orgos-team-rpc 服务端行(bundle 行:name 'dsh-orgos-team-rpc/server',host 平面)
 *
 * 中央实例暴露 POST <path>(默认 /api/orgos/rpc):成员子进程内的 team_* 工具经此
 * 直连 TeamService。安全模型:
 * - 认证:每成员随机 token(TeamService.issueMemberRpc 签发,子进程 env 注入),
 *   verifyMemberRpc 恒时比较;positionId 与 token 绑定,客户端身份字段不可信;
 * - 白名单:仅 REMOTE_TOOL_DEFS(13 个远程化工具)按 method 分派,不反射调用;
 * - 权限:dispatch 用「经校验的 positionId」重放 def.invoke —— 服务端
 *   resolveViewer/roleScope 投影兜底(与本地工具同一权限路径);
 * - 审计:每请求 TeamService.logRpc 落 runs 流;请求体 1MB 上限。
 *
 * 依赖:teamService(team-core 行)+ webServer(官方 host 服务,get 可缺省 → 行停用)。
 */
export const name = 'dsh-orgos-team-rpc/server'

export const inject = ['teamService']

import { failRpc, okRpc, remoteDefByMethod, MAX_RPC_BODY_BYTES, type RpcRequest } from '../index.js'
import type { IncomingMessage, ServerResponse } from 'node:http'

interface TeamServiceLike {
  verifyMemberRpc(positionId: string, token: string): boolean
  logRpc(positionId: string, method: string, ok: boolean): void
}

interface WebServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
  }): () => void
}

interface Ctx {
  get(key: string): unknown
  teamService: TeamServiceLike
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void }
}

interface ServerConfig {
  /** 挂载路径(默认 /api/orgos/rpc) */
  path?: string
}

export function apply(ctx: Ctx, config: ServerConfig = {}): void {
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  if (webServer === undefined) {
    ctx.logger.warn('[dsh-orgos-team-rpc/server] webServer 服务缺失,行停用(团队工具远程化不启用)')
    return
  }
  const path = config.path ?? '/api/orgos/rpc'
  webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      let positionId = ''
      let method = ''
      try {
        if (req.method !== 'POST') {
          respond(res, failRpc('bad_request', '仅接受 POST'))
          return
        }
        const raw = await readBody(req, MAX_RPC_BODY_BYTES)
        const body = JSON.parse(raw) as Partial<RpcRequest>
        positionId = typeof body.positionId === 'string' ? body.positionId : ''
        method = typeof body.method === 'string' ? body.method : ''
        const token = typeof body.token === 'string' ? body.token : ''
        const args = body.args === null || body.args === undefined ? {} : body.args
        if (typeof args !== 'object' || Array.isArray(args)) {
          respond(res, failRpc('bad_request', 'args 必须为对象'))
          return
        }
        // 认证:token 与 positionId 绑定,恒时比较
        if (!ctx.teamService.verifyMemberRpc(positionId, token)) {
          ctx.teamService.logRpc(positionId || 'unknown', method || 'unknown', false)
          respond(res, failRpc('unauthorized', 'token 与岗位不匹配'))
          return
        }
        // 白名单分派:仅远程化工具,按 method 查表,不反射
        const def = remoteDefByMethod(method)
        if (def === undefined) {
          ctx.teamService.logRpc(positionId, method, false)
          respond(res, failRpc('invalid_method', `method 不在远程化白名单:${method}`))
          return
        }
        const service = ctx.get('teamService') as unknown
        const result = await def.invoke(service as never, args as Record<string, unknown>, positionId)
        ctx.teamService.logRpc(positionId, method, true)
        respond(res, okRpc(result))
      } catch (error) {
        // 解析/分派异常:internal(业务错误已由工具结果承载,不进异常路径)
        ctx.teamService.logRpc(positionId || 'unknown', method || 'unknown', false)
        respond(res, failRpc('bad_request', String(error).slice(0, 200)))
      }
    },
  })
  ctx.logger.info(`[dsh-orgos-team-rpc/server] RPC 端点已注册:POST ${path}`)
}

/** 读取请求体(大小上限;超限抛错 → bad_request) */
async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > limit) throw new Error(`请求体超过上限 ${limit} 字节`)
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 统一响应:业务结果一律 HTTP 200 + envelope */
function respond(res: ServerResponse, body: unknown): void {
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}
