# S0 and Fleet-Integrity Remediation Program Design

**Date:** 2026-08-24
**Status:** approved
**Baseline:** `80b498ecee73bb1c3f5f58e47dce65a016dc892c`
**Revised:** 2026-08-24 — current-state corrections, confirmed-defect anchors and registration contracts added after verifying the design against the baseline code
**Findings:** RMM-QA-012, 020, 038, 039, 099, 105, 134, 212, 225, 297, 319, 333, 445

## Objective

Close the four S0 contracts and nine fleet-integrity defects without requiring an atomic upgrade of the hosted fleet. The implementation must preserve tenant and site isolation, distinguish requested, admitted, delivered, applied and terminal state, and keep older agents compatible while new protocols are introduced.

This design authorizes implementation and local/candidate verification. It does not authorize a production deployment, customer-device rollout, destructive production migration, or closure of a finding without its required environment evidence.

## Approved product and security decisions

1. Partner-wide automations may reference partner-owned or explicitly global resources. They may not borrow organization-owned resources. Organization automations may reference same-organization resources, explicitly shareable resources owned by their partner, or explicitly global resources.
2. A cross-site restore requires authorization to both source and target sites plus a new explicit `backup:cross_site_restore` permission. Same-organization membership or access to both sites does not implicitly grant this operation.
3. PAM cleanup latency is measured from the agent's durable `cleanup_received` acknowledgement. The acceptance target is 2 seconds p95 and 5 seconds maximum.
4. Reachability and agent self-health are separate state axes. A connected agent is not implicitly healthy, and an unhealthy agent is not implicitly offline.
5. New server-to-agent behavior is additive and capability-negotiated. An older agent never receives a command or payload it cannot enforce safely.

## Program structure

The work ships as five independently reviewable and reversible tracks. Each track may contain multiple checkpoint commits, but no track depends on partially deployed behavior from a later track.

### Track A: authorization boundaries

Closes RMM-QA-099 and RMM-QA-134.

#### Automation reference ownership

Add one shared resolver that is used during standalone automation create/update, configuration-policy automation linking, run admission and final dispatch:

```ts
type AutomationReferenceOwner =
  | { scope: 'organization'; orgId: string; partnerId: string }
  | { scope: 'partner'; orgId: null; partnerId: string };

async function resolveOwnedAutomationReferences(
  tx: DbTransaction,
  owner: AutomationReferenceOwner,
  targetOrgIds: readonly string[],
  actions: readonly NormalizedAutomationAction[],
  notificationTargets: readonly string[],
): Promise<ResolvedAutomationReferences>;
```

The resolver loads scripts, software catalogs, selected software versions and notification channels with identifier and ownership predicates in the same query. It returns the loaded rows consumed by dispatch; callers do not repeat a bare-ID lookup.

Ownership predicates are per-table, not uniform. `automations`, `software_catalog`, `software_policies` and `notification_channels` enforce `org_id XOR partner_id`; `scripts`, `script_categories` and `alert_templates` instead carry a `partner_id` denormalized from the owning organization (`2026-06-13-catalog-partner-axis-rls.sql`), so an org-owned script has **both** axes set. A partner-wide owner must therefore match scripts on `org_id IS NULL AND partner_id = :partnerId`, or on `is_system` — never on `partner_id` alone, which silently admits org-owned scripts. `scripts.is_system` is the only recognized global flag; `alert_templates.is_built_in` is not an ownership axis (org-owned rows carry it) and must not be treated as global.

Unknown, deleted, moved, malformed, foreign or ownership-changed resources fail before an automation run, child execution, deployment, command, queue entry, provider call or success audit is created. Software-version ownership is derived through and pinned to its catalog.

Existing automations receive normalized resource-binding rows with expected resource type and owner axes. A backfill marks valid bindings active and quarantines invalid bindings with a stable reason. Quarantined automation cannot execute. The new admission path is enabled only after the backfill completes.

#### Resilience source/target site authorization

Add one shared resolver used by Hyper-V, MSSQL, snapshot, VM restore, instant boot, BMR token, recovery-media and boot-media routes and workers:

```ts
type ResilienceResourceRef = {
  kind: 'device' | 'vm' | 'sql_instance' | 'backup_chain' | 'snapshot'
    | 'recovery_token' | 'media_artifact' | 'boot_media_artifact' | 'restore_job';
  id: string;
  role: 'source' | 'target';
};

async function authorizeResilienceResources(input: {
  orgId: string;
  principal: AuthorizationPrincipal;
  refs: readonly ResilienceResourceRef[];
  operation: 'read' | 'restore' | 'verify' | 'token' | 'media' | 'revoke';
}): Promise<AuthorizedResilienceResources>;
```

The resolver first loads only organization, device and site identity. It performs no metadata, secret, storage, provider or command work before authorization. A site-restricted principal must be authorized for every resolved site. Missing device/site lineage fails closed. A restore with different source and target sites additionally requires `backup:cross_site_restore`.

Async jobs persist the initiating authorization subject and grant revision. Workers reload that subject and re-run the same authorization contract immediately before provider, queue or command side effects. Legacy queued jobs without a recoverable subject are quarantined rather than executed.

The resolver replaces the per-route `isDeviceSiteDenied` / `resolveSiteAllowedDeviceIds` helpers duplicated across `routes/backup/{restore,vmrestore,hyperv,mssql,bmr}.ts`; the existing `requireSiteAccess` middleware is used only by `software.ts` today. Two confirmed defects anchor the acceptance tests: the restore path site-checks only the **target** device and never the snapshot's source-device site (`restore.ts:188-232`, so a site-A-restricted user can restore a site-B snapshot today), and the restore-cancel check passes a device ID where a site ID is expected (`restore.ts:417` — fails closed, but on the wrong condition). Site restriction currently exists only on organization-scope tokens (`allowedSiteIds` is undefined for partner/system principals); the resolver contract states explicitly which principal kinds are site-restricted instead of inferring it from field presence.

`backup:cross_site_restore` is a new permission and must be registered in all six places: `PERMISSION_GRANTS` (`packages/shared/src/constants/permissions.ts`), `DEFAULT_PERMISSIONS` and the `SYSTEM_ROLES` grant lists (`apps/api/src/db/seed.ts`), `ACTION_LABELS` (`routes/permissionsCatalog.ts` — `RESOURCE_LABELS` already has `backup`), an insert migration for `permissions`/`role_permissions` (pattern: `2026-08-11-variables-permissions.sql`), and the `seed.test.ts` parity assertions.

### Track B: fleet and execution truth

Closes RMM-QA-012, RMM-QA-039, RMM-QA-105, RMM-QA-212, RMM-QA-297 and RMM-QA-319.

#### Reusable server-backed device selector

Introduce one site-authorized selector endpoint and web hook:

```http
GET /devices/options?search=&cursor=&limit=50&status=&siteId=&osType=&includeIds=
```

```ts
type DeviceOptionPage = {
  data: Array<{
    id: string;
    hostname: string;
    displayName: string | null;
    osType: string;
    status: string;
    siteId: string | null;
    siteName: string | null;
  }>;
  page: {
    nextCursor: string | null;
    returned: number;
    total: number;
    hasMore: boolean;
    observedAt: string;
  };
};
```

Search, filtering, sorting and authorization are server-owned. `includeIds` preserves labels for already-selected off-page values. The shared web hook exposes loading, ready, empty, error, stale and truncated states. A supporting-scope error, stale response or unresolved truncation prevents submission.

All affected remote, device-group, alert, script and network selectors migrate to this contract without absorbing unrelated Device Groups persistence work.

The endpoint mounts as its own sub-router **before** `coreRoutes` in `routes/devices/index.ts` — otherwise `/options` is eaten by the `GET /:id` matcher — and ships a `.mountorder.test.ts` following the existing convention (`customFieldValues.mountorder.test.ts`). Migration targets are the shared `DeviceTargetSelector` (today `fetchWithAuth('/devices')` with pure client-side substring filtering) plus the ad-hoc dropdown fetches in the scripts, alerts, remote, DR, patch, backup, ticket, baseline and discovery components; `ScriptsPage`'s `'/devices?limit=10000'` is the worst offender.

#### Reachability and self-health

Enrollment and re-enrollment use the existing `pending` device status (today written only by the pre-provision route). This changes current behavior: both the re-enroll UPDATE branch and the fresh-row INSERT branch in `routes/agents/enrollment.ts` unconditionally set `status = 'online'` and advance `lastSeenAt`. After this track, a new enrollment has `lastSeenAt = null`; re-enrollment preserves the last real heartbeat time and does not advance it. Only an authenticated main-agent heartbeat changes pending/offline to online. The stale `DEVICE_STATUSES` constant in `packages/shared/src/constants/index.ts` (missing `updating` and `pending`) is corrected in the same change.

Self-health is an independent, versioned observation:

```ts
type AgentHealthObservation = {
  schemaVersion: 1;
  deviceId: string;
  agentVersion: string;
  overall: 'healthy' | 'warning' | 'error' | 'unknown';
  metricsAvailable: boolean | null;
  components: Record<string, { state: 'healthy' | 'warning' | 'error' | 'unknown'; reason?: string }>;
  observedAt: string;
};
```

The API records immutable tenant-scoped health observations with server receipt time and an indexed latest-observation projection. Older agents may omit this field: they remain reachable through heartbeat, while health is `unknown`. Health never overwrites `devices.status`.

#### Script admission and automation terminal results

The canonical script-execution response becomes a typed admission result:

```ts
type ScriptAdmissionResult = {
  requestId: string;
  status: 'queued' | 'partially_queued' | 'rejected';
  targets: Array<{
    requestedDeviceId: string;
    admission: 'admitted' | 'excluded' | 'suppressed' | 'denied';
    reasonCode?: string;
    executionId?: string;
    commandId?: string;
    batchId?: string;
  }>;
};
```

The modal callback returns this value instead of `Promise<void>`. The UI renders queued/admitted state separately from terminal success and preserves per-device rejection reasons.

Automation gains durable action-result rows unique on `(run_id, device_id, action_index)`. Script, raw-command and software actions remain nonterminal after dispatch. Script-result, command-result, deployment-result, timeout, cancellation and reaper paths update the rows idempotently. Device and run aggregates are derived from child terminal states; a parent cannot become successful while an admitted child is nonterminal.

#### Versioned software-inventory evidence

Current state: `PUT /agents/:id/software` is an unconditional wipe-and-reinsert; an empty `software` array (accepted by the validator) deletes every inventory row for the device (`routes/agents/inventory.ts:163-186`) and leaves `device_vulnerabilities` rows NULL-linked, after which fleet aggregation misclassifies them as OS findings until the next correlation run.

Inventory reports include an observation identity and completeness contract:

```ts
type SoftwareInventoryObservation = {
  schemaVersion: 2;
  observationId: string;
  collectorVersion: string;
  observedAt: string;
  completeness: 'complete' | 'partial' | 'failed';
  expectedSources: string[];
  succeededSources: string[];
  failedSources: Array<{ source: string; code: string }>;
  truncated: boolean;
  itemCount: number;
  items: SoftwareInventoryItem[];
};
```

Incomplete, failed, truncated or implausibly collapsed observations are retained as evidence but do not replace the last-known-good inventory. A vulnerability may resolve by absence only from a fresh accepted complete observation and records the resolving observation ID. Legacy reports may refresh legacy-visible inventory but cannot resolve a finding by absence; legacy empty reports retain the previous inventory.

### Track C: production operations

Closes RMM-QA-020 and RMM-QA-038.

#### Continuous readiness

The API already serves `/ready` from a live, TTL-cached, single-flighted readiness evaluator (`services/readiness.ts`, #2974) fed by a per-worker boolean map. This track extends that evaluator into the full registry rather than introducing a parallel endpoint: every required worker reports its running state, Redis connection state, transition time, last successful job and last error. `/ready` returns 503 when the database, required Redis connection or any required consumer is not currently runnable. Missing expected registry entries fail closed. The separate `/health/ready` implementation (bare DB `select 1` + Redis ping, no worker or shutdown awareness) is consolidated onto the same evaluator so the two cannot diverge.

`/health` remains process liveness. Container readiness checks and post-deploy admission checks use `/ready`; restart/liveness semantics continue to use `/health`. Compose healthchecks currently probe `/health` in both the tracked compose files and the hand-maintained droplet compose, so the switch requires explicit healthcheck edits in the repo files and in `/opt/breeze/docker-compose.yml` on each droplet at rollout, with `start_period` sized so a booting API legitimately returning 503 is not cycled by the restart policy.

#### Bounded offline processing

This extends the existing `jobs/offlineDetector.ts`, which is already a keyset-cursor chunked scan (default cap 5,000 devices per run, 500 per chunk) that enqueues per-device `mark-offline` jobs, re-checks the stale predicate before each UPDATE, and wraps each page read in a short system-context statement. Keep database reads and writes inside short system-context statements. Queue publication, event emission and alert work remain outside the database context.

The deltas are: durable cross-run cursor continuation (the current per-run cap silently truncates a backlog larger than one sweep), deterministic transition IDs derived from device identity and observed `lastSeenAt` (mark jobs are not identity-keyed today, so duplicate sweeps can double-enqueue), and drain throughput sized so 10,000 stale devices complete within the existing 30-second schedule without an unbounded transaction or loop. Duplicate sweeps are idempotent, a worker restart resumes its continuation, and a device that reconnects before compare-and-set transition remains online.

### Track D: versioned agent control protocols

Closes RMM-QA-225 and RMM-QA-333.

#### Peripheral effective-policy sets

Current state: the distributor ships every active policy for the org to every eligible device ordered only by `updatedAt`, and the agent applies first-match-wins in list order with `targetIds` never consulted (`jobs/peripheralJobs.ts`, `agent/internal/peripheral/evaluate.go`) — a device-level policy does not beat an org-level one, and nothing on the wire is monotonic or content-addressed.

The server resolves the winning per-device policy set. `peripheral_policies` is already dual-ownership (`org_id XOR partner_id`), so precedence must rank the ownership axis too. Deterministic precedence is:

1. device target over group over site over organization-wide; an organization-owned policy over the owning partner's partner-wide policy;
2. exact device class over an umbrella class;
3. numeric priority ascending;
4. restrictive tie-break: block, read-only, alert, allow;
5. policy UUID ascending.

The version-2 envelope binds schema version, device/org/site/group target identity, monotonic revision, content digest, generation time, reason and the effective policies. The agent rejects wrong identity, lower revision, malformed digest, or the same revision with a different digest. Matching revision/digest is idempotent success. An empty set explicitly removes previous enforcement.

Desired and applied revision/digest plus requested/applied/rejected evidence are durable. Policy and membership mutations enqueue old-union-new affected devices through a device-keyed coalescing queue, with periodic reconciliation as a backstop. Partner-wide rows fan out by the device organization's partner — never by `org_id` equality alone, which silently no-ops on `org_id NULL` — and the distributor resolves policy sets in a system database context so partner-wide rows remain visible on agent paths (the #1105 heartbeat probe-config pattern).

Legacy peripheral enforcement is cleared and acknowledged before enabling version 2. A device that does not report the version-2 capability receives no version-2 enforcement.

#### Signed production rollback

Rollback is a separate protocol, not a relaxation of the normal upgrade downgrade guard. A directive binds rollback identity, current and target version, component versions, signed manifest, artifact digests, reason, authorizer, approval time and expiry.

Creation requires a dedicated rollback permission, step-up MFA, a signed target, and an N-to-N-1 transition. The agent advertises `rollbackProtocolVersion = 1` and records download, verification, staging, swap, restart, health, failure and recovery phases. Invalid, expired, replayed, wrong-device, wrong-current-version or incorrectly signed directives fail closed. Older agents retain ordinary upgrade/pin behavior and never receive rollback directives.

### Track E: PAM lifetime and cleanup

Closes RMM-QA-445 while establishing the shared foundation required by the adjacent PAM convergence, readiness, audit and idempotency findings.

Current state: no agent cleanup command exists at all — PAM expiry is a server-side status UPDATE only (`jobs/pamJobs.ts`), actuation is a CAS from `approved` to `actuating` plus a `device_commands` insert, and the only durable trace is an `elevation_audit` row. `pam_actuations` is a new table, not a retrofit; the request/session state it tracks lives today in `elevation_requests`/`elevation_audit` (`schema/elevations.ts`).

Each approved request revision creates one durable `pam_actuations` identity with monotonic generation, desired state (`active` or `cleanup`) and observed lifecycle state. Approval plus the actuation row and outbox command commit atomically; the outbox reuses the `intent_outbox` transactional-outbox pattern (`schema/actionIntents.ts`) rather than introducing a second outbox shape. Deny, revoke, expiry, policy removal, approval failure and entitlement removal atomically set cleanup intent and enqueue an idempotent cleanup generation.

Version-2 apply and cleanup commands bind actuation, generation, request, device and organization identity. Apply additionally binds target path/hash, subject identity, expiry, server time and maximum remaining lifetime. Results bind actuation/generation and report received, verified-active, cleaned or failed plus boot, Windows session, PID/process creation, Job Object, account and observation evidence. A cleanup generation is an irreversible tombstone; delayed older apply commands are rejected.

On Windows the agent creates the elevated target suspended, attaches the entire process tree to a named Job Object configured to terminate members when closed, and resumes only after successful attachment. The long-lived actuation manager retains or reopens the revocable primitive. Cleanup terminates the job, waits for zero members, demotes/disables and rotates the local account, verifies no matching privileged process/token remains, then acknowledges cleaned. Restart and reboot reconcile persisted desired state. Missing helper support or inability to verify dismissal/cleanup is failure, never success.

Legacy request status remains for compatibility, but endpoint enforcement status is exposed separately. Session end and terminal audit advance only from a persisted cleaned result. Offline cleanup remains queued and is not called revoked-at-endpoint. A synchronous revoke returns terminal success only after cleaned; otherwise it returns accepted/pending state.

Existing active or actuating legacy requests are marked `legacy_untracked`. They are never backfilled as cleaned. PAM remains disabled for those endpoints until cleanup and account state have been independently verified.

## Data and migration rules

All new tenant tables use the repository's required ownership shape, enable and force RLS in the creation migration, and are registered in organization/device cascade and export-policy registries as applicable. Open JSON evidence is classified `excludedOpen` in tenant export policy. Append-only event ledgers receive the required audit-admin deletion handling.

Migrations are additive, idempotent, ordered after shipped migrations and never edit a shipped migration. Large backfills are bounded and report affected/quarantined row counts. Server code tolerating old rows and payloads deploys before any producer emits new versions.

Two additional cross-cutting rules:

- **FK lock ordering on hot agent-write tables.** Inserts that FK to `devices` take `FOR KEY SHARE` on the device row; enrollment/re-enrollment updates on that same row have deadlocked with concurrent agent writers before (40P01 — #3739, PR #3911). The new agent-write tables (health observations, inventory observations, actuation results) keep their device-FK inserts in short transactions and never interleave a `devices`-row update inside the same transaction as a child insert.
- **No epoch-aligned repeatable jobs.** BullMQ `repeat: { every }` schedules align to the epoch, so identical intervals all fire simultaneously (the 00:00 UTC stampede). The coalescing queue's reconciliation backstop and any new periodic sweep use offset or jittered schedules.

## Failure behavior

- Authorization uncertainty fails before side effects.
- Unknown agent capability prevents new-protocol command admission.
- Lost, duplicated, delayed or reordered commands reconcile through identity, generation and compare-and-set state.
- Partial observations remain visible as partial and cannot erase last-known-good truth.
- Admission is never rendered as terminal success.
- Cleanup and disable paths remain enabled when new admission is disabled.
- A rollout pause does not strand already-issued cleanup or reconciliation work.

## Testing and evidence

Every behavior change follows red-green-refactor: its acceptance test is written and observed failing before production code changes.

Required automated evidence includes:

- real-Postgres two-partner/two-organization/two-site authorization matrices with known valid foreign IDs and zero-side-effect assertions;
- API route, worker/retry, webhook, API-key, service-principal and AI entry-point coverage for authorization contracts;
- selector fixtures from 0 through 10,000 devices, including early/middle/final matches and stale-scope response races;
- script/automation admission, delivery, terminal, timeout, cancellation, duplicate and out-of-order result matrices;
- Go race tests for agent state managers and table/property tests for precedence and generation rules;
- 10,000-device offline drain with database-pool and queue headroom measurements;
- old-agent omission tests for every additive heartbeat capability;
- signed rollback interruption tests across download, verify, stage, swap, restart and health phases;
- disposable Windows PAM tests covering normal cleanup, child processes, offline/reconnect, duplicate/reordered commands, helper loss, agent crash/restart and endpoint reboot.

Integration suites must live in the directories the integration vitest config actually discovers, and their `runIf` guards skip silently — for every new integration suite, the evidence includes the CI shard log line proving it executed, not just a green job.

The implementation can be code-complete without every environment packet, but a finding remains fixed-unverified until its required real database, 10,000-device, cross-platform or Windows evidence passes against the exact candidate and shipping artifacts.

## Rollout strategy

1. Land additive schemas, tolerant parsers and observability with new behavior disabled.
2. Land server-only authorization, selector, admission and readiness behavior.
3. Dual-write new truth rows while existing readers continue to function; reconcile/backfill and quarantine invalid legacy state.
4. Ship inert agent capabilities and observe capability telemetry.
5. Enable new protocols for internal devices, then small hosted canaries, then progressively larger cohorts only after explicit deployment authorization.
6. Remove legacy distributors/readers only after fleet convergence and a tested rollback.

Peripheral rollout uses 5, then 25, then 100 devices before the remainder. PAM remains lab-only until restart/reboot cases and the 5-second cleanup maximum pass, then uses 5 and 25 device canaries. Any foreign-scope rejection, digest equivocation, cleanup timeout, unverified enforcement, legacy command claim or material queue backlog pauses expansion automatically.

## Review and completion boundary

The combined branch receives one independent whole-branch review, matching repository review-rigor rules. Review fixes use targeted tests; re-review occurs only when a fix itself changes tenant authorization, migration, concurrency or shipped-agent behavior.

No code path is called fixed merely because its unit tests pass. Closure requires the relevant acceptance contract, zero-side-effect proof and exact-candidate environment evidence described above.
