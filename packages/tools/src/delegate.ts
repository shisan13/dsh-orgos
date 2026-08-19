/**
 * team_delegate —— 委派工具(FR-D3;仅 orchestrator preset 挂载,技术设计 §7.2)
 *
 * 绝不 DIY 的机器化入口:orchestrator 只派发、绝不代替执行。
 * 参数 = Brief V1(技术设计 §10.1);缺字段拒绝派发(FR-D2);
 * 全部校验在 DelegationEngine 服务端强制(authority 子树/深度/并发/ACL)。
 */
import { validateBrief } from 'dsh-orgos-core'
import type { BriefV1 } from 'dsh-orgos-core'
import { fail, ok, type TeamToolContext, type ToolOutput } from './types.ts'

export interface DelegateInput {
  /** Brief V1 全字段;target/task/requirements/acceptance 必填 */
  brief: BriefV1
}

/** team_delegate 核心(Pro 绑定层薄包装:输入 JSON Schema 校验 + 调用本函数) */
export function teamDelegate(input: DelegateInput, ctx: TeamToolContext): ToolOutput {
  const issues = validateBrief(input.brief)
  if (issues.length > 0) {
    const details = issues.map((i) => `- ${i.field}: ${i.message}`).join('\n')
    return fail('BRIEF_INVALID', `brief 字段校验失败:\n${details}`)
  }
  const result = ctx.delegation.delegate(ctx.identity.positionId, input.brief)
  if (!result.ok) {
    return fail(result.error.code, result.error.message)
  }
  const d = result.value
  const occupantLabel = d.toOccupantKind === 'human' ? '任务卡片' : '收件箱'
  return ok(
    [
      `已派发 ${d.id}`,
      `  目标:${d.toPositionId}(${occupantLabel})`,
      `  任务:${d.brief.task}`,
      `  验收:${d.brief.acceptance.length} 项标准,brief v${d.briefVersion}`,
      `  派发方:${d.fromPositionId}`,
    ].join('\n'),
    { delegationId: d.id, status: d.status, toPositionId: d.toPositionId },
  )
}

/**
 * team_delegate 的失败处理配套:重派(≤3 次,openclaw 铁律)。
 * 单独导出供 orchestrator preset 的另一工具行或合并进 delegate 输出建议。
 */
export function teamRetry(input: { delegationId: string; briefNext: BriefV1 }, ctx: TeamToolContext): ToolOutput {
  const result = ctx.delegation.retry(input.delegationId, input.briefNext, ctx.identity.positionId)
  if (!result.ok) return fail(result.error.code, result.error.message)
  const d = result.value
  return ok(`已重派 ${d.id}(attempt ${d.attempt},brief v${d.briefVersion})`, { delegationId: d.id, attempt: d.attempt })
}
