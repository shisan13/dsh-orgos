# dsh-orgos

> **DeepSeek Harness 上的组织操作系统** —— 把「IM 路由 + 常驻团队 + 绝不 DIY 调度哲学」三者合一,人机混合组织的开源插件。

> English: [README.md](README.md)。

dsh-orgos 让你在 DeepSeek Harness(DSH)之上构建并运营一支**组织化团队**:虚拟员工(agent)与人类员工同处一张组织树,IM 是入口,调度有纪律,从几人的小队到多 BG 集团,一套模型覆盖全部规模。

## 它能做什么

| 能力 | 说明 |
|------|------|
| **IM 路由** | 飞书(已实测)/ Telegram / 企业微信 / 钉钉 / Slack / Discord / WhatsApp 多通道;群或私聊绑定到岗位,多 bot 同群 @谁触发谁 |
| **常驻团队** | 组织树(org→bg→dept→team→岗位)声明式配置;每个岗位一个角色预设(人格/工具/模型),成员会话常驻、重启自动恢复 |
| **绝不 DIY 调度** | 调度中心只协调不执行:结构化任务派发、失败诊断重派(≤3 次)、心跳跟进、回执摘要 |
| **人机混合** | 岗位与占位者分离:同一岗位可以是 agent 或真人(IM 身份),替换即替代演进,知识交接 |
| **组织信息流** | 委派/回执/协作/公告/记忆/心跳六条流;五维 scope(视野/权限/工具/记忆/订阅)服务端强制;三层记忆(私有/团队/集团) |
| **IM 审批** | 成员执行敏感操作 → IM 卡片审批(允许/拒绝),超时 fail-closed |
| **可观测** | `team_status`/`team_doctor`/`team_run` 工具、`/run` 命令、HTTP 快照、运行记录 |
| **官方能力派生(FR-D6)** | 成员内部用官方 DSH subagent(spawn/fork)与 workflow 工具派生;Codex/Claude Code 作为成员执行引擎走官方可选 Profile Bundle(预设内 disabled 行模板)——见 [ADR-006](doc/tech/decisions/ADR-006-官方融合互补策略.md) |

## 架构设计:能力从哪来,长期往哪走

上述每一项能力都不是孤立堆砌,而是同一套架构的必然产物。设计的立足点很朴素:
**今天能跑起来的,不因规模增长而推倒重来**——一套模型覆盖小组到集团,
规模升级走"换 provider、不重写"的路径。

### 能力与结构的对应

| 能力 | 支撑它的架构设计 |
|------|------------------|
| 多 IM 通道、多 bot 同群 | `MessageGateway` seam:每 IM 一个独立 adapter 包,统一消息规范化 |
| 常驻团队、任意深度组织树 | 纯领域内核(domain/):组织树/路由/ACL 与 DSH 解耦,声明式驱动 |
| 绝不 DIY 调度、失败重派 | 委派状态机(queued→dispatched→running→completed/failed→重派≤3),确定性状态流转 |
| 人机混合、替换即演进 | 岗位与占位者分离:岗位是稳定实体,占位者(agent/human)是可替换后端 |
| 六条流、五维 scope、三层记忆 | 服务端强制投影:工具只拿得到自己权限内的数据,过滤是机制不是提示词 |
| IM 审批 fail-closed | 审批瀑布流挂成员会话,卡片回执答复,10 分钟无响应自动拒绝 |
| 可观测 | 六条流即事实日志(runs/mailbox/delegations/memory),快照与医生诊断直接从日志投影 |

### 一条主线:一套模型,三种规模

组织树 `org → bg → dept → team → 岗位` 任意深度,三种规模只是同一棵树的三种形态:

- 小组 = org → team(几人即可生效);
- 部门/公司 = org → dept → team ×N;
- 集团 = org → bg → dept → team(多 BG 联邦)。

协调机制与规模无关:每层可选配 orchestrator(有则委派下达,无则上抛);
回执沿父链**逐层 digest 折叠**(成员报告 → 团队 → 部门 → BG → 集团,上层只见结论);
成员**懒激活**(待命零常驻成本,派发时自动唤醒)。
这三条让"加一层组织"只是加配置,不是加复杂度。

### 分层内核:领域与宿主解耦

```
packages/core/
├── domain/   # 纯领域内核:组织树/路由/委派状态机/scope 投影/digest/记忆
│             # 零 DSH 依赖、零 Node IO —— 换宿主(其他 harness/框架)内核可整体移植
└── dsh/      # DSH 绑定层:TeamService/成员运行时/持久化/扩展面(薄,只做环境接线)
```

领域内核回答"组织如何运转",绑定层回答"如何在 DSH 上落地"。
所有单测的 80%+ 覆盖在领域内核上,换宿主时核心逻辑的验证跟着走。

### Capability seams:外部依赖全部可插拔

每一条外部依赖都收敛为接口,实现是可插拔的 provider:

| seam | 现状 | 长期演进 |
|------|------|----------|
| `MessageGateway`(IM 通道) | 6 个 adapter 已实现(飞书已实测) | 新 IM 一个包接入 |
| `TeamStore`(存储引擎) | JSONL 文件存储(正确性优先) | SQLite provider 插拔,数据记录格式不变,迁移=一次性导入 |
| `DocumentProvider`(文档协作) | 接口已定义 | 飞书云文档/多维表格、钉钉、企微、Notion/Confluence,与 IM adapter 同模式 |
| `OrgFederation`(跨实例联邦) | 接口已定义 | 每 BG 一个 host 实例,根 orchestrator 跨实例委派/折叠/心跳 |
| MemberBackend(成员后端) | agent 会话后端(单机) | subagent-acp / 多机成员分布,seam 设计已预留 |

### 插件的插件:扩展 orgos = 给 DSH 写插件

继承 DSH"一切皆是插件"的心智:**orgos 的扩展点就是普通 DSH 插件行**。
第三方插件 `ctx.get('teamService')` 拿到 [Orgos Extension API](packages/core/src/dsh/extensions.ts):

- `registerDocumentProvider` / `listDocumentProviders` —— 文档库 registry;
- `setFederation` —— 集团联邦注入;
- `onTeamEvent` —— 订阅团队事件流(订阅者异常不阻断事件总线);
- `options.store` —— 存储 provider 注入点。

第三方能力(Jira 对接、日历、CRM、代码平台、文档库)以独立 npm 包 + cordis 行启用,
写法与给 DSH 写插件零差异——生态只学一套。

### 数据格式即迁移契约

JSONL 流记录(委派/任务/邮箱/记忆/runs)从第一天起就是稳定的、可重放的事实日志:
冷启动靠它恢复状态,SQLite/联邦后端靠它做一次性迁移。格式不变,历史数据永远有效。

### 规模相关的效率设计(当下即生效)

| 设计 | 作用 | 与规模的关系 |
|------|------|--------------|
| 成员懒激活 | 未派发的岗位零会话、零 token | 岗位数增长不增加常驻成本 |
| digest 折叠链 | 每层 orchestrator 只读结论 | 层级越多,上层信息量不变 |
| scope 服务端强制投影 | 工具只拿得到自己权限内的数据 | 组织越大,信息隔离越刚需 |
| 委派深度 ≤3 + 失败重派 | 任务有终态,不无限递归 | 防调度失控 |

## 快速开始

```bash
# 1. 安装(DSH 插件协议)
dsh plugin add dsh-orgos

# 2. 启动 dsh:角色预设自动播种;Web 新会话选"调度中心(orchestrator)"

# 3. 初始化团队(在"调度中心"会话中发送)
用 team_setup 初始化团队(action=init, scale=small)

# 4. 配置 IM(以飞书为例)
#    - 凭据写入 DSH credentials(键自定,值格式 appId:appSecret)
#    - profile 层启用 team-im-feishu 行并配置 channels
#    - 群里 @bot 即可对话;绑定群→岗位用 team_setup bind
```

## 使用指南

### 按你的规模选型(个人 / 小团队 / 大团队)

一套模型覆盖全部规模,差异只在 `team_setup init` 的 `scale` 与后续自定义:

| 用户 | 推荐起点 | 组织树 | 典型玩法 |
|------|----------|--------|----------|
| **个人** | `scale=small`(1 组长 + 2 成员) | org→team | 手机上用 IM 指挥自己的虚拟小组;任务派发/回执/心跳全程 IM 闭环 |
| **小团队** | `scale=small` 起步,`team.yml` 加岗位 | org→team | 一个群绑到团队节点,@谁触发谁;真人成员挂 `occupant.kind: human` 直接进群协作 |
| **大团队/公司** | `scale=dept`(2 团队各带 orchestrator) | org→dept→team×N | 部门墙 + 跨部门协作 ACL;每层 orchestrator 折叠摘要;敏感操作走 IM 审批卡 |
| **集团预演(多 BG)** | `scale=group`(org→bg×2→dept→team) | org→bg→dept→team | BG 间默认隔离;跨 BG 经 ACL 显式声明;集团根只见折叠汇总 |

> `scale` 只是初始模板——任何规模起步后都可以随时编辑 `team.yml` 调整,
> 组织树是声明式配置,不是代码。

### 自定义组织架构(team.yml)

团队配置就是一份声明式 YAML,位于 `${DSH_HOME}/team-state/team/team.yml`
(改完重启生效;`team_setup bind/unbind/replace` 走安全流程:备份→校验→原子替换,失败自动回滚):

```yaml
org: my-org                        # 组织名
nodes:                             # 治理节点树(org/bg/dept/team,任意深度)
  - id: my-org
    kind: org
    orchestratorPosition: head     # 该层可选配 orchestrator(有则委派下达,无则上抛)
    children: [team-a, team-b]
  - id: team-a
    kind: team
    orchestratorPosition: lead-a
    children: []
positions:                         # 岗位 = 稳定实体,占位者可替换
  - id: lead-a                     # orchestrator 岗位
    occupant: { kind: agent, preset: orgos-orchestrator }
  - id: dev-1
    teamId: team-a
    occupant: { kind: agent, preset: orgos-coder }          # 虚拟员工
  - id: designer-1
    teamId: team-a
    occupant: { kind: human, im: { channel: feishu, userId: ou_xxx } }  # 真人
    handover: { inheritMemory: team, reassignOpenTasks: transfer }      # 替换时的交接策略
routes:                            # IM 路由:(通道, 群/会话) → 岗位或节点
  - { channel: feishu, peerId: oc_xxx, target: team-a }
acl:                               # 治理规则
  delegationDepthMax: 3            # 委派深度上限
  allowCrossTeam:                  # 跨部门协作白名单(默认跨 team 拒绝)
    - { from: team-a, to: team-b, scopes: [note, result] }
roles:                             # 按预设覆盖五维 scope(visibility/authority/memory/subscription)
  orgos-coder: { visibility: team, authority: self, memory: [private, team], subscription: [team, self] }
```

完整样例见 [examples/](examples/)(小组/部门/集团/多 bot 同群);字段语义在样例注释中就近说明。

### 角色与人员构成

内置 5 个角色预设(安装即播种到用户目录,绝不触碰 DSH shipped 预设):

| 预设 | 角色 | 典型岗位 |
|------|------|----------|
| `orgos-orchestrator` | 调度中心 | 组长/部门主管/BG 主管/总裁 —— 只协调不执行 |
| `orgos-coder` | 工程师 | 编码/实现(带审批触发的文件与命令工具) |
| `orgos-reviewer` | 评审 | 审查/验收/回归质量闸门 |
| `orgos-analyst` | 分析师 | 调研/数据/方案 |
| `orgos-assistant` | 助手 | 通用协助/客服 |

- **换人**:任何岗位 `occupant` 可随时换成真人(`kind: human`)或其他预设,
  `team_setup replace` 自动生成交接清单、按 `handover` 策略处理进行中任务并注入新占位者初始记忆;
- **自定义角色**:按 DSH 方式写自己的 agent preset(人格/工具/模型),`occupant.preset` 引用即可,
  orgos 不锁定角色体系。

### 除了"调度中心",还能怎么玩

调度中心(orchestrator)是主入口,但不是唯一入口:

| 入口 | 玩法 |
|------|------|
| **IM 直连岗位** | 群绑定到团队节点,消息按路由到岗位;多 bot 同群 @谁触发谁;DM 白名单(owner 可私聊成员) |
| **Web 成员会话** | Web 新会话直接选 `orgos-coder` 等预设,你就是那个岗位的虚拟员工(与 IM 投递同一会话) |
| **`/run` 命令** | 任何已绑定 IM 群发 `/run`,立即回运行摘要(入站/审批/委派/回执 + 委派单在途/完成/失败) |
| **IM 审批** | 成员执行敏感操作时你收到审批卡片(允许/拒绝),10 分钟无响应自动拒绝(fail-closed) |
| **团队室页签** | Web 会话页「团队室」:组织树/成员状态/委派单/任务板/健康检查,15s 自动刷新 |
| **岗位替换** | `team_setup replace` 触发知识交接:交接清单 + 记忆落层 + 新占位者初始 framing(agent)或欢迎卡(真人) |
| **三层记忆** | `team_memory_save` 沉淀团队/集团显式提炼,`team_memory_recall` 按 scope 取回(私有记忆 = 成员 session 历史) |
| **12 个团队工具** | delegate/status/mail×2/task×3/memory×2/setup/doctor/run,成员与调度中心共用同一套纪律 |

## 规模与演进路径

**当下:开箱即用,零性能负债**。组织模型、协调机制、成员懒激活在单机部署下即可承载
数十至数百岗位的团队;JSONL 存储为正确性与可恢复性优先,数据格式即迁移契约。

**长期:集团级 = 换 provider**。SQLite → 文档 provider → 跨实例联邦逐级插上,
每一级都只动一个 seam,不动组织模型与领域内核。接口先行,实现按需——
这正是上面「Capability seams」一节的兑现方式。

## 目录

```
packages/
├── core/          # domain/(纯领域内核,harness-agnostic)+ dsh/(DSH 绑定层 + 扩展面)
├── im-gateway/    # MessageGateway seam + 消息规范化
├── im-feishu/     # 飞书适配器(WS 长连接,已实测)
├── im-telegram/ wecom/ dingtalk/ slack/ discord/ whatsapp/
├── tools/         # 团队工具(delegate/status/mail/task/memory/setup(含 replace)/doctor/run)
├── ui/            # Client 半(团队室数据加载器)
└── bundle/        # dsh-orgos 组合包(dsh.bundle manifest)
examples/          # 团队配置样例(小组/部门/集团/多 bot 同群)
```

## 路线图

| 阶段 | 状态 |
|------|------|
| M1 核心 + 飞书 + 双端实跑 | ✅ 完成 |
| M2 全 IM + 审批 + Run 数据 + 三层记忆 + 知识交接 + 扩展面接口 | 🔨 进行中(飞书与 Telegram 已真实凭据实跑;预设已挂官方 subagent/workflow 派生工具;任务板 CAS;剩:whatsapp/slack/discord/钉钉/企微真实凭据联调) |
| M3 SQLite + 文档 provider + 发布 | 🔲 计划中 |
| M4 集团联邦 + 多租户 + 审计 | 🔲 规划预留(接口已定义) |

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。核心约定:新 IM 适配器 = 独立包 + fixture 测试;单测覆盖率 ≥ 80%,关键路径 Given-When-Then;文档与代码同步。

## License

[MIT](LICENSE) © shisan13
