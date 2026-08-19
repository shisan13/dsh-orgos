/**
 * dsh-orgos-ui Client 半 —— 团队室页签(conversation.view list seat)
 *
 * 参照官方 ui-trajectory 的注册模式:ctx.slots.inject('conversation.view',
 * () => ctx.slots.register({ name, id, order, label, inject }, Component))。
 * 数据源:GET /api/orgos/snapshot(host 侧 core 行注册的只读快照)。
 */
import { createElement, useEffect, useState } from 'react'

export const name = 'dsh-orgos-ui'

// 官方契约:apply 中直接读取的 ctx 属性必须逐一声明注入。
// 客户端运行时只提供 slots(无 logger 服务),日志走浏览器 console。
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const inject = ['slots']

interface ClientCtx {
  slots: {
    inject(slot: string, factory: () => () => void): unknown
    register(options: unknown, component: unknown): () => void
  }
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

/** 状态语义映射:offline 是懒激活设计(派发时自动唤醒),不是故障。
 *  颜色全部走官方主题 CSS 变量(--dsw-alias-*),自动适配明暗主题。 */
const STATUS_VIEW: Record<string, { label: string; color: string }> = {
  offline: { label: '待命', color: 'var(--dsw-alias-brand-primary)' },
  idle: { label: '空闲', color: 'var(--dsw-alias-state-success-primary)' },
  busy: { label: '工作中', color: 'var(--dsw-alias-state-warn-primary)' },
  failed: { label: '异常', color: 'var(--dsw-alias-state-error-primary)' },
}

/** 主题别名,组件内统一引用,避免散落硬编码色 */
const T = {
  text: 'var(--dsw-alias-label-primary)',
  text2: 'var(--dsw-alias-label-secondary)',
  border: 'var(--dsw-alias-border-l1)',
  brand: 'var(--dsw-alias-brand-primary)',
  ok: 'var(--dsw-alias-state-success-primary)',
  err: 'var(--dsw-alias-state-error-primary)',
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
    return createElement('div', { style: { padding: 24, color: T.text2 } }, error)
  }
  if (data === null) {
    return createElement('div', { style: { padding: 24, color: T.text2 } }, '加载团队状态…')
  }
  const checks = data.doctor?.checks ?? []
  return createElement(
    'div',
    { style: { padding: 24, display: 'flex', flexDirection: 'column', gap: 16, color: T.text } },
    createElement('h3', null, `团队 · ${data.org ?? '未初始化'}`),
    createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      ...(data.positions.map((p) =>
        createElement(
          'div',
          { key: p.id, style: { display: 'flex', gap: 8, alignItems: 'center' } },
          createElement('span', { style: { minWidth: 96, fontWeight: 600 } }, p.id),
          createElement('span', { style: { color: p.kind === 'human' ? T.ok : T.brand } }, p.kind === 'human' ? '真人' : '虚拟员工'),
          p.preset !== undefined ? createElement('span', { style: { color: T.text2 } }, p.preset) : null,
          createElement('span', {
            style: {
              color: STATUS_VIEW[p.status]?.color ?? T.text2,
            },
          }, STATUS_VIEW[p.status]?.label ?? p.status),
        ),
      )),
    ),
    createElement(
      'div',
      { style: { color: T.text2, fontSize: 12 } },
      '成员按需唤醒:「待命」= 未派发任务,派发时自动上线,不产生常驻成本。',
    ),
    data.run !== undefined
      ? createElement('div', { style: { color: T.text2 } }, data.run)
      : null,
    createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 4, borderTop: `1px solid ${T.border}`, paddingTop: 8 } },
      ...checks.map((c) =>
        createElement(
          'div',
          { key: c.name, style: { display: 'flex', gap: 8, fontSize: 13 } },
          createElement('span', { style: { color: c.ok ? T.ok : T.err, fontWeight: 700 } }, c.ok ? '✓' : '✗'),
          createElement('span', { style: { color: T.text2 } }, c.detail),
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
  console.info('[dsh-orgos-ui] 团队室页签已注册(conversation.view #orgos-team)')
}
