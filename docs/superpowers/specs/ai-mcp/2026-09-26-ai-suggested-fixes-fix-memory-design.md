---
status: draft (quorum: Codex gpt-6-astra xhigh, 2026-09-26, AGREE WITH CHANGES — all 6 disagreements adopted)
date: 2026-09-26
tracking_issue: TBD (registered after the plan is written)
related: "#7118 (origin bug), PR #7124 (interim matcher hotfix), #6754 (AI full control), #4192 (graduation evidence), #3828 (fix-held watch)"
---

# AI Suggested Fixes + partner-wide Fix Memory — design

## Problem

"Suggested Fixes" (`services/remediationSuggestions.ts`, `routes/remediationSuggestions.ts`, `components/remediation/RemediationSuggestionsPanel.tsx`) looks like an AI feature but has no model in it. The settings copy said "AI-generated" until PR #7124.

What the code actually does:

- **Matching.** It maps alert or anomaly text to hard-coded keyword buckets, then substring-matches those terms against the first 100 scripts, templates and playbooks.
- **Scoring.** The "confidence" shown to the user is `0.45 + matched/total/2`.
- **Rationale.** The "rationale" is just the matched script's own description.
- **Result in the field (#7118).** A Windows-only agent-migration script was suggested for Linux servers across a whole fleet. Its description contains "Program**Data**", which matched the memory term `ram`.

PR #7124 is the interim fix: an OS filter, whole-word matching, lifecycle scripts excluded, and honest copy.

The feature also never learns:

- `/execute` sets `status='executed'` when the script is dispatched (`routes/remediationSuggestions.ts:889-911`).
- Nothing records whether the script succeeded, or whether the problem cleared and stayed cleared.
- The only "did the fix hold" logic in the product is `services/aiAgents/fixWatch.ts`, and it only covers AI-agent act runs.

## Goals

1. Suggestions come from real AI research grounded in the device (OS, logs, context) and in a catalog that can actually run there.
2. **Fix memory:** a fix proven on a recurring problem is reused automatically and for free. The same problem is not researched twice.
3. Memory is **partner-wide**, so a fix proven at client A helps client B of the same MSP. It never crosses partners.
4. "Proven" means observed outcomes, not model claims.
5. Memory is a reusable module. Chat, AI agents, Helper and MCP reach it through one tool.

## Non-goals

- **No new autonomy path.** Suggestions never auto-run. AI agents consume memory under their existing approval policy (W3).
- **No cross-partner or Breeze-global learned memory.** A curated seed catalog could come later as shipped content, never as learned data.
- **No embeddings or pgvector.** pgvector exists only in the optional Workspace extension (`ee/workspace/migrations/2026-07-19-content-chunks.sql`), so memory must behave identically on self-hosted installs without it.
- **Research never drafts or proposes scripts itself.** The "Draft a script" action hands off to the existing script builder.

## Decisions (product owner, 2026-09-26)

| # | Decision | Chosen |
|---|---|---|
| P1 | Memory sharing scope | Partner-wide (not per-org, not global) |
| P2 | What makes a fix "proven" | Verified outcome **and** human 👍/👎, as counts with a minimum success rate; demotion is automatic |
| P3 | When suggestions are generated | A memory hit is attached automatically at no cost. LLM research runs on demand, and automatically for high/critical severity when memory has no hit |
| P4 | What AI may suggest | Catalog items (OS-filtered), built-in actions, manual steps, and a "draft a script" hand-off. Drafting is delivered as a hand-off, not in-run |
| P5 | Autonomy | None new. Existing agents consume memory through their existing policy |
| P6 | Research engine | Claude Agent SDK: memory as an SDK tool, research as a narrow agent-run profile. Signature, memory lookup and outcome recording stay plain services |
| P7 | Interim | Ship the #7118 hotfix now (PR #7124) |

## Quorum record

My position was checked by Codex (`gpt-6-astra`, xhigh, read-only, 2026-09-26). It agreed with partner-wide memory and a bounded research profile, and disagreed on six points. All six were verified against the code and adopted:

1. **Don't generalize `fixWatch` or its table directly.** Its phase functions mutate agent watches, write agent evidence and revoke autonomy (`fixWatch.ts:542,676,737`). Instead, extract its probes and retry logic, and keep separate persistence adapters.
2. **"Resolved + no recurrence" is not proof.** Humans can set `resolved`, and cooldown or dedupe can suppress a recurrence (`fixWatch.ts:19,573`). Proof requires an objective recovery plus fresh telemetry during the hold window.
3. **Recurrence keys + OS are not a problem identity.**
   - `alertTriggerKey` prefers the config item name over the rule id, collapses missing inputs to `alert`, and truncates at 200 characters (`packages/shared/src/types/remediationTrigger.ts:18,66`).
   - Org-local rule UUIDs under-match across orgs.
4. **Org-private fixes must not appear in the org-readable partner aggregate.** Not even as a teaser.
5. **`ai_agent_op_evidence` is not immutable.** Re-votes update rows (`aiAgentOpEvidence.ts:73`), and the table requires `agent_id`. It cannot be the memory's source of truth.
6. **A research profile needs an explicit agent identity.**
   - `ai_agent_runs.agent_id` is NOT NULL (`db/schema/aiAgents.ts:85`).
   - Admission requires a partner-baseline `ai_agents` row (`effectivePolicy.ts:507-516`).
   - No system agent exists today.

## Architecture

```
alert / anomaly created ──► signature ──► fix memory lookup (free, automatic)
                                             │ proven hit          │ miss
                                             ▼                     ▼
                                  "Proven fix" suggestion   high/critical: auto quick research
tech: Generate ─────────────────────────────────────► research run, quick (≤4 turns)
tech: Research deeper ──────────────────────────────► research run, deep (≤10 turns)
                                             ▼
             suggestion ──► human runs it (existing flow) ──► outcome watcher ──► fix_memory
```

Units and their boundaries:

| Unit | Location | Does | Depends on |
|---|---|---|---|
| Signature | `services/fixMemory/signature.ts` (pure) | Turns a source context into a versioned structured signature | Source rows, device OS |
| Memory store | `services/fixMemory/store.ts` | Transactional outcome → aggregate update; rebuild from outcomes | `fix_outcomes`, `fix_memory` |
| Lookup | `services/fixMemory/lookup.ts` | `provenFixes(ctx)` and `similarFixes(ctx)`, run under the caller's RLS context | `fix_memory`, candidate catalog |
| Candidate catalog | `services/fixMemory/catalog.ts` (extracted from today's `listCandidates`) | Scripts, templates and playbooks visible to this org and runnable on this OS, plus built-in actions | scripts, script_templates, playbook_definitions |
| Outcome watcher | `services/fixMemory/outcomeWatcher.ts` + `jobs/fixOutcomeWorker.ts` | Runs the state machine below | Script events, `alert.resolved`, extracted probes |
| Research agent | `services/aiAgents/researchProfile.ts` + provisioning | Bounded read-only run that ends in `submit_suggestions` | Agent runtime, catalog, lookup |
| Tool | `find_proven_fixes` | Tier-1 read of memory for chat, agents, Helper and MCP | Lookup |

## Data model

### `fix_outcomes`: org-owned (tenancy shape 1), one row per counted attempt

**Columns**

- `id`, `org_id` NOT NULL, `partner_id` (denormalized for rebuild), `device_id` NOT NULL.
- `suggestion_id` → `remediation_suggestions`.
- `source_type` and `source_id`, plus nullable `alert_id` and `anomaly_episode_id`.
- `signature_version`, `signature_key`, `signature_facets` (jsonb).
- `fix_kind`: `system_script | partner_script | org_script | builtin_action | playbook | manual_steps`.
- `script_id`, `script_version_id` (the pinned version the proof attaches to), `builtin_action`, `playbook_id`.
- `script_execution_id`.
- `state`: `pending | awaiting_recovery | holding | verified | failed | recurred | inconclusive | cancelled`.
- `state_reason`, `human_vote` (`up | down | null`, a re-vote replaces it), `voted_by`, `voted_at`.
- `holding_until`, `terminal_at`, `counted_at` (the exactly-once marker).
- `created_at`, `updated_at`.

**Constraints**

- Unique `(suggestion_id)` for execution attempts. One suggestion is one attempt; a re-run creates a new suggestion row.
- Composite FKs that reference `org_id` are `DEFERRABLE INITIALLY IMMEDIATE`.

**Private detail stays here.** Hostnames, alert text, script output and parameter values live only in this table or in rows it links to, and never reach `fix_memory`.

**Registrations** (see CLAUDE.md, cascade registration):

- `CORE_ORG_CASCADE_DELETE_ORDER` and `CORE_DEVICE_CASCADE_DELETE_TABLES`.
- `CORE_DEVICE_ORG_DENORMALIZED_TABLES`, because the table has `device_id` plus `org_id`.
- An `orgMergeRegistry` policy of `leave-for-erasure`, matching the existing evidence tables. Merge must not double-count or restamp history.
- `CORE_TENANT_EXPORT_POLICY`, with `signature_facets` in `excludedOpen`.
- The table is **not** append-only (votes update rows), so it gets no `AUDIT_ADMIN_REQUIRED_TABLES` entry.

### `fix_memory`: the reusable aggregate (org_id XOR partner_id)

**Columns**

- `id`, `org_id` (nullable), `partner_id` (nullable).
- `<table>_one_owner_chk` enforces `(org_id IS NULL) <> (partner_id IS NULL)`.
- `signature_version`, `signature_key`, `os_type`.
- `fix_kind`, `script_id`, `script_version_id`, `builtin_action`, `playbook_id`, `instructions_ref`. The last of these points at reviewed generic steps; no model prose from any org is stored here.
- `attempts`, `verified_count`, `failed_count`, `recurred_count`, `up_votes`, `down_votes`.
- `rolling_success_rate` (the last 20 counted attempts), `consecutive_failures`.
- `status`: `active | demoted | retired`.
- `retired_by`, `retired_at`, `last_verified_at`, `updated_at`.
- Unique `(owner, signature_version, signature_key, os_type, fix identity)`.

**Owner rule**

- **Partner rows** hold shareable fixes only: system scripts, partner-wide script versions, built-in actions, built-in playbooks and reviewed generic steps.
- **Org rows** hold fixes that use org-only scripts or org playbooks.
- When a script is promoted from org to partner-wide through the existing re-scope flow (`routes/scripts.ts:159`, gated on `canManagePartnerWidePolicies`), its org memory folds into the partner row. This happens only through that operator action.

**RLS.** One dual-axis policy covers everything: `system OR breeze_has_org_access(org_id) OR breeze_has_partner_access(partner_id)`.

- On top of that, a **separate SELECT-only** policy: `USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id())`.
- The template is `migrations/2026-10-05-110000-config-policy-partner-wide-select.sql`.
- This is load-bearing for org tokens and headless agent runs. Agent tool calls carry `partnerId` into `breeze.current_partner_id` (`agentAuthContext.ts:110`, `db/index.ts:511`).
- The table goes in `DUAL_AXIS_TENANT_TABLES` and is **not** in `PARTNER_WIDE_SELECT_BRANCH_EXEMPT`.
- It also gets a `fixMemoryPartnerRls.integration.test.ts`.

**Registrations**

- Org cascade + merge + export for org rows. Partner rows are removed by partner deletion's `partner_id` discovery.
- The aggregate is **derived**. `rebuildFixMemory(scope)` recomputes it from `fix_outcomes`.

**Erasure.** GDPR org erasure first marks the affected memory stale inside the erasure run, then deletes that org's outcomes, then rebuilds. The rebuild must be retryable because the cascade commits table by table.

**Cross-partner org transfer.** The organization's contributions are removed from the source partner's memory and are **not** carried to the destination. Whether a cross-partner transfer workflow exists is **not verified**; if none exists, this is a documented invariant for the future.

### Signature v1

A versioned structured key, `signature_version = 1`.

**Facets**

1. **Source family:** `alert | anomaly | correlation`.
2. **Condition semantics.** Never an org-local rule UUID.
   - Alert: the alert template or monitor check type plus its condition kind.
   - Anomaly: `source_table` + metric family + `anomaly_type` (`metricAnomalyEpisodeKeys.ts:44`).
   - Correlation: the root alert's semantics, marked `root_inferred`, because the root is the earliest alert rather than an established cause (`alertCorrelationGroups.ts:75`).
3. **OS family.**
4. **One optional discriminator:** service name, KB/patch id, exit code, or event id. It is extracted deterministically from structured fields, never from free text.

**Broad signatures.** A signature without a discriminator is **broad**. Broad matches appear only under "Similar fixes" and are never auto-attached as proven.

The key is a stable hash of the canonicalized facets. The facets themselves are stored for explainability on `fix_outcomes` only.

**Not checked:** the exact per-source field list for condition semantics. The W1 plan must enumerate it from the alert, monitor and anomaly schemas.

## Proof rule

The thresholds are tunables. Their defaults live in shared constants.

- **Counted attempts:** a terminal `verified`, `failed` or `recurred`. `inconclusive` and `cancelled` are never counted. A 👎 counts as a failure. A 👍 confirms, but it cannot make a fix proven by itself.
- **Proven**, shown and auto-attached: `status = active`, at least **3** verified, a `rolling_success_rate` of at least **0.8** over the last 20 counted attempts, and no `recurred` among the last 3.
- **Demoted** (hidden from proven, still listed as similar): a recurrence, or **2** consecutive failures. Three verified successes in a row lift the demotion.
- **Retired:** an MSP operator's manual action. Retired entries stay retired.
- **Version pin:** proof attaches to `script_version_id`. A new version starts at zero. An old version's entry leaves "proven" once that version can no longer be dispatched.

## Outcome lifecycle

**Hooks** (verified):

- **Script terminal.** `script.completed` and `script.failed` are declared (`eventBus.ts:70-71`) but never emitted. The automation and webhook forms already offer them as triggers, and automations have no script→script loop guard. W1 therefore does **not** emit these public events: it calls the outcome watcher inline, the way `applyAutomationActionTerminal` is called, from both terminal-write paths (wiring the public events with a loop guard is a separate follow-up):
  - agent results, at `services/commandResultHandlers.ts:612-620`;
  - the reaper and cancel path, at `services/scriptExecutionTerminal.ts:53-65`.
- **Recovery.** `resolveAlert` publishes `alert.resolved` on every path (`alertService.ts:900`).
  - Automatic resolves leave `resolvedBy` null. The manual route sets it (`routes/alerts/alerts.ts:1089-1095`).
  - Only automatic condition-clear resolves count. `checkAutoResolve` is the canonical path.
  - For anomalies, only an episode that is `cleared` counts, not one that expired during offline or no-data (`metricAnomalyEpisodes.ts:737`).

**State machine.** One state machine per `fix_outcomes` row:

```
execute ─► pending ─script failed / timeout / os_mismatch──────────────► failed
              │ script ok
              ▼
        awaiting_recovery ─condition still active at 24h────────────────► failed ("ran, didn't fix")
              │           ─human resolve / dismiss──────────────────────► inconclusive
              │ auto-resolve / episode cleared
              ▼
         holding (24h) ─same signature recurs on the device─────────────► recurred
              │        ─telemetry gap / device offline in the window───► inconclusive
              ▼
           verified
```

**Other fix kinds**

- Built-in actions use the same machine, with the action's own result standing in for the script result.
- Manual steps start at `awaiting_recovery` when the tech clicks **Done**. W1 records Done, but nothing creates manual-step suggestions until W2, so manual steps feed memory from W2 onward.

**Exactly-once.** A terminal transition and its aggregate delta commit in one transaction, guarded by `counted_at IS NULL`. Redelivered events are then no-ops.

**Sweeper.** A 5-minute repeatable job handles timeouts, hold expiry and stranded rows, using probe and retry helpers **extracted** from `fixWatch.ts`. `fixWatch` keeps its own persistence, evidence and demotion adapters, so its behaviour is unchanged. Suggestion outcomes never feed `ai_agent_op_evidence` or graduation. An agent act execution may contribute to both ledgers, but only once to each.

**Telemetry freshness.** Freshness means device heartbeats, plus metric samples for the signature's metric family, throughout the hold. The exact freshness probe is defined in the W1 plan.

## Research agent

**Identity**

- A new agent kind, `research`, joins `triage | patch | helpdesk | designer`. That means shared types, a CHECK constraint migration, `profileCaps` and effective policy changes.
- Research agents are **auto-provisioned per partner, idempotently**, when research is first admitted. System attribution is needed because `created_by` has a user FK. **Not verified:** whether the column accepts null or a system actor. The W2 plan resolves this first.
- The kind is locked to the `remediation_research` profile, and the runtime rejects any other pairing.
- **Zero actions:** no act or intent tools, and a fixed mode.
- It appears in the AI Agents list as "Fix research (built-in)". Only enable/disable and budget caps are editable, and org overrides use the existing partner-baseline + override model.

**Admission.** Research goes through `createAndEnqueueAgentRun` (`runService.ts:989`):

- kill switch;
- circuit breaker;
- credit and budget via `checkBudgetDetailed`;
- the agent's daily cap;
- its own concurrency and rate caps.

**Auto-triggered research** (high/critical with no proven hit) is deduped per `(source, depth)` and rate-capped per org per hour.

**Profile `remediation_research`.** Its anatomy mirrors `verdictProfile.ts`.

- **Tools:**
  - `find_proven_fixes`
  - `get_device_details`
  - read-only event-log search
  - `get_device_context`
  - `list_scripts` (it already filters by `osType`, `aiToolsScripts.ts:1433`)
  - a playbook list
  - the profile-private outcome tool `submit_suggestions`, registered via `outcomeTools.ts`
- **Depth:** quick is ≤4 turns (Generate, auto). Deep is ≤10 turns (Research deeper).
- **Caps** default to 5¢ quick and 25¢ deep. These are **ceilings, not estimates**. The W2 eval measures real cost before the defaults ship.

**`submit_suggestions` is validated server-side.** Invalid items are dropped and logged to the run trace, and never persisted. Each item must be exactly one of:

- **a catalog reference** that this org can see and that runs on this device's OS (the #7118 filter, enforced server-side), including partner-wide scripts. Today's matcher misses those (`remediationSuggestions.ts:254`);
- **a built-in action** from an allowlist: reboot, restart service, kill process or disk cleanup, each with typed parameters;
- **manual steps**, labelled AI-written;
- **a draft request**, which renders as a "Draft a script" button that opens the script builder pre-filled with context.

**Finalizer.** A finalizer writes `remediation_suggestions` rows with a new `origin` of `memory | ai_research | catalog_match` and a `run_id` link. This replaces today's placeholder fields: the `confidence` % goes away, and `rationale` now holds the model's reasoning.

## `find_proven_fixes` tool

- **Tier and scope.** Tier 1 and read-only. It takes `alertId | anomalyEpisodeId` in W1; a structured `deviceId + problem` input (with device authorization and signature construction) arrives in W2. It returns proven and similar fixes, together with their track records.
- **Output.** It returns only rows visible under the caller's RLS context, and never another org's private rows.
- **Registration**, per the `list_remediation_suggestions` precedent (`ecb77c549`):
  - core handler + `aiTools.ts`
  - `aiToolSchemas.ts`
  - SDK declaration + `TOOL_TIERS`
  - `TOOL_PERMISSIONS`
  - `TOOL_CAPABILITY`
  - `mcpCoverage.ts`
  - the web `tierConfig.ts`
  - docs `mcp-server.mdx` and `ai.mdx`
- **Enforced by:** the registry parity, handler coverage, MCP coverage, docs parity, route binding, description budget and output budget contracts.

## UI

**Panel** (alert, anomaly episode and correlation views). Three labelled groups:

1. **Proven fixes**, with a track record ("Worked 7 of 8 times across your clients · last verified 3d ago") and a scope label ("All clients" or "This client").
2. **AI suggestions**, marked "AI researched", with the rationale and a risk tier.
3. **Similar fixes**: broad or demoted matches, de-emphasized.

**Actions:**

- Generate and Research deeper.
- Run, through the existing accept / elevation / execute flow, unchanged.
- After a run: 👍/👎, **Done** for manual steps, and "Draft a script".
- A "Researching…" state that polls the run.
- Explicit states for credits exhausted, research failed (with retry) and "AI found no safe fix". Never a silent empty state.
- All mutations go through `runAction`.

**Fix memory list.** A tab in the AI area for MSP operators: entries, track records, a filter by signature or OS, and **Retire**. This is data, not a setting, so the settings-audit rules do not apply.

## Error handling

- **The memory path never depends on research.** Memory hits and catalog candidates render whether research is running, denied or failed.
- **Research failure or timeout** writes no partial rows. The panel shows a retry.
- **Budget or credit denial** is surfaced with its reason from `checkBudgetDetailed`.
- **A signature that can't be computed** (missing facets) gets no memory lookup, but research still runs.
- **An aggregate rebuild failure** leaves the affected entries marked stale. Stale entries are excluded from "proven" until a successful rebuild.

## Testing

**W1 runs against real Postgres** (integration):

- **RLS:**
  - org B cannot read org A's private rows;
  - an org token reads partner rows through the SELECT branch;
  - a cross-partner forge fails with 42501;
  - the XOR check fails with 23514;
  - a headless agent-auth context reads partner rows.
- **Lifecycle:** erasure followed by rebuild, and merge (`leave-for-erasure`).
- **Contract suites:** `rls-coverage`, `tenantCascade`, `tenant-export-policy`, `orgMergeRegistry`, `cascadeDelete`, `moveOrg.coverage`.
- **Exactly-once:** duplicate delivery of `script.*` and `alert.resolved` events.
- **Unit tests:** every state-machine edge as a table-driven test; the signature canonicalization; the aggregate math, including demotion and lifting it.

**W2**

- Profile and tool registry parity.
- `submit_suggestions` rejections: an OS-incompatible reference, another org's script, a non-allowlisted action, and a draft request that must not call `propose_script`.
- Kind/profile pairing enforcement.
- An **eval set of about 20 real alert shapes** (Linux, Windows and macOS; patch, disk, service and memory), measuring cost per run and suggestion quality before cap defaults ship.
- Playwright panel flows.

**W3**

- An integration test showing a triage run uses a proven fix instead of a full run.
- A patch-agent known-false-failure classification test.

## Waves

| Wave | Scope | Depends on |
|---|---|---|
| **W1: Foundation** | Tables + RLS + all registrations; the signature module; inline script-terminal hooks; the outcome watcher + sweeper, with probes extracted from `fixWatch`; free memory attach on new alerts; the `find_proven_fixes` tool; 👍/👎 and Done in the current panel (learning starts on the #7124 matcher) | #7124 merged |
| **W2: Research** | The `research` agent kind + provisioning; the `remediation_research` profile + `submit_suggestions` + finalizer; the panel redesign; the Fix memory list; the eval; retiring the keyword matcher from Generate | W1 |
| **W3: Consumers** | The triage verdict and full runs call memory first; the patch agent recognizes known false failures via memory | W1 (W2 optional) |

**Rollout.** Both memory and research sit behind the existing `ml.remediation_suggestions.enabled` flag. Research additionally requires AI enabled and credits available for the org.

## Amendments at W1 planning (2026-09-26)

Adopted after the W1 plan was cross-checked by Codex:

- **Script terminal hook is internal**, not the public `script.*` events (see Outcome lifecycle).
- **Anomaly and plain metric-threshold signatures have no discriminator**, so under the broad rule they never auto-attach in W1. Auto-attach fires only for service, process, software and exit-code problems. Anomalies still show under "Similar fixes".
- **One attempt per source + script.** The existing unique index and `/execute`'s 409 stay; "a re-run creates a new suggestion row" is dropped.
- **`fix_outcomes` stays with the source org on a device move**, listed in `INTENTIONALLY_NO_ORG_ID` like `ai_agent_fix_watches`, rather than in `CORE_DEVICE_ORG_DENORMALIZED_TABLES`.
- **`find_proven_fixes` `deviceId + problem` input moves to W2.**
- **Lookup re-checks the fix script's current ownership** at attach and read time, independent of ambient RLS, because scripts can be re-scoped (partner→org, org→org) without a new version.

## Open verification items (resolve at plan time)

1. Whether `ai_agents.created_by` can carry a system actor for provisioned research agents (W2).
2. The exact condition-semantics fields per source family for signature v1 (W1).
3. The telemetry freshness probe for each metric family (W1).
4. Whether a cross-partner org transfer workflow exists. If it does, it needs a memory invalidation hook (W1).
5. The alert auto-resolve paths other than `checkAutoResolve` (`policyAlertBridge.ts:145`, `monitorWorker.ts:380`, `scriptExitCodeAlerts.ts:187`), and which of them count as objective condition-clears (W1).
