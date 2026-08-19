# dsh-orgos

> **DeepSeek Harness 上的组织操作系统** —— 把「IM 路由 + 常驻团队 + 绝不 DIY 调度哲学」三者合一,人机混合组织的开源插件。

dsh-orgos 让你在 DeepSeek Harness(DSH)之上构建并运营一支**组织化团队**:虚拟员工(agent)与人类员工同处一张组织树,IM 是入口,调度有纪律,规模从小队到多 BG 集团一套模型。

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

## 架构要点

严格继承 DeepSeek Harness 设计理念:

- **Everything is a plugin**:能力全部是 Cordis 插件行,经组合包(bundle)`cordis.patch.yml` 层插入,零 fork、零侵入;
- **两平面**:跨会话服务(团队注册表/IM 网关/邮箱/任务板)在 host composition;角色人格/工具在 agent preset(自动播种到用户目录,绝不触碰 shipped 预设);
- **Capability seams**:IM 适配器为 seam(统一 `MessageGateway` + per-IM provider),新 IM 一个包接入;成员运行时(MemberBackend)同样为 seam,agent 与 human 是两种后端;
- **事件驱动**:一切经 DSH 事件流衔接,团队自有 `team/*` 命名空间。

## 目录

```
packages/
├── core/          # domain/(纯领域内核,harness-agnostic)+ dsh/(DSH 绑定层)
├── im-gateway/    # MessageGateway seam + 消息规范化
├── im-feishu/     # 飞书适配器(WS 长连接,已实测)
├── im-telegram/ wecom/ dingtalk/ slack/ discord/ whatsapp/
├── tools/         # 团队工具(delegate/status/mail/task/setup/doctor/run)
├── ui/            # Client 半(团队室数据加载器)
└── bundle/        # dsh-orgos 组合包(dsh.bundle manifest)
examples/          # 团队配置样例(小组/部门/集团/多 bot 同群)
```

## 路线图

| 阶段 | 状态 |
|------|------|
| M1 核心 + 飞书 + 双端实跑 | ✅ 完成 |
| M2 全 IM + 审批 + Run 数据 | 🔨 进行中(6 适配器纯逻辑完成;telegram 可实测;其余待凭据联调) |
| M3 集团治理 + 发布 | 🔲 计划中 |

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。核心约定:新 IM 适配器 = 独立包 + fixture 测试;单测覆盖率 ≥ 80%,关键路径 Given-When-Then;文档与代码同步。

## License

[MIT](LICENSE) © shisan13
