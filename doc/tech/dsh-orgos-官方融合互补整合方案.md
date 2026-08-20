# dsh-orgos × DSH 官方:融合互补整合方案(产品 + 技术)

| 项目 | 内容 |
|------|------|
| 文档版本 | v1.0(2026-08-20,基于 DSH rc.8) |
| 状态 | 提案(待用户决策) |
| 上游基线 | DSH rc.8(536 commits;官方 Agent Teams 孵化、subagent 产品化、code-runtime-python 发布) |
| 关联文档 | [技术设计](dsh-orgos-技术设计-完整版.md)、[ADR-005](decisions/ADR-005-官方AgentTeams关系.md)、[rc8 适配分析](rc8-适配分析.md) |

---

## 0. 策略总纲(融合互补三原则)

1. **官方有且完善 → 直接用官方**。执行引擎(subagent/workflow)、审批(user-approval)、会话/持久化(session/storage)、凭据(credentials)、UI 生态(slots/settings/预设 authoring)属于此类——不重复造,只做 Consumer。
2. **官方有接口而实现不完善/官方只定义 seam → 我们做 Provider/Consumer 提升**。subagent 六 provider 是官方"接口官方、实现开放"的旗舰 seam;我们作为**组织层的 Consumer 实现**接入,并补齐官方缺失的组织语义(层级/scope/人机)。
3. **官方没有 → 我们做深做透(差异化)**。组织树、IM 入口、绝不 DIY 哲学、人机混合替代演进、六条流+五维 scope、三层记忆折叠、Run 面板审计——官方中长期路线不覆盖这些,**这就是"独立于官方、高于官方"的根据地**。

**主线本质(回归)**:dsh-orgos = **组织操作系统**。官方未来越来越强的是"执行与基础设施",我们始终做的是"组织与运营"。两者通过官方 seam 对接,互补共存,边界随官方演进逐版重校(已建立 [rc8-适配分析](rc8-适配分析.md) 的升级清单机制)。

---

## 1. 官方中长期规划解读(证据 → 推断 → 对我们的含义)

| # | 官方事实(笔记/文档证据) | 官方规划推断 | 我们的应对 |
|---|-------------------------|--------------|-----------|
| 1 | seam 哲学:`service definition + provider + consumer`,换 provider 即换产品(capability-seams 文档) | 官方长期把"可替换能力"作为产品演进主轴 | **我们的自建能力全部按 seam 形态组织**(MemberBackend/MessageGateway 已如此),未来官方提供同类 seam 时可无缝切换 |
| 2 | subagent 六 provider:spawn/fork/**acp/codex/claude-code/dsh-sdk** | 执行引擎持续开放化、产品化、远程化 | 执行层永远用官方;我们的"成员"是官方 subagent 之上的组织层 Consumer |
| 3 | ACP 定位 = **仅面向自动化的协议**(2026-07-23 simplification:不做 UI 选择器) | 官方把 ACP 留给机器间集成——正是"成员远程化"的通道 | §2.4 层次 B 的 member-acp 后端基于官方 ACP,方向被官方确认 |
| 4 | Agent Teams = experimental 私有包;promotion 需评审+转正重命名;转正前"发布包不能暴露 Team" | 官方短期内**不会默认挂 team**;转正后 API 会原子重命名 | 我们不依赖 experimental API;转正后再评估原语下沉(见 §4.2) |
| 5 | 官方 team 文档自认限制:Lead 绑定、inactive 唤醒延迟、failed member 永久占名、Lead 日志膨胀、无 worktree 隔离、写 scope 仅提示 | 官方 team 是"会话内任务派生",不是常驻组织 | **我们的常驻成员+组织树正好补官方限制**,ADR-002 四冲突判断被官方文档反向印证 |
| 6 | storage-domain(`ctx.storageDomain`)通用域数据设施 + json/sqlite 实现 | 官方在收编"域数据持久化"为通用 seam | 我们的 team-state JSONL 评估迁移 storageDomain(§4.7) |
| 7 | code-runtime-python / 单文件可执行 SDK 运行时 | 官方走向多语言 agent 运行时 | 成员执行引擎未来多语言化,组织层零改动(MemberBackend 抽象吸收) |
| 8 | llm 目录 + 会话级模型选择 + reasoning 回传 | 模型层持续完善 | 我们成员模型分级(Pro/Flash)继续用官方 `!!js` 注入,零自建 |

**一句话解读**:官方在把"执行、任务、存储、UI"做厚做实;官方**不打算**做组织治理、IM 运营、人机组织学。我们的空间随官方变厚而变得更清晰——**官方每强一分,我们的组织层就多一个免费的执行引擎和基础设施**。

---

## 2. 官方能力三清单

### A. 官方完善 → 直接用(Consumer 角色)

| 官方能力 | 我们当前状态 | 整合动作 |
|----------|-------------|---------|
| `ctx.agents`(create/resume/inject)+ agentPresets.mount | ✅ 已用(成员运行时) | 保持;升级点:恢复逻辑借鉴官方 team 的 provisioning 对账严谨性 |
| subagent(spawn/fork)+ tool-subagent/workflow | ⚠️ 预设未挂 | **M2 收尾挂入 coder/orchestrator 预设**(FR-D6 官方原生兑现) |
| subagent-codex/claude-code | ❌ 未用 | bundle 加显式行(层次 A:成员执行引擎=Claude Code/Codex 开箱即用) |
| user-approval(waterfall/prepend/超时 deny) | ✅ 已对接(IM 呈现层) | 保持;官方完善部分零自建 |
| session 持久化(JSONL/SQLite)+ sessionQuery | ✅ 成员会话走官方 | 保持;成员历史零自建 |
| credentials / attachment / settings / schedule | ✅ 已用 | 保持 |
| client UI:slots/settings/预设 authoring/locale | ✅ team-ui 已注册 slot | 预设管理 UI 向官方 authoring 对齐,自建 UI 只做团队语义 |

### B. 官方有接口、实现不完善 → 我们适配提升(Provider/Consumer 提升)

| 官方 seam/接口 | 不完善点 | 我们的提升 |
|---------------|---------|-----------|
| `ctx.subagents` 六 provider seam | 官方只给"一次性子代理"语义;无组织成员语义、无 IM 入口 | **MemberBackend seam 是官方 subagent seam 的"组织层镜像"**——我们做 consumer 实现;M3+ 的 member-codex/member-claude-code/member-acp 后端 = 官方 provider 的包装 |
| experimental team(mailbox/task-board) | 扁平、Lead 绑定、experimental 不可依赖、无投影 | 我们的 Mailbox/TaskBoard 保持自建;TaskBoard 借官方 CAS(expectedRevision)+DAG+tombstone 设计自建实现 |
| `ctx.storageDomain` | 新 seam,只有 json 基线实现、无"域"生态 | 我们定义"team-state 域"(org/委托/邮箱/任务/记忆/运行流 schema),作为官方域数据设施的首个真实 Consumer |
| 预设 authoring(rc.8 client) | 官方 UI 只管文件级读/复制/删除,无团队语义(角色-岗位-模型-沙箱打包) | 播种器 + team_setup 保留"角色资产包"语义,文件级操作完全交给官方 UI |
| approval 的远程呈现 | 官方只有 Web answerer;IM 呈现官方没有 | 已实现(prepend 抢答 + IM 卡片 + 回执),继续作为官方 user-approval 的 IM Provider |

### C. 官方缺失 → 我们做深(差异化根据地)

| 我们的能力 | 官方状态 | 我们的深度 |
|-----------|---------|-----------|
| 组织树(org/bg/dept/team + 岗位/占位者) | 无(官方 team 扁平且明确不做层级) | 层级治理、管辖子树、升级链、跨 BG ACL |
| IM 路由(7 通道多 bot) | 无 | 组织入口=IM 优先 |
| 绝不 DIY 调度哲学 | 无(workflow 是任务图,不是组织委派) | 委派状态机、失败重派≤3、升级上报 |
| 人机混合(FR-H1~H8) | 无(官方纯 agent) | 岗位/占位者分离、替代演进、知识交接 |
| 六条流 + 五维 scope | 无 | 服务端强制投影、越权不可达 |
| 三层记忆 + digest 折叠链 | 无 | 每层折叠一次的摘要链 |
| 心跳折叠 + Run 面板审计 | 无 | 下→上折叠、visibility 投影审计 |

---

## 3. 整合架构(三层)

```
┌─────────────────────────────────────────────────────────────┐
│ 第三层 dsh-orgos 差异层(官方没有,做深做透)                    │
│   组织树 · 委派状态机 · 五维 scope 投影 · 三层记忆/digest      │
│   人机混合(岗位/占位者/替代演进) · 心跳折叠 · Run 审计          │
│   绝不 DIY 调度哲学(preset persona + 引擎)                    │
├─────────────────────────────────────────────────────────────┤
│ 第二层 dsh-orgos 适配层(官方有接口不完善 → 我们提升)           │
│   MemberBackend seam(member-session 默认;member-codex/acp    │
│   = 官方 subagent/ACP provider 的包装,M3+)                    │
│   IM 审批呈现(user-approval 的 IM Provider)                   │
│   TaskBoard CAS(借官方 team 设计,自建实现)                    │
│   team-state 域(官方 storageDomain 的首个域 Consumer)         │
│   角色资产包(官方 preset authoring + 团队级覆盖注入)           │
├─────────────────────────────────────────────────────────────┤
│ 第一层 官方层(直接用,零自建)                                   │
│   agents/sessions · subagents(6 provider)+workflow            │
│   user-approval · settings/credentials/attachment/schedule    │
│   storageDomain(域数据设施) · client UI(slots/settings/预设)  │
└─────────────────────────────────────────────────────────────┘
        依赖方向:上层消费下层;每层内部按官方 seam 三角组织
        (definition / provider / consumer),未来官方提供同类
        seam 时,下层可整体替换而不动上层语义。
```

**换 Provider 即换产品(官方 seam 哲学的我们对偶)**:官方换 provider 换执行引擎;我们换 provider 换"成员的承载方式"(session 进程内 / ACP 进程外 / Codex CLI)——组织的语义、路由、scope、记忆全部不变。

---

## 4. 分模块整合设计

### 4.1 成员运行时(MemberBackend)
- **保持不变**:member-session 默认后端(官方 team 文档自证 Lead 绑定等限制,ADR-002 四冲突仍成立)。
- **融合升级**:
  1. 恢复路径借鉴官方 team 的"provisioning 快照 + child 对账"严谨性(我们的 ensure 目前无对账,进程崩溃后 sessionId 与成员状态可能失配);
  2. M3+ 新后端全部基于官方 seam:member-codex/member-claude-code = 官方 `subagent-codex/claude-code` provider 包装;member-acp = 官方 ACP(其"仅面向自动化"定位与成员无 UI 场景天然契合);member-remote = 官方 dsh-sdk;
  3. 能力档案(capabilityProfile)→ 官方 subagent 的 capabilities flag 对齐,未来 `target: auto` 路由按官方 provider 能力选后端。

### 4.2 协作三件套(Mailbox/TaskBoard/团队状态)
- **自建保留**:组织树 scope 投影是官方 team 没有的,团队层语义必须自建。
- **借官方设计**:TaskBoard 立即补 CAS(`expectedRevision`)+ tombstone + DAG 依赖(官方 design note 直接批判了我们当前"owner 当锁"的做法)——**自建实现,不依赖 experimental 包**。
- **转正后评估(观察位)**:官方 team 转正且 API 稳定后,把"存储原语"(roster/mail/task 的持久化)下沉官方,我们保留投影/治理层——两层分工:官方=原语,我们=组织语义。

### 4.3 委派/调度(绝不 DIY)
- 官方 workflow 是成员内部任务图(FR-D6),**组织委派状态机自建**——两条线正交,互不替代。
- 融合:orchestrator 委派 → 成员 inbox(官方 session 注入);成员内部再派生 = 官方 subagent/workflow;失败重派 ≤3 = 我们引擎(官方无哲学)。
- 未来增强:官方 team 转正后,其 task DAG 可作为"委派任务图"的可视化/校验层(状态机仍是我们的)。

### 4.4 IM 网关(7 通道)
- 官方完全缺失且无规划 → **纯差异化,长期自建**。
- 官方可吸收:webhook 型 IM 的 HTTP 路由已用官方 webServer;入站统一走官方 agent.inject/session;出站流式未来评估官方 session 事件。
- 我们提升官方没有的:多通道多 bot、路由回退、每 peer 会话绑定、@ 提及、审批卡片——官方 IM 生态(社区 lark 插件)与我们定位不同(它们是"桥",我们是"组织入口")。

### 4.5 审批闭环
- 官方完善面(waterfall/answerer/超时 deny)零自建;我们的全部价值 = **IM 呈现层 Provider**(prepend 抢答 + 卡片 + 回执)——这正是"官方有且完善就用,官方没有的呈现我们补"的标准形态,已实现,保持。

### 4.6 UI(team-ui / Run 面板)
- 官方 slots/settings 生态直接注册(已做);预设管理 UI 让给官方 authoring,我们只保留团队语义面(角色-岗位绑定视图)。
- Run 面板:官方无 → 自建差异化(visibility 投影 + 审计),数据模型从 M1 起已按官方"模型可见 ⟺ 有日志"原则设计,可直接消费官方 session/usage 事件。

### 4.7 持久化/状态(重大升级点)
- **迁移方案**:team-state 的 JSONL 自建 store → 迁移到官方 `ctx.storageDomain`(域数据设施 seam):
  1. 我们定义"team-state 域"schema(org 快照/registry/mailbox/taskboard/delegations/memory/runs 七个流);
  2. 官方提供 json(基线)与 sqlite 后端——我们免费获得官方持久化质量与后端切换;
  3. 我们的 TeamStore 接口保持不变(纯领域层不受影响),只换 dsh 绑定层的实现;
  4. 时机:M3 起步(官方 storageDomain 在 rc.8 刚出现,观察一版再迁;迁移前保持自建 JSONL 可回放)。
- 凭据/附件/会话持久化:已全用官方,零动作。

### 4.8 预设/角色资产包
- 官方 authoring(rc.8)接管文件级操作;我们保留:播种器(模板就位)、teamCtx 团队级覆盖注入(`!!js`)、角色资产包语义(角色-岗位-模型-沙箱-记忆-scope 打包)。
- 跨 profile 预设可见性体验问题(rc8 排查根因):三层修复——文档+doctor 诊断+upstream issue(预设挂载失败 UI 应显式报错而非静默回退)。

### 4.9 心跳/记忆/digest
- 心跳定时用官方 schedule(已做);折叠链/三层记忆/digest 官方无 → 自建差异化,长期不动。

---

## 5. 产品定位与叙事(互补共存,高于官方)

**一句话定位**:官方给执行引擎与基础设施,dsh-orgos 给组织——把 harness 从"工具"变成**组织操作系统**。

| 维度 | 官方(rc.8 路线) | dsh-orgos |
|------|-----------------|-----------|
| 层次 | 执行层 + 任务层 + 基础设施 | **组织层**(治理/信息流/人机组织学) |
| 生命周期 | 会话内、Lead 绑定、进程即生命周期 | 常驻组织、成员无父、跨会话持久 |
| 入口 | Web/CLI | **IM 优先(7 通道)+ Web** |
| 成员 | 派生子代理(纯 agent) | 岗位/占位者(人机同构、替代演进) |
| 哲学 | 机制(派生/投递/任务) | **机制 + 绝不 DIY + 重派 ≤3 + 升级链** |
| 信息 | 无投影模型 | **六条流 + 五维 scope + 三层记忆** |
| 关系 | — | 官方 seam 的**组织层 Consumer/Provider**,互补共存 |

**高于官方的含义**:不是代码比官方好,而是在官方之上的**语义层**(组织治理、人机混合、IM 运营、调度哲学)——这些官方不做,我们做深;官方 seam 每强一分,我们就多一个可替换的执行引擎,组织的语义资产一分不丢。

---

## 6. 演进路线图(对齐官方节奏)

| 阶段 | 官方节奏锚点 | 我们动作 |
|------|-------------|---------|
| **阶段 1:用官方(M2 收尾)** | rc.8 | ①实跑验收 rc.8 ②预设挂官方 subagent/workflow(FR-D6)③bundle 挂 codex/claude 行(层次 A)④TaskBoard CAS 借官方设计补强 ⑤预设 authoring 对齐 + 体验三层修复 ⑥打包固化 |
| **阶段 2:高于官方(M3)** | 官方 team 仍 experimental | ①npm 全量发布 ②集团治理(ACL/BG 隔离)③人机混合完整体验(FR-H8/决策卡)④Run 面板 ⑤team-state 迁 storageDomain(观察一版后)⑥新叙事 README + awesome 收录 |
| **阶段 3:互补共存制度化(M3+)** | 官方 team 转正 / ACP·SDK 演进 | ①官方 team API 稳定 → 存储原语下沉评估(保留投影/治理层)②member-codex/claude-code/acp 后端基于官方 provider ③多机部署跟进官方 dsh-sdk ④ADR-005 决策滚动更新 |
| **持续机制** | 每版 rc 发布 | seam diff 扫描 → 本方案与 rc8-适配分析核对更新 → 决策点复议 |

---

## 7. 风险与约束

| 风险 | 缓解 |
|------|------|
| 官方 experimental team 转正时 API 原子重命名 | 我们零依赖 experimental 包(只借设计思想);转正后再评估 |
| storageDomain 语义变化 | 观察一版再迁移;TeamStore 接口隔离纯领域层 |
| 官方未来做 IM/组织(方向变化) | 我们已用官方 seam 组织自建能力,可吸收/共存;叙事随 rc 逐版重校 |
| 官方 subagent 不变量未来放宽(四冲突消失) | 正是 ADR-002 预留的 seam 吸收点——届时 member-session 可退为可选后端,零重写 |
| profile 装配脆弱性(tmp tgz/双进程) | 阶段 1 npm 发布 + 单进程部署文档 + 打包固化 |

## 8. 决策点(请用户拍板)

1. 是否采纳本方案总纲(三原则 + 三层架构)?
2. TaskBoard CAS 补强、FR-D6 预设挂官方工具、bundle 挂 codex/claude 行——是否列入 M2 收尾立即做?
3. team-state 迁移官方 storageDomain:定在 M3(观察一版后)是否认可?
4. 本方案是否升格为 ADR-006(融合互补策略决策)?
