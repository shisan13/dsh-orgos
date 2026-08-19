/**
 * Mailbox —— 成员邮箱(技术设计 §4.4 / §5;FR-C1;安全设计 §4.2)
 *
 * MailItem: {id, from, to | broadcast, kind: task|note|result|escalation, refs: [delegationId], body, at}
 * ACL:block → allowCrossTeam → 同 team 默认 allow(scopes: 全部)→ deny(AclPolicy.canMail);
 * 公告流(FR-F4):to={broadcast, scope: team|org} —— team 广播限 team orchestrator 及上层,
 * org 广播限 org 根 orchestrator;公告不携带任务指令(与委派流严格区分)。
 *
 * 纯内存 + append 语义(持久化 JSONL 由 Pro 绑定层接 TeamStore)。
 */
import { OrgTree } from '../org/OrgTree.ts'
import { AclPolicy } from '../acl/AclPolicy.ts'
import type { AclConfig, MailScope } from '../types.ts'

export interface BroadcastTarget {
  broadcast: true
  scope: 'team' | 'org'
}

export type MailRecipient = string | BroadcastTarget

export interface MailItem {
  id: string
  /** 发件岗位 id */
  from: string
  to: MailRecipient
  kind: MailScope
  /** 关联委派等引用 */
  refs: string[]
  body: string
  at: number
}

export type MailboxResult = { ok: true; item: MailItem } | { ok: false; code: MailboxErrorCode; message: string }

export type MailboxErrorCode =
  | 'SENDER_NOT_FOUND'
  | 'RECIPIENT_NOT_FOUND'
  | 'BROADCAST_FORBIDDEN'
  | 'ACL_DENY'
  | 'EMPTY_BODY'

export interface MailboxOptions {
  now?: () => number
  idFactory?: () => string
}

export class Mailbox {
  private readonly items: MailItem[] = []
  private readonly tree: OrgTree
  private readonly acl: AclPolicy
  private readonly now: () => number
  private readonly idFactory: () => string
  private seq = 0

  constructor(tree: OrgTree, aclConfig: AclConfig, opts?: MailboxOptions) {
    this.tree = tree
    this.acl = new AclPolicy(aclConfig, tree)
    this.now = opts?.now ?? Date.now
    this.idFactory = opts?.idFactory ?? (() => `mail-${++this.seq}`)
  }

  /** 定向投递:ACL 校验通过后入箱 */
  send(from: string, to: string, kind: MailScope, body: string, refs: string[] = []): MailboxResult {
    if (!this.tree.hasPosition(from)) {
      return { ok: false, code: 'SENDER_NOT_FOUND', message: `发件岗位不存在:${from}` }
    }
    if (!this.tree.hasPosition(to)) {
      return { ok: false, code: 'RECIPIENT_NOT_FOUND', message: `收件岗位不存在:${to}` }
    }
    if (body.trim().length === 0) {
      return { ok: false, code: 'EMPTY_BODY', message: '邮件正文不能为空' }
    }
    const gate = this.acl.canMail(from, to, kind)
    if (!gate.allowed) {
      return { ok: false, code: 'ACL_DENY', message: gate.reason ?? 'ACL 拒绝' }
    }
    const item: MailItem = { id: this.idFactory(), from, to, kind, refs, body, at: this.now() }
    this.items.push(item)
    return { ok: true, item }
  }

  /** 公告广播(FR-F4):team 广播 → team orchestrator 或上级;org 广播 → org 根 orchestrator */
  broadcast(from: string, scope: 'team' | 'org', body: string): MailboxResult {
    if (!this.tree.hasPosition(from)) {
      return { ok: false, code: 'SENDER_NOT_FOUND', message: `发件岗位不存在:${from}` }
    }
    if (body.trim().length === 0) {
      return { ok: false, code: 'EMPTY_BODY', message: '公告正文不能为空' }
    }
    const fromNode = this.tree.nodeOfPosition(from)
    if (scope === 'org') {
      // org 广播仅限 org 根节点 orchestrator
      if (!(fromNode === this.tree.root() && this.tree.isOrchestrator(from))) {
        return { ok: false, code: 'BROADCAST_FORBIDDEN', message: `org 广播仅限集团根 orchestrator(当前 ${from})` }
      }
    } else {
      // team 广播:team orchestrator 或任何上层治理岗位
      const isTeamOrchestrator = this.tree.isOrchestrator(from) && this.tree.nodeOfPosition(from) === fromNode
      const isUpper = this.tree.pathToRoot(fromNode).some((ancestor) => this.tree.orchestratorOf(ancestor) === from)
      if (!isTeamOrchestrator && !isUpper) {
        return { ok: false, code: 'BROADCAST_FORBIDDEN', message: `team 广播仅限 team orchestrator 或上层治理岗位(当前 ${from})` }
      }
    }
    const item: MailItem = { id: this.idFactory(), from, to: { broadcast: true, scope }, kind: 'note', refs: [], body, at: this.now() }
    this.items.push(item)
    return { ok: true, item }
  }

  /** 投递对象展开(Pro 绑定层用):广播 → 订阅范围内的岗位列表;定向 → [to] */
  recipientsOf(item: MailItem): string[] {
    if (typeof item.to === 'string') return [item.to]
    if (item.to.scope === 'org') {
      return this.tree.positionsAll().filter((p) => !p.restricted).map((p) => p.id)
    }
    // team 广播:同 team 岗位(排除受限)+ 上层治理岗位
    const teamNode = this.tree.nodeOfPosition(item.from)
    const out = this.tree.positionsAll().filter((p) => !p.restricted && this.tree.nodeOfPosition(p.id) === teamNode).map((p) => p.id)
    for (const ancestor of this.tree.pathToRoot(teamNode)) {
      const oc = this.tree.orchestratorOf(ancestor)
      if (oc) out.push(oc)
    }
    return [...new Set(out)]
  }

  /** 全量(投影由 ScopeProjection.projectMail 负责) */
  list(): MailItem[] {
    return [...this.items]
  }
}
