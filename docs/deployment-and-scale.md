# Deployment Shapes & Large-Project Delivery Flow

> Answers two core questions: ① can a single machine + md docs carry a full product lifecycle for large projects; ② what happens when the virtual team is spread across machines.
> Related: [Architecture](architecture.md), [Quant team guide](quant-trading-guide.md), [team.yml field manual](../examples/README.md).

## 1. Deployment shapes: three stages, capabilities open gradually

| Stage | Where members run | Communication media | State & collaboration | Fits |
|-------|-------------------|---------------------|----------------------|------|
| **A Single machine (current baseline)** | same DSH process (lazily-activated member sessions) | local md knowledge dir, mailbox, task board, Feishu Bitable (doc-feishu, already cloud) | team-state local JSONL | individuals / small teams; the quant template runs here |
| **B Hybrid (media goes cloud)** | still one process | + internal md moved into a shared git repo (team wiki), members read/write via git | team-state stays on the central instance | media across machines, members not yet |
| **C Multi-machine (members go remote)** | members = separate processes/machines (member-acp / member-dsh-sdk backends) | shared git wiki + doc-feishu; session injection via official ACP/SDK | team-state owned by the central instance (single writer); members attach remotely | distributed virtual teams across servers |

> **B stage implementation (landed)**: media is now tool-driven, not raw git — members use one tool set (`team_doc_*`: list/read/create/update/search, CAS via `expectedVersion`) over pluggable DocumentProviders: `git-wiki` (`team-doc-git` row, md files in a git repo, every write commits+pushes), `feishu-docs` (`team-doc-feishu-docs` row, cloud docx), `feishu-bitable` (`team-doc-feishu` row, table rows). All three bundle rows are `disabled` templates — enable and configure in your profile. Knowledge base stores **full assets**; three-tier memory (`team_memory_*`) keeps storing **distilled facts**.

**Rule of thumb**: communication media and execution location are two separate axes — move the media to the cloud first (B), then move members remote (C).

## 2. Large-project lifecycle: what carries each step

Example: building a quant trading App (a "broker app upgrade") from 0 to 1, on stage A:

| # | Step | Delegation chain | Carrier / artifact | Receipt focus |
|---|------|------------------|--------------------|---------------|
| 1 | Requirement gathering | pm-1 researches (web_search / user feedback) → PRD draft | `docs/prd/quant-app-PRD.md` | sources & uncertainty notes |
| 2 | Requirement review | pm-1 → ceo-pmo (decision card) / product-lead | final PRD + demand pool (doc-feishu) | testable acceptance criteria |
| 3 | Design brief | product-lead → design-lead (ui-1/ux-1) | mockups (external image host / Bitable attachments; **md keeps only reference links**) | link + version |
| 4 | Tech design | tech-director → leads | `docs/tech/quant-app-design.md` | architecture/deps/risks |
| 5 | Task breakdown to people | each lead → positions (team_delegate, full Brief) | delegation records + task board (deps ordering) | one delegation per position |
| 6 | Scheduling | leads arrange deps: backend API → frontend pages → app → integration | task board deadlineAt + deps DAG | milestones |
| 7 | Batched QA | eng/frontend leads → qa-1 in batches (Brief.acceptance = this batch's cases) | test report md + delegation receipt | pass/reject list |
| 8 | Independent FE/BE testing | qa-1 verifies backend APIs (eng team) and frontend pages (frontend team) separately | independent reports | each side passes |
| 9 | Unified black-box testing | tech-director → qa-1 (end-to-end acceptance Brief) | black-box report + issue list (task board) | pass/risk list |
| 10 | Release | tech-director → ceo-pmo approval card (go-live) → leads broadcast | announcement flow (team/org broadcast) | canary/rollback plan |

Key points:
- **Mockups never live in md**: md carries text assets (PRD/design/decisions); binary mockups live externally (image host / Bitable attachments) and md stores **reference links only** (with versions). This is a capability boundary of md, not a defect.
- **Batched QA & independent testing**: delegation semantics support them natively — each test batch is one delegation to qa-1 (Brief.acceptance = the batch's case list); FE/BE independent testing = separate acceptance delegations per team; unified black-box = a full-chain acceptance delegation from tech-director.
- **Task breakdown to people**: one "big demand" = product (PRD) → tech (design) → each lead splits Briefs delegating to specific positions; task-board deps express "APIs first, pages depend on APIs, integration depends on pages".

## 3. Media matrix (project dimension × reporting dimension)

| Medium | Single machine (A) | Multi-machine (B/C) | Dimension |
|--------|--------------------|---------------------|-----------|
| Internal md knowledge dir | local workspace dir (member fs tools) | **shared git repo (team wiki)**: members git pull/push | project (PRD/design/decisions/retro) |
| Mailbox (team_mail_*) | team-state mailbox.jsonl | central instance holds state; members access via tools (cross-machine by design) | collaboration/escalation (directed) |
| Task board (team_task_*) | same | same (CAS expectedRevision guards concurrent writes) | project (task status tracking) |
| Announcements (team_mail broadcast) | same | same | reporting (top-down) |
| Three-tier memory (team_memory_*) | same | same | reporting (decisions/knowledge) |
| Feishu Bitable (doc-feishu) | **cloud, cross-machine by design** | same | demand pool / task tables / review tables (external third-party docs) |
| Mockups / binary assets | external image host/attachments + md reference | same (reference URLs are inherently cross-machine) | project |

**Conclusion**: mailbox / task board / announcements / memory / Bitable are already cross-machine in stages B and C (state lives on the central instance; members attach remotely). The **only medium that needs work is "internal md"** — move it from a local directory to a shared git repo. That is the minimal change that turns "local md doesn't work" into "shared git wiki", with zero mechanism rewrites.

## 4. Multi-machine path (official capabilities, not self-built)

1. **Media goes cloud (B, landed)**: enable a doc-provider row in your profile (`team-doc-git` for the git wiki, optionally `team-doc-feishu-docs`/`team-doc-feishu` for Feishu backends); members read/write the knowledge base through `team_doc_*` tools (git commits/pushes under the hood); md reference rules unchanged.
2. **Members go remote (C, M3+)**: MemberBackend seam (reserved in ADR-002) gains two backends wrapping official providers:
   - `member-acp`: official `subagent-acp` (child process driven as an ACP client, deployable to remote machines via stdio/SSH bridging);
   - `member-dsh-sdk`: official `subagent-dsh-sdk` (child process = a full peer DSH runtime with its own composition/session/model).
   Organizational semantics (positions/routing/delegation/scope/memory) stay untouched — **swap the provider, swap how a member is hosted**: the dual of the official seam philosophy.
3. **team-state single writer**: the central instance owns the JSONL (single writer, no distributed-consistency problem); after migrating to official storageDomain (M3) a remote backend becomes optional.
4. When the official experimental Agent Teams matures, its persistent roster/mailbox/task primitives can be evaluated for sinking (projection/governance layers stay self-built).

## 5. Conclusion

- **Single-machine md full lifecycle: OK** — every step of a large project has a matching mechanism (§2 ten-step table), with exactly two boundaries: binary assets (md keeps references only) and cross-machine scenarios (md moves to git).
- **Multi-machine: designed in, two steps to reach** — first make media cloud (git wiki + inherently cross-machine mailbox/task board/Bitable), then make members remote (official ACP/dsh-sdk wrapped as member-acp/member-dsh-sdk backends). The current code baseline is single-machine; the single-writer principle for team state holds throughout.
