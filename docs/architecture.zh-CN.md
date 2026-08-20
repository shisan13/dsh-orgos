# dsh-orgos 架构与链路总览

> 面向使用者与贡献者的架构说明(配置字段手册见 [examples/README.zh-CN.md](../examples/README.zh-CN.md))。
> 内部方案/决策文档不随仓库发布,保存在仓库外的内部文档目录。

## 1. 一句话架构

**dsh-orgos 是 DeepSeek Harness(DSH)上的组织操作系统**:官方 DSH 提供执行引擎与基础设施(会话/subagent/审批/存储/UI),dsh-orgos 在其上构建组织层(组织树、IM 路由、委派纪律、人机混合、信息流与 scope)。三者关系:

| 层 | 内容 | 来源 |
|----|------|------|
| 官方层(直接用) | agents/sessions、subagent+workflow、user-approval、settings/credentials/attachment/schedule、client UI | 官方 DSH |
| 适配层(我们提升) | MemberBackend(成员运行时)、IM 审批呈现、TaskBoard CAS、team-state 持久化 | dsh-orgos dsh/ 绑定层 |
| 差异层(我们做深) | 组织树、委派状态机、五维 scope、三层记忆、心跳折叠、Run 审计 | dsh-orgos domain/ 纯领域内核 |

## 2. 包结构

```
packages/
├── core/          dsh-orgos-core
│   ├── domain/    纯领域内核(零 DSH import,可移植):组织树/路由/委派状态机/
│   │              scope 投影/digest/ACL/邮箱/任务板/记忆
│   └── dsh/       DSH 绑定层:TeamService/成员运行时/持久化/播种器
├── im-gateway/    IM seam:NormalizedMessage 契约/规范化/幂等/退避(公共)
├── im-<平台>/     每个 IM 一个包(纯协议层 + dsh/ 注册 factory):
│                  飞书/Telegram/企微/钉钉/Slack/Discord/WhatsApp
├── tools/         团队工具(team_delegate/status/mail/task/setup/doctor/run/memory)
├── doc-feishu/    飞书多维表格文档 provider
├── ui/            团队室页签(Client)
└── bundle/        dsh-orgos:唯一声明 dsh.bundle 的组合包(cordis.patch.yml)
presets/           角色预设模板(播种到用户 root,绝不覆盖用户修改)
examples/          team.yml 三模板(小组/部门/集团,与 tools 模板同源)
```

依赖方向单向:`im-* → im-gateway`,`tools → core(domain)`,`bundle → 全部`。

## 3. 核心模型

### 3.1 组织树与岗位-占位者

- 治理节点:`org / bg / dept / team` 四类,children 组成树;每层可声明 `orchestratorPosition`(该层调度者岗位)。
- 叶子是**岗位 Position**(稳定身份:title/层级/能力档案/权限/任务历史随岗位延续),**占位者 Occupant** 可动态替换:`kind: agent`(角色 preset + 常驻会话)或 `kind: human`(IM 身份)。
- 人机同构:路由、委派、任务板、邮箱、scope、记忆全链路对 human/agent 一视同仁;替代演进 = 换占位者 + 知识交接。**替代率是配置事实,不是架构版本**。

### 3.2 委派状态机(绝不 DIY 的机器化)

```
queued ─投递─▶ dispatched ─认领─▶ running ─完成─▶ completed
                            │
                            └─失败─▶ failed ─诊断改brief重派(≤3)─▶ dispatched(attempt+1)
                                     │
                                     └─attempt=3─▶ failed-final ─▶ escalated(升级父层 orchestrator,不可跳级)
human 占位者:失败/停滞走 催办(nudge)─▶ 升级(escalate)─▶ 转交(reassign),不适用改 brief 重派
任意状态 ─取消/超时─▶ cancelled / timeout(→ failed 路径)
```

约束(服务端强制):目标必须在派发方管辖子树内;委派深度 ≤ delegationDepthMax(默认 3);成员并发 ≤ memberConcurrencyMax(默认 2);brief 缺字段拒绝派发。

### 3.3 六条信息流 + 五维 scope + 三层记忆

| 流 | 方向 | 载体 | 压缩 |
|----|------|------|------|
| 委派 | 上→下 | Brief → 成员收件箱 | 上下文裁剪(只带任务相关材料) |
| 回执 | 下→上 | 结果报告 → 派发方收件箱 | digest 规则模板(结论/指标/验证;细节留本层) |
| 协作 | 横向 | 邮箱 + 任务板 | 不压缩;ACL:block→allowCrossTeam→同 team→deny |
| 公告 | 上→下 | 广播(team/org) | 不压缩;按订阅 scope 投递;不携带任务指令 |
| 记忆 | 沉淀 | 记忆流 JSONL | 本层 orchestrator 提炼后向上推送 |
| 心跳 | 下→上 | 成员自检 → 团队折叠 | 每层折叠一次,天然摘要链 |

五维 scope 全部服务端强制投影(不依赖模型自觉):visibility(看)/authority(做)/tool(用,由 preset 决定)/memory(记)/subscription(听)。层级默认见 examples/README。三层记忆:私有(成员会话历史)/团队/集团。

## 4. 关键链路

### 4.1 IM 入站 → 路由 → 投递 → 回执

```
IM 平台消息 → im-<平台> 适配器(规范化 NormalizedMessage + 幂等去重)
  → team-im-gateway(team/inbound-message 事件)
  → RouterResolver:①路由表(channel,peerId)精确匹配 → 岗位/节点
      ②未绑定群:非 @提及静默;@提及 → 回退 org 根 orchestrator
      ③DM:白名单(owner+allowlist)校验 → 默认入口;白名单外拒绝
      ④治理节点无 orchestrator → 沿父链上抛
  → 成员运行时:懒激活(首条消息创建/恢复成员会话)→ agent.inject() 投递
  → 成员执行(agent:角色 preset 组合;human:IM 任务卡)
  → 回执:agent 完成/失败 → 回执流 → 派发方收件箱 + 出站回送原 peer
```

### 4.2 委派闭环(US1)

```
orchestrator 调 team_delegate(brief) → DelegationEngine 校验(子树/深度/并发/brief)
  → 登记 delegations.jsonl → 投递目标岗位成员收件箱(agent)/任务卡(human)
  → 成员认领 → 执行 → 完成回执(附验证输出)→ digest → 派发方
  → 失败:orchestrator 诊断(读历史/任务板)→ 改 brief 重派(≤3)→ 仍失败升级父层
```

### 4.3 审批闭环(IM 卡片)

```
成员执行触发官方 user-approval → 成员 ctx 监听(approval/request,prepend 抢答)
  → IM 审批卡(Allow/Deny 按钮,value 携带 approvalId)
  → 用户点击 → approval_reply → 回执 resolve → 官方答复;10 分钟超时自动 deny(fail-closed)
```

### 4.4 成员生命周期与心跳

```
懒激活:首条消息 ensure 成员会话(resume 优先,恢复历史)→ 处理 → idle 待命(agent 保持挂载)
状态折叠:agent/status 事件 → offline/idle(待命)/busy(处理中)/failed
心跳:成员自检(schedule 提醒)→ 团队折叠 → 逐层上递;异常即时升级
```

### 4.5 持久化

```
$DSH_HOME/team-state/
├── team/team.yml        主配置(team_setup 备份+校验+原子替换)
├── delegations.jsonl    委派状态机全时间线
├── mailbox.jsonl / taskboard.jsonl / memory-*.jsonl / runs.jsonl
├── snapshots/           快照(冷启动加速)
└── backups/             配置历史(回滚)
成员会话历史 = DSH 原生 session 持久化(不复制);凭据只走 DSH credentials,不落明文。
```

## 5. 官方融合互补策略(公开摘要)

1. **官方有且完善 → 直接用**:subagent/workflow(成员内部派生)、user-approval、session/存储/凭据/UI。
2. **官方有接口不完善 → 我们提升**:MemberBackend 是官方 subagent seam 的组织层镜像;IM 审批呈现;TaskBoard CAS(借官方设计自建);team-state 迁官方 storageDomain(M3 计划)。
3. **官方缺失 → 做深**:组织树、IM 路由、绝不 DIY、人机混合、六条流+五维 scope、三层记忆、心跳折叠、Run 面板。
4. 不依赖官方 experimental 包(转正会原子重命名);每次官方 rc 发布执行 seam 扫描核对。

## 6. 相关文档

- 配置手册(team.yml 全字段 + 四模板):[examples/README.zh-CN.md](../examples/README.zh-CN.md)
- 量化团队组建:[quant-trading-guide.zh-CN.md](quant-trading-guide.zh-CN.md)
- 部署形态与大项目研发流程:[deployment-and-scale.zh-CN.md](deployment-and-scale.zh-CN.md)
- 概要:仓库 [README.zh-CN.md](../README.zh-CN.md)
- 开发约定:[AGENTS.md](../AGENTS.md)、[CONTRIBUTING.md](../CONTRIBUTING.md)
