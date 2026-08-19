# AGENTS.md — dsh-orgos 开发约定(仓库协作约定)

> 供 AI 开发会话与贡献者阅读。项目一句话:**dsh-orgos = DeepSeek Harness 上的组织操作系统**
> ——「IM 路由 + 常驻团队 + 绝不 DIY 调度哲学」三者合一,人机混合组织的开源插件。

## 结构与实现要点

| 模块 | 要点 |
|------|------|
| `packages/core` | `domain/` 纯领域内核(组织树/路由/委派状态机/scope 投影/digest/ACL,零 DSH import,harness-agnostic);`dsh/` DSH 绑定层(TeamService/成员运行时/持久化/播种) |
| `packages/im-*` | IM 适配器:纯协议层(规范化/退避/去重/卡片)+ `dsh/` 绑定层(注册 factory 到 MessageGateway);凭据值由各绑定层自解析(JSON/冒号/裸 token) |
| `packages/tools` | 团队工具(team_delegate/status/mail/task/setup/doctor/run);参数 schema 必须为已编译 JSON Schema object(type/properties/required),禁 undefined 键 |
| `packages/bundle` | 唯一声明 `dsh.bundle` 的组合包;新适配器行 disabled 模板,用户 profile 层启用 |
| `presets/` | 角色预设模板(播种源,只写用户 root,绝不覆盖已有) |

## 质量闸门(不过不打回)

1. 挂载校验:preset/bundle 变更 → `dsh --dump-config` 确认行序 + 实跑验证;
2. 单测红线:覆盖率 ≥ 80%,关键路径 Given-When-Then;
3. 文档一致性:代码与 README/包注释不一致时就近更新;
4. 自我评审:每轮变更按"短中长期兼顾、拒绝 hack;困难留给自己、简单留给用户"自评;
5. 敏感信息(密钥/token/隐私)禁止入代码/文档/日志。

## 硬性红线

- 只改 DSH 用户 root(`~/.dsh/.agent-presets/`、`~/.dsh/skills/`)与本项目目录;绝不改 DSH shipped 预设与其他 harness 目录;
- 危险命令(rm -rf /、chmod 777 / 等)直接拒绝;
- 写用户已有配置文件前必须检查存在性,存在则合并/追加,绝不覆盖。

## 测试装配

本地联调用 `python3 scripts/assemble-packs.py`(手动 tgz 打包 + 依赖 file: 重写);发布走 pnpm publish。
注:`packages/bundle` 无 tsconfig(纯 YAML 组合包),全仓 `tsc` 会报 TS5058 属预期,类型检查按包执行。
