# DSH rc.8 适配分析(2026-08-19 发布)

> 面向 dsh-orgos 维护者的版本适配清单。基线:rc.7 → rc.8(536 commits / 1604 files)。

## 1. 结论

**rc.8 对我们的绑定层向后兼容,零紧急适配。** 我们依赖的核心 seam 源码全部未变:

| seam | rc.8 变化 | 状态 |
|------|-----------|------|
| `ctx.agents`(create/resume/inject/list) | 无 | ✅ |
| `ctx.agentPresets`(mount/resolve/selected 事件/settings) | 无 | ✅ |
| `approval/request` waterfall(prepend 抢答) | 无 | ✅ 审批卡片闭环不受影响 |
| `webServer` / tools 注册 / `dsh-schedule` / events / credentials | 无 | ✅ |
| `conversation.view` Slot 契约 | 契约未变;渲染器内部重构 | ⚠️ 实跑验证 team-ui 页签 |

> 2026-08-20 的"预设选择异常"不是 rc.8 兼容问题:根因是 web profile 未安装 dsh-orgos bundle,预设挂载时 `Cannot find package 'dsh-orgos-tools'` 被拒后 UI 回退默认预设(详见本目录 ADR-005 与排查记录)。

## 2. 与我们相关的重大变化

| # | 变化 | 规模 | 对我们的意义 |
|---|------|------|--------------|
| 1 | **官方 Agent Teams 孵化**(experimental) | 3+ commits,2 包 | 任务层扁平机制官方化;关系与决策见 [ADR-005](decisions/ADR-005-官方AgentTeams关系.md) |
| 2 | subagent 产品化:Codex/Claude Code 可安装产品子代理 | 58 commits | §2.4 层次 A 官方强化;coder 岗位用 Claude Code 执行编码更成熟 |
| 3 | code-runtime-python 正式发布(Python SDK agent runtime) | 28 commits | 成员执行引擎新官方选项 |
| 4 | workflow 官方包增强 | 7 commits | 成员内部派生(FR-D6)选项;团队层继续"绝不 DIY",不用 workflow |
| 5 | 官方 ACP 调整 | 3 commits | §2.4 层次 B(member-acp)演进点的官方侧进展 |

## 3. 次要变化(观察/验证项)

| 变化 | 影响 | 动作 |
|------|------|------|
| `commands.execute` 签名增加 `images` 参数 | 我们未用官方 commands(IM `/bind`、`/run` 是自建文本命令) | 零;若未来接入需传参 |
| attachment:`admitEncodedImages` 图片批量准入重构 | 我们绑定层不直接调 attachment 服务(附件只传 ref) | 零 |
| client Slots 渲染器重构(scoped-slots.tsx 新增 909 行) | team-ui 注册契约不变 | 实跑验证团队室页签 |
| agent-loop:取消前缀 finalize、失败 attempt 不 finalize | 成员会话取消语义 | 观察成员中断行为 |
| session:SQLite 持久化布局优化 | 成员会话冷恢复 | 纯收益 |
| llm-deepseek:reasoning content 每轮回传修复 | 成员推理完整性 | 纯收益 |
| commands/events 等杂项(shell/pty/pwsh) | 成员沙箱工具面 | 零 |

## 4. 升级操作清单(每次 DSH 发版后执行)

1. `git -C <checkout> fetch && git log dsh-v<旧>..dsh-v<新> --stat` 扫描 seam 面;
2. 重跑本仓库全量测试 + 覆盖率;
3. 实跑验收:预设挂载/IM 通道/审批卡片/team-ui/Run 面板;
4. 更新本文档与 ADR(如有新 seam 或官方新能力)。
