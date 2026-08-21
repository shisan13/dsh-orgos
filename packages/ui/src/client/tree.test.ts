/**
 * tree.ts 纯函数单测(组织树视图 P1):Given-When-Then。
 * 覆盖:索引构建(根/排序/孤儿/岗位挂桶)、过滤(节点/岗位/祖先链/大小写/无命中)、
 * 默认展开规则(≤30 全展开 / >30 折叠 team)、聚合徽标文案、根聚合兜底。
 */
import { describe, expect, it } from 'vitest'
import {
  aggregateLabel,
  applyFilter,
  buildTreeIndex,
  defaultExpanded,
  orgRootId,
  rootAggregate,
  totalPositionCount,
} from './tree.js'
import type { OrgTreeAggregate, OrgTreeSnapshot } from './tree.js'

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
