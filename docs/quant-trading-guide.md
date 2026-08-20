# Building a Quant Trading Virtual Team with dsh-orgos

> A complete hands-on guide from zero to running: stand up a 25-position quant organization (product & engineering divisions, multi-client development, data/strategy/risk pipeline) in 30 minutes, then let it flow like a real company — requirements, delegation, receipts, approvals, memory, heartbeat.
> Based on the real template [`examples/team-quant.yml`](../examples/team-quant.yml) (`team_setup init quant`); field semantics in [examples/README.md](../examples/README.md), architecture background in [docs/architecture.md](architecture.md).

---

## 1. Quick start (running in 30 minutes)

Prerequisites: DeepSeek Harness installed with a working profile (a dedicated profile such as `orgos-demo` is recommended).

### Step 1: Install the plugin (~3 min)

```bash
# Inside the target profile directory (e.g. ~/.dsh/profiles/orgos-demo)
cd ~/.dsh/profiles/orgos-demo
pnpm add dsh-orgos dsh-orgos-core dsh-orgos-tools dsh-orgos-ui file:/tmp/orgos-packs/*.tgz   # local pack-based install
# Once published:
# dsh plugin add dsh-orgos
```

Add `"dsh-orgos"` to `dsh.profile.bundles` in the profile's `package.json`, then restart the profile.

**Expected**: `dsh --profile orgos-demo --dump-config` shows `team-core`, `team-im-gateway`, `team-im-feishu` (enabled by default) and the other IM adapter rows (`disabled: true`).

### Step 2: Configure IM credentials (~5 min)

Credentials live only in DSH credentials (never plaintext in config files). Configure channels on the `team-im-gateway` row and the owner/allowlist on `team-core` in the profile's `cordis.patch.yml`:

```yaml
- id: team-core
  name: 'dsh-orgos-core/dsh'
  config:
    ownerIds: ['ou_your_owner_id']        # your IM user id (owner)
    allowlist: []                          # extra whitelist

- id: team-im-gateway
  name: 'dsh-orgos-im-gateway/dsh'
  config:
    channels:
      feishu-main:                         # channel name = routing channel
        provider: feishu
        credentialId: dsh_orgos_feishu_main
      telegram-personal:                   # second IM in parallel (optional)
        provider: telegram
        credentialId: dsh_orgos_telegram_personal
```

Write the credentials (key names match `credentialId`; value format is parsed by each adapter binding — Feishu is `appId:appSecret`, Telegram is the bare bot token). **Expected**: after restart, `/tmp/orgos-gateway.markers.log` shows `channel:feishu-main conn=connected → started` (the same check used in our verified 3081 run); for Telegram, `getWebhookInfo` reports `pending_update_count: 0` (long-polling confirming normally).

### Step 3: Initialize the quant team (~2 min)

```bash
# From any orchestrator session (or copy the template to ${DSH_HOME}/team-state/team/team.yml)
team_setup init quant
```

**Expected**: team snapshot (`/api/orgos/snapshot`) shows `org: quant-alpha` with all 25 positions; `team_status` lists them. If you copy the template instead, replace the placeholders `ou_your_ceo_id` (your Feishu open_id) and `oc_your_group_id` (main group chat_id) and restart.

### Step 4: Bind IM groups (~5 min)

```yaml
routes:
  - { channel: feishu-main, peerId: oc_your_group_id, target: quant-alpha }   # main group @bot → org root (CEO/PMO)
```

The main group is already in the template; add more groups with `team_setup bind` (channel/peerId/target triple, atomic replace with backup+validation):

```
team_setup bind channel=feishu-main peerId=oc_ops_group target=dept-product
```

**Expected**: in the Feishu main group, `@bot 汇报当前团队状态` routes to `quant-alpha` (ceo-pmo) and the PMO replies with the team snapshot; `team/inbound-message` events and receipts are visible in markers.

### Step 5: First delegation acceptance (~5 min)

In the Feishu group tell the PMO: "assign to the quant researcher to research the win rate of a BTC 30-day MA strategy, one-page report." The PMO (orchestrator) will:

1. `team_delegate` a structured brief (see §3.1 example);
2. deliver it to `quant-researcher-1`'s inbox (member lazy-activation creates the session);
3. on completion, the receipt flow returns a digest (conclusion + metrics + verification);
4. you get a "done" notification; `team_run` shows the full delegation timeline.

**Acceptance**: receipt carries the conclusion and verification output; `delegations.jsonl` shows the full state flow (queued→dispatched→running→completed).

---

## 2. Organization design & position responsibilities

### 2.1 Org chart (25 positions / 10 nodes)

```
quant-alpha (org) ── orchestrator: ceo-pmo (CEO/PMO, human example)
├── dept-product (Product & Ops) ── product-lead
│   └── team-product
│       ├── pm-1        Product Manager (analyst)
│       ├── ops-1       Ops Specialist (assistant)
│       └── content-1   Content Ops (assistant)
└── dept-tech (Engineering) ── tech-director
    ├── team-frontend ── frontend-lead
    │   ├── team-app ── app-lead
    │   │   ├── ios-1        iOS Engineer (coder)
    │   │   ├── android-1    Android Engineer (coder)
    │   │   └── harmonyos-1  HarmonyOS Engineer (coder)
    │   └── team-web-mini ── web-lead
    │       ├── web-1           Web Frontend PC/H5 (coder)
    │       ├── miniapp-wx-1    WeChat Mini Program (coder)
    │       └── miniapp-alipay-1 Alipay Mini Program (coder)
    └── team-backend ── backend-lead
        ├── team-eng ── eng-lead
        │   ├── java-1   Java Service Engineer (coder)
        │   ├── java-2   Trading Execution Engineer (coder)
        │   └── qa-1     Test Engineer (reviewer)
        └── team-data ── data-lead
            ├── data-eng-1          Data Engineer (coder)
            ├── quant-researcher-1  Quant Researcher (analyst)
            ├── strat-1             Strategy Engineer (coder)
            └── risk-1              Risk Reviewer (reviewer)
```

### 2.2 Positions & preset mapping

| Position | Preset | One-line responsibility |
|----------|--------|-------------------------|
| ceo-pmo | human (example) | org goals / portfolio governance, escalation fallback, key decisions (risk limits / release approval) |
| product-lead | orchestrator | product dept scheduling, demand prioritization, cross-team coordination, reporting up |
| pm-1 | analyst | requirements collection / PRD / acceptance criteria |
| ops-1 / content-1 | assistant | ops activities and content (announcements, tutorials, community) |
| tech-director | orchestrator | tech dept scheduling, tech selection, cross frontend/backend coordination |
| frontend-lead / app-lead / web-lead | orchestrator | frontend line scheduling, release coordination, quality gate |
| ios-1 / android-1 / harmonyos-1 | coder | three-client app development with self-test, evidence-based reporting |
| web-1 / miniapp-wx-1 / miniapp-alipay-1 | coder | PC/H5 and two mini-program development |
| backend-lead / eng-lead | orchestrator | backend / engineering line scheduling |
| java-1 | coder | business services / gateway development |
| java-2 | coder | trading execution chain (orders / risk linkage) |
| qa-1 | reviewer | test plans / cases / acceptance review (quality gate) |
| data-lead | orchestrator | data & algorithm line scheduling |
| data-eng-1 | coder | data ingestion / cleaning / feature pipeline |
| quant-researcher-1 | analyst | strategy research: hypotheses, backtest design, research report (with sources) |
| strat-1 | coder | strategy engineering: turning research into backtestable/deployable code |
| risk-1 | reviewer | risk review: backtest verification, limit checks, pre-release risk assessment |

> Preset tool surfaces: coder/analyst/assistant/reviewer all carry official `subagent`/`subagent_fork`/`tool-workflow` (intra-member delegation) and `web_search` (live info); orchestrator presets additionally carry `team_delegate`/`team_status`/`team_setup` (never-DIY: coordinate only, never execute for the team).

### 2.3 Human-machine mix & replacement evolution

| Position | Suggested occupant | Why |
|----------|-------------------|-----|
| ceo-pmo | **human** (as in the template) | decision cards (approve/reject/modify), human fallback and authorization boundary |
| pm-1 | human or analyst | requirement "final calls" and business context; start with analyst, swap to human later with zero-config migration |
| other execution/governance | agent | development / research / risk execution suits virtual employees |
| qa-1 / risk-1 | agent (reviewer) | review-type roles fit the "verify but don't execute" reviewer persona |

**Replacement evolution = swap the occupant**: `team_setup replace target=pm-1 newKind=human newImChannel=feishu newImUserId=ou_xxx` — the system generates a handover checklist, handles in-flight tasks per the handover policy, and writes a handover record (`team_memory_save kind: handover`). Replacement rate is just a configuration fact; the org tree / routing / permissions / history all persist with the position.

---

## 3. Working mechanisms

### 3.1 Product development flow (requirements → release)

Every step is "delegate → claim → execute → receipt", using `team_delegate` (orchestrators) + `team_task_*` (members).

| Step | Delegator → Receiver | Artifact (internal md dir, §3.3) | Receipt focus |
|------|---------------------|--------------------------------|---------------|
| Requirements | ceo-pmo → pm-1 | `docs/prd/<id>-<name>.md` | requirement list + priority |
| PRD review | product-lead → qa-1 | review record | is the acceptance criteria testable |
| Tech planning | product-lead → tech-director → leads | `docs/tech/方案.md` | schedule & dependencies |
| Development | leads → coders | code + `docs/tech/决策记录.md` | acceptance evidence (test output) |
| Testing | eng-lead → qa-1 | test report | pass rate / blockers |
| Acceptance | product-lead → qa-1 + pm-1 | acceptance verdict | matches PRD acceptance criteria |
| Release | tech-director → java-2 | release record | gray-release metrics / rollback plan |

**Brief example (real quant scenario)**: research an MA strategy with `quant-researcher-1`:

```
team_delegate
  target: quant-researcher-1
  task: research the statistical win rate and applicable regime of a BTC 30-day MA(MA30) trend strategy
  background: data pipeline ready (inside team-data); research only for now, no deployment
  workingDirectory: /Users/you/workspace/quant-alpha/strategies/ma30
  requirements:
    - use 2023-2026 daily data with rolling-window validation
    - win rate = winning trades / total trades; also report avg PnL / max drawdown / Sharpe
    - conclusion must cite data source and statistics definition
  constraints:
    - no look-ahead bias (signals computed after daily close)
    - position per trade ≤ 2%
  protectedFiles:
    - config/secrets.yaml        # contains sensitive config; read/modify forbidden
    - data/raw/                  # raw data read-only
  acceptance:
    - one-page research report (md): conclusion, three metric tables, one applicability verdict
    - reproducible command included (backtest script path + arguments)
  verification: python backtest.py --strategy ma30 --period 2023-2026
  timeoutMinutes: 60
```

**How to read a receipt digest**: on completion, the delegator's inbox receives a digest generated by a deterministic template (not free-form model text): `conclusion` (one line), `metrics` (e.g. `win-rate: 54.2%`), `verification` (acceptance command output). Details stay at the level; `team_status` drills down — "upward reports carry conclusions, details stay local".

### 3.2 Project management: delegation records / task board / milestones / failure handling / heartbeat

**Delegation records**: each delegation is a state-machine record (queued→dispatched→running→completed/failed); `team_run` shows the full timeline and retry count.

**Task board** (`team_task_*`): tasks carry `revision` (CAS prevents stale overwrites) and optional `deps`. Milestone dependency example:

| Task | Depends on | Owner | Note |
|------|-----------|-------|------|
| Data pipeline 1.0 | — | data-eng-1 | first: data is the premise |
| MA30 research | Data pipeline | quant-researcher-1 | research builds on data |
| Strategy implementation | MA30 research | strat-1 | implementation depends on research |
| Trading execution integration | Strategy implementation | java-2 | release depends on strategy code |
| Release review | Strategy + execution | risk-1 + qa-1 | double gate before release |

**Failure handling (never-DIY)**: on member failure the orchestrator does NOT take over; it diagnoses with `team_status`/history → **revises the brief and retries ≤3 times** (attempt increments, brief v2/v3) → if still failing, `failed-final` → **escalate to the parent orchestrator** (no level skipping) → ceo-pmo fallback (decision card).

**Heartbeat rhythm**: member self-check (schedule, default 30 min) → team fold → level-by-level escalation; orchestrators follow up task-board stalls and overdue delegations (`timeoutMinutes` expiry enters the timeout path). Anomalies (stalls/failures) escalate immediately, not on the next beat.

### 3.3 Communication media

**Internal md documents (team knowledge directory)**: all artifacts land as md with numbered names; the writer owns updates:

```
team-state/team-wiki/           # or docs/ under member workspaces
├── docs/prd/2026-001-QuantApp-PRD.md   # written by pm-1
├── docs/tech/2026-001-技术方案.md      # written by tech-director/leads
├── docs/tech/决策记录-2026-001.md      # technical decisions (data/eng)
└── docs/memory/                          # retrospective entry (maps to three-tier memory)
```

**External third-party docs (Feishu Bitable, doc-feishu provider)**: sync the demand pool / task tables to Feishu for viewing outside IM. Config (the `team-doc-feishu` row, a `disabled` template; enable and configure as needed):

```yaml
- id: team-doc-feishu
  name: 'dsh-orgos-doc-feishu/dsh'
  disabled: false
  config:
    credentialRef: dsh_orgos_feishu_main
    appToken: <Bitable appToken>
    tableId: <table id>
```

**Mailbox (collaboration flow)** `team_mail_send`:

| kind | Scenario | Example |
|------|----------|---------|
| note | lateral collaboration / clarification | frontend asks backend about API fields; product asks tech feasibility |
| result | delivery / result handback | data engineer sends feature docs to researcher; QA sends test verdict to PM |
| escalation | escalate for help | researcher escalates a data blocker to data-lead |
| (broadcast) | team/org announcement | product-lead announces release window |

Cross-team collaboration is constrained by ACL (this template: product↔tech note/result, frontend↔backend note/result); block wins, undeclared means denied.

**Three-tier memory** (`team_memory_save`):

| Tier | Writer | Content |
|------|--------|---------|
| Private | the member | session history (DSH persistence) + MEMORY distillation, invisible to the team |
| Team | members + level orchestrators | decisions (kind: decision), retrospectives (kind: insight), handovers (kind: handover) |
| Org | senior orchestrators | cross-department strategy / announcements / retrospectives |

Example: `team_memory_save level=team kind=decision content="MA30 strategy backtest win rate 54.2%; defer release pending trend filter re-test" digest="MA30 deferred: win rate below bar"` — digest is the compression for upper levels; each level folds once, forming a natural summary chain.

### 3.4 Reporting dimension: per-level digest folding → CEO morning brief

Each level folds its children's digests once and passes only to its **direct parent**:

```
member self-check/receipt → team-lead fold → dept fold → CEO/PMO
ceo-pmo's morning inbox ≈ a "morning brief":
  - [Product] App 2.0 smoke test passed, release planned Friday
  - [Tech-Backend] trading execution integration 3/5 done, 1 blocker (data latency) escalated
  - [Tech-Data] MA30 research done: win rate 54.2%, defer suggested (3 research briefs folded to 1 verdict)
```

The escalation chain never skips levels: `risk-1` issues go to `data-lead` → `backend-lead` → `tech-director` → `ceo-pmo`; each level decides whether to keep escalating.

---

## 4. Quant-specific mechanisms

### 4.1 Strategy research relay (delegation chain + ACL)

```
research (quant-researcher-1, analyst)
  → backtest (strat-1, coder): engineer the research conclusion
  → review (risk-1, reviewer): backtest results vs risk constraints
  → release (eng-lead → java-2, coder): trading-execution integration + deploy
```

The delegation chain follows the governance subtree: data-lead → researcher → (receipt) → data-lead → strat-1 (depends on research) → data-lead → risk-1 → tech-director → java-2 (cross-subtree: java-2 lives in team-eng — **cross-subtree requires an upper-level relay**: tech-director receives data-lead's delivery, then delegates to eng-lead/java-2, or uses the escalation flow). ACL keeps lateral collaboration (research↔data note/result) within bounds.

### 4.2 Data pipeline & dependencies

```
data-eng-1 (ingestion/cleaning/feature pipeline)→ feature dataset → quant-researcher-1 (research)
  → strat-1 (strategy code)→ risk-1 (review)→ java-2 (execution integration)→ production
```

Dependencies are declared explicitly with task `deps` (e.g. "strategy implementation" depends on "MA30 research"); CAS prevents stale overwrites; a depended-on task cannot be deleted accidentally (referential integrity).

### 4.3 Risk control & approvals (IM cards)

Trading-related operations always go through an approval card (reusing official user-approval; triggered when a member executes, presented in IM with Allow/Deny buttons, 10-minute timeout auto-denies fail-closed):

| Scenario | Trigger | Approver |
|----------|---------|----------|
| Strategy release | java-2 pre-release approval | ceo-pmo (human decision card) |
| Position-limit change | java-2/strat-1 modifies config | ceo-pmo |
| Large backtest spend | quant-researcher requests | data-lead |

### 4.4 Model tiers (roles override)

Research/strategy roles use Pro, execution/ops use Flash. Override per role preset in the `roles` section of team.yml (team-level tightening, not left to model self-discipline):

```yaml
roles:
  orgos-analyst:            # researcher / product manager: complex reasoning
    visibility: self
    authority: self
    memory: [private, team]
    subscription: [self, team]
  # Actual model routing is wired in the preset model row (config `!!js ctx.teamCtx.memberModel...`);
  # the `roles` section covers five-dimension scope only. Concrete model values follow profile config.
```

> Model selection wiring lives in the preset model row; `roles` is only the five-dimension scope override. Actual model values depend on profile configuration.

---

## 5. Cross-team collaboration example: one end-to-end requirement

**Requirement**: ceo-pmo says in the Feishu main group "build a quant app where users can see BTC MA signals."

```
① Delegation   ceo-pmo →(team_delegate)→ pm-1 produce PRD (3 days)
② Delegation   product-lead → tech-director → leads tech planning
③ Collaboration pm-1 →(team_mail_send note)→ web-lead clarify "signal push frequency"
④ Delegation   frontend-lead → web-1 H5; app-lead → ios-1/android-1/harmonyos-1 three clients
⑤ Delegation   backend-lead → eng-lead → java-1 services, java-2 signal push; data-lead → data-eng-1 data, strat-1 signal computation
⑥ Collaboration frontend ↔ backend (team_mail_send result) API integration
⑦ Receipts     members complete → leads receive digests → fold level by level
⑧ Announcement product-lead broadcasts "gray-release time" to team-product; ceo-pmo org broadcast
⑨ Approval     java-2 release triggers user-approval → ceo-pmo decision card [approve]
⑩ Memory       data-lead retrospective: team_memory_save kind=insight "signal latency issue & root cause"
⑪ Heartbeat    member self-checks / lead follow-up throughout; stalls escalate immediately
```

All six flows appear: delegation (①④⑤) / receipt (⑦) / collaboration (③⑥) / announcement (⑧) / memory (⑩) / heartbeat (⑪); approval is the mandatory gate for release.

---

## 6. Operations & scaling

### 6.1 team_doctor self-check list

| Check | What it looks at | Example fix |
|-------|------------------|-------------|
| team-config | org loaded, position count | validation failed → `team_setup validate` shows the error list |
| members | positions & occupant states | offline is normal (lazy activation); failed needs session inspection |
| delegations | delegation/task/mail backlog | stalled task → diagnose, retry or escalate |
| store | state dir writable | permissions/disk |
| federation | org federation (single instance, not enabled) | enable for conglomerate stage |

**Watch items**: IM connection state (markers: `channel:* conn=connected`), heartbeat folds on time.

### 6.2 Adding positions & new strategy groups

```
# add a position (e.g. new client flutter-1)
- id: flutter-1
  title: Flutter Engineer
  teamId: team-app
  occupant: { kind: agent, preset: orgos-coder }
# add a strategy group: new team node under data-lead
- id: team-strategies
  kind: team
  orchestratorPosition: strat-lead
  children: []
# add the corresponding positions & routes; update acl (cross-group note/result) and roles
```

Swap occupants with `team_setup replace`; restart after adding rows (member list hot-loads).

### 6.3 Scaling up: adding a bg layer

Past a few dozen positions, group departments under `bg` nodes:

```
quant-alpha (org) → bg-quant(bg) → dept-product / dept-tech → …(the original tree sinks one level)
```

If the delegation-depth cap (default 3) becomes the bottleneck, raise `acl.delegationDepthMax` accordingly (or keep 3 and govern through "relay level by level").

### 6.4 Multi-IM group binding template

```yaml
routes:
  - { channel: feishu-main, peerId: oc_your_group_id, target: quant-alpha }   # main group → PMO
  - { channel: feishu-main, peerId: oc_tech_group, target: dept-tech }        # tech group → tech director
  - { channel: telegram-personal, peerId: '-5303218893', target: assistant-2 } # Telegram dedicated entry (position must exist first)
```

Multiple bots in one group: whoever is @-mentioned responds (template includes this); every peer gets an isolated session (DM isolation).

---

## 7. Related docs & next steps

- Field manual: [examples/README.md](../examples/README.md); architecture: [docs/architecture.md](architecture.md)
- Template: [examples/team-quant.yml](../examples/team-quant.yml); squad/department/conglomerate templates in the same directory
- Tools: the 12 `team_*` tool definitions live in `packages/tools/src/dsh/registerTeamTools.ts` (team_delegate/status/mail_send/mail_recv/task_create/task_claim/task_complete/run/memory_save/memory_recall/doctor/setup)
- Next steps: add a second IM, enable the doc-feishu demand table, connect real data sources so researchers run real backtests, and go bg for conglomerate scale.
