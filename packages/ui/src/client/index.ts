/**
 * dsh-orgos-ui/client —— Client 半入口(行 name 'dsh-orgos-ui/client')
 * 与官方 client 包契约一致:./client 子路径导出,插件在浏览器加载。
 * M2 首版:数据加载器 + 最小化渲染占位;Slot 注册在实跑验收阶段校准。
 */
export const name = 'dsh-orgos-ui'

interface ClientCtx {
  get(key: string): unknown
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void }
}

export async function fetchTeamSnapshot(): Promise<unknown> {
  try {
    const res = await fetch('/api/orgos/snapshot', { headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

export function apply(ctx: ClientCtx): void {
  ctx.logger.info('[dsh-orgos-ui] client half loaded; team snapshot loader ready')
}
