/**
 * dsh-orgos-ui Client 半 —— 团队室页签(conversation.view list seat)
 *
 * 参照官方 ui-trajectory 的注册模式:ctx.slots.inject('conversation.view',
 * () => ctx.slots.register({ name, id, order, label, inject }, Component))。
 * 数据源:GET /api/orgos/snapshot(host 侧 core 行注册的只读快照)。
 */
import { createElement, useEffect, useState } from 'react'

export const name = 'dsh-orgos-ui'

interface ClientCtx {
  slots: {
    inject(slot: string, factory: () => () => void): unknown
    register(options: unknown, component: unknown): () => void
  }
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

async function fetchTeamSnapshot(): Promise<TeamSnapshotData | null> {
  try {
    const res = await fetch('/api/orgos/snapshot', { headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    return (await res.json()) as TeamSnapshotData
  } catch {
    return null
  }
}

/** 团队室视图组件:组织树摘要 + 成员状态 + 运行摘要 + 健康检查 */
function TeamRoomView(): unknown {
  const [data, setData] = useState<TeamSnapshotData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      void fetchTeamSnapshot().then((snap) => {
        if (cancelled) return
        if (snap === null) setError('团队快照不可用(未安装 dsh-orgos-core 或 /api/orgos/snapshot 未注册)')
        else setData(snap)
      })
    }
    load()
    const timer = setInterval(load, 15_000) // 15s 轮询
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  if (error !== null) {
    return createElement('div', { style: { padding: 24, color: '#999' } }, error)
  }
  if (data === null) {
    return createElement('div', { style: { padding: 24, color: '#999' } }, '加载团队状态…')
  }
  const checks = data.doctor?.checks ?? []
  return createElement(
    'div',
    { style: { padding: 24, display: 'flex', flexDirection: 'column', gap: 16 } },
    createElement('h3', null, `团队 · ${data.org ?? '未初始化'}`),
    createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      ...(data.positions.map((p) =>
        createElement(
          'div',
          { key: p.id, style: { display: 'flex', gap: 8, alignItems: 'center' } },
          createElement('span', { style: { minWidth: 96, fontWeight: 600 } }, p.id),
          createElement('span', { style: { color: p.kind === 'human' ? '#7c6' : '#7ac' } }, p.kind === 'human' ? '真人' : '虚拟员工'),
          p.preset !== undefined ? createElement('span', { style: { color: '#888' } }, p.preset) : null,
          createElement('span', {
            style: {
              color: p.status === 'busy' ? '#e80' : p.status === 'idle' ? '#2a2' : '#999',
            },
          }, p.status),
        ),
      )),
    ),
    data.run !== undefined
      ? createElement('div', { style: { color: '#666' } }, data.run)
      : null,
    createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 4, borderTop: '1px solid #eee', paddingTop: 8 } },
      ...checks.map((c) =>
        createElement(
          'div',
          { key: c.name, style: { display: 'flex', gap: 8, fontSize: 13 } },
          createElement('span', { style: { color: c.ok ? '#2a2' : '#e22', fontWeight: 700 } }, c.ok ? '✓' : '✗'),
          createElement('span', { style: { color: '#555' } }, c.detail),
        ),
      ),
    ),
  )
}

export function apply(ctx: ClientCtx): void {
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      {
        name: 'conversation.view',
        id: 'orgos-team',
        order: 20,
        label: () => '团队室',
        inject: () => ({}),
      },
      TeamRoomView,
    ),
  )
  ctx.logger.info('[dsh-orgos-ui] 团队室页签已注册(conversation.view #orgos-team)')
}
