/**
 * 委派状态机(技术设计 §4.3;openclaw 调度哲学的机器化)
 *
 * ```
 * queued ──投递──▶ dispatched ──成员 inbox/任务卡片 claimed──▶ running
 * running ──成员完成──▶ completed
 * running ──成员报告失败──▶ failed
 * failed(agent)──诊断+改 brief(重派≤3次)──▶ dispatched(attempt+1)
 * failed(human)──催办→升级→转交──▶ reassigned / escalated
 * failed(attempt=max)──▶ failed-final ──▶ escalated(升级到上层 orchestrator)
 * 任意状态 ──取消/超时──▶ cancelled / timeout(→ failed 路径)
 * ```
 *
 * 本模块是纯状态转换函数(确定性、可测):不关心谁触发、不碰持久化,
 * 由 DelegationEngine 组合校验 + 事件。状态转换非法时抛 DelegationStateError。
 */
import type { BriefV1, OccupantKind } from '../types.ts'

export type DelegationStatus =
  | 'queued'
  | 'dispatched'
  | 'running'
  | 'completed'
  | 'failed'
  | 'failed-final'
  | 'escalated'
  | 'cancelled'
  | 'timeout'

/** 时间线上的一个事件(append-only,delegations.jsonl 的承载形态) */
export interface DelegationEvent {
  at: number
  type: string
  /** 触发者(岗位 id 或 'system') */
  by?: string
  note?: string
  /** 重派后的 brief 版本 */
  briefVersion?: number
}

export interface Delegation {
  id: string
  /** 派发方所在节点与岗位 */
  fromNodeId: string
  fromPositionId: string
  /** 委派目标岗位(在岗者接单) */
  toPositionId: string
  /** 实际接单占位者(claim 时确定;agent 为 preset 对应会话,human 为 IM 身份) */
  toOccupantKind: OccupantKind
  brief: BriefV1
  briefVersion: number
  attempt: number
  status: DelegationStatus
  timeline: DelegationEvent[]
  createdAt: number
  updatedAt: number
  /** 完成/失败报告 */
  report?: string
  /** 升级目标节点(不可跳级:父链最近 orchestrator 所在节点) */
  escalationToNodeId?: string
  /** 转交后的新目标岗位 */
  reassignedToPositionId?: string
  /** 失败/取消原因 */
  reason?: string
}

/** 允许的迁移表:状态 → 可接受的事件类型 → 下一状态 */
const TRANSITIONS: Record<DelegationStatus, Record<string, DelegationStatus>> = {
  queued: { dispatch: 'dispatched', cancel: 'cancelled' },
  dispatched: { claim: 'running', reassign: 'dispatched', cancel: 'cancelled', timeout: 'timeout' },
  running: { complete: 'completed', fail: 'failed', reassign: 'dispatched', timeout: 'timeout' },
  failed: { retry: 'dispatched', reassign: 'dispatched', escalate: 'escalated', cancel: 'cancelled' },
  'failed-final': { escalate: 'escalated' },
  completed: {},
  escalated: {},
  cancelled: {},
  timeout: { escalate: 'escalated', cancel: 'cancelled', fail: 'failed' },
}

/**
 * 状态机转换:返回新 Delegation(不可变:复制 + 追加时间线)。
 * patch 中的 by/note/briefVersion 进入时间线事件;其余字段(spread)应用到新状态。
 */
export function transition(
  d: Delegation,
  eventType: string,
  at: number,
  patch?: { by?: string; note?: string; briefVersion?: number } & Partial<Delegation>,
): Delegation {
  const allowed = TRANSITIONS[d.status]?.[eventType]
  if (allowed === undefined) {
    throw new DelegationStateError(`非法状态迁移:${d.status} --${eventType}--> ?`)
  }
  const event: DelegationEvent = {
    at,
    type: eventType,
    by: patch?.by,
    note: patch?.note,
    briefVersion: patch?.briefVersion,
  }
  const next: Delegation = {
    ...d,
    ...patch,
    status: allowed,
    timeline: [...d.timeline, event],
    updatedAt: at,
  }
  return next
}

export class DelegationStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DelegationStateError'
  }
}

/** Brief V1 校验(技术设计 §10.1;FR-D2:缺字段拒绝派发) */
export type BriefIssue = { field: string; message: string }

export function validateBrief(brief: unknown): BriefIssue[] {
  const issues: BriefIssue[] = []
  if (typeof brief !== 'object' || brief === null) {
    return [{ field: '$', message: 'brief 必须是对象' }]
  }
  const b = brief as Record<string, unknown>
  if (typeof b.target !== 'string' || b.target.length === 0) {
    issues.push({ field: 'target', message: '缺少 target(岗位 id 或 auto)' })
  }
  if (typeof b.task !== 'string' || b.task.trim().length === 0) {
    issues.push({ field: 'task', message: '缺少 task(一句话任务)' })
  }
  for (const field of ['requirements', 'acceptance'] as const) {
    if (!Array.isArray(b[field]) || (b[field] as unknown[]).length === 0) {
      issues.push({ field, message: `${field} 必须是非空数组(结构化需求/验收标准)` })
    } else if ((b[field] as unknown[]).some((x) => typeof x !== 'string' || x.trim().length === 0)) {
      issues.push({ field, message: `${field} 的元素必须是非空字符串` })
    }
  }
  if (b.timeoutMinutes !== undefined && (typeof b.timeoutMinutes !== 'number' || b.timeoutMinutes < 1)) {
    issues.push({ field: 'timeoutMinutes', message: 'timeoutMinutes 必须是 ≥1 的整数' })
  }
  return issues
}
