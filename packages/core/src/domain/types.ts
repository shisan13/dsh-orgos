/**
 * dsh-orgos core 领域类型(纯领域内核,harness-agnostic,零 DSH import)
 *
 * 对应技术设计 §4 概念模型:组织树(§4.1)、Position/Occupant(§4.2)、
 * 六条信息流与五维 scope(§4.6)、ACL(安全设计 §4.2)。
 */

/** 治理层节点类型:org/bg/dept/team(技术设计 §4.1) */
export type NodeKind = 'org' | 'bg' | 'dept' | 'team'

/** 占位者类型:agent(角色 preset + 常驻 session)或 human(IM 身份绑定) */
export type OccupantKind = 'agent' | 'human'

/** 成员状态(agent 由 agent/status 推导;human 由 IM 在线状态推导) */
export type MemberStatus = 'offline' | 'idle' | 'busy' | 'failed'

/** 协作流可承载的内容类型(安全设计 §4.2 scopes) */
export type MailScope = 'task' | 'note' | 'result' | 'escalation'

/** 人类成员 / agent 的 IM 身份绑定 */
export interface ImIdentity {
  channel: string
  userId: string
}

/**
 * 占位者(Occupant,技术设计 §4.2):岗位的当前在岗者。
 * 人机同构核心:kind 换成 human 即"任意一级任意节点都可能是人"。
 */
export interface Occupant {
  kind: OccupantKind
  /** agent 专用:角色 preset id(如 orgos-coder) */
  preset?: string
  /** human 专用:IM 身份绑定 */
  im?: ImIdentity
}

/** 替换时的交接策略(FR-H5,技术设计 §4.7.3) */
export interface HandoverPolicy {
  /** 知识提炼写入哪层记忆 */
  inheritMemory: 'private' | 'team' | 'org'
  /** 进行中任务处理 */
  reassignOpenTasks: 'transfer' | 'keep' | 'cancel'
}

/**
 * 岗位(Position,组织树稳定叶子):id/标题/层级/能力档案随岗位延续,
 * 占位者替换即替代演进(ADR-004)。
 */
export interface PositionDef {
  id: string
  title: string
  /** 执行岗位所属 team 节点 id(治理岗位不设,由节点 orchestratorPosition 反向关联) */
  teamId?: string
  /** shared/guest 等受限岗位(安全设计 §4.2:协作排除) */
  restricted?: boolean
  /** 能力档案:人与 agent 同构,参与路由/自动派发匹配(PRD FR-H3) */
  capabilityProfile?: string[]
  occupant: Occupant
  handover?: HandoverPolicy
}

/** 治理层节点定义(org/bg/dept/team) */
export interface NodeDef {
  id: string
  kind: NodeKind
  title?: string
  /** 本层 orchestrator 岗位 id(可选;有 orchestrator 的层才接受委派) */
  orchestratorPosition?: string
  children: string[]
}

/** 路由规则:(channel, peerId) → 岗位或治理节点(技术设计 §6) */
export interface RouteRule {
  channel: string
  peerId: string
  /** 目标:positionId 或节点 id */
  target: string
}

/** ACL 跨 team 直通声明(安全设计 §4.2) */
export interface AllowCrossTeamRule {
  from: string
  to: string
  scopes: MailScope[]
}

/** ACL 阻断规则(to 可为 team 节点 id 或 positionId) */
export interface BlockRule {
  to: string
}

/** 团队级 ACL 配置(安全设计 §4.2;判定顺序 block → allowCrossTeam → 同 team → deny) */
export interface AclConfig {
  allowCrossTeam?: AllowCrossTeamRule[]
  block?: BlockRule[]
  /** 委派深度上限,沿组织树计,默认 3(T8) */
  delegationDepthMax?: number
  /** 每成员并发派发上限,默认 2(T8) */
  memberConcurrencyMax?: number
}

/** 结构化 Brief V1(技术设计 §10.1;FR-D2,字段校验缺字段拒绝派发) */
export interface BriefV1 {
  /** 岗位 id(在岗者接单);或 'auto'(M2 演进点) */
  target: string
  /** 一句话任务 */
  task: string
  background?: string
  workingDirectory?: string
  /** 结构化需求 */
  requirements: string[]
  constraints?: string[]
  protectedFiles?: string[]
  /** 验收标准,成员须附验证输出 */
  acceptance: string[]
  /** 验收命令 */
  verification?: string
  timeoutMinutes?: number
}

/** 角色 scope 默认值(技术设计 §4.6.2 五维 scope) */
export interface RoleDefaults {
  /** 能看什么:自己相关 / 管辖子树全量 */
  visibility: 'self' | 'team' | 'dept' | 'bg' | 'org'
  /** 能做什么:委派目标 / 升级路径 / 配置变更 */
  authority: 'self' | 'team' | 'dept' | 'bg' | 'org'
  /** 记什么:记忆可见范围(private/team/org…) */
  memory: ('private' | 'team' | 'dept' | 'bg' | 'org')[]
  /** 听什么:事件/通知订阅白名单 */
  subscription: ('self' | 'team' | 'dept' | 'bg' | 'org')[]
}

/**
 * team.yml 声明式主配置(技术设计 §4.1 / §8.1)。
 * 解析与校验见 config/TeamConfig.ts。
 */
export interface TeamConfig {
  org: string
  nodes: NodeDef[]
  positions: PositionDef[]
  routes: RouteRule[]
  acl: AclConfig
  /** 角色 scope 覆盖(可选;缺省按层级默认,见 scope/scopeDefaults) */
  roles?: Record<string, RoleDefaults>
}

/** 组织树校验问题(FR-X5:结构/连通/ACL/引用完整性,错误提示友好可修复) */
export interface ValidationIssue {
  path: string
  message: string
  /** 可执行的修复建议 */
  fix?: string
}
