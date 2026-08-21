/**
 * dsh-orgos-ui Client 半 —— 团队室页签(conversation.view list seat)
 *
 * 参照官方 ui-trajectory 的注册模式:ctx.slots.inject('conversation.view',
 * () => ctx.slots.register({ name, id, order, label, inject }, Component))。
 * 数据源:GET /api/orgos/snapshot(host 侧 core 行注册的只读快照)。
 *
 * P1 组织树视图:data.tree(OrgTreeSnapshot,core ≥ 新增 tree 字段)存在时渲染
 * 概览条 + 组织树(折叠/搜索/详情卡)+ 手风琴面板;tree 为 undefined(旧 core)时
 * 保持原扁平列表渲染(FlatTeamView 兜底)。全部 createElement 风格,禁 JSX;
 * 颜色一律走官方主题 CSS 变量(--dsw-alias-*)。
 */
import { createElement, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  aggregateLabel,
  applyFilter,
  buildTreeIndex,
  defaultExpanded,
  rootAggregate,
} from './tree.js'
import type { OrgTreeAggregate, OrgTreeNode, OrgTreePosition, OrgTreeSnapshot } from './tree.js'

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
  /** 组织树快照(旧 core 无此字段 → UI 回退扁平列表) */
  tree?: OrgTreeSnapshot
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

/** 主题别名,组件内统一引用,避免散落硬编码色。
 *  bg1 为页面级背景 token(仓库现有代码未用过背景 token,按 P1 决策取 --dsw-alias-bg-layer-1)。 */
const T = {
  text: 'var(--dsw-alias-label-primary)',
  text2: 'var(--dsw-alias-label-secondary)',
  border: 'var(--dsw-alias-border-l1)',
  brand: 'var(--dsw-alias-brand-primary)',
  ok: 'var(--dsw-alias-state-success-primary)',
  warn: 'var(--dsw-alias-state-warn-primary)',
  err: 'var(--dsw-alias-state-error-primary)',
  bg1: 'var(--dsw-alias-bg-layer-1)',
}

/** 概览条统计(数据来自树根聚合,无聚合时逐岗位兜底) */
interface OverviewStats {
  positionCount: number
  online: number
  offline: number
  failed: number
  inflight: number
}

async function fetchTeamSnapshot(viewer?: string): Promise<TeamSnapshotData | null> {
  try {
    // P3 成员视角:成员会话打开团队室时带 ?viewer= 由服务端投影(树裁剪+scope);
    // 根会话缺省 = 全树视图(现状)。显示投影非安全边界(服务端注释同义)。
    const url = viewer === undefined ? '/api/orgos/snapshot' : `/api/orgos/snapshot?viewer=${encodeURIComponent(viewer)}`
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    return (await res.json()) as TeamSnapshotData
  } catch {
    return null
  }
}

/** 会话 id → 成员岗位 id(orgos-member-<positionId> 命名约定);根/web 会话返回 undefined */
function viewerOfSession(sessionId?: string): string | undefined {
  if (sessionId === undefined || !sessionId.startsWith('orgos-member-')) return undefined
  const positionId = sessionId.slice('orgos-member-'.length)
  return positionId.length > 0 ? positionId : undefined
}

// ---------------------------------------------------------------------------
// 共享片段构建(扁平兜底与手风琴面板复用同一套行渲染,保证两处观感一致)
// ---------------------------------------------------------------------------

/** 岗位 id → 团队室显示名(title 优先),委派单/任务板与岗位区显示一致,消除歧义 */
function titleOf(data: TeamSnapshotData, positionId: string): string {
  return data.positions.find((p) => p.id === positionId)?.title ?? positionId
}

/** 委派单计数:总数 / 在途(queued|dispatched|running|escalated)/ 失败(failed|failed-final|timeout) */
function delegationCounts(data: TeamSnapshotData): { total: number; inflight: number; failed: number } {
  const delegations = data.delegations ?? []
  return {
    total: delegations.length,
    inflight: delegations.filter((d) => ['queued', 'dispatched', 'running', 'escalated'].includes(d.status)).length,
    failed: delegations.filter((d) => ['failed', 'failed-final', 'timeout'].includes(d.status)).length,
  }
}

/** 委派单行列表(≤8 条) */
function delegationRows(data: TeamSnapshotData, titleOfPosition: (id: string) => string): ReactNode[] {
  const delegations = data.delegations ?? []
  if (delegations.length === 0) {
    return [createElement('div', { key: 'empty', style: { color: T.text2, fontSize: 13 } }, '暂无委派(用 team_delegate 派发任务)')]
  }
  return delegations.slice(0, 8).map((d) =>
    createElement(
      'div',
      { key: d.id, style: { display: 'flex', gap: 8, fontSize: 13, alignItems: 'center' } },
      createElement('span', { style: { minWidth: 88, color: T.text2 } }, d.brief?.target !== undefined ? titleOfPosition(d.brief.target) : ''),
      createElement('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, d.brief?.task ?? d.id),
      createElement('span', { style: { color: DELEGATION_STATUS_VIEW[d.status]?.color ?? T.text2 } }, DELEGATION_STATUS_VIEW[d.status]?.label ?? d.status),
    ),
  )
}

/** 任务行列表(≤8 条) */
function taskRows(data: TeamSnapshotData, titleOfPosition: (id: string) => string): ReactNode[] {
  const tasks = data.tasks ?? []
  if (tasks.length === 0) {
    return [createElement('div', { key: 'empty', style: { color: T.text2, fontSize: 13 } }, '任务板为空')]
  }
  return tasks.slice(0, 8).map((t) =>
    createElement(
      'div',
      { key: t.id, style: { display: 'flex', gap: 8, fontSize: 13, alignItems: 'center' } },
      createElement('span', { style: { minWidth: 88, color: T.text2 } }, titleOfPosition(t.assignee)),
      createElement('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t.title),
      createElement('span', { style: { color: TASK_STATUS_VIEW[t.status]?.color ?? T.text2 } }, TASK_STATUS_VIEW[t.status]?.label ?? t.status),
    ),
  )
}

/** doctor 检查行列表 */
function doctorRows(data: TeamSnapshotData): ReactNode[] {
  const checks = data.doctor?.checks ?? []
  return checks.map((c) =>
    createElement(
      'div',
      { key: c.name, style: { display: 'flex', gap: 8, fontSize: 13 } },
      createElement('span', { style: { color: c.ok ? T.ok : T.err, fontWeight: 700 } }, c.ok ? '✓' : '✗'),
      createElement('span', { style: { color: T.text2 } }, c.detail),
    ),
  )
}

// ---------------------------------------------------------------------------
// 组织树视图(数据树 → 概览条 + 树面板 + 详情卡 + 手风琴面板)
// ---------------------------------------------------------------------------

/** 概览条(sticky):统计数字 + 搜索框 + 全部展开/折叠 */
function TeamOverview(props: {
  stats: OverviewStats
  query: string
  onQuery: (q: string) => void
  onExpandAll: () => void
  onCollapseAll: () => void
}): ReactNode {
  const chips: Array<[string, string, string]> = [
    ['岗位', String(props.stats.positionCount), T.text],
    ['在线', String(props.stats.online), T.ok],
    ['待命', String(props.stats.offline), T.brand],
    ['失败', String(props.stats.failed), T.err],
    ['在途委派', String(props.stats.inflight), T.warn],
  ]
  return createElement(
    'div',
    {
      style: {
        position: 'sticky',
        top: 0,
        zIndex: 1,
        backgroundColor: T.bg1,
        borderBottom: `1px solid ${T.border}`,
        padding: '10px 0',
        display: 'flex',
        flexWrap: 'wrap',
        gap: 12,
        alignItems: 'center',
      },
    },
    ...chips.map(([label, value, color]) =>
      createElement(
        'span',
        { key: label, style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: T.text2, whiteSpace: 'nowrap' } },
        createElement('span', { style: { width: 8, height: 8, borderRadius: 4, background: color, display: 'inline-block' } }),
        createElement('span', null, label),
        createElement('b', { style: { color: T.text } }, value),
      ),
    ),
    createElement('input', {
      value: props.query,
      onChange: (e) => props.onQuery(e.target.value),
      onKeyDown: (e) => {
        if (e.key === 'Escape') props.onQuery('')
      },
      placeholder: '搜索岗位/团队(title/id)…',
      style: {
        flex: 1,
        minWidth: 180,
        padding: '6px 10px',
        borderRadius: 6,
        border: `1px solid ${T.border}`,
        background: T.bg1,
        color: T.text,
        fontSize: 13,
        outline: 'none',
      },
    }),
    createElement(
      'button',
      { onClick: props.onExpandAll, style: overviewButtonStyle },
      '全部展开',
    ),
    createElement(
      'button',
      { onClick: props.onCollapseAll, style: overviewButtonStyle },
      '全部折叠',
    ),
  )
}

const overviewButtonStyle: Record<string, string> = {
  fontSize: 12,
  padding: '4px 10px',
  border: `1px solid ${T.border}`,
  borderRadius: 6,
  background: T.bg1,
  color: T.text2,
  cursor: 'pointer',
}

/** 树行(容器节点与岗位叶子共用):连接线 = flex spacer 的 border-left(不画 ASCII) */
function TreeRow(props: {
  node?: OrgTreeNode
  pos?: OrgTreePosition
  depth: number
  expanded?: boolean
  hit: boolean
  selected?: boolean
  agg?: OrgTreeAggregate
  onToggle?: () => void
  onSelect?: () => void
}): ReactNode {
  const { node, pos, depth, expanded, hit, selected, agg, onToggle, onSelect } = props
  // 缩进:第 1 级 24px,之后每级 −2px,下限 12px
  const indent = Math.max(12, 24 - 2 * depth)
  const lineColor = hit ? T.warn : T.border
  const content: ReactNode[] = []
  if (node !== undefined) {
    content.push(
      createElement('span', { key: 'caret', style: { fontSize: 10, color: T.text2, width: 14, textAlign: 'center', flexShrink: 0 } }, expanded ? '▾' : '▸'),
      createElement(
        'span',
        { key: 'title', style: { fontWeight: 600, fontSize: 13, color: hit ? T.warn : T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        node.title ?? node.id,
      ),
      agg !== undefined
        ? createElement(
            'span',
            { key: 'badge', style: { fontSize: 11, color: T.text2, border: `1px solid ${T.border}`, borderRadius: 10, padding: '1px 8px', whiteSpace: 'nowrap', flexShrink: 0 } },
            agg.failed > 0 ? createElement('span', { style: { color: T.err, marginRight: 4 } }, '●') : null,
            aggregateLabel(agg),
          )
        : null,
    )
  } else if (pos !== undefined) {
    const view = STATUS_VIEW[pos.status]
    content.push(
      createElement('span', { key: 'dot', style: { width: 8, height: 8, borderRadius: 4, background: view?.color ?? T.text2, flexShrink: 0, display: 'inline-block' } }),
      createElement(
        'span',
        { key: 'title', style: { fontSize: 13, color: hit ? T.warn : T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        pos.title ?? pos.id,
      ),
    )
    if (pos.preset !== undefined) {
      content.push(
        createElement('span', { key: 'preset', style: { fontSize: 11, color: T.text2, border: `1px solid ${T.border}`, borderRadius: 4, padding: '0 6px', whiteSpace: 'nowrap', flexShrink: 0 } }, pos.preset),
      )
    }
    if (pos.status === 'busy') {
      content.push(createElement('span', { key: 'busy', style: { fontSize: 11, color: T.warn, fontWeight: 700, flexShrink: 0 } }, '忙'))
    }
  }
  const clickable = node !== undefined || pos !== undefined
  return createElement(
    'div',
    {
      onClick: clickable ? (onSelect ?? onToggle) : undefined,
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 8px',
        cursor: clickable ? 'pointer' : 'default',
        backgroundColor: selected === true ? T.bg1 : undefined,
        boxShadow: selected === true ? `inset 2px 0 0 ${T.brand}` : undefined,
      },
    },
    createElement('div', { style: { width: indent, flexShrink: 0, alignSelf: 'stretch', borderLeft: `1px solid ${lineColor}` } }),
    ...content,
  )
}

/** 组织树主面板:双向滚动容器(容器 maxHeight calc(100vh - 220px));递归产出行 */
function OrgTreePanel(props: {
  tree: OrgTreeSnapshot
  index: ReturnType<typeof buildTreeIndex>
  isExpanded: (id: string) => boolean
  filterActive: boolean
  hitIds: Set<string>
  selectedId: string | null
  onToggleNode: (id: string) => void
  onSelectPosition: (id: string) => void
}): ReactNode {
  const { tree, index, isExpanded, filterActive, hitIds, selectedId, onToggleNode, onSelectPosition } = props
  const hit = (id: string): boolean => filterActive && hitIds.has(id)
  const rows: ReactNode[] = []
  const pushNode = (nodeId: string, depth: number): void => {
    const node = index.nodeById.get(nodeId)
    if (node === undefined) return
    const expanded = isExpanded(nodeId)
    rows.push(
      createElement(TreeRow, {
        key: `n:${nodeId}`,
        node,
        depth,
        expanded,
        hit: hit(nodeId),
        agg: tree.aggregates[nodeId],
        onToggle: () => onToggleNode(nodeId),
      }),
    )
    if (!expanded) return // 折叠态只渲染容器行,不递归(首屏行数 = 展开节点数 + 可见岗位数)
    for (const childId of index.children.get(nodeId) ?? []) pushNode(childId, depth + 1)
    for (const pos of index.positions.get(nodeId) ?? []) {
      rows.push(
        createElement(TreeRow, {
          key: `p:${pos.id}`,
          pos,
          depth: depth + 1,
          hit: hit(pos.id),
          selected: selectedId === pos.id,
          onSelect: () => onSelectPosition(pos.id),
        }),
      )
    }
  }
  for (const rootId of index.roots) pushNode(rootId, 0)

  return createElement(
    'div',
    { style: { maxHeight: 'calc(100vh - 220px)', overflow: 'auto', border: `1px solid ${T.border}`, borderRadius: 8, padding: '6px 0', flex: 1, minWidth: 0 } },
    filterActive && hitIds.size === 0
      ? createElement('div', { style: { padding: 16, color: T.text2, fontSize: 13 } }, '无匹配的岗位或团队(试试 title/id 关键字)')
      : rows.length > 0
        ? rows
        : createElement('div', { style: { padding: 16, color: T.text2, fontSize: 13 } }, '组织为空(尚无节点与岗位)'),
  )
}

/** 岗位详情卡:桌面在右(窄屏转底部);点击同一岗位再次取消选中 */
function MemberDetail(props: { pos: OrgTreePosition; onClose: () => void; bottom?: boolean }): ReactNode {
  const view = STATUS_VIEW[props.pos.status]
  const fields: Array<[string, string]> = [
    ['状态', view?.label ?? props.pos.status],
    ['Preset', props.pos.preset ?? '—'],
    ['类型', props.pos.kind === 'human' ? '真人' : '虚拟员工'],
    ['在途委派', String(props.pos.openDelegations ?? 0)],
    ['开放任务', String(props.pos.openTasks ?? 0)],
  ]
  return createElement(
    'div',
    {
      style: {
        border: `1px solid ${T.border}`,
        borderRadius: 8,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        backgroundColor: T.bg1,
        ...(props.bottom === true ? { width: '100%' } : { width: 260, flexShrink: 0 }),
      },
    },
    createElement(
      'div',
      { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
      createElement('span', { style: { fontSize: 14, fontWeight: 700, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, props.pos.title ?? props.pos.id),
      createElement('span', { onClick: props.onClose, style: { cursor: 'pointer', color: T.text2, fontSize: 14, flexShrink: 0 } }, '✕'),
    ),
    ...fields.map(([k, v]) =>
      createElement(
        'div',
        { key: k, style: { display: 'flex', justifyContent: 'space-between', fontSize: 13 } },
        createElement('span', { style: { color: T.text2 } }, k),
        createElement('span', { style: { color: T.text, fontWeight: 600 } }, v),
      ),
    ),
  )
}

/** 手风琴面板外壳:点击标题展开/收起 */
function AccordionPanel(props: { title: string; open: boolean; onToggle: () => void; children: ReactNode }): ReactNode {
  return createElement(
    'div',
    { style: { border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden', backgroundColor: T.bg1 } },
    createElement(
      'div',
      { onClick: props.onToggle, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', cursor: 'pointer' } },
      createElement('span', { style: { fontSize: 11, color: T.text2, width: 12, textAlign: 'center', flexShrink: 0 } }, props.open ? '▾' : '▸'),
      createElement('span', { style: { fontSize: 13, fontWeight: 600, color: T.text } }, props.title),
    ),
    props.open ? createElement('div', { style: { padding: '4px 12px 12px', display: 'flex', flexDirection: 'column', gap: 4 } }, props.children) : null,
  )
}

/** 手风琴面板组:委派单 / 任务板 / 邮箱记忆 / Run 摘要 / Doctor 检查 */
function AccordionPanels(props: {
  data: TeamSnapshotData
  panels: Record<string, boolean>
  onToggle: (key: string) => void
}): ReactNode {
  const { data, panels, onToggle } = props
  const titleOfPosition = (id: string): string => titleOf(data, id)
  const delegations = delegationCounts(data)
  const tasks = data.tasks ?? []
  const openTasks = tasks.filter((t) => t.status === 'open' || t.status === 'claimed').length
  const checks = data.doctor?.checks ?? []
  const okChecks = checks.filter((c) => c.ok).length
  const doctorChildren: ReactNode[] =
    checks.length === 0 ? [createElement('div', { key: 'empty', style: { color: T.text2, fontSize: 13 } }, '暂无检查项')] : doctorRows(data)

  return createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    createElement(
      AccordionPanel,
      { title: `委派单 ${delegations.total} · 在途 ${delegations.inflight} · 失败 ${delegations.failed}`, open: panels.delegations === true, onToggle: () => onToggle('delegations') },
      ...delegationRows(data, titleOfPosition),
    ),
    createElement(
      AccordionPanel,
      { title: `任务板 ${tasks.length} · 进行中 ${openTasks}`, open: panels.tasks === true, onToggle: () => onToggle('tasks') },
      ...taskRows(data, titleOfPosition),
    ),
    createElement(
      AccordionPanel,
      { title: `邮箱 ${data.mailCount} · 记忆 ${data.memoryCount}`, open: panels.mail === true, onToggle: () => onToggle('mail') },
      createElement('div', { style: { color: T.text2, fontSize: 13 } }, '邮箱/记忆当前仅汇总计数,明细随 IM 通道与提炼流程下钻。'),
    ),
    createElement(
      AccordionPanel,
      { title: 'Run 摘要', open: panels.run === true, onToggle: () => onToggle('run') },
      createElement('div', { style: { color: T.text2, fontSize: 13 } }, data.run ?? '暂无运行摘要(用 /run 查看)'),
    ),
    createElement(
      AccordionPanel,
      { title: `健康检查 ${okChecks}/${checks.length}`, open: panels.doctor === true, onToggle: () => onToggle('doctor') },
      ...doctorChildren,
    ),
  )
}

/** 组织树模式主视图:概览条(sticky)+ 树 + 详情卡 + 手风琴面板 */
function OrgTreeView({ data }: { data: TeamSnapshotData }): ReactNode {
  const tree = data.tree as OrgTreeSnapshot
  const index = useMemo(() => buildTreeIndex(tree), [tree])
  const defaults = useMemo(() => defaultExpanded(tree), [tree])
  // 折叠状态会话内记忆(useState 集合,不入库);默认展开规则之上叠加用户覆盖
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [narrow, setNarrow] = useState<boolean>(() => typeof window !== 'undefined' && window.innerWidth < 720)
  const [panels, setPanels] = useState<Record<string, boolean>>(() => ({ delegations: true, tasks: false, mail: false, run: false, doctor: false }))

  // 窄屏(<720px)详情卡转底部:监听窗口 resize
  useEffect(() => {
    const onResize = (): void => setNarrow(window.innerWidth < 720)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const filter = useMemo(() => applyFilter(tree, query), [tree, query])
  const filterActive = query.trim().length > 0

  // 展开判定:搜索态 → 命中祖先链强制展开(叠加用户显式展开,不改状态以便 Esc 恢复);
  // 常态 → 显式展开 > 显式折叠 > 默认规则
  const isExpanded = (id: string): boolean => {
    if (filterActive) return filter.expandedAncestors.has(id) || expandedIds.has(id)
    if (expandedIds.has(id)) return true
    if (collapsedIds.has(id)) return false
    return defaults.has(id)
  }

  const toggleNode = (id: string): void => {
    if (isExpanded(id)) {
      const next = new Set(collapsedIds)
      next.add(id)
      setCollapsedIds(next)
      setExpandedIds((prev) => {
        const s = new Set(prev)
        s.delete(id)
        return s
      })
    } else {
      const next = new Set(expandedIds)
      next.add(id)
      setExpandedIds(next)
      setCollapsedIds((prev) => {
        const s = new Set(prev)
        s.delete(id)
        return s
      })
    }
  }

  const expandAll = (): void => {
    setExpandedIds(new Set(tree.nodes.map((n) => n.id)))
    setCollapsedIds(new Set())
  }
  const collapseAll = (): void => {
    setCollapsedIds(new Set(tree.nodes.map((n) => n.id)))
    setExpandedIds(new Set())
  }

  const selectPosition = (id: string): void => {
    setSelectedId((prev) => (prev === id ? null : id)) // 再点同一岗位取消选中
  }
  const togglePanel = (key: string): void => {
    setPanels((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  // 概览统计:优先树根聚合(aggregates[org 根]);缺失时逐岗位兜底
  const stats: OverviewStats = useMemo(() => {
    const rootAgg = rootAggregate(tree)
    if (rootAgg !== undefined) {
      return {
        positionCount: rootAgg.positionCount,
        online: rootAgg.busy + rootAgg.idle,
        offline: rootAgg.offline,
        failed: rootAgg.failed,
        inflight: rootAgg.openDelegations,
      }
    }
    let positionCount = 0
    let online = 0
    let offline = 0
    let failed = 0
    let inflight = 0
    for (const list of index.positions.values()) {
      for (const p of list) {
        positionCount += 1
        if (p.status === 'busy' || p.status === 'idle') online += 1
        else if (p.status === 'offline') offline += 1
        else if (p.status === 'failed') failed += 1
        else offline += 1
        inflight += p.openDelegations ?? 0
      }
    }
    return { positionCount, online, offline, failed, inflight }
  }, [tree, index])

  const selectedPos: OrgTreePosition | undefined =
    selectedId === null ? undefined : (() => {
      for (const list of index.positions.values()) {
        const found = list.find((p) => p.id === selectedId)
        if (found !== undefined) return found
      }
      return undefined
    })()

  return createElement(
    'div',
    { style: { padding: 24, display: 'flex', flexDirection: 'column', gap: 16, color: T.text } },
    createElement('h3', null, `团队 · ${data.org ?? '未初始化'}`),
    createElement(TeamOverview, {
      stats,
      query,
      onQuery: (q) => setQuery(q),
      onExpandAll: expandAll,
      onCollapseAll: collapseAll,
    }),
    createElement(
      'div',
      { style: { display: 'flex', gap: 16, alignItems: 'flex-start' } },
      createElement(OrgTreePanel, {
        tree,
        index,
        isExpanded,
        filterActive,
        hitIds: filter.hitIds,
        selectedId,
        onToggleNode: toggleNode,
        onSelectPosition: selectPosition,
      }),
      selectedPos !== undefined && !narrow ? createElement(MemberDetail, { pos: selectedPos, onClose: () => setSelectedId(null) }) : null,
    ),
    selectedPos !== undefined && narrow ? createElement(MemberDetail, { pos: selectedPos, onClose: () => setSelectedId(null), bottom: true }) : null,
    createElement(AccordionPanels, { data, panels, onToggle: togglePanel }),
  )
}

// ---------------------------------------------------------------------------
// 扁平兜底(旧 core:data.tree 为 undefined —— 原实现逻辑原样保留)
// ---------------------------------------------------------------------------

/** 扁平列表视图:原团队室渲染(无 tree 字段时的降级兼容) */
function FlatTeamView({ data }: { data: TeamSnapshotData }): ReactNode {
  const delegations = delegationCounts(data)
  const tasks = data.tasks ?? []
  const openTasks = tasks.filter((t) => t.status === 'open' || t.status === 'claimed').length
  const titleOfPosition = (id: string): string => titleOf(data, id)
  return createElement(
    'div',
    { style: { padding: 24, display: 'flex', flexDirection: 'column', gap: 16, color: T.text } },
    createElement('h3', null, `团队 · ${data.org ?? '未初始化'}`),
    createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      ...data.positions.map((p) =>
        createElement(
          'div',
          { key: p.id, style: { display: 'flex', gap: 8, alignItems: 'center' } },
          createElement('span', { style: { minWidth: 96, fontWeight: 600 } }, p.title ?? p.id),
          createElement('span', { style: { color: p.kind === 'human' ? T.ok : T.brand } }, p.kind === 'human' ? '真人' : '虚拟员工'),
          p.preset !== undefined ? createElement('span', { style: { color: T.text2 } }, p.preset) : null,
          createElement('span', { style: { color: STATUS_VIEW[p.status]?.color ?? T.text2 } }, STATUS_VIEW[p.status]?.label ?? p.status),
        ),
      ),
    ),
    createElement('div', { style: { color: T.text2, fontSize: 12 } }, '成员按需唤醒:「待命」= 未派发任务,派发时自动上线,不产生常驻成本。'),
    createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
      createElement(
        'div',
        { style: { fontSize: 13, fontWeight: 600, color: T.text2, marginBottom: 2 } },
        `委派单 ${delegations.total} · 在途 ${delegations.inflight} · 失败 ${delegations.failed}`,
      ),
      ...delegationRows(data, titleOfPosition),
    ),
    createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
      createElement(
        'div',
        { style: { fontSize: 13, fontWeight: 600, color: T.text2, marginBottom: 2 } },
        `任务板 ${tasks.length} · 进行中 ${openTasks} · 邮箱 ${data.mailCount} · 记忆 ${data.memoryCount}`,
      ),
      ...taskRows(data, titleOfPosition),
    ),
    data.run !== undefined ? createElement('div', { style: { color: T.text2 } }, data.run) : null,
    createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 4, borderTop: `1px solid ${T.border}`, paddingTop: 8 } },
      ...doctorRows(data),
    ),
  )
}

/** 团队室视图组件:轮询快照 → 组织树视图(tree 存在)或扁平列表兜底 */
function TeamRoomView(): ReactNode {
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
  // 降级兼容:tree 为 undefined(旧 core)→ 扁平列表渲染;tree 存在但无节点也走兜底
  const treeMode = data.tree !== undefined && data.tree.nodes.length > 0
  return treeMode ? createElement(OrgTreeView, { data }) : createElement(FlatTeamView, { data })
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
