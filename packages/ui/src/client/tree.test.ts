/**
 * tree.ts 纯函数单测(组织树视图 P1+P2):Given-When-Then。
 * P1 覆盖:索引构建(根/排序/孤儿/岗位挂桶)、过滤(节点/岗位/祖先链/大小写/无命中)、
 * 默认展开规则(≤30 全展开 / >30 折叠 team)、聚合徽标文案、根聚合兜底。
 * P2 覆盖:flattenVisible(深层树/折叠/搜索态祖先并入/脏引用/空树)、
 * visibleWindow(夹取/overscan/退化输入)、keyboardMove(方向键/展开折叠/选中/越界/空表)。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  aggregateLabel,
  applyFilter,
  buildTreeIndex,
  defaultExpanded,
  flattenVisible,
  keyboardMove,
  orgRootId,
  rootAggregate,
  totalPositionCount,
  visibleWindow,
} from './tree.js'
import type { OrgTreeAggregate, OrgTreeSnapshot, VisibleRow } from './tree.js'

/** 3 层 fixture:org → bg/dept → team → 岗位;含治理岗位、孤儿节点、全部四种容器 kind */
function makeFixture(): OrgTreeSnapshot {
  const zero = (): OrgTreeAggregate => ({
    positionCount: 0,
    busy: 0,
    idle: 0,
    offline: 0,
    failed: 0,
    openDelegations: 0,
    openTasks: 0,
  })
  const agg = (over: Partial<OrgTreeAggregate>): OrgTreeAggregate => ({ ...zero(), ...over })
  return {
    nodes: [
      { id: 'acme', kind: 'org', parentId: null, title: 'Acme Org' },
      { id: 'core', kind: 'bg', parentId: 'acme', title: 'Core BG' },
      { id: 'ops', kind: 'dept', parentId: 'acme', title: 'Ops Dept' },
      { id: 'team-a', kind: 'team', parentId: 'core', title: 'Platform Team' },
      { id: 'team-b', kind: 'team', parentId: 'core', title: 'Efficiency Team' },
      { id: 'team-c', kind: 'team', parentId: 'ops', title: 'Duty Team' },
      // 孤儿节点:parentId 指向不存在的节点
      { id: 'ghost-team', kind: 'team', parentId: 'ghost', title: 'Ghost Team' },
    ],
    positionsByNode: {
      acme: [{ id: 'lead', title: 'Orchestrator', kind: 'agent', status: 'offline' }],
      core: [],
      ops: [],
      'team-a': [
        { id: 'coder-1', title: 'Senior Coder', preset: 'orgos-coder', kind: 'agent', status: 'busy', openDelegations: 2, openTasks: 1 },
        { id: 'coder-2', title: 'Junior Coder', kind: 'agent', status: 'idle' },
      ],
      'team-b': [{ id: 'assistant-1', title: 'Assistant', preset: 'orgos-assistant', kind: 'agent', status: 'offline' }],
      'team-c': [{ id: 'op-1', title: 'Operator', kind: 'agent', status: 'failed' }],
      'ghost-team': [],
    },
    aggregates: {
      acme: agg({ positionCount: 5, busy: 1, idle: 1, offline: 2, failed: 1, openDelegations: 2, openTasks: 1 }),
      core: agg({ positionCount: 3, busy: 1, idle: 1, offline: 1, failed: 0, openDelegations: 2, openTasks: 1 }),
      ops: agg({ positionCount: 1, busy: 0, idle: 0, offline: 0, failed: 1, openDelegations: 0, openTasks: 0 }),
      'team-a': agg({ positionCount: 2, busy: 1, idle: 1, offline: 0, failed: 0, openDelegations: 2, openTasks: 1 }),
      'team-b': agg({ positionCount: 1, busy: 0, idle: 0, offline: 1, failed: 0, openDelegations: 0, openTasks: 0 }),
      'team-c': agg({ positionCount: 1, busy: 0, idle: 0, offline: 0, failed: 1, openDelegations: 0, openTasks: 0 }),
    },
  }
}

/** 大组织 fixture:总岗位数 > 30(验证默认折叠规则) */
function makeBigTree(teamCount: number, perTeam: number): OrgTreeSnapshot {
  const nodes: OrgTreeSnapshot['nodes'] = [
    { id: 'big', kind: 'org', parentId: null, title: 'Big Org' },
    { id: 'bg1', kind: 'bg', parentId: 'big', title: 'BG One' },
  ]
  const positionsByNode: OrgTreeSnapshot['positionsByNode'] = { big: [], bg1: [] }
  const aggregates: OrgTreeSnapshot['aggregates'] = {}
  const zero: OrgTreeAggregate = { positionCount: 0, busy: 0, idle: 0, offline: 0, failed: 0, openDelegations: 0, openTasks: 0 }
  let total = 0
  for (let i = 0; i < teamCount; i += 1) {
    const teamId = `team-${i}`
    nodes.push({ id: teamId, kind: 'team', parentId: 'bg1', title: `Team ${i}` })
    const list: OrgTreeSnapshot['positionsByNode'][string] = []
    for (let j = 0; j < perTeam; j += 1) {
      list.push({ id: `${teamId}-p${j}`, title: `Worker ${j}`, kind: 'agent', status: 'offline' })
      total += 1
    }
    positionsByNode[teamId] = list
    aggregates[teamId] = { ...zero, positionCount: perTeam, offline: perTeam }
  }
  aggregates.bg1 = { ...zero, positionCount: total, offline: total }
  aggregates.big = { ...zero, positionCount: total, offline: total }
  return { nodes, positionsByNode, aggregates }
}

describe('buildTreeIndex(渲染索引)', () => {
  it('GIVEN 3 层组织树 WHEN buildTreeIndex THEN roots 只含 org 根且 children 桶按 title 排序', () => {
    const index = buildTreeIndex(makeFixture())
    expect(index.roots).toEqual(['acme'])
    // Core BG 排在 Ops Dept 前(ASCII 升序);core 下 Efficiency < Platform(按 title 排序)
    expect(index.children.get('acme')).toEqual(['core', 'ops'])
    expect(index.children.get('core')).toEqual(['team-b', 'team-a'])
    expect(index.children.get('ops')).toEqual(['team-c'])
  })

  it('GIVEN 两个子节点 title 相同 WHEN buildTreeIndex THEN 按 id 稳定排序', () => {
    const tree: OrgTreeSnapshot = {
      nodes: [
        { id: 'root', kind: 'org', parentId: null, title: 'Root' },
        { id: 'b-node', kind: 'team', parentId: 'root', title: 'Same Name' },
        { id: 'a-node', kind: 'team', parentId: 'root', title: 'Same Name' },
      ],
      positionsByNode: { root: [], 'b-node': [], 'a-node': [] },
      aggregates: {},
    }
    expect(buildTreeIndex(tree).children.get('root')).toEqual(['a-node', 'b-node'])
  })

  it('GIVEN parentId 指向不存在的节点 WHEN buildTreeIndex THEN 孤儿仅存于 nodeById,不出现在 children/roots', () => {
    const index = buildTreeIndex(makeFixture())
    expect(index.nodeById.has('ghost-team')).toBe(true)
    expect(index.roots).not.toContain('ghost-team')
    for (const list of index.children.values()) expect(list).not.toContain('ghost-team')
  })

  it('GIVEN 岗位挂桶 WHEN buildTreeIndex THEN positions 按所属节点挂载(治理岗位挂 org,执行岗位挂 team)', () => {
    const index = buildTreeIndex(makeFixture())
    expect(index.positions.get('acme')?.map((p) => p.id)).toEqual(['lead'])
    expect(index.positions.get('team-a')?.length).toBe(2)
    expect(index.positions.get('team-b')?.map((p) => p.id)).toEqual(['assistant-1'])
    expect(index.positions.get('team-c')?.map((p) => p.id)).toEqual(['op-1'])
  })
})

describe('applyFilter(搜索过滤)', () => {
  it('GIVEN 空查询 WHEN applyFilter THEN hitIds 与 expandedAncestors 均为空', () => {
    const result = applyFilter(makeFixture(), '   ')
    expect(result.hitIds.size).toBe(0)
    expect(result.expandedAncestors.size).toBe(0)
  })

  it('GIVEN 岗位 title/id 命中 WHEN 查询 coder THEN hitIds 含两个 coder 岗位且不含节点', () => {
    const result = applyFilter(makeFixture(), 'coder')
    expect(result.hitIds.has('coder-1')).toBe(true)
    expect(result.hitIds.has('coder-2')).toBe(true)
    expect(result.hitIds.has('team-a')).toBe(false)
  })

  it('GIVEN 节点 title 命中 WHEN 查询 platform THEN hitIds 含 team-a 且祖先链含 core、acme', () => {
    const result = applyFilter(makeFixture(), 'platform')
    expect(result.hitIds.has('team-a')).toBe(true)
    expect(result.expandedAncestors.has('core')).toBe(true)
    expect(result.expandedAncestors.has('acme')).toBe(true)
    expect(result.expandedAncestors.has('team-a')).toBe(false) // 自身不算祖先
  })

  it('GIVEN 岗位命中 WHEN 查询 op-1 THEN 祖先链含 team-c、ops、acme(岗位父链逐级上溯)', () => {
    const result = applyFilter(makeFixture(), 'op-1')
    expect(result.hitIds.has('op-1')).toBe(true)
    expect(result.expandedAncestors.has('team-c')).toBe(true)
    expect(result.expandedAncestors.has('ops')).toBe(true)
    expect(result.expandedAncestors.has('acme')).toBe(true)
  })

  it('GIVEN 大小写混合 WHEN 查询 PLATFORM THEN 命中 team-a(大小写不敏感)', () => {
    const result = applyFilter(makeFixture(), 'PLATFORM')
    expect(result.hitIds.has('team-a')).toBe(true)
  })

  it('GIVEN 无任何匹配 WHEN 查询 nope THEN 两集合均为空(UI 显示无命中提示)', () => {
    const result = applyFilter(makeFixture(), 'nope')
    expect(result.hitIds.size).toBe(0)
    expect(result.expandedAncestors.size).toBe(0)
  })

  it('GIVEN 按节点 id 命中 WHEN 查询 team-c THEN hitIds 含 team-c 且祖先链含 ops', () => {
    const result = applyFilter(makeFixture(), 'team-c')
    expect(result.hitIds.has('team-c')).toBe(true)
    expect(result.expandedAncestors.has('ops')).toBe(true)
  })
})

describe('defaultExpanded(默认展开规则)', () => {
  it('GIVEN 总岗位数 5 ≤ 30 WHEN defaultExpanded THEN 全部节点展开(含 team)', () => {
    const expanded = defaultExpanded(makeFixture())
    expect(expanded.size).toBe(7) // 6 个真实节点 + 孤儿节点
    expect(expanded.has('acme')).toBe(true)
    expect(expanded.has('core')).toBe(true)
    expect(expanded.has('team-a')).toBe(true)
    expect(expanded.has('ghost-team')).toBe(true)
  })

  it('GIVEN 总岗位数 36 > 30 WHEN defaultExpanded THEN org/bg 展开、team 折叠(首屏只见骨架)', () => {
    const expanded = defaultExpanded(makeBigTree(4, 9))
    expect(expanded.has('big')).toBe(true)
    expect(expanded.has('bg1')).toBe(true)
    expect(expanded.has('team-0')).toBe(false)
    expect(expanded.has('team-3')).toBe(false)
  })
})

describe('aggregateLabel(聚合徽标文案)', () => {
  it('GIVEN 混合聚合 WHEN aggregateLabel THEN 文案为「N岗位 · X忙 · Y待命 · Z失败」', () => {
    const label = aggregateLabel({ positionCount: 5, busy: 1, idle: 1, offline: 2, failed: 1, openDelegations: 2, openTasks: 1 })
    expect(label).toBe('5岗位 · 1忙 · 2待命 · 1失败')
  })

  it('GIVEN 全零聚合 WHEN aggregateLabel THEN 文案为「0岗位 · 0忙 · 0待命 · 0失败」', () => {
    const label = aggregateLabel({ positionCount: 0, busy: 0, idle: 0, offline: 0, failed: 0, openDelegations: 0, openTasks: 0 })
    expect(label).toBe('0岗位 · 0忙 · 0待命 · 0失败')
  })
})

describe('根聚合兜底(概览条数据源)', () => {
  it('GIVEN 有 org 根 WHEN orgRootId/rootAggregate THEN 返回 org 根及其聚合', () => {
    const tree = makeFixture()
    expect(orgRootId(tree)).toBe('acme')
    expect(rootAggregate(tree)?.positionCount).toBe(5)
    expect(totalPositionCount(tree)).toBe(5)
  })

  it('GIVEN 多根且无 org kind WHEN orgRootId THEN 取第一个根(不崩溃)', () => {
    const tree: OrgTreeSnapshot = {
      nodes: [
        { id: 'r1', kind: 'bg', parentId: null, title: 'R1' },
        { id: 'r2', kind: 'bg', parentId: null, title: 'R2' },
      ],
      positionsByNode: { r1: [], r2: [] },
      aggregates: {},
    }
    expect(orgRootId(tree)).toBe('r1')
  })

  it('GIVEN 无根节点 WHEN orgRootId/rootAggregate THEN null/undefined,不抛错', () => {
    const tree: OrgTreeSnapshot = { nodes: [{ id: 'x', kind: 'team', parentId: 'ghost' }], positionsByNode: {}, aggregates: {} }
    expect(orgRootId(tree)).toBeNull()
    expect(rootAggregate(tree)).toBeUndefined()
    expect(totalPositionCount(tree)).toBe(0)
  })

  it('GIVEN 无根聚合记录 WHEN totalPositionCount THEN 逐桶求和兜底', () => {
    const tree: OrgTreeSnapshot = {
      nodes: [{ id: 'root', kind: 'org', parentId: null, title: 'Root' }],
      positionsByNode: {
        root: [
          { id: 'p1', kind: 'agent', status: 'offline' },
          { id: 'p2', kind: 'agent', status: 'busy' },
        ],
      },
      aggregates: {},
    }
    expect(totalPositionCount(tree)).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// P2:flattenVisible / visibleWindow / keyboardMove
// ---------------------------------------------------------------------------

/** 4 层深树:org → bg → dept → team → 岗位(depth 最深处 4) */
function makeDeepTree(): OrgTreeSnapshot {
  return {
    nodes: [
      { id: 'o', kind: 'org', parentId: null },
      { id: 'b', kind: 'bg', parentId: 'o' },
      { id: 'd', kind: 'dept', parentId: 'b' },
      { id: 't1', kind: 'team', parentId: 'd' },
      { id: 't2', kind: 'team', parentId: 'd' },
    ],
    positionsByNode: {
      o: [],
      b: [],
      d: [],
      t1: [{ id: 'p1', kind: 'agent', status: 'offline' }],
      t2: [],
    },
    aggregates: {},
  }
}

/** fixture 全展开的行数组(id 序:acme→core→team-b→assistant-1→team-a→coder-1→coder-2→ops→team-c→op-1→lead) */
function allRows(): VisibleRow[] {
  const tree = makeFixture()
  return flattenVisible(tree, buildTreeIndex(tree), defaultExpanded(tree))
}

/** 行数组内全部节点 id(作为「已展开」集合) */
function nodeIds(rows: VisibleRow[]): Set<string> {
  return new Set(rows.filter((r) => r.type === 'node').map((r) => r.node!.id))
}

describe('flattenVisible(按展开集合扁平化)', () => {
  it('GIVEN 全部展开 WHEN flattenVisible THEN 行序深度优先:节点行在前、岗位行跟随其节点、祖先在前', () => {
    const rows = allRows()
    expect(rows.map((r) => (r.type === 'node' ? r.node!.id : r.pos!.id))).toEqual([
      'acme', 'core', 'team-b', 'assistant-1', 'team-a', 'coder-1', 'coder-2', 'ops', 'team-c', 'op-1', 'lead',
    ])
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 3, 2, 3, 3, 1, 2, 3, 1])
    expect(rows[0]!.type).toBe('node')
    expect(rows[3]!.type).toBe('position')
  })

  it('GIVEN core 折叠 WHEN flattenVisible THEN 其后代(team-b/team-a 及岗位)不产出,但 core 行保留', () => {
    const tree = makeFixture()
    const expanded = defaultExpanded(tree)
    expanded.delete('core')
    const rows = flattenVisible(tree, buildTreeIndex(tree), expanded)
    expect(rows.map((r) => (r.type === 'node' ? r.node!.id : r.pos!.id))).toEqual(['acme', 'core', 'ops', 'team-c', 'op-1', 'lead'])
    expect(rows[1]!.type).toBe('node')
  })

  it('GIVEN 仅展开根 WHEN flattenVisible THEN 根行+直属子节点行+根直属岗位(子节点自身折叠,其后代不产出)', () => {
    const tree = makeFixture()
    const rows = flattenVisible(tree, buildTreeIndex(tree), new Set(['acme']))
    expect(rows.map((r) => (r.type === 'node' ? r.node!.id : r.pos!.id))).toEqual(['acme', 'core', 'ops', 'lead'])
    expect(rows.filter((r) => r.type === 'position')).toHaveLength(1) // 仅根直属岗位
  })

  it('GIVEN 展开集合为空 WHEN flattenVisible THEN 仅根行(后代全部不产出)', () => {
    const tree = makeFixture()
    const rows = flattenVisible(tree, buildTreeIndex(tree), new Set())
    expect(rows.map((r) => r.node!.id)).toEqual(['acme'])
  })

  it('GIVEN 4 层深树全展开 WHEN flattenVisible THEN 行序按深度优先且 depth 逐层正确', () => {
    const tree = makeDeepTree()
    const rows = flattenVisible(tree, buildTreeIndex(tree), new Set(['o', 'b', 'd', 't1', 't2']))
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 3, 4, 3])
    expect(rows[3]!.node!.id).toBe('t1')
    expect(rows[4]!.type).toBe('position')
    expect(rows[4]!.pos!.id).toBe('p1')
    expect(rows[5]!.node!.id).toBe('t2')
  })

  it('GIVEN 4 层深树中层折叠 WHEN flattenVisible THEN 折叠节点后代(含岗位)整体不产出', () => {
    const tree = makeDeepTree()
    // 展开 o/b,折叠 d:d 行仍产出,但 t1/t2 及其岗位不产出
    const rows = flattenVisible(tree, buildTreeIndex(tree), new Set(['o', 'b']))
    expect(rows.map((r) => (r.type === 'node' ? r.node!.id : r.pos!.id))).toEqual(['o', 'b', 'd'])
  })

  it('GIVEN 搜索态调用方把命中祖先并入 expandedIds WHEN flattenVisible THEN 命中岗位行可达', () => {
    const tree = makeFixture()
    const filter = applyFilter(tree, 'coder')
    const expanded = new Set([...defaultExpanded(tree), ...filter.expandedAncestors])
    const rows = flattenVisible(tree, buildTreeIndex(tree), expanded)
    const ids = rows.map((r) => (r.type === 'node' ? r.node!.id : r.pos!.id))
    expect(ids).toContain('coder-1')
    expect(ids).toContain('coder-2')
  })

  it('GIVEN children 桶含脏引用 WHEN flattenVisible THEN 跳过未定义节点不崩溃', () => {
    const tree = makeFixture()
    const index = buildTreeIndex(tree)
    index.children.get('core')!.push('no-such-node')
    const rows = flattenVisible(tree, index, defaultExpanded(tree))
    expect(rows.some((r) => r.type === 'node' && r.node!.id === 'no-such-node')).toBe(false)
  })

  it('GIVEN 节点岗位桶缺失 WHEN flattenVisible THEN 该节点行保留、无岗位行(?? [])', () => {
    const tree = makeFixture()
    delete tree.positionsByNode['team-a']
    const rows = flattenVisible(tree, buildTreeIndex(tree), defaultExpanded(tree))
    const ids = rows.map((r) => (r.type === 'node' ? r.node!.id : r.pos!.id))
    expect(ids).toContain('team-a')
    expect(ids).not.toContain('coder-1')
  })

  it('GIVEN 空树 WHEN flattenVisible THEN 返回空数组', () => {
    const empty: OrgTreeSnapshot = { nodes: [], positionsByNode: {}, aggregates: {} }
    expect(flattenVisible(empty, buildTreeIndex(empty), new Set())).toEqual([])
  })
})

describe('visibleWindow(窗口化计算)', () => {
  it('GIVEN 顶部视口 WHEN visibleWindow THEN start=0,end=可见行数+overscan', () => {
    expect(visibleWindow(100, 0, 440, 22, 5)).toEqual({ start: 0, end: 25 }) // ceil(440/22)=20,+5
  })

  it('GIVEN 中部滚动 WHEN visibleWindow THEN start=floor(scrollTop/rowH)-overscan,end=ceil((scrollTop+viewH)/rowH)+overscan', () => {
    expect(visibleWindow(100, 220, 440, 22, 5)).toEqual({ start: 5, end: 35 }) // floor(10)-5 / ceil(660/22)+5
  })

  it('GIVEN scrollTop 不足一行 WHEN visibleWindow THEN start 夹取到 0', () => {
    expect(visibleWindow(100, 10, 440, 22, 0)).toEqual({ start: 0, end: 21 }) // ceil(450/22)=21
  })

  it('GIVEN 滚动到底 WHEN visibleWindow THEN end 夹取到 total', () => {
    expect(visibleWindow(100, 2200, 440, 22, 5)).toEqual({ start: 95, end: 100 }) // floor(100)-5 / ceil(2640/22)+5=125→100
  })

  it('GIVEN 视口高度超过全部内容 WHEN visibleWindow THEN 全量可见', () => {
    expect(visibleWindow(10, 0, 500, 22, 2)).toEqual({ start: 0, end: 10 })
  })

  it('GIVEN overscan=0 WHEN visibleWindow THEN 窗口恰为视口覆盖行', () => {
    expect(visibleWindow(100, 220, 220, 22, 0)).toEqual({ start: 10, end: 20 })
  })

  it('GIVEN total=0 WHEN visibleWindow THEN {start:0,end:0}', () => {
    expect(visibleWindow(0, 0, 440, 22, 5)).toEqual({ start: 0, end: 0 })
  })

  it('GIVEN rowHeight=0 退化配置 WHEN visibleWindow THEN 返回全量窗口不崩溃', () => {
    expect(visibleWindow(50, 0, 440, 0, 5)).toEqual({ start: 0, end: 50 })
  })
})

describe('keyboardMove(键盘导航决策)', () => {
  it('GIVEN ArrowDown 中间行 WHEN keyboardMove THEN focusIndex+1 且无副作用', () => {
    const expand = vi.fn()
    const collapse = vi.fn()
    const select = vi.fn()
    const r = keyboardMove(allRows(), 2, 'ArrowDown', new Set(), expand, collapse, select)
    expect(r.focusIndex).toBe(3)
    expect(r.toggleNodeId).toBeUndefined()
    expect(r.selectPositionId).toBeUndefined()
    expect(expand).not.toHaveBeenCalled()
    expect(collapse).not.toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
  })

  it('GIVEN ArrowDown 末行 WHEN keyboardMove THEN focusIndex 不动(越界不移动)', () => {
    const r = keyboardMove(allRows(), 10, 'ArrowDown', new Set(), vi.fn(), vi.fn(), vi.fn())
    expect(r.focusIndex).toBe(10)
  })

  it('GIVEN ArrowUp 中间行 WHEN keyboardMove THEN focusIndex-1', () => {
    const r = keyboardMove(allRows(), 5, 'ArrowUp', new Set(), vi.fn(), vi.fn(), vi.fn())
    expect(r.focusIndex).toBe(4)
  })

  it('GIVEN ArrowUp 首行 WHEN keyboardMove THEN focusIndex 不动', () => {
    const r = keyboardMove(allRows(), 0, 'ArrowUp', new Set(), vi.fn(), vi.fn(), vi.fn())
    expect(r.focusIndex).toBe(0)
  })

  it('GIVEN ArrowRight 折叠容器节点 WHEN keyboardMove THEN expand 该节点且 focus 不动', () => {
    const expand = vi.fn()
    const r = keyboardMove(allRows(), 1, 'ArrowRight', new Set(['acme']), expand, vi.fn(), vi.fn())
    expect(r.focusIndex).toBe(1)
    expect(r.toggleNodeId).toBe('core')
    expect(expand).toHaveBeenCalledWith('core')
  })

  it('GIVEN ArrowRight 已展开且有子行 WHEN keyboardMove THEN focus 移到第一个子行', () => {
    const rows = allRows()
    const r = keyboardMove(rows, 1, 'ArrowRight', nodeIds(rows), vi.fn(), vi.fn(), vi.fn())
    expect(r.focusIndex).toBe(2) // core → team-b
  })

  it('GIVEN ArrowRight 已展开叶子节点(无子行)WHEN keyboardMove THEN focus 不动', () => {
    const rows: VisibleRow[] = [
      { type: 'node', node: { id: 'root', kind: 'org', parentId: null }, depth: 0 },
      { type: 'node', node: { id: 'leaf', kind: 'team', parentId: 'root' }, depth: 1 },
      { type: 'node', node: { id: 'sib', kind: 'team', parentId: 'root' }, depth: 1 },
    ]
    const r = keyboardMove(rows, 1, 'ArrowRight', new Set(['root', 'leaf']), vi.fn(), vi.fn(), vi.fn())
    expect(r.focusIndex).toBe(1)
  })

  it('GIVEN ArrowRight 岗位行 WHEN keyboardMove THEN focus 不动且无副作用', () => {
    const r = keyboardMove(allRows(), 3, 'ArrowRight', new Set(), vi.fn(), vi.fn(), vi.fn())
    expect(r.focusIndex).toBe(3)
  })

  it('GIVEN ArrowLeft 已展开容器节点 WHEN keyboardMove THEN collapse 该节点且 focus 不动', () => {
    const collapse = vi.fn()
    const r = keyboardMove(allRows(), 1, 'ArrowLeft', new Set(['acme', 'core']), vi.fn(), collapse, vi.fn())
    expect(r.focusIndex).toBe(1)
    expect(r.toggleNodeId).toBe('core')
    expect(collapse).toHaveBeenCalledWith('core')
  })

  it('GIVEN ArrowLeft 折叠容器节点 WHEN keyboardMove THEN focus 移到父行', () => {
    const r = keyboardMove(allRows(), 1, 'ArrowLeft', new Set(['acme']), vi.fn(), vi.fn(), vi.fn())
    expect(r.focusIndex).toBe(0) // core → acme
  })

  it('GIVEN ArrowLeft 岗位行 WHEN keyboardMove THEN focus 移到所属节点行', () => {
    const r = keyboardMove(allRows(), 3, 'ArrowLeft', new Set(), vi.fn(), vi.fn(), vi.fn())
    expect(r.focusIndex).toBe(2) // assistant-1 → team-b
  })

  it('GIVEN ArrowLeft 根节点且无父 WHEN keyboardMove THEN focus 不动', () => {
    const r = keyboardMove(allRows(), 0, 'ArrowLeft', new Set(), vi.fn(), vi.fn(), vi.fn())
    expect(r.focusIndex).toBe(0)
  })

  it('GIVEN Enter 岗位行 WHEN keyboardMove THEN select 该岗位且 focus 不动', () => {
    const select = vi.fn()
    const r = keyboardMove(allRows(), 3, 'Enter', new Set(), vi.fn(), vi.fn(), select)
    expect(r.focusIndex).toBe(3)
    expect(r.selectPositionId).toBe('assistant-1')
    expect(select).toHaveBeenCalledWith('assistant-1')
  })

  it('GIVEN Enter 折叠容器节点 WHEN keyboardMove THEN expand 该节点', () => {
    const expand = vi.fn()
    const r = keyboardMove(allRows(), 1, 'Enter', new Set(['acme']), expand, vi.fn(), vi.fn())
    expect(r.focusIndex).toBe(1)
    expect(r.toggleNodeId).toBe('core')
    expect(expand).toHaveBeenCalledWith('core')
  })

  it('GIVEN Enter 已展开容器节点 WHEN keyboardMove THEN collapse 该节点', () => {
    const collapse = vi.fn()
    const r = keyboardMove(allRows(), 1, 'Enter', new Set(['acme', 'core']), vi.fn(), collapse, vi.fn())
    expect(r.toggleNodeId).toBe('core')
    expect(collapse).toHaveBeenCalledWith('core')
  })

  it('GIVEN 其它按键(Esc 等)WHEN keyboardMove THEN focus 不动且无副作用', () => {
    const expand = vi.fn()
    const collapse = vi.fn()
    const select = vi.fn()
    const r = keyboardMove(allRows(), 4, 'Escape', new Set(), expand, collapse, select)
    expect(r.focusIndex).toBe(4)
    expect(expand).not.toHaveBeenCalled()
    expect(collapse).not.toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
  })

  it('GIVEN 空行列表 WHEN keyboardMove THEN focusIndex=0 且无副作用', () => {
    const expand = vi.fn()
    expect(keyboardMove([], 0, 'ArrowDown', new Set(), expand, vi.fn(), vi.fn())).toEqual({ focusIndex: 0 })
    expect(expand).not.toHaveBeenCalled()
  })

  it('GIVEN focusIndex 越界 WHEN keyboardMove THEN 夹取到 [0, rows.length-1]', () => {
    const r = keyboardMove(allRows(), 99, 'ArrowDown', new Set(), vi.fn(), vi.fn(), vi.fn())
    expect(r.focusIndex).toBe(10) // 夹到末行后 ArrowDown 不再动
  })
})
