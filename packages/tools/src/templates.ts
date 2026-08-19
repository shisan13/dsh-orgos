/**
 * team_setup init 三模板(PRD §5.9 FR-X2;ADR-003)
 *
 * 权威源 = 本文件;examples/*.yml 为用户可见的同内容样例(一致性测试保证不漂移)。
 * 三级规模:小组(small)/多部门(dept)/多 BG 集团(group),均含人机混合示例
 * (occupant.kind: human 与 agent 混合,ADR-004)。
 */

/** 小组规模:org → team → positions(1 orchestrator + 2 专家,1 人 1 agent) */
export const TEMPLATE_SMALL = `# dsh-orgos 小组模板(team_setup init small)
# 规模:org → team → positions;1 个 orchestrator + 2 个执行岗位(1 人类 + 1 agent)
org: my-team
nodes:
  - id: my-team
    kind: org
    orchestratorPosition: lead
    children: []
positions:
  - id: lead
    title: 组长
    occupant: { kind: agent, preset: orgos-orchestrator }
  - id: coder-1
    title: 工程师
    teamId: my-team
    occupant: { kind: agent, preset: orgos-coder }
  - id: reviewer-1
    title: 评审
    teamId: my-team
    occupant: { kind: human, im: { channel: feishu, userId: ou_your_feishu_id } }
routes:
  - { channel: feishu, peerId: oc_your_group_id, target: my-team }
acl:
  delegationDepthMax: 3
  memberConcurrencyMax: 2
`

/** 部门规模:org → dept[] → team[] → positions[](2 团队各带 orchestrator) */
export const TEMPLATE_DEPT = `# dsh-orgos 部门模板(team_setup init dept)
# 规模:org → dept → team ×2;每 team 一个 orchestrator,混合占位
org: my-org
nodes:
  - id: my-org
    kind: org
    orchestratorPosition: dept-head
    children: [dept-eng]
  - id: dept-eng
    kind: dept
    children: [team-front, team-backend]
  - id: team-front
    kind: team
    orchestratorPosition: frontend-lead
    children: []
  - id: team-backend
    kind: team
    orchestratorPosition: backend-lead
    children: []
positions:
  - id: dept-head
    title: 部门主管
    occupant: { kind: agent, preset: orgos-orchestrator }
  - id: frontend-lead
    title: 前端组长
    occupant: { kind: agent, preset: orgos-orchestrator }
  - id: backend-lead
    title: 后端组长
    occupant: { kind: human, im: { channel: feishu, userId: ou_your_feishu_id } }
  - id: fe-1
    title: 前端工程师
    teamId: team-front
    occupant: { kind: agent, preset: orgos-coder }
  - id: be-1
    title: 后端工程师
    teamId: team-backend
    occupant: { kind: agent, preset: orgos-coder }
routes:
  - { channel: feishu, peerId: oc_your_group_id, target: my-org }
acl:
  allowCrossTeam:
    - { from: team-front, to: team-backend, scopes: [note, result] }
  delegationDepthMax: 3
  memberConcurrencyMax: 2
`

/** 集团规模:org → bg[] → dept[] → team[] → positions[](跨 BG 治理) */
export const TEMPLATE_GROUP = `# dsh-orgos 集团模板(team_setup init group)
# 规模:org → bg ×2 → dept → team;BG 间默认隔离(安全设计 §4.3)
org: acme
nodes:
  - id: acme
    kind: org
    orchestratorPosition: ceo
    children: [bg-eng, bg-ops]
  - id: bg-eng
    kind: bg
    orchestratorPosition: cto
    children: [dept-web]
  - id: bg-ops
    kind: bg
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
    kind: team
    children: []
positions:
  - id: ceo
    title: 集团总裁
    occupant: { kind: human, im: { channel: feishu, userId: ou_your_feishu_id } }
  - id: cto
    title: CTO
    occupant: { kind: agent, preset: orgos-orchestrator }
  - id: frontend-lead
    title: 前端组长
    occupant: { kind: agent, preset: orgos-orchestrator }
  - id: fe-1
    title: 前端工程师
    teamId: team-front
    occupant: { kind: agent, preset: orgos-coder }
  - id: ops-1
    title: 运维
    teamId: team-ops
    occupant: { kind: human, im: { channel: feishu, userId: ou_ops_user_id } }
routes:
  - { channel: feishu, peerId: oc_your_group_id, target: acme }
acl:
  delegationDepthMax: 3
  memberConcurrencyMax: 2
`

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
