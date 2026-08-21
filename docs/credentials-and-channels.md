# Credentials & Channels Reference

> How every IM channel and document provider gets its credentials and configuration. Related: [Architecture](architecture.md), [Deployment shapes](deployment-and-scale.md), [team.yml field manual](../examples/README.md).

## 1. Where credentials live

All secrets live in **`$DSH_HOME/.credentials.yaml`** (usually `~/.dsh/.credentials.yaml`), managed by the official `dsh-credentials-local` provider:

```yaml
dsh_orgos_feishu_main: 'cli_xxx:yyy'            # value format depends on the adapter, see §3
dsh_orgos_telegram_personal: '123456:AA...'
```

Rules:
- **Key names** = POSIX identifiers (letters/digits/underscore, no `-`); each channel/feature gets its own key so they can be rotated independently.
- **Values** = plain strings; the format is parsed by each adapter binding (§3). Wrong format → the row logs a warning and that channel stays disabled (fail-closed).
- The file is hot-reloaded (a watcher re-reads it); no restart is strictly required to pick up a changed value.
- **Never put secrets in `cordis.patch.yml`, team.yml, logs, or the repo.** Credential *references* (key names) go in config files; values stay in `.credentials.yaml`.

## 2. Three-layer wiring

A channel is wired in three places, each with a different concern:

| Layer | File | What you write |
|-------|------|----------------|
| 1. Credential value | `~/.dsh/.credentials.yaml` | `<key>: '<value>'`(the secret itself) |
| 2. Channel registration | your profile `cordis.patch.yml` → `team-im-gateway` row `config.channels` | `channelName: { provider, credentialId }` — `credentialId` = the key from layer 1 |
| 3. Routing | `~/.dsh/team-state/team/team.yml` `routes:` (or `team_setup bind`) | `{ channel: <channelName>, peerId: <group/user id>, target: <positionId> }` — who hears this channel |

Document providers have only layers 1 and 2 (their row `config` carries the non-secret parts; routing to teams is the provider's own scope logic).

### Telegram example (multiple bots)

Four Telegram bots = four credential keys + four channel entries:

```yaml
# ~/.dsh/.credentials.yaml
dsh_orgos_telegram_main: '123456:AA-main-token'
dsh_orgos_telegram_coder: '123456:AA-coder-token'
dsh_orgos_telegram_finance: '123456:AA-finance-token'
dsh_orgos_telegram_personal: '123456:AA-personal-token'
```

```yaml
# profile cordis.patch.yml — team-im-gateway row
- id: team-im-gateway
  name: 'dsh-orgos-im-gateway/dsh'
  config:
    channels:
      telegram-main:     { provider: 'telegram', credentialId: 'dsh_orgos_telegram_main' }
      telegram-coder:    { provider: 'telegram', credentialId: 'dsh_orgos_telegram_coder' }
      telegram-finance:  { provider: 'telegram', credentialId: 'dsh_orgos_telegram_finance' }
      telegram-personal: { provider: 'telegram', credentialId: 'dsh_orgos_telegram_personal' }

# the telegram adapter row is shared by all telegram channels (one long-poll loop per bot):
- id: team-im-telegram
  name: 'dsh-orgos-im-telegram/dsh'
  disabled: false
  config:
    proxyUrl: 'http://127.0.0.1:8001'   # optional; needed in regions where Bot API is unreachable
```

```yaml
# ~/.dsh/team-state/team/team.yml
routes:
  - { channel: telegram-main,    peerId: '<group id>', target: lead }
  - { channel: telegram-coder,   peerId: '<group id>', target: coder-1 }
  - { channel: telegram-finance, peerId: '<group id>', target: analyst-1 }
  - { channel: telegram-personal, peerId: '<group id>', target: assistant-2 }
```

Verification: restart the demo, then check `/tmp/orgos-gateway.markers.log` for `channel:<name> started` per channel; Telegram long-polling is healthy when `getWebhookInfo` reports `pending_update_count: 0`.

## 3. Credential value formats (per adapter/provider)

| Feature | Row | `credentialId` value format | Non-secret row config |
|---------|-----|-----------------------------|----------------------|
| Feishu IM | `team-im-feishu` | `appId:appSecret`(colon-separated; same key reusable by doc providers) | — |
| Telegram | `team-im-telegram` | bare bot token | `proxyUrl?`, `botUsername?` |
| WeCom | `team-im-wecom` | JSON `{"corpId","secret","agentId","token","encodingAESKey"}` | — |
| DingTalk | `team-im-dingtalk` | JSON `{"appKey","appSecret","robotCode?"}` | — |
| Slack | `team-im-slack` | `botToken:appToken`(colon-separated) | — |
| Discord | `team-im-discord` | bare bot token | — |
| WhatsApp | `team-im-whatsapp` | JSON `{"phoneNumberId","accessToken","appSecret"}` | — |
| Git wiki (`doc-git`) | `team-doc-git` | optional: **ssh private-key file path** (injected as `GIT_SSH_COMMAND`; remote repo only — a local repo needs no credential) | `repoPath`(required), `docsDir?`, `label?` |
| Feishu cloud docs | `team-doc-feishu-docs` | `appId:appSecret`(same format as im-feishu; one key can serve both rows) | `folderToken?`, `folderMap?`(teamId → folder token) |
| Feishu Bitable | `team-doc-feishu` | `appId:appSecret` | `appToken`(required), `tableId`(required), `titleField?`, `bodyField?`, `label?` |
| member-dsh-sdk (C stage) | `team-core` row `config.memberDshSdk` | none to write — the binding resolves `DEEPSEEK_API_KEY` from the same `.credentials.yaml` and injects it into the child process | `sdkClientEntry`, `launch`, `provider?`, `model?`, `positions` |

## 4. Enabling rows

All adapter/provider rows ship as `disabled: true` templates in the dsh-orgos bundle. Enable one by copying the row into your profile `cordis.patch.yml` and dropping `disabled` (see the commented templates in `packages/bundle/cordis.patch.yml`).

## 5. FAQ

**Q: I created more bots on the same platform (e.g. 3 more Telegram bots) — where do I add them?**
A: One credential key per bot in `~/.dsh/.credentials.yaml` (§1), one `channels` entry per bot in the profile's `team-im-gateway` config (§2), one `routes` entry per bot → position in `team.yml`. The adapter row is per-platform, not per-bot.

**Q: Multiple bots in the same group?**
A: Add multiple `routes` entries with the same `peerId` but different `channel`s — whoever is @-mentioned answers (see the field manual FAQ and `team-hybrid.example.md`).

**Q: Feishu docs vs Feishu IM — can they share one credential?**
A: Yes — both parse `appId:appSecret`; one key can be referenced by `team-im-feishu`, `team-doc-feishu-docs`, and `team-doc-feishu` simultaneously (the app must have the corresponding scopes enabled: im/message, docx:document, bitable:app).
