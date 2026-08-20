# examples/ — Team Configuration (team.yml) Samples & Field Reference

> 中文: [README.zh-CN.md](README.zh-CN.md)

This directory holds **team.yml** samples and the complete field reference for the dsh-orgos team configuration. The authoritative source is `packages/tools/src/templates.ts` — a consistency test in `packages/tools/src/tools.test.ts` guarantees the examples and templates stay character-identical.

| File | Scenario |
|------|----------|
| [`team-small.yml`](team-small.yml) | Squad: org → team → positions (1 orchestrator + 2 executors, human-machine hybrid) |
| [`team-dept.yml`](team-dept.yml) | Department: org → dept → team ×2 (an orchestrator per team + cross-team ACL) |
| [`team-group.yml`](team-group.yml) | Multi-BG conglomerate: org → bg → dept → team, BG isolation by default |
| [`team-hybrid.example.md`](team-hybrid.example.md) | Advanced: **multi-bot in one group + human-machine hybrid** |

Usage: `team_setup init` (scale: small/dept/group) bootstraps from the authoritative templates; advanced users can copy a sample to `${DSH_HOME}/team-state/team/team.yml` (replace the placeholders, then restart).

> Field semantics are authoritative in `packages/core/src/domain/types.ts` (types & comments) and `packages/core/src/domain/config/TeamConfig.ts` (validation); the templates themselves carry per-field inline comments in Chinese.

---

## 1. Top-level structure

```yaml
org: acme                      # conglomerate root node id (required)
nodes: [ ... ]                 # governance nodes (required, may be empty)
positions: [ ... ]             # all positions (required, may be empty)
routes: [ ... ]                # IM routing table (required, may be empty)
acl: { ... }                   # team-level ACL (required, may be empty object)
roles: { ... }                 # per-role scope overrides (optional)
```

| Field | Type | Required | Semantics | Default / constraint |
|-------|------|:--------:|-----------|----------------------|
| `org` | string | ✅ | Conglomerate root node id; must exist in `nodes` | none; missing/unknown → validation error |
| `nodes` | NodeDef[] | ✅ | Governance tree (org/bg/dept/team) | may be `[]` |
| `positions` | PositionDef[] | ✅ | All positions (governance + executor, one model) | may be `[]` |
| `routes` | RouteRule[] | ✅ | IM routes: (channel, peerId) → position/node | may be `[]` |
| `acl` | AclConfig | ✅ | Collaboration/delegation ACL | may be `{}`; default depth 3, concurrency 2 |
| `roles` | Record\<presetId, RoleDefaults\> | ❌ | Per-preset five-dimension scope overrides | defaults by level (see §5) |

---

## 2. nodes[] — governance nodes (NodeDef)

Governance nodes form the org tree: `org → bg → dept → team`. Tree leaves are positions (see §3); `children` may reference governance nodes only — executor positions attach via `positions[].teamId`, not via `children`.

| Field | Type | Required | Semantics | Default / constraint |
|-------|------|:--------:|-----------|----------------------|
| `id` | string | ✅ | Node id | unique across the config |
| `kind` | enum | ✅ | `org` / `bg` / `dept` / `team` | invalid value → error |
| `title` | string | ❌ | Display name | — |
| `orchestratorPosition` | string | ❌ | Position id of this level's orchestrator | **levels with this field accept delegations**; otherwise they escalate up the parent chain |
| `children` | string[] | ✅ | Child node ids | governance nodes only; duplicate/missing/cycle/orphan → error |

**Level semantics**: squad = `org → team`; department = `org → dept[] → team[]`; conglomerate = `org → bg[] → dept[] → team[]`. The root (the `org` field) sits at the top.

---

## 3. positions[] — positions (PositionDef)

A position is a **stable leaf** of the org tree: id/title/capability profile/permissions persist with the position; the occupant is swappable (replacement = evolution, ADR-004). Governance positions are referenced by a node's `orchestratorPosition`; executor positions attach to a team via `teamId`.

| Field | Type | Required | Semantics | Default / constraint |
|-------|------|:--------:|-----------|----------------------|
| `id` | string | ✅ | Position id | unique; routes/delegation/mail address it by this id |
| `title` | string | ✅ | Position title | shown in team room / task board |
| `teamId` | string | executor✅ | Owning team node id | **governance positions omit it** (linked via orchestratorPosition); unknown reference → error |
| `restricted` | boolean | ❌ | Restricted position flag (shared/guest) | default `false`; `true` → no delegation, excluded from collaboration ACL, self-only visibility |
| `capabilityProfile` | string[] | ❌ | Capability profile (human/agent symmetric) | participates in routing / auto-assignment (future `target: auto`) |
| `occupant` | Occupant | ✅ | The incumbent (see §3.1) | missing kind → error |
| `handover` | HandoverPolicy | ❌ | Handover policy on occupant replacement (see §3.2) | — |

### 3.1 occupant — the incumbent

| Field | Type | Required | Semantics |
|-------|------|:--------:|-----------|
| `kind` | enum | ✅ | `agent` = role preset + resident session; `human` = IM identity binding (any node at any level may be human) |
| `preset` | string | agent✅ | Role preset id (e.g. `orgos-orchestrator` / `orgos-coder`) |
| `im` | { channel, userId } | human✅ | Human member IM identity: `channel` (e.g. feishu) + `userId` (e.g. open_id) |

Human-machine isomorphism: flip `occupant.kind` to `human` and the position is now held by a person — routing/delegation/task board/scope all stay unchanged.

### 3.2 handover — replacement policy

| Field | Type | Required | Semantics |
|-------|------|:--------:|-----------|
| `inheritMemory` | enum | ✅ | Which memory tier the knowledge distills into: `private` / `team` / `org` |
| `reassignOpenTasks` | enum | ✅ | Open-task handling: `transfer` (hand over with context) / `keep` / `cancel` |

Triggered by `team_setup replace`: generates a handover checklist → transfers open tasks per policy → writes knowledge into team memory → injects initial memory for the new occupant.

---

## 4. routes[] — routing table (RouteRule)

| Field | Type | Required | Semantics |
|-------|------|:--------:|-----------|
| `channel` | string | ✅ | IM channel name (matches team-im-gateway channel config, e.g. feishu / telegram-personal) |
| `peerId` | string | ✅ | Group/conversation id (with channel, forms the exact-match key) |
| `target` | string | ✅ | Route target: a position id **or** a governance node id |

**Resolution order** (routing algorithm):

```
1. Exact match (channel, peerId): position → deliver directly; node → its orchestrator
   (or escalate up the parent chain when absent);
2. Unbound group (peer.kind=group): deliver only on @-mention; fall back to the org root orchestrator;
3. Unbound DM: user must be allowlisted (ownerIds/allowlist, configured on the team-core row); fall back to org root;
4. Governance node: this level's orchestrator; none → escalate to parent;
5. restricted (shared/guest) positions: subject to ACL limits.
```

- **Multi-bot in one group**: multiple routes with the same `peerId` (differentiated by `channel`) — @mention picks who responds.
- **Session binding**: the `(channel, peerId, positionId)` triple is persisted, so a group always lands on the same position.

---

## 5. acl — team-level ACL (AclConfig)

| Field | Type | Required | Semantics |
|-------|------|:--------:|-----------|
| `allowCrossTeam` | AllowCrossTeamRule[] | ❌ | Cross-team collaboration whitelist |
| `block` | BlockRule[] | ❌ | Block rules (`to` = team node id or position id) |
| `delegationDepthMax` | number | ❌ | Delegation depth cap, counted along the org tree | default 3; must be ≥1 |
| `memberConcurrencyMax` | number | ❌ | Concurrent delegations per member | default 2; must be ≥1 |

### 5.1 allowCrossTeam — direct cross-team

| Field | Type | Required | Semantics |
|-------|------|:--------:|-----------|
| `from` | string | ✅ | Initiating **team node id** |
| `to` | string | ✅ | Target team node id |
| `scopes` | enum[] | ✅ | Allowed collaboration kinds: `task` / `note` / `result` / `escalation` |

> Note: `scopes` **without `task`** means "collaborate but never delegate across teams" (the delegation flow never opens a cross-team whitelist).

### 5.2 block — denial

`to` = team node id or position id; any hit denies both collaboration and delegation.

### 5.3 Evaluation order (important)

```
1. block hit → deny (highest priority; restricted positions are denied by default too);
2. allowCrossTeam hit with matching scope → allow;
3. same team → allow by default (all scopes);
4. otherwise → deny.
```

---

## 6. roles — per-role scope overrides (optional)

`roles` is keyed by **preset id** (e.g. `orgos-coder`) and overrides that role's five-dimension scope defaults:

| Field | Type | Values | Semantics |
|-------|------|--------|-----------|
| `visibility` | enum | `self` / `team` / `dept` / `bg` / `org` | What it can see (task board / mail / memory read projection) |
| `authority` | enum | same | What it can do (delegation targets / escalation / config changes) |
| `memory` | enum[] | `private` / `team` / `dept` / `bg` / `org` | What it records (memory visibility) |
| `subscription` | enum[] | `self` / `team` / `dept` / `bg` / `org` | What it listens to (event/notification whitelist) |

**Defaults by level** (when `roles` is absent):

| Position level | visibility | authority | memory | subscription |
|----------------|-----------|-----------|--------|--------------|
| member (executor) | self | self | private + team | self + team |
| team lead | team | team | + team | + team |
| dept | dept | dept | + dept | + dept folded reports |
| bg | bg | bg | + bg | + bg |
| org (root) | org | org | + org | + org |

> All projections are enforced server-side (out-of-scope data is unreachable), never left to the model's discretion. Restricted positions default to memory = private only, subscription = self only.

---

## 7. Template comparison

| Dimension | small | dept | group |
|-----------|-------|------|-------|
| Tree depth | org → team | org → dept → team ×2 | org → bg ×2 → dept → team |
| Positions | 3 (1 orchestrator + 2 executors) | 5 (3 orchestrators + 2 executors) | 5 (3 orchestrators + 2 executors) |
| Human incumbents | reviewer-1 (member) | backend-lead (lead) | ceo (president) + ops-1 (ops) |
| Cross-team ACL | — | allowCrossTeam (team-front → team-backend, note/result) | — (BG isolation by default) |
| Escalation chain | root is the team | team → dept-head | team → dept → bg → ceo |
| Best for | individuals / squads | departments | conglomerates |

---

## 8. Validation error checklist (team_setup validate / team_doctor output)

Every check in `packages/core/src/domain/config/TeamConfig.ts` (each carries an actionable fix):

| # | Trigger | Notes |
|---|---------|-------|
| 1 | YAML syntax error | fix indentation / quotes / colons |
| 2 | Top level is not an object | organize with org/nodes/positions/routes/acl |
| 3 | `org` missing | fill in the conglomerate root id |
| 4 | `org` root not present in `nodes` | nodes must contain the id=org root node |
| 5 | nodes[].id missing / duplicate | unique id per node |
| 6 | nodes[].kind invalid | must be org/bg/dept/team |
| 7 | nodes[].children not an array | `children: []` or omit |
| 8 | positions[].id missing / duplicate | unique id per position |
| 9 | positions[].occupant missing kind | `occupant: { kind: agent, preset: ... }` or `{ kind: human, im: {...} }` |
| 10 | children references an unknown node | fix the children reference |
| 11 | node has multiple parents / orphan / root cycle | keep a single-rooted, acyclic tree |
| 12 | orchestratorPosition references a missing position | must exist in positions |
| 13 | positions[].teamId references a missing node | teamId must be a team node |
| 14 | position is both executor and governance | pick one role per position |
| 15 | route missing channel/peerId/target | fill the triple |
| 16 | route target does not exist | target must be an id in positions or nodes |
| 17 | acl is not an object | omit or use valid fields |
| 18 | allowCrossTeam.from/to not a team node | from/to must be team node ids |
| 19 | allowCrossTeam.scopes invalid | use task/note/result/escalation |
| 20 | block.to does not exist | to must be a team node id or position id |
| 21 | delegationDepthMax not an integer ≥1 | e.g. `delegationDepthMax: 3` |
| 22 | memberConcurrencyMax not an integer ≥1 | e.g. `memberConcurrencyMax: 2` |
| 23 | roles malformed / field invalid | five-dimension values per §6 |

---

## 9. FAQ

**Q: What is a restricted (shared/guest) position for?**
A: `restricted: true` positions accept no delegations, their collaboration mail is ACL-denied, memory is private-only, and subscription is self-only — an isolation slot for "public assistant" style read-only entries (security design §4.2, shared/guest exclusion).

**Q: Why is cross-team collaboration denied?**
A: ACL evaluates block → allowCrossTeam → same-team → deny. Cross-team requires an explicit `allowCrossTeam` declaration with a matching scope; `scopes` without `task` forbids cross-team delegation.

**Q: What happens when a group has no route?**
A: Only @-mention messages are delivered (requireMention), falling back to the org root orchestrator; plain group text is silent. DMs require the user to be allowlisted (ownerIds/allowlist on the team-core row).

**Q: What if a node has no orchestratorPosition?**
A: The level accepts no delegations; delegations/messages escalate up the parent chain to the nearest ancestor with an orchestrator (escalation never skips levels).

**Q: How do I configure a human member?**
A: `occupant: { kind: human, im: { channel: feishu, userId: ou_xxx } }`; they interact via IM task cards (accept/reject/report) and decision cards ([agree][reject][modify]). Tracking semantics = nudge → escalate → reassign (distinct from an agent's "revise brief and redeploy ≤3").

**Q: How does multi-bot routing in one group work?**
A: Multiple routes with the same `peerId` (differentiated by `channel`); @mention picks who responds; a real person @-mentioned directly answers themselves. See team-hybrid.example.md.

**Q: When must placeholders be replaced?**
A: `ou_your_feishu_id` / `ou_ops_user_id` (human member open_ids) and `oc_your_group_id` (group id) must be replaced with real values before going live; `team_setup validate` re-checks.

**Q: How do I enable the team knowledge base (`team_doc_*` tools)?**
A: The knowledge base backend is a pluggable document provider exposed as `disabled` bundle-row templates (copy the row into your profile and drop `disabled`): local/remote git wiki → `team-doc-git` row (`config.repoPath` points to an existing git repo); Feishu cloud docx → `team-doc-feishu-docs` row (`config.credentialRef` in `appId:appSecret` format); Feishu Bitable → `team-doc-feishu` row (plus appToken/tableId). The three can coexist; `team_doc_*` tools merge across providers, and passing `expectedVersion` on update enables CAS against overwrites.

**Q: roles overrides vs. defaults?**
A: Without `roles`, level-based defaults apply (§6 table); with `roles`, the matching preset id overrides the given dimensions — an empty `memory`/`subscription` array means "no override, fall back to default".
