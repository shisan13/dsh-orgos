/**
 * TeamConfig —— team.yml 声明式配置的解析与校验(技术设计 §4.1 / §8.1;FR-X5)
 *
 * 校验范围:结构(org/nodes/positions 形状)、连通(树/环)、引用完整性
 * (orchestratorPosition/teamId/routes/acl 目标存在)、ACL 有效性。
 * 错误输出为 ValidationIssue[] 列表,带可执行的 fix 建议(友好可修复)。
 *
 * 本模块不做 IO:输入为 yaml 文本,输出为 TeamConfig 或问题列表;
 * 原子替换+备份+回滚的安全写入流程见 tools/team_setup(纯策略)与 Pro 阶段绑定层。
 */
import { parse as parseYaml, YAMLParseError } from 'yaml'
import type { AclConfig, MailScope, NodeDef, PositionDef, RouteRule, TeamConfig, ValidationIssue } from '../types.ts'
import { OrgTree, OrgTreeError } from '../org/OrgTree.ts'

/** 治理节点类型集合(children 只允许治理节点) */
const NODE_KINDS = new Set(['org', 'bg', 'dept', 'team'])
/** 五维 scope 的可见层级枚举(用于 roles 覆盖校验) */
const SCOPE_LEVELS = new Set(['self', 'team', 'dept', 'bg', 'org'])
/** memory scope 额外允许 private(私有记忆,FR-M1) */
const MEMORY_LEVELS = new Set(['private', 'team', 'dept', 'bg', 'org'])
const MAIL_SCOPES = new Set(['task', 'note', 'result', 'escalation'])

export type ParseResult =
  | { ok: true; config: TeamConfig }
  | { ok: false; issues: ValidationIssue[] }

/**
 * 解析 team.yml 文本。语法错误 → 单条 issue;结构错误 → 逐条 issue。
 * 校验失败时不抛出,统一走 issues(工具层可直接渲染为用户可读输出)。
 */
export function parseTeamConfig(text: string): ParseResult {
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (err) {
    const detail = err instanceof YAMLParseError ? err.message : String(err)
    return {
      ok: false,
      issues: [{ path: '$', message: `YAML 语法错误:${detail}`, fix: '修正 YAML 语法后重试(缩进/引号/冒号空格)' }],
    }
  }
  return validateRawConfig(raw)
}

/** 对象形状校验(把 unknown 逐步收窄到 TeamConfig,并收集问题) */
function validateRawConfig(raw: unknown): ParseResult {
  const issues: ValidationIssue[] = []
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      issues: [{ path: '$', message: 'team.yml 顶层必须是对象', fix: '以 org/nodes/positions/routes/acl 字段组织配置' }],
    }
  }
  const cfg = raw as Record<string, unknown>

  const org = cfg.org
  if (typeof org !== 'string' || org.length === 0) {
    issues.push({ path: 'org', message: '缺少 org(集团根节点 id)', fix: '填写集团根节点 id,如 org: acme' })
  }

  const nodes = readPositionalList(cfg.nodes, 'nodes', issues)
  const positions = readPositionalList(cfg.positions, 'positions', issues)

  // 基础形状校验(类型错误直接算问题,不再继续深入)
  const nodeDefs: NodeDef[] = []
  for (const [i, n] of nodes.entries()) {
    if (typeof n !== 'object' || n === null) {
      issues.push({ path: `nodes[${i}]`, message: '节点必须是对象', fix: '补齐 id/kind/children 字段' })
      continue
    }
    const node = n as Record<string, unknown>
    const id = typeof node.id === 'string' ? node.id : ''
    if (!id) {
      issues.push({ path: `nodes[${i}].id`, message: '节点缺少 id', fix: '每个节点必须有唯一 id' })
    }
    const kind = node.kind
    if (typeof kind !== 'string' || !NODE_KINDS.has(kind)) {
      issues.push({ path: `nodes[${i}].kind`, message: `节点 ${id || i} 的 kind 必须是 org/bg/dept/team 之一`, fix: '修正 kind 字段' })
    }
    if (node.children !== undefined && !Array.isArray(node.children)) {
      issues.push({ path: `nodes[${i}].children`, message: `节点 ${id || i} 的 children 必须是数组`, fix: 'children: [] 或省略' })
    }
    nodeDefs.push({
      id,
      kind: kind as NodeDef['kind'],
      title: typeof node.title === 'string' ? node.title : undefined,
      orchestratorPosition: typeof node.orchestratorPosition === 'string' ? node.orchestratorPosition : undefined,
      children: Array.isArray(node.children) ? (node.children as unknown[]).filter((c): c is string => typeof c === 'string') : [],
    })
  }

  const positionDefs: PositionDef[] = []
  for (const [i, p] of positions.entries()) {
    if (typeof p !== 'object' || p === null) {
      issues.push({ path: `positions[${i}]`, message: '岗位必须是对象', fix: '补齐 id/title/occupant 字段' })
      continue
    }
    const position = p as Record<string, unknown>
    const id = typeof position.id === 'string' ? position.id : ''
    if (!id) {
      issues.push({ path: `positions[${i}].id`, message: '岗位缺少 id', fix: '每个岗位必须有唯一 id' })
    }
    const occupant = position.occupant
    if (typeof occupant !== 'object' || occupant === null || (occupant as Record<string, unknown>).kind === undefined) {
      issues.push({ path: `positions[${i}].occupant`, message: `岗位 ${id || i} 缺少 occupant.kind`, fix: 'occupant: { kind: agent, preset: orgos-coder } 或 { kind: human, im: {...} }' })
    }
    positionDefs.push({
      id,
      title: typeof position.title === 'string' ? position.title : '',
      teamId: typeof position.teamId === 'string' ? position.teamId : undefined,
      restricted: position.restricted === true,
      capabilityProfile: Array.isArray(position.capabilityProfile) ? (position.capabilityProfile as unknown[]).filter((c): c is string => typeof c === 'string') : undefined,
      occupant: {
        kind: (occupant as Record<string, unknown> | null)?.kind === 'human' ? 'human' : 'agent',
        preset: typeof (occupant as Record<string, unknown> | null)?.preset === 'string' ? (occupant as Record<string, unknown>).preset as string : undefined,
        im: typeof (occupant as Record<string, unknown> | null)?.im === 'object' ? (occupant as Record<string, unknown>).im as PositionDef['occupant']['im'] : undefined,
      },
      handover: typeof position.handover === 'object' && position.handover !== null ? position.handover as PositionDef['handover'] : undefined,
    })
  }

  // 引用完整性 + 树结构:交给 OrgTree 构造做几何校验,把异常转成 issue
  if (nodeDefs.length > 0 || typeof org === 'string') {
    const treeIssues = tryOrgTree(org as string, nodeDefs, positionDefs)
    issues.push(...treeIssues)
  }

  // org 根节点必须实际存在(防"只声明 org 却没有树"的空配置)
  if (typeof org === 'string' && org.length > 0 && !nodeDefs.some((n) => n.id === org)) {
    issues.push({ path: 'org', message: `org 根节点 ${org} 不在 nodes 中`, fix: `nodes 中必须包含 id=${org} 的根节点(及其 orchestratorPosition)` })
  }

  // 唯一性校验(节点/岗位 id 重复;YAML 对象天然不允许,但数组允许)
  const seenNodes = new Set<string>()
  for (const [i, n] of nodeDefs.entries()) {
    if (n.id && seenNodes.has(n.id)) issues.push({ path: `nodes[${i}].id`, message: `节点 id 重复:${n.id}`, fix: '改为唯一 id' })
    seenNodes.add(n.id)
  }
  const seenPositions = new Set<string>()
  for (const [i, p] of positionDefs.entries()) {
    if (p.id && seenPositions.has(p.id)) issues.push({ path: `positions[${i}].id`, message: `岗位 id 重复:${p.id}`, fix: '改为唯一 id' })
    seenPositions.add(p.id)
  }

  const routes = readPositionalList(cfg.routes, 'routes', issues)
  const routeRules: RouteRule[] = []
  for (const [i, r] of routes.entries()) {
    if (typeof r !== 'object' || r === null) {
      issues.push({ path: `routes[${i}]`, message: '路由规则必须是对象', fix: '补齐 channel/peerId/target 字段' })
      continue
    }
    const rule = r as Record<string, unknown>
    const channel = typeof rule.channel === 'string' ? rule.channel : ''
    const peerId = typeof rule.peerId === 'string' ? rule.peerId : ''
    const target = typeof rule.target === 'string' ? rule.target : ''
    if (!channel || !peerId || !target) {
      issues.push({ path: `routes[${i}]`, message: '路由规则缺少 channel/peerId/target', fix: '如 { channel: feishu, peerId: oc_xxx, target: coder-1 }' })
    }
    if (target && !seenNodes.has(target) && !seenPositions.has(target)) {
      issues.push({ path: `routes[${i}].target`, message: `路由目标不存在:${target}`, fix: 'target 必须是 nodes 或 positions 中存在的 id' })
    }
    routeRules.push({ channel, peerId, target })
  }

  const acl = validateAcl(cfg.acl, seenNodes, seenPositions, issues)

  const roles = validateRoles(cfg.roles, issues)

  const fixed: TeamConfig = {
    org: typeof org === 'string' ? org : '',
    nodes: nodeDefs,
    positions: positionDefs,
    routes: routeRules,
    acl,
    roles,
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, config: fixed }
}

/** 用 OrgTree 构造做树几何校验,异常转 issue(不影响后续引用校验继续) */
function tryOrgTree(org: string, nodes: NodeDef[], positions: PositionDef[]): ValidationIssue[] {
  if (!org || nodes.length === 0) return []
  try {
    new OrgTree({ org, nodes, positions })
    return []
  } catch (err) {
    if (err instanceof OrgTreeError) {
      return [{ path: 'nodes', message: err.message, fix: '按消息修正节点/岗位引用' }]
    }
    return [{ path: 'nodes', message: `组织树校验异常:${String(err)}`, fix: '检查 nodes/positions 字段类型' }]
  }
}

/** ACL 校验:引用存在 + 字段形状;判定语义由 AclPolicy 负责 */
function validateAcl(raw: unknown, nodeIds: Set<string>, positionIds: Set<string>, issues: ValidationIssue[]): AclConfig {
  const acl: AclConfig = {}
  if (raw === undefined || raw === null) return acl
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ path: 'acl', message: 'acl 必须是对象', fix: '省略 acl 或使用 allowCrossTeam/block/delegationDepthMax/memberConcurrencyMax 字段' })
    return acl
  }
  const cfg = raw as Record<string, unknown>

  const cross = readPositionalList(cfg.allowCrossTeam, 'acl.allowCrossTeam', issues)
  const crossRules = []
  for (const [i, r] of cross.entries()) {
    if (typeof r !== 'object' || r === null) {
      issues.push({ path: `acl.allowCrossTeam[${i}]`, message: '跨 team 规则必须是对象', fix: '补齐 from/to/scopes 字段' })
      continue
    }
    const rule = r as Record<string, unknown>
    const from = typeof rule.from === 'string' ? rule.from : ''
    const to = typeof rule.to === 'string' ? rule.to : ''
    const scopes = Array.isArray(rule.scopes) ? (rule.scopes as unknown[]).filter((s): s is MailScope => typeof s === 'string' && MAIL_SCOPES.has(s)) : []
    for (const s of Array.isArray(rule.scopes) ? (rule.scopes as unknown[]) : []) {
      if (typeof s !== 'string' || !MAIL_SCOPES.has(s)) {
        issues.push({ path: `acl.allowCrossTeam[${i}].scopes`, message: `非法协作类型:${String(s)}`, fix: `scopes 取值:${[...MAIL_SCOPES].join('/')}` })
      }
    }
    if (from && !nodeIds.has(from)) issues.push({ path: `acl.allowCrossTeam[${i}].from`, message: `不存在的 team:${from}`, fix: 'from 必须是 team 节点 id' })
    if (to && !nodeIds.has(to)) issues.push({ path: `acl.allowCrossTeam[${i}].to`, message: `不存在的 team:${to}`, fix: 'to 必须是 team 节点 id' })
    crossRules.push({ from, to, scopes })
  }
  if (crossRules.length > 0) acl.allowCrossTeam = crossRules

  const block = readPositionalList(cfg.block, 'acl.block', issues)
  const blockRules = []
  for (const [i, r] of block.entries()) {
    if (typeof r !== 'object' || r === null) {
      issues.push({ path: `acl.block[${i}]`, message: '阻断规则必须是对象', fix: '补齐 to 字段' })
      continue
    }
    const rule = r as Record<string, unknown>
    const to = typeof rule.to === 'string' ? rule.to : ''
    if (to && !nodeIds.has(to) && !positionIds.has(to)) {
      issues.push({ path: `acl.block[${i}].to`, message: `阻断目标不存在:${to}`, fix: 'to 必须是 team 节点 id 或岗位 id' })
    }
    blockRules.push({ to })
  }
  if (blockRules.length > 0) acl.block = blockRules

  if (cfg.delegationDepthMax !== undefined && (typeof cfg.delegationDepthMax !== 'number' || cfg.delegationDepthMax < 1)) {
    issues.push({ path: 'acl.delegationDepthMax', message: 'delegationDepthMax 必须是 ≥1 的整数', fix: '如 delegationDepthMax: 3' })
  } else if (typeof cfg.delegationDepthMax === 'number') {
    acl.delegationDepthMax = cfg.delegationDepthMax
  }
  if (cfg.memberConcurrencyMax !== undefined && (typeof cfg.memberConcurrencyMax !== 'number' || cfg.memberConcurrencyMax < 1)) {
    issues.push({ path: 'acl.memberConcurrencyMax', message: 'memberConcurrencyMax 必须是 ≥1 的整数', fix: '如 memberConcurrencyMax: 2' })
  } else if (typeof cfg.memberConcurrencyMax === 'number') {
    acl.memberConcurrencyMax = cfg.memberConcurrencyMax
  }
  return acl
}

/** roles 覆盖校验:五维 scope 的取值枚举 */
function validateRoles(raw: unknown, issues: ValidationIssue[]): TeamConfig['roles'] {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ path: 'roles', message: 'roles 必须是对象', fix: '省略 roles 或使用 { roleId: { visibility, authority, memory, subscription } }' })
    return undefined
  }
  const out: TeamConfig['roles'] = {}
  for (const [roleId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) {
      issues.push({ path: `roles.${roleId}`, message: '角色默认值必须是对象', fix: '省略或补齐五维字段' })
      continue
    }
    const v = value as Record<string, unknown>
    const bad = (field: string, allowed: Set<string>): boolean =>
      v[field] !== undefined && !(typeof v[field] === 'string' && allowed.has(v[field]))
    if (bad('visibility', SCOPE_LEVELS)) issues.push({ path: `roles.${roleId}.visibility`, message: `非法 visibility:${String(v.visibility)}`, fix: `取值:${[...SCOPE_LEVELS].join('/')}` })
    if (bad('authority', SCOPE_LEVELS)) issues.push({ path: `roles.${roleId}.authority`, message: `非法 authority:${String(v.authority)}`, fix: `取值:${[...SCOPE_LEVELS].join('/')}` })
    for (const f of ['memory', 'subscription'] as const) {
      const allowed = f === 'memory' ? MEMORY_LEVELS : SCOPE_LEVELS
      const arr = v[f]
      if (arr !== undefined && (!Array.isArray(arr) || arr.some((x) => typeof x !== 'string' || !allowed.has(x)))) {
        issues.push({ path: `roles.${roleId}.${f}`, message: `非法 ${f}:${String(arr)}`, fix: `取值数组:${[...allowed].join('/')}` })
      }
    }
    out[roleId] = {
      visibility: v.visibility as never,
      authority: v.authority as never,
      memory: (v.memory as never[] | undefined) ?? [],
      subscription: (v.subscription as never[] | undefined) ?? [],
    }
  }
  return out
}

/** 读取数组字段,非数组时报 issue(返回空数组继续) */
function readPositionalList(raw: unknown, path: string, issues: ValidationIssue[]): unknown[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    issues.push({ path, message: `${path} 必须是数组`, fix: `如 ${path}: [...]` })
    return []
  }
  return raw
}

/** 直接对已构造对象做校验(供 team_setup 等工具对"已解析配置"二次把关) */
export function validateTeamConfig(config: TeamConfig): ValidationIssue[] {
  const result = validateRawConfig(JSON.parse(JSON.stringify(config)))
  return result.ok ? [] : result.issues
}
