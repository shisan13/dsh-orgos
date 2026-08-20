# ADR-005(草案):官方 Agent Teams(runtime)与 dsh-orgos 的关系

| 项目 | 内容 |
|------|------|
| 文档版本 | v0.1(草案,待用户决策) |
| 状态 | 提案中 |
| 触发 | DSH rc.8(2026-08-19)孵化官方 `@deepseek-ai/dsh-experimental-agent-team` + `dsh-experimental-tool-agent-team` |

---

## 1. 背景与事实

DSH rc.8 将 Agent Teams 以**实验性包**形态并入内核(`packages/experimental/agent-team`):

| 官方能力 | 实现 |
|----------|------|
| roster | 扁平、上限配置、kebab-case 名字;Lead = 隐式 Team(Root SessionId 即 TeamId) |
| member | **continuable subagent 直接 child**(预留 Session id;仅 Lead 可创建/interrupt) |
| mailbox | Lead 日志持久投递(queued→delivered 对账、去重、target 冷恢复) |
| task-board | CAS(expectedRevision)全快照任务板、DAG 依赖、tombstone |
| 生命周期 | 进程 teardown drain、provisioning 快照与 child Session 对账恢复 |
| 文件边界 | 同 cwd;writeScopes 仅提示性警告,不提供互斥 |

与我们重叠:roster/mailbox/task-board 三大协作机制。差异同样明确:**无组织树层级、无 IM 路由、无调度哲学、无人机混合、无五维 scope**。

## 2. 关键判断:ADR-002 的四个结构性冲突对官方 team 包依然成立

官方 team member = continuable child,正是 ADR-002 判定的 B 方案形态。四个冲突逐条核对:

| ADR-002 冲突 | 官方 team 包现状 | 结论 |
|--------------|------------------|------|
| followup 只接受 live 直接父 | team 消息走 Lead 日志 + target inbox,**父必须活着**(Lead 即 team owner) | 冲突仍在:IM 消息随时到达,我们的成员必须无父常驻 |
| 父离开注册表关闭子森林 | "进程 teardown 仍是最终生命周期 owner,并会 drain continuation Activation" | 冲突仍在:成员生命周期绑定 Lead 进程 |
| 子代理 approval 固定 never | team 文档未提审批;subagent 委派策略未变 | 冲突仍在:FR-I7 IM 审批卡片闭环无法基于官方 team member |
| 子代理 join 父的 preset | "fork child 只捕获 Lead 已完成 turn 前缀" | 冲突仍在:成员人格必须跑自己的角色 preset |

**结论:官方 team 包不改变 ADR-002 的决策。我们的 MemberBackend seam(默认 member-session 后端)继续成立。**

## 3. 提案决策:三层关系

1. **不迁移核心**(基于 §2):组织树/常驻成员/审批闭环保持自有实现;
2. **成员内部可挂官方 team 工具**:官方 `tool-agent-team` 是任务层派生机制的官方原生实现,成员角色 preset 可挂载(FR-D6"成员内部可再用 DSH 原生 subagent/workflow"的官方增强)——**两层正交原则**不变,互不冲突;
3. **观察 promotion 节奏**:官方 team 包是 experimental(发布排除/依赖隔离),若未来官方放宽 subagent 不变量(父绑定/审批/preset join),我们的 MemberBackend seam(ADR-002 预留的 member-remote/member-acp/member-codex)可吸收官方 team 为第二后端,不重写核心。

## 4. 需用户决策

- 是否采纳 §3 的三层关系(默认建议采纳);
- 是否在 coder/orchestrator 预设中**试点**挂载官方 team 工具(需要 bundle 显式启用 experimental 包;当前官方包未随 base 默认挂载,属于"部署显式挂载"形态)。
