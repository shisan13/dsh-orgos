# 部署形态与大项目研发流程

> 回答两个核心问题:①单机下基于 md 文档能否支撑大型项目全产品研发周期;②虚拟团队分布在不同机器/服务器时怎么办。
> 配套:[架构总览](architecture.zh-CN.md)、[量化团队组建指南](quant-trading-guide.zh-CN.md)、[team.yml 字段手册](../examples/README.zh-CN.md)。

## 1. 部署形态:三阶段,能力逐级打开

| 阶段 | 成员运行位置 | 沟通介质 | 状态与协作 | 适用 |
|------|-------------|---------|-----------|------|
| **A 单机(当前基线)** | 同一 DSH 进程内(懒激活成员会话) | 本机 md 知识目录、邮箱、任务板、飞书多维表格(doc-feishu,天然云端) | team-state 本地 JSONL | 个人/小团队;量化模板即可跑 |
| **B 混合(介质云化)** | 仍单进程 | + 内部 md 迁入共享 git 仓库(team wiki),成员经 git 读写 | team-state 仍在中央实例 | 介质跨机、成员暂不分机 |
| **C 多机(成员远程化)** | 成员 = 独立进程/独立机器(MemberBackend 的 member-acp / member-dsh-sdk 后端) | 共享 git wiki + doc-feishu;会话注入走官方 ACP/SDK | team-state 由中央实例持有(单写者),成员远程接入 | 跨服务器分布式虚拟团队 |

> **B 阶段实现(已落地)**:介质不再靠裸 git,而是统一工具——成员用一套 `team_doc_*`(list/read/create/update/search,`expectedVersion` 做 CAS)读写可插拔文档 provider:`git-wiki`(`team-doc-git` 行,md 文件落在 git 仓库,每次写入自动 commit+push)、`feishu-docs`(`team-doc-feishu-docs` 行,飞书云文档)、`feishu-bitable`(`team-doc-feishu` 行,多维表格行)。三行均为 bundle `disabled` 模板,profile 层启用并配置。知识库存**完整资产**;三层记忆(`team_memory_*`)继续存**提炼事实**。

**判断口诀**:通信介质与执行位置是两件事,可分别演进——先让介质云化(B),再让成员远程化(C)。

## 2. 大项目全研发周期:每一步用什么

以"从 0 到 1 做一个量化交易 App(券商 App 升级版)"为例,单机(A)下的完整闭环:

| # | 环节 | 委派链 | 载体/产物 | 回执关注点 |
|---|------|--------|----------|-----------|
| 1 | 需求收集 | pm-1 调研(web_search/用户反馈)→ PRD 草稿 | `docs/prd/量化App-PRD.md` | 来源与不确定性标注 |
| 2 | 需求评审 | pm-1 → ceo-pmo(决策卡)/product-lead | PRD 终稿 + 需求池(doc-feishu) | 验收口径是否可测 |
| 3 | 设计需求 | product-lead → design-lead(ui-1/ux-1) | 设计稿(外部图床/飞书多维表格附件,**md 内只放引用链接**) | 设计稿链接 + 标注 |
| 4 | 技术方案 | tech-director → 各 lead | `docs/tech/量化App-技术方案.md` | 架构/依赖/风险 |
| 5 | task 拆分到人 | 各 lead → 岗位(team_delegate,Brief 全字段) | 委派单 + 任务板(deps 排依赖) | 每岗一条委派 |
| 6 | 排期 | lead 编排 deps:后端接口 → 前端页面 → App 端 → 联调 | 任务板 deadlineAt + deps DAG | 里程碑节点 |
| 7 | 分批 QA | eng-lead/前端 lead → qa-1 分批验收(Brief: 验收标准 = 本批用例) | 测试报告 md + 委派回执 | 通过/驳回清单 |
| 8 | 前后端独立测试 | qa-1 分别验收后端接口(工程 team)与前端页面(前端 team) | 独立测试报告 | 各自通过 |
| 9 | 统一黑盒测试 | tech-director → qa-1(全链路验收 Brief) | 黑盒报告 + 问题单(任务板) | 通过/风险清单 |
| 10 | 发布 | tech-director → ceo-pmo 审批卡(上线放行)→ 各 lead 公告 | 公告流(team/org 广播) | 灰度/回滚预案 |

要点:
- **设计稿不入 md**:md 存文字资产(PRD/方案/决策);二进制设计稿放外部(图床/飞书多维表格附件),md 内只放**引用链接**(附版本号)。这是 md 介质的能力边界,不是缺陷。
- **分批 QA 与独立测试**:委派语义天然支持——每批测试 = 一条给 qa-1 的委派(Brief.acceptance = 本批用例清单);前后端独立测试 = 对两个 team 分别委派验收;统一黑盒 = tech-director 发起的全链路验收委派。
- **task 拆分到人**:一个"大需求"= 产品(PRD)→ 技术(方案)→ 各 lead 拆 Brief 委派到具体岗位,任务板 deps 表达"接口先行、页面依赖接口、联调依赖页面"。

## 3. 沟通介质矩阵(项目维度 × 汇报关系维度)

| 介质 | 单机(A) | 多机(B/C) | 适用维度 |
|------|---------|-----------|---------|
| 内部 md 知识目录 | 本机 workspace 目录(成员 fs 工具读写) | **共享 git 仓库(team wiki)**:成员 git pull/push | 项目维度(PRD/方案/决策/复盘) |
| 邮箱(team_mail_*) | team-state mailbox.jsonl | 中央实例持有;成员经工具访问(跨机天然可用) | 协作/升级(定向) |
| 任务板(team_task_*) | 同左 | 同左(CAS expectedRevision 防跨实例并发写) | 项目维度(task 状态跟进) |
| 公告(team_mail 广播) | 同左 | 同左 | 汇报关系维度(上→下) |
| 三层记忆(team_memory_*) | 同左 | 同左 | 汇报关系维度(决策/知识沉淀) |
| 飞书多维表格(doc-feishu) | **云端,天然跨机** | 同左 | 需求池/任务表/评审表(外部第三方文档) |
| 设计稿/二进制资产 | 外部图床/附件 + md 引用 | 同左(引用 URL 天然跨机) | 项目维度 |

**结论**:邮箱/任务板/公告/记忆/多维表格在 B/C 阶段都天然跨机(状态由中央实例持有,成员远程接入);**唯一需要改造的是"内部 md"**——从本机目录迁到共享 git 仓库。这是把"本机 md 搞不定"变成"共享 git wiki"的最小改动,不需要重写任何机制。

## 4. 多机落地路径(基于官方能力,非自研)

1. **介质云化(B,已落地)**:profile 层启用文档 provider 行(`team-doc-git` 指向 git wiki 仓库,可选 `team-doc-feishu-docs`/`team-doc-feishu` 接飞书后端);成员经 `team_doc_*` 工具读写知识库(底层自动 git commit/push);md 引用规则不变。
2. **成员远程化(C,M3+)**:MemberBackend seam(ADR-002 预留)新增两个后端,包装官方 provider:
   - `member-acp`:官方 `subagent-acp`(子进程跑 ACP 客户端,可部署到远程机器,经 stdio/SSH 桥接);
   - `member-dsh-sdk`:官方 `subagent-dsh-sdk`(子进程 = 完整对等 DSH 运行时,组合/会话/模型自持)。
   组织的语义(岗位/路由/委派/scope/记忆)零改动——**换 provider 即换成员承载方式**,这正是官方 seam 哲学的对偶。
3. **team-state 单写者**:中央实例持有 JSONL(单写者,无分布式一致性问题);后续迁官方 storageDomain(M3)后可选远端后端。
4. 官方实验性 Agent Teams 转正后,其持久 roster/mailbox/task 原语可评估下沉(投影/治理层仍自建)。

## 5. 结论

- **单机 md 全周期:OK**——大项目研发周期每个环节都有对应机制(§2 十步表),唯二边界:二进制资产(md 只放引用)与跨机场景(md 要迁 git)。
- **多机:设计上已就绪,分两步走**——先介质云化(git wiki + 天然跨机的邮箱/任务板/多维表格),再成员远程化(官方 ACP/dsh-sdk 包装为 member-acp/member-dsh-sdk 后端);当前代码基线是单机,团队状态单写者原则贯穿始终。
