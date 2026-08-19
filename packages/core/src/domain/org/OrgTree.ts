/**
 * OrgTree —— 组织树(技术设计 §4.1)
 *
 * 递归组织树:org → bg → dept → team → positions。
 * - 治理层节点(org/bg/dept/team)通过 children 组成树;
 * - 治理岗位(orchestrator)与执行岗位统一进 positions,节点只引用 orchestratorPosition;
 * - 树的叶子身份 = 岗位(Position),执行岗位挂在 team 节点下,治理岗位挂在所属节点上。
 *
 * 纪律:本类只做树结构与索引(纯数据),不做权限/路由判定——
 * 管辖子树判断(isAncestor/subtree)、升级链(pathToRoot)为上层提供几何基础。
 */
import type { NodeDef, PositionDef, TeamConfig } from '../types.ts'

export class OrgTreeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrgTreeError'
  }
}

export class OrgTree {
  private readonly nodes = new Map<string, NodeDef>()
  private readonly parentOfNode = new Map<string, string>()
  private readonly positions = new Map<string, PositionDef>()
  /** positionId → 所属节点 id(治理岗位→其节点;执行岗位→teamId 节点) */
  private readonly positionNodeMap = new Map<string, string>()
  /** nodeId → orchestratorPosition id(存在即有 orchestrator) */
  private readonly orchestratorOfNode = new Map<string, string>()
  private readonly rootId: string

  constructor(config: Pick<TeamConfig, 'org' | 'nodes' | 'positions'>) {
    this.rootId = config.org
    for (const node of config.nodes) {
      if (this.nodes.has(node.id)) {
        throw new OrgTreeError(`重复节点 id:${node.id}`)
      }
      this.nodes.set(node.id, node)
      if (node.orchestratorPosition) {
        this.orchestratorOfNode.set(node.id, node.orchestratorPosition)
      }
    }
    for (const node of config.nodes) {
      for (const child of node.children) {
        if (!this.nodes.has(child)) {
          throw new OrgTreeError(`节点 ${node.id} 的 children 引用了不存在的节点:${child}`)
        }
        if (this.parentOfNode.has(child)) {
          throw new OrgTreeError(`节点 ${child} 有多个父节点(不是树)`)
        }
        this.parentOfNode.set(child, node.id)
      }
    }
    // 根不得有父(成环检测优先于孤儿检测,报错语义更准确)
    if (this.parentOfNode.has(this.rootId)) {
      throw new OrgTreeError(`根节点 ${this.rootId} 不能有父节点(成环)`)
    }
    // 孤儿节点(除根外无父)报错
    for (const id of this.nodes.keys()) {
      if (id !== this.rootId && !this.parentOfNode.has(id)) {
        throw new OrgTreeError(`节点 ${id} 是孤儿(不在 ${this.rootId} 的树内)`)
      }
    }
    for (const position of config.positions) {
      if (this.positions.has(position.id)) {
        throw new OrgTreeError(`重复岗位 id:${position.id}`)
      }
      this.positions.set(position.id, position)
      if (position.teamId) {
        if (!this.nodes.has(position.teamId)) {
          throw new OrgTreeError(`岗位 ${position.id} 的 teamId 引用了不存在的节点:${position.teamId}`)
        }
        this.positionNodeMap.set(position.id, position.teamId)
      }
    }
    // 治理岗位反向索引:节点 orchestratorPosition → 岗位归属节点
    for (const node of config.nodes) {
      const oc = node.orchestratorPosition
      if (oc) {
        if (!this.positions.has(oc)) {
          throw new OrgTreeError(`节点 ${node.id} 的 orchestratorPosition 引用了不存在的岗位:${oc}`)
        }
        if (this.positionNodeMap.has(oc)) {
          throw new OrgTreeError(`岗位 ${oc} 同时是执行岗位与治理岗位`)
        }
        this.positionNodeMap.set(oc, node.id)
      }
    }
  }

  /** 根节点 id */
  root(): string {
    return this.rootId
  }

  hasNode(nodeId: string): boolean {
    return this.nodes.has(nodeId)
  }

  node(nodeId: string): NodeDef {
    const node = this.nodes.get(nodeId)
    if (!node) throw new OrgTreeError(`未知节点:${nodeId}`)
    return node
  }

  /** 全部治理节点(供配置校验/UI) */
  nodesAll(): NodeDef[] {
    return [...this.nodes.values()]
  }

  parentOf(nodeId: string): string | undefined {
    return this.parentOfNode.get(nodeId)
  }

  childrenOf(nodeId: string): string[] {
    const node = this.nodes.get(nodeId)
    if (!node) throw new OrgTreeError(`未知节点:${nodeId}`)
    return [...node.children]
  }

  /** 节点深度:根为 0 */
  depth(nodeId: string): number {
    let d = 0
    let cur: string | undefined = nodeId
    while (cur !== undefined && cur !== this.rootId) {
      cur = this.parentOfNode.get(cur)
      d += 1
      if (d > this.nodes.size) {
        throw new OrgTreeError(`节点 ${nodeId} 的父链成环`)
      }
    }
    if (cur === undefined) {
      throw new OrgTreeError(`节点 ${nodeId} 不在树内`)
    }
    return d
  }

  /** 节点到根的父链(含自身,不含根;升级链语义:index 0 最近父) */
  pathToRoot(nodeId: string): string[] {
    const path: string[] = []
    let cur = this.parentOfNode.get(nodeId)
    while (cur !== undefined) {
      path.push(cur)
      if (cur === this.rootId) break
      cur = this.parentOfNode.get(cur)
    }
    return path
  }

  /** 节点 id 是否为 ancestor 的后代(含自身;管辖子树判断的几何基础) */
  isAncestor(ancestorNodeId: string, nodeId: string): boolean {
    let cur: string | undefined = nodeId
    while (cur !== undefined) {
      if (cur === ancestorNodeId) return true
      cur = this.parentOfNode.get(cur)
    }
    return false
  }

  /** 以 nodeId 为根的整棵子树节点 id 集合(含自身;深度优先) */
  subtree(nodeId: string): string[] {
    if (!this.nodes.has(nodeId)) throw new OrgTreeError(`未知节点:${nodeId}`)
    const out: string[] = []
    const walk = (id: string): void => {
      out.push(id)
      for (const child of this.nodes.get(id)?.children ?? []) walk(child)
    }
    walk(nodeId)
    return out
  }

  hasPosition(positionId: string): boolean {
    return this.positions.has(positionId)
  }

  position(positionId: string): PositionDef {
    const position = this.positions.get(positionId)
    if (!position) throw new OrgTreeError(`未知岗位:${positionId}`)
    return position
  }

  positionsAll(): PositionDef[] {
    return [...this.positions.values()]
  }

  /** 岗位所属节点(治理岗位→其节点;执行岗位→team 节点) */
  nodeOfPosition(positionId: string): string {
    const nodeId = this.positionNodeMap.get(positionId)
    if (!nodeId) throw new OrgTreeError(`岗位 ${positionId} 未归属任何节点`)
    return nodeId
  }

  /** 节点是否配置了 orchestrator 岗位 */
  hasOrchestrator(nodeId: string): boolean {
    return this.orchestratorOfNode.has(nodeId)
  }

  orchestratorOf(nodeId: string): string | undefined {
    return this.orchestratorOfNode.get(nodeId)
  }

  /** 岗位是否为治理岗位(某节点的 orchestrator) */
  isOrchestrator(positionId: string): boolean {
    for (const nodeId of this.orchestratorOfNode.keys()) {
      if (this.orchestratorOfNode.get(nodeId) === positionId) return true
    }
    return false
  }

  /** 岗位是否为受限岗位(shared/guest) */
  isRestricted(positionId: string): boolean {
    return this.position(positionId).restricted === true
  }

  /** 岗位占位者类型 */
  occupantKind(positionId: string): 'agent' | 'human' {
    return this.position(positionId).occupant.kind
  }
}
