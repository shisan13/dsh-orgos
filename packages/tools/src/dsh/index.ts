/**
 * dsh-orgos-tools —— agent 平面 cordis 插件入口(preset 行:name 'dsh-orgos-tools/dsh')
 *
 * 可选消费:ctx.get('teamService') 缺失时不注册任何工具(跨 profile 容错,技术设计 §7.2)。
 */
export const name = 'dsh-orgos-tools'

interface Ctx {
  get(key: string): unknown
  tools?: { register(def: unknown): () => void }
}

import { registerTeamTools } from './registerTeamTools.js'

export function apply(ctx: Ctx): void {
  const tools = ctx.get('tools')
  if (tools === undefined) return
  registerTeamTools(ctx, tools as never)
}
