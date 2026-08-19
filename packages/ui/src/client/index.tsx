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
  positions: Array<{ id: string; kind: 'agent' | 'human'; title?: string; preset?: string; status: string }>
  delegations: Array<{ id: string; status: string; brief?: { target?: string; task?: string } }>
  tasks: Array<{ id: string; title: string; status: string; assignee: string }>
  mailCount: number
  memoryCount: number
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

/** 委派单状态语义 */
const DELEGATION_STATUS_VIEW: Record<string, { label: string; color: string }> = {
  queued: { label: '排队', color: 'var(--dsw-alias-label-secondary)' },
  dispatched: { label: '已派发', color: 'var(--dsw-alias-brand-primary)' },
  running: { label: '执行中', color: 'var(--dsw-alias-state-warn-primary)' },
  escalated: { label: '已升级', color: 'var(--dsw-alias-state-warn-primary)' },
  completed: { label: '完成', color: 'var(--dsw-alias-state-success-primary)' },
  failed: { label: '失败', color: 'var(--dsw-alias-state-error-primary)' },
  'failed-final': { label: '最终失败', color: 'var(--dsw-alias-state-error-primary)' },
  timeout: { label: '超时', color: 'var(--dsw-alias-state-error-primary)' },
  cancelled: { label: '取消', color: 'var(--dsw-alias-label-secondary)' },
}

/** 任务状态语义 */
const TASK_STATUS_VIEW: Record<string, { label: string; color: string }> = {
  open: { label: '待认领', color: 'var(--dsw-alias-label-secondary)' },
  claimed: { label: '进行中', color: 'var(--dsw-alias-state-warn-primary)' },
  done: { label: '完成', color: 'var(--dsw-alias-state-success-primary)' },
  cancelled: { label: '取消', color: 'var(--dsw-alias-label-secondary)' },
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
  const delegations = data.delegations ?? []
  const inflight = delegations.filter((d) => ['queued', 'dispatched', 'running', 'escalated'].includes(d.status)).length
  const failed = delegations.filter((d) => ['failed', 'failed-final', 'timeout'].includes(d.status)).length
  const tasks = data.tasks ?? []
  const openTasks = tasks.filter((t) => t.status === 'open' || t.status === 'claimed').length
  // 岗位 id → 团队室显示名(title 优先),委派单/任务板与岗位区显示一致,消除歧义
  const titleOf = (positionId: string): string => data.positions.find((p) => p.id === positionId)?.title ?? positionId
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
          createElement('span', { style: { minWidth: 96, fontWeight: 600 } }, p.title ?? p.id),
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
    createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
      createElement(
        'div',
        { style: { fontSize: 13, fontWeight: 600, color: T.text2, marginBottom: 2 } },
        `委派单 ${delegations.length} · 在途 ${inflight} · 失败 ${failed}`,
      ),
      delegations.length === 0
        ? createElement('div', { style: { color: T.text2, fontSize: 13 } }, '暂无委派(用 team_delegate 派发任务)')
        : delegations.slice(0, 8).map((d) =>
            createElement(
              'div',
              { key: d.id, style: { display: 'flex', gap: 8, fontSize: 13, alignItems: 'center' } },
              createElement('span', { style: { minWidth: 88, color: T.text2 } }, d.brief?.target !== undefined ? titleOf(d.brief.target) : ''),
              createElement('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, d.brief?.task ?? d.id),
              createElement('span', {
                style: { color: DELEGATION_STATUS_VIEW[d.status]?.color ?? T.text2 },
              }, DELEGATION_STATUS_VIEW[d.status]?.label ?? d.status),
            ),
          ),
    ),
    createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
      createElement(
        'div',
        { style: { fontSize: 13, fontWeight: 600, color: T.text2, marginBottom: 2 } },
        `任务板 ${tasks.length} · 进行中 ${openTasks} · 邮箱 ${data.mailCount} · 记忆 ${data.memoryCount}`,
      ),
      tasks.length === 0
        ? createElement('div', { style: { color: T.text2, fontSize: 13 } }, '任务板为空')
        : tasks.slice(0, 8).map((t) =>
            createElement(
              'div',
              { key: t.id, style: { display: 'flex', gap: 8, fontSize: 13, alignItems: 'center' } },
              createElement('span', { style: { minWidth: 88, color: T.text2 } }, titleOf(t.assignee)),
              createElement('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t.title),
              createElement('span', {
                style: { color: TASK_STATUS_VIEW[t.status]?.color ?? T.text2 },
              }, TASK_STATUS_VIEW[t.status]?.label ?? t.status),
            ),
          ),
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
