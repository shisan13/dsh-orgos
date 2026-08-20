/**
 * team_task_* —— 任务板工具(FR-C2;scope 投影越权返回空,技术设计 §13)
 *
 * create/claim/done/cancel/remove 由 TaskBoard 服务端强制权限与 CAS:
 * expectedRevision 提供即严格 CAS(陈旧状态 STALE_REVISION 拒绝);
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
  /** 依赖任务 id(存在且未删除;无环) */
  deps?: string[]
}

export interface TaskIdInput {
  id: string
  /** CAS 版本号:提供即严格校验,不匹配 → STALE_REVISION(防陈旧覆盖) */
  expectedRevision?: number
}

export function teamTaskCreate(input: TaskCreateInput, ctx: TeamToolContext): ToolOutput {
  const result = ctx.taskboard.create({
    teamId: input.teamId,
    title: input.title,
    assignee: input.assignee,
    deadlineAt: input.deadlineAt,
    deps: input.deps,
    createdBy: ctx.identity.positionId,
  })
  if (!result.ok) return fail(result.code, result.message)
  return ok(`任务已创建 ${result.item.id}(${result.item.status},rev ${result.item.revision})`, {
    taskId: result.item.id,
    revision: result.item.revision,
  })
}

export function teamTaskClaim(input: TaskIdInput, ctx: TeamToolContext): ToolOutput {
  const result = ctx.taskboard.claim(input.id, ctx.identity.positionId, { expectedRevision: input.expectedRevision })
  if (!result.ok) return fail(result.code, result.message)
  return ok(`任务已认领 ${result.item.id}(rev ${result.item.revision})`, {
    taskId: result.item.id,
    revision: result.item.revision,
  })
}

export function teamTaskDone(input: TaskIdInput, ctx: TeamToolContext): ToolOutput {
  const result = ctx.taskboard.done(input.id, ctx.identity.positionId, { expectedRevision: input.expectedRevision })
  if (!result.ok) return fail(result.code, result.message)
  return ok(`任务已完成 ${result.item.id}(rev ${result.item.revision})`, {
    taskId: result.item.id,
    revision: result.item.revision,
  })
}

export function teamTaskCancel(input: TaskIdInput, ctx: TeamToolContext): ToolOutput {
  const result = ctx.taskboard.cancel(input.id, ctx.identity.positionId, { expectedRevision: input.expectedRevision })
  if (!result.ok) return fail(result.code, result.message)
  return ok(`任务已取消 ${result.item.id}(rev ${result.item.revision})`, {
    taskId: result.item.id,
    revision: result.item.revision,
  })
}

/** 删除(tombstone):任务保留为墓碑供审计;被依赖时 TASK_HAS_DEPENDENTS 拒绝 */
export function teamTaskRemove(input: TaskIdInput, ctx: TeamToolContext): ToolOutput {
  const result = ctx.taskboard.remove(input.id, ctx.identity.positionId, { expectedRevision: input.expectedRevision })
  if (!result.ok) return fail(result.code, result.message)
  return ok(`任务已删除(墓碑保留) ${result.item.id}(rev ${result.item.revision})`, {
    taskId: result.item.id,
    revision: result.item.revision,
  })
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
    const meta = t.meta as { id: string; title: string; status: string; assignee: string; revision?: number; deps?: string[] }
    const deps = meta.deps !== undefined && meta.deps.length > 0 ? `(依赖:${meta.deps.join(',')})` : ''
    return `${meta.id} [${meta.status}@rev${meta.revision ?? '?'}] ${meta.title} → ${meta.assignee}${deps}${t.filtered ? `(裁剪:${t.filtered})` : ''}`
  })
  return ok(`任务板(${projected.length} 条可见):\n${bullet(lines)}`, { count: projected.length })
}
