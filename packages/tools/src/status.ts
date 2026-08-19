/**
 * team_status —— 团队状态查询(FR-C3;FR-S1 visibility 投影)
 *
 * 输出:岗位/占位者状态 + 委派分布 + 超时 + 邮箱积压,全部按调用方
 * visibility scope 服务端投影(越权数据不可达,技术设计 §4.6.2)。
 */
import { projectDelegations, roleScope } from 'dsh-orgos-core'
import { ok, type TeamToolContext, type ToolOutput } from './types.ts'

export function teamStatus(_input: object, ctx: TeamToolContext): ToolOutput {
  const scope = roleScope(ctx.orgTree, ctx.identity.positionId, ctx.roles)
  // 岗位视图:治理岗位看管辖子树成员,member 只看自己(含自身节点)
  const positions = ctx.orgTree.positionsAll().filter((p) => {
    if (scope.visibility === 'self') return p.id === ctx.identity.positionId
    const node = ctx.orgTree.nodeOfPosition(p.id)
    const viewerNode = ctx.orgTree.nodeOfPosition(ctx.identity.positionId)
    return ctx.orgTree.isAncestor(viewerNode, node) || ctx.orgTree.isAncestor(node, viewerNode)
  })
  const positionLines = positions.map((p) => {
    const occupant = p.occupant.kind === 'agent' ? `agent(${p.occupant.preset ?? '?'})` : `human(${p.occupant.im?.userId ?? '?'})`
    return `${p.id} [${p.occupant.kind}] ${p.title} ${p.restricted ? '(受限)' : ''} ${occupant}`
  })

  // 委派视图:按 visibility 投影(越权数据不可达)
  const delegations = projectDelegations(ctx.delegation.snapshot(), {
    tree: ctx.orgTree,
    viewerPositionId: ctx.identity.positionId,
    roles: ctx.roles,
  })
  const activeDelegations = delegations.filter((d) => ['queued', 'dispatched', 'running'].includes(d.status))
  const overdue = ctx.delegation.timeoutOverdue().filter((d) =>
    delegations.some((dv) => dv.id === d.id),
  )
  const mailCount = ctx.mailbox.list().length

  const lines = [
    `身份:${ctx.identity.positionId}(${ctx.identity.kind}) visibility=${scope.visibility}`,
    `岗位(${positionLines.length}):`,
    ...positionLines.map((l) => `  ${l}`),
    `委派:进行中 ${activeDelegations.length} 条,超时 ${overdue.length} 条`,
    `邮箱积压:${mailCount} 条(可见数以 team_mail_recv 为准)`,
  ]
  return ok(lines.join('\n'), {
    scope,
    positions: positionLines.length,
    activeDelegations: activeDelegations.length,
    overdue: overdue.length,
  })
}
