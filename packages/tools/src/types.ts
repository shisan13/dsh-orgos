/**
 * 团队工具纯逻辑核心(技术设计 §7.2 工具归属 + §13 工具层测试)
 *
 * 每个工具 = (input, ctx) => ToolOutput:参数校验 → 领域服务 → scope 投影 → 渲染文本。
 * Pro 阶段绑定层把工具注册为 cordis 工具行(仅挂 orchestrator/全员 preset),
 * 本包不接触 DSH 契约(分层纪律 §2.4)。
 *
 * 工具清单:
 *   team_delegate(仅 orchestrator)、team_mail_send/recv、team_task_*、
 *   team_status、team_setup(validate/init/update 计划)。
 */
import { OrgTree, DelegationEngine, Mailbox, TaskBoard } from 'dsh-orgos-core'
import type { TeamConfig } from 'dsh-orgos-core'

/** 调用方身份(工具行注入:成员岗位 + 占位者类型) */
export interface ToolIdentity {
  positionId: string
  kind: 'agent' | 'human'
}

/** Pro 绑定层注入的领域服务(全部为 host 侧已提供的服务引用) */
export interface TeamToolContext {
  identity: ToolIdentity
  orgTree: OrgTree
  delegation: DelegationEngine
  mailbox: Mailbox
  taskboard: TaskBoard
  roles?: TeamConfig['roles']
}

/** 工具输出(渲染文本 + 结构化数据;错误码供 UI/IM 呈现) */
export interface ToolOutput {
  ok: boolean
  /** 渲染文本(IM/Composer 通用) */
  text: string
  /** 结构化结果(可选,供 UI/后续工具消费) */
  data?: unknown
  /** 错误码(无错误时缺省) */
  code?: string
}

export function ok(text: string, data?: unknown): ToolOutput {
  return { ok: true, text, data }
}

export function fail(code: string, message: string): ToolOutput {
  return { ok: false, text: `[${code}] ${message}`, code }
}

/** 渲染列表辅助:bullet 行 */
export function bullet(items: string[]): string {
  return items.map((i) => `- ${i}`).join('\n')
}
