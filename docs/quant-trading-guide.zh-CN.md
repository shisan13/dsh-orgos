# 基于 dsh-orgos 组建量化交易虚拟团队

> 一份从零到跑起来的完整实战指南:30 分钟搭起一个 25 岗位的量化组织(产品/技术双部门、多端研发、数据/策略/风控链路),然后让它像真实公司一样流转——需求、委派、回执、审批、记忆、心跳全链路。
> 本指南基于真实模板 [`examples/team-quant.yml`](../examples/team-quant.yml)(`team_setup init quant`),字段语义见 [examples/README.zh-CN.md](../examples/README.zh-CN.md),架构背景见 [docs/architecture.zh-CN.md](architecture.zh-CN.md)。

---

## 1. 快速组建(30 分钟跑起来)

前置:已安装 DeepSeek Harness,并有一个跑通的 profile(推荐独立 profile,如 `orgos-demo`);本机已有 DSH 官方插件安装通道。

### 第 1 步:安装插件(约 3 分钟)

```bash
# 在目标 profile 目录(如 ~/.dsh/profiles/orgos-demo)安装 dsh-orgos 全部包
cd ~/.dsh/profiles/orgos-demo
pnpm add dsh-orgos dsh-orgos-core dsh-orgos-tools dsh-orgos-ui file:/tmp/orgos-packs/*.tgz   # 本地联调打包方式
# 发布后则为:
# dsh plugin add dsh-orgos
```

编辑 profile 的 `package.json`,在 `dsh.profile.bundles` 中加入 `"dsh-orgos"`;重启 profile。

**预期**:`dsh --profile orgos-demo --dump-config` 的输出中出现 `team-core`、`team-im-gateway`、`team-im-feishu`(默认启用)与其余 IM 适配器行(`disabled: true`)。

### 第 2 步:配置 IM 凭据(约 5 分钟)

凭据只走 DSH credentials(不落配置文件明文)。在 profile 的 `cordis.patch.yml` 里给 `team-im-gateway` 行配置通道,并设置 `team-core` 的 owner/allowlist 白名单:

```yaml
- id: team-core
  name: 'dsh-orgos-core/dsh'
  config:
    ownerIds: ['ou_your_owner_id']        # 你的 IM 用户 id(owner)
    allowlist: []                          # 额外白名单

- id: team-im-gateway
  name: 'dsh-orgos-im-gateway/dsh'
  config:
    channels:
      feishu-main:                         # 通道名 = 路由 channel
        provider: feishu
        credentialId: dsh_orgos_feishu_main
      telegram-personal:                   # 第二个 IM 并行接入(可选)
        provider: telegram
        credentialId: dsh_orgos_telegram_personal
```

再用 credentials 写入凭据(键名与 credentialId 对应;值格式由各适配器绑定层自解析——飞书为 `appId:appSecret`,Telegram 为裸 bot token)。**预期**:重启后 `/tmp/orgos-gateway.markers.log` 出现 `channel:feishu-main conn=connected → started`(本机 3081 实跑验证过的判定方式);`getWebhookInfo`(Telegram)显示 `pending_update_count: 0` 说明长轮询在正常确认。

### 第 3 步:初始化量化团队(约 2 分钟)

```bash
# 在任一 orchestrator 会话中调用(或直接复制模板到 ${DSH_HOME}/team-state/team/team.yml)
team_setup init quant
```

**预期**:团队快照(`/api/orgos/snapshot`)显示 `org: quant-alpha`,25 个岗位在列;`team_status` 输出岗位清单。若直接复制模板,替换占位符 `ou_your_ceo_id`(你的飞书 open_id)与 `oc_your_group_id`(主群 chat_id)后重启。

### 第 4 步:绑定 IM 群(约 5 分钟)

```yaml
routes:
  - { channel: feishu-main, peerId: oc_your_group_id, target: quant-alpha }   # 主群 @bot → org 根(总裁/PMO)
```

主群已经在上面的模板里;加其他群用 `team_setup bind`(channel/peerId/target 三元组,带备份+校验的原子替换):

```
team_setup bind channel=feishu-main peerId=oc_ops_group target=dept-product
```

**预期**:在飞书主群 `@机器人` 发"汇报当前团队状态",消息路由到 `quant-alpha`(ceo-pmo),PMO 回复团队快照;`team/inbound-message` 事件与回执在 markers 可查。

### 第 5 步:首次派发验收(约 5 分钟)

在飞书群 @PMO 下指令:"派给量化研究员,研究 BTC 30 日均线策略的胜率,写一页报告"。PMO(orchestrator)会:

1. 用 `team_delegate` 发起结构化委派(brief 见 §3.1 示例);
2. 消息进入 `quant-researcher-1` 的收件箱(成员懒激活,自动创建会话);
3. 研究员完成 → 回执流 → PMO 收到 digest(结论+指标+验证);
4. 你收到"已完成"通知,`team_run` 可查完整委派时间线。

**验收通过标志**:回执里带结论与验证输出,`delegations.jsonl` 有完整状态流转(queued→dispatched→running→completed)。

---

## 2. 组织设计与岗位职责

### 2.1 组织结构图(25 岗位 / 10 节点)

```
quant-alpha (org) ── orchestrator: ceo-pmo(总裁/PMO,human 示例)
├── dept-product (产品运营) ── product-lead
│   └── team-product
│       ├── pm-1        产品经理(analyst)
│       ├── ops-1       运营专员(assistant)
│       └── content-1   内容运营(assistant)
└── dept-tech (技术) ── tech-director
    ├── team-frontend ── frontend-lead
    │   ├── team-app ── app-lead
    │   │   ├── ios-1        iOS 工程师(coder)
    │   │   ├── android-1    Android 工程师(coder)
    │   │   └── harmonyos-1  鸿蒙工程师(coder)
    │   └── team-web-mini ── web-lead
    │       ├── web-1           Web 前端(PC/H5)(coder)
    │       ├── miniapp-wx-1    微信小程序(coder)
    │       └── miniapp-alipay-1 支付宝小程序(coder)
    └── team-backend ── backend-lead
        ├── team-eng ── eng-lead
        │   ├── java-1   Java 服务工程师(coder)
        │   ├── java-2   交易执行工程师(coder)
        │   └── qa-1     测试工程师(reviewer)
        └── team-data ── data-lead
            ├── data-eng-1          数据工程师(coder)
            ├── quant-researcher-1  量化研究员(analyst)
            ├── strat-1             策略工程师(coder)
            └── risk-1              风控复核(reviewer)
```

### 2.2 岗位职责与预设映射

| 岗位 | 角色预设 | 一句话职责 |
|------|---------|-----------|
| ceo-pmo | human(示例) | 集团目标/项目组合治理、升级兜底、关键决策(风险限额/上线放行) |
| product-lead | orchestrator | 产品运营部门调度:需求池排期、跨团队协调、向 CEO 汇报 |
| pm-1 | analyst | 需求收集/PRD 撰写/验收口径定义 |
| ops-1 / content-1 | assistant | 运营活动与内容产出(公告、教程、社群) |
| tech-director | orchestrator | 技术部门调度:技术选型、跨前端/后端协调、向上汇报 |
| frontend-lead / app-lead / web-lead | orchestrator | 前端线逐层调度:排期、联调协调、质量把关 |
| ios-1 / android-1 / harmonyos-1 | coder | 三端 App 开发与自测,附验收证据汇报 |
| web-1 / miniapp-wx-1 / miniapp-alipay-1 | coder | PC/H5 与双小程序开发 |
| backend-lead / eng-lead | orchestrator | 后端/工程线调度 |
| java-1 | coder | 业务服务/网关开发 |
| java-2 | coder | 交易执行链路开发(下单/风控联动) |
| qa-1 | reviewer | 测试计划/用例/验收复核(质量把关) |
| data-lead | orchestrator | 数据与算法线调度 |
| data-eng-1 | coder | 数据采集/清洗/特征管道开发 |
| quant-researcher-1 | analyst | 策略研究:假设、回测设计、研究报告(附数据来源) |
| strat-1 | coder | 策略工程化:把研究结论实现为可回测/可上线的策略代码 |
| risk-1 | reviewer | 风控复核:回测结果核查、限额校验、上线前风险评估 |

> 预设工具面:coder/analyst/assistant/reviewer 均已挂官方 `subagent`/`subagent_fork`/`tool-workflow`(内部派生)与 `web_search`(实时信息);orchestrator 预设另挂 `team_delegate`/`team_status`/`team_setup`(绝不 DIY:只协调,不代执行)。

### 2.3 人机混合建议与替代演进

| 岗位 | 建议占位 | 理由 |
|------|---------|------|
| ceo-pmo | **human**(模板已示例) | 决策卡交互(同意/驳回/修改),人工兜底与授权边界 |
| pm-1 | human 或 analyst | 需求"拍板"与业务语境敏感;纯 agent 起步可用 analyst,后续换 human 零配置迁移 |
| 其余执行/治理岗位 | agent | 研发/研究/风控执行适合虚拟员工 |
| qa-1 / risk-1 | agent(reviewer) | 复核类岗位天然适合"只验收不执行"的 reviewer 人格 |

**替代演进 = 换占位者**:`team_setup replace target=pm-1 newKind=human newImChannel=feishu newImUserId=ou_xxx` —— 系统自动生成交接清单、按 handover 策略处理进行中任务、写入交接记录(team_memory_save kind: handover)。替代率只是配置事实,组织树/路由/权限/历史全部随岗位延续。

---

## 3. 工作机制

### 3.1 产品研发流程规范(需求 → 上线)

每一环都是"委派 → 认领 → 执行 → 回执",工具统一为 `team_delegate`(orchestrator 用)+ `team_task_*`(成员用)。

| 环节 | 委派方 → 接收方 | 产物(内部 md 目录,见 §3.3) | 回执关注点 |
|------|----------------|---------------------------|-----------|
| 需求收集 | ceo-pmo → pm-1 | `docs/prd/<编号>-<名称>.md` | 需求清单+优先级建议 |
| PRD 评审 | product-lead → qa-1(评审) | 评审记录 | 验收口径是否可测 |
| 技术排期 | product-lead → tech-director → 各 lead | `docs/tech/方案.md` | 排期与依赖 |
| 开发 | 各 lead → coder | 代码 + `docs/tech/决策记录.md` | 验收证据(测试输出) |
| 测试 | eng-lead → qa-1 | 测试报告 | 通过率/阻塞项 |
| 验收 | product-lead → qa-1 + pm-1 | 验收结论 | 是否符合 PRD 验收标准 |
| 发布 | tech-director → java-2(发布执行) | 发布记录 | 灰度指标/回滚预案 |

**Brief 字段示例(真实量化场景)**:让 `quant-researcher-1` 研究一条均线策略:

```
team_delegate
  target: quant-researcher-1
  task: 研究 BTC 30 日均线(MA30)趋势策略的统计胜率与适用区间
  background: 数据管道已就绪(team-data 内);初版只做研究,不涉及上线
  workingDirectory: /Users/you/workspace/quant-alpha/strategies/ma30
  requirements:
    - 用 2023-2026 日线数据做样本,滚动窗口验证
    - 胜率=盈利交易数/总交易数;给出平均收益/最大回撤/夏普
    - 结论须附数据来源与统计口径
  constraints:
    - 不引入未来函数(信号当日收盘后计算)
    - 单笔仓位 ≤ 2%
  protectedFiles:
    - config/secrets.yaml        # 含敏感配置,禁止读取/修改
    - data/raw/                  # 原始数据只读
  acceptance:
    - 输出一页研究报告(md),含:结论、三张指标表、一句适用性判断
    - 报告附可复现命令(回测脚本路径+运行参数)
  verification: python backtest.py --strategy ma30 --period 2023-2026
  timeoutMinutes: 60
```

**回执 digest 怎么读**:成员完成 → 派发方收件箱收到 digest(确定性模板生成,非模型自由发挥):`结论`(一句话)、`指标`(如 `胜率: 54.2%`)、`验证`(验收命令输出)。细节留在本层,`team_status` 可下钻完整报告——这就是"向上汇报带结论,细节留本层"。

### 3.2 项目管理:委派单 / 任务板 / 里程碑 / 失败处理 / 心跳

**委派单**:每一条委派 = 一份状态机记录(queued→dispatched→running→completed/failed),`team_run` 查全时间线与重派次数。

**任务板**(`team_task_*`):任务带 `revision`(CAS 防陈旧覆盖),可 `deps` 声明依赖。里程碑排依赖示例:

| 任务 | 依赖 | 负责 | 说明 |
|------|------|------|------|
| 数据管道 1.0 | — | data-eng-1 | 先行:数据是一切前提 |
| MA30 研究 | 数据管道 | quant-researcher-1 | 研究基于数据 |
| 策略实现 | MA30 研究 | strat-1 | 实现依赖研究结论 |
| 交易执行接入 | 策略实现 | java-2 | 上线依赖策略代码 |
| 上线复核 | 策略实现 + 执行接入 | risk-1 + qa-1 | 发布前双复核 |

**失败处理(绝不 DIY)**:成员失败 → orchestrator 不接手,而是用 `team_status`/历史诊断卡点 → **优化 brief 重派 ≤3 次**(attempt 递增、brief v2/v3)→ 仍失败 → `failed-final` → **升级父层 orchestrator**(不可跳级)→ ceo-pmo 兜底(决策卡)。

**心跳节奏**:成员自检(schedule,默认 30 分钟)→ 团队折叠 → 逐层上递;orchestrator 跟进任务板卡点/超时委派(`timeoutMinutes` 过期即进超时路径)。异常(卡点/失败)即时升级,不等下一跳。

### 3.3 沟通介质

**内部 md 文档(团队知识目录)**:所有产物落 md,命名带编号;谁写谁负责更新:

```
team-state/team-wiki/           # 或成员工作区 docs/
├── docs/prd/2026-001-量化App-PRD.md      # pm-1 写
├── docs/tech/2026-001-技术方案.md        # tech-director/各 lead 写
├── docs/tech/决策记录-2026-001.md        # 技术决策,data/eng 写
└── docs/memory/                            # 复盘沉淀入口(与三层记忆对应)
```

**外部第三方文档(飞书多维表格,doc-feishu provider)**:需求池/任务表同步到飞书,团队可在 IM 之外查表。配置(`team-doc-feishu` 行,`disabled` 模板,启用后按需配):

```yaml
- id: team-doc-feishu
  name: 'dsh-orgos-doc-feishu/dsh'
  disabled: false
  config:
    credentialRef: dsh_orgos_feishu_main
    appToken: <多维表格 appToken>
    tableId: <表格 id>
```

**邮箱(协作流)** `team_mail_send`:

| kind | 场景 | 示例 |
|------|------|------|
| note | 同层协作/澄清 | 前端问后端接口字段;产品问技术可行性 |
| result | 交付/结果回传 | 数据工程师把特征说明发给研究员;QA 把测试结论发给 PM |
| escalation | 升级求助 | 研究员数据卡点升级给 data-lead |
| (广播) | 团队/集团公告 | 产品 lead 发 team 公告:版本发布窗口 |

跨 team 协作受 ACL 约束(本模板:产品↔技术 note/result,前端↔后端 note/result),block 优先、未声明即拒。

**三层记忆**(`team_memory_save`):

| 层 | 写入者 | 内容 |
|----|--------|------|
| 私有 | 成员自己 | 会话历史(DSH 持久化)+ MEMORY 提炼,团队不可见 |
| 团队 team | 成员贡献 + 各层 orchestrator 提炼 | 决策记录(kind: decision)、复盘(kind: insight)、交接(kind: handover) |
| 集团 org | 高层 orchestrator | 跨部门战略/公告/复盘汇总 |

写法示例:`team_memory_save level=team kind=decision content="MA30 策略经回测胜率 54.2%,暂缓上线;待增加趋势过滤后复测" digest="MA30 暂缓:胜率未达标"`——digest 是上层阅读压缩,每层折叠一次,天然摘要链。

### 3.4 汇报关系维度:逐层 digest 折叠 → CEO 晨报

每一层只向**直接上层**递 digest,每层折叠一次,形成摘要链:

```
member 自检/回执 → team-lead 折叠 → dept 折叠 → CEO/PMO
ceo-pmo 早上的收件箱 ≈ 一份"晨报":
  - [产品] App 2.0 冒烟测试通过,预计周五发版
  - [技术-后端] 交易执行接入完成 3/5,1 项阻塞(数据延迟)已升级
  - [技术-数据] MA30 研究完成:胜率 54.2%,建议暂缓(已折叠:3 条研究简报 → 1 条结论)
```

升级链不可跳级:`risk-1` 的问题先到 `data-lead` → `backend-lead` → `tech-director` → `ceo-pmo`;每一层决定是否继续上抛。

---

## 4. 量化项目特有机制

### 4.1 策略研发四岗接力(委派链 + ACL)

```
研究(quant-researcher-1,analyst)
  → 回测(strat-1,coder):把研究结论工程化
  → 复核(risk-1,reviewer):回测结果与风控约束核查
  → 上线(eng-lead → java-2,coder):交易执行接入 + 发布
```

委派链沿管辖子树进行:data-lead → researcher → (研究完成,回执)→ data-lead → strat-1(依赖研究结论)→ data-lead → risk-1 → tech-director → java-2(跨 team?data-lead 管辖 team-data,java-2 在 team-eng——**跨子树需上层中转**:tech-director 接到 data-lead 的交付后,再派给 eng-lead/java-2;或走升级流)。ACL 保证横向协作(研究 ↔ 数据 note/result)不越权。

### 4.2 数据链路与依赖

```
data-eng-1(采集/清洗/特征管道)→ 特征数据集 → quant-researcher-1(研究)
  → strat-1(策略代码)→ risk-1(复核)→ java-2(执行接入)→ 线上
```

依赖用任务板 `deps` 显式声明(如"策略实现"依赖"MA30 研究"),CAS 保证不陈旧覆盖;被依赖任务未删时不可误删(引用完整性)。

### 4.3 风控与审批(IM 卡片)

交易相关操作一律走审批卡(复用官方 user-approval,成员执行时触发,IM 呈现 Allow/Deny 按钮,10 分钟超时自动拒绝 fail-closed):

| 场景 | 触发 | 审批人 |
|------|------|--------|
| 策略上线 | java-2 执行发布前置审批 | ceo-pmo(human 决策卡) |
| 仓位限额调整 | java-2/strat-1 改配置 | ceo-pmo |
| 大额回测消耗 | quant-researcher 申请 | data-lead |

### 4.4 模型分级(roles 覆盖)

研究/策略岗用 Pro,执行/运营岗用 Flash。在 team.yml 的 `roles` 段按角色 preset 覆盖(团队级收紧,不依赖模型自觉):

```yaml
roles:
  orgos-analyst:            # 研究员/产品经理:复杂推理
    visibility: self
    authority: self
    memory: [private, team]
    subscription: [self, team]
  # 模型分级经 preset 注入(teamCtx.memberModel),团队配置声明:
  # analyst/coder 用 Pro 或 Flash 由 profile 的模型行按岗位覆盖
```

> 模型选择的实际接线在 preset 的模型行(config `!!js ctx.teamCtx.memberModel...`);`roles` 段只做五维 scope 覆盖。具体模型取值以 profile 配置为准。

---

## 5. 跨团队协作示例:一条端到端需求

**需求**:ceo-pmo 在飞书主群说"做一版量化 App,用户能看 BTC 均线信号"。

```
① 委派流   ceo-pmo →(team_delegate)→ pm-1 产出 PRD(3 天)
② 委派流   product-lead → tech-director → 各 lead 技术排期
③ 协作流   pm-1 →(team_mail_send note)→ web-lead 澄清"信号推送频率"
④ 委派流   frontend-lead → web-1 开发 H5;app-lead → ios-1/android-1/harmonyos-1 三端
⑤ 委派流   backend-lead → eng-lead → java-1 服务、java-2 信号推送;data-lead → data-eng-1 数据、strat-1 信号计算
⑥ 协作流   frontend ↔ backend(team_mail_send result)联调接口
⑦ 回执流   各成员完成 → 对应 lead 收 digest → 逐层折叠上报
⑧ 公告流   product-lead 广播"灰度发版时间"到 team-product;ceo-pmo org 广播
⑨ 审批卡   java-2 上线触发 user-approval → ceo-pmo 决策卡[同意]
⑩ 记忆流   data-lead 沉淀复盘:team_memory_save kind=insight"信号延迟问题与根因"
⑪ 心跳流   全程成员自检/lead 跟进,卡点即时升级
```

六条流全部出现:委派(①④⑤)/回执(⑦)/协作(③⑥)/公告(⑧)/记忆(⑩)/心跳(⑪);审批作为"上线放行"的必经卡点。

---

## 6. 运维与扩展

### 6.1 team_doctor 自检清单

| 检查 | 看什么 | 修复建议示例 |
|------|--------|-------------|
| team-config | 组织加载、岗位数 | team.yml 校验失败 → `team_setup validate` 看错误清单 |
| members | 岗位与占位者状态 | 成员 offline 属正常(懒激活);failed 需查会话 |
| delegations | 委派/任务/邮箱积压 | 卡点任务 → 诊断重派或升级 |
| store | 状态目录可写 | 权限/磁盘问题 |
| federation | 集团联邦(单实例未启用) | 集团期启用 |

**观察项**:IM 连接状态(markers:`channel:* conn=connected`)、心跳折叠是否按时。

### 6.2 扩展岗位与新策略组

```
# 加一个岗位(如新端 flutter-1)
- id: flutter-1
  title: Flutter 工程师
  teamId: team-app
  occupant: { kind: agent, preset: orgos-coder }
# 加一个策略组:新增 team 节点 + data-lead 之下挂 team-strategies
- id: team-strategies
  kind: team
  orchestratorPosition: strat-lead
  children: []
# 对应新增岗位与路由;更新 acl(跨组 note/result)与 roles
```

用 `team_setup replace` 换占位者;新增行后重启生效(成员列表热加载)。

### 6.3 规模再大:升层级(bg 化)

超过几十个岗位时,在 org 下加 `bg` 层把部门归类(如 `bg-quant` 管产品+技术,`bg-ops` 管运营):

```
quant-alpha (org) → bg-quant(bg) → dept-product / dept-tech → …(原树整体下沉一层)
```

委派深度上限(默认 3)不够时同步调大 `acl.delegationDepthMax`(或保持 3,靠"逐层中转"治理)。

### 6.4 多 IM 群绑定模板

```yaml
routes:
  - { channel: feishu-main, peerId: oc_your_group_id, target: quant-alpha }   # 主群 → PMO
  - { channel: feishu-main, peerId: oc_tech_group, target: dept-tech }        # 技术群 → 技术总监
  - { channel: telegram-personal, peerId: '-5303218893', target: assistant-2 } # Telegram 专属入口(需先建岗位)
```

多 bot 同群:@谁触发谁(模板自带示例);每个 peer 独立会话(DM 隔离)。

---

## 7. 相关文档与下一步

- 字段手册:[examples/README.zh-CN.md](../examples/README.zh-CN.md);架构:[docs/architecture.zh-CN.md](architecture.zh-CN.md)
- 模板:[examples/team-quant.yml](../examples/team-quant.yml);小组/部门/集团模板同目录
- 工具:12 个 `team_*` 工具定义见 `packages/tools/src/dsh/registerTeamTools.ts`(team_delegate/status/mail_send/mail_recv/task_create/task_claim/task_complete/run/memory_save/memory_recall/doctor/setup)
- 下一步:接第二个 IM、启用 doc-feishu 需求表、接入真实数据源让研究员跑真回测、集团 bg 化。
