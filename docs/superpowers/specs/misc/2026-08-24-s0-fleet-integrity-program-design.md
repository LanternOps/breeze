# S0 and Fleet-Integrity Remediation Program Design

**Date:** 2026-08-24  
**Status:** approved  
**Baseline:** `80b498ecee73bb1c3f5f58e47dce65a016dc892c`  
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

#### Reachability and self-health

Enrollment and re-enrollment use the existing `pending` device status. A new enrollment has `lastSeenAt = null`; re-enrollment preserves the last real heartbeat time and does not advance it. Only an authenticated main-agent heartbeat changes pending/offline to online.

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

Replace startup worker booleans with a live registry. Every required worker reports its running state, Redis connection state, transition time, last successful job and last error. `/ready` returns 503 when the database, required Redis connection or any required consumer is not currently runnable. Missing expected registry entries fail closed.

`/health` remains process liveness. Container readiness checks and post-deploy admission checks use `/ready`; restart/liveness semantics continue to use `/health`.

#### Bounded offline processing

Keep database reads and writes inside short system-context statements. Use durable cursor continuation jobs and deterministic transition IDs derived from device identity and observed `lastSeenAt`. Queue publication, event emission and alert work remain outside the database context.

The pipeline drains 10,000 stale devices within the existing 30-second schedule without an unbounded transaction or loop. Duplicate sweeps are idempotent, a worker restart resumes its continuation, and a device that reconnects before compare-and-set transition remains online.

### Track D: versioned agent control protocols

Closes RMM-QA-225 and RMM-QA-333.

#### Peripheral effective-policy sets

The server resolves the winning per-device policy set. Deterministic precedence is:

1. device target over group over site over organization;
2. exact device class over an umbrella class;
3. numeric priority ascending;
4. restrictive tie-break: block, read-only, alert, allow;
5. policy UUID ascending.

The version-2 envelope binds schema version, device/org/site/group target identity, monotonic revision, content digest, generation time, reason and the effective policies. The agent rejects wrong identity, lower revision, malformed digest, or the same revision with a different digest. Matching revision/digest is idempotent success. An empty set explicitly removes previous enforcement.

Desired and applied revision/digest plus requested/applied/rejected evidence are durable. Policy and membership mutations enqueue old-union-new affected devices through a device-keyed coalescing queue, with periodic reconciliation as a backstop.

Legacy peripheral enforcement is cleared and acknowledged before enabling version 2. A device that does not report the version-2 capability receives no version-2 enforcement.

#### Signed production rollback

Rollback is a separate protocol, not a relaxation of the normal upgrade downgrade guard. A directive binds rollback identity, current and target version, component versions, signed manifest, artifact digests, reason, authorizer, approval time and expiry.

Creation requires a dedicated rollback permission, step-up MFA, a signed target, and an N-to-N-1 transition. The agent advertises `rollbackProtocolVersion = 1` and records download, verification, staging, swap, restart, health, failure and recovery phases. Invalid, expired, replayed, wrong-device, wrong-current-version or incorrectly signed directives fail closed. Older agents retain ordinary upgrade/pin behavior and never receive rollback directives.

### Track E: PAM lifetime and cleanup

Closes RMM-QA-445 while establishing the shared foundation required by the adjacent PAM convergence, readiness, audit and idempotency findings.

Each approved request revision creates one durable `pam_actuations` identity with monotonic generation, desired state (`active` or `cleanup`) and observed lifecycle state. Approval plus the actuation row and outbox command commit atomically. Deny, revoke, expiry, policy removal, approval failure and entitlement removal atomically set cleanup intent and enqueue an idempotent cleanup generation.

Version-2 apply and cleanup commands bind actuation, generation, request, device and organization identity. Apply additionally binds target path/hash, subject identity, expiry, server time and maximum remaining lifetime. Results bind actuation/generation and report received, verified-active, cleaned or failed plus boot, Windows session, PID/process creation, Job Object, account and observation evidence. A cleanup generation is an irreversible tombstone; delayed older apply commands are rejected.

On Windows the agent creates the elevated target suspended, attaches the entire process tree to a named Job Object configured to terminate members when closed, and resumes only after successful attachment. The long-lived actuation manager retains or reopens the revocable primitive. Cleanup terminates the job, waits for zero members, demotes/disables and rotates the local account, verifies no matching privileged process/token remains, then acknowledges cleaned. Restart and reboot reconcile persisted desired state. Missing helper support or inability to verify dismissal/cleanup is failure, never success.

Legacy request status remains for compatibility, but endpoint enforcement status is exposed separately. Session end and terminal audit advance only from a persisted cleaned result. Offline cleanup remains queued and is not called revoked-at-endpoint. A synchronous revoke returns terminal success only after cleaned; otherwise it returns accepted/pending state.

Existing active or actuating legacy requests are marked `legacy_untracked`. They are never backfilled as cleaned. PAM remains disabled for those endpoints until cleanup and account state have been independently verified.

## Data and migration rules

All new tenant tables use the repository's required ownership shape, enable and force RLS in the creation migration, and are registered in organization/device cascade and export-policy registries as applicable. Open JSON evidence is classified `excludedOpen` in tenant export policy. Append-only event ledgers receive the required audit-admin deletion handling.

Migrations are additive, idempotent, ordered after shipped migrations and never edit a shipped migration. Large backfills are bounded and report affected/quarantined row counts. Server code tolerating old rows and payloads deploys before any producer emits new versions.

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
