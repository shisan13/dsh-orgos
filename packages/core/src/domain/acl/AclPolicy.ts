/**
 * AclPolicy —— 团队间 ACL(安全设计 §4.2)
 *
 * 判定顺序:block → allowCrossTeam → 同 team 默认 allow(scopes: 全部)→ 其他 deny。
 * - block.to 可为 team 节点 id 或岗位 id;restricted(shared/guest)岗位默认阻断协作;
 * - canDelegate 额外强制"非受限岗位"与 block 判定(委派流不开跨 team 白名单,
 *   跨子树由上层 orchestrator 中转——升级而非直派,技术设计 §6);
 * - delegationDepthMax / memberConcurrencyMax 默认值 3 / 2(T8)。
 */
import { OrgTree } from '../org/OrgTree.ts'
import type { AclConfig, MailScope } from '../types.ts'

export type AclGate = { allowed: true } | { allowed: false; reason: string }

export class AclPolicy {
  private readonly config: AclConfig
  private readonly tree: OrgTree

  constructor(config: AclConfig, tree: OrgTree) {
    this.config = config
    this.tree = tree
  }

  delegationDepthMax(): number {
    return this.config.delegationDepthMax ?? 3
  }

  memberConcurrencyMax(): number {
    return this.config.memberConcurrencyMax ?? 2
  }

  /** 委派流校验:block + restricted 岗位拒绝(协作白名单不适用于委派) */
  canDelegate(_fromPositionId: string, toPositionId: string): AclGate {
    const to = this.tree.position(toPositionId)
    // restricted(shared/guest)岗位不接受委派(安全设计 §4.2:shared 全拒绝)
    if (to.restricted === true) {
      return { allowed: false, reason: `岗位 ${toPositionId} 是受限岗位(shared/guest),不接受委派` }
    }
    // block:to 岗位自身或所属 team 被 block
    const toTeam = this.tree.nodeOfPosition(toPositionId)
    for (const rule of this.config.block ?? []) {
      if (rule.to === toPositionId || rule.to === toTeam) {
        return { allowed: false, reason: `ACL block:${rule.to} 阻断对该岗位的委派` }
      }
    }
    return { allowed: true }
  }

  /**
   * 协作流校验(canMail):block → allowCrossTeam → 同 team → deny。
   * from/to 为岗位 id;同 team 以岗位所属 team 节点判定。
   */
  canMail(fromPositionId: string, toPositionId: string, scope: MailScope): AclGate {
    const to = this.tree.position(toPositionId)
    const toTeam = this.tree.nodeOfPosition(toPositionId)
    // 1. block 优先(含 restricted 岗位)
    for (const rule of this.config.block ?? []) {
      if (rule.to === toPositionId || rule.to === toTeam) {
        return { allowed: false, reason: `ACL block:${rule.to} 阻断协作` }
      }
    }
    // restricted(shared/guest)岗位:默认阻断协作(安全设计 §4.2 shared/guest 全拒绝)
    if (to.restricted === true) {
      return { allowed: false, reason: `岗位 ${toPositionId} 是受限岗位(shared/guest),不接受协作投递` }
    }
    // 2. 同 team 默认 allow(scopes: 全部)
    const fromTeam = this.tree.nodeOfPosition(fromPositionId)
    if (fromTeam === toTeam) {
      return { allowed: true }
    }
    // 2b. 组织根 orchestrator 默认全组织可达(FR-S2 authority=org 根语义;
    // 根协调者向任意团队协作不应被"跨 team"拦截——实测 lead 向 team-main 投递被拒)
    if (fromTeam === this.tree.root()) {
      return { allowed: true }
    }
    // 3. 跨 team:显式 allowCrossTeam 且 scope 在白名单内
    for (const rule of this.config.allowCrossTeam ?? []) {
      if (rule.from === fromTeam && rule.to === toTeam && rule.scopes.includes(scope)) {
        return { allowed: true }
      }
    }
    return { allowed: false, reason: `跨 team 协作未授权:${fromTeam} → ${toTeam}(${scope}),需在 acl.allowCrossTeam 显式声明` }
  }
}
