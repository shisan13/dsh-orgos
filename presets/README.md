# presets/ — 角色预设模板(dsh-orgos-core 播种源)

本目录是 dsh-orgos 角色预设的**模板资产**(ADR-003)。dsh-orgos-core 启动时把
缺省的预设自动播种到用户目录(`${DSH_HOME}/.agent-presets/orgos-*`):

- 只写用户 root,绝不触碰 DSH shipped 预设目录;
- 已存在同名预设 → 绝不覆盖(用户改过的归用户)。

## 角色清单(M2)

| 预设 id | 角色 | 说明 |
|---------|------|------|
| `orgos-orchestrator` | 调度中心 | 团队 orchestration:只协调不执行(绝不 DIY),结构化委派、失败诊断重派、心跳跟进 |
| `orgos-coder` | 工程师 | 编码执行岗(带审批触发的文件/命令工具) |
| `orgos-reviewer` | 评审 | 质量闸门:审查/验收/回归 |
| `orgos-analyst` | 分析师 | 分析/研究/数据 |
| `orgos-assistant` | 助手 | 通用协助/客服类岗位 |

每个岗位在 `team.yml` 里通过 `occupant.preset` 引用;岗位替换(agent↔human↔
preset 升级)用 `team_setup replace`,系统按 §4.7.3 自动生成交接清单并注入新占位者。
