# dsh-orgos Architecture & Data Flows

> Architecture overview for users and contributors (the configuration field manual lives in [examples/README.md](../examples/README.md)).
> Internal design/decision documents are kept outside this repository.

## 1. Architecture in one sentence

**dsh-orgos is an organizational operating system on DeepSeek Harness (DSH).** Official DSH supplies the execution engines and infrastructure (sessions/subagents/approval/storage/UI); dsh-orgos builds the organization layer on top (org tree, IM routing, dispatch discipline, human-machine hybrid, information flows & scope). Three layers:

| Layer | Contents | Owner |
|-------|----------|-------|
| Official (use as-is) | agents/sessions, subagent+workflow, user-approval, settings/credentials/attachment/schedule, client UI | DSH |
| Adaptation (we complete) | MemberBackend (member runtime), IM approval rendering, TaskBoard CAS, team-state persistence | dsh-orgos dsh/ bindings |
| Differentiation (we build deep) | org tree, delegation state machine, five-dimension scope, three-tier memory, heartbeat folding, run audit | dsh-orgos domain/ kernel |

## 2. Package layout

```
packages/
├── core/          dsh-orgos-core
│   ├── domain/    Pure domain kernel (zero DSH imports, portable): org tree / routing /
│   │              delegation state machine / scope projection / digest / ACL / mailbox /
│   │              task board / memory
│   └── dsh/       DSH bindings: TeamService / member runtime / persistence / seeder
├── im-gateway/    IM seam: NormalizedMessage contract / normalization / idempotency / backoff (shared)
├── im-<platform>/ One package per IM (pure protocol layer + dsh/ factory registration):
│                  Feishu / Telegram / WeCom / DingTalk / Slack / Discord / WhatsApp
├── tools/         Team tools (team_delegate/status/mail/task/setup/doctor/run/memory)
├── doc-feishu/    Feishu Bitable document provider
├── ui/            Team room tab (Client)
└── bundle/        dsh-orgos: the only package declaring dsh.bundle (cordis.patch.yml)
presets/           Role preset templates (seeded into the user root; never overwrite user edits)
examples/          Three team.yml templates (squad / department / conglomerate; kept in sync with tools templates)
```

Dependencies are one-way: `im-* → im-gateway`, `tools → core(domain)`, `bundle → all`.

## 3. Core models

### 3.1 Org tree & Position/Occupant

- Governance nodes: `org / bg / dept / team`, joined by `children`; each level may declare an `orchestratorPosition`.
- Leaves are **Positions** (stable identity: title/level/capability profile/permissions/task history persist with the position); the **Occupant** is swappable: `kind: agent` (role preset + persistent session) or `kind: human` (IM identity).
- Human-machine symmetry: routing, delegation, task board, mailbox, scope and memory treat human and agent occupants identically; replacement is evolution (swap occupant + knowledge handover). **Replacement rate is a configuration fact, not an architecture version.**

### 3.2 Delegation state machine ("never DIY" mechanized)

```
queued ─dispatch─▶ dispatched ─claim─▶ running ─complete─▶ completed
                              │
                              └─fail─▶ failed ─diagnose + revise brief, retry (≤3)─▶ dispatched(attempt+1)
                                       │
                                       └─attempt=3─▶ failed-final ─▶ escalated (parent orchestrator, no level skipping)
human occupants: fail/stall → nudge ─▶ escalate ─▶ reassign (no brief-rewrite retry)
any state ─cancel/timeout─▶ cancelled / timeout (→ failed path)
```

Enforced server-side: target must be inside the delegator's subtree; depth ≤ delegationDepthMax (default 3); per-member concurrency ≤ memberConcurrencyMax (default 2); briefs missing required fields are rejected.

### 3.3 Six information flows + five-dimension scope + three-tier memory

| Flow | Direction | Carrier | Compression |
|------|-----------|---------|-------------|
| Delegation | down | Brief → member inbox | context clipped (task-relevant material only) |
| Receipt | up | result report → delegator inbox | deterministic digest (conclusion/metrics/verification; detail stays local) |
| Collaboration | lateral | mailbox + task board | none; ACL: block→allowCrossTeam→same-team→deny |
| Announcement | down | broadcast (team/org) | none; delivered per subscription scope; never carries task instructions |
| Memory | sedimentation | memory stream JSONL | refined by the level's orchestrator, pushed upward |
| Heartbeat | up, periodic | member self-check → team fold | folded once per level (natural summary chain) |

All five scope dimensions are enforced server-side (never left to model self-discipline): visibility / authority / tool (preset-defined) / memory / subscription. Level defaults are in examples/README. Three-tier memory: private (member session history) / team / org.

## 4. Key data flows

### 4.1 IM inbound → route → deliver → reply

```
IM message → im-<platform> adapter (NormalizedMessage + idempotency dedup)
  → team-im-gateway (team/inbound-message event)
  → RouterResolver: ① exact (channel, peerId) route-table match → position/node
      ② unbound group: non-mention silently ignored; mention → fallback to org-root orchestrator
      ③ DM: whitelist (owner+allowlist) check → default entry; reject otherwise
      ④ governance node without orchestrator → bubble up the parent chain
  → member runtime: lazy activation (create/resume member session on first message) → agent.inject()
  → member works (agent: role preset composition; human: IM task card)
  → receipt: completion/failure → receipt flow → delegator inbox + outbound reply to original peer
```

### 4.2 Delegation loop (US1)

```
orchestrator calls team_delegate(brief) → DelegationEngine checks (subtree/depth/concurrency/brief)
  → record delegations.jsonl → deliver to target member inbox (agent) / task card (human)
  → member claims → works → completion receipt (with verification output) → digest → delegator
  → failure: orchestrator diagnoses (history/task board) → revise brief, retry (≤3) → escalate to parent
```

### 4.3 Approval loop (IM cards)

```
member triggers official user-approval → member-context listener (approval/request, prepend claim)
  → IM approval card (Allow/Deny buttons, value carries approvalId)
  → user taps → approval_reply → resolve → official answer; 10-minute timeout auto-denies (fail-closed)
```

### 4.4 Member lifecycle & heartbeat

```
Lazy activation: first message ensures the member session (resume first, preserving history)
  → runs → idle (agent stays mounted for the next job)
Status folding: agent/status events → offline / idle / busy / failed
Heartbeat: member self-check (schedule reminder) → team fold → per-level escalation; anomalies escalate immediately
```

### 4.5 Persistence

```
$DSH_HOME/team-state/
├── team/team.yml        main config (team_setup: backup + validate + atomic replace)
├── delegations.jsonl    full delegation state-machine timeline
├── mailbox.jsonl / taskboard.jsonl / memory-*.jsonl / runs.jsonl
├── snapshots/           snapshots (faster cold start)
└── backups/             config history (rollback)
Member session history = native DSH session persistence (never copied); credentials live only in DSH credentials, never in plaintext.
```

## 5. Official-capability fusion strategy (public summary)

1. **Official & complete → use as-is**: subagent/workflow (intra-member delegation), user-approval, session/storage/credentials/UI.
2. **Official interface, incomplete → we complete**: MemberBackend mirrors the official subagent seam; IM approval rendering; TaskBoard CAS (official design, own implementation); team-state migrating to official storageDomain (M3 plan).
3. **Official missing → we build deep**: org tree, IM routing, never-DIY, human-machine hybrid, six flows + five-dimension scope, three-tier memory, heartbeat folding, run panel.
4. No dependency on official experimental packages (promotion renames them atomically); every official rc release triggers a seam-diff review.

## 6. Related docs

- Configuration manual (every team.yml field + three templates): [examples/README.md](../examples/README.md)
- Overview: repository [README.md](../README.md)
- Development conventions: [AGENTS.md](../AGENTS.md), [CONTRIBUTING.md](../CONTRIBUTING.md)
