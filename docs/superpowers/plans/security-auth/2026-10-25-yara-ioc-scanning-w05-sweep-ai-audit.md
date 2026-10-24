---
tracking_issue: LanternOps/breeze#6263
wave_issue: LanternOps/breeze#6268
---
# YARA IOC Scanning W05: Fleet sweep ("Sweep now"), AI `ioc_hunt` actions, audit events, docs and copy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tech, the in-app AI, or an MCP client can run one or more pinned rule sets against every eligible device in a chosen scope, within minutes. They can watch the sweep's progress, see degraded coverage honestly, and cancel it. Each sweep leaves per-org audit events and a per-device scan row. Every YARA scan records the exact rule-set versions it was sent, so a threat says which version fired.

**Architecture:**
- **Sweep record.** A sweep is a new per-org parent row, `security_scan_sweeps`, that pins the rule-set versions approved at create. Its children are ordinary `security_scans` rows carrying `sweep_id`, which reuse W01–W03's dispatch, result ingest and Scans UI.
- **The database is the queue.** A single-flight `pump-sweeps` job admits queued sweep scans of online devices into the existing `dispatch-scan` path. The claim runs under a per-partner advisory lock, so the org, partner and device caps hold under concurrency. The command insert happens in the claim transaction with deferred delivery, and the scan row stores its `command_id`.
- **Fetch authorization.** The agent fetch route also authorizes the exact `{id, version}` refs a running scan was dispatched with.
- **AI.** AI access is a new base-Tier-1 tool, `ioc_hunt`. Reads stay Tier 1 over MCP. `sweep` and `import_iocs` are Tier-3 actions, single-org and digest-pinned, released through the existing action-intent lifecycle (chat in-app, MCP via B-W04). There is no second lifecycle.
- **Agent.** No agent change, no new wire key, no new agent version gate.

**Tech Stack:** Hono, Drizzle (queries only), hand-written SQL migration, BullMQ (`security-scan` queue), Zod, Vitest (unit + Integration Tests), React islands in Astro, react-i18next (8 locales), Starlight docs.

**Spec:** `docs/superpowers/specs/security-auth/2026-09-18-yara-ioc-scanning-design.md`
- §7: sweep route, AI actions, audit.
- §8: "Sweep now" with a scope picker and a confirmation stating the device count.
- §9: rules are code; matched-strings caps.
- §11: copy rule.
- §12: the W05 row.

**W01–W04 as built are binding:**
- `apps/api/src/jobs/securityScanJobs.ts` (caps, dispatch, `buildSecurityScanPayload`)
- `apps/api/src/services/yaraScanRefs.ts` (`planYaraScan`, `resolveYaraRuleSetRefs`, `MIN_AGENT_VERSION_YARA_SCAN = '0.124.0'`)
- `apps/api/src/routes/agents/yaraRuleSets.ts` (fetch route, attachment check)
- `apps/api/src/routes/agents/helpers.ts` (`handleSecurityCommandResult`)
- `apps/api/src/routes/security/{scans,yara,yaraAccess,yaraIocImport,yaraTest}.ts`
- `apps/api/src/services/aiToolsSecurity.ts`
- `apps/api/src/services/aiGuardrails.ts`
- B-W04 intents: plan `docs/superpowers/plans/ai-mcp/2026-10-20-mcp-modernization-b04-tier3-intents.md`; code `services/mcpIntentCreation.ts`, `services/mcpIntentEligibility.ts`, `jobs/intentReleaseWorker.ts`

**Index:** `docs/superpowers/plans/security-auth/2026-09-18-yara-ioc-scanning.md`, W05 row.

---

## Global Constraints

### Branches and PRs

There are three PRs. Each branches from fresh `origin/main` after the previous one merges. None is stacked: a PR whose base is not `main` gets no CI.

| PR | Scope | Branch |
|---|---|---|
| A | API | `feature/6263-yara-ioc-scanning/wave-6268` |
| B | AI | `feature/6263-yara-ioc-scanning/wave-6268-b` |
| C | web + docs | `feature/6263-yara-ioc-scanning/wave-6268-c` |

- Every body says `Part of #6263` and `Refs #6268`.
- Only PR C says `Closes #6268`.
- No other closing keyword appears anywhere, including negated ones.

### Migration

PR A has exactly one migration, in slot `apps/api/migrations/2027-01-04-140000-security-scan-sweeps.sql`.
- On 2026-10-24 the newest file on `main` is `2027-01-04-110000-ticket-merge.sql`. The dispatch brief's in-flight `2027-01-03-150000/160000/160100` slots are already behind it.
- Re-check `git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -3` and the open PRs at implementation time. Take the next free `HHMMSS` if this slot is taken or sorts too early, and say so in the PR body.
- The migration is idempotent and has no `BEGIN`/`COMMIT`.
- It writes no rows, so it needs no `set_config('breeze.scope','system',true)`. A later backfill would put that line first.
- Then run `pnpm db:check-drift`.

### Tenancy

`security_scan_sweeps` is shape 1 (`org_id NOT NULL`).
- RLS is enabled and forced, with select/insert/update/delete policies on `breeze_has_org_access(org_id)`, all in the same migration.
- It is registered in `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts` (repoint) and `CORE_TENANT_EXPORT_POLICY`, with every column classified.
- It has no `device_id`, so no device list applies.
- The new `security_scans` columns are classified in that table's existing export entry.
- **Why it is org-only:** a sweep is an execution record, like `script_execution_batches` and `patch_jobs`, not a config or policy table. A cross-org request is N org rows sharing a `group_id`. Partner-Wide First does not apply.

### No agent change

- Sweeps reuse the W02 payload keys exactly: `scanRecordId`, `scanType`, `paths`, `ruleSets`, `exclusions`, `maxFileSizeMb`, `timeoutMinutes`, `autoQuarantine`, `triggerDefender`.
- There is no new `MIN_AGENT_VERSION_*`. A device below `MIN_AGENT_VERSION_YARA_SCAN` is **skipped** (`agent_too_old`) and never sent a legacy scan.
- `git diff origin/main --stat -- agent/` is empty in every PR.
- `agent/internal/yarascan/yarac/yarac.go` and `pack.lock` are untouched.

### Sweeps are detect-only and Defender-free in W05

- Every sweep scan goes out with `autoQuarantine: false` and `triggerDefender: false`, whatever the device's policy says.
- Spec D7: an unreviewed custom rule must not move files fleet-wide. A fleet-wide `Start-MpScan` is unrelated load.
- Quarantine stays a per-threat or bulk action on the Threats tab.

### Caps

Each is env-overridable via `parsePositiveIntEnv`.

| Name | Default | Meaning |
|---|---|---|
| `SECURITY_SWEEP_MAX_DEVICES` | 10000 | eligible devices per request, across orgs |
| `SECURITY_SWEEP_MAX_ACTIVE_PER_ORG` | 5 | sweeps in state `active` per org (completed ones do not count) |
| `SECURITY_SWEEP_PUMP_INTERVAL_MS` | 30000 | pump cadence |
| `SECURITY_SWEEP_PUMP_BATCH` | 100 | admitted per sweep per org per tick |
| `SECURITY_SWEEP_PARTNER_RUNNING_CAP` | 200 | `running` scans across a partner's orgs, all origins |
| `SECURITY_SWEEP_TTL_HOURS_DEFAULT` | 24 | request `ttlHours` ∈ 1–72 |
| `SECURITY_SWEEP_MFA_DEVICE_THRESHOLD` | 50 | human creates above this need `hasSatisfiedMfa` |
| `IOC_HUNT_FOUR_EYES_DEVICE_THRESHOLD` | 25 | AI `sweep` above this is four-eyes |
| `SECURITY_SWEEP_RUNNING_GRACE_MINUTES` | 65 | finalize grace beyond the 720-minute scan-timeout ceiling |

- Rule sets per sweep: 1–20 (`YARA_MAX_RULE_SETS_PER_POLICY`).
- Custom `paths`: 1–20 entries, each ≤ 1024 chars, validated by the same element schema as `scanRequestSchema`.
- Per-user creates: 10/h via `rateLimiter`, key `security-sweep-create:<userId>`.
- Existing caps are unchanged: org running 40, device 1, org queued backpressure 500.

### Statuses

- `security_scans.status` gains `cancelled` and `expired`. It is `varchar(20)` with no CHECK, so no DDL. `listScansQuerySchema` (`routes/security/schemas.ts`) gains both values.
- `security_scan_sweeps.state` is `active | completed | cancelled | expired`, enforced by a CHECK.

### Copy rule (spec §11)

- Use "IOC sweep", "IOC scan", "detection rules" and "threat hunting".
- Never use "EDR", "antivirus", "real-time protection" or "prevention".
- `apps/web/src/locales/yaraCopyRule.test.ts` is extended to the new key prefixes.

### Web

- Mutations go through `runAction`.
- Hash state goes through `useHashState`.
- Every interactive element has a `data-testid`.
- New keys go into all **8** locale dirs (`de-DE en es-419 fr-CA fr-FR it-IT pt-BR tr-TR`); `localeParity` checks them.

### Verification

- **Typecheck:** `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "exit=$?"` per touched package. Read the exit code, and never pipe to `tail`. For the API, use the CI form `npx tsc --build tsconfig.tests.json` when the single program OOMs (exit 134).
- **Scoped tests:** `cd apps/<pkg> && npx vitest run <path>`.
- **Integration:** run on a per-worktree stack with `npx vitest run --config vitest.integration.config.ts <file>`, then tear the stack down.

---

## Review Focus

### 1. A device moves org mid-sweep

`breeze_cascade_device_org_id()` and the mover restamp `security_scans.org_id`, but the sweep stays in the source org.

**Expected behavior:**
- Before the `devices` UPDATE, the mover detaches the device's sweep scans: `queued` → `cancelled`, and `sweep_id → NULL` for all of them.
- Every reader also requires `sweep.org_id = scan.org_id`: dispatch, fetch, progress and the pump. This is the backstop for any trigger-only path.

**Pinned in:** Task A2 (mover) and Task A9 (integration, before and after command creation).

### 2. A set is edited, disabled or deleted between approval and dispatch

The sweep pins `{id, version, sha256}` at create.

**Expected behavior:**
- If a set's current published sha differs from the pin at claim, the scan is `failed` with `rule_set_errors [{id, version, code: 'rule_set_changed'}]`, and no command is sent.
- If any pinned set is disabled, deleted or no longer eligible for the device, the outcome is the same, with its own code.
- The whole scan fails; it is never a partial-set scan and never a legacy scan.
- The UI offers "Sweep again with the current rules". The dedupe key includes the sha, so a re-sweep is allowed.

**Pinned in:** Task A5.

### 3. A mostly-offline fleet, or a long scan, holds the org's concurrency

**Expected behavior:**
- The pump admits only `devices.status = 'online'` devices.
- Queued-in-DB sweep scans are excluded from the scheduler's backpressure and busy predicates.
- A claimed scan whose command terminalized **undelivered** becomes `expired`.
- A `running` sweep scan with no result is `failed` only after the 720-minute scan ceiling plus `SECURITY_SWEEP_RUNNING_GRACE_MINUTES`. This never uses the command's 30-minute server timeout.
- A late result still lands (#3607 late-result acceptance), and overwrites the status.

**Pinned in:** Task A5.

### 4. A re-click, a retry, or two tabs create duplicate fleet-wide runs

**Expected behavior:**
- Creates for an org serialize on `pg_advisory_xact_lock`.
- Devices live in an active, unexpired sweep with the same `dedupe_key` are skipped.
- When all targets are skipped, the response is 409 `SWEEP_ALREADY_RUNNING` and nothing is written.
- An AI retry replays its intent via the intent idempotency key.

**Pinned in:** Task A4 (unit), Task A9 (concurrent integration) and Task B2.

### 5. Approval shows one scope, release runs another

An approved AI sweep could be released after a device enrols, a group grows, or a set is republished.

**Expected behavior:**
- The intent's effect digest pins `previewDigest` (targets + set shas).
- The released handler recomputes the targets under the rebuilt auth and refuses `SWEEP_SCOPE_CHANGED` on any mismatch.
- A site- or device-restricted requester never reaches beyond `allowedSiteIds` / `allowedDeviceIds` in *any* org.

**Pinned in:** Task A3 and Task B2.

---

## Decisions this plan makes

Quorum: a Claude position, critiqued by Codex `gpt-6-astra` at `xhigh`, read-only, on 2026-10-24 against `53afe2c5dd`. The record is in §Quorum record. Every Codex correction below was verified against the cited code before it was adopted. Disagreements left open are Gate B items.

### W05-1 Sweep record: `security_scan_sweeps` + three `security_scans` columns

```sql
CREATE TABLE IF NOT EXISTS security_scan_sweeps (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id),
  group_id       uuid NOT NULL,                   -- shared by the org rows of one request; no FK
  dedupe_key     varchar(64) NOT NULL,            -- W05-4
  rule_set_ids   uuid[] NOT NULL,                 -- sorted, distinct, 1..20
  rule_set_pins  jsonb NOT NULL,                  -- [{id, version, sha256}] pinned at create
  scan_type      varchar(16) NOT NULL,
  paths          text[],
  scope          jsonb NOT NULL,                  -- request scope, for display
  state          varchar(16) NOT NULL DEFAULT 'active',
  targeted_count integer NOT NULL,
  skipped        jsonb NOT NULL DEFAULT '{}',     -- { agent_too_old, busy_same_sweep, rule_set_not_eligible }
  origin         varchar(16) NOT NULL,            -- web | api | ai_chat | mcp
  ai_origin      jsonb,                           -- AiOriginRef when origin is ai_chat | mcp
  intent_id      uuid,                            -- action_intents.id; no FK
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  completed_at   timestamptz,
  cancelled_at   timestamptz,
  cancelled_by   uuid REFERENCES users(id),
  CONSTRAINT security_scan_sweeps_state_chk CHECK (state IN ('active','completed','cancelled','expired')),
  CONSTRAINT security_scan_sweeps_scan_type_chk CHECK (scan_type IN ('quick','full','custom')),
  CONSTRAINT security_scan_sweeps_rule_sets_chk CHECK (cardinality(rule_set_ids) BETWEEN 1 AND 20),
  CONSTRAINT security_scan_sweeps_paths_chk CHECK ((scan_type = 'custom') = (paths IS NOT NULL AND cardinality(paths) BETWEEN 1 AND 20)),
  CONSTRAINT security_scan_sweeps_origin_chk CHECK (origin IN ('web','api','ai_chat','mcp'))
);
-- indexes: (org_id, created_at DESC); (group_id); (expires_at) WHERE state = 'active'; (org_id, dedupe_key) WHERE state = 'active'
ALTER TABLE security_scans ADD COLUMN IF NOT EXISTS sweep_id uuid REFERENCES security_scan_sweeps(id) ON DELETE SET NULL;
ALTER TABLE security_scans ADD COLUMN IF NOT EXISTS dispatched_rule_sets jsonb;   -- [{id, version, sha256}] actually sent
ALTER TABLE security_scans ADD COLUMN IF NOT EXISTS command_id uuid;             -- device_commands.id of the dispatch; no FK
-- index: security_scans (sweep_id, status) WHERE sweep_id IS NOT NULL
```

**Progress is computed, not stored.**
- It is `count(*) FILTER (WHERE status = …)` and `sum(threats_found)` over `security_scans` by `sweep_id`, joined `ON s.org_id = w.org_id`, under the caller's RLS.
- `degraded` counts completed or timed-out children with `engine <> 'yara'` or a non-empty `rule_set_errors`. These are the agent's fetch or compile fallbacks, reported as a successful legacy scan.
- With no counters there is nothing to double-count. An org user sees only their org's slice.
- **Site- and device-restricted callers** get the aggregates over devices they can reach only (W05-5). The same rule applies to lists.

**Completion is stored.**
- The pump sets `state = 'completed'` and `completed_at` once no child is `queued` or `running`.
- `SECURITY_SWEEP_MAX_ACTIVE_PER_ORG` counts `active` only, so finished sweeps never block new ones.

**The FK is plain, not composite.** A composite `(sweep_id, org_id)` would break the device-move restamp. Review Focus 1 covers it instead: the mover detaches, and every reader checks org equality. `ON DELETE SET NULL`.

**Export policy:**
- `security_scan_sweeps`:
  - `included`: every scalar column, plus `rule_set_ids` and `paths`.
  - `excludedOpen`: `rule_set_pins`, `scope`, `skipped`, `ai_origin`.
- `security_scans`:
  - `included`: `sweep_id`, `command_id`.
  - `excludedOpen`: `dispatched_rule_sets`.

**Org merge** repoints `org_id`, like `security_scans`.

**Device move:**
- The table has no `device_id`.
- `security_scans` keeps its restamp disposition.
- The mover gains the detach statement from Review Focus 1, in the style of its existing `device_function_assessments.run_id = NULL` sever.

**Retention:**
- The sweep row lives as long as its org.
- Audit rows follow `audit_retention_policies` when a policy row exists for the org. The service's virtual default is 365 days; without a row, nothing is pruned.
- `security_scans` has no pruning job either. W05 adds none.

**Rejected alternatives:**
- No table, with metadata in audit rows only. Dispatch would have no durable pin carrier, and there would be no cancel or expiry state.
- One partner-owned row per request. Org users would not see a sweep that hit their devices, and org cascade would not reach it.

### W05-2 Fan-out: the database is the queue

**On create.** The request transaction does three things:
1. It inserts the sweep rows.
2. It inserts one `queued` scan per target device: `sweep_id` set, `started_at = now()`, `initiated_by = created_by`. Inserts are chunked at 1000 rows.
3. After commit, it adds **one** coalescing `pump-sweeps` job, with `jobId: 'security-sweep-pump-now'`.

No per-scan BullMQ job is created at insert. That would mean 10,000 jobs cycling through the throttle, and the throttle is also broken today (W05-3).

**`pump-sweeps`** is a new job name on `security-scan`. It runs:
- as a repeatable every `SECURITY_SWEEP_PUMP_INTERVAL_MS`, plus the immediate job;
- under `withSystemDbAccessContext`;
- single-flight via `pg_try_advisory_xact_lock(hashtext('security-sweep-pump'))`. Busy means return `{ skipped: true }`.

Each tick, in order:

1. **Expire.** Every `active` sweep with `expires_at <= now()` becomes `expired`.
   - Its `queued` scans become `expired`.
   - Its `running` scans whose command is still undelivered (`device_commands.status = 'pending'`) are cancelled through `commandCancelPropagation`, and the scan becomes `expired`.
   - One `security.scan_sweep.expire` audit row is written per sweep row.
2. **Finalize** `running` sweep scans, looking up the command by `security_scans.command_id`, never by payload. The payload is erased on terminalization (`commandCancelPropagation.ts`).
   - The command terminalized with no agent delivery (`executed_at IS NULL`; verify the column the sent transition stamps) → the scan becomes `expired`.
   - Otherwise, `started_at < now() − (720 + SECURITY_SWEEP_RUNNING_GRACE_MINUTES) min` with no result → `failed`.
3. **Complete.** Every `active` sweep with no `queued`/`running` child becomes `completed`.
4. **Admit.** Active, unexpired sweeps are taken oldest first, per org. The batch size is `n = min(40 − running(org), 200 − running(partner), SECURITY_SWEEP_PUMP_BATCH)`.
   - Candidates are the sweep's `queued` scans whose device is `online` and unparked (`notParkedDeviceCondition()`).
   - The device must have no `running` scan, and no `queued` scan without a `sweep_id`.
   - Admitted scans are ordered by `security_scans.id`, and each gets `addUniqueDispatchJob({ type: 'dispatch-scan', scanId, origin: 'sweep', sweepId })`.

**Separate predicates.** Queued sweep scans are not in flight. Two scheduler checks change to exclude `sweep_id IS NOT NULL AND status = 'queued'`, so 10,000 offline sweep targets cannot starve scheduled scans:
- `getOrgQueuedScans`, the backpressure count;
- `schedulePolicyScans`' busy select.

**Bounds:**
- Per instance: the existing `SECURITY_SCAN_WORKER_CONCURRENCY`.
- Agent side, unchanged:
  - one running scan per device;
  - the W02 pool `clamp(NumCPU/2, 1, 4)` at background priority;
  - agent command pool 10.

**Resumable.** State lives in rows. After a restart or a Redis flush, the next tick re-admits. A claim is a CAS (W05-3).

### W05-3 Dispatch and claim

`processDispatchScan` is restructured into a claim transaction. It applies to every origin:

1. `pg_advisory_xact_lock(hashtext('security-scan-partner:' || partner_id))` on the device org's partner. Lock order is fixed: the partner lock, then rows. All claims for a partner serialize, so the org cap (40), the partner cap (200) and the device cap (1) are counted and claimed atomically. Today's count-then-claim race is closed for scheduled and manual-queued scans too.
2. Re-read the scan, the device and the sweep (`FOR SHARE` on the sweep row). Cancel and expiry take `FOR UPDATE` on that row, so they serialize against the claim.
3. **Sweep-only checks.** If `sweep.state` is not `active`, or `expires_at <= now()`, or `sweep.org_id <> scan.org_id`, or `device.org_id <> scan.org_id`, the scan becomes `cancelled` and no command is sent.
4. **Settings:**
   - Exclusions, `maxFileSizeMb` and `scanTimeoutMinutes` come from `resolveSecurityScanPolicyForDevice`; with no policy, the agent defaults apply.
   - For sweeps, `autoQuarantine: false` and `triggerDefender: false`. The builder gains a `triggerDefender` parameter, defaulting to `true` for the existing callers.
   - `autoQuarantineSuppressedReason` stays `null`.
5. **Refs:**
   - Sweeps use `resolvePinnedYaraRefs({ deviceId, pins })`. It is a new function in `yaraScanRefs.ts`, using the same ownership rule as `resolveYaraRuleSetRefs`.
   - It returns refs only when **every** pin is visible-for-device, enabled, and has `publishedVersion === pin.version` and `publishedSha256 === pin.sha256`. It also requires `agentSupportsYaraScan`.
   - Anything else yields errors `rule_set_changed | not_found | disabled | not_published | agent_too_old`. The scan becomes `failed`, `engine = 'legacy'`, with those `rule_set_errors`, and no command is sent.
   - Non-sweep scans keep `planYaraScan`.
6. **AI-originated sweeps** (`sweep.origin ∈ {ai_chat, mcp}`) run `checkAiRemoteToolsPolicy(deviceId, 'security_scan')`. A deny makes the scan `failed` with `rule_set_errors [{id:'*', code:'ai_policy_denied'}]`. The `aiOrigin` from `sweep.ai_origin` is passed to the command.
7. **Claim and insert, atomically:**
   - `UPDATE security_scans SET status='running', engine, rule_set_errors, dispatched_rule_sets, command_id … WHERE id = $1 AND status = 'queued'`.
   - `queueCommandForExecution(…, { expectedOrgId: sweep?.orgId ?? scan.orgId, offlinePolicy, aiOrigin, deferDelivery: true, commandId })`, inside the same transaction. The command id is reserved up front, so `command_id` is known.
   - Sweeps use `offlinePolicy: { kind: 'queue', deliverWithinMs: max(60_000, expiresAt − now) }`.
   - After commit, `deliver()` runs.

**Existing throttle defect, fixed here.** Today `requeueThrottledScan` calls `addUniqueDispatchJob` from inside the running job. That job finds its own `active` job, treats it as reusable, and schedules nothing, so a throttled scan stays `queued` forever. The fix: throttles are reported back to the processor, which calls `job.moveToDelayed(Date.now() + delay, token)` and throws BullMQ's `DelayedError`. A test proves a throttled scan is retried. The sweep pump does not depend on the fix, since it re-admits, but scheduled and manual scans do.

**Shared claim stamp.** `dispatched_rule_sets` is stamped for scheduled and manual-queued scans in the same claim. `startDeviceScan` (W05-11) stamps it at insert.

**`queueSchemas` gains two members:**
- `{ type: 'dispatch-scan', scanId: uuid, origin: 'sweep', sweepId: uuid }.strict()`
- `{ type: 'pump-sweeps', tickAt: string }.strict()`

### W05-4 Dedupe and the active cap

**The key.** `dedupe_key = sha256hex(canonicalJson([orgId, pins.map(p => p.id + '@' + p.sha256).sort(), scanType, (paths ?? []).slice().sort()]))`, using the existing canonical serializer in `services/actionIntents/canonicalize.ts`.

Creates are serialized per org: inside the create transaction, `pg_advisory_xact_lock(hashtext('security-sweep-org:' || org_id))` is taken per target org, in sorted order. Then:

1. **Active cap.** If the org already has `SECURITY_SWEEP_MAX_ACTIVE_PER_ORG` sweeps that are `active` and unexpired, the whole request gets 409 `TOO_MANY_ACTIVE_SWEEPS`. All or nothing.
2. **Busy devices.** A target with a `queued`/`running` scan in an active, unexpired sweep with the same key is skipped and counted in `skipped.busy_same_sweep`.
3. **All busy.** If every target in every org is skipped for that reason, the response is 409 `SWEEP_ALREADY_RUNNING` with `{ sweepIds, groupIds }`, and nothing is written.

**Re-triggering:**
- A partly covered re-trigger creates a sweep for the rest. This is the "resume" after a cancel or an expiry.
- A republished set has a new sha, so a new key, so a fresh sweep.

### W05-5 Scope, eligibility and permission ceilings

**Scope** is a Zod discriminated union on `kind`:
- `{ kind: 'all' }`
- `{ kind: 'orgs', orgIds: uuid[1..100] }`
- `{ kind: 'sites', siteIds: uuid[1..200] }`
- `{ kind: 'groups', groupIds: uuid[1..50] }`, with membership from `device_group_memberships`
- `{ kind: 'devices', deviceIds: uuid[1..1000] }`

**`resolveSweepTargets(auth, …)` runs under the caller's RLS.** Permissions are resolved **per target org**: `getUserPermissions(userId, { partnerId, orgId })` for each org touched. An org membership takes precedence over the partner membership and may narrow it.

For each target org:
- **Permission:** `devices:execute` is required in that org. An org without it is dropped for `all`, and gets 403 `ORG_OUT_OF_SCOPE` when named explicitly.
- **Ceilings:** devices are intersected with `allowedSiteIds` **and** `allowedDeviceIds`.
  - A named `sites` or `devices` entry outside them → 403 `SITE_OUT_OF_SCOPE` / `DEVICE_OUT_OF_SCOPE` for the whole request.
  - For `all`/`orgs`/`groups`, devices outside them are dropped silently.
- **Device filters:** `isEphemeral = false`, `notParkedDeviceCondition()`, `status <> 'decommissioned'`.
- **Rule sets:** every set must be eligible for the device's org, using the `resolveYaraRuleSetRefs` ownership rule; otherwise the device is skipped as `rule_set_not_eligible`.
  - A set invisible to the caller → 404 `RULE_SET_NOT_FOUND`.
  - A set that is disabled or unpublished → 400 `RULE_SET_NOT_PUBLISHED`.
- **Agent version:** `agentSupportsYaraScan`, otherwise the device is skipped as `agent_too_old`.
- **Cap:** after filtering, more than `SECURITY_SWEEP_MAX_DEVICES` → 400 `SWEEP_TOO_LARGE` with the count. Zero → 400 `NO_ELIGIBLE_DEVICES` with `skipped`.

The same ceilings apply to preview, list, progress and cancel (W05-1, W05-6).

**Output:**
- `previewDigest = sha256hex(canonicalJson({ v: 1, targets: sortedDeviceIds, pins: sortedPins, scanType, paths }))`
- `byOrg`
- `pins`
- `skipped`

**Not offered:** "devices covered by the policies that attach the set" (spec §7). This is a spec change and goes to Gate B 3.

### W05-6 Operator path: direct action, preview-digest confirm

**`POST /security/sweeps/preview`.** Body `{ ruleSetIds, scope, scanType, paths?, ttlHours? }`. It writes nothing and returns:

```json
{ "data": { "targeted": 0, "byOrg": [{ "orgId": "", "orgName": "", "targeted": 0 }], "skipped": {}, "ruleSets": [{ "id": "", "name": "", "version": 0 }], "previewDigest": "" } }
```

**`POST /security/sweeps`.** Body = the preview body plus `previewDigest` (required).
- It re-resolves. A digest mismatch gives 409 `SWEEP_SCOPE_CHANGED` with the fresh preview: devices or pins changed between preview and confirm.
- If `targeted > 50` and `!hasSatisfiedMfa(auth)`, it returns 403 `MFA_REQUIRED`.
  - This is "MFA as the org's policy requires", which can be the password session when no second factor is enforced. The docs say so.
  - API keys never satisfy it, so an API-key create above 50 is refused. AI and MCP sweeps are governed by the intent approval instead (W05-7).
- On success it returns 201 `{ data: { groupId, sweeps: SweepSummary[] } }`.
- `origin` is `web` for a user session and `api` for an API key.

**Reads:**
- `GET /security/sweeps?state=&orgId=&page=&limit=`
- `GET /security/sweeps/:id`
- `GET /security/sweeps/groups/:groupId`

All three are ceiling-filtered.

**`POST /security/sweeps/:id/cancel` and `…/groups/:groupId/cancel`.**
- It needs `devices:execute` in the sweep's org.
- A site- or device-restricted user may cancel only a sweep they created.
- It sets `state = 'cancelled'`, `cancelled_at` and `cancelled_by`, under `FOR UPDATE` on the sweep row.
  - `queued` children → `cancelled`.
  - `running` children whose command is still `pending` (undelivered) → the command is cancelled via `commandCancelPropagation` and the scan becomes `cancelled`.
  - Delivered scans finish, because the agent has no cancel wire.
- It is idempotent: a non-active sweep gives 200 with its state.

**Why not an intent for humans:** the in-app tech already holds `devices:execute`, the sweep is detect-only, and the confirmation shows the count, as the spec asks. Four-eyes for humans would be new product policy, so it is Gate B 2.

### W05-7 AI: a new tool `ioc_hunt` (base Tier 1)

**Why not extend `security_scan`:**
- MCP's effective tier is `max(base, guardrail, floor)`, so read actions on a base-Tier-3 tool would need approval, and the tool is hidden from `tools/list` while intents are off.
- `security_scan`'s per-tool limiter (3/600 s) would charge reads against sweeps.
- `deviceId` is required in its three schemas.

The spec's "security_scan gains sweep/list_rule_sets" is met in substance. This is Gate B 4.

`domain: 'security'`, `searchHint: 'IOC sweep: detection rule sets, preview/run/cancel a sweep, sweep status, import IOCs'`.

| Action | Tier / scope | Does | Permission |
|---|---|---|---|
| `list_rule_sets` | 1 | visible sets: id, name, owner kind (`org`/`partner`/`builtin`), enabled, publishedVersion, stale, ruleCount; paged | `devices:read` |
| `preview_sweep` | 1 | W05-6 preview, **single org** (`orgId` required) | `devices:read` |
| `list_sweeps` | 1 | ceiling-filtered `SweepSummary[]` | `devices:read` |
| `sweep_status` | 1 | one sweep: progress, degraded, threats found, top 10 rule names hit | `devices:read` |
| `sweep` | 3: `supervised` when `expectedDeviceCount ≤ 25`, else `four_eyes`; missing → `four_eyes` | W05-6 create, single org | `devices:execute` |
| `cancel_sweep` | 2 | W05-6 cancel by sweep id | `devices:execute` |
| `import_iocs` | 3 `supervised` | W04 IOC import into an existing set | `devices:write` |

**Single org.** `preview_sweep` and `sweep` take `orgId`, and the scope is resolved inside that org. Released intent auth is rebuilt for `[intent.orgId]` only (`services/actionIntents/actorContext.ts`), so a cross-org AI sweep cannot be released faithfully. A partner sweep across orgs is a UI or API action.

**`sweep` input:** `{ orgId, ruleSetIds, scope, scanType, paths?, ttlHours?, expectedDeviceCount, previewDigest }`.
- `expectedDeviceCount` and `previewDigest` come from a prior `preview_sweep`.
- `TIER_DECIDING_INPUT_KEYS.ioc_hunt = ['expectedDeviceCount']`, and a new input-aware `resolveApprovalScope` branch reads it.
- The released handler re-resolves under the rebuilt auth. It refuses `SWEEP_SCOPE_CHANGED` when `previewDigest` differs or `targeted > expectedDeviceCount`.

**Effect digest** (`EFFECT_DIGEST_RESOLVERS`, keyed the way multi-action tools are keyed there):
- `ioc_hunt` `sweep` pins `{ v: 1, orgId, previewDigest, pins }`, with `pins` read from `yara_rule_sets` in system scope, which the resolver context is.
- `import_iocs` pins `{ v: 1, ruleSetId, currentVersion, iocDigest: sha256(canonical iocs) }`.
- Both are added to `PINNED_EFFECT_DIGEST_REQUIRED` (`services/actionIntents/pinnedEffectPolicy.ts`), so a missing pin fails creation.
- Resolvers get no auth. Caller-scoped target eligibility is carried by `previewDigest`, computed under the caller's context, and re-proved by the handler at release.

**Not agent-mintable in W05.** `ioc_hunt` is added to no `agentToolCatalog` entry, so `origin` can never be `ai_agent`. The approver-substitution path (`USER_OWNED_RELEASE_ACTIONS`, partner-axis approvers only) is therefore not reached.
- Chat intents release under the requester's session auth.
- MCP intents release under the live origin credential (B-W04 D-B26). Its user is the key's creator or the OAuth consenting user, a real `users` row.
- The handler still checks `approverReleaseMismatch(auth, context)` before every write, as defense in depth. The helper moves to `services/aiToolReleaseGuards.ts`.
- Any `auth.user.id` write that `services/aiTools.userOwnedRelease.contract.test.ts` flags in `aiToolsIocHunt.ts` gets a `SAFE_WRITE_SITES` entry with the reason `not agent-mintable: absent from agentToolCatalog`.
- The two stale `aiToolsSecurity.ts` keys (`:631`/`:720` → current lines) are corrected in the same commit.

**`import_iocs`:**
- It calls the extracted W04 service, so the W04 gates all run: built-in 403, `canMutateOrgWideGovernance` ceiling, `canManagePartnerWidePolicies` for partner sets, `devices:write`, the set lock, the 500-rule cap and the 409s.
- It refuses 409 `AI_IMPORT_AUTO_QUARANTINE_SET` when the locked set has `auto_quarantine = true`. The check runs **under the import's set lock**.
- **Audit redaction.** IOC values must not reach the generic `ai.tool.ioc_hunt` / `mcp.tool.ioc_hunt` rows: `sanitizeAuditPayload` does not redact them. Before the generic writers serialize `toolInput`, add an `ioc_hunt` entry to a per-tool input summarizer that replaces `iocs` with `{ count, kinds }`. The summarizer lives at the single choke point both writers use: the chat `ai.tool.*` writer in `aiAgentSdk.ts` and `mcpTier3Lifecycle.ts`. If no shared hook exists, Task B3 adds `summarizeToolInputForAudit(toolName, input)` in `services/aiToolAuditInput.ts`, and both writers call it.

**MCP.** Nothing new.
- `sweep` and `import_iocs` → `MCP_APPROVAL_REQUIRED` with the flag off, or `fileMcpActionIntent` with `MCP_TIER3_INTENTS_ENABLED`.
- `origin` is `mcp` for `intent.source === 'mcp_api'` and `ai_chat` for `chat`.
- `ai_origin` and `intent_id` are stamped from `ToolExecutionContext`.
- **Human MFA** above 50 devices does not apply. The intent approval (four-eyes above 25) governs AI and MCP sweeps.

**Approval headline** (`buildApprovalDescription`): `IOC sweep: "<first set name>"[ +<n> more] on up to <expectedDeviceCount> devices in <org name> (<scope label>)`.
- Scope labels are `all reachable devices`, `<n> sites`, `<n> groups` and `<n> devices`.
- With no DB read available, the fallback is `<n> rule sets` / `this organization`.
- The headline must contain no `[a-z]_[a-z]`.

**`security_scan` `scan` is re-routed** through the shared `startDeviceScan` (W05-11). It keeps its tier, uses `aiQueueCommand` semantics (AI remote-tools policy + `aiOrigin`), and never auto-quarantines.

**Rate limit and budget:**
- `ioc_hunt` gets `{ limit: 30, windowSeconds: 600 }`. Sweep creation is also limited in the service (W05-4, plus the per-user limit), so UI, AI and MCP share one budget.
- The index line is measured with `renderToolIndexByDomain(listChatSurfaceToolNames())`, flag off **and** flag on (`FLOWS_ENABLED`).
- Today the ceiling on `main` is **6656 B** with `MAX_INLINE_ACTIONS` 8. PR #9767 (open) makes it 6912 B and 7. With 7 actions, the line renders inline under both.
- If either measurement goes over the ceiling on `main` at implementation time, **stop**. That is Gate B 5.

**Not in W05** (explicit rescope of what W04's mcp-coverage notes promised):
- AI rule-set and rule create/edit/delete. A model authoring free-text rules is the wrong default; the structured importer is the safe write.
- AI sample test. It needs a file.

The `mcpCoverage` entries for `security/yara.ts` and `security/yaraTest.ts` change accordingly. That is Gate B 7.

### W05-8 Audit events

Writers are `writeAuditEvent` in requests and `createAuditLogAsync` in the pump. There is one row per **org sweep row**, with `orgId` set.

| Action | resourceType / resourceId | Actor | details |
|---|---|---|---|
| `security.scan_sweep.create` | `security_scan_sweep` / sweep id | the real principal: `actorType` `user`, or `api_key` with `actorId` the key id and `actorEmail` the creator's | `{ groupId, pins, scanType, pathsCount, scopeKind, targeted, skipped, origin, intentId, ttlHours }` |
| `security.scan_sweep.cancel` | same | same | `{ groupId, cancelledQueued, cancelledUndelivered }` |
| `security.scan_sweep.expire` | same | `actorType: 'system'` | `{ groupId, expiredQueued, expiredUndelivered }` |
| `security.scan_sweep.complete` | same | `actorType: 'system'` | `{ groupId, progress }` |

- **Never in details:** paths, device ids, IOC values, matched strings.
- **`initiatedBy`:**
  - `ai` for `ai_chat`;
  - `integration` for `mcp` and `api`;
  - `manual` for `web`;
  - `schedule` for expire and complete.
- **Generic rows.** The generic `ai.tool.ioc_hunt` / `mcp.tool.ioc_hunt` rows stay, with the W05-7 input summary.
- **Per-device commands.** `security_scan` is in `AUDITED_COMMANDS`. Task A5 records whether `queueCommandForExecution` writes a per-device row. If it does, the per-device execution evidence is 10,000 rows for a 10,000-device sweep, and that is accepted.

### W05-9 Rule version at detection time, server-side (W04 deferred)

- **What the server knows.** The agent verifies the bundle's id, version and sha (`agent/internal/yarascan/fetch.go`), and the fetch route serves only the current version. So the version an honest agent matched is the dispatched one.
- **Ingest.** `handleSecurityCommandResult` resolves the scan through the **command's own** `scanRecordId`, never the agent-reported one, which it prefers today. It then writes `details.ruleSetVersion` on threats whose `ruleSetId` matches a `dispatched_rule_sets` entry. Legacy and unmatched threats get no key.
- **Display.** The details projection adds `ruleSetVersion: number | null`, and `ThreatRulePanel` shows "Version N".
- **Agent.** Nothing changes, so there is no `MIN_AGENT_VERSION_*`.

### W05-10 Agent fetch route: dispatched-ref authorization

Agent context, no escalation. If the policy check fails, before the 404:

```sql
EXISTS (SELECT 1 FROM security_scans s
        WHERE s.device_id = $device AND s.org_id = $deviceOrg AND s.status = 'running'
          AND s.dispatched_rule_sets @> jsonb_build_array(jsonb_build_object('id', $setId::text, 'version', $version)))
```

- **Not sweep state.** A cancel or expiry while the agent loads bundles (up to 5 min, `ruleSetLoadTimeout`) must not break an already-dispatched scan.
- **Not `queued`.** No command exists yet.
- **Order unchanged.** The existing version/409 and built-in checks run after it.

### W05-11 Shared device-scan start, PR split and lab

**`startDeviceScan`** (`services/securityScanStart.ts`) is lifted verbatim from `POST /security/scan/:deviceId`, plus three changes:
- it stamps `dispatched_rule_sets` and `command_id`;
- it takes `aiOrigin`;
- it applies the AI remote-tools policy when `aiOrigin` is set.

The UI route and AI `scan` share it. Manual scans still bypass the queue caps, as W01 built it. That is deferred.

| PR | Ships | Shippable alone because |
|---|---|---|
| A (API) | migration, mover detach, sweep service, pump, claim lock + throttle fix, fetch auth, routes, audit, `dispatched_rule_sets` / `command_id` / `ruleSetVersion`, `startDeviceScan` | API clients can use it; web and AI are unchanged |
| B (AI) | `ioc_hunt`, guardrails, parity files, digest pins, audit input summary, `security_scan scan` re-route | uses only A's services |
| C (web + docs) | Sweep now dialog, Sweeps tab, statuses, "Version N", locales, docs, release-notes copy | uses only A's routes |

**Lab:** no agent-shipped part, so no agent lab before promote. A one-sweep smoke against a real agent on a wt-stack (Task C5) is owed before PR C merges.

---

## File structure

### PR A — API

| File | Responsibility |
|---|---|
| `apps/api/migrations/2027-01-04-140000-security-scan-sweeps.sql` (create) | table, CHECKs, indexes, RLS ×4, three `security_scans` columns + index |
| `apps/api/src/db/schema/security.ts` (modify) | `securityScanSweeps`; `securityScans.sweepId`, `.dispatchedRuleSets`, `.commandId` |
| `packages/shared/src/types/securityScanSweep.ts` (create; export from `types/index.ts`) | types, constants |
| `packages/shared/src/validators/securityScanSweep.ts` + test (create) | Zod request schemas |
| `apps/api/src/services/securityScanSweepTargets.ts` + test (create) | `resolveSweepTargets` |
| `apps/api/src/services/securityScanSweeps.ts` + test (create) | preview / create / cancel / progress / list |
| `apps/api/src/jobs/securityScanSweepPump.ts` + test (create) | `pumpSweeps` |
| `apps/api/src/jobs/securityScanClaim.ts` + test (create) | `claimAndDispatchScan` (the W05-3 transaction) |
| `apps/api/src/jobs/securityScanJobs.ts` (modify) | worker routes `pump-sweeps`; `processDispatchScan` → `claimAndDispatchScan`; throttle via `moveToDelayed`; backpressure/busy predicates; `buildSecurityScanPayload(…, triggerDefender)` |
| `apps/api/src/jobs/queueSchemas.ts` (modify) | two union members |
| `apps/api/src/services/yaraScanRefs.ts` (modify) | `resolvePinnedYaraRefs` |
| `apps/api/src/services/securityScanStart.ts` + test (create) | `startDeviceScan` |
| `apps/api/src/routes/security/scans.ts`, `schemas.ts` (modify) | thin call; status enum |
| `apps/api/src/routes/security/sweeps.ts` + test (create); `index.ts` (modify) | routes |
| `apps/api/src/routes/agents/yaraRuleSets.ts` + test (modify) | dispatched-ref authorization |
| `apps/api/src/routes/agents/helpers.ts` + test (modify) | command-bound scan lookup, `ruleSetVersion` |
| `apps/api/src/routes/security/threats.ts` / `helpers.ts` + test (modify) | projection |
| `apps/api/src/services/deviceOrgMove/moveDeviceOrgInTransaction.ts` + test (modify) | sweep detach before restamp |
| `apps/api/src/services/tenantCascade.ts`, `orgMergeRegistry.ts`, `tenantExportPolicyRegistry.ts` (modify) | registrations |
| `apps/api/src/services/mcpCoverage.ts` (modify) | `security/sweeps.ts` → `tool_in_later_wave` (#6268) |
| `apps/api/src/__tests__/parkedFanoutModules.ts` (modify) | the new selectors; guard counts |
| `apps/api/src/__tests__/integration/securityScanSweeps.integration.test.ts` (create) | real-DB tenancy, races, pump, fetch, move |
| `apps/api/src/system/connections/internalEnvVars.ts` (modify if the env contract requires) | `SECURITY_SWEEP_*`, `IOC_HUNT_*` |

### PR B — AI

| File | Responsibility |
|---|---|
| `apps/api/src/services/aiToolsIocHunt.ts` + tests (create) | `registerIocHuntTools` |
| `apps/api/src/services/aiTools.ts` (modify) | register |
| `apps/api/src/services/aiToolSchemas.ts`, `aiAgentSdkTools.ts` (`TOOL_TIERS.ioc_hunt = 1`), `aiToolRateLimits.ts` (modify) | parity |
| `apps/api/src/services/aiGuardrails.ts` (modify) | `TIER1_ACTIONS`, `TIER2_ACTIONS`, `TIER3_ACTIONS`, `TIER3_SUPERVISED_ACTIONS`, the input-aware scope branch, `TIER_DECIDING_INPUT_KEYS`, `TOOL_PERMISSIONS`, headline |
| `apps/api/src/services/actionIntents/effectDigest.ts`, `pinnedEffectPolicy.ts` (modify) | resolvers, mandatory pins |
| `apps/api/src/services/aiToolReleaseGuards.ts` (create) | `approverReleaseMismatch`, moved |
| `apps/api/src/services/aiToolAuditInput.ts` (create if no hook exists) | `summarizeToolInputForAudit` |
| `apps/api/src/services/yaraIocImportService.ts` (create); `routes/security/yaraIocImport.ts` (modify) | W04 import extracted |
| `apps/api/src/services/aiToolsSecurity.ts` (modify) | `scan` → `startDeviceScan` |
| `apps/web/src/components/ai-risk/tierConfig.ts`; `apps/docs/src/content/docs/features/{ai,mcp-server}.mdx` (modify) | parity |
| `apps/api/src/services/mcpCoverage.ts` (modify) | flips (Gate B 7) |

### PR C — web + docs

| File | Responsibility |
|---|---|
| `apps/web/src/components/security/sweeps/{sweepsApi.ts, sweepProgress.ts, SweepDialog.tsx, SweepsPanel.tsx}` + tests (create) | client, formatter, dialog, tab |
| `…/detectionRules/RuleSetEditor.tsx`, `…/SecurityScansPage.tsx`, `…/SecurityScanManager.tsx`, `…/ThreatRulePanel.tsx` + tests (modify) | button, tab, statuses, version |
| `apps/web/src/locales/*/security.json` ×8, `apps/web/src/locales/yaraCopyRule.test.ts` (modify) | copy |
| `apps/docs/src/content/docs/features/security.mdx`, `docs/release-notes/next-release-draft.md` (modify) | docs, release copy |

---

## PR A — API

### Task A1: Shared types and request validators

**Files:**
- Create: `packages/shared/src/types/securityScanSweep.ts`, `packages/shared/src/validators/securityScanSweep.ts`, `packages/shared/src/validators/securityScanSweep.test.ts`
- Modify: `packages/shared/src/types/index.ts`, `packages/shared/src/validators/index.ts`, `apps/api/src/routes/security/schemas.ts` (imports the shared path element schema)

**Interfaces — Produces:**
- Value tuples, each with its type:
  - `SECURITY_SWEEP_STATES = ['active','completed','cancelled','expired'] as const`
  - `SECURITY_SWEEP_ORIGINS = ['web','api','ai_chat','mcp'] as const`
  - `SECURITY_SWEEP_SKIP_REASONS = ['agent_too_old','busy_same_sweep','rule_set_not_eligible'] as const`
- Constants: `SECURITY_SWEEP_MAX_DEVICES_DEFAULT = 10_000`, `SECURITY_SWEEP_TTL_HOURS_DEFAULT = 24`, `SECURITY_SWEEP_TTL_HOURS_MAX = 72`, `SECURITY_SWEEP_MFA_DEVICE_THRESHOLD = 50`, `IOC_HUNT_FOUR_EYES_DEVICE_THRESHOLD = 25`.
- `type SecuritySweepScope`, the W05-5 union.
- `interface YaraRuleSetPin { id: string; version: number; sha256: string }`
- `interface SweepProgress { queued; running; completed; timedOut; failed; cancelled; expired; degraded; threatsFound }`, all numbers.
- `interface SweepSummary { id; groupId; orgId; orgName: string | null; ruleSets: Array<{ id; name: string | null; version: number }>; scanType; state: SecuritySweepState; targeted; skipped; progress: SweepProgress; origin; createdBy: { id; name: string | null } | null; createdAt; expiresAt; completedAt: string | null }`
- Schemas:
  - `securitySweepScopeSchema`.
  - `securitySweepRequestSchema = { ruleSetIds (uuid[1..20], distinct), scope, scanType, paths?, ttlHours? }`, refined so that `paths` ⇔ `custom`.
  - `securitySweepCreateSchema = request & { previewDigest: /^[0-9a-f]{64}$/ }`.

- [ ] **Step 1: Write the failing tests:**
  - `accepts each scope kind`. Also: `kind: 'nope'` is rejected.
  - `bounds arrays`: 101 orgIds, 201 siteIds, 51 groupIds, 1001 deviceIds and 21 ruleSetIds are each rejected, and duplicate ruleSetIds are rejected.
  - `paths only for custom`: quick + paths, custom without paths, 21 paths and a 1025-char path are each rejected.
  - `ttlHours`: 0 and 73 are rejected; 1, 72 and absent are accepted.
  - `create requires a 64-hex previewDigest`.
- [ ] **Step 2: Run** `cd packages/shared && npx vitest run src/validators/securityScanSweep.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement.** Move the path element schema from `scanRequestSchema` into the shared validator and import it back, so there is one definition.
- [ ] **Step 4: Run** the test, then `npx vitest run src/validators`, then shared tsc (exit 0). Then run `cd apps/api && npx vitest run src/routes/security/scans.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): security scan sweep types and request validators (#6268)`.

### Task A2: Migration, schema, registrations, mover detach

**Files:**
- Create: the migration.
- Modify: `db/schema/security.ts`, `services/tenantCascade.ts`, `services/orgMergeRegistry.ts`, `services/tenantExportPolicyRegistry.ts`, `services/deviceOrgMove/moveDeviceOrgInTransaction.ts` + its test.
- Test: `__tests__/integration/securityScanSweeps.integration.test.ts` (`describe('tenancy')`).

- [ ] **Step 1: Write the failing integration tests:**
  - `org A user cannot read org B sweep`.
  - `forged org-B insert under org-A breeze_app context fails WITH CHECK`.
  - `security_scans.sweep_id SET NULL on sweep delete`.
  - `state CHECK rejects 'done'`.
  - `paths and origin CHECKs`.

  Also write a unit test in the mover's test file: `move detaches sweep scans: queued → cancelled, sweep_id NULL, running keeps status with sweep_id NULL; runs before the devices UPDATE`.
- [ ] **Step 2: Run** on a per-worktree stack (`pnpm wt-stack up` with a free `BREEZE_DOCKER_SUBNET`/`BREEZE_CADDY_IP`): `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/securityScanSweeps.integration.test.ts`, then the mover unit test. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Migration.** Write it per W05-1. The RLS block copies the org-policy shape of `2026-12-30-230000-yara-rule-sets.sql`: `ENABLE` + `FORCE`, then `DROP POLICY IF EXISTS` and create for `security_scan_sweeps_{select,insert,update,delete}` on `breeze_has_org_access(org_id)`.
  - **Drizzle schema.**
  - **Cascade.** Add `security_scan_sweeps`. Place it where `tenantCascade*` / `tenantCascadeFkChildren` require: FK children (`security_scans`) come before parents, which wins over alphabetical order if the test says so.
  - **Merge.** Repoint.
  - **Export.** Per W05-1.
  - **Mover.** Add the detach statement before the `devices` UPDATE. Comment it like the existing `device_function_assessments` sever.
- [ ] **Step 4: Run.**
  1. `pnpm db:migrate`, then `pnpm db:check-drift` (expected: no drift).
  2. The tenancy tests, plus `rls-coverage.integration.test.ts` with `DB_CONTEXTLESS_WRITE_STRICT=true`, `tenant-export-policy`, every `tenantCascade*`, and the org-merge registry suites.
  3. The mover unit test, plus `src/routes/devices/moveOrg.coverage.test.ts` and `cascadeDelete.test.ts`.

  Expected: PASS. Record the counts.
- [ ] **Step 5: Commit** `feat(api): security_scan_sweeps table, sweep columns on security_scans, RLS, registrations, move detach (#6268)`.

### Task A3: Target resolution

**Files:**
- Create: `services/securityScanSweepTargets.ts`, `securityScanSweepTargets.test.ts`
- Modify: `__tests__/parkedFanoutModules.ts`

**Interfaces — Produces:**
```ts
resolveSweepTargets(auth: AuthContext, input: { ruleSetIds: string[]; scope: SecuritySweepScope; scanType: ScanType; paths?: string[]; onlyOrgId?: string }):
  Promise<
    | { ok: true; byOrg: Map<string, string[]>; skipped: Record<SweepSkipReason, number>; pins: YaraRuleSetPin[]; ruleSetNames: Map<string, string>; previewDigest: string }
    | { ok: false; status: 400 | 403 | 404; code: 'ORG_OUT_OF_SCOPE' | 'SITE_OUT_OF_SCOPE' | 'DEVICE_OUT_OF_SCOPE' | 'RULE_SET_NOT_FOUND' | 'RULE_SET_NOT_PUBLISHED' | 'SWEEP_TOO_LARGE' | 'NO_ELIGIBLE_DEVICES'; detail?: Record<string, unknown> }
  >
```
- It runs under the caller's context only.
- `onlyOrgId` restricts the scope to one org. The AI path uses it.
- `previewDigest` follows W05-5.

- [ ] **Step 1: Write the failing tests** (Drizzle mocks, `breeze-testing`):
  - `drops parked, ephemeral, decommissioned`.
  - `per-org permissions: org membership narrower than partner membership wins`.
  - `allowedSiteIds and allowedDeviceIds both intersect`.
  - `explicit foreign site/device → *_OUT_OF_SCOPE`.
  - `org without devices:execute dropped from all, ORG_OUT_OF_SCOPE when named`.
  - `org set ineligible on another org's device → skipped.rule_set_not_eligible`.
  - `partner-wide set eligible across its partner; built-in everywhere`.
  - `agent 0.123.9 skipped; '0.124.0-rc1' eligible; 'dev' skipped`.
  - `invisible set → 404; disabled/unpublished → 400`.
  - `10001 → SWEEP_TOO_LARGE; 0 → NO_ELIGIBLE_DEVICES`.
  - `previewDigest stable across input order, changes when a device or a pin sha changes`.
  - `onlyOrgId excludes other orgs`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/securityScanSweepTargets.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** One device select joined to `organizations`. Sets are loaded once under caller RLS. Groups come from `device_group_memberships`. Permissions are cached per org within the call.
- [ ] **Step 4: Register** `'services/securityScanSweepTargets.ts': { guards: 1, reason: 'IOC sweep target selection' }`. Then run the test plus `src/__tests__/parkedFanout.contract.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): sweep target resolution with per-org permission ceilings and pinned rule sets (#6268)`.

### Task A4: Sweep service

**Files:**
- Create: `services/securityScanSweeps.ts`, `securityScanSweeps.test.ts`
- Modify: `jobs/securityScanJobs.ts`, to export `enqueueSweepPump(): Promise<void>`. It uses `jobId: 'security-sweep-pump-now'`, `removeOnComplete: true`.

**Interfaces — Produces:**
- `previewSweep(auth, request, opts?: { onlyOrgId?: string })`
- `createSweep(auth, request & { previewDigest: string }, ctx: { origin: SecuritySweepOrigin; aiOrigin?: AiOriginRef; intentId?: string | null; mfaSatisfied: boolean; onlyOrgId?: string; expectedDeviceCount?: number })`
  - Returns `{ ok: true; groupId; sweeps: SweepSummary[] }`, or `{ ok: false; status; code: 'SWEEP_SCOPE_CHANGED' | 'SWEEP_ALREADY_RUNNING' | 'TOO_MANY_ACTIVE_SWEEPS' | 'MFA_REQUIRED' | 'RATE_LIMITED' | TargetErrorCode; detail? }`.
- `cancelSweep(auth, sweepId)` and `cancelSweepGroup(auth, groupId)`. Each returns `{ ok: true; sweeps: SweepSummary[]; cancelledQueued; cancelledUndelivered }` or `{ ok: false; status: 403 | 404 }`.
- `listSweeps(auth, { state?, orgId?, page, limit })`, `getSweep(auth, id)`, `getSweepGroup(auth, groupId)`. All are ceiling-filtered (W05-1).

- [ ] **Step 1: Write the failing tests:**
  - **Preview and create:**
    - `preview writes nothing`.
    - `create: one sweep per org sharing groupId; one queued scan per device with sweep_id and initiated_by; 2500 devices → 3 chunked inserts`.
    - `rule_set_pins and dedupe_key persisted`.
    - `one pump job enqueued after commit`.
    - `previewDigest mismatch → SWEEP_SCOPE_CHANGED with fresh preview, nothing written`.
    - `expectedDeviceCount given and exceeded → SWEEP_SCOPE_CHANGED`.
  - **MFA:**
    - `> 50 without satisfied MFA (user session) → MFA_REQUIRED`.
    - `api key > 50 → MFA_REQUIRED`.
    - `ai_chat/mcp origin skips the MFA rule`.
  - **Dedupe and caps:**
    - `same key all busy → SWEEP_ALREADY_RUNNING with ids, nothing written`.
    - `half busy → created for the rest, skipped.busy_same_sweep`.
    - `expired-but-still-active sweep does not count as busy`.
    - `republished set (new sha) → not busy`.
    - `org at 5 active → TOO_MANY_ACTIVE_SWEEPS; completed sweeps do not count`.
    - `11th create in an hour → RATE_LIMITED`. The limiter is called outside any DB context.
  - **Audit:**
    - `one security.scan_sweep.create per org row; api-key actor attribution; no paths/device ids`.
  - **Cancel:**
    - `queued → cancelled; pending-command running → command cancelled + scan cancelled; delivered running untouched; FOR UPDATE on the sweep`.
    - `cancel twice → 200, one audit`.
    - `restricted user cancels only own`.
  - **Reads:**
    - `progress: degraded counts legacy engine / rule_set_errors among completed`.
    - `restricted caller's aggregates cover only reachable devices`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/securityScanSweeps.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per W05-4 and W05-6.
- [ ] **Step 4: Run** the same test file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): security scan sweep service — preview digest, create, dedupe, cancel, progress (#6268)`.

### Task A5: Claim transaction, pump, throttle fix

**Files:**
- Create: `jobs/securityScanClaim.ts` + test, `jobs/securityScanSweepPump.ts` + test
- Modify: `jobs/securityScanJobs.ts` + its test, `jobs/queueSchemas.ts`, `services/yaraScanRefs.ts` + test, `__tests__/parkedFanoutModules.ts`

**Interfaces — Produces:**
- `claimAndDispatchScan(data: DispatchScanJobData): Promise<{ outcome: 'dispatched' | 'throttled' | 'skipped' | 'failed' | 'cancelled'; commandId: string | null; throttleReason?: string }>`
- `pumpSweeps(now: Date): Promise<{ skipped: boolean; expired: number; finalized: number; completed: number; admitted: number }>`
- `resolvePinnedYaraRefs({ deviceId, agentVersion, pins }): Promise<{ ok: true; refs: YaraRuleSetRef[] } | { ok: false; errors: YaraRuleSetError[] }>`
- `buildSecurityScanPayload(scanRecordId, scanType, settings, paths?, ruleSets?, opts?: { triggerDefender?: boolean })`. The default is `true`.
- `initializeSecurityScanWorkers` also registers the `pump-sweeps` repeatable, removing any stale one first, like `schedulePolicyTick`.

- [ ] **Step 1: Write the failing tests.**

  **Claim:**
  - `partner advisory lock taken before counts`.
  - `two concurrent claims in one org at 39 running → exactly one dispatches` (integration twin in A9).
  - `throttled → moveToDelayed + DelayedError, job retried (regression for the self-reuse defect)`.
  - `command inserted in the claim tx with deferDelivery and a reserved id stored in command_id; deliver() after commit`.
  - `dispatched_rule_sets stamped for sweep, scheduled and manual-queued scans`.

  **Sweep branch:**
  - `uses pins, not the policy`.
  - `autoQuarantine false and triggerDefender false even if the policy enables them`.
  - `exclusions/maxFileSizeMb/timeout from the policy`.
  - `sweep cancelled / expired / org mismatch / device org mismatch → cancelled, no command`.
  - `pin sha changed → failed rule_set_changed`.
  - `one pin disabled → failed (no partial-set scan)`.
  - `agent too old → failed agent_too_old`.
  - `ai origin + remote-tools policy deny → failed ai_policy_denied`.
  - `aiOrigin passed to the command`.
  - `expectedOrgId = sweep.orgId`.
  - `deliverWithinMs = max(60 s, expires − now)`.

  **Pump:**
  - `single-flight: second concurrent pump returns skipped`.
  - `expire: queued → expired, pending-command running → cancelled command + expired, one audit per sweep`.
  - `finalize via command_id: terminal undelivered → expired`.
  - `running with no result beyond 720+65 min → failed`.
  - `running at 31 min with a server-timed-out command and a later result → stays running, then completed by the late result`.
  - `complete: no queued/running → completed + audit`.
  - `admit: only online, unparked, no running scan, no non-sweep queued scan; org cap 40, partner cap 200, batch 100; oldest sweep first; idempotent job ids`.

  **Scheduler predicates:**
  - `queued sweep scans excluded from getOrgQueuedScans and the busy select`.

  **Schemas:**
  - `origin sweep requires sweepId; pump-sweeps strict`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/jobs/securityScanClaim.test.ts src/jobs/securityScanSweepPump.test.ts src/jobs/securityScanJobs.test.ts src/services/yaraScanRefs.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per W05-2 and W05-3. Keep `securityScanJobs.ts` around 500 lines or fewer: the claim and the pump live in their own files.
  - Read `commandCancelPropagation.ts` for the cancel helper.
  - Read the `device_commands` transition code for the "delivered" column.
  - Record in the commit body whether `queueCommandForExecution` writes a per-device audit row (W05-8).
  - Register `'jobs/securityScanSweepPump.ts': { guards: 1, reason: 'IOC sweep admission' }`.
  - Bump `jobs/securityScanJobs.ts`'s pinned guard count if the claim re-check adds a predicate reference.
- [ ] **Step 4: Run** the four files, plus `src/__tests__/parkedFanout.contract.test.ts`, `src/services/workerRegistry*.test.ts` and `src/services/commandTimeouts*.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): locked scan claim with deferred delivery, sweep pump, throttle retry fix (#6268)`.

### Task A6: Fetch authorization and `ruleSetVersion`

**Files:**
- Modify: `routes/agents/yaraRuleSets.ts` + test, `routes/agents/helpers.ts` + test, `routes/security/threats.ts` / `helpers.ts` + `threats.test.ts`

- [ ] **Step 1: Write the failing tests.**

  **Fetch:**
  - `set not in policy, running scan dispatched with {id, version} → 200`.
  - `same scan, sweep cancelled mid-load → still 200`.
  - `queued scan → 404`.
  - `completed scan → 404`.
  - `other device's scan → 404`.
  - `scan org ≠ device org → 404`.
  - `dispatched version 3, request version 4 → not authorized by this branch (404 or the existing 409 if policy-attached)`.

  **Ingest:**
  - `scan resolved by the command's scanRecordId even when the agent reports another`.
  - `threat on ruleSetId S gets details.ruleSetVersion`.
  - `legacy threat / null dispatched_rule_sets → no key`.

  **Details route:**
  - `ruleSetVersion number or null; junk → null`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/routes/agents/yaraRuleSets.test.ts src/routes/agents/helpers.test.ts src/routes/security/threats.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per W05-9 and W05-10.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): agent fetch honours dispatched rule-set refs; threats record the version they matched (#6268)`.

### Task A7: `startDeviceScan`

**Interfaces — Produces:**
```ts
startDeviceScan(auth: AuthContext, input: { deviceId: string; scanType: ScanType; paths?: string[]; mfaSatisfied: boolean; aiOrigin?: AiOriginRef }):
  Promise<{ ok: true; scan: { id: string; deviceId: string; deviceName: string; orgId: string; scanType: ScanType; status: 'queued'; startedAt: string } } | { ok: false; status: 403 | 404; error: string }>
```

- [ ] **Step 1: Write the failing test** `services/securityScanStart.test.ts`. Port the route's cases and add:
  - `dispatched_rule_sets and command_id stamped`;
  - `aiOrigin → remote-tools policy checked and aiOrigin on the command`;
  - `aiOrigin and policy deny → 403, no row`.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement** the lift. The route becomes a thin call, and `scans.test.ts` passes with only its mocks changed.
- [ ] **Step 4: Run** `npx vitest run src/services/securityScanStart.test.ts src/routes/security/scans.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `refactor(api): startDeviceScan shared by the scan route and the AI tool (#6268)`.

### Task A8: Sweep routes

**Files:**
- Create: `routes/security/sweeps.ts` + test
- Modify: `routes/security/index.ts`, `services/mcpCoverage.ts`

**Routes**, per W05-6, all behind `requireScope('organization','partner','system')`:
- `POST /sweeps/preview`, `POST /sweeps` and both cancels require `requirePermission('devices','execute')`.
- The reads require `devices:read`.
- `zValidator` uses the shared schemas.
- mcpCoverage gets `'security/sweeps.ts': { exempt: 'tool_in_later_wave', note: 'IOC sweeps (#6263 W05); the ioc_hunt AI tool ships in W05 PR B (#6268).' }`.

- [ ] **Step 1: Write the failing route tests:**
  - `viewer → 403 on preview/create/cancel`.
  - `400 invalid body`.
  - `201 shape`.
  - `409/403 codes pass through with detail`.
  - `list paginates/filters by state`.
  - `group sums visible rows only`.
  - `cancel by id and by group`.
  - `api key → origin api, MFA rule above 50`.
- [ ] **Step 2: Run** `npx vitest run src/routes/security/sweeps.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, and mount the routes.
- [ ] **Step 4: Run** the route test, plus `src/__tests__/mcp-coverage.test.ts`, `partner-wide-write-coverage.test.ts`, `site-ceiling-write-coverage.test.ts` and the env-contract tests.
  - If a write-coverage walk flags `services/securityScanSweeps.ts`, add an allowlist entry with the reason `sweep rows are execution records, not config; per-device site/device ceilings enforced in resolveSweepTargets`.
  - Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): IOC sweep routes — preview, create, list, group, cancel (#6268)`.

### Task A9: Integration and race suite, gates, PR A

- [ ] **Step 1: Extend** `securityScanSweeps.integration.test.ts` with real-DB cases.

  **Tenancy:**
  - `partner user sweeps a partner-wide set across two orgs → two rows, one groupId`.
  - `org A user sees only org A's row and progress`.

  **Races:**
  - `two concurrent identical creates → one created, one SWEEP_ALREADY_RUNNING`.
  - `two concurrent claims at the org cap → one dispatch`.
  - `cancel vs claim → either cancelled-before-claim or claimed-then-command-cancelled, never a delivered command for a cancelled sweep row`.

  **Pump and fetch:**
  - `pump under breeze_app system context admits and the claim stamps dispatched_rule_sets + command_id`.
  - `fetch under agent RLS: dispatched ref 200, after the scan completes 404`.

  **Lifecycle:**
  - `device moved before command creation → scan cancelled, never dispatched`.
  - `device moved after command creation → sweep_id NULL, result still ingests in the new org`.
  - `republish after approval → rule_set_changed`.
  - `Redis job lost → next pump re-admits`.
  - `command cancelled (payload erased) → finalize via command_id`.
  - `late result after server timeout → completed`.
  - `org cascade delete removes sweeps and scans; org merge repoints`.
- [ ] **Step 2: Run** the full gate set.
  1. **Integration, on the stack:**
     - the new file;
     - the W03/W04 YARA integration suites;
     - `rls-coverage` (strict);
     - `tenant-export-policy`;
     - `tenantCascade*`;
     - `pnpm test:integration-suite-coverage`.
  2. **API unit batches:** `src/routes/security`, `src/routes/agents`, `src/jobs`, `src/services/security*`, `src/services/yara*`, `src/services/deviceOrgMove` and `src/__tests__`.
  3. **CI gating:** `node --test .github/scripts/ci-area-gating.test.mjs`.
  4. **Typecheck:** api and shared tsc, reading the exit codes.

  Record every count, then run `pnpm wt-stack down`.
- [ ] **Step 3: Open PR A.**
  - Title: `feat(security): YARA W05a — IOC sweep API, locked claim + pump, fetch authorization, rule version on threats (#6268)`.
  - Body: `Part of #6263`, `Refs #6268`, plus:
    - migration;
    - tenancy justification;
    - caps;
    - the throttle-defect fix;
    - the per-device audit finding.
  - Run one `/pr-review-toolkit:review-pr` round and post the summary.

---

## PR B — AI `ioc_hunt`

Branch from `main` after PR A merges. First check #9767:
- If it merged, the ceiling is 6912 B and `MAX_INLINE_ACTIONS` is 7.
- Files to rebase-check: `aiGuardrails.ts`, `aiToolSchemas.ts`, `aiAgentSdkTools.ts`, `mcpCoverage.ts`, `tierConfig.ts`, `ai.mdx`, `mcp-server.mdx`.

### Task B1: Register `ioc_hunt`, read actions, index measurement

**Interfaces — Produces:**
- `registerIocHuntTools(aiTools)` registers tool `ioc_hunt`, with `tier: 1` and `domain: 'security'`.
- Its `input_schema` declares: `action` (all 7), `orgId`, `ruleSetIds`, `scope`, `scanType`, `paths`, `ttlHours`, `expectedDeviceCount`, `previewDigest`, `sweepId`, `ruleSetId`, `iocs`, `label`, `page`, `limit`.
- The description is ≤ 300 chars and names all 7 actions.
- `deviceArgs`: declare `scope.deviceIds` only if `deviceArgsCoverage` requires it. Then site-narrow it per `aiToolsSiteScope`; `resolveSweepTargets` already does.

- [ ] **Step 1: Write the failing tests:**
  - `list_rule_sets visible sets with owner kind`.
  - `preview_sweep single-org, writes nothing, returns previewDigest`.
  - `list_sweeps / sweep_status shapes and ceilings`.
  - `not present in any agentToolCatalog entry`.
- [ ] **Step 2: Run** `npx vitest run src/services/aiToolsIocHunt.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** over A3/A4. Update the Zod schema, the SDK shape + tier, the rate limit, `TIER1_ACTIONS`, `TOOL_PERMISSIONS`, `tierConfig.ts`, `ai.mdx` and `mcp-server.mdx`.
- [ ] **Step 4: Measure.** Run `npx vitest run src/services/aiToolIndex.test.ts` with the flag off and on, and record the bytes before and after. Over the ceiling → **stop** (Gate B 5).
- [ ] **Step 5: Run** the AI contract batch. Expected: PASS.
  - `aiTools.*.contract.test.ts`, `aiToolsSiteScope.contract.test.ts`, `aiToolIndex.test.ts`
  - `aiAgentSdkTools.{registryParity.contract,mcpCoverage,handlerCoverage.contract}.test.ts`
  - `aiToolPermissionsCatalogParity.contract.test.ts`, `aiToolsRegistryParity.test.ts`
  - `aiGuardrailsTierConfig.parity.test.ts`, `aiGuardrailsAiDocs.parity.test.ts`, `aiGuardrails.approvalScope.contract.test.ts`
  - `aiAgents/agentToolCatalog.contract.test.ts`
  - `routes/mcpServer.{statelessParity,conformance}.contract.test.ts`, `routes/mcpServer.effectiveTier.test.ts`
- [ ] **Step 6: Commit** `feat(ai): ioc_hunt tool — rule sets, sweep preview, list and status (#6268)`.

### Task B2: `sweep` and `cancel_sweep`

**Files to modify:** `aiToolsIocHunt.ts`, `aiGuardrails.ts`, `actionIntents/effectDigest.ts`, `actionIntents/pinnedEffectPolicy.ts`, `services/aiTools.userOwnedRelease.contract.test.ts`.

**File to create:** `services/aiToolReleaseGuards.ts`. `aiToolsSecurity.ts` and `aiToolsBrowser.ts` then import from it.

- [ ] **Step 1: Write the failing tests.**

  **Approval scope and tier:**
  - `expectedDeviceCount 25 → supervised, 26 → four_eyes, missing/non-numeric → four_eyes`.
  - `sweep tier 3 in chat and over MCP; reads tier 1 over MCP`.

  **Headline:**
  - `headline 'IOC sweep: "Advisory 7" +1 more on up to 12 devices in Acme (3 sites)', no snake_case`.

  **Digest:**
  - `digest required (creation fails without a pin)`.
  - `digest pins orgId + previewDigest + pins`.

  **Release:**
  - `released handler: digest/targets changed → SWEEP_SCOPE_CHANGED, nothing written`.
  - `approverReleaseMismatch → refused before write`.
  - `origin chat → ai_chat, mcp_api → mcp; ai_origin + intent_id stamped`.
  - `cross-org scope refused (single org)`.

  **Cancel:**
  - `cancel_sweep tier 2, refused for a restricted caller on another's sweep`.

  **Contract:**
  - `SAFE_WRITE_SITES entries added/re-pinned, including the two stale aiToolsSecurity keys`.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the B1 batch plus `actionIntents/effectDigestCoverage.contract.test.ts`, `actionIntents/approvalLabels.contract.test.ts`, `actionIntents/pinnedEffect*.test.ts`, `services/aiTools.userOwnedRelease.contract.test.ts` and `jobs/intentReleaseWorker*.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai): ioc_hunt sweep (single-org, four-eyes above 25, digest-pinned) and cancel_sweep (#6268)`.

### Task B3: `import_iocs` and the audit input summary

- [ ] **Step 1: Write the failing tests.**

  **Import:**
  - `imports via the extracted W04 service and returns the publish body`.
  - `auto_quarantine set → AI_IMPORT_AUTO_QUARANTINE_SET, checked under the set lock`.
  - `built-in → 403; partner-wide without canManagePartnerWidePolicies → 403; site ceiling → 403`.
  - `digest pins ruleSetId + currentVersion + iocDigest (required)`.

  **Audit summary:**
  - `generic ai.tool.ioc_hunt and mcp.tool.ioc_hunt rows carry iocs as { count, kinds }, never values`.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Extract `importIocsIntoSet(auth, setId, { label, iocs, severity? })` into `services/yaraIocImportService.ts`. `yaraIocImport.test.ts` passes with mocks only.
  - Move the W04 `site-ceiling-write-coverage` allowlist entry to the service file, with the same reason.
  - Add the input summarizer at the shared choke point, or create `services/aiToolAuditInput.ts` (W05-7).
  - Confirm `parkedFanout` needs no entry, because the service selects no devices.
- [ ] **Step 4: Run** the import route test, the tool test, `mcp-coverage`, both write-coverage walks, and the audit writer tests in `aiAgentSdk*.test.ts` and `mcpTier3Lifecycle*.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai): ioc_hunt import_iocs through the W04 importer; IOC values summarized in tool audit (#6268)`.

### Task B4: `security_scan scan` re-route, coverage flips, PR B

- [ ] **Step 1: Write the failing test:** `scan creates a security_scans row through startDeviceScan with aiOrigin and returns its id`.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `scan` → `startDeviceScan(auth, { deviceId, scanType: 'quick', mfaSatisfied: false, aiOrigin })`.
  - The other actions stay on `aiExecuteCommand`.
  - Update `aiTools.deviceWaitContext.contract.test.ts` `waitingActions` (`scan` no longer waits 60 s) and `aiTools.selfManagedHandlers.dbContext.test.ts`.
  - Coverage flips, per Gate B 7 defaults:
    - `security/sweeps.ts`, `security/yaraIocImport.ts` and `security/yara.ts` → `{ tools: ['ioc_hunt'] }`. The `yara.ts` reads are covered by `list_rule_sets`; rule CRUD stays UI-only (noted in the PR).
    - `security/yaraTest.ts` → `{ exempt: 'tool_in_later_wave', note: 'YARA sample test needs a file upload; no AI tool in W05 (#6268 Gate B 7).' }`.
- [ ] **Step 4: Run** the B1–B3 batches, tsc for api and web (exit codes), and the docs parity tests. Record the counts.
- [ ] **Step 5: Open PR B.**
  - Title: `feat(ai): YARA W05b — ioc_hunt tool (sweep, import IOCs), security_scan scan through the scan service (#6268)`.
  - Body: `Part of #6263`, `Refs #6268`, the index bytes (flag off and on), and MCP behaviour with intents off and on.
  - Run one review round and post the summary.

---

## PR C — web, docs, release-notes copy

Branch from `main` after PR B merges. PR C needs only PR A. If B stalls, C may follow A with Todd's say; the docs AI paragraph then waits for B.

### Task C1: Sweep API client and progress formatter

**Interfaces:**
- Client calls: `previewSweep`, `createSweep`, `listSweeps`, `getSweepGroup`, `cancelSweep`, `cancelSweepGroup`.
- Mutations go through `runAction`, with friendly copy for every W05-4/5/6 code.
- `describeSweepProgress(s: SweepSummary): { percent: number; label: string; tone: 'info' | 'success' | 'warning' }`:
  - `percent` = terminal ÷ targeted.
  - The tone is `warning` when `failed + expired + degraded > 0`, or when the state is `cancelled` or `expired`.

- [ ] **Step 1: Write the failing table test.** Cases: running, completed, completed with degraded, cancelled with remainder, expired, zero targeted.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/security/sweeps/sweepProgress.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test plus `src/lib/__tests__/no-silent-mutations.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): sweep API client and progress formatter (#6268)`.

### Task C2: "Sweep now" dialog

**Behaviour:**
- **The button.** `data-testid="rule-set-sweep-now"` on `RuleSetEditor`. It is disabled with a reason when the set is disabled or never published.
- **The dialog steps:**
  1. Scope: All reachable devices, Organizations, Sites, Device groups or Devices. Reuse the existing multi-select target picker; check the deployments or patch-job pickers first.
  2. Scan type, plus paths for custom scans.
  3. Duration: 24 h by default, 1–72 h.
  4. **Preview:** "N devices in M organizations", the rule-set versions, and the skipped reasons with counts and one-line explanations.
  5. **Confirm:** "Sweep N devices". It sends `previewDigest`.
- **Always shown:** "Sweeps only detect. Nothing is quarantined automatically."
- **Responses:**
  - `SWEEP_SCOPE_CHANGED` → show the new preview and ask again.
  - `MFA_REQUIRED` → the existing MFA prompt pattern.
  - `SWEEP_ALREADY_RUNNING` → a link to the existing sweep.
  - Success → `/security/scans#sweeps&group=<id>`.

- [ ] **Step 1: Write the failing tests:**
  - `disabled for unpublished set`.
  - `preview then confirm sends previewDigest`.
  - `scope changed re-previews`.
  - `already running links`.
  - `detect-only banner`.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): Sweep now on detection rule sets with preview-digest confirmation (#6268)`.

### Task C3: Sweeps tab, statuses, rule version

**Behaviour:**
- **Sweeps tab.** `#sweeps` becomes a third top-level tab. The selected group lives in `#sweeps&group=<id>`, held with `useHashState`.
- **List columns:** sets and versions, scope, a progress bar, degraded count, threats found, created by and at, and state.
  - Active sweeps get a Cancel button.
  - When a child failed with `rule_set_changed`, a "Sweep again with the current rules" action opens the dialog prefilled.
- **Scan history.** The `SecurityScanManager` status union gains `cancelled | expired`.
- **Threat panel.** `ThreatRulePanel` shows "Version {{version}}".

- [ ] **Step 1: Write the failing tests:**
  - `sweeps tab via hash; group survives reload`.
  - `cancel via runAction refreshes`.
  - `rule_set_changed offers re-sweep`.
  - `cancelled/expired render in history`.
  - `version shown only when present`.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `src/components/security` and the `no-hash-in-usestate` lint test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): Sweeps tab, cancelled/expired scan states, rule version on threats (#6268)`.

### Task C4: Locales, copy test, docs, release-notes copy

**Locale keys** (`security.json` ×8): `sweeps.*`, `securityScanManager.status.{cancelled,expired}` and `securityThreatDetail.rule.version`. The `yaraCopyRule.test.ts` prefixes gain `security:sweeps.` and the two status keys.

**Docs** (`features/security.mdx`): a new "IOC sweeps" section after "The IOC Scans Page". It covers:
- what a sweep is;
- that it is detect-only, with no Defender scan;
- scope and eligibility, with each skip reason;
- the preview and its confirmation;
- MFA above 50 devices: what "satisfied" means, and that API keys are refused above 50;
- pinned rule versions, and what "rules changed during the sweep" means;
- duration and expiry, and that offline devices run when they return within it;
- pacing in plain words: one scan per device, plus organization and partner limits;
- cancel: queued scans stop and delivered scans finish;
- re-running;
- degraded coverage;
- AI: `ioc_hunt`, an approval to start a sweep, a second approver above 25 devices, one organization per AI sweep, and IOC import;
- the audit events.

Also add API reference rows for the routes, and "Version N" under Threat Detection.

**Release notes** (`docs/release-notes/next-release-draft.md`):
- **Features / API:** "IOC sweeps (#6268)": routes, `ioc_hunt`, detect-only, and the `SECURITY_SWEEP_*` / `IOC_HUNT_*` env vars with their defaults.
  - Also note the throttle-retry fix: scheduled scans that were throttled were previously never retried.
  - Also note that the AI `security_scan` `scan` now records a scan row.
- **Migrations:** `2027-01-04-140000-security-scan-sweeps.sql` creates a table, adds three nullable columns to `security_scans` (metadata-only, no rewrite), and adds one partial index on `sweep_id IS NOT NULL`, which is empty at upgrade.
- §11 copy throughout.

- [ ] **Step 1: Extend `yaraCopyRule.test.ts`** and add one en key without the other locales.
- [ ] **Step 2: Run** `npx vitest run src/locales/yaraCopyRule.test.ts src/lib/i18n/localeParity.test.ts`. Expected: FAIL.
- [ ] **Step 3: Add** all keys in all 8 locales, then write the docs and the release-notes entries. Then run `grep -n -i -E "\bEDR\b|antivirus|real-time protection|prevention"` over the new docs section. Expected: no hits.
- [ ] **Step 4: Run:**
  - the two tests;
  - `src/lib/i18n`;
  - `src/locales/humanizedKeyRegression.test.ts` (update `humanizedKeyBaseline.json` only if the test requires it);
  - web tsc (exit code);
  - `pnpm exec astro check`.

  Expected: PASS.
- [ ] **Step 5: Commit** `docs(security): IOC sweeps docs, locales and release-notes copy (#6268)`.

### Task C5: Browser and agent smoke, PR C

- [ ] **Step 1: Set up** a per-worktree stack using the `worktree-stack` skill: copy the root `.env` with AI keys blanked, set `BREEZE_WORKSPACE_ENABLED=false`, and use a free subnet. Enrol one agent ≥ 0.124.0 on a lab VM. Never use a host running the installed agent.
- [ ] **Step 2: Walk through the smoke:**
  1. Create a set with an EICAR-hash IOC.
  2. Sweep one device.
  3. Confirm the sweep reaches completed.
  4. Confirm the threat shows "Version N".
  5. Re-sweep. Expected: `SWEEP_ALREADY_RUNNING` while active, a new sweep after completion.
  6. Republish the set mid-sweep against a second, offline device. Expected: `rule_set_changed`.
  7. Cancel an active sweep that targets an offline device.

  With no agent, run steps 1, 2 and 7 and record the agent leg as owed.
- [ ] **Step 3: Run** `pnpm wt-stack down` and report what was left running.
- [ ] **Step 4: Open PR C.**
  - Title: `feat(security): YARA W05c — Sweep now, Sweeps tab, docs and release copy (#6268)`.
  - Body: `Part of #6263`, `Closes #6268`, and the smoke result.
  - Run one review round and post the summary.

---

## Contract tests and CI jobs that fire

| Suite | PR | Why |
|---|---|---|
| `rls-coverage` (strict) | A | new shape-1 table |
| `tenant-export-policy`, `tenantCascade*`, org-merge registry | A | new table + 3 columns |
| `moveOrg.coverage`, `cascadeDelete`, mover tests | A | `security_scans` columns + mover detach |
| `parkedFanout.contract` | A | new selectors; guard counts |
| `mcp-coverage` | A, B | new route module; flips |
| `partner-wide-write-coverage`, `site-ceiling-write-coverage` | A, B | sweep service; import service move |
| `workerRegistry`, `commandTimeouts` | A | new job name; command lifecycle |
| `integration-suite-coverage` | A | new integration file |
| `aiToolIndex` (both flag states), `descriptionBudget`, `deviceArgsCoverage`, `aiToolsSiteScope`, registry/permissions/handler parity, `tierConfig` + `ai.mdx` parity, `approvalScope`, `approvalLabels`, `effectDigestCoverage`, pinned-effect policy, `userOwnedRelease` (`SAFE_WRITE_SITES`), `mcpServer` effective-tier/stateless/conformance, `agentToolCatalog` | B | new AI tool |
| `no-silent-mutations`, `no-hash-in-usestate`, `localeParity`, `yaraCopyRule`, `humanizedKeyRegression` | C | web |
| Test Agent, `pack.lock`, `yara-pack-fp` | — | untouched, must stay green |

## Exit checklist

- [ ] One migration; slot recorded; `db:check-drift` clean; RLS in the same file; four registrations; new `security_scans` columns classified; mover detach.
- [ ] `git diff origin/main --stat -- agent/` is empty in all three PRs.
- [ ] No sweep scan goes out with `autoQuarantine` or `triggerDefender` true, with a partial set, with an unpinned version, or as a legacy scan.
- [ ] Claim: caps are counted and claimed under the partner lock; the command is inserted in the claim transaction; `command_id` is stored; the throttle retries.
- [ ] Every YARA dispatch stamps `dispatched_rule_sets`. Threats carry `ruleSetVersion`, bound through the command's scan id.
- [ ] tsc exit 0 for api, shared and web. Integration and race suites are green, with counts.
- [ ] Index bytes recorded for both flag states. The ceiling was not raised without Todd.
- [ ] IOC values are never in audit rows.
- [ ] 8 locales; no §11 banned word.
- [ ] One review round per PR, summary posted.

## Deferred

- **Cross-batch IOC dedupe** for partial overlap (W04 deferred). Still needs an IOC table or stored-rule parsing.
- **W03 `validate` sandboxing** (Landlock + `oom_score_adj` for `breeze-yarac validate`, W04 deferred). A W03 follow-up issue; the orchestrator decides whether to file it.
- **Single-rule create cap race.** Fixed by #9497.
- **Agent cache-first bundle fetch.** Look up the compiled cache by the pinned sha before the GET, or send `If-None-Match`. This is agent-shipped and needs a lab leg. Sweep egress for the built-in pack is bounded by the pump meanwhile.
- **Server execution timeout for `security_scan`.** It is 30 min (`commandTimeouts.ts` `MEDIUM_TIMEOUT_TYPES`) while scans run up to 720 min, and late results are accepted. Making it follow `timeoutMinutes` is a command-lifecycle change worth its own issue. W05 avoids it by finalizing on its own clock.
- **Manual single-device scans bypass the dispatch caps** (W01 as built), and non-sweep `running` scans are never finalized. Follow-up issues.
- **AI rule-set and rule CRUD, AI sample test.** UI-only by Gate B 7.
- **Multi-org AI sweeps.** These need multi-org release authority in the intent layer.
- **A by-sweep scan list route.** The tab shows counts and links to scan history.
- **Sweep reports, exports, and scheduled hunts.**
- **Playwright E2E** for Detection rules and Sweeps.

## Gate B — decisions for Todd

Each bracketed default is what this plan is written to, and changes in one place.

1. **Sweep record.** Default: a new per-org table `security_scan_sweeps` (shape 1, `org_id NOT NULL`, execution record), plus `security_scans.sweep_id` / `dispatched_rule_sets` / `command_id`. The alternative, no table, was rejected (W05-1).
2. **Human sweeps.** Default: a direct action with a preview-digest confirmation, and MFA above 50 devices (API keys refused above 50). No four-eyes. The alternative is in-app intents with four-eyes above N.
3. **Spec §7 scope "devices covered by the policies that attach the set".** Default: not offered. All reachable devices, org, site, group or device lists, gated by set eligibility. *Codex: a genuine spec change, so it is listed here and was not silently made.*
4. **AI surface.** Default: a new base-Tier-1 tool, `ioc_hunt`. The spec's literal "security_scan gains sweep and list_rule_sets" would make reads Tier 3 over MCP and share the 3-per-10-minute limiter.
5. **Prompt budget.** Default: measure both flag states. If the ceiling on main is broken, stop and ask for +128 B.
6. **AI approval scope.** Default: four-eyes above 25 expected devices, supervised at or below. The alternative is always four-eyes.
7. **MCP coverage rescope.** Default: AI rule-set and rule CRUD plus the sample test stay UI-only. `yara.ts` is covered by `ioc_hunt` reads; `yaraTest.ts` keeps a `tool_in_later_wave` note. The alternatives are a CRUD action set in `ioc_hunt`, or a new human-only `McpExemptReason`. *Codex flagged that W04's coverage notes promised CRUD in W05.*
8. **AI `import_iocs` into a set with `auto_quarantine` on.** Default: refused. The alternative is allowing it as four-eyes.
9. **Rule content during a sweep.** Default: pin `{id, version, sha256}` at create; a republished set fails the remaining scans as `rule_set_changed` and offers a re-sweep. *Adopted from Codex over my "current version at claim" position.* The alternative is the current version at claim, recorded per scan.
10. **AI agents.** Default: `ioc_hunt` is in no agent catalog in W05, so agents cannot start sweeps or import IOCs.
11. **Duration and caps.** Defaults: 24 h (1–72 h); 10,000 devices per request; 5 active sweeps per org; 200 running per partner; 100 admitted per sweep per org per tick; 10 creates per user per hour.
12. **Throttle-retry defect.** Default: fix it in PR A, because sweeps and scheduled scans share the dispatch path. The alternative is a separate issue, with sweeps relying on the pump only.

## Quorum record

**2026-10-24.** The Claude position (P1–P14) was critiqued by Codex `gpt-6-astra`, `model_reasoning_effort="xhigh"`, `-s read-only`, against `53afe2c5dd`. Codex confirmed facts F1–F9, with additions: the MCP tier floor; 168 h is configurable. Every adopted finding below was re-checked against the cited file before adoption.

| Position | Codex | Resolution |
|---|---|---|
| P1 table + plain FK | **DISAGREE** on the move handling | **Adopted.** The mover detaches sweep scans before the restamp, and every reader checks org equality. Added `dedupe_key` persistence, `command_id`, and stored completion. The trigger was not modified: the mover runs first, and readers are the backstop for any trigger-only path. |
| P2 DB-as-queue pump | AGREE-WITH-CHANGES | **Adopted.** Claims serialize under a partner advisory lock. The pump is single-flight. Sweep-queued rows are excluded from scheduler backpressure and busy checks. The command is inserted in the claim transaction with deferred delivery. **Found:** the existing throttle never retries (self-reuse of its active job). Fixed in A5 (Gate B 12). |
| P3 dispatch | AGREE-WITH-CHANGES | **Adopted.** `triggerDefender: false`; all pinned sets or fail; `expectedOrgId` = the sweep's org; pinned versions carried through delayed dispatch (Gate B 9). |
| P4 fetch auth | AGREE-WITH-CHANGES | **Adopted.** Authorization comes from the running scan's exact dispatched `{id, version}`, independent of sweep state, so a cancel during the 5-minute load does not break a started scan. |
| P5 expiry and finalize | **DISAGREE** | **Adopted.** Lookup by `command_id` (payload is erased on cancel). The command's 30-minute server timeout is not used; finalize uses the 720-minute ceiling plus grace. Undelivered commands are cancelled on cancel and expiry, serialized against the claim. Late results are preserved. |
| P6 dedupe | AGREE-WITH-CHANGES | **Adopted.** Canonical key including pin shas; `expires_at > now`; per-org advisory lock. |
| P7 scope | AGREE-WITH-CHANGES | **Adopted.** Per-target-org permission resolution; `allowedDeviceIds` as well as sites; ceilings on preview, list, progress, cancel and approval; recheck at dispatch. The policy-coverage scope removal is surfaced as Gate B 3. |
| P8 caps | AGREE-WITH-CHANGES | **Adopted.** Stored `completed` state, so finished sweeps do not hold the active cap; the cap check is atomic with admission. |
| P9 operator confirm | AGREE-WITH-CHANGES | **Adopted.** `previewDigest` is consumed on create. The MFA meaning is documented. API keys are refused above 50. AI and MCP are governed by intent approval. |
| P10 AI tool | AGREE-WITH-CHANGES (substantial) | **Adopted.** AI sweeps are single-org (released auth holds only `intent.orgId`). Not agent-mintable, so the partner-axis approver substitution is not reached (Gate B 10). The digest pins a caller-computed `previewDigest` and is mandatory; the handler re-proves it under the rebuilt auth. `ai_origin` and the remote-tools policy are carried through the pump. Import keeps the W04 gates and checks auto-quarantine under the lock. |
| P11 audit | AGREE-WITH-CHANGES | **Adopted.** The real principal is attributed. The retention wording is corrected (365 days only when a policy row exists). IOC values are summarized out of the generic tool audit. |
| P12 version at detection | AGREE-WITH-CHANGES | **Adopted.** Bound to the command's own scan id; versions only for matching refs. |
| P13 no agent change | AGREE | Degraded coverage surfaced as `progress.degraded`. |
| P14 PR split | AGREE-WITH-CHANGES | **Adopted.** PR A carries the scope, version, origin and command contracts; the status enum and copy prefixes are extended. W04's promised CRUD/test in W05 is explicitly rescoped as Gate B 7. |

**Open disagreements:** none silently resolved. Gate B items 3, 7 and 9 record the three places where Codex and the original position differed on product scope; the plan is written to the stricter default in each.
