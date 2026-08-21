/**
 * 组织树快照的纯函数工具集(零 React 依赖,可单测)。
 *
 * 形状与 core TeamService.OrgTreeSnapshot 一致(见 packages/core/src/dsh/teamService.ts):
 *  - nodes:容器节点(org/bg/dept/team),parentId 指父容器,null 为根;
 *  - positionsByNode:节点 id → 直属岗位列表(治理岗位挂其节点,执行岗位挂 team);
 *  - aggregates:节点 id → 子树闭包聚合(服务端后序计算,UI 不重算)。
 * 岗位行额外携带 openDelegations/openTasks(服务端挂载,类型上为可选字段,
 * 与 core d.ts 的公开形状保持兼容)。
 *
 * P2 新增(>500 岗位场景):
 *  - flattenVisible:按展开集合扁平化为行数组(虚拟滚动行模型);
 *  - visibleWindow:滚动窗口化计算(start/end 夹取 + overscan);
 *  - keyboardMove:键盘导航决策(焦点移动/展开折叠/选中,确定性可单测)。
 */

/** 容器节点(与 core OrgTreeSnapshot.nodes 元素同形) */
export interface OrgTreeNode {
  id: string
  kind: 'org' | 'bg' | 'dept' | 'team'
  parentId: string | null
  title?: string
  orchestratorPosition?: string
}

/** 岗位叶子(与 core OrgTreeSnapshot.positionsByNode 值同形 + 可选委派/任务计数) */
export interface OrgTreePosition {
  id: string
  title?: string
  preset?: string
  kind: 'agent' | 'human'
  status: string
  openDelegations?: number
  openTasks?: number
}

/** 子树聚合(与 core OrgTreeSnapshot.aggregates 值同形) */
export interface OrgTreeAggregate {
  positionCount: number
  busy: number
  idle: number
  offline: number
  failed: number
  openDelegations: number
  openTasks: number
}

/** 组织树快照(与 core OrgTreeSnapshot 同形) */
export interface OrgTreeSnapshot {
  nodes: OrgTreeNode[]
  positionsByNode: Record<string, OrgTreePosition[]>
  aggregates: Record<string, OrgTreeAggregate>
}

/** buildTreeIndex 的产物:渲染期 O(1) 查询索引 */
export interface TreeIndex {
  /** 节点 id → 节点(含孤儿节点,孤儿不进 children/roots 故不可达) */
  nodeById: Map<string, OrgTreeNode>
  /** 父节点 id → 已排序子节点 id 列表 */
  children: Map<string, string[]>
  /** 节点 id → 直属岗位列表 */
  positions: Map<string, OrgTreePosition[]>
  /** 顶层节点 id(parentId === null;正常树只有一个 org 根) */
  roots: string[]
}

/** applyFilter 的产物:命中集合 + 需自动展开的祖先链 */
export interface FilterResult {
  /** 命中 id:命中节点 id + 命中岗位 id(用于高亮) */
  hitIds: Set<string>
  /** 命中项的祖先节点 id 集合(用于搜索态自动展开) */
  expandedAncestors: Set<string>
}

/** 排序键:title 优先,缺失/相同按 id,保证稳定可复现 */
function sortKey(n: OrgTreeNode | undefined): string {
  if (n === undefined) return ''
  return `${n.title ?? ''}\u0000${n.id}`
}

/**
 * 构建渲染索引:节点/岗位按 id 挂桶,children 排序,roots 归一。
 * 约束:nodeById 恒含全部节点;孤儿(parentId 指向不存在的节点)不渲染但不报错。
 */
export function buildTreeIndex(tree: OrgTreeSnapshot): TreeIndex {
  const nodeById = new Map<string, OrgTreeNode>()
  const children = new Map<string, string[]>()
  const positions = new Map<string, OrgTreePosition[]>()
  const roots: string[] = []

  for (const n of tree.nodes) nodeById.set(n.id, n)
  for (const n of tree.nodes) {
    if (n.parentId === null) {
      roots.push(n.id)
      continue
    }
    const bucket = children.get(n.parentId)
    if (bucket !== undefined) bucket.push(n.id)
    else if (nodeById.has(n.parentId)) children.set(n.parentId, [n.id])
    // 否则为孤儿:仅保留在 nodeById,不进 children/roots
  }
  for (const list of children.values()) {
    list.sort((a, b) => sortKey(nodeById.get(a)).localeCompare(sortKey(nodeById.get(b))))
  }
  roots.sort((a, b) => sortKey(nodeById.get(a)).localeCompare(sortKey(nodeById.get(b))))
  for (const [id, list] of Object.entries(tree.positionsByNode)) positions.set(id, list)

  return { nodeById, children, positions, roots }
}

/** 组织根 id:优先 parentId===null 且 kind==='org' 的节点;退化取任一根;无根返回 null */
export function orgRootId(tree: OrgTreeSnapshot): string | null {
  const roots = tree.nodes.filter((n) => n.parentId === null)
  if (roots.length === 0) return null
  const org = roots.find((n) => n.kind === 'org')
  return org !== undefined ? org.id : roots[0]!.id
}

/** 组织根聚合(概览条数据源);无根或未聚合返回 undefined */
export function rootAggregate(tree: OrgTreeSnapshot): OrgTreeAggregate | undefined {
  const id = orgRootId(tree)
  return id === null ? undefined : tree.aggregates[id]
}

/** 岗位总数:优先根聚合(与服务端闭包和一致),缺失时逐桶求和 */
export function totalPositionCount(tree: OrgTreeSnapshot): number {
  const rootAgg = rootAggregate(tree)
  if (rootAgg !== undefined) return rootAgg.positionCount
  let count = 0
  for (const list of Object.values(tree.positionsByNode)) count += list.length
  return count
}

/**
 * 默认展开规则:
 *  总岗位数 ≤ 30 → 全部节点展开;
 *  > 30 → org/bg/dept 展开、team 折叠(首屏只见骨架,岗位行随 team 隐藏)。
 */
export function defaultExpanded(tree: OrgTreeSnapshot): Set<string> {
  const all = new Set(tree.nodes.map((n) => n.id))
  if (totalPositionCount(tree) <= 30) return all
  const set = new Set<string>()
  for (const n of tree.nodes) if (n.kind !== 'team') set.add(n.id)
  return set
}

/**
 * 按岗位/团队 title/id 过滤(大小写不敏感,子串匹配)。
 * 返回命中 id 集合 + 命中项祖先链(自动展开所需)。
 */
export function applyFilter(tree: OrgTreeSnapshot, query: string): FilterResult {
  const hitIds = new Set<string>()
  const q = query.trim().toLowerCase()
  if (q === '') return { hitIds, expandedAncestors: new Set() }

  const matches = (title: string | undefined, id: string): boolean =>
    (title !== undefined && title.toLowerCase().includes(q)) || id.toLowerCase().includes(q)

  for (const n of tree.nodes) if (matches(n.title, n.id)) hitIds.add(n.id)
  for (const list of Object.values(tree.positionsByNode)) {
    for (const p of list) if (matches(p.title, p.id)) hitIds.add(p.id)
  }

  // 祖先链:对每个命中(节点或岗位)沿父链上溯至根。
  // 节点命中直接走 parentId;岗位命中先经 positionParent 跳到所属节点再上溯。
  const nodeById = new Map(tree.nodes.map((n) => [n.id, n]))
  const positionParent = new Map<string, string>()
  for (const [nodeId, list] of Object.entries(tree.positionsByNode)) {
    for (const p of list) positionParent.set(p.id, nodeId)
  }
  const parentOf = (id: string): string | null => {
    const node = nodeById.get(id)
    if (node !== undefined) return node.parentId
    return positionParent.get(id) ?? null
  }
  const expandedAncestors = new Set<string>()
  for (const hit of hitIds) {
    let cur = parentOf(hit)
    while (cur !== null) {
      expandedAncestors.add(cur)
      cur = parentOf(cur)
    }
  }
  return { hitIds, expandedAncestors }
}

/** 容器聚合徽标文案:「N岗位 · X忙 · Y待命 · Z失败」(failed>0 红点由 UI 负责) */
export function aggregateLabel(agg: OrgTreeAggregate): string {
  return `${agg.positionCount}岗位 · ${agg.busy}忙 · ${agg.offline}待命 · ${agg.failed}失败`
}

// ---------------------------------------------------------------------------
// P2:扁平化 / 窗口化 / 键盘导航(虚拟滚动 + 键盘操作的行模型与决策,零 React 依赖)
// ---------------------------------------------------------------------------

/** 扁平化可见行(虚拟滚动与键盘导航共用行模型) */
export interface VisibleRow {
  type: 'node' | 'position'
  node?: OrgTreeNode
  pos?: OrgTreePosition
  depth: number
}

/** 虚拟滚动可见窗口:行区间 [start, end),start/end 均已夹取到 [0, total] */
export interface WindowRange {
  start: number
  end: number
}

/** 键盘导航决策结果:新焦点 + 动作报告(动作副作用已由注入回调执行,调用方勿重复执行) */
export interface KeyboardMoveResult {
  focusIndex: number
  /** 需要切换展开的容器节点 id(展开/折叠方向由当前展开态决定,回调已执行) */
  toggleNodeId?: string
  /** 需要选中的岗位 id(与点击行为一致:重复 Enter 同一岗位取消选中,回调已执行) */
  selectPositionId?: string
}

/**
 * 按展开集合把树扁平化为行数组(深度优先:节点行在前、其直属岗位行在后)。
 * 折叠节点的后代不产出,但节点自身行保留(与 P1 渲染语义一致);
 * 搜索态由调用方把命中祖先并入 expandedIds 后传入,本函数不做搜索耦合。
 * 岗位行直读快照桶(tree.positionsByNode 与 index.positions 同源,免一层索引)。
 * 防御:children 桶里的脏引用(节点不存在)直接跳过,不崩溃。
 */
export function flattenVisible(tree: OrgTreeSnapshot, index: TreeIndex, expandedIds: Set<string>): VisibleRow[] {
  const rows: VisibleRow[] = []
  const pushNode = (nodeId: string, depth: number): void => {
    const node = index.nodeById.get(nodeId)
    if (node === undefined) return // 脏引用防御:正常索引下孤儿不可达
    rows.push({ type: 'node', node, depth })
    if (!expandedIds.has(nodeId)) return // 折叠:自身行保留,后代不产出
    for (const childId of index.children.get(nodeId) ?? []) pushNode(childId, depth + 1)
    for (const pos of tree.positionsByNode[nodeId] ?? []) rows.push({ type: 'position', pos, depth: depth + 1 })
  }
  for (const rootId of index.roots) pushNode(rootId, 0)
  return rows
}

/**
 * 虚拟滚动窗口化计算:
 *  start = floor(scrollTop / rowHeight) − overscan(夹取 ≥ 0);
 *  end   = ceil((scrollTop + viewportHeight) / rowHeight) + overscan(夹取 ≤ total)。
 * 退化输入(total ≤ 0 或 rowHeight ≤ 0)返回整表可见,不崩溃。
 */
export function visibleWindow(
  total: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan: number,
): WindowRange {
  if (total <= 0 || rowHeight <= 0) return { start: 0, end: Math.max(0, total) }
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const end = Math.min(total, Math.ceil((scrollTop + Math.max(0, viewportHeight)) / rowHeight) + overscan)
  return { start, end }
}

/**
 * 键盘导航决策(确定性:同输入 → 同输出,便于单测)。
 * 副作用经注入回调发出:expand/collapse/select 在命中对应分支时被调用一次;
 * 返回值携带新焦点与动作报告(toggleNodeId/selectPositionId),供测试断言。
 * 规则:
 *  - ArrowDown/Up:focusIndex ±1,越界不动;
 *  - ArrowRight:折叠容器 → expand(焦点不动);已展开 → 焦点移到第一个子行(无子行不动);
 *  - ArrowLeft:已展开容器 → collapse(焦点不动);岗位行/折叠节点 → 焦点移到父行(无父不动);
 *  - Enter:岗位行 → select;容器行 → 切换展开(collapse/expand 视当前展开态);
 *  - 其它按键(含 Esc,由搜索框处理):仅返回当前焦点。
 */
export function keyboardMove(
  rows: VisibleRow[],
  focusIndex: number,
  key: string,
  expandedIds: Set<string>,
  expand: (id: string) => void,
  collapse: (id: string) => void,
  select: (id: string) => void,
): KeyboardMoveResult {
  if (rows.length === 0) return { focusIndex: 0 }
  const idx = Math.min(Math.max(0, focusIndex), rows.length - 1) // 焦点越界夹取
  const cur = rows[idx]!
  switch (key) {
    case 'ArrowDown': {
      if (idx >= rows.length - 1) return { focusIndex: idx }
      return { focusIndex: idx + 1 }
    }
    case 'ArrowUp': {
      if (idx <= 0) return { focusIndex: idx }
      return { focusIndex: idx - 1 }
    }
    case 'ArrowRight': {
      if (cur.type !== 'node' || cur.node === undefined) return { focusIndex: idx }
      const nodeId = cur.node.id
      if (!expandedIds.has(nodeId)) {
        expand(nodeId)
        return { focusIndex: idx, toggleNodeId: nodeId }
      }
      // 已展开:下一行即第一个子行(存在且更深才移动)
      const next = rows[idx + 1]
      if (next !== undefined && next.depth > cur.depth) return { focusIndex: idx + 1 }
      return { focusIndex: idx }
    }
    case 'ArrowLeft': {
      if (cur.type === 'node' && cur.node !== undefined && expandedIds.has(cur.node.id)) {
        collapse(cur.node.id)
        return { focusIndex: idx, toggleNodeId: cur.node.id }
      }
      // 岗位行或折叠节点:找最近的浅一级行即父行(扁平序中父行必在焦点之前)
      for (let j = idx - 1; j >= 0; j -= 1) {
        const row = rows[j]!
        if (row.depth < cur.depth) return { focusIndex: j }
      }
      return { focusIndex: idx } // 根节点无父行,不动
    }
    case 'Enter': {
      if (cur.type === 'position' && cur.pos !== undefined) {
        select(cur.pos.id)
        return { focusIndex: idx, selectPositionId: cur.pos.id }
      }
      if (cur.type === 'node' && cur.node !== undefined) {
        const nodeId = cur.node.id
        if (expandedIds.has(nodeId)) collapse(nodeId)
        else expand(nodeId)
        return { focusIndex: idx, toggleNodeId: nodeId }
      }
      return { focusIndex: idx }
    }
    default:
      return { focusIndex: idx }
  }
}
