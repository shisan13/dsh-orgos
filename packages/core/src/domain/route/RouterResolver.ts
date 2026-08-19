/**
 * RouterResolver —— 路由算法(技术设计 §6;FR-I2/I3/I4/I5)
 *
 * resolve(channel, peer, msg):
 *   1. 路由表精确匹配:(channel, peer.id) → positionId 或治理节点 id
 *   2. 未匹配:
 *      a. peer.kind=group 且群未绑定 → 回退:沿 org 树从根往下找"默认入口"节点
 *         (org 级 orchestrator,即 openclaw 的"main 兜底"语义);群内非 @ 提及静默
 *      b. peer.kind=direct 且用户在白名单 → 绑定到默认入口节点(默认 org orchestrator)
 *      c. 白名单外 → 拒绝(文案可配)
 *   3. 命中执行岗位 → route position(restricted 岗位标记 restricted)
 *   4. 命中治理节点 → 该层 orchestrator 占位者;无 orchestrator → 上抛父节点
 *   5. 命中 shared/guest 岗位 → 标记 restricted,由上层(ACL/投影)限制
 *
 * 本模块只做"配置期"路由决策:投递动作(ensurePosition/agent.inject/任务卡)由
 * Pro 阶段绑定层执行。纯函数,无 IO。
 */
import type { RouteRule } from '../types.ts'
import { OrgTree } from '../org/OrgTree.ts'

/** 入站消息的规范化最小视图(完整定义在 im-gateway 包;此处只取路由所需字段) */
export interface RoutableMessage {
  channel: string
  peer: { kind: 'group' | 'direct'; id: string }
  sender: { id: string }
  kind: 'text' | 'mention' | 'reply' | 'approval_reply' | 'attachment'
}

export type RouteAction = 'route' | 'reject' | 'silent'

export interface RouteResult {
  action: RouteAction
  /** 命中目标(route 时必填):岗位或治理节点 */
  target?: { kind: 'position' | 'node'; id: string }
  /** reject/silent 的原因(可观测/审计) */
  reason?: string
  /** 命中受限岗位(shared/guest) */
  restricted?: boolean
}

export interface RouterOptions {
  /** owner + allowlist 用户 id(按 sender.id 维度,安全设计 §2 T1) */
  ownerIds: string[]
  allowlist?: string[]
  /** 群内非 @ 提及是否静默(对应 openclaw requireMention,默认 true) */
  requireMentionInGroup?: boolean
  /** 未绑定入口回退目标节点(默认 org 根节点) */
  defaultEntryNodeId?: string
  /** 白名单外拒绝话术模板(占位 {userId} 可替换) */
  rejectionMessage?: string
}

export class RouterResolver {
  private readonly routes = new Map<string, RouteRule>()
  private readonly tree: OrgTree
  private readonly opts: Required<Pick<RouterOptions, 'ownerIds'>> & RouterOptions

  constructor(tree: OrgTree, routes: RouteRule[], opts: RouterOptions) {
    this.tree = tree
    this.opts = { requireMentionInGroup: true, ...opts }
    for (const rule of routes) {
      if (!rule.channel || !rule.peerId || !rule.target) continue
      this.routes.set(`${rule.channel}:${rule.peerId}`, rule)
    }
  }

  resolve(msg: RoutableMessage): RouteResult {
    // 1. 路由表精确匹配
    const rule = this.routes.get(`${msg.channel}:${msg.peer.id}`)
    if (rule) {
      return this.routeTarget(rule.target)
    }
    // 2. 未匹配:按 peer kind 回退
    if (msg.peer.kind === 'group') {
      if (this.opts.requireMentionInGroup && msg.kind !== 'mention') {
        return { action: 'silent', reason: 'group-require-mention' }
      }
      return this.routeTarget(this.defaultEntryNodeId())
    }
    // direct:白名单校验
    if (!this.isWhitelisted(msg.sender.id)) {
      return { action: 'reject', reason: 'not-whitelisted' }
    }
    return this.routeTarget(this.defaultEntryNodeId())
  }

  /** 白名单判定(owner + allowlist,安全设计 §2 T1) */
  isWhitelisted(userId: string): boolean {
    if (this.opts.ownerIds.includes(userId)) return true
    return this.opts.allowlist?.includes(userId) ?? false
  }

  /** 默认入口:显式配置 > org 根;根无 orchestrator 时沿树向下找第一个有 orchestrator 的节点 */
  private defaultEntryNodeId(): string {
    const explicit = this.opts.defaultEntryNodeId
    if (explicit) {
      if (!this.tree.hasNode(explicit)) {
        throw new Error(`RouterOptions.defaultEntryNodeId 不存在:${explicit}`)
      }
      return explicit
    }
    return this.firstOrchestratorNode(this.tree.root())
  }

  /** 沿树从 nodeId 往下(含自身)找第一个有 orchestrator 的治理节点 */
  private firstOrchestratorNode(nodeId: string): string {
    const node = this.tree.node(nodeId)
    if (this.tree.hasOrchestrator(nodeId)) return nodeId
    for (const child of node.children) {
      const hit = this.firstOrchestratorNode(child)
      if (hit !== '') return hit
    }
    return ''
  }

  /** 命中 target:岗位直接路由;治理节点找 orchestrator,无则上抛父链 */
  private routeTarget(target: string): RouteResult {
    if (this.tree.hasPosition(target)) {
      const result: RouteResult = { action: 'route', target: { kind: 'position', id: target } }
      if (this.tree.isRestricted(target)) result.restricted = true
      return result
    }
    if (this.tree.hasNode(target)) {
      return this.routeNode(target)
    }
    return { action: 'reject', reason: 'target-not-found' }
  }

  /** 治理节点:本层 orchestrator → 上抛父链(不可跳级) → 兜底拒绝 */
  private routeNode(nodeId: string): RouteResult {
    let cur: string | undefined = nodeId
    while (cur !== undefined) {
      const oc = this.tree.orchestratorOf(cur)
      if (oc) {
        return { action: 'route', target: { kind: 'position', id: oc } }
      }
      cur = this.tree.parentOf(cur)
    }
    return { action: 'reject', reason: 'no-orchestrator-on-chain' }
  }

  /** 运行时新增/删除路由(带校验;持久化由 team_setup 安全流程负责) */
  upsertRoute(rule: RouteRule): void {
    if (!this.tree.hasPosition(rule.target) && !this.tree.hasNode(rule.target)) {
      throw new Error(`路由目标不存在:${rule.target}`)
    }
    this.routes.set(`${rule.channel}:${rule.peerId}`, rule)
  }

  removeRoute(channel: string, peerId: string): boolean {
    return this.routes.delete(`${channel}:${peerId}`)
  }

  routeList(): RouteRule[] {
    return [...this.routes.values()]
  }
}
