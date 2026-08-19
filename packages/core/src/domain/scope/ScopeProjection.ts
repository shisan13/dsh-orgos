/**
 * ScopeProjection —— 五维 scope 的服务端强制投影(技术设计 §4.6.2;FR-S1~S5;FR-R3)
 *
 * 设计主线:所有投影过滤(任务板/邮箱/记忆/委派查询)按调用方身份过滤后返回,
 * 工具只拿得到自己 scope 内的数据——过滤是强制机制,不是提示词恳求。
 *
 * 五维:visibility(看)/ authority(做)/ tool(用,由角色 preset 决定,不在此投影)/
 * memory(记)/ subscription(听)。本模块实现 visibility/authority 的判定核心:
 * - roleScope:按岗位层级推导五维默认值(§4.6.2 表;roles 覆盖);
 * - projectTasks / projectMail:服务端投影(越权数据不可达);
 * - canDelegate / canMail:authority 判定(engine/mailbox 已内置,此处提供统一入口供工具层用)。
 *
 * T10(人类成员隐私):同级 agent 查询人类成员任务,只返回结构化元数据,
 * 汇报正文/详情需 authority 授权(上级 orchestrator 可下钻)。
 */
import { OrgTree } from '../org/OrgTree.ts'
import type { PositionDef, RoleDefaults, TeamConfig } from '../types.ts'

export type ScopeLevel = 'self' | 'team' | 'dept' | 'bg' | 'org'

export interface MemberScope {
  visibility: ScopeLevel
  authority: ScopeLevel
  /** memory 允许 private(私有记忆,FR-M1) */
  memory: RoleDefaults['memory']
  subscription: ScopeLevel[]
}

/** §4.6.2 层级默认表:节点 kind → 治理岗位默认五维 */
const NODE_DEFAULTS: Record<'org' | 'bg' | 'dept' | 'team', RoleDefaults> = {
  org: { visibility: 'org', authority: 'org', memory: ['private', 'team', 'dept', 'bg', 'org'], subscription: ['org', 'bg', 'dept', 'team'] },
  bg: { visibility: 'bg', authority: 'bg', memory: ['private', 'team', 'dept', 'bg'], subscription: ['bg', 'dept', 'team'] },
  dept: { visibility: 'dept', authority: 'dept', memory: ['private', 'team', 'dept'], subscription: ['dept', 'team'] },
  team: { visibility: 'team', authority: 'team', memory: ['private', 'team'], subscription: ['team', 'self'] },
}

/** 执行岗位默认(member):只见自己相关 */
const MEMBER_DEFAULTS: RoleDefaults = {
  visibility: 'self',
  authority: 'self',
  memory: ['private', 'team'],
  subscription: ['self', 'team'],
}

/** 受限岗位(shared/guest):记忆仅私有、订阅仅自己(安全设计 T7) */
const RESTRICTED_DEFAULTS: RoleDefaults = {
  visibility: 'self',
  authority: 'self',
  memory: ['private'],
  subscription: ['self'],
}

/** 按岗位推导五维 scope(roles 覆盖 > 层级默认 > 受限默认) */
export function roleScope(tree: OrgTree, positionId: string, roles?: TeamConfig['roles']): MemberScope {
  const position = tree.position(positionId)
  const defaults = defaultsFor(tree, position)
  const override = roles?.[position.occupant.preset ?? '']
  if (!override) return defaults
  return {
    visibility: override.visibility ?? defaults.visibility,
    authority: override.authority ?? defaults.authority,
    memory: override.memory.length > 0 ? override.memory : defaults.memory,
    subscription: override.subscription.length > 0 ? override.subscription : defaults.subscription,
  }
}

function defaultsFor(tree: OrgTree, position: PositionDef): MemberScope {
  const base = position.restricted === true
    ? RESTRICTED_DEFAULTS
    : tree.isOrchestrator(position.id)
      ? NODE_DEFAULTS[tree.node(tree.nodeOfPosition(position.id)).kind]
      : MEMBER_DEFAULTS
  return { ...base }
}

/**
 * 调用方可见范围(节点级):self=岗位所在 team 节点;team 及以上=管辖子树。
 * 返回 { nodeIds, selfOnly } —— 投影判定的几何基础。
 */
export interface VisibilityGeometry {
  /** viewer 可见的治理节点集合(team 及以上覆盖整个子树) */
  nodeIds: Set<string>
  /** visibility=self 时,只允许与 viewer 直接相关的条目 */
  selfOnly: boolean
}

export function visibilityGeometry(tree: OrgTree, viewerPositionId: string, scope: MemberScope): VisibilityGeometry {
  const viewerNode = tree.nodeOfPosition(viewerPositionId)
  if (scope.visibility === 'self') {
    return { nodeIds: new Set([viewerNode]), selfOnly: true }
  }
  // team/dept/bg/org:管辖子树 = 自身节点起全部后代(治理岗位);执行岗位 team 级 = 所属 team 节点
  const start = tree.isOrchestrator(viewerPositionId) ? viewerNode : tree.nodeOfPosition(viewerPositionId)
  return { nodeIds: new Set(tree.subtree(start)), selfOnly: false }
}

/** 任务板条目投影输入(与 TaskBoard 解耦的最小形状;TaskItem 天然兼容) */
export interface ProjectableTask {
  id: string
  teamId: string
  assignee: string
  createdBy?: string
  /** 人类成员任务的汇报正文等详情(仅授权者可读,T10) */
  detail?: Record<string, unknown>
}

export interface TaskProjection {
  /** 全部调用方可读字段 */
  meta: Record<string, unknown>
  /** 授权下钻时才附带详情(人类隐私,T10) */
  detail?: Record<string, unknown>
  /** 为什么被过滤(可观测/审计) */
  filtered?: string
}

export interface ProjectContext {
  tree: OrgTree
  /** 调用方岗位 id */
  viewerPositionId: string
  roles?: TeamConfig['roles']
}

/**
 * 任务板投影:按 visibility scope 过滤;T10 人类隐私裁剪。
 * viewer 与 assignee 同级(同 team 非上级)且 viewer 为 agent、assignee 为 human 时,只给 meta。
 */
export function projectTasks(tasks: ProjectableTask[], ctx: ProjectContext): TaskProjection[] {
  const viewer = ctx.tree.position(ctx.viewerPositionId)
  const scope = roleScope(ctx.tree, ctx.viewerPositionId, ctx.roles)
  const geo = visibilityGeometry(ctx.tree, ctx.viewerPositionId, scope)
  const viewerNode = ctx.tree.nodeOfPosition(ctx.viewerPositionId)
  const viewerIsAgent = viewer.occupant.kind === 'agent'

  const out: TaskProjection[] = []
  for (const task of tasks) {
    const teamInScope = geo.nodeIds.has(task.teamId)
    const related = task.assignee === ctx.viewerPositionId || task.createdBy === ctx.viewerPositionId
    if (geo.selfOnly) {
      if (!related) continue
    } else if (!teamInScope) {
      continue
    }
    // T10:人类任务隐私 —— 同级 agent 只见元数据,详情需上级授权(上级 orchestrator 可下钻)
    const assigneePos = ctx.tree.hasPosition(task.assignee) ? ctx.tree.position(task.assignee) : undefined
    const assigneeIsHuman = assigneePos?.occupant.kind === 'human'
    const assigneeNode = assigneePos !== undefined ? ctx.tree.nodeOfPosition(task.assignee) : undefined
    // 上级 = 管辖节点严格包含 assignee 节点(同 team 同级不算上级)
    const isSuperior = assigneeNode !== undefined && assigneeNode !== viewerNode && ctx.tree.isAncestor(viewerNode, assigneeNode)
    const hideDetail = viewerIsAgent && assigneeIsHuman && !isSuperior
    const { detail, ...meta } = task
    if (hideDetail) {
      out.push({ meta, filtered: 'human-privacy:同级 agent 不可见人类成员任务详情(T10)' })
    } else if (detail !== undefined) {
      out.push({ meta, detail })
    } else {
      out.push({ meta })
    }
  }
  return out
}

/** 邮件投影输入(与 Mailbox 解耦;MailItem 天然兼容) */
export interface ProjectableMail {
  id: string
  from: string
  to: string | { broadcast: true; scope: 'team' | 'org' }
  /** 私人正文等详情(默认不投影进输出,T10) */
  detail?: Record<string, unknown>
}

export interface MailProjection {
  item: Record<string, unknown>
  filtered?: string
}

/**
 * 邮件投影:
 * - self:只给 from/to 含调用方的邮件;
 * - team 及以上:管辖子树内成员的邮件(to/from 属于子树岗位);
 * - broadcast:按订阅 scope 白名单(subscription 含对应层级才可见)。
 */
export function projectMail(items: ProjectableMail[], ctx: ProjectContext): MailProjection[] {
  const scope = roleScope(ctx.tree, ctx.viewerPositionId, ctx.roles)
  const geo = visibilityGeometry(ctx.tree, ctx.viewerPositionId, scope)
  const out: MailProjection[] = []
  for (const item of items) {
    if (typeof item.to === 'string') {
      const toInScope = geo.nodeIds.has(ctx.tree.nodeOfPosition(item.to))
      const fromInScope = geo.nodeIds.has(ctx.tree.nodeOfPosition(item.from))
      const related = item.to === ctx.viewerPositionId || item.from === ctx.viewerPositionId
      if (geo.selfOnly) {
        if (!related) continue
      } else if (!toInScope && !fromInScope) {
        continue
      }
      // T10 延伸:agent 同级不可见 human 私人邮件正文(正文属 detail 类字段,由上层裁剪)
      const { detail, ...meta } = item
      void detail
      out.push({ item: meta })
    } else {
      // broadcast:按 subscription scope 过滤(team 广播 → 同 team;org 广播 → 需订阅 org)
      const bcast = item.to
      const subscribed = bcast.scope === 'team'
        ? scope.subscription.includes('team')
        : scope.subscription.includes('org')
      if (subscribed) {
        const { detail, ...meta } = item
        void detail
        out.push({ item: meta })
      }
    }
  }
  return out
}

/** 委派视图投影(§4.8/FR-R3):visibility=self 时只给与调用方相关的委派 */
export function projectDelegations<T extends { fromPositionId: string; toPositionId: string }>(delegations: T[], ctx: ProjectContext): T[] {
  const scope = roleScope(ctx.tree, ctx.viewerPositionId, ctx.roles)
  const geo = visibilityGeometry(ctx.tree, ctx.viewerPositionId, scope)
  if (geo.selfOnly) {
    return delegations.filter((d) => d.fromPositionId === ctx.viewerPositionId || d.toPositionId === ctx.viewerPositionId)
  }
  return delegations.filter((d) => {
    const fromNode = ctx.tree.hasPosition(d.fromPositionId) ? ctx.tree.nodeOfPosition(d.fromPositionId) : undefined
    const toNode = ctx.tree.hasPosition(d.toPositionId) ? ctx.tree.nodeOfPosition(d.toPositionId) : undefined
    return (fromNode !== undefined && geo.nodeIds.has(fromNode)) || (toNode !== undefined && geo.nodeIds.has(toNode))
  })
}

/** 记忆投影输入(与 MemoryStore 解耦;MemoryEntry 天然兼容) */
export interface ProjectableMemory {
  level: 'team' | 'org'
  teamId?: string
}

/**
 * 记忆流投影(技术设计 §4.6.3;FR-M1):
 * - org 层:'org' ∈ memory 才可见(org 汇总只读,BG 间默认隔离);
 * - team 层:'team' ∈ memory 且条目 teamId 在管辖子树内
 *   (self 可见范围即本 team;治理岗位可见管辖子树内全部 team 记忆);
 * - private 层不在团队库(成员 session 历史,永不复制)。
 * 过滤是强制机制:工具只拿得到 scope 内的记忆。
 */
export function projectMemory<T extends ProjectableMemory>(entries: T[], ctx: ProjectContext): T[] {
  const scope = roleScope(ctx.tree, ctx.viewerPositionId, ctx.roles)
  const geo = visibilityGeometry(ctx.tree, ctx.viewerPositionId, scope)
  return entries.filter((e) => {
    if (e.level === 'org') return scope.memory.includes('org')
    if (e.level !== 'team') return false
    if (!scope.memory.includes('team')) return false
    if (typeof e.teamId !== 'string' || !geo.nodeIds.has(e.teamId)) return false
    return true
  })
}
