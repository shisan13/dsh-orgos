/**
 * dsh-orgos-ui —— Client 半插件(dsh.client;行 name 'dsh-orgos-ui/client')
 *
 * M2 首版:团队室页签数据加载器 + 渲染组件(无 React 硬依赖,
 * 以注册函数形式暴露,由宿主 client 环境装配;Slot 注册在
 * 实跑验收阶段按 cordis_inspect Slots 契约校准后启用)。
 *
 * 数据源:GET /api/orgos/snapshot(host 侧 core 行注册的只读快照,
 * 根视角;scope 投影由工具层强制)。
 */
export const name = 'dsh-orgos-ui'

interface ClientCtx {
  get(key: string): unknown
  slots?: unknown
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void }
}

export interface TeamSnapshotData {
  loaded: boolean
  org?: string
  positions: Array<{ id: string; kind: 'agent' | 'human'; preset?: string; status: string }>
  delegations: unknown[]
  tasks: unknown[]
  mailCount: number
  run?: string
  doctor?: { checks: Array<{ name: string; ok: boolean; detail: string }> }
}

/** 拉取团队快照(30s 轮询由调用方决定;本函数单次拉取) */
export async function fetchTeamSnapshot(): Promise<TeamSnapshotData | null> {
  try {
    const res = await fetch('/api/orgos/snapshot', { headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    return (await res.json()) as TeamSnapshotData
  } catch {
    return null
  }
}

export function apply(ctx: ClientCtx): void {
  // M2 首版:暴露数据加载器;Slot 注册(团队室页签)在实跑验收阶段按
  // cordis_inspect 查询到的 Slot 树与 props 契约校准后启用。
  ctx.logger.info('[dsh-orgos-ui] client 已加载(数据加载器可用)')
}
