# 凭据与通道配置参考

> 每个 IM 通道与文档 provider 的凭据/配置写在哪儿、格式是什么。相关:[架构](architecture.zh-CN.md)、[部署形态](deployment-and-scale.zh-CN.md)、[team.yml 字段手册](../examples/README.zh-CN.md)。

## 1. 凭据存放位置

所有密钥统一放在 **`$DSH_HOME/.credentials.yaml`**(通常为 `~/.dsh/.credentials.yaml`),由官方 `dsh-credentials-local` 服务管理:

```yaml
dsh_orgos_feishu_main: 'cli_xxx:yyy'            # 值格式由各适配器决定,见 §3
dsh_orgos_telegram_personal: '123456:AA...'
```

规则:
- **键名** = POSIX 标识符(字母/数字/下划线,不含 `-`);每个通道/特性一个键,便于独立轮换;
- **值** = 纯字符串;格式由各适配器绑定层自解析(§3)。格式错误 → 该行告警并停用该通道(fail-closed);
- 文件热加载(watcher 重读),改值后无需重启;
- **密钥绝不进 `cordis.patch.yml`、team.yml、日志或仓库**:配置文件里只写凭据*引用*(键名),值只在 `.credentials.yaml`。

## 2. 三层接线

一个通道在三个地方配置,各管一件事:

| 层 | 文件 | 写什么 |
|----|------|--------|
| 1. 凭据值 | `~/.dsh/.credentials.yaml` | `<键>: '<值>'`(密钥本身) |
| 2. 通道登记 | 你的 profile `cordis.patch.yml` → `team-im-gateway` 行 `config.channels` | `通道名: { provider, credentialId }`,`credentialId` = 第 1 层的键名 |
| 3. 路由绑定 | `~/.dsh/team-state/team/team.yml` `routes:`(或 `team_setup bind`) | `{ channel: <通道名>, peerId: <群/用户 id>, target: <岗位 id> }` —— 谁听这个通道 |

文档 provider 只有第 1、2 层(第 3 层由 provider 自身的 scope 逻辑接管,如 folderMap)。

### Telegram 多机器人示例

四个 Telegram 机器人 = 四个凭据键 + 四个通道条目:

```yaml
# ~/.dsh/.credentials.yaml
dsh_orgos_telegram_main: '123456:AA-main-token'
dsh_orgos_telegram_coder: '123456:AA-coder-token'
dsh_orgos_telegram_finance: '123456:AA-finance-token'
dsh_orgos_telegram_personal: '123456:AA-personal-token'
```

```yaml
# profile cordis.patch.yml —— team-im-gateway 行
- id: team-im-gateway
  name: 'dsh-orgos-im-gateway/dsh'
  config:
    channels:
      telegram-main:     { provider: 'telegram', credentialId: 'dsh_orgos_telegram_main' }
      telegram-coder:    { provider: 'telegram', credentialId: 'dsh_orgos_telegram_coder' }
      telegram-finance:  { provider: 'telegram', credentialId: 'dsh_orgos_telegram_finance' }
      telegram-personal: { provider: 'telegram', credentialId: 'dsh_orgos_telegram_personal' }

# telegram 适配器行按平台共享(每机器人一个长轮询循环):
- id: team-im-telegram
  name: 'dsh-orgos-im-telegram/dsh'
  disabled: false
  config:
    proxyUrl: 'http://127.0.0.1:8001'   # 可选;Bot API 不可直连的地区需要
```

```yaml
# ~/.dsh/team-state/team/team.yml
routes:
  - { channel: telegram-main,    peerId: '<群 id>', target: lead }
  - { channel: telegram-coder,   peerId: '<群 id>', target: coder-1 }
  - { channel: telegram-finance, peerId: '<群 id>', target: analyst-1 }
  - { channel: telegram-personal, peerId: '<群 id>', target: assistant-2 }
```

验证:重启演示后看 `/tmp/orgos-gateway.markers.log` 每个通道出现 `channel:<名字> started`;Telegram 长轮询健康时 `getWebhookInfo` 显示 `pending_update_count: 0`。

## 3. 各凭据值格式(按适配器/provider)

| 特性 | 行 | `credentialId` 值格式 | 非密钥行配置 |
|------|----|----------------------|-------------|
| 飞书 IM | `team-im-feishu` | `appId:appSecret`(冒号分隔;文档 provider 可复用同一键) | — |
| Telegram | `team-im-telegram` | 裸 bot token | `proxyUrl?`、`botUsername?` |
| 企微 | `team-im-wecom` | JSON `{"corpId","secret","agentId","token","encodingAESKey"}` | — |
| 钉钉 | `team-im-dingtalk` | JSON `{"appKey","appSecret","robotCode?"}` | — |
| Slack | `team-im-slack` | `botToken:appToken`(冒号分隔) | — |
| Discord | `team-im-discord` | 裸 bot token | — |
| WhatsApp | `team-im-whatsapp` | JSON `{"phoneNumberId","accessToken","appSecret"}` | — |
| Git wiki(`doc-git`) | `team-doc-git` | 可选:**ssh 私钥文件路径**(经 `GIT_SSH_COMMAND` 注入;仅远程仓库需要,本地仓库零凭据) | `repoPath`(必填)、`docsDir?`、`label?` |
| 飞书云文档 | `team-doc-feishu-docs` | `appId:appSecret`(与 im-feishu 同格式,可共用一个键) | `folderToken?`、`folderMap?`(teamId → 文件夹 token) |
| 飞书多维表格 | `team-doc-feishu` | `appId:appSecret` | `appToken`(必填)、`tableId`(必填)、`titleField?`、`bodyField?`、`label?` |
| member-dsh-sdk(C 阶段) | `team-core` 行 `config.memberDshSdk` | 无需手写 —— 绑定层自动从同一 `.credentials.yaml` 解析 `DEEPSEEK_API_KEY` 注入子进程 | `sdkClientEntry`、`launch`、`provider?`、`model?`、`positions` |

## 4. 启用行

所有适配器/provider 行在 dsh-orgos bundle 中均为 `disabled: true` 模板:复制该行到你的 profile `cordis.patch.yml` 并去掉 `disabled` 即启用(模板注释见 `packages/bundle/cordis.patch.yml`)。

## 5. 常见问题

**Q:我在同一平台又建了几个机器人(如新增 3 个 Telegram bot),配置加到哪个文件?**
A:每个机器人一个凭据键加到 `~/.dsh/.credentials.yaml`(§1);每个机器人一条 `channels` 条目加到 profile 的 `team-im-gateway` 配置(§2);每个机器人一条 `routes` 绑定岗位加到 `team.yml`。适配器行按平台共享,不按机器人重复。

**Q:多个机器人进同一个群?**
A:同一 `peerId` 写多条 route(按 channel 区分),@ 谁谁应答(见字段手册 FAQ 与 `team-hybrid.example.md`)。

**Q:飞书文档与飞书 IM 能共用同一凭据吗?**
A:能 —— 两者都解析 `appId:appSecret`;同一个键可同时被 `team-im-feishu`、`team-doc-feishu-docs`、`team-doc-feishu` 引用(应用需开通相应权限:im/message、docx:document、bitable:app)。
