# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 Conventional Commits。

## [0.2.0] - 2026-08-21

### 新增

#### B 阶段:团队知识库(Team Wiki 多 Provider)
- `packages/doc-git`:git wiki 文档 provider —— md 文件落 git 仓库,每次写入 commit+push;CAS 以 HEAD 为版本,无 remote 本地模式自动跳过推送;
- `packages/doc-feishu-docs`:飞书云文档(docx)provider —— 官方端点核实实现;`folderMap` 团队→文件夹目录映射(list/search/create 统一生效),drive/files 分页取全;
- `team_doc_*` 5 工具(list/read/create/update/search)+ TeamService 文档路由(跨 provider 合并、visibility 投影、歧义消解、`expectedVersion` CAS);
- `DocumentProvider` 契约收敛:`DocumentRef.version` + `DocumentUpdateResult`(STALE_DOCUMENT),纯追加零破坏。

#### C 阶段:member-dsh-sdk 后端(P1 进程常驻)
- 成员 = 官方 SDK 子进程(完整对等 DSH 运行时),子会话跨轮次复用(常驻人格/记忆);
- `MemberRuntimeFacade` 统一门面 + `HybridMemberRuntime` 按岗位分流(渐进迁移);
- 绑定层经 credentials 服务解析 `DEEPSEEK_API_KEY` 注入子进程 env(官方 env 整体替换语义,PATH/HOME 自动合并)。

#### M3 第一阶段
- **存储 provider 化**:`SQLiteTeamStore`(node:sqlite,记录格式与 JSONL 逐字节同构)+ `scripts/migrate-store.mjs` 停服迁移(事务/幂等保护/可回退);
- **团队工具远程化**:`TeamToolDefs` 单源(15 个常规工具,13 个远程白名单)+ 新包 `packages/team-rpc`(中央实例 RPC 服务端:每成员随机 token + positionId 恒时比较、白名单不反射、审计落 runs;成员子进程 RPC 客户端:同 schema 注册、fail-closed);
- **成员组合模板**:`scripts/generate-member-composition.mjs`(角色 preset persona → 子进程组合)+ `examples/member-compositions/`;
- 心跳补齐:远程成员心跳经 deliver 上下文合并(不触发独立轮次,上限 3 条)。

### 文档
- `docs/credentials-and-channels(.zh-CN).md`:全部 IM/文档 provider 的凭据位置与格式总表、Telegram 多机器人示例;
- `docs/quant-trading-guide`、`docs/deployment-and-scale`:知识库章节与 B 阶段落地标注;
- README/字段手册同步。

### 内部
- C 阶段验证结论、M3 主线技术方案(含 3081 实跑证据)。

## [0.1.0] - 2026-08-xx

### 新增
- 组织内核(org→bg→dept→team→positions 树/路由/委派状态机/scope 投影/ACL/三层记忆);
- IM 网关 + 飞书/Telegram/企微/钉钉/Slack/Discord/WhatsApp 七适配器;
- 团队工具(team_delegate/status/mail/task/memory/setup/doctor/run);
- 团队室 UI、角色预设、bundle 组合包、示例模板与文档。
