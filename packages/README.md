# packages/(monorepo)

monorepo 包结构规划见[架构总览](../docs/architecture.zh-CN.md)与内部技术设计(仓库外 `~/Documents/work/dsh-orgos-docs-internal/doc/tech/`)。

**M1 完成**(Flash 领域内核 + Pro 绑定层);**M2 Flash 完成**:6 个新 IM 适配器纯协议层落地(全仓 vitest 覆盖率 ≥80% 四维,typecheck 零错误,`pnpm -r build` 全过)。

| 包 | 说明 | 状态 |
|----|------|------|
| `core/` | `dsh-orgos-core`:**domain/ 纯领域内核**(组织树/路由/委派状态机/scope 投影/digest/ACL/邮箱/任务板,零 DSH import)+ `dsh/` 绑定层 | ✅ M1(domain Flash + dsh Pro) |
| `im-gateway/` | `dsh-orgos-im-gateway`:MessageGateway seam 定义 + NormalizedMessage 规范化 + 幂等集 + 出站队列 + **重连退避(公共)** | ✅ M1;退避公共化 M2 |
| `im-feishu/` | `dsh-orgos-im-feishu`:飞书/Lark WebSocket 适配器(事件规范化/卡片渲染/长消息分段/重连退避,纯协议层) | ✅ M1 |
| `im-telegram/` | `dsh-orgos-im-telegram`:Telegram 长轮询 getUpdates(轮询循环/Update 规范化/内联键盘/4096 分段) | ✅ M2 Flash |
| `im-wecom/` | `dsh-orgos-im-wecom`:企业微信智能机器人回调(**AES-256-CBC 解密/SHA1 验签/URL 验证**/XML 解析/template_card) | ✅ M2 Flash |
| `im-dingtalk/` | `dsh-orgos-im-dingtalk`:钉钉 Stream Mode(信封解包/机器人消息/卡片回调 params 解析/interactive 模板卡片) | ✅ M2 Flash |
| `im-slack/` | `dsh-orgos-im-slack`:Slack Socket Mode(events_api/interactive 分派/Block Kit/线程回复) | ✅ M2 Flash |
| `im-discord/` | `dsh-orgos-im-discord`:Discord Gateway(DISPATCH 事件/mention 判定/2000 硬限制分段/组件按钮) | ✅ M2 Flash |
| `im-whatsapp/` | `dsh-orgos-im-whatsapp`:WhatsApp Business API webhook(**HMAC-SHA256 验签**/entry 解包/交互按钮) | ✅ M2 Flash |
| `im-wechat/ qq/` | 第三方网关被动适配 | M3(P2) |
| `tools/` | `dsh-orgos-tools`:team_delegate / team_mail_* / team_task_* / team_status / team_setup / team_run 纯逻辑核心 | ✅ M1/M2(核心);工具行注册 Pro |
| `heartbeat/` | 团队心跳 + 成员心跳 framing(状态扫描逻辑在 core 委派引擎的 timeoutOverdue) | ✅ M1(Pro) |
| `ui/` | Client 半(dsh.client + ./client):团队室页签、Run 面板 | ✅ M2 骨架(Pro) |
| `bundle/` | `dsh-orgos`:唯一声明 `dsh.bundle` 的组合包,cordis.patch.yml 在此 | ✅ M1(Pro) |

## 开发命令(根目录)

```bash
pnpm install          # 安装依赖(workspace 链接)
pnpm -r build         # 按拓扑序构建全部包(tsc → lib/)
pnpm test             # 全仓 vitest(bundle 为 YAML 组合包,无测试)
pnpm --filter dsh-orgos-core exec vitest run --coverage  # 单包覆盖率
```

> 注:`pnpm -r exec tsc -p tsconfig.json --noEmit` 会因 `packages/bundle`(纯 YAML 包,无 tsconfig)报错,属预期;类型检查按包执行。

## 包间依赖

```
tools/ ──▶ core/ (domain)
im-* (全部) ──▶ im-gateway/ (seam 契约 + BackoffPolicy)
```

- 开发期 vitest 经 alias 直接跑依赖源码(`vitest.config.ts`);发布构建走 `tsconfig.build.json`(无 paths,解析已发布/已构建依赖)。
- 版本统一 0.1.0,全仓同步发版(技术设计 §3.3)。
- 适配器包结构统一(仿 im-feishu):`events.ts`(平台事件 → NormalizedMessage)+ `cards.ts`(平台卡片渲染)+ `format.ts`(平台字符限制分段)+ `<X>Adapter.ts`(transport 抽象 + 退避/去重/异常隔离)+ `fixtures/`(record-replay)+ 测试;webhook 型(wecom/whatsapp)为被动模式 `handleRequest/handleWebhook`。

## M2 Flash 测试基线

| 包 | 测试数 | 覆盖率(Stmts/Branch/Funcs/Lines) |
|----|--------|----------------------------------|
| im-telegram | 19 | 89.3/82.3/90.9/92.5 |
| im-wecom | 24 | 95.7/84.6/95.2/96.0 |
| im-dingtalk | 14 | 90.1/80.9/84.4/94.3 |
| im-slack | 15 | 91.4/82.8/90.6/92.9 |
| im-discord | 15 | 91.4/80.5/90.3/93.0 |
| im-whatsapp | 15 | 96.4/81.0/96.0/98.1 |
