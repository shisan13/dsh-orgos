/**
 * team_task_* —— 任务板工具(FR-C2;scope 投影越权返回空,技术设计 §13)
 *
 * create/claim/done/cancel 由 TaskBoard 服务端强制权限(assignee/team orchestrator/创建者);
 * list 经 ScopeProjection.projectTasks 投影:member 只见自己相关,
 * T10 人类任务隐私:同级 agent 只见元数据。
 */
import { projectTasks } from 'dsh-orgos-core'
import { bullet, fail, ok, type TeamToolContext, type ToolOutput } from './types.ts'

export interface TaskCreateInput {
  teamId: string
  title: string
  assignee: string
  deadlineAt?: number
}

export interface TaskIdInput {
  id: string
}

export function teamTaskCreate(input: TaskCreateInput, ctx: TeamToolContext): ToolOutput {
  const result = ctx.taskboard.create({
    teamId: input.teamId,
    title: input.title,
    assignee: input.assignee,
    deadlineAt: input.deadlineAt,
    createdBy: ctx.identity.positionId,
  })
  if (!result.ok) return fail(result.code, result.message)
  return ok(`任务已创建 ${result.item.id}(${result.item.status})`, { taskId: result.item.id })
}

export function teamTaskClaim(input: TaskIdInput, ctx: TeamToolContext): ToolOutput {
  const result = ctx.taskboard.claim(input.id, ctx.identity.positionId)
  if (!result.ok) return fail(result.code, result.message)
  return ok(`任务已认领 ${result.item.id}`, { taskId: result.item.id })
}

export function teamTaskDone(input: TaskIdInput, ctx: TeamToolContext): ToolOutput {
  const result = ctx.taskboard.done(input.id, ctx.identity.positionId)
  if (!result.ok) return fail(result.code, result.message)
  return ok(`任务已完成 ${result.item.id}`, { taskId: result.item.id })
}

export function teamTaskCancel(input: TaskIdInput, ctx: TeamToolContext): ToolOutput {
  const result = ctx.taskboard.cancel(input.id, ctx.identity.positionId)
  if (!result.ok) return fail(result.code, result.message)
  return ok(`任务已取消 ${result.item.id}`, { taskId: result.item.id })
}

export function teamTaskList(_input: object, ctx: TeamToolContext): ToolOutput {
  const tasks = ctx.taskboard.list()
  const projected = projectTasks(tasks, {
    tree: ctx.orgTree,
    viewerPositionId: ctx.identity.positionId,
    roles: ctx.roles,
  })
  if (projected.length === 0) {
    return ok('任务板为空(scope 内无可见任务)')
  }
  const lines = projected.map((t) => {
    const meta = t.meta as { id: string; title: string; status: string; assignee: string }
    return `${meta.id} [${meta.status}] ${meta.title} → ${meta.assignee}${t.filtered ? `(裁剪:${t.filtered})` : ''}`
  })
  return ok(`任务板(${projected.length} 条可见):\n${bullet(lines)}`, { count: projected.length })
}
