/**
 * DelegationEngine —— 委派引擎(技术设计 §5.3 / §4.3;FR-D2~D5)
 *
 * 组合:OrgTree(管辖子树/深度)+ AclPolicy(委派 ACL)+ Brief 校验 + 状态机。
 * 全部校验在引擎内服务端强制,不依赖模型自觉。
 *
 * 错误码(工具层直接渲染):
 *   BRIEF_INVALID / TARGET_NOT_FOUND / AUTO_UNSUPPORTED / NOT_ORCHESTRATOR /
 *   OUT_OF_SUBTREE / DEPTH_EXCEEDED / CONCURRENCY_EXCEEDED / ACL_DENY /
 *   STATE_ILLEGAL / HUMAN_RETRY_UNSUPPORTED / AGENT_NUDGE_UNSUPPORTED /
 *   HUMAN_REASSIGN_UNSUPPORTED(agent 转交走 retry 语义)
 */
import { OrgTree } from '../org/OrgTree.ts'
import type { AclConfig, BriefV1 } from '../types.ts'
import { AclPolicy } from '../acl/AclPolicy.ts'
import { transition, validateBrief, type Delegation, type DelegationStatus, type BriefIssue } from './stateMachine.ts'

export type EngineErrorCode =
  | 'BRIEF_INVALID'
  | 'TARGET_NOT_FOUND'
  | 'AUTO_UNSUPPORTED'
  | 'NOT_ORCHESTRATOR'
  | 'OUT_OF_SUBTREE'
  | 'DEPTH_EXCEEDED'
  | 'CONCURRENCY_EXCEEDED'
  | 'ACL_DENY'
  | 'STATE_ILLEGAL'
  | 'HUMAN_RETRY_UNSUPPORTED'
  | 'AGENT_NUDGE_UNSUPPORTED'
  | 'AGENT_REASSIGN_UNSUPPORTED'
  | 'DELEGATION_NOT_FOUND'

export interface EngineError {
  code: EngineErrorCode
  message: string
  /** BRIEF_INVALID 时的字段级问题 */
  details?: BriefIssue[]
}

export type EngineResult<T> = { ok: true; value: T } | { ok: false; error: EngineError }

export interface EngineOptions {
  /** 重派次数上限(默认 3,openclaw 铁律 ≤3) */
  maxAttempts?: number
  /** 时钟注入(测试用) */
  now?: () => number
  /** id 生成(默认 dlg-<自增>) */
  idFactory?: () => string
}

const ACTIVE: readonly DelegationStatus[] = ['queued', 'dispatched', 'running']

export class DelegationEngine {
  private readonly delegations = new Map<string, Delegation>()
  private readonly tree: OrgTree
  private readonly acl: AclPolicy
  private readonly maxAttempts: number
  private readonly now: () => number
  private readonly idFactory: () => string
  private seq = 0

  constructor(tree: OrgTree, aclConfig: AclConfig, opts?: EngineOptions) {
    this.tree = tree
    this.acl = new AclPolicy(aclConfig, tree)
    this.maxAttempts = opts?.maxAttempts ?? 3
    this.now = opts?.now ?? Date.now
    this.idFactory = opts?.idFactory ?? (() => `dlg-${++this.seq}`)
  }

  /**
   * 派发(FR-D3):校验 → 登记 → dispatched(投递动作由 Pro 绑定层执行)。
   * fromPositionId 必须是治理岗位(orchestrator);target 必须在其管辖子树。
   */
  delegate(fromPositionId: string, brief: BriefV1): EngineResult<Delegation> {
    const briefIssues = validateBrief(brief)
    if (briefIssues.length > 0) {
      return { ok: false, error: { code: 'BRIEF_INVALID', message: 'brief 字段校验失败', details: briefIssues } }
    }
    const target = brief.target
    if (!this.tree.hasPosition(fromPositionId)) {
      return { ok: false, error: { code: 'NOT_ORCHESTRATOR', message: `派发方岗位不存在:${fromPositionId}` } }
    }
    if (!this.tree.isOrchestrator(fromPositionId)) {
      return { ok: false, error: { code: 'NOT_ORCHESTRATOR', message: `只有 orchestrator 岗位可以派发:${fromPositionId}` } }
    }
    if (target === 'auto') {
      return { ok: false, error: { code: 'AUTO_UNSUPPORTED', message: 'target=auto(按能力档案自动选岗)为 M2 演进点,当前请显式指定岗位 id' } }
    }
    if (!this.tree.hasPosition(target)) {
      return { ok: false, error: { code: 'TARGET_NOT_FOUND', message: `目标岗位不存在:${target}` } }
    }
    if (target === fromPositionId) {
      return { ok: false, error: { code: 'OUT_OF_SUBTREE', message: '不能派发给自己' } }
    }

    // authority:目标必须在派发方管辖子树内(技术设计 §4.6.2;§6 不可跳级)
    const fromNode = this.tree.nodeOfPosition(fromPositionId)
    const toNode = this.tree.nodeOfPosition(target)
    if (!this.tree.isAncestor(fromNode, toNode)) {
      return { ok: false, error: { code: 'OUT_OF_SUBTREE', message: `目标岗位 ${target} 不在 ${fromPositionId} 管辖子树内` } }
    }
    // T8:委派深度上限(沿组织树计,默认 3)
    const depthDiff = this.tree.depth(toNode) - this.tree.depth(fromNode)
    if (depthDiff > this.acl.delegationDepthMax()) {
      return { ok: false, error: { code: 'DEPTH_EXCEEDED', message: `委派深度 ${depthDiff} 超过上限 ${this.acl.delegationDepthMax()}`, } }
    }
    // ACL:block/restricted 拒绝
    const gate = this.acl.canDelegate(fromPositionId, target)
    if (!gate.allowed) {
      return { ok: false, error: { code: 'ACL_DENY', message: gate.reason ?? 'ACL 拒绝', } }
    }
    // T8:并发上限
    const activeCount = this.activeDelegationsOf(target)
    if (activeCount >= this.acl.memberConcurrencyMax()) {
      return { ok: false, error: { code: 'CONCURRENCY_EXCEEDED', message: `岗位 ${target} 已有 ${activeCount} 条进行中委派,超过并发上限 ${this.acl.memberConcurrencyMax()}`, } }
    }

    const at = this.now()
    const id = this.idFactory()
    const delegation: Delegation = {
      id,
      fromNodeId: fromNode,
      fromPositionId,
      toPositionId: target,
      toOccupantKind: this.tree.occupantKind(target),
      brief: { ...brief },
      briefVersion: 1,
      attempt: 0,
      status: 'queued',
      timeline: [{ at, type: 'delegate', by: fromPositionId }],
      createdAt: at,
      updatedAt: at,
    }
    const dispatched = transition(delegation, 'dispatch', at, { by: fromPositionId, note: '投递到成员 inbox/任务卡片' })
    this.delegations.set(id, dispatched)
    return { ok: true, value: dispatched }
  }

  /** 完成/失败回执(FR-D4):settle 携带报告;失败自动走重派/升级判定 */
  settle(id: string, outcome: 'completed' | 'failed', report: string, by?: string): EngineResult<Delegation> {
    const d = this.delegations.get(id)
    if (!d) return this.notFound()
    if (typeof report !== 'string' || report.trim().length === 0) {
      return { ok: false, error: { code: 'STATE_ILLEGAL', message: '回执必须携带报告正文' } }
    }
    const at = this.now()
    try {
      if (outcome === 'completed') {
        // 回执隐含认领:dispatched → running → completed(成员完成时直接回执)
        const base = d.status === 'dispatched' ? transition(d, 'claim', at, { by, note: '回执前隐含认领' }) : d
        const next = transition(base, 'complete', at, { by, report })
        this.delegations.set(id, next)
        return { ok: true, value: next }
      }
      // failed:重派次数判定(同样容忍 dispatched 直接失败)
      const base = d.status === 'dispatched' ? transition(d, 'claim', at, { by, note: '失败前隐含认领' }) : d
      const failed = transition(base, 'fail', at, { by, report, note: '成员报告失败' })
      if (failed.attempt >= this.maxAttempts) {
        const final = transition(failed, 'escalate', at, {
          by: 'system',
          note: `重派 ${this.maxAttempts} 次仍失败,升级上层 orchestrator`,
          escalationToNodeId: this.escalationTarget(failed.fromNodeId),
        })
        this.delegations.set(id, final)
        return { ok: true, value: final }
      }
      this.delegations.set(id, failed)
      return { ok: true, value: failed }
    } catch (err) {
      return { ok: false, error: this.stateError(err) }
    }
  }

  /**
   * 重派(agent 语义):诊断 → 优化 brief → 重派 ≤3 次(openclaw 铁律)。
   * 仅 agent 岗位;仅 failed 状态;briefNext 版本 +1。
   */
  retry(id: string, briefNext: BriefV1, by?: string): EngineResult<Delegation> {
    const d = this.delegations.get(id)
    if (!d) return this.notFound()
    if (d.toOccupantKind === 'human') {
      return { ok: false, error: { code: 'HUMAN_RETRY_UNSUPPORTED', message: '人类成员走催办→升级→转交,不适用改 brief 重派(FR-H7)' } }
    }
    const briefIssues = validateBrief(briefNext)
    if (briefIssues.length > 0) {
      return { ok: false, error: { code: 'BRIEF_INVALID', message: '重派 brief 字段校验失败', details: briefIssues } }
    }
    try {
      const at = this.now()
      const next = transition(d, 'retry', at, {
        by,
        note: '诊断后优化 brief 重派',
        brief: { ...briefNext },
        briefVersion: d.briefVersion + 1,
        attempt: d.attempt + 1,
      })
      this.delegations.set(id, next)
      return { ok: true, value: next }
    } catch (err) {
      return { ok: false, error: this.stateError(err) }
    }
  }

  /** 催办(human 语义 §4.7.2):不改状态,仅时间线记录 */
  nudge(id: string, by?: string): EngineResult<Delegation> {
    const d = this.delegations.get(id)
    if (!d) return this.notFound()
    if (d.toOccupantKind === 'agent') {
      return { ok: false, error: { code: 'AGENT_NUDGE_UNSUPPORTED', message: 'agent 成员不适用催办,走诊断重派' } }
    }
    if (d.status !== 'running' && d.status !== 'dispatched') {
      return { ok: false, error: { code: 'STATE_ILLEGAL', message: `仅运行中的委派可催办(当前 ${d.status})` } }
    }
    const at = this.now()
    const next: Delegation = { ...d, timeline: [...d.timeline, { at, type: 'nudge', by, note: '催办(含剩余时限)' }], updatedAt: at }
    this.delegations.set(id, next)
    return { ok: true, value: next }
  }

  /** 转交(human 语义 §4.7.2):换目标岗位,附上下文;仅 human 岗位 */
  reassign(id: string, positionNext: string, by?: string): EngineResult<Delegation> {
    const d = this.delegations.get(id)
    if (!d) return this.notFound()
    if (d.toOccupantKind === 'agent') {
      return { ok: false, error: { code: 'AGENT_REASSIGN_UNSUPPORTED', message: 'agent 成员不适用转交,走诊断重派' } }
    }
    if (!this.tree.hasPosition(positionNext)) {
      return { ok: false, error: { code: 'TARGET_NOT_FOUND', message: `转交目标岗位不存在:${positionNext}` } }
    }
    try {
      const at = this.now()
      const next = transition(d, 'reassign', at, {
        by,
        note: `转交至 ${positionNext}`,
        toPositionId: positionNext,
        toOccupantKind: this.tree.occupantKind(positionNext),
        reassignedToPositionId: positionNext,
      })
      this.delegations.set(id, next)
      return { ok: true, value: next }
    } catch (err) {
      return { ok: false, error: this.stateError(err) }
    }
  }

  /** 升级(显式):failed/failed-final/timeout 可升级;目标 = 父链最近 orchestrator */
  escalate(id: string, by?: string): EngineResult<Delegation> {
    const d = this.delegations.get(id)
    if (!d) return this.notFound()
    try {
      const at = this.now()
      const next = transition(d, 'escalate', at, { by, escalationToNodeId: this.escalationTarget(d.fromNodeId) })
      this.delegations.set(id, next)
      return { ok: true, value: next }
    } catch (err) {
      return { ok: false, error: this.stateError(err) }
    }
  }

  /** 取消 */
  cancel(id: string, by?: string): EngineResult<Delegation> {
    const d = this.delegations.get(id)
    if (!d) return this.notFound()
    try {
      const at = this.now()
      const next = transition(d, 'cancel', at, { by, note: '取消' })
      this.delegations.set(id, next)
      return { ok: true, value: next }
    } catch (err) {
      return { ok: false, error: this.stateError(err) }
    }
  }

  /**
   * 超时处理(§4.3 timeout → failed 路径):
   * agent → timeout → failed(attempt 已达上限则直接升级);human → 仅记录 timeout 事件(等待催办/升级决策)。
   */
  markTimeout(id: string): EngineResult<Delegation> {
    const d = this.delegations.get(id)
    if (!d) return this.notFound()
    const at = this.now()
    try {
      if (d.toOccupantKind === 'human') {
        const next: Delegation = { ...d, timeline: [...d.timeline, { at, type: 'timeout', note: '任务超时(human):等待催办/升级决策' }], updatedAt: at }
        this.delegations.set(id, next)
        return { ok: true, value: next }
      }
      const timed = transition(d, 'timeout', at, { by: 'system', note: '任务超时' })
      if (timed.attempt >= this.maxAttempts) {
        const final = transition(timed, 'escalate', at, { by: 'system', escalationToNodeId: this.escalationTarget(timed.fromNodeId) })
        this.delegations.set(id, final)
        return { ok: true, value: final }
      }
      const failed = transition(timed, 'fail', at, { by: 'system', note: '超时视为失败,供 orchestrator 重派' })
      this.delegations.set(id, failed)
      return { ok: true, value: failed }
    } catch (err) {
      return { ok: false, error: this.stateError(err) }
    }
  }

  /** 超时扫描(供 heartbeat 折叠):返回超时未决的委派 id 列表 */
  timeoutOverdue(now?: number): Delegation[] {
    const at = now ?? this.now()
    const out: Delegation[] = []
    for (const d of this.delegations.values()) {
      if (d.status !== 'running' && d.status !== 'dispatched') continue
      const limitMs = (d.brief.timeoutMinutes ?? 10) * 60_000
      if (at - d.updatedAt > limitMs) out.push(d)
    }
    return out
  }

  get(id: string): Delegation | undefined {
    return this.delegations.get(id)
  }

  /** 只读快照(按可见性由 ScopeProjection 过滤;此处返回全量副本) */
  snapshot(): Delegation[] {
    return [...this.delegations.values()].map((d) => structuredClone(d))
  }

  /** 岗位当前进行中(queued/dispatched/running)委派数 */
  activeDelegationsOf(positionId: string): number {
    let n = 0
    for (const d of this.delegations.values()) {
      if (d.toPositionId === positionId && ACTIVE.includes(d.status)) n += 1
    }
    return n
  }

  /** 升级目标:from 节点父链上最近一个有 orchestrator 的节点(不可跳级,§4.3) */
  private escalationTarget(fromNodeId: string): string | undefined {
    for (const ancestor of this.tree.pathToRoot(fromNodeId)) {
      if (this.tree.hasOrchestrator(ancestor)) return ancestor
    }
    return undefined
  }

  private notFound(): EngineResult<Delegation> {
    return { ok: false, error: { code: 'DELEGATION_NOT_FOUND', message: '委派不存在' } }
  }

  private stateError(err: unknown): EngineError {
    return {
      code: 'STATE_ILLEGAL',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}
