# examples/ — 团队配置(team.yml)样例与字段手册

> English: [README.md](README.md)

本目录是 dsh-orgos **团队配置 team.yml** 的样例与完整字段手册。权威源 = `packages/tools/src/templates.ts`(一致性测试 `packages/tools/src/tools.test.ts` 保证 examples 与模板逐字符一致)。

| 文件 | 场景 |
|------|------|
| [`team-small.yml`](team-small.yml) | 小组:org → team → positions(1 orchestrator + 2 执行岗位,人机混合) |
| [`team-dept.yml`](team-dept.yml) | 部门:org → dept → team ×2(每 team 一个 orchestrator + 跨 team ACL) |
| [`team-group.yml`](team-group.yml) | 多 BG 集团:org → bg → dept → team 三级分层,BG 间默认隔离 |
| [`team-quant.yml`](team-quant.yml) | **量化交易大型项目**:产品运营 + 技术(前端 app/web-小程序、后端工程/数据算法)+ PMO,约 25 岗位,三层治理,`init quant` 一键组建(见 [量化团队组建指南](../docs/quant-trading-guide.md)) |
| [`team-hybrid.example.md`](team-hybrid.example.md) | **多 bot 同群 + 人机混合** 进阶配置说明 |

使用方式:`team_setup init`(scale: small/dept/group)以权威模板初始化;进阶可直接把样例复制到 `${DSH_HOME}/team-state/team/team.yml`(替换占位符后重启生效)。

> 字段语义权威来源 = `packages/core/src/domain/types.ts`(类型与注释)与 `packages/core/src/domain/config/TeamConfig.ts`(校验规则);模板内已含逐字段中文速查注释。

---

## 1. 顶层结构

```yaml
org: acme                      # 集团根节点 id(必填)
nodes: [ ... ]                 # 治理节点列表(必填,可空)
positions: [ ... ]             # 全部岗位列表(必填,可空)
routes: [ ... ]                # 路由表(必填,可空)
acl: { ... }                   # 团队级 ACL(必填,可空对象)
roles: { ... }                 # 角色 scope 覆盖(可选)
```

| 字段 | 类型 | 必填 | 语义 | 默认/约束 |
|------|------|:----:|------|-----------|
| `org` | string | ✅ | 集团根节点 id;必须是 `nodes` 中存在的节点 | 无默认;缺失或不在 nodes 中 → 校验错误 |
| `nodes` | NodeDef[] | ✅ | 治理层节点(org/bg/dept/team)组成的树 | 可为空数组 |
| `positions` | PositionDef[] | ✅ | 全部岗位(治理岗位 + 执行岗位统一模型) | 可为空数组 |
| `routes` | RouteRule[] | ✅ | IM 路由表:(channel, peerId) → 岗位/节点 | 可为空数组 |
| `acl` | AclConfig | ✅ | 协作/委派 ACL | 可空对象;缺省深度 3、并发 2 |
| `roles` | Record\<presetId, RoleDefaults\> | ❌ | 按角色 preset 覆盖五维 scope 默认值 | 缺省按层级默认(见 §5) |

---

## 2. nodes[] — 治理层节点(NodeDef)

治理节点组成组织树:`org → bg → dept → team`。树的叶子身份是岗位(见 §3);`children` 只允许引用治理节点,执行岗位经 `positions[].teamId` 归属,不写在 children。

| 字段 | 类型 | 必填 | 语义 | 默认/约束 |
|------|------|:----:|------|-----------|
| `id` | string | ✅ | 节点 id | 全配置唯一(与 positions 共用命名空间?否——节点与岗位各自唯一即可,但路由 target 可指向任意一类) |
| `kind` | enum | ✅ | 节点类型:`org` / `bg` / `dept` / `team` | 非法取值 → 校验错误 |
| `title` | string | ❌ | 展示名 | — |
| `orchestratorPosition` | string | ❌ | 本层 orchestrator 岗位 id(引用 positions) | **有该字段的层才接受委派**;无则委派/消息沿父链上抛 |
| `children` | string[] | ✅ | 子节点 id 列表 | 只允许治理节点 id;重复/缺失/成环/孤儿 → 校验错误 |

**层级语义**:小组 = `org → team`;部门 = `org → dept[] → team[]`;集团 = `org → bg[] → dept[] → team[]`。根节点(`org` 字段)在树的最上层。

---

## 3. positions[] — 岗位(PositionDef)

岗位是组织树的**稳定叶子**:id/标题/能力档案/权限随岗位延续;占位者(Occupant)可替换(替代演进,ADR-004)。治理岗位被节点 `orchestratorPosition` 引用;执行岗位用 `teamId` 归属团队。

| 字段 | 类型 | 必填 | 语义 | 默认/约束 |
|------|------|:----:|------|-----------|
| `id` | string | ✅ | 岗位 id | 全配置唯一;路由/委派/邮箱都用它寻址 |
| `title` | string | ✅ | 岗位标题 | 团队室/任务板展示 |
| `teamId` | string | 执行岗位✅ | 所属 team 节点 id | 治理岗位**不设**(由 orchestratorPosition 反向关联);引用不存在 → 校验错误 |
| `restricted` | boolean | ❌ | 受限岗位标记(shared/guest) | 默认 false;`true` → 不接受委派、协作被 ACL 排除、只见自己相关条目 |
| `capabilityProfile` | string[] | ❌ | 能力档案(人与 agent 同构) | 参与路由/自动派发匹配(未来 `target: auto`) |
| `occupant` | Occupant | ✅ | 在岗者(见 §3.1) | 缺失 kind → 校验错误 |
| `handover` | HandoverPolicy | ❌ | 替换占位者时的交接策略(见 §3.2) | — |

### 3.1 occupant — 占位者

| 字段 | 类型 | 必填 | 语义 |
|------|------|:----:|------|
| `kind` | enum | ✅ | `agent` = 角色 preset + 常驻会话;`human` = IM 身份绑定(任意层级任意节点都可是人) |
| `preset` | string | agent✅ | 角色 preset id(如 `orgos-orchestrator` / `orgos-coder`) |
| `im` | { channel, userId } | human✅ | 人类成员 IM 身份:`channel`(如 feishu)+ `userId`(如 open_id) |

人机同构核心:把 `occupant.kind` 换成 `human` 就是"该岗位现在由人担任"——路由/委派/任务板/scope 全链路不变。

### 3.2 handover — 交接策略(替换占位者时)

| 字段 | 类型 | 必填 | 语义 |
|------|------|:----:|------|
| `inheritMemory` | enum | ✅ | 知识提炼写入哪层记忆:`private` / `team` / `org` |
| `reassignOpenTasks` | enum | ✅ | 进行中任务处理:`transfer`(转交附上下文)/ `keep` / `cancel` |

用 `team_setup replace` 触发:自动生成交接清单 → 按策略转交进行中任务 → 知识写入团队记忆 → 新占位者初始记忆注入。

---

## 4. routes[] — 路由表(RouteRule)

| 字段 | 类型 | 必填 | 语义 |
|------|------|:----:|------|
| `channel` | string | ✅ | IM 通道名(与 team-im-gateway 配置的通道一致,如 feishu / telegram-personal) |
| `peerId` | string | ✅ | 群/会话 id(与 channel 组成精确匹配路由键) |
| `target` | string | ✅ | 路由目标:岗位 id **或** 治理节点 id |

**路由判定顺序**(§6 路由算法):

```
1. 精确匹配:(channel, peerId) 命中 → 岗位直接投递 / 治理节点交给 orchestrator(无则沿父链上抛);
2. 未绑定群(peer.kind=group):群内 @ 提及才投递,回退到 org 根 orchestrator(main 兜底);
3. 未绑定私聊:用户必须在白名单(ownerIds/allowlist,由 team-core 行配置),回退到 org 根;
4. 命中治理节点:本层 orchestrator 占位者;无 orchestrator → 上抛父节点;
5. restricted(shared/guest)岗位:按 ACL 限制处理。
```

- **多 bot 同群**:同一 `peerId` 配多条 route(按 channel 区分),@谁触发谁(详见 team-hybrid.example.md)。
- **会话绑定**:`(channel, peerId, positionId)` 三元组持久化,同一群永远回到同一岗位。

---

## 5. acl — 团队级 ACL(AclConfig)

| 字段 | 类型 | 必填 | 语义 |
|------|------|:----:|------|
| `allowCrossTeam` | AllowCrossTeamRule[] | ❌ | 跨 team 协作白名单 |
| `block` | BlockRule[] | ❌ | 阻断规则(to 可为 team 节点 id 或岗位 id) |
| `delegationDepthMax` | number | ❌ | 委派深度上限,沿组织树计 | 默认 3;须 ≥1 |
| `memberConcurrencyMax` | number | ❌ | 每成员并发派发上限 | 默认 2;须 ≥1 |

### 5.1 allowCrossTeam — 跨 team 直通

| 字段 | 类型 | 必填 | 语义 |
|------|------|:----:|------|
| `from` | string | ✅ | 发起方 **team 节点 id** |
| `to` | string | ✅ | 目标 team 节点 id |
| `scopes` | enum[] | ✅ | 允许的协作类型:`task` / `note` / `result` / `escalation` |

> 注意:`scopes` **不含 `task`** 即表示"可以协作但不能跨 team 派活"(委派流不开跨 team 白名单)。

### 5.2 block — 阻断

`to` 为 team 节点 id 或岗位 id;命中即拒绝(含委派与协作)。

### 5.3 判定顺序(重要)

```
1. block 命中 → 拒绝(优先级最高,含 restricted 岗位默认阻断);
2. allowCrossTeam 命中且 scope 匹配 → 允许;
3. 同 team → 默认允许(全部 scopes);
4. 其余 → 拒绝。
```

---

## 6. roles — 角色 scope 覆盖(可选)

`roles` 以 **preset id** 为键(如 `orgos-coder`),覆盖该角色的五维 scope 默认值:

| 字段 | 类型 | 取值 | 语义 |
|------|------|------|------|
| `visibility` | enum | `self` / `team` / `dept` / `bg` / `org` | 能看什么(任务板/邮箱/记忆读取投影) |
| `authority` | enum | 同上 | 能做什么(委派目标/升级路径/配置变更) |
| `memory` | enum[] | `private` / `team` / `dept` / `bg` / `org` | 记什么(记忆可见范围) |
| `subscription` | enum[] | `self` / `team` / `dept` / `bg` / `org` | 听什么(事件/通知订阅白名单) |

**缺省默认值(按层级)**:

| 岗位层级 | visibility | authority | memory | subscription |
|----------|-----------|-----------|--------|--------------|
| member(执行岗位) | self | self | private + team | self + team |
| team lead | team | team | + team | + team |
| dept | dept | dept | + dept | + dept 折叠报告 |
| bg | bg | bg | + bg | + bg |
| org(根) | org | org | + org | + org |

> 所有投影过滤在服务端强制(越权数据不可达),不依赖模型自觉。restricted 岗位默认 memory 仅 private、subscription 仅 self。

---

## 7. 三模板差异速查

| 维度 | small | dept | group |
|------|-------|------|-------|
| 树层级 | org → team | org → dept → team ×2 | org → bg ×2 → dept → team |
| 岗位数 | 3(1 orchestrator + 2 执行) | 5(3 orchestrator + 2 执行) | 5(3 orchestrator + 2 执行) |
| 人类占位 | reviewer-1(成员) | backend-lead(组长) | ceo(总裁)+ ops-1(运维) |
| 跨 team ACL | — | allowCrossTeam(team-front → team-backend,note/result) | —(BG 间默认隔离) |
| 升级链 | 根即 team | team → dept-head | team → dept → bg → ceo |
| 适用 | 个人/小组 | 部门 | 集团 |

---

## 8. 校验错误清单(team_setup validate / team_doctor 输出)

`packages/core/src/domain/config/TeamConfig.ts` 的全部校验点(每个都带可执行修复建议):

| # | 触发 | 说明 |
|---|------|------|
| 1 | YAML 语法错误 | 修正缩进/引号/冒号空格 |
| 2 | 顶层非对象 | 用 org/nodes/positions/routes/acl 组织 |
| 3 | `org` 缺失 | 填写集团根节点 id |
| 4 | `org` 根节点不在 `nodes` 中 | nodes 必须含 id=org 的根节点 |
| 5 | nodes[].id 缺失/重复 | 每个节点唯一 id |
| 6 | nodes[].kind 非法 | 必须是 org/bg/dept/team |
| 7 | nodes[].children 非数组 | `children: []` 或省略 |
| 8 | positions[].id 缺失/重复 | 每个岗位唯一 id |
| 9 | positions[].occupant 缺 kind | `occupant: { kind: agent, preset: ... }` 或 `{ kind: human, im: {...} }` |
| 10 | children 引用不存在节点 | 修正 children 引用 |
| 11 | 节点有多个父/孤儿/根成环 | 保证单根树、无环 |
| 12 | orchestratorPosition 引用不存在岗位 | 引用必须存在于 positions |
| 13 | positions[].teamId 引用不存在节点 | teamId 必须是 team 节点 |
| 14 | 岗位同时是执行岗位与治理岗位 | 一个岗位只能二选一 |
| 15 | routes 缺 channel/peerId/target | 补齐三元组 |
| 16 | routes.target 不存在 | target 必须是 positions 或 nodes 中存在的 id |
| 17 | acl 非对象 | 省略或使用合法字段 |
| 18 | allowCrossTeam.from/to 不是 team 节点 | from/to 必须是 team 节点 id |
| 19 | allowCrossTeam.scopes 非法 | 取值 task/note/result/escalation |
| 20 | block.to 不存在 | to 必须是 team 节点 id 或岗位 id |
| 21 | delegationDepthMax 非 ≥1 整数 | 如 `delegationDepthMax: 3` |
| 22 | memberConcurrencyMax 非 ≥1 整数 | 如 `memberConcurrencyMax: 2` |
| 23 | roles 非对象/字段非法 | 五维取值见 §6 |

---

## 9. 常见问题(FAQ)

**Q:restricted(shared/guest)岗位有什么用?**
A:标记为 `restricted: true` 的岗位不接受委派、协作邮件被 ACL 拒绝、记忆仅私有、订阅仅自己——"公开助手"类只读入口的隔离位。安全设计 §4.2(shared/guest 排除规则)。

**Q:跨 team 协作为什么被拒?**
A:ACL 判定顺序 block → allowCrossTeam → 同 team → deny。跨 team 必须显式声明 `allowCrossTeam` 且 scope 匹配;`scopes` 不含 `task` 时不能跨 team 派活(委派流不开跨 team 白名单)。

**Q:群没绑定路由会怎样?**
A:群内 @ 提及才投递(requireMention),回退到 org 根 orchestrator;群内普通文本静默。私聊则必须用户在白名单(ownerIds/allowlist 由 team-core 行配置)。

**Q:节点没有 orchestratorPosition 会怎样?**
A:该层不接受委派;委派/消息沿父链上抛到最近的有 orchestrator 的祖先(升级不可跳级)。

**Q:人类成员怎么配?**
A:`occupant: { kind: human, im: { channel: feishu, userId: ou_xxx } }`;其交互 = IM 任务卡(接受/拒绝/完成汇报)与决策卡([同意][驳回][修改])。跟踪语义 = 催办→升级→转交(与 agent 的"改 brief 重派 ≤3"区分)。

**Q:多 bot 同群怎么路由?**
A:同一 `peerId` 配多条 route(按 channel 区分),@谁触发谁;真人直接 @ 则真人应答。详见 team-hybrid.example.md。

**Q:占位符什么时候替换?**
A:模板中 `ou_your_feishu_id` / `ou_ops_user_id`(人类成员 open_id)与 `oc_your_group_id`(群 id)必须在正式使用前替换为真实值;`team_setup validate` 可复查。

**Q:团队知识库(team_doc_* 工具)怎么启用?**
A:知识库后端是可插拔文档 provider,对应 bundle 行的 disabled 模板(profile 层复制行并去掉 disabled):本地/远程 git wiki 启用 `team-doc-git` 行(`config.repoPath` 指向已有 git 仓库);飞书云文档启用 `team-doc-feishu-docs` 行(`config.credentialRef` 用 appId:appSecret 格式);飞书多维表格启用 `team-doc-feishu` 行(另需 appToken/tableId)。三者可并存,`team_doc_*` 工具跨 provider 合并;更新带 `expectedVersion` 可防多人覆盖(CAS)。

**Q:roles 覆盖与默认的关系?**
A:不写 roles 时按岗位层级取默认值(§6 表);写了则按 preset id 覆盖对应维度,memory/subscription 空数组视为"不覆盖,回落默认"。
