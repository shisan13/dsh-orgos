# dsh-orgos

> **An organizational operating system for DeepSeek Harness** — combining IM routing, persistent hybrid teams, and the "never DIY" dispatch philosophy into one open-source plugin.

dsh-orgos lets you build and run an **organized team** on top of DeepSeek Harness (DSH): virtual employees (agents) and human employees live in the same org tree, IM is the front door, dispatch is disciplined, and one model spans everything from a three-person squad to a multi-BG conglomerate.

> 中文文档见 [README.zh-CN.md](README.zh-CN.md)。

## What it does

| Capability | Description |
|------|------|
| **IM routing** | Feishu (verified end-to-end) / Telegram / WeCom / DingTalk / Slack / Discord / WhatsApp; groups or DMs bound to positions; in a multi-bot group, @-mention picks who responds |
| **Persistent teams** | Declarative org tree (org→bg→dept→team→positions); each position gets a role preset (persona/tools/model); member sessions persist and recover across restarts |
| **Never-DIY dispatch** | The dispatch center coordinates but never executes: structured delegation, failure-diagnosis reassignment (≤3 attempts), heartbeat follow-up, receipt digests. Task board uses CAS (expectedRevision) so stale agent state cannot overwrite newer state |
| **Human-machine hybrid** | Positions are stable entities, occupants are swappable: the same position can be an agent or a human (IM identity); replacement is evolution, with knowledge handover |
| **Organizational information flows** | Six flows — delegation / receipt / collaboration / announcement / memory / heartbeat; five-dimension scope (visibility / authority / tool / memory / subscription) enforced server-side; three-tier memory (private / team / org) |
| **IM approval** | Sensitive member actions raise an IM approval card (allow / deny); fail-closed on timeout |
| **Observability** | `team_status` / `team_doctor` / `team_run` tools, the `/run` command, HTTP snapshot, run records |
| **Official-capability delegation (FR-D6)** | Members delegate internally with official DSH subagent (spawn/fork) and workflow tools; Codex / Claude Code as member engines via optional Profile Bundles (disabled row templates in presets) — see [Architecture & Data Flows](docs/architecture.md) |

## Architecture: where the capabilities come from, and where they go

None of the capabilities above is a pile of isolated features — they are the direct products of one architecture. The design premise is plain: **what runs today must not be rebuilt as the team grows**. One model spans squad to conglomerate, and scaling up means swapping providers, never rewriting.

### Capability → structure mapping

| Capability | Architecture that supports it |
|------|------------------|
| Multi-IM channels, multi-bot groups | The `MessageGateway` seam: one adapter package per IM, unified message normalization |
| Persistent teams, org tree of any depth | A pure domain core (`domain/`): org tree / routing / ACL decoupled from DSH, driven by declarative config |
| Never-DIY dispatch, failure reassignment | A delegation state machine (queued→dispatched→running→completed/failed→reassign ≤3), deterministic transitions |
| Human-machine hybrid, replacement as evolution | Position/occupant separation: the position is the stable entity; the occupant (agent/human) is a swappable backend |
| Six flows, five-dimension scope, three-tier memory | Server-side enforced projection: tools only ever see data within the caller's scope — filtering is a mechanism, not a prompt request |
| IM approval, fail-closed | The approval waterfall is attached to member sessions; card receipts answer it; auto-deny after 10 minutes of silence |
| Observability | The six flows double as a factual log (runs/mailbox/delegations/memory); snapshots and doctor checks project directly from the log |

### One line: one model, three scales

The org tree `org → bg → dept → team → positions` has arbitrary depth; the three scales are just three shapes of the same tree:

- Squad = org → team (works from a handful of people);
- Department / company = org → dept → team ×N;
- Conglomerate = org → bg → dept → team (multi-BG federation).

Coordination mechanics are scale-independent: each layer may appoint an orchestrator (delegations land where one exists, bubble up where none does); receipts fold upward as **per-layer digests** (member report → team → dept → BG → org; the top only reads conclusions); members are **lazily activated** (on standby at zero cost, woken on dispatch). Adding an org layer is adding config, not complexity.

### Layered kernel: domain decoupled from the host

```
packages/core/
├── domain/   # Pure domain kernel: org tree / routing / delegation state machine /
│             # scope projection / digest / memory — zero DSH imports, zero Node IO;
│             # portable as a whole to another host (harness/framework)
└── dsh/      # DSH binding layer: TeamService / member runtime / persistence /
              # extension API — thin, only wires the environment
```

The domain kernel answers "how an organization runs"; the binding layer answers "how it lands on DSH". Over 80% of unit-test coverage lives in the domain kernel, so its verification travels with it when the host changes.

### Capability seams: every external dependency is pluggable

Every external dependency converges to an interface; implementations are swappable providers:

| Seam | Today | Long term |
|------|------|----------|
| `MessageGateway` (IM channels) | 6 adapters implemented (Feishu verified) | A new IM is one package |
| `TeamStore` (storage engine) | JSONL file storage (correctness first) | SQLite provider plugs in; record format unchanged; migration is a one-time import |
| `DocumentProvider` (document collaboration) | Interface defined | Feishu Docs/Bitable, DingTalk, WeCom, Notion, Confluence — same pattern as IM adapters |
| `OrgFederation` (cross-instance federation) | Interface defined | One host instance per BG; the root orchestrator delegates/folds/heartbeats across instances |
| MemberBackend (member backend) | Agent-session backend (single machine) | subagent-acp / multi-machine member distribution, seam reserved by design |

### Plugins for the plugin: extending orgos = writing a DSH plugin

Inheriting DSH's "everything is a plugin" mindset: **orgos extension points are ordinary DSH plugin rows**. A third-party plugin gets the [Orgos Extension API](packages/core/src/dsh/extensions.ts) via `ctx.get('teamService')`:

- `registerDocumentProvider` / `listDocumentProviders` — document library registry;
- `setFederation` — conglomerate federation injection;
- `onTeamEvent` — subscribe to team events (a throwing subscriber never blocks the event bus);
- `options.store` — storage provider injection point.

Third-party capabilities (Jira sync, calendars, CRM, code platforms, document libraries) ship as standalone npm packages + a cordis row — written exactly like a DSH plugin. One ecosystem, one way of writing plugins.

### The data format is the migration contract

JSONL flow records (delegations/tasks/mail/memory/runs) have been stable, replayable fact logs from day one: cold starts recover state from them, SQLite/federation backends migrate from them in one pass. The format never changes, so historical data stays valid forever.

### Scale-related efficiency design (in effect today)

| Design | Effect | Relationship to scale |
|------|------|--------------|
| Lazy member activation | Undispatched positions cost zero sessions, zero tokens | More positions ≠ more standing cost |
| Digest folding chain | Each orchestrator layer reads conclusions only | More layers ≠ more information at the top |
| Server-side scope projection | Tools only see data within their authority | The bigger the org, the more mandatory the isolation |
| Delegation depth ≤3 + reassignment | Tasks always reach a terminal state, no infinite recursion | Prevents dispatch chaos at scale |

## Quick start

```bash
# 1. Install (DSH plugin protocol)
dsh plugin add dsh-orgos

# 2. Start dsh: role presets auto-seed; open a new Web session as "dispatch center (orchestrator)"

# 3. Initialize your team (send in the "dispatch center" session)
Initialize with team_setup (action=init, scale=small)

# 4. Configure IM (Feishu example)
#    - Put credentials into DSH credentials (key of your choice, value format appId:appSecret)
#    - Enable the team-im-feishu row in your profile and configure channels
#    - @-mention the bot in a group to talk; bind group→position with team_setup bind
```

## Usage guide

### Pick your scale (individual / small team / large team)

One model covers every scale; only `team_setup init`'s `scale` and later customization differ:

| User | Recommended start | Org tree | Typical play |
|------|----------|--------|----------|
| **Individual** | `scale=small` (1 lead + 2 members) | org→team | Run your own virtual squad from your phone over IM; dispatch/receipt/heartbeat close the loop entirely in IM |
| **Small team** | Start `scale=small`, add positions in `team.yml` | org→team | One group bound to the team node, @-mention picks the position; humans join with `occupant.kind: human` |
| **Large team / company** | `scale=dept` (2 teams, each with an orchestrator) | org→dept→team×N | Department walls + cross-team ACL; per-layer digest folding; sensitive actions raise IM approval cards |
| **Conglomerate rehearsal (multi-BG)** | `scale=group` (org→bg×2→dept→team) | org→bg→dept→team | BGs isolated by default; cross-BG via explicit ACL; the org root reads folded summaries only |

> `scale` is only a starting template — edit `team.yml` anytime after starting at any scale.
> The org tree is declarative config, not code.

### Customizing the org structure (team.yml)

The team config is one declarative YAML file at `${DSH_HOME}/team-state/team/team.yml`
(edit and restart; `team_setup bind/unbind/replace` go through the safe path: backup → validate → atomic replace, auto-rollback on failure):

```yaml
org: my-org                        # org name
nodes:                             # governance node tree (org/bg/dept/team, any depth)
  - id: my-org
    kind: org
    orchestratorPosition: head     # optional orchestrator per layer (delegations land where one exists, bubble up otherwise)
    children: [team-a, team-b]
  - id: team-a
    kind: team
    orchestratorPosition: lead-a
    children: []
positions:                         # position = stable entity; occupants are swappable
  - id: lead-a                     # orchestrator position
    occupant: { kind: agent, preset: orgos-orchestrator }
  - id: dev-1
    teamId: team-a
    occupant: { kind: agent, preset: orgos-coder }          # virtual employee
  - id: designer-1
    teamId: team-a
    occupant: { kind: human, im: { channel: feishu, userId: ou_xxx } }  # human
    handover: { inheritMemory: team, reassignOpenTasks: transfer }      # handover policy on replacement
routes:                            # IM routing: (channel, group/session) → position or node
  - { channel: feishu, peerId: oc_xxx, target: team-a }
acl:                               # governance rules
  delegationDepthMax: 3            # delegation depth cap
  allowCrossTeam:                  # cross-team collaboration whitelist (cross-team denied by default)
    - { from: team-a, to: team-b, scopes: [note, result] }
roles:                             # per-preset override of the five-dimension scope
  orgos-coder: { visibility: team, authority: self, memory: [private, team], subscription: [team, self] }
```

Full samples live in [examples/](examples/) (squad / department / conglomerate / multi-bot groups); field semantics are annotated next to each field.

### Roles and staffing

Five built-in role presets (auto-seeded into the user directory on install; shipped DSH presets are never touched):

| Preset | Role | Typical positions |
|------|------|----------|
| `orgos-orchestrator` | Dispatch center | Team lead / dept head / BG head / CEO — coordinates, never executes |
| `orgos-coder` | Engineer | Coding/implementation (file & command tools behind approval) |
| `orgos-reviewer` | Reviewer | Review/acceptance/regression quality gate |
| `orgos-analyst` | Analyst | Research/data/proposals |
| `orgos-assistant` | Assistant | General assistance/customer support |

- **Swapping people**: any `occupant` can switch to a human (`kind: human`) or another preset at any time;
  `team_setup replace` generates a handover list, handles in-flight tasks per the `handover` policy, and injects the new occupant's initial memory;
- **Custom roles**: write your own DSH agent preset (persona/tools/model) and reference it in `occupant.preset` —
  orgos does not lock the role system.

### Beyond the "dispatch center": other ways to play

The orchestrator is the main entrance, but not the only one:

| Entrance | Play |
|------|------|
| **IM direct to positions** | Groups bound to team nodes route messages to positions; multi-bot groups @-mention to pick who responds; DM whitelist (owners can message members privately) |
| **Web member sessions** | Open a Web session as `orgos-coder` etc. and you are that position's virtual employee (the same session IM delivers into) |
| **`/run` command** | Send `/run` in any bound IM group for an instant run summary (inbound/approval/delegation/receipt + in-flight/completed/failed delegation units) |
| **IM approval** | Sensitive member actions raise approval cards (allow/deny); 10 minutes of silence auto-denies (fail-closed) |
| **Team Room tab** | The "Team Room" view in Web sessions: org tree / member status / delegations / task board / health checks, auto-refresh every 15s |
| **Position replacement** | `team_setup replace` triggers knowledge handover: handover list + memory tiering + initial framing for agents or a welcome card for humans |
| **Three-tier memory** | `team_memory_save` distills explicit team/org knowledge; `team_memory_recall` fetches per scope (private memory = member session history) |
| **12 team tools** | delegate/status/mail×2/task×3/memory×2/setup/doctor/run — members and the dispatch center share one discipline |

## Scale and evolution path

**Today: works out of the box, zero performance debt.** The org model, coordination mechanics, and lazy activation carry teams of dozens to hundreds of positions on a single machine; JSONL storage prioritizes correctness and recoverability, and the data format doubles as the migration contract.

**Long term: conglomerate scale = swapping providers.** SQLite → document providers → cross-instance federation plug in one by one, each touching a single seam and never the org model or the domain kernel. Interfaces first, implementations on demand — exactly what the "Capability seams" section above promises.

## Repository layout

```
packages/
├── core/          # domain/ (pure domain kernel, harness-agnostic) + dsh/ (DSH binding layer + extension API)
├── im-gateway/    # MessageGateway seam + message normalization
├── im-feishu/     # Feishu adapter (WS long connection, verified)
├── im-telegram/ wecom/ dingtalk/ slack/ discord/ whatsapp/
├── tools/         # Team tools (delegate/status/mail/task/memory/setup (incl. replace)/doctor/run)
├── ui/            # Client half (Team Room view)
└── bundle/        # dsh-orgos bundle (dsh.bundle manifest)
examples/          # Team config samples (squad/department/conglomerate/multi-bot groups)
```

## Roadmap

| Stage | Status |
|------|------|
| M1 Core + Feishu + end-to-end run | ✅ Done |
| M2 All IMs + approval + run data + three-tier memory + knowledge handover + extension API | 🔨 In progress (feishu & telegram live with real credentials; official-subagent/workflow delegation tools added to presets; TaskBoard CAS; remaining: real-credential runs for whatsapp/slack/discord/dingtalk/wecom) |
| M3 SQLite + document providers + release | 🔲 Planned |
| M4 Conglomerate federation + multi-tenancy + audit | 🔲 Reserved (interfaces defined) |

## Documentation

| Doc | Path |
|-----|------|
| Architecture & data flows | [docs/architecture.md](docs/architecture.md) |
| team.yml configuration manual (every field + four templates) | [examples/README.md](examples/README.md) |
| Quant team guide | [docs/quant-trading-guide.md](docs/quant-trading-guide.md) |
| Deployment shapes & large-project delivery flow (single/multi machine) | [docs/deployment-and-scale.md](docs/deployment-and-scale.md) |

Internal design & decision documents (PRD / tech design / ADRs / security) live outside this repository.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Core conventions: a new IM adapter = a standalone package + fixture tests; unit-test coverage ≥ 80% with Given-When-Then on critical paths; docs stay in sync with code.

## License

[MIT](LICENSE) © shisan13
