# AI Scorecard — attribution, narrative delivery, and measured impact

**Status:** draft (spec-drafted, not approved)
**Anchor issue:** [#5022](https://github.com/LanternOps/breeze/issues/5022) — device work by AI agents is invisible on the device page
**Also covers:** [#4248](https://github.com/LanternOps/breeze/issues/4248) — email delivery of the weekly AI org narrative · [#4182](https://github.com/LanternOps/breeze/issues/4182) — measured time saved
**Area:** `docs/superpowers/specs/ai-mcp/`
**Author:** spec-author session, 2026-09-13
**Advisor quorum:** Fable (this document) + Codex `gpt-6-astra` xhigh read-only — see [Review log](#review-log)

---

## 1. Problem

Three symptoms of one gap: **Breeze cannot show what its AI did, so it cannot show what its AI is worth.**

**(A) Attribution is missing at the source (#5022).** Todd asked an AI agent to run scripts on device *Kit* (olivetech). Nothing on the device page said an AI had touched the machine. Verified in source:

- `run_script` dispatches with `triggerType: 'manual', triggeredBy: auth.user.id` in both branches (`apps/api/src/services/aiToolsScripts.ts:274` proposal, `:507` library), so the `script_executions` row is indistinguishable from a human tech's manual run.
- `execute_command` (`aiToolsScripts.ts:647`) has no trigger concept at all; the `device_commands` row only gets `created_by`.
- Worse on the autonomous path: `resolveCommandCreatedBy` (`services/commandQueue.ts:441-474`, mirrored at `scriptDispatch.ts:514-531`) probes the `users` table for the actor id and **degrades it to NULL** for an `ai_agent` principal, because `ai_agents.id` is not a `users` row. Agent-issued device work therefore has *no actor whatsoever* today.
- The one exception already shipped: `dispatchScriptToDevice` writes an `ai.script.executed` audit row (`services/scriptDispatch.ts:771-804`) — but **only when `source.kind === 'proposal'`**, i.e. only for AI-*authored* scripts (the #5022/W05 slice of the AI script-authoring feature). Running an existing **library** script through the AI tool — exactly Todd's case — writes nothing. The web side is likewise half-built: `DeviceActivityFeed.tsx:62` already carries an `ai.script.` icon rule and `INITIATOR_LABELS.ai = "AI"`, waiting for rows that never arrive.
- **54 device-mutating AI tool call sites** exist (§4.2). One is a raw insert that bypasses every dispatch helper (`aiToolsBrowser.ts:472`).

**(B) The weekly AI narrative cannot leave the product (#4248).** P2-3 shipped the narrative as an in-app notification plus an authenticated download. Email was deferred on the quorum's D4 finding: `resolveRecipientUserIds` (`services/aiAgents/recipients.ts`) verifies live membership and org access but **not** `reports:export` permission and **not** unrestricted site authority — and an email attaches full-org data. Sending it today would be an authorization leak to site-restricted recipients.

**(C) Impact is estimated, never measured (#4182).** P2-6 shipped `ai_agent_impact_daily` with ten activity counters priced by fixed constants (`DEFAULT_IMPACT_WEIGHTS` in `packages/shared/src/types/aiAgentImpact.ts:41-44` — alertJudged 90 s, ticketTriaged 360 s, fixExecuted 900 s, …). Every number on `/ai-agents/impact` is an activity count multiplied by a guess. Nothing reads MTTR, first-response time, or a single time entry. An MSP evaluating Breeze's AI has no measured evidence at all.

These three are one spec because they are one causal chain: **you cannot measure what you did not attribute, and you cannot report what you cannot measure.** Attribution is the foundation; the scorecard and the narrative are its two readouts.

## 2. Users and scope

| Actor | Need |
|---|---|
| **Technician** (org or partner scope) | On a device page, see at a glance that an AI touched this machine, what it did, and which conversation or agent run to open. |
| **Partner admin / MSP owner** | A defensible answer to "what is the AI worth" — estimated *and* measured — and the weekly narrative delivered by email to the people who should see it. |
| **Customer contact / org-scoped recipient** | Receives the weekly narrative **only** if their live authority covers the whole org. |
| **Compliance / DPO** | AI attribution survives tenant export and org erasure; audit rows remain append-only. |

**Partner vs org.** Nothing in this spec introduces a new config-ish table, so the Partner-Wide First rule (CLAUDE.md) has no new subject: the AI-attribution columns hang off existing org-scoped and system-scoped operational tables, and the impact surfaces reuse P2-6's existing partner-axis weights (`partners.ai_impact_weights`). The measured-impact reads follow P2-6's precedent exactly — `auth.orgCondition(...)` on every read even though RLS enforces, because partner scope means *accessible* orgs, not every org under the partner.

**Out of the users' way.** No new env flag. Attribution is on for every AI surface from the moment it ships; there is no "AI attribution enabled" toggle, because a marker a partner can disable is a marker a tech cannot trust.

## 3. Proposed design

### 3.1 Attribution: one typed tuple, two operational tables, zero audit-log columns

A new Postgres enum and three columns, applied to the two tables that actually record device work:

```sql
CREATE TYPE ai_initiator_kind AS ENUM ('ai_assistant', 'ai_agent');
```

- `ai_assistant` — a human asked, in chat or over MCP; the human stays accountable (`triggered_by` / `created_by` unchanged).
- `ai_agent` — an autonomous agent run decided; there is no human in the loop for this action.
- **NULL means "AI initiation not recorded" — never "a human did this".** No backfill, no `NOT NULL`, no default. This wording is load-bearing, not pedantry: every AI-run library script that already exists stamps `trigger_type='manual'` and the invoker's user id (`aiToolsScripts.ts:507`), so historical AI work will carry NULL. The UI must render NULL as *absence of a marker*, never as affirmative human attribution. (Quorum defect, adopted.)

| Table | New columns |
|---|---|
| `script_executions` | `ai_initiator_kind ai_initiator_kind NULL`, `ai_session_id uuid NULL` (FK → `ai_sessions(id)` ON DELETE SET NULL), `ai_agent_run_id uuid NULL` (**bare uuid, no FK**) |
| `device_commands` | `ai_initiator_kind ai_initiator_kind NULL`, `ai_session_id uuid NULL` (**bare uuid**), `ai_agent_run_id uuid NULL` (**bare uuid**) |
| `audit_logs` | **none** (see below) |

Partial indexes, sized for the two read paths that need them:

```sql
CREATE INDEX IF NOT EXISTS script_executions_ai_device_created_idx
  ON script_executions (device_id, created_at DESC)
  WHERE ai_initiator_kind IS NOT NULL;
CREATE INDEX IF NOT EXISTS script_executions_ai_org_created_idx
  ON script_executions (org_id, created_at DESC)
  WHERE ai_initiator_kind IS NOT NULL;
CREATE INDEX IF NOT EXISTS device_commands_ai_device_created_idx
  ON device_commands (device_id, created_at DESC)
  WHERE ai_initiator_kind IS NOT NULL;
```

**Why not extend `trigger_type`.** `trigger_type` (`db/schema/scripts.ts:23`, values `manual | scheduled | alert | policy | automation`) answers *what scheduled this run*. "AI" answers *who decided*. They are orthogonal — an AI can kick off a policy-driven run, and a human can hand-run an AI-authored script — so collapsing them into one enum destroys information rather than adding it, requires an `ALTER TYPE … ADD VALUE` (a separate committed migration file, per the `2026-06-29-a-report-type-security-compliance.sql` precedent), and silently breaks every exhaustive consumer of the enum.

**Why not a `jsonb` origin blob.** Two hard reasons, not taste. (1) The export-policy contract classifies **every** `json`/`jsonb`/`bytea` column as `excludedOpen`, so on `script_executions` the attribution would be stripped from the tenant GDPR export — precisely the artifact in which a customer asks "who did this to my machine". (2) Typed columns support the partial indexes above; a jsonb key does not, and both the device Scripts tab and the measured-impact queries are index-bound.

**Why `audit_logs` gets no new column.** The vocabulary is already there and already in use: `actor_type` is an enum containing `'ai_agent'` (`packages/shared/src/constants/index.ts:60`) and `initiated_by` contains `'ai'`; `ai.script.executed` already writes both. Decisively, `audit_logs` is append-only — `migrations/2026-05-25-a-audit-log-append-only.sql` REVOKEs UPDATE/DELETE and installs `audit_log_immutable()`, an *unconditional* `RAISE EXCEPTION` on any row UPDATE regardless of which column changed. A FK with `ON DELETE SET NULL` is therefore **physically impossible** on that table, and a bare-uuid column would need a `DISABLE TRIGGER` backfill run as table owner to ever be populated for history. The ids belong in the existing `details` jsonb (already `excludedOpen`, already how `ai.script.executed` carries `executionId`/`proposalId`).

**FK shape rationale.** `script_executions` is a tenant table on the org cascade, so a real FK to the org-scoped `ai_sessions` keeps it honest and lets erasure null it cleanly. `ai_agent_run_id` stays a bare uuid on both tables, following the two existing precedents for pointing at run-shaped rows from a table that must survive erasure and device moves (`script_executions.automation_run_id`; `script_proposals.agent_run_id` at `db/schema/scriptProposals.ts:34`) — `ai_agent_runs` is deliberately excluded from the device-move re-stamp path (`routes/devices/core.ts:210-240`). `device_commands` takes bare uuids for both. Note the correct reason: **not** "no tenant FKs are allowed on it" — `submitted_org_id` is already a real `organizations` FK (`db/schema/devices.ts:585`) — but a deliberate *retention* choice, so an AI session or run that is erased or left behind by a merge cannot block or mutate a system-scoped command row. (Quorum correction, adopted.)

**Lifecycle: the links must detach on move and merge.** `script_executions` follows the device across an org move (`CORE_DEVICE_ORG_DENORMALIZED_TABLES`, `routes/devices/core.ts:295`; re-stamp at `routes/devices/moveOrg.ts:463`), while `ai_agent_runs` deliberately stays with the source org. An execution that moves therefore ends up pointing at a run in a *different tenant*. The same happens on org merge, where executions repoint (`orgMergeRegistry.ts:822`) but runs are left for source erasure (`:214`). **On both device move and org merge, `ai_session_id` and `ai_agent_run_id` are set to NULL while `ai_initiator_kind` is retained.** The fact that an AI did the work survives; the cross-tenant pointer does not. This must be proved by integration tests on move, merge and erasure. (Quorum defect, adopted — this was missing from the first draft and is a genuine cross-tenant exposure vector.)

### 3.2 Threading: `AuthContext.aiOrigin`, stamped at the insert chokepoints

```ts
// middleware/auth.ts — additive, optional
export interface AiOriginRef {
  kind: 'ai_assistant' | 'ai_agent';
  sessionId?: string;    // ai_sessions.id
  agentRunId?: string;   // ai_agent_runs.id
}
// AuthContext gains: aiOrigin?: AiOriginRef
```

Minted **once per AI surface**, never per tool:

| Surface | Mint site | Value |
|---|---|---|
| Autonomous agent run | `services/aiAgents/agentAuthContext.ts:78` (already sets `principal: {kind:'ai_agent', agentId, runId}`) | `{ kind: 'ai_agent', agentRunId: run.id, sessionId: run.sessionId ?? undefined }` |
| Chat / streaming assistant | where the chat auth context is built alongside `ActiveSession.breezeSessionId` (`services/streamingSessionManager.ts:459`) | `{ kind: 'ai_assistant', sessionId }` |
| MCP server | `routes/mcpServer.ts` / `services/mcpExecutionOrg.ts` ledger session | `{ kind: 'ai_assistant', sessionId }` |

Read at exactly the insert chokepoints, which stamp the columns:

| Chokepoint | File |
|---|---|
| `queueCommand` → `db.insert(deviceCommands)` | `services/commandQueue.ts:525` |
| `dispatchPreparedCommand` → `db.insert(deviceCommands)` | `services/commandQueue.ts:1160` (does **not** route through `queueCommand`) |
| `insertQueuedCommandInTransaction` | `services/commandQueue.ts:118` |
| `dispatchScriptToDevice` → `db.insert(scriptExecutions)` | `services/scriptDispatch.ts:536` (values built at `:845-853`) |
| `dispatchDeviceCommand` (the #5128 §D enqueue seam) | `services/dispatchDeviceCommand.ts:73`, persist at `:125` |

**Why `AuthContext` and not `ToolExecutionContext`.** `ToolExecutionContext` (`services/toolExecutionContext.ts:72`) is the optional **third** handler argument, and `services/aiTools.ts:100-121` documents a live trap: the `safeHandler` wrappers in `aiToolsBackupVm.ts`, `aiToolsPolicyPrereqs.ts`, `aiToolsC2C.ts` and `aiToolsConfigPolicy.ts` declare `(input, auth) => …` and **silently drop the third argument with no compile error**; extension tools are called with two arguments by design (`aiTools.ts:576-578`); and `makeSessionAwareHandler` never builds a context at all. Four of the 54 sweep rows already sit behind those wrappers. `AuthContext` is argument two — structurally undroppable at the *handler* boundary — and it reaches every one of the 54 sites *and* the two `executeCommandWithSystemPrecheck` lanes that never enter `executeTool` (`aiAgents/playbookActExecutor.ts:454`, `aiAgents/actVerify.ts:159/210/240`).

**But `AuthContext` alone is NOT sufficient, and the first draft was wrong to claim it was.** The quorum verified that none of the insert chokepoints receives an `AuthContext` at all: `queueCommand` takes `userId` plus an options bag (`commandQueue.ts:480`), `insertQueuedCommandInTransaction` takes a small input object (`:102`), `dispatchPreparedCommand` takes `ExecuteCommandOptions` (`:1111`), and the AI handlers already reduce auth to `auth.user.id` before calling them (`aiToolsScripts.ts:647`). So the origin has to be **explicitly passed through dispatch options** regardless of where it is carried into the tool layer. The design is therefore two-part:

1. **Carrier** — `AuthContext.aiOrigin`, minted per surface as above. It is the *source of truth* inside the tool layer and the only thing that reaches the act/verify bypass lanes.
2. **Conduit** — an explicit `aiOrigin?: AiOriginRef` field on `ExecuteCommandOptions`, the `queueCommand` options bag, `insertQueuedCommandInTransaction`'s input, and `DispatchScriptInput`. The chokepoints stamp from that field.
3. **Enforcement** — an **AI dispatch adapter** (`services/aiDispatch.ts`) whose signature makes `aiOrigin` a *required* parameter, plus a contract test asserting that no file under `services/aiTools*.ts` or `services/aiAgents/**` imports `queueCommand` / `executeCommand` / `dispatchDeviceCommand` / `dispatchScriptToDevice` directly. AI tools may only reach the device through the adapter. This converts "remember to pass it" into a compile error plus a source scan, which is the only control this repo has a good record with.

**Origin must also survive a durable boundary.** `intentReleaseWorker` **rebuilds the auth context from scratch** for a human-owned intent (`jobs/intentReleaseWorker.ts:917`, `services/actionIntents/actorContext.ts:295`), so a chat-minted origin is lost across an approval. The agent-owned branch calls `buildAgentAuthContext` (`actorContext.ts:515`) and is covered by the agent mint. Therefore: **the serializable `AiOriginRef` is persisted on the `action_intents` row at creation and reconstructed by the release worker.** Likewise the MCP path must stamp origin *after* the ledger creates its `ai_sessions` row (`services/mcpToolExecutionLedger.ts:72`) — the MCP transport session id is **not** the persisted `ai_sessions.id` — and the chat path must stamp each refreshed execution context, not only session creation (`services/streamingSessionManager.ts:788`).

**Guarded by source-scan contract tests** (Test API job, no DB needed): no `db.insert(deviceCommands)` / `db.insert(scriptExecutions)` / `tx.insert(deviceCommands)` outside the chokepoint files, and no direct dispatch import from an AI tool file. Code review has a 0/5 record on registration-shaped omissions in this repo; contract tests are 5/5.

### 3.3 Audit emission, broadened

Today only proposal-backed script dispatch writes an AI audit row. The chokepoints gain a single fire-and-forget emission whenever `auth.aiOrigin` is set — reusing the existing vocabulary, never inventing a parallel one:

| Field | Value |
|---|---|
| `actor_type` | derived from the **authenticated principal**, never from authorship: `'ai_agent'` only for the autonomous principal; an assistant-initiated action keeps `'user'` / `'api_key'` |
| `actor_id` | the principal's own id — always consistent with `actor_type` |
| `initiated_by` | `'ai'` |
| `action` | `ai.script.executed` (unchanged) for scripts; **new** `ai.command.executed` for `device_commands` |
| `details` | `{ commandId, executionId?, commandType, aiInitiatorKind, aiSessionId, aiAgentRunId, toolName }` |

`deriveCategory()` (`routes/devices/events.ts:433-450`) already maps the `ai.` prefix to category `'ai'`, and `resolveActorLabel()` already renders `'AI Agent'` for `actor_type='ai_agent'` (`:421-431`). No route change is needed for the feed to carry these rows — only the client allowlist (§3.4).

**Three-way separation, and a defect on main.** *Authorship* (who wrote the script), *initiation* (who decided to run it now), and *authenticated principal* (who the request was) are three different things and must stay three different fields. The shipped `ai.script.executed` emission gets this wrong today: `scriptDispatch.ts:783` derives `actorType` from `source.proposal.authorKind` while `actorId` comes from the invoker, so an AI-*authored* script hand-run by a human writes `actor_type='ai_agent'` paired with a **human user id**. W01 corrects that emission to derive both from the principal, moving authorship into `details`. (Quorum defect, adopted — pre-existing, worth its own line in the PR body.)

**Honesty about the guarantee.** Command audit writes are fire-and-forget (`createAuditLogAsync`; failures caught at `commandQueue.ts:1190`), so "every AI mutation writes an audit row" is a best-effort property, not a contract. The spec claims only best-effort. If the device feed is ever required to be complete, that needs a durable outbox — named as [OD-10](#od-10), not assumed.

### 3.4 Device page surfaces

**Two feed components, not one — the first draft named only one of them.** `DeviceActivityFeed` (`DeviceDetails.tsx:782`) is the **Overview** right-rail feed; the **Activities tab** renders `DeviceEventLogViewer` (`DeviceDetails.tsx:929`). Both read the same `GET /devices/:id/events` and **both** need the AI treatment. (Quorum correction, adopted.)

**Both feeds.** `ACTION_RULES` (`DeviceActivityFeed.tsx:59`) gains an `ai.command.` prefix beside the existing `ai.script.` entry; `ACTION_PREFIXES` derives from it and is sent to the events route. The existing initiator chip (`INITIATOR_LABELS.ai = "AI"`, rendered at `:457-462`) already fires on `initiatedBy: 'ai'` and outranks the "Automated" chip in the precedence at `:429-441` — free once the rows exist. `DeviceEventLogViewer` needs the equivalent, audited against its own action filtering.

**Scripts tab.** `GET /devices/:id/scripts` (`routes/devices/scripts.ts:31-64`) projects no provenance at all today; widen the select by the three new columns. **Do not reuse `RunContextChip`** — it encodes OS execution privilege (`system | user | elevated`, `RunContext.tsx:23`), which is orthogonal to AI initiation, and overloading it would *hide* the privilege a tech most needs to see on an AI-run script. Add a distinct `AiInitiatorChip`, rendered **alongside** the run-context chip. (Quorum defect, adopted.)

**Origin links are an authorization decision, not a href.** An `ai_sessions` transcript is owner-bound (`services/aiAgent.ts:208`), and session navigation goes through `aiStore.switchSession` (`apps/web/src/stores/aiStore.ts:565`) rather than a URL. A technician with device access does **not** thereby have transcript access. So: the chip's default affordance is an **authorized origin summary** (kind, agent or assistant name, timestamp, tool) served by an endpoint that authorizes against the origin object's own ownership rules; a deep link appears only when the viewer actually owns or can access that session or run. Where the origin id is inaccessible — or was detached by a move or merge — the DTO omits the id entirely and the UI reads "origin not available". This is the mitigation for the quorum's single biggest named risk (§9).

**Overview.** One line in the right-rail block: *"AI activity — N actions in the last 7 days"*. **Count each mutation once.** One AI script produces both a `script_executions` row and a `device_commands` row (`scriptDispatch.ts:536` and `:644`), so a naive sum over both tables double-counts every script. Define an action as one *dispatched* mutation, counted from `script_executions` plus only those `device_commands` rows with no owning execution, and state dispatched-vs-completed explicitly in the label. (Quorum defect, adopted.)

All new strings get real translations in all 8 locales (`localeParity` + `translationCoverage` tests).

### 3.5 Narrative email delivery (#4248)

**Extraction.** `emailReportRun` (`jobs/reportScheduleWorker.ts:401-494`) and `emailReportFailure` (`:371-399`) are module-private. Move them **verbatim** into `services/reports/reportDelivery.ts`, export them, re-import into the worker. Behaviour is pinned by a rendered-HTML snapshot test captured *before* the move and re-run after — the extraction must be provably inert. Note the existing shape they impose: they take **email address strings** (not user ids), build in-memory PDF/CSV `Buffer`s via `buildReportPdf`/`rowsToCsv`, drop attachments over `MAX_ATTACHMENT_BYTES` (5 MB, `:99`) in favour of a link, and touch no db handle and no object storage.

**Authority gate.** The call site is the narrative branch of `services/aiAgents/runFinishedNotify.ts` (~`:470-554`), where `resolveRecipientUserIds` has already produced `userIds` for the in-app notification. Each candidate passes only if:

```ts
const live = await resolveLiveReportAuthority(userId, orgId, 'export');   // services/siteScope.ts:1061
if (!live.ok) continue;                                    // user_inactive | membership_removed | permission_removed | …
if (live.authority.scope.kind !== 'unrestricted') continue; // 'restricted' AND 'legacy_unscoped' both fail
```

`legacy_unscoped` **must not pass**: it means the scope is unprovable, and an unprovable scope is not an unrestricted one. **Distinguish denied from temporarily unverifiable**, though: a resolver exception surfaces as `unverifiable_scope` (`services/siteScope.ts:1039`) — fail closed on disclosure, but leave that recipient's delivery row retryable rather than marking it permanently refused. Survivors are then resolved user-id → `users.email` — a step that does **not** exist on this path today, because `emailReportRun` takes addresses. Recipients who fail the gate keep their in-app notification unchanged (the download route already re-verifies the requester's live authority and 404s a restricted requester); only the *email* is withheld. A run where every recipient fails logs a counted, non-failing outcome — silence must be observable.

**Double-send guard — a per-recipient delivery table, not a boolean stamp.** The first draft proposed a single `report_runs.narrative_emailed_at` CAS. The quorum showed that is unsound, and the objection holds:

- A CAS gives **at-most-one committed attempt, possibly zero deliveries**. Claim commits, process dies before sending → the narrative is permanently lost with the flag saying "sent".
- `emailReportRun` **returns normally when no email service is configured** (`reportScheduleWorker.ts:413`) — a no-op that would stamp "emailed".
- The notification loop runs inside `inSystemDbContext` (`services/aiAgents/runFinishedNotify.ts:551`). Sending inside that transaction and then rolling back **erases the claim after the mail has already left**.

So: a durable **`report_run_deliveries`** table — `(report_run_id, recipient_user_id, channel)` UNIQUE, with `state` in `pending | claimed | sent | failed | unknown`, `attempts`, `last_error`, `claimed_at`, `sent_at`. Rules:

- Rows are created **atomically with the artifact** in `persistNarrativeReport`'s existing transaction, not derived later from the in-memory outcome. (Today the narrative is discovered through `outcome.narrativeReport`, which is persisted after the artifact commits — `narrativeReport.ts:124` → `runFinalizers.ts:269` → `runLoop.ts:2223` → `runFinishedNotify.ts:169`. A crash in that gap loses the delivery intent entirely.)
- The claim (`pending → claimed`) **commits before any network call**, and the send happens **outside** any DB transaction.
- An ambiguous provider outcome becomes `unknown` and is **preserved**, never auto-reset to `pending` — replay is a human decision. The email service has no idempotency-key parameter today (`services/email.ts:17`), and even Resend's dedupe retains only 24 h, so unlimited replay is not safe.
- Reconciliation is an independent pass over `pending`/`claimed` rows, giving crash recovery the CAS cannot.

`report_runs` has no `org_id` and is deliberately absent from the cascade / export / merge registries (P2-3), so a *column* add there escapes the export-policy contract; a **new table** does not — `report_run_deliveries` has no `org_id` either (it hangs off `report_runs`), which must be confirmed against the registry contracts in W03 rather than assumed. See [OD-8](#od-8).

One correction to carry forward: the report **worker** swallows delivery failure (`reportScheduleWorker.ts:724`), but the narrative notification path already enqueues durable retries (`runLoop.ts:2302`). Preserve that distinction rather than flattening both.

**Three doors, one path.** (1) `'ai_org_narrative'` stays in `WORKER_EXCLUDED_REPORT_TYPES` (`reportScheduleWorker.ts:155`, enforced at `:163` and `:513`), pinned by a contract test. (2) **Both** recipient writers refuse (409) on an `ai_org_narrative` definition — `POST /reports/:id/recipients` (`routes/reports/recipients.ts:188`) **and `POST /:id/recipients/convert` (`:136`), which inserts attachments independently** and which the first draft missed. (3) The narrative's own delivery is the table above.

**Payload.** The branded PDF rendered from `result.summary.narrative` through the existing `buildReportPdf` path, plus the `/reports` link, under the same 5 MB rule as every other report email. The narrative artifact is a `report_runs` row, not a stored file — there is no signed URL to send.

### 3.6 Measured impact (#4182)

Three measured signals, presented **beside** — never merged into — P2-6's estimate.

| Signal | Definition | Source (all verified present on main) |
|---|---|---|
| **MTTR delta** | Within one (org, alert rule, 90-day window): p50 and p90 of `resolved_at − triggered_at` for AI-touched alerts vs untouched alerts of the same rule | `alerts.triggered_at` / `resolved_at` (`db/schema/alerts.ts:103-128`); AI-touched = an `ai_alert_verdicts` row (P2-1, shipped) or an `ai_agent_runs.alert_id` link |
| **Time to first response** | p50/p90 of `first_response_at − created_at`, AI-triaged vs not | `tickets.first_response_at` (`db/schema/portal.ts:141`), written by `services/ticketService.ts:1516-1522`; an aggregate precedent already exists at `services/portal/ticketReadModel.ts:122-131`. AI-triaged = `ai_agent_runs.ticket_id` or a consumed `ticket_drafts` row |
| **Technician minutes per ticket** | p50/p90 of summed `duration_minutes` per ticket, AI-triaged vs not | `time_entries` (`db/schema/timeTracking.ts:22-72`) — partner-axis RLS, has `ticket_id`, `duration_minutes`, `is_billable`, `source`, `is_approved` |

**The naive version of this is worse than no metric, and the quorum proved it.** Three defects that would have shipped a number flattering to the AI and false:

1. **Reverse temporal attribution.** The verdict subscriber deliberately waits before starting AI analysis, so an alert that self-resolves in five minutes and is *then* analysed enters the "AI-touched" cohort as a five-minute MTTR (`services/aiAgents/alertVerdictSubscriber.ts:388`). The AI would be credited for outcomes that completed before it looked. Identically on tickets: **resolved** tickets trigger AI runs for resolution notes (`services/aiAgents/ticketHelpdeskSubscriber.ts:439`), so an `ai_agent_runs.ticket_id` link is no evidence of involvement before first response.
2. **Group verdicts are invisible to a direct link.** Correlation-group verdicts carry `alert_id = NULL` by design (`services/aiAgents/alertVerdicts.ts:354`, membership traversal at `:535`), so a direct-linkage predicate silently drops them.
3. **Resolved-only percentiles omit still-open cases.** A complete calendar day is not a complete outcome; conditioning on completion biases both arms differently.

**Therefore the metric is defined by exposure time, not by linkage:**

- **AI exposure is a timestamped event**, taken as the earliest AI contact with the item — the verdict's `created_at` (direct or via correlation-group membership), or the run's start — and **an item enters the AI arm only if exposure precedes the outcome being measured.** Each alert is deduplicated once across direct and group paths. Follow the existing rollup's precedent of demanding more than a link: `impactRollup.ts:190` already requires a qualifying profile, status, absence of error, and an outcome.
- **Fixed exposure age L.** Cohorts are formed among items still open/unanswered at a prespecified age *L*, then compared on what happens after. This removes the self-resolution artefact structurally rather than by caveat.
- **Primary statistic: proportion resolved/responded within horizon H**, with enough follow-up time — not a duration percentile. Duration p50/p90, if shown at all, is explicitly labelled *conditional on completion*.
- **Right-censoring is the fuller answer.** Still-open items are censored, not dropped; Kaplan–Meier gives p50/p90 that are honest about incomplete observation, emitted only when estimable. Recorded as the target shape in [OD-6](#od-6).
- **Cohort within a rule** (alerts) or priority+category (tickets), one org, one window. Comparing all AI-touched to all untouched measures which items the AI *chose*.
- **n < 20 per arm ⇒ no number** — a display gate, and explicitly *not* a substitute for the above. At n=20 the upper decile holds about two observations, so p90 is reported with its cohort size and uncertainty or not at all.
- **Never called "before/after".** "AI-touched vs untouched in one window" is a contemporaneous comparison. Either name it accurately or define an explicit adoption breakpoint; the issue's "MTTR before/after" phrasing describes the latter and this spec does not silently substitute the former.
- **Labelled correlational, with the bias named** — the AI triages the easy items first — in the same spirit as P2-6's rule that a thumbs-up is never called "precision".

**Timestamp trap.** `alerts.triggered_at` / `resolved_at` are plain `timestamp` (`db/schema/alerts.ts:115`), whereas P2-6's SQL operates on `timestamptz` (`impactRollup.ts:25`). Copying P2-6's `AT TIME ZONE 'UTC'` casts blindly onto alert columns shifts the bound. Normalize deliberately and pin it with a test.

**Time entries need care of their own.** A running timer has NULL `duration_minutes` (`db/schema/timeTracking.ts:54`), and an absent entry is *missing information, not zero labour*. Measure **recorded technician minutes per ticket**: aggregate entries per ticket first, then compare cohorts, and publish the logging-coverage rate alongside — a delta computed over 30 %-logged tickets is not a delta.

**Authorization is a new decision, not an inheritance.** `/ai-agents/impact` requires AI read permission (`routes/aiAgents.ts:1552`), but `time_entries` deliberately requires partner/system scope plus a `time_entries` permission, and an ordinary standalone read is limited to the caller's *own* entries (`routes/timeEntries/timeEntries.ts:23`, `:205`). Publishing org-wide labour comparisons on the impact page is therefore a **new authorization decision**, and a system-context query to get around those restrictions would bypass the existing policy outright — exactly the anti-pattern CLAUDE.md names (#2417). The measured band's technician-minutes arm requires the caller to hold the time-entry permission and partner scope; otherwise that arm is omitted while MTTR and TTFR still render. Measured reads also need explicit **site** handling: existing impact filtering is organizational (`services/aiAgents/impactQuery.ts:169`) while run visibility treats site authority as an additional boundary (`services/aiAgentRunSiteScope.ts:6`). W04 requires unrestricted site scope for the measured band in its first release rather than inventing scoped aggregation under time pressure. (Quorum defect, adopted.)

**Not a rollup table.** These are windowed cohort comparisons, not per-day counters — a `_daily` table would have to be rebuilt for every window anyway. Ship a read-time service `services/aiAgents/impactMeasured.ts` over the existing tables, capped at 90 days, inheriting P2-6's UTC and complete-day rules verbatim (`(<col> AT TIME ZONE 'UTC')::date`; half-open bounds with the load-bearing `::timestamp` cast; `through` is the last *complete* UTC day). Add a rollup only if measured p95 latency forces it — recorded as [OD-6](#od-6).

**`sla_compliance` is not a source.** `db/schema/analytics.ts:222-257` has `response_time_actual` / `resolution_time_actual` columns, but grep finds **no writer** anywhere — they are never populated. Anything reading them would report zeros as fact.

### 3.7 Where the scorecard lives

The existing `/ai-agents/impact` page (`apps/web/src/pages/ai-agents/impact.astro` → `components/aiAgents/ImpactPage.tsx`), which already renders the estimate tiles, the daily stacked bar, the per-org table, the weights drawer and a branded PDF export. It gains a **Measured** band beneath the estimate band, visually separated, with its own "measured, correlational" heading. The narrative gets a *reference* to the measured figures in its existing sections — it does not become a second scorecard. Rationale in [OD-5](#od-5).

## 4. Tenancy and data model impact

### 4.1 Registration lists — the mechanical checklist

Six column-adds across two tables in W01, and one new table in W03:

| Table | Columns | `CORE_ORG_CASCADE_DELETE_ORDER` | `CORE_DEVICE_CASCADE_DELETE_TABLES` | `CORE_DEVICE_ORG_DENORMALIZED_TABLES` | `CORE_TENANT_EXPORT_POLICY` | org-merge |
|---|---|---|---|---|---|---|
| `script_executions` | 3 | already present (`tenantCascade.ts:638`) — no change | already present (`routes/devices/core.ts:521`) — no change | already present (`core.ts:295`) — no change | **3 new `included` strings required** (`tenantExportPolicyRegistry.ts:487`) | already in `REPOINT_TABLES` (`orgMergeRegistry.ts:822`) — no change |
| `device_commands` | 3 | absent by design (`ASSOCIATED_SYSTEM_SCOPED_TABLES`, `tenantCascade.ts:801`) | already present (`core.ts:497`) — no change | absent (no `org_id`) | **no entry exists** — nothing to add | `follows-parent` (`orgMergeRegistry.ts:65`) — no change |
| `report_run_deliveries` (**new**, W03 — [OD-8](#od-8)) | new table, no `org_id` | must be **confirmed**, not assumed: `report_runs` is deliberately outside these registries, and a child of it plausibly follows — W03 verifies against the live contracts | n/a | n/a | no `org_id` ⇒ expected to be out of export scope (`tenantExportPolicy.ts:103-108` requires `org_id` or `id`) — **verify** | classify explicitly |
| `audit_logs` | 0 | — | — | — | — | — |

**The one line that will redden CI if missed:** the three `script_executions` columns must be added to `CORE_TENANT_EXPORT_POLICY` in the same PR. `buildExportPlan` compares live `information_schema` columns against the policy and throws `missing classifications: …` (`services/tenantExportPolicy.ts:195-201`). All three are typed scalars — `ai_initiator_kind` an enum, two uuids — none matching `SUSPICIOUS_NAME_PARTS`, so all three go in `included`, not `reviewedIncluded` and not `excludedOpen`. That classification is itself the argument against the jsonb blob in §3.1: an `ai_origin jsonb` would be forced to `excludedOpen` and vanish from the tenant export.

**RLS.** W01 adds no tables, so no new policies and no allowlist entries in `rls-coverage.integration.test.ts`. `script_executions` keeps its shape-1 `org_id` policy. `device_commands` keeps its system scope: the quorum confirmed that both the RLS and cascade discovery checks match the **literal** column name `org_id` (`rls-coverage.integration.test.ts:1204`, `tenantCascade.integration.test.ts:55`), so `ai_session_id` is not inferred as a tenant key and the property the `devices.ts:581-584` comment protects is untouched. W03's `report_run_deliveries` is a new table and must pick and register a shape — it has no `org_id`, so it follows `report_runs`' FK-child backstop pattern, which W03 confirms against the live contracts rather than assuming.

**Composite-FK / deferrable rule.** Does **not** apply. The only new FK is `script_executions.ai_session_id → ai_sessions(id)` — a single-column FK to a primary key, not a composite `(x, org_id) → parent(id, org_id)`. Org merge repoints `org_id` on both tables independently and never touches this edge, so `DEFERRABLE INITIALLY IMMEDIATE` is not required. (It is required for composite org FKs precisely because `SET CONSTRAINTS ALL DEFERRED` re-points parent and child in separate statements; that mechanism is not in play here.)

**Erasure.** `ai_sessions` is org-cascade-deleted; the `ON DELETE SET NULL` on `script_executions.ai_session_id` means a partial erasure that removes a conversation leaves the execution row with its `ai_initiator_kind` intact — the *fact* that an AI did it survives even when the *evidence* is erased. This is deliberate and mirrors the "evidence erased" behaviour the script-authoring feature already ships for proposals. An integration test must prove a full org erasure still succeeds with AI-attributed rows present.

### 4.2 The sweep — every device-mutating AI tool

54 verified call sites. The design's claim is that **all of them are covered by five chokepoints plus one fix**, because none of them insert device work themselves except one.

| Group | Sites | Reaches the device via |
|---|---|---|
| Scripts (`run_script` ×2 branches, `cancel_script_execution`) | 3 | `dispatchScriptToDevice` → `script_executions` + `device_commands` |
| Direct command tools (`execute_command`, `manage_services`, `manage_processes` ×2, `manage_scheduled_tasks`, `registry_operations`, `file_operations`, `analyze_disk_usage`, `disk_cleanup`, `set_agent_log_level`, `capture_agent_pprof`, `trigger_agent_upgrade`, `trigger_agent_restart`, `take_screenshot`, `analyze_screen`, `computer_control`, `security_scan`, `remediate_sensitive_data`, `analyze_boot_performance`, `manage_startup_items`, `network_discovery`) | 21 | `executeCommand` / `queueCommandForExecution` / `queueCommand` → `device_commands` |
| Backup / virtualisation / data (`restore_snapshot`, `restore_as_vm`, `instant_boot_vm`, `manage_hyperv_vm`, `trigger_hyperv_backup`, `restore_hyperv_vm`, `manage_hyperv_checkpoints`, `trigger_mssql_backup`, `restore_mssql_database`, `verify_mssql_backup`, `trigger_vault_sync`) | 11 | `queueCommandForExecution` → `device_commands` |
| Incident (`execute_containment`, `collect_evidence`) | 2 | `queueCommandForExecution` → `device_commands` (+ `incident_actions`) |
| **Rogue** `manage_browser_policy` | 1 | **raw `db.insert(deviceCommands)` at `aiToolsBrowser.ts:472`** — bypasses `queueCommand`, `dispatchDeviceCommand` *and* `resolveCommandCreatedBy` |
| Agent act/verify lanes | 2 files, 4 sites | `executeCommandWithSystemPrecheck` → `dispatchPreparedCommand`; never enters `executeTool` |
| Indirect — a row that a worker later turns into device work (`manage_patches` install/rollback → `patch_jobs`/`patch_rollbacks`; `manage_deployments` → `deployments`; `manage_automations` run → `automation_runs`; `execute_playbook` → `playbook_executions`; `request_elevation`/`revoke_elevation` → `elevation_requests`) | ~8 | the worker dispatches later, under its **own** auth context |
| Arms-future-change (`apply_configuration_policy`, agent-managed automations, policy creation) | ~3 | no immediate device write |
| External (`s1_isolate_device`, `s1_threat_action`, `sync_huntress_data`) | 3 | vendor API — no Breeze device table |

**Four paths the chokepoint story does NOT cover — the quorum found these and they change W01's scope:**

| Path | Why the chokepoints miss it |
|---|---|
| **Backup** | AI enqueues backup work (`aiToolsBackup.ts:553` → `jobs/backupEnqueue.ts:138`); the worker then builds an `AgentCommand` and calls `dispatchCommandToAgent` **directly** (`jobs/backupWorker.ts:1011`, `:1189`), never touching `device_commands`. Queue metadata defaults to system. Without explicit handling, **AI-initiated backups stay invisible**. |
| **Peripheral reconciliation** | A second AI-reachable raw insert: `aiToolsFleet.ts:1318` (group change) → `jobs/peripheralJobs.ts:344` → `services/peripheralPolicyState.ts:262` does `tx.insert(deviceCommands)` directly. |
| **SentinelOne** | `s1_isolate_device` / `s1_threat_action` genuinely mutate the endpoint through the provider API (`services/sentinelOne/actions.ts:233`, `:388`), outside Breeze's command queue. They mutate a real device even though no Breeze command row exists, so "out of scope" is too glib — they need their own durable attribution and a device audit event. |
| **Patch jobs** | The final insert *is* centralized, but origin is lost before it: the AI creates the job with `createdBy` (`aiToolsFleet.ts:932`) and the later dispatch (`jobs/patchJobExecutor.ts:1191`) passes neither that actor nor any AI origin. A propagation hole, not an insert hole. |

**Consequences the design states plainly:**

1. **Two rogue inserts must be converted** in W01 — `aiToolsBrowser.ts:472` and `services/peripheralPolicyState.ts:262` — or they are permanent silent holes. The source-scan contract test (§3.2) must cover `tx.insert(...)` as well as `db.insert(...)`; the first draft's scan would have missed the peripheral one.
2. **The direct-transport path needs its own seam.** `dispatchCommandToAgent` bypasses `device_commands` entirely, so backup work cannot be attributed by any column on that table. Either the backup job row carries the origin and the worker emits the audit event, or AI-initiated backups are declared out of scope *in writing*. See [OD-3](#od-3).
3. **The indirect group needs origin on the intermediate row** — patch jobs, deployments, automation runs, playbook executions, elevation requests. See [OD-3](#od-3).
4. **Provider-API actions get an audit event, not a column.** SentinelOne isolation is real device work; it earns an `ai.` audit row against the device even with no Breeze command row.

## 5. Out of scope

- **Designing #4177** (AI time suggestions, actual-labor vs AI-duration split). Referenced only; being planned in parallel. This spec deliberately asserts that #4182's time-entry arm is *not* blocked on it — see [OD-4](#od-4).
- **A device-level AI scorecard.** The device page gets a signal and a chip, not an impact dashboard.
- **Attribution for external-API actions** (SentinelOne, Huntress) — no Breeze device write exists to mark.
- **Backfilling historical attribution.** Rows before this ships stay NULL. `audit_logs` history cannot be backfilled at all without an owner-privileged `DISABLE TRIGGER`, and will not be.
- **Causal claims of any kind.** The measured band reports observed cohort differences. No A/B, no counterfactual, no "the AI saved you X hours".
- **Emailing anything other than the weekly narrative.** The `reportDelivery.ts` extraction is behaviour-preserving; no other report changes delivery.
- **A new env flag / kill switch for attribution.** Deliberate — see §2.

## 6. Open Decisions

<a id="od-1"></a>
### OD-1. Attribution carrier: `AuthContext.aiOrigin` vs `ToolExecutionContext.aiOrigin` vs a side table

- **A — `AuthContext.aiOrigin` (argument 2).** Pro: structurally undroppable; already reaches all 54 sites *and* the two `executeCommandWithSystemPrecheck` lanes that never enter `executeTool`; default-on so a new tool cannot forget; zero handler-signature changes. Con: widens a very hot, security-sensitive type; must be minted correctly at three surfaces, and any lane that rebuilds a fresh `AuthContext` mid-flight loses it.
- **B — `ToolExecutionContext.aiOrigin` (argument 3).** Pro: purpose-built per-invocation context; already carries `actionIntentId`. Con: the `safeHandler` wrapper trap documented at `aiTools.ts:100-121` silently drops argument 3 in four tool files (covering four sweep rows) with **no compile error**; extension tools are called with two arguments by design; `makeSessionAwareHandler` builds no context at all; and it never reaches the act/verify bypass lanes.
- **C — Populate the existing `ai_tool_executions.command_id` and join.** Pro: no schema change on hot tables. Con: that column has **no writer anywhere** today (verified by grep) — it is dead; `ai_tool_executions` has no `org_id` and no `device_id`, so the device page would need a three-table join on every row; and it cannot express the act/verify lanes, which mint no tool-execution row.

**Recommend A as the carrier — but A alone is insufficient, and the quorum proved why.** No chokepoint receives an `AuthContext` at all (`commandQueue.ts:102`, `:480`, `:1111`), so the origin must be passed explicitly through dispatch options regardless. The resolved design is **A + an explicit `aiOrigin` on the dispatch options + a mandatory-origin AI dispatch adapter + a contract test forbidding AI tools from importing un-attributed dispatch** (§3.2), plus persistence of the serializable origin on `action_intents` so it survives `intentReleaseWorker`'s from-scratch auth rebuild (`jobs/intentReleaseWorker.ts:917`). Recorded as a **disagreement resolved on the merits**: the quorum's factual correction stands, its adapter proposal is adopted, and A is retained only as the in-process carrier and the sole route into the act/verify bypass lanes.

<a id="od-2"></a>
### OD-2. `ai_assistant` vs `ai_agent` as two enum values, or one boolean plus the ids

- **A — Two-value enum, NULL = human.** Pro: the distinction is the one a tech actually cares about ("a human asked for this" vs "nobody was watching"); it is closed and indexable; NULL needs no backfill. Con: a third surface later (a scheduled AI job? a customer-portal AI?) needs an `ALTER TYPE ADD VALUE` in its own committed migration file.
- **B — `is_ai boolean` + let `ai_session_id` / `ai_agent_run_id` imply the kind.** Pro: no enum, no future `ALTER TYPE`. Con: the implication is not enforceable — an agent run also has a session id, so the two columns cannot distinguish the cases; and a row with the boolean set but both ids NULL (a lane we failed to thread) is indistinguishable from a correctly-attributed one.
- **C — Reuse the existing `initiated_by_type` enum** (`['manual','ai','automation','policy','schedule','agent','integration']`, already on `audit_logs`). Pro: one vocabulary across audit and operational tables. Con: it does not distinguish assistant from autonomous, which is the whole point; and it mixes trigger semantics back into actor semantics — the §3.1 objection to `trigger_type`, restated.

**Recommend A.** The assistant/autonomous split is the load-bearing distinction for both trust and the scorecard, and a closed enum is what makes it queryable.

<a id="od-3"></a>
### OD-3. Attribution across the deferred boundary (patch jobs, deployments, automation runs, elevations, playbooks — and backup)

When an AI tool creates a `patch_job` / `deployment` / `automation_run` / `elevation_request`, the *device command* is dispatched later by a worker whose `AuthContext` has no `aiOrigin` (`aiToolsFleet.ts:932` → `jobs/patchJobExecutor.ts:1191`). Roughly eight sweep sites are in this shape. **Backup is worse**: it never creates a `device_commands` row at all — `jobs/backupWorker.ts:1011/1189` calls `dispatchCommandToAgent` directly — so no column on any table in §3.1 can attribute it.

- **A — Propagate onto the intermediate row.** Add the same three columns to each intermediate table, and have the worker read them back into the `aiOrigin` it passes to the chokepoint. Pro: complete and truthful attribution end-to-end. Con: four to five more tables, each with its own export-policy entries — a materially larger W01, and each new table is another registration checklist to get right.
- **B — Ship direct-dispatch attribution now; file the indirect lanes as a follow-up.** Pro: covers Todd's reported case and the large majority of the 54 sites in one wave; keeps the migration small and the contract surface tight. Con: a patch installed by an AI still reads as an ordinary patch job on the device page — a known, documented gap rather than a fixed one.
- **C — Attribute the intermediate row only** (mark the `patch_job` as AI-created, do not thread into the command). Pro: cheap, and the *decision* is what an auditor cares about. Con: the device Activities feed still shows an unattributed command, which is the exact symptom #5022 filed.

**Recommend B for W01, with A's table list enumerated here and filed as a tracked follow-up before W01 merges** — so the gap is a decision on the record, not an omission. Two amendments after the quorum: (i) **the W01 release notes and the device page must not imply completeness** while backup and patch are unattributed; (ii) the quorum argues W01 "leaves backups invisible", which is a fair characterisation — if Todd judges AI-initiated backup/patch work to be a primary complaint rather than a secondary one, promote `patch_jobs` **and** the backup job row into W01, accepting a materially larger wave. **This is the decision most worth Todd's explicit call.**

<a id="od-4"></a>
### OD-4. Is #4182 blocked on #4177?

The issue text says "Depends on the time-entry roadmap item." **Verified: `time_entries` already exists on main** (`db/schema/timeTracking.ts:22-72`, with `ticket_id`, `duration_minutes`, `is_billable`, `source`, `is_approved`, and routes at `routes/timeEntries.ts`).

- **A — Not blocked. Ship the measured band on today's data.** Pro: MTTR and TTFR need nothing new at all, and the technician-minutes delta needs only existing `time_entries` rows; #4177 adds AI *suggestions* and an actual-labor/AI-duration split, which enrich the metric but are not required to compute it. Con: on partners who do not log time consistently, the technician-minutes arm will mostly render "not enough data" — an honest but unimpressive first showing.
- **B — Blocked; wait for #4177.** Pro: one coherent launch with the labor split. Con: delays two metrics (MTTR, TTFR) that are fully computable today for a dependency neither of them has.

**Recommend A**, and update #4182's description to say so. Flagged explicitly because it contradicts the filed issue and should be Todd's call to ratify.

<a id="od-5"></a>
### OD-5. Where the scorecard is presented

- **A — Extend the existing `/ai-agents/impact` page with a Measured band.** Pro: one page, one mental model; reuses the window selector, per-org table, weights drawer and PDF export already built; keeps estimated and measured visibly adjacent, which is the honest presentation. Con: `ImpactPage.tsx` is already ~1000 lines and will grow.
- **B — A new `/ai-agents/scorecard` page.** Pro: clean separation of estimated from measured; room to grow. Con: two pages answering "what is the AI worth" is exactly the confusion that makes an MSP distrust both; and it splits the PDF export.
- **C — Fold the measured figures into the weekly narrative only.** Pro: no new UI. Con: a weekly artifact is not a dashboard; a partner cannot pick a window or drill to an org; and the narrative is model-authored prose, which is the wrong container for numbers that must not be paraphrased.

**Recommend A**, splitting `ImpactPage.tsx` into an estimate band component and a measured band component at the same time (the file-size guideline earns its keep here).

<a id="od-6"></a>
### OD-6. Measured impact: read-time query vs a rollup table

- **A — Read-time service `impactMeasured.ts`, 90-day cap.** Pro: no new table, therefore no cascade/export/merge/RLS registration at all; cohort windows are inherently re-computed, so a daily rollup would be rebuilt for every window anyway; correctness is easier to prove. Con: heavier queries on the impact page; needs indexes on `alerts (org_id, rule_id, triggered_at)` and the ticket equivalents, and a p95 budget in the plan.
- **B — A rollup table mirroring P2-6's nightly pattern.** Pro: fast reads, an established idempotent-rebuild pattern to copy. Con: percentiles do not aggregate — you cannot compute a 90-day p90 from ninety daily p90s — so the table would have to store raw durations or sketches, which is a much bigger design; plus a fifth registration checklist.

**Recommend A**, with an explicit p95 latency budget in the plan and B named as the escape hatch if it is exceeded. **Amended after the quorum:** the statistic itself is the harder question. Ship the *proportion resolved/responded within H among items open at exposure age L* as the primary figure, and treat Kaplan–Meier right-censored p50/p90 as the target refinement rather than the v1 — but do **not** ship uncensored resolved-only percentiles as the headline, which was the first draft's implicit plan and would systematically flatter the AI arm.

<a id="od-8"></a>
### OD-8. Narrative delivery durability

- **A — `report_runs.narrative_emailed_at` + CAS** (first draft). Pro: one nullable column, no new table, no registry work. Con: at-most-once, possibly **zero** — a crash after the claim loses the narrative silently; a no-op send (no email service configured, `reportScheduleWorker.ts:413`) stamps "emailed"; and a rollback of the enclosing `inSystemDbContext` transaction (`runFinishedNotify.ts:551`) erases the claim after the mail has left.
- **B — `report_run_deliveries` table**, `(report_run_id, recipient_user_id, channel)` UNIQUE, `pending|claimed|sent|failed|unknown`, rows created atomically with the artifact, claim committed before the network call, ambiguous outcomes preserved as `unknown`, independent reconciliation pass. Pro: crash-recoverable, per-recipient observability, no false "sent". Con: a new table — cascade/export/merge/RLS registration to get right (it has no `org_id`, hanging off `report_runs`, which itself is deliberately outside those registries — that needs confirming, not assuming); materially larger W03.
- **C — B's semantics without a table**, encoded in the existing `report_runs.result` jsonb. Pro: no new table. Con: jsonb is `excludedOpen` by policy, unindexable for a reconciliation scan, and read-modify-write races between recipients.

**Recommend B.** The whole point of #4248 is that the narrative reaches people; a guard whose failure mode is "silently never sent" defeats the feature it protects. Flagged as the largest single scope increase the quorum caused.

<a id="od-9"></a>
### OD-9. Origin link exposure

- **A — Authorized origin summary by default; deep link only for viewers who can access the session or run.** Pro: closes the quorum's biggest named risk (a provenance pointer treated as permission to disclose its target — transcripts are owner-bound at `services/aiAgent.ts:208`, and device history can move tenants while run history stays behind). Con: an extra endpoint, and most techs see a summary rather than the conversation.
- **B — Always deep-link; let the target route 403.** Pro: trivial. Con: a dead link is a bad UI *and* the id itself leaks that a particular session touched this device, across a tenant boundary after a move.
- **C — No link at all; chip only.** Pro: safest, cheapest. Con: the issue explicitly asks to link to the conversation or agent run.

**Recommend A**, with the DTO **omitting** the id entirely when the viewer cannot resolve it (not returning it and hiding it client-side).

<a id="od-10"></a>
### OD-10. Is device-page AI attribution a completeness contract?

Audit writes on the command path are fire-and-forget with caught failures (`commandQueue.ts:1190`), so a dropped row is invisible.

- **A — Best-effort, stated as such.** Pro: no new machinery; matches every other audit caller in the repo. Con: "what has been done to this machine" is exactly the question a tech must be able to trust, and a silently missing row is worse than a visibly missing feature.
- **B — Durable outbox** (write the audit intent in the same transaction as the command insert; a worker drains it). Pro: a real guarantee. Con: new infrastructure well beyond this spec's scope, and it would want to cover every audit caller, not just AI ones.

**Recommend A for these waves**, stated explicitly in the UI copy and the docs, with B filed as a platform-level follow-up. Raised here because the first draft's phrasing implied a guarantee the code does not provide.

<a id="od-7"></a>
### OD-7. Recipients who fail the export-authority gate

- **A — Silently withhold the email; keep the in-app notification.** Pro: no information leak about who has what authority; the recipient still gets the narrative through a path that re-verifies their scope at download. Con: a partner admin cannot tell why a customer contact never got the email.
- **B — Withhold, and surface a "N recipients skipped (insufficient report authority)" line on the run detail.** Pro: observable; the admin can fix the permission. Con: a count is a small authority oracle — though only to someone who can already see the agent run.
- **C — Fail the whole delivery if any recipient fails the gate.** Pro: loudest. Con: one site-restricted contact silently kills the weekly report for everyone — a worse failure than the one being prevented.

**Recommend B.** A skipped-count on a surface that already requires `ai_agents:read` is a negligible oracle next to a permanently invisible failure. **C is rejected outright.**

## 7. Test and rollout notes

**Contract tests (Test API job — no database, so these fail fast on every PR):**
- Source-scan: no `db.insert(deviceCommands)` / `db.insert(scriptExecutions)` outside the chokepoint files. *This is the control that keeps the sweep swept.*
- `WORKER_EXCLUDED_REPORT_TYPES` still contains `'ai_org_narrative'`.
- Every AI surface that mints an `AuthContext` sets `aiOrigin` (a table test over the mint sites).
- `migrationRlsScope.test.ts` — the new migration writes no rows, so no `set_config('breeze.scope','system',true)` is needed; assert it stays that way rather than joining the frozen 122-offender baseline.

**Integration tests (Integration Tests job — real Postgres; these are the ones a stale base hides):**
- `tenant-export-policy.integration.test.ts` and `tenantExportErasureRoundtrip.integration.test.ts` — the three new `script_executions` columns are classified. **This is the failure a unit-green PR will hit on main if the export-policy entry is forgotten.**
- `tenantCascade.integration.test.ts` — unchanged lists still pass with the new columns present.
- Org erasure succeeds with AI-attributed `script_executions` and `device_commands` rows present, and with an `ai_sessions` row deleted underneath a surviving execution (proves the `ON DELETE SET NULL`).
- Org merge repoints `script_executions.org_id` with `ai_session_id` populated (proves no deferrable-FK requirement was missed).
- Narrative email: a site-restricted recipient and a `legacy_unscoped` recipient are both excluded; an unrestricted one receives; a second finalizer pass sends **zero** additional emails (the CAS).
- A live-Postgres proof that an AI-dispatched library script (not a proposal) produces both the attributed `script_executions` row and the `ai.command.executed`/`ai.script.executed` audit row, and that `GET /devices/:id/events` returns it — the exact reproduction of Todd's Kit case.

**Web tests:** `DeviceActivityFeed` renders the AI chip and the deep link; `DeviceScriptHistory` renders the AI variant of `RunContextChip`; Overview shows the count line; `localeParity` + `translationCoverage` for all 8 locales; `no-silent-mutations` unaffected (no new mutations on the device page).

**Migrations.** `main`'s newest is `2026-10-16-180200-monitor-definitions-builtin-key.sql`; slots `180300` and `180500` are taken by in-flight PRs. Use **`2026-10-16-181200-ai-device-attribution.sql`** (W01) and **`2026-10-16-181400-report-run-deliveries.sql`** (W03). Both idempotent (`CREATE TYPE` guarded by a `DO $$ … EXCEPTION WHEN duplicate_object`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`), no inner `BEGIN;`/`COMMIT;`, no DML so no `breeze.scope` elevation needed. Re-check the newest committed migration at PR time — the naming ratchet runs ahead of real time and a sibling PR may land a later name.

**CI traps to repeat in every plan:** the export-policy and cascade suites run **only** in Integration Tests, so a unit-green PR on a stale base can redden main after merge; a PR based on a sibling branch runs **no CI at all** (`ci.yml` triggers on `pull_request: branches: [main]`) and `gh pr checks` reads green — dispatch `gh workflow run CI --ref <branch>` before merging a stacked PR; `pnpm test` runs neither the RLS nor the integration config; never write `pnpm --filter <pkg> test -- --run <path>`; `vitest run <path>` is a substring filter, not a glob.

**Rollout.** No env flag, no policy-snapshot bump, no new permission (existing `devices:read` for the device surfaces, `ai_agents:read` for the impact page). Attribution begins with the first AI action after deploy; historical rows stay NULL and the UI must render that as "no AI marker", never as "not AI" for pre-deploy rows on a device whose history spans the boundary. Waves land independently — W02 is inert but harmless without W01's rows, and W03/W04 do not depend on W01 at all.

## 8. Waves sketch

| Wave | Issue | Scope | Gate |
|---|---|---|---|
| **W01 — Attribution at the source** | #5022 | Migration (enum + 3 columns × 2 tables + partial indexes); `AuthContext.aiOrigin` + mint sites incl. MCP-after-ledger and chat refresh; explicit `aiOrigin` on dispatch options; mandatory-origin AI dispatch adapter; origin persisted on `action_intents` and reconstructed by `intentReleaseWorker`; convert **both** rogue inserts (`aiToolsBrowser.ts:472`, `peripheralPolicyState.ts:262`); corrected + broadened audit emission (principal-derived actor, `ai.command.executed`); detach-on-move/merge; export-policy entries; two source-scan contract tests | Export-policy + cascade + **move + merge + erasure** suites green under Integration Tests; live-Postgres reproduction of the Kit case; approved-intent reconstruction proved |
| **W02 — Device page surfaces** | #5022 | `ai.command.` action rule + AI chip in **both** `DeviceActivityFeed` (Overview) **and** `DeviceEventLogViewer` (Activities); widened `GET /devices/:id/scripts` + a **new** `AiInitiatorChip` rendered alongside `RunContextChip`; authorized origin-summary endpoint (id omitted when unresolvable); de-duplicated Overview count; 8 locales | Web suite + locale parity; a viewer without session access sees the summary and no id; count proven not to double-count a script |
| **W03 — Narrative email** | #4248 | `services/reports/reportDelivery.ts` extraction (snapshot **plus** attachment / oversize-fallback / missing-provider / transport-failure tests); per-recipient `resolveLiveReportAuthority(…, 'export')` unrestricted-only gate with `unverifiable_scope` kept retryable; user-id→email resolution; **`report_run_deliveries`** table created atomically with the artifact, claim-before-send, send outside any transaction, reconciliation pass; 409 on **both** recipient writers; contract test on the worker exclusion | Integration proof: restricted and `legacy_unscoped` excluded, unrestricted delivered, a second pass sends zero, and a simulated crash after claim is recovered rather than lost |
| **W04 — Measured impact** | #4182 | Exposure-time semantics and source-data correctness **first** (exposure timestamp incl. correlation-group traversal, age *L*, horizon *H*, censoring, `timestamp` vs `timestamptz` normalization, logging coverage); aggregate authorization (time-entry permission + unrestricted site scope) **before** any query/UI work; then `services/aiAgents/impactMeasured.ts`, indexes, DTO, Measured band, `ImpactPage.tsx` split | Integration proof per metric against seeded cohorts, **including a self-resolving alert analysed afterwards being excluded from the AI arm**, a group-verdict alert being included exactly once, and the n<20 suppression path |

W01 → W02 is a hard order (W02 renders W01's data). W03 and W04 are independent of both and of each other.

<a id="review-log"></a>
## 9. Review log

**Fable (spec author), 2026-09-13.** Position as written in §3 and the Open Decisions. Key judgements: attribution belongs on `AuthContext` rather than `ToolExecutionContext` because of the documented argument-3 truncation trap; `audit_logs` takes no new column because its immutability trigger makes an `ON DELETE SET NULL` FK physically impossible; typed columns rather than a jsonb blob because the export-policy contract would force jsonb to `excludedOpen` and strip attribution from the tenant export; #4182 is *not* blocked on #4177 because `time_entries` already exists on main.

Claims labelled: everything in §1, §3.1–§3.6 and §4 cited to a file:line was **verified** against `origin/main` in this session. The 54-site sweep table is **verified** site-by-site. The statement that `ai_tool_executions.command_id` has no writer is **verified by grep** (no writer found) but not proven by exhaustive tracing. The claim that no RLS discovery rule keys off `_id` columns generally is **not checked** and is called out as a verification step in §4.1.

**Codex `gpt-6-astra` (xhigh, read-only), 2026-09-13.** Verdict: *"I would block P2, P6 and P7 as written. The principal failures are incomplete provenance propagation, temporally invalid metric cohorts, and an email claim being mistaken for delivery."*

| Position | Codex | Outcome |
|---|---|---|
| P1 attribution model | AGREE-WITH-CONDITIONS | **All three conditions adopted** — NULL redefined as "AI initiation not recorded"; actor type/id derived from the principal (exposing a live defect at `scriptDispatch.ts:783`); the audit-column limitation accepted explicitly rather than glossed. |
| P2 threading | **DISAGREE** | **Upheld and adopted.** Codex verified no chokepoint receives an `AuthContext` (`commandQueue.ts:102/480/1111`), which falsified the draft's central "structurally reachable" claim. Resolved on the merits into carrier + explicit conduit + mandatory-origin adapter + intent persistence (§3.2, OD-1). |
| P3 registration | AGREE-WITH-CONDITIONS | **Adopted.** Move/merge lifecycle was missing entirely — executions follow the device across orgs while runs stay behind, so the new links go cross-tenant. Detach-on-move/merge added. The "no tenant FKs on `device_commands`" rationale was factually wrong (`submitted_org_id` is one) and is corrected. |
| P4 UI | AGREE-WITH-CONDITIONS | **Adopted.** Wrong component named (Activities is `DeviceEventLogViewer`, not `DeviceActivityFeed`); `RunContextChip` encodes OS privilege and must not be overloaded; session links are owner-bound; the Overview count double-counted every script. |
| P5 scorecard location | AGREE-WITH-CONDITIONS | **Adopted.** Reusing the page must not mean inheriting its permissions: time-entry aggregates are a new authorization decision, and a system-context read to sidestep them would be the #2417 anti-pattern. |
| P6 measured metrics | **DISAGREE** | **Upheld and adopted — the most valuable finding.** Linkage-based cohorts commit reverse temporal attribution (`alertVerdictSubscriber.ts:388`, `ticketHelpdeskSubscriber.ts:439`), group verdicts with `alert_id IS NULL` are dropped, and resolved-only percentiles omit open cases. §3.6 rewritten around exposure time, age *L*, horizon *H* and censoring. |
| P7 email | **DISAGREE** | **Upheld and adopted.** The CAS is at-most-once-possibly-zero; a no-op send would stamp "emailed"; sending inside `inSystemDbContext` can roll back the claim after delivery. Replaced by `report_run_deliveries` (OD-8). Also caught the missed second recipient writer at `recipients.ts:136`. |
| P8 waves | AGREE-WITH-CONDITIONS | **Adopted** — exit criteria rewritten per wave. |

Codex's four missed sweep paths (backup's direct `dispatchCommandToAgent`, the peripheral `tx.insert`, SentinelOne's provider-API device mutation, patch-job origin loss) are folded into §4.2 and OD-3. Its answer to (b) — that neither the RLS nor the cascade discovery keys off anything but the literal `org_id`, so `ai_session_id` is safe on `device_commands` — **resolves the one item the author had flagged as not-checked**; §4.1's verification step is retained as a cheap re-confirmation rather than an open risk.

Its answer to (f), adopted as the spec's headline risk: **treating a provenance pointer as permission to disclose its target.** Device history can move tenants while agent-run history stays behind, and transcripts are owner-private; a generic join or a "just make the link work" relaxation would expose another tenant's or technician's AI context. Mitigated by detach-on-move/merge (§3.1) and the authorized origin summary ([OD-9](#od-9)).

Two Codex points **not** adopted as stated: (1) bare immutable UUID columns on `audit_logs` — the export limitation is accepted instead, since `details` already carries the ids and the column would be unpopulatable for history without an owner-privileged `DISABLE TRIGGER` backfill; recorded as an accepted limitation rather than a silent one. (2) Full Kaplan–Meier in v1 — retained as the target refinement in [OD-6](#od-6), with the simpler proportion-within-horizon statistic as the first release, because the honest-but-simple figure ships sooner than the sophisticated one.

**Net:** no unresolved disagreement remains. Every Codex objection was either adopted or explicitly accepted as a stated limitation. The material scope increases the quorum caused — the AI dispatch adapter and intent persistence in W01, `report_run_deliveries` in W03, and exposure-time semantics in W04 — are called out in the waves table so they are priced before implementation rather than discovered during it.

- 2026-09-13 — **Gate A approved by the product owner: all ten recommendations (OD-1 A+adapter, OD-2 A, OD-3 B with the indirect-lane follow-up filed before W01 merges, OD-4 A — #4182 description updated, OD-5 A, OD-6 A, OD-7 B, OD-8 B, OD-9 A, OD-10 A).** `spec-approved` applied to #5022, #4182, #4248. Migration slot reserved `2026-10-16-181700`.
