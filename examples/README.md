# examples/ — 团队配置样例(权威源 = packages/tools/src/templates.ts,一致性测试保证不漂移)

| 文件 | 场景 |
|------|------|
| `team-small.yml` | 小组:org → team → positions(1 orchestrator + 2 专家,人机混合) |
| `team-dept.yml` | 部门:org → dept → team ×2(每 team 一个 orchestrator) |
| `team-group.yml` | 多 BG 集团:org → bg → dept → team 三级分层 |
| `team-hybrid.example.md` | **多 bot 同群 + 人机混合** 配置说明(进阶场景) |

使用:`team_setup init`(scale: small/dept/group)用权威模板初始化;
进阶直接复制样例到 `${DSH_HOME}/team-state/team/team.yml`(替换群 ID/open_id 后重启)。

## 进阶能力(模板保持最小,按需在岗位上加)

- **岗位替换/知识交接**:给岗位加 `handover: { inheritMemory: team, reassignOpenTasks: transfer }`
  (取值:inheritMemory = private/team/org;reassignOpenTasks = transfer/keep/cancel),
  然后用 `team_setup replace`(agent↔human↔preset 升级)触发交接清单 + 初始记忆注入。
- **三层记忆**:成员用 `team_memory_save` 沉淀 team/org 层显式提炼;
  `team_memory_recall` 按 memory scope 强制投影(私有记忆 = 成员自己的 session 历史)。
- **岗位权限微调**:`roles:` 按 preset 覆盖五维 scope(visibility/authority/memory/subscription)。
