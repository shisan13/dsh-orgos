/**
 * TaskBoard —— 团队任务板(技术设计 §4.4;FR-C2;openclaw 任务板的机器化)
 *
 * TaskItem: {id, teamId, title, status: open|claimed|done|cancelled, assignee, delegationId?, deadlineAt?, updatedAt}
 * 操作权限:claim/done/cancel 仅 assignee 或 team orchestrator(或委托链上的派发方);
 * 投影由 ScopeProjection.projectTasks 负责(此处不越权过滤)。
 */
import { OrgTree } from '../org/OrgTree.ts'

export type TaskStatus = 'open' | 'claimed' | 'done' | 'cancelled'

export interface TaskItem {
  id: string
  teamId: string
  title: string
  status: TaskStatus
  assignee: string
  /** 关联委派(派发登记的接单任务) */
  delegationId?: string
  deadlineAt?: number
  createdBy: string
  createdAt: number
  updatedAt: number
}

export type TaskResult = { ok: true; item: TaskItem } | { ok: false; code: TaskErrorCode; message: string }

export type TaskErrorCode =
  | 'TASK_NOT_FOUND'
  | 'TEAM_NOT_FOUND'
  | 'ASSIGNEE_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'STATE_ILLEGAL'
  | 'EMPTY_TITLE'

export interface TaskBoardOptions {
  now?: () => number
  idFactory?: () => string
}

export class TaskBoard {
  private readonly items = new Map<string, TaskItem>()
  private readonly tree: OrgTree
  private readonly now: () => number
  private readonly idFactory: () => string
  private seq = 0

  constructor(tree: OrgTree, opts?: TaskBoardOptions) {
    this.tree = tree
    this.now = opts?.now ?? Date.now
    this.idFactory = opts?.idFactory ?? (() => `task-${++this.seq}`)
  }

  create(input: { teamId: string; title: string; assignee: string; delegationId?: string; deadlineAt?: number; createdBy: string }): TaskResult {
    if (!this.tree.hasNode(input.teamId)) {
      return { ok: false, code: 'TEAM_NOT_FOUND', message: `team 节点不存在:${input.teamId}` }
    }
    if (!this.tree.hasPosition(input.assignee)) {
      return { ok: false, code: 'ASSIGNEE_NOT_FOUND', message: `接单人岗位不存在:${input.assignee}` }
    }
    if (input.title.trim().length === 0) {
      return { ok: false, code: 'EMPTY_TITLE', message: '任务标题不能为空' }
    }
    const at = this.now()
    const item: TaskItem = {
      id: this.idFactory(),
      teamId: input.teamId,
      title: input.title,
      status: 'open',
      assignee: input.assignee,
      delegationId: input.delegationId,
      deadlineAt: input.deadlineAt,
      createdBy: input.createdBy,
      createdAt: at,
      updatedAt: at,
    }
    this.items.set(item.id, item)
    return { ok: true, item }
  }

  /** 认领(open → claimed):仅 assignee 或 team orchestrator */
  claim(id: string, by: string): TaskResult {
    return this.mutate(id, by, (item) => {
      if (item.status !== 'open') {
        return { code: 'STATE_ILLEGAL', message: `任务当前状态 ${item.status},不可认领` }
      }
      item.status = 'claimed'
      return null
    })
  }

  /** 完成(→ done):仅 assignee 或 team orchestrator */
  done(id: string, by: string): TaskResult {
    return this.mutate(id, by, (item) => {
      if (item.status !== 'claimed' && item.status !== 'open') {
        return { code: 'STATE_ILLEGAL', message: `任务当前状态 ${item.status},不可完成` }
      }
      item.status = 'done'
      return null
    })
  }

  /** 取消(→ cancelled):仅 assignee / team orchestrator / 创建者 */
  cancel(id: string, by: string): TaskResult {
    return this.mutate(id, by, (item) => {
      if (item.status === 'done' || item.status === 'cancelled') {
        return { code: 'STATE_ILLEGAL', message: `任务当前状态 ${item.status},不可取消` }
      }
      item.status = 'cancelled'
      return null
    }, { allowCreator: true })
  }

  /** 任务是否归 by 管辖(assignee 本人 / team orchestrator / 创建者) */
  private canAct(item: TaskItem, by: string, allowCreator: boolean): boolean {
    if (item.assignee === by) return true
    if (allowCreator && item.createdBy === by) return true
    const byNode = this.tree.nodeOfPosition(by)
    const itemNode = this.tree.nodeOfPosition(item.assignee)
    return this.tree.isAncestor(byNode, itemNode) && this.tree.isOrchestrator(by)
  }

  private mutate(
    id: string,
    by: string,
    apply: (item: TaskItem) => { code: TaskErrorCode; message: string } | null,
    opts?: { allowCreator?: boolean },
  ): TaskResult {
    const item = this.items.get(id)
    if (!item) {
      return { ok: false, code: 'TASK_NOT_FOUND', message: `任务不存在:${id}` }
    }
    if (!this.tree.hasPosition(by)) {
      return { ok: false, code: 'ASSIGNEE_NOT_FOUND', message: `操作者岗位不存在:${by}` }
    }
    if (!this.canAct(item, by, opts?.allowCreator ?? false)) {
      return { ok: false, code: 'PERMISSION_DENIED', message: `${by} 无权操作任务 ${id}` }
    }
    const err = apply(item)
    if (err) {
      return { ok: false, code: err.code, message: err.message }
    }
    item.updatedAt = this.now()
    return { ok: true, item }
  }

  /** 全量(投影由 ScopeProjection 负责) */
  list(): TaskItem[] {
    return [...this.items.values()]
  }

  get(id: string): TaskItem | undefined {
    return this.items.get(id)
  }
}
