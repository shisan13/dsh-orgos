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

export const TEMPLATE_QUANT = `# dsh-orgos 量化交易组织模板(team_setup init quant)
# 规模:org → dept(产品运营(含设计)/技术)→ team → team 三层治理,~28 岗位
# 层级:ceo-pmo(总裁/PMO)→ product-lead / tech-director → 前端(frontend)/后端(backend)
#       → app / web-mini、eng / data 子 team
# 委派深度(org→dept→team→team)= 3 跳,与默认 delegationDepthMax: 3 恰好匹配。
#
# 使用前替换占位符:
#   ou_your_ceo_id      → 你的飞书 open_id(总裁/PMO,human 占位示例)
#   oc_your_group_id    → 主群 chat_id(绑定 org 根:群内 @bot 直达总裁/PMO)
#
# 字段语义以 packages/core/src/domain/types.ts 与 config/TeamConfig.ts 为准;
# 逐字段手册见 examples/README.zh-CN.md。
org: quant-alpha                  # 集团根节点 id(必填;必须是 nodes 中存在的节点)
nodes:
  - id: quant-alpha
    kind: org                     # 集团层:目标/治理/项目组合/升级兜底
    orchestratorPosition: ceo-pmo # org 层 orchestrator:CEO/PMO(接受全局升级与未绑定入口)
    children: [dept-product, dept-tech]
  - id: dept-product
    kind: dept                    # 部门层:产品与运营(含设计)
    orchestratorPosition: product-lead
    children: [team-product, team-design]
  - id: team-product
    kind: team                    # 团队层:产品/运营执行岗位归属单元
    children: []
  - id: team-design
    kind: team                    # 团队层:设计(UI/UX;设计稿交付前端实现)
    orchestratorPosition: design-lead
    children: []
  - id: dept-tech
    kind: dept                    # 部门层:技术
    orchestratorPosition: tech-director
    children: [team-frontend, team-backend]
  - id: team-frontend
    kind: team                    # 大团队层:前端
    orchestratorPosition: frontend-lead
    children: [team-app, team-web-mini]
  - id: team-app
    kind: team                    # 子团队层:移动端(iOS/Android/鸿蒙)
    orchestratorPosition: app-lead
    children: []
  - id: team-web-mini
    kind: team                    # 子团队层:PC/H5 + 微信/支付宝小程序
    orchestratorPosition: web-lead
    children: []
  - id: team-backend
    kind: team                    # 大团队层:后端
    orchestratorPosition: backend-lead
    children: [team-eng, team-data]
  - id: team-eng
    kind: team                    # 子团队层:工程(Java 服务/网关/交易执行)
    orchestratorPosition: eng-lead
    children: []
  - id: team-data
    kind: team                    # 子团队层:数据/算法(数据工程/量化策略)
    orchestratorPosition: data-lead
    children: []
positions:
  # —— 治理岗位(每层 orchestrator;占位者可为 human 或 agent)——
  - id: ceo-pmo
    title: 总裁/PMO
    occupant: { kind: human, im: { channel: feishu, userId: ou_your_ceo_id } } # human 示例:决策卡交互(任意层级可为人)
  - id: product-lead
    title: 产品运营负责人
    occupant: { kind: agent, preset: orgos-orchestrator }
  - id: design-lead
    title: 设计负责人
    occupant: { kind: agent, preset: orgos-orchestrator }
  - id: tech-director
    title: 技术总监
    occupant: { kind: agent, preset: orgos-orchestrator }
  - id: frontend-lead
    title: 前端负责人
    occupant: { kind: agent, preset: orgos-orchestrator }
  - id: app-lead
    title: App 端负责人
    occupant: { kind: agent, preset: orgos-orchestrator }
  - id: web-lead
    title: Web/小程序负责人
    occupant: { kind: agent, preset: orgos-orchestrator }
  - id: backend-lead
    title: 后端负责人
    occupant: { kind: agent, preset: orgos-orchestrator }
  - id: eng-lead
    title: 工程负责人
    occupant: { kind: agent, preset: orgos-orchestrator }
  - id: data-lead
    title: 数据/算法负责人
    occupant: { kind: agent, preset: orgos-orchestrator }
  # —— 执行岗位(产品运营 team)——
  - id: pm-1
    title: 产品经理
    teamId: team-product
    capabilityProfile: [product, prd, roadmap]
    occupant: { kind: agent, preset: orgos-analyst }
  - id: ops-1
    title: 运营专员
    teamId: team-product
    capabilityProfile: [operation, content, growth]
    occupant: { kind: agent, preset: orgos-assistant }
  - id: content-1
    title: 内容运营
    teamId: team-product
    occupant: { kind: agent, preset: orgos-assistant }
  # —— 执行岗位(设计 team)——
  - id: ui-1
    title: UI 设计师
    teamId: team-design
    capabilityProfile: [ui, design-system, figma]
    occupant: { kind: agent, preset: orgos-coder }
  - id: ux-1
    title: UX/交互设计师
    teamId: team-design
    occupant: { kind: agent, preset: orgos-analyst }
  # —— 执行岗位(App 子 team)——
  - id: ios-1
    title: iOS 工程师
    teamId: team-app
    occupant: { kind: agent, preset: orgos-coder }
  - id: android-1
    title: Android 工程师
    teamId: team-app
    occupant: { kind: agent, preset: orgos-coder }
  - id: harmonyos-1
    title: 鸿蒙工程师
    teamId: team-app
    occupant: { kind: agent, preset: orgos-coder }
  # —— 执行岗位(Web/小程序子 team)——
  - id: web-1
    title: Web 前端工程师(PC/H5)
    teamId: team-web-mini
    occupant: { kind: agent, preset: orgos-coder }
  - id: miniapp-wx-1
    title: 微信小程序工程师
    teamId: team-web-mini
    occupant: { kind: agent, preset: orgos-coder }
  - id: miniapp-alipay-1
    title: 支付宝小程序工程师
    teamId: team-web-mini
    occupant: { kind: agent, preset: orgos-coder }
  # —— 执行岗位(工程子 team)——
  - id: java-1
    title: Java 服务工程师
    teamId: team-eng
    occupant: { kind: agent, preset: orgos-coder }
  - id: java-2
    title: Java 交易执行工程师
    teamId: team-eng
    occupant: { kind: agent, preset: orgos-coder }
  - id: qa-1
    title: 测试工程师
    teamId: team-eng
    occupant: { kind: agent, preset: orgos-reviewer }
  # —— 执行岗位(数据/算法子 team)——
  - id: data-eng-1
    title: 数据工程师
    teamId: team-data
    occupant: { kind: agent, preset: orgos-coder }
  - id: quant-researcher-1
    title: 量化研究员
    teamId: team-data
    capabilityProfile: [quant, research, python]
    occupant: { kind: agent, preset: orgos-analyst }
  - id: strat-1
    title: 策略工程师
    teamId: team-data
    occupant: { kind: agent, preset: orgos-coder }
  - id: risk-1
    title: 风控复核
    teamId: team-data
    occupant: { kind: agent, preset: orgos-reviewer }
routes:
  # 主群 @bot 直达总裁/PMO(未绑定群回退同样到达 org 根 orchestrator)
  - { channel: feishu-main, peerId: oc_your_group_id, target: quant-alpha }
acl:
  # 跨 team 协作白名单(判定顺序 block→allowCrossTeam→同 team→deny):
  # 产品 ↔ 技术 双向 note/result(需求澄清/交付回执);前端 ↔ 后端 双向 result(联调)。
  allowCrossTeam:
    - { from: team-product, to: team-design, scopes: [note, result] }
    - { from: team-design, to: team-frontend, scopes: [note, result] }
    - { from: team-product, to: team-frontend, scopes: [note, result] }
    - { from: team-product, to: team-backend, scopes: [note, result] }
    - { from: team-frontend, to: team-backend, scopes: [note, result] }
    - { from: team-backend, to: team-frontend, scopes: [note, result] }
  # 委派深度:org→dept→team→team = 3 跳(CEO 直派子团队岗位恰好合法;更深需经中转)
  delegationDepthMax: 3
  # 每成员并发委派上限(量化场景防过载:研究员同时只跑 2 个研究任务)
  memberConcurrencyMax: 2`

export const SCALES = ['small', 'dept', 'group', 'quant'] as const
export type TeamScale = (typeof SCALES)[number]

export const TEMPLATES: Record<TeamScale, string> = {
  small: TEMPLATE_SMALL,
  dept: TEMPLATE_DEPT,
  group: TEMPLATE_GROUP,
  quant: TEMPLATE_QUANT,
}

export const SCALE_DESCRIPTIONS: Record<TeamScale, string> = {
  small: '虚拟几人小组:1 组长 + 2 成员',
  dept: '多部门虚拟团队:2 团队各带 orchestrator',
  group: '多 BG 虚拟集团公司:跨 BG 治理',
  quant: '量化交易大型项目:产品运营 + 技术(前端 app/web-小程序、后端工程/数据算法)+ PMO,约 25 岗位',
}
