/**
 * team_setup init 三模板(PRD §5.9 FR-X2;ADR-003)
 *
 * 权威源 = 本文件;examples/*.yml 为用户可见的同内容样例(一致性测试保证不漂移)。
 * 三级规模:小组(small)/多部门(dept)/多 BG 集团(group),均含人机混合示例
 * (occupant.kind: human 与 agent 混合,ADR-004)。
 * 模板内逐字段中文注释即字段手册的速查版;完整语义见 examples/README.zh-CN.md。
 */

/** 小组规模:org → team → positions(1 orchestrator + 2 专家,1 人 1 agent) */
export const TEMPLATE_SMALL = `# dsh-orgos 小组模板(team_setup init small)
# 规模:org → team → positions;1 个 orchestrator + 2 个执行岗位(1 人类 + 1 agent)
#
# 使用前替换占位符:
#   ou_your_feishu_id → 你的飞书 open_id(人类成员)
#   oc_your_group_id  → 你的飞书群 chat_id(群路由)
#
# 字段语义以 packages/core/src/domain/types.ts 与 config/TeamConfig.ts 为准。
org: my-team                      # 集团根节点 id(必填;必须存在于 nodes,是整棵树的根)
nodes:
  - id: my-team                   # 治理节点 id(必填;全配置唯一,不能有重复)
    kind: org                     # 节点类型(必填):org / bg / dept / team
    orchestratorPosition: lead    # 本层 orchestrator 岗位 id(可选;有此字段的层才接受委派,无则路由沿父链上抛)
    children: []                  # 子节点 id 列表(治理节点;执行岗位经 positions[].teamId 归属,不写在 children)
positions:
  - id: lead                      # 岗位 id(必填;全配置唯一,或为治理岗位被 orchestratorPosition 引用)
    title: 组长                   # 岗位标题(必填;团队室/任务板展示用)
    occupant:                     # 占位者(必填):岗位的在岗者,人机同构核心(ADR-004)
      kind: agent                 # 占位者类型(必填):agent = 角色 preset + 常驻会话;human = IM 身份绑定
      preset: orgos-orchestrator  # agent 专用:角色 preset id(如 orgos-orchestrator / orgos-coder)
  - id: coder-1                   # 执行岗位:用 teamId 归属到某个 team 节点
    title: 工程师
    teamId: my-team               # 所属 team 节点 id(执行岗位必填;治理岗位不设,由 orchestratorPosition 反向关联)
    occupant:
      kind: agent
      preset: orgos-coder
  - id: reviewer-1
    title: 评审
    teamId: my-team
    occupant:
      kind: human                 # human 占位:不设 preset,绑 IM 身份(任意层级任意节点都可是人)
      im:
        channel: feishu           # 人类成员 IM 通道名(与 team-im-gateway 配置的通道一致)
        userId: ou_your_feishu_id # 人类成员 IM 用户 id(占位符,替换为真实 open_id)
routes:
  - channel: feishu               # IM 通道名(必填;对应 bundle/用户 profile 的通道配置)
    peerId: oc_your_group_id      # 群/会话 id(必填;与 channel 组成精确匹配路由键)
    target: my-team               # 路由目标(必填):岗位 id 或治理节点 id(节点 → 该层 orchestrator 接单)
acl:
  delegationDepthMax: 3           # 委派深度上限(默认 3,沿组织树计;T8 防委派链失控)
  memberConcurrencyMax: 2         # 每成员并发派发上限(默认 2;T8 防并发淹没)`

/** 部门规模:org → dept[] → team[] → positions[](2 团队各带 orchestrator) */
export const TEMPLATE_DEPT = `# dsh-orgos 部门模板(team_setup init dept)
# 规模:org → dept → team ×2;每 team 一个 orchestrator,混合占位
#
# 使用前替换占位符:
#   ou_your_feishu_id → 你的飞书 open_id(人类组长)
#   oc_your_group_id  → 你的飞书群 chat_id(群路由)
#
# 字段语义以 packages/core/src/domain/types.ts 与 config/TeamConfig.ts 为准。
org: my-org                       # 集团根节点 id(必填;必须是 nodes 中存在的节点)
nodes:
  - id: my-org                    # 治理节点 id(必填;全配置唯一)
    kind: org                     # 节点类型(必填):org / bg / dept / team
    orchestratorPosition: dept-head  # 本层 orchestrator 岗位 id(可选;org 层 = 全局兜底,接受未绑定群/私聊的升级)
    children: [dept-eng]          # 子节点 id 列表(治理节点)
  - id: dept-eng
    kind: dept                    # 部门层:跨 team 协调与规范,可无自己的 orchestrator(无则委派上抛)
    children: [team-front, team-backend]
  - id: team-front
    kind: team                    # 团队层:执行岗位归属的最小治理单元
    orchestratorPosition: frontend-lead  # team 层 orchestrator:本 team 委派/调度/质量
    children: []
  - id: team-backend
    kind: team
    orchestratorPosition: backend-lead
    children: []
positions:
  - id: dept-head                 # 治理岗位:被 my-org 的 orchestratorPosition 引用
    title: 部门主管
    occupant:
      kind: agent
      preset: orgos-orchestrator  # 治理角色:绝不 DIY + team_delegate 等调度工具
  - id: frontend-lead
    title: 前端组长
    occupant:
      kind: agent
      preset: orgos-orchestrator
  - id: backend-lead
    title: 后端组长
    occupant:
      kind: human                 # human orchestrator:任意层级都可为人(FR-H6 决策卡交互)
      im:
        channel: feishu
        userId: ou_your_feishu_id
  - id: fe-1                      # 执行岗位:teamId 归属 team-front
    title: 前端工程师
    teamId: team-front
    occupant:
      kind: agent
      preset: orgos-coder
  - id: be-1
    title: 后端工程师
    teamId: team-backend
    occupant:
      kind: agent
      preset: orgos-coder
routes:
  - channel: feishu               # IM 通道名(必填)
    peerId: oc_your_group_id      # 群/会话 id(必填)
    target: my-org                # 路由目标:岗位或治理节点(此处群 @bot → org 根 orchestrator=dept-head)
acl:
  allowCrossTeam:                 # 跨 team 协作白名单(可选;判定顺序 block → allowCrossTeam → 同 team → deny)
    - from: team-front            # 发起方 team 节点 id(必填)
      to: team-backend            # 目标 team 节点 id(必填)
      scopes: [note, result]      # 允许的协作类型(必填):task / note / result / escalation;不含 task 即不能跨 team 派活
  delegationDepthMax: 3           # 委派深度上限(默认 3,沿组织树计)
  memberConcurrencyMax: 2         # 每成员并发派发上限(默认 2)`

/** 集团规模:org → bg[] → dept[] → team[] → positions[](跨 BG 治理) */
export const TEMPLATE_GROUP = `# dsh-orgos 集团模板(team_setup init group)
# 规模:org → bg ×2 → dept → team;BG 间默认隔离(安全设计 §4.3)
#
# 使用前替换占位符:
#   ou_your_feishu_id → 你的飞书 open_id(集团总裁)
#   ou_ops_user_id    → 运维成员的飞书 open_id
#   oc_your_group_id  → 你的飞书群 chat_id(群路由)
#
# 字段语义以 packages/core/src/domain/types.ts 与 config/TeamConfig.ts 为准。
org: acme                         # 集团根节点 id(必填;必须是 nodes 中存在的节点)
nodes:
  - id: acme                      # 治理节点 id(必填;全配置唯一)
    kind: org                     # 节点类型(必填):org / bg / dept / team
    orchestratorPosition: ceo     # 本层 orchestrator 岗位 id(可选;org 根 = 升级兜底与配置变更)
    children: [bg-eng, bg-ops]    # 子节点 id 列表(治理节点)
  - id: bg-eng
    kind: bg                      # BG 层:方向/风险/跨 dept 决策;BG 间默认无协作可见性(隔离)
    orchestratorPosition: cto
    children: [dept-web]
  - id: bg-ops
    kind: bg                      # 无 orchestrator 的 BG:委派/消息沿父链上抛(acme → ceo)
    children: [dept-ops]
  - id: dept-web
    kind: dept
    children: [team-front]
  - id: dept-ops
    kind: dept
    children: [team-ops]
  - id: team-front
    kind: team
    orchestratorPosition: frontend-lead
    children: []
  - id: team-ops
    kind: team                    # 无 orchestrator 的 team:任务路由上抛父链
    children: []
positions:
  - id: ceo                       # 治理岗位(集团总裁):被 acme 的 orchestratorPosition 引用
    title: 集团总裁
    occupant:
      kind: human                 # human 根节点:决策经 IM 决策卡([同意][驳回][修改])回系统
      im:
        channel: feishu
        userId: ou_your_feishu_id
  - id: cto
    title: CTO
    occupant:
      kind: agent
      preset: orgos-orchestrator
  - id: frontend-lead
    title: 前端组长
    occupant:
      kind: agent
      preset: orgos-orchestrator
  - id: fe-1
    title: 前端工程师
    teamId: team-front
    occupant:
      kind: agent
      preset: orgos-coder
  - id: ops-1
    title: 运维
    teamId: team-ops
    occupant:
      kind: human
      im:
        channel: feishu
        userId: ou_ops_user_id
routes:
  - channel: feishu               # IM 通道名(必填)
    peerId: oc_your_group_id      # 群/会话 id(必填)
    target: acme                  # 路由目标:岗位或治理节点(群 @bot → org 根 orchestrator=ceo)
acl:
  delegationDepthMax: 3           # 委派深度上限(默认 3,沿组织树计;集团三级 = 恰好覆盖 org→bg→dept→team)
  memberConcurrencyMax: 2         # 每成员并发派发上限(默认 2)`

export const SCALES = ['small', 'dept', 'group'] as const
export type TeamScale = (typeof SCALES)[number]

export const TEMPLATES: Record<TeamScale, string> = {
  small: TEMPLATE_SMALL,
  dept: TEMPLATE_DEPT,
  group: TEMPLATE_GROUP,
}

export const SCALE_DESCRIPTIONS: Record<TeamScale, string> = {
  small: '虚拟几人小组:1 组长 + 2 成员',
  dept: '多部门虚拟团队:2 团队各带 orchestrator',
  group: '多 BG 虚拟集团公司:跨 BG 治理',
}
