/**
 * team_mail_send / team_mail_recv —— 协作流工具(FR-C1;安全设计 §4.2)
 *
 * send:ACL 判定在 Mailbox 服务端强制(block → allowCrossTeam → 同 team → deny);
 * recv:mailbox.list() → ScopeProjection.projectMail 按调用方身份过滤后渲染
 * (member 只见自己相关;治理岗位见管辖子树;广播按订阅 scope)。
 */
import { projectMail } from 'dsh-orgos-core'
import type { MailScope } from 'dsh-orgos-core'
import { bullet, fail, ok, type TeamToolContext, type ToolOutput } from './types.ts'

export interface MailSendInput {
  to: string
  kind: MailScope
  body: string
  refs?: string[]
}

export interface MailRecvInput {
  /** 过滤:仅显示未读/全部(当前全部;未读语义由 Pro 绑定层接 inbox 事件) */
  all?: boolean
}

export function teamMailSend(input: MailSendInput, ctx: TeamToolContext): ToolOutput {
  const result = ctx.mailbox.send(ctx.identity.positionId, input.to, input.kind, input.body, input.refs ?? [])
  if (!result.ok) return fail(result.code, result.message)
  return ok(`已投递 ${result.item.id} → ${result.item.to}(${result.item.kind})`, { mailId: result.item.id })
}

export function teamMailRecv(_input: MailRecvInput, ctx: TeamToolContext): ToolOutput {
  const items = ctx.mailbox.list()
  const projected = projectMail(items, {
    tree: ctx.orgTree,
    viewerPositionId: ctx.identity.positionId,
    roles: ctx.roles,
  })
  if (projected.length === 0) {
    return ok('邮箱为空(scope 内无可见邮件)')
  }
  const lines = projected.map((p) => {
    const item = p.item as { id: string; from: string; to: string | { broadcast: true; scope: string }; kind: string; body: string }
    const toLabel = typeof item.to === 'string' ? item.to : `广播(${item.to.scope})`
    const body = String(item.body).slice(0, 80)
    return `${item.id} ${item.from} → ${toLabel} [${item.kind}] ${body}${p.filtered ? `(已裁剪:${p.filtered})` : ''}`
  })
  return ok(`邮箱(${projected.length} 条可见):\n${bullet(lines)}`, { count: projected.length })
}
