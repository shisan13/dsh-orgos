/**
 * TaskBoard —— 团队任务板(技术设计 §4.4;FR-C2;openclaw 任务板的机器化)
 *
 * 并发正确性(借官方 experimental agent-team 的 task-board 设计,只借鉴不依赖):
 * - CAS:TaskItem.revision 从 1 起,每次成功变更 +1;claim/done/cancel/remove 支持
 *   expectedRevision,提供且不匹配 → STALE_REVISION(陈旧状态拒绝,防覆盖);
 *   未提供 → 宽松语义(向后兼容既有工具/测试);
 * - tombstone:remove 保留任务为墓碑(deletedAt 置位,status→cancelled),
 *   list() 默认不返回已删除项,get() 返回带 deletedAt 的对象;对已删除任务的
 *   进一步操作 → TASK_DELETED;
 * - DAG:create 支持 deps 依赖列表(须指向未删除任务、无自依赖、无环),
 *   环检测为全图 DFS(与官方 assertTaskGraphCandidate 同构);依赖用于有序工作,
 *   不阻止 claim/done/cancel(语义保持简单);删除被依赖任务 → TASK_HAS_DEPENDENTS。
 *
 * 操作权限:claim/done 仅 assignee 或 team orchestrator;cancel/remove 额外允许创建者;
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
  /** CAS 版本号:从 1 起,每次成功变更 +1(并发正确性) */
  revision: number
  /** 依赖的任务 id(指向未删除任务;创建时校验存在性与无环) */
  deps: string[]
  /** 墓碑标记:删除时间戳;存在即任务已删除(list 默认过滤) */
  deletedAt?: number
}

export type TaskResult = { ok: true; item: TaskItem } | { ok: false; code: TaskErrorCode; message: string }

export type TaskErrorCode =
  | 'TASK_NOT_FOUND'
  | 'TEAM_NOT_FOUND'
  | 'ASSIGNEE_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'STATE_ILLEGAL'
  | 'EMPTY_TITLE'
  | 'STALE_REVISION'
  | 'TASK_DELETED'
  | 'DEPENDENCY_CYCLE'
  | 'TASK_HAS_DEPENDENTS'

export interface TaskBoardOptions {
  now?: () => number
  idFactory?: () => string
}

export interface TaskCreateInput {
  teamId: string
  title: string
  assignee: string
  delegationId?: string
  deadlineAt?: number
  createdBy: string
  /** 依赖的任务 id(必须存在且未删除;无环) */
  deps?: string[]
}

/** 变更操作的通用可选参数:expectedRevision 提供即 CAS 严格模式 */
export interface TaskMutationOptions {
  expectedRevision?: number
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

  create(input: TaskCreateInput): TaskResult {
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
      revision: 1,
      deps: dedupe(input.deps ?? []),
    }
    const graphError = this.validateGraph(item)
    if (graphError !== null) {
      return { ok: false, code: graphError.code, message: graphError.message }
    }
    this.items.set(item.id, item)
    return { ok: true, item }
  }

  /** 认领(open → claimed):仅 assignee 或 team orchestrator */
  claim(id: string, by: string, opts?: TaskMutationOptions): TaskResult {
    return this.mutate(id, by, (item) => {
      if (item.status !== 'open') {
        return { code: 'STATE_ILLEGAL', message: `任务当前状态 ${item.status},不可认领` }
      }
      item.status = 'claimed'
      return null
    }, opts)
  }

  /** 完成(→ done):仅 assignee 或 team orchestrator */
  done(id: string, by: string, opts?: TaskMutationOptions): TaskResult {
    return this.mutate(id, by, (item) => {
      if (item.status !== 'claimed' && item.status !== 'open') {
        return { code: 'STATE_ILLEGAL', message: `任务当前状态 ${item.status},不可完成` }
      }
      item.status = 'done'
      return null
    }, opts)
  }

  /** 取消(→ cancelled):仅 assignee / team orchestrator / 创建者 */
  cancel(id: string, by: string, opts?: TaskMutationOptions): TaskResult {
    return this.mutate(id, by, (item) => {
      if (item.status === 'done' || item.status === 'cancelled') {
        return { code: 'STATE_ILLEGAL', message: `任务当前状态 ${item.status},不可取消` }
      }
      item.status = 'cancelled'
      return null
    }, { ...opts, allowCreator: true })
  }

  /**
   * 删除(tombstone):status → cancelled + deletedAt 置位,list 不再返回;
   * 仅 assignee / team orchestrator / 创建者;被未删除任务依赖时拒绝。
   */
  remove(id: string, by: string, opts?: TaskMutationOptions): TaskResult {
    const item = this.items.get(id)
    if (item === undefined) {
      return { ok: false, code: 'TASK_NOT_FOUND', message: `任务不存在:${id}` }
    }
    if (item.deletedAt !== undefined) {
      return { ok: false, code: 'TASK_DELETED', message: `任务 ${id} 已删除` }
    }
    // 引用完整性:仍被未删除任务依赖时拒绝删除(与官方 TEAM_TASK_HAS_DEPENDENTS 对齐)
    for (const other of this.items.values()) {
      if (other.id !== id && other.deletedAt === undefined && other.deps.includes(id)) {
        return { ok: false, code: 'TASK_HAS_DEPENDENTS', message: `任务 ${id} 仍被任务 ${other.id} 依赖,不可删除` }
      }
    }
    return this.mutate(id, by, (current) => {
      current.status = 'cancelled'
      current.deletedAt = this.now()
      return null
    }, { ...opts, allowCreator: true })
  }

  /** 任务是否归 by 管辖(assignee 本人 / team orchestrator / 创建者) */
  private canAct(item: TaskItem, by: string, allowCreator: boolean): boolean {
    if (item.assignee === by) return true
    if (allowCreator && item.createdBy === by) return true
    const byNode = this.tree.nodeOfPosition(by)
    const itemNode = this.tree.nodeOfPosition(item.assignee)
    return this.tree.isAncestor(byNode, itemNode) && this.tree.isOrchestrator(by)
  }

  /**
   * 通用变更:存在性 → tombstone → CAS → 权限 → 状态迁移 → revision+1。
   * expectedRevision 提供且不匹配 → STALE_REVISION(陈旧状态拒绝,message 含当前 revision)。
   */
  private mutate(
    id: string,
    by: string,
    apply: (item: TaskItem) => { code: TaskErrorCode; message: string } | null,
    opts?: TaskMutationOptions & { allowCreator?: boolean },
  ): TaskResult {
    const item = this.items.get(id)
    if (item === undefined) {
      return { ok: false, code: 'TASK_NOT_FOUND', message: `任务不存在:${id}` }
    }
    if (item.deletedAt !== undefined) {
      return { ok: false, code: 'TASK_DELETED', message: `任务 ${id} 已删除` }
    }
    if (opts?.expectedRevision !== undefined && item.revision !== opts.expectedRevision) {
      return {
        ok: false,
        code: 'STALE_REVISION',
        message: `任务 ${id} 陈旧状态:期望 revision ${opts.expectedRevision},当前 ${item.revision};请重读后重试`,
      }
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
    item.revision += 1
    item.updatedAt = this.now()
    return { ok: true, item }
  }

  /**
   * DAG 校验(与官方 assertTaskGraphCandidate 同构):
   * - 缺失/已删除依赖 → TASK_NOT_FOUND;自依赖/成环 → DEPENDENCY_CYCLE;
   * - 全图 DFS(visiting/visited),覆盖既有任务图与新任务。
   */
  private validateGraph(candidate: TaskItem): { code: TaskErrorCode; message: string } | null {
    for (const depId of candidate.deps) {
      if (depId === candidate.id) {
        return { code: 'DEPENDENCY_CYCLE', message: `任务 ${candidate.id} 不能依赖自身` }
      }
      const dep = this.items.get(depId)
      if (dep === undefined || dep.deletedAt !== undefined) {
        return { code: 'TASK_NOT_FOUND', message: `依赖任务不存在或已删除:${depId}` }
      }
    }
    const tasks = new Map(this.items)
    tasks.set(candidate.id, candidate)
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visit = (taskId: string): string | undefined => {
      const task = tasks.get(taskId)
      if (task === undefined || task.deletedAt !== undefined) return undefined
      if (visiting.has(taskId)) {
        return `任务依赖成环,包含 ${taskId}`
      }
      if (visited.has(taskId)) return undefined
      visiting.add(taskId)
      for (const depId of task.deps) {
        const cycle = visit(depId)
        if (cycle !== undefined) return cycle
      }
      visiting.delete(taskId)
      visited.add(taskId)
      return undefined
    }
    for (const task of tasks.values()) {
      const cycle = visit(task.id)
      if (cycle !== undefined) {
        return { code: 'DEPENDENCY_CYCLE', message: cycle }
      }
    }
    return null
  }

  /** 全量活跃任务(默认不返回已删除项;投影由 ScopeProjection 负责) */
  list(): TaskItem[] {
    return [...this.items.values()].filter((item) => item.deletedAt === undefined)
  }

  /** 全部条目(含 tombstone,供审计/对账) */
  listAll(): TaskItem[] {
    return [...this.items.values()]
  }

  /** 按 id 取任务;tombstone 返回带 deletedAt 的对象 */
  get(id: string): TaskItem | undefined {
    return this.items.get(id)
  }
}

/** 去重并保持顺序(重复依赖宽容处理,与"引用完整性"不冲突) */
function dedupe(ids: string[]): string[] {
  return [...new Set(ids)]
}
