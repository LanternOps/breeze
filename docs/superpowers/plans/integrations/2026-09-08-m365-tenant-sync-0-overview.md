---
title: M365 tenant sync foundation — plan overview and shared interface contract
date: 2026-09-08
spec: docs/superpowers/specs/integrations/2026-09-08-m365-tenant-sync-foundation-design.md
tracking_issue: LanternOps/breeze#5327
---

# M365 tenant sync foundation — plan overview

> **For agentic workers:** each wave below is its own plan file and its own PR.
> Use superpowers:subagent-driven-development or superpowers:executing-plans
> per wave. Every wave plan argues from the spec; read the spec first.

**Goal:** persist a per-org snapshot of a customer's M365 tenant (users, sign-in
activity, Intune devices, CA policies, license SKUs, Secure Score) refreshed on
a schedule through the existing customer-graph-read executor, with a daily
posture rollup, under manifest v3 with a non-interrupting re-consent flow.

**Architecture:** the executor gains whole-domain `m365.sync.*` actions on a
separate `/v1/sync-action` route; the API gains a due-time ticker with a
claim/lease/generation protocol, a three-phase `sync-domain` job (snapshot,
fetch outside any DB context, fenced persist with change-only writes), seven
RLS shape-1 tables with tenant-consistent composite FKs, and lifecycle hooks
on consent/disconnect. Everything is gated by `M365_TENANT_SYNC_ENABLED`.

**Tech stack:** TypeScript, Hono, Drizzle + hand-written SQL migrations,
BullMQ + Redis, Zod (`@breeze/shared/m365`), Vitest (unit, RLS, integration),
the `m365-graph-read-executor` Node service.

## Waves

| Wave | Plan file | Scope | Depends on | Rigor |
|---|---|---|---|---|
| W01 | `2026-09-08-m365-tenant-sync-1-manifest-v3-upgrade-consent.md` | Manifest v3, `grantHealth` in DTOs, upgrade-consent route + callback promotion, card banner (spec §2) | — | high (auth/consent) |
| W02 | `2026-09-08-m365-tenant-sync-2-schema-migration.md` | Migration, Drizzle schema, `m365_connections (id, org_id)` index, cascade/export/merge registration, device-move detach, retention job (spec §3) | — | high (tenancy) |
| W03 | `2026-09-08-m365-tenant-sync-3-executor-sync-actions.md` | Shared sync action schemas + result type, executor cases, Graph client sync profile, `/v1/sync-action`, caps, sign-in limiter + continuation, API client operation (spec §4) | — | medium |
| W04 | `2026-09-08-m365-tenant-sync-4-sync-core.md` | Executor call helper refactor, sync budget, claim protocol + ticker, `sync-domain` job for `users` (primary only), `intune_devices`, `ca_policies`, `skus`; flag gating; metrics (spec §5.1–5.4, §5.9 counts, §5.10, §7, §10) | W02, W03 | high (system-context worker) |
| W05 | `2026-09-08-m365-tenant-sync-5-enrichment-lifecycle.md` | Users enrichment (MFA, roles), `signin_activity` with continuation, `secure_score` with backfill, rollup, adaptive cadence, device link reconciliation, lifecycle hooks (consent seed, disconnect, upgrade re-seed), on-demand route, reconciliation on tick (spec §5.5–5.9, §10) | W04 | medium |
| W06 | `2026-09-08-m365-tenant-sync-6-integration-docs.md` | End-to-end integration suite, re-consent tests, benchmark harness, deploy doc / runbook / release notes, card "last synced" line (spec §9, §10) | W01, W05 | medium |

W01, W02, W03 are file-disjoint and can run in parallel. W04 needs W02's
schema and W03's shared types on its base branch. Branch names:
`feature/<parent#>-m365-tenant-sync/wave-<subissue#>`.

## Global constraints (copied from the spec; every wave inherits them)

- Migration file name must sort after the newest committed migration
  (`2026-10-14-100500-…` as of 2026-09-08; re-check with
  `ls apps/api/migrations | sort | tail -1`). Idempotent, no inner
  `BEGIN/COMMIT`, RLS enabled + forced + policies in the same file.
- All new tables are shape 1: `org_id NOT NULL` → `organizations(id)`, policy
  `USING (public.breeze_has_org_access(org_id))` FOR ALL.
- Composite FKs on `(x, org_id)` are `DEFERRABLE INITIALLY IMMEDIATE`.
- Every jsonb column is `excludedOpen`; every column whose name contains `mfa`
  or `hash` is `reviewedIncluded` in `CORE_TENANT_EXPORT_POLICY`.
- BullMQ custom job ids contain no `:`.
- Fail-closed: no Redis budget signal = deny; missing flag = off.
- Never edit a shipped migration. Never call the bare pool in request code.
- Test one file with `cd apps/api && npx vitest run <path>` (never
  `pnpm … test -- --run`).
- Executor projection allowlists are the only fields that leave the executor.

## Shared interface contract

Names below are fixed. A wave that needs to deviate updates this file in the
same PR and says so in the PR body.

### Shared package (`packages/shared/src/m365/`)

```ts
// sync.ts (new, exported from index.ts)
export const M365_SYNC_DOMAINS = [
  'users', 'signin_activity', 'intune_devices', 'ca_policies', 'skus', 'secure_score',
] as const;
export type M365SyncDomain = typeof M365_SYNC_DOMAINS[number];

export const M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS: Record<M365SyncDomain, number> = {
  users: 6 * 3600, signin_activity: 24 * 3600, intune_devices: 6 * 3600,
  ca_policies: 24 * 3600, skus: 24 * 3600, secure_score: 24 * 3600,
};
export const M365_SYNC_DOMAIN_INTERVAL_BOUNDS: Record<M365SyncDomain, { min: number; max: number }> = {
  users: { min: 3600, max: 48 * 3600 }, intune_devices: { min: 3600, max: 48 * 3600 },
  ca_policies: { min: 3600, max: 48 * 3600 }, skus: { min: 3600, max: 48 * 3600 },
  secure_score: { min: 3600, max: 48 * 3600 },
  signin_activity: { min: 24 * 3600, max: 7 * 24 * 3600 },
};

// readActions.ts additions
// ids appended to M365_READ_ACTION_IDS:
//   'm365.sync.users' | 'm365.sync.signin_activity' | 'm365.sync.intune_devices'
//   | 'm365.sync.ca_policies' | 'm365.sync.skus' | 'm365.sync.secure_score'
// Zod branches (all .strict()):
//   { type: 'm365.sync.users' }
//   { type: 'm365.sync.signin_activity', continuation?: string }   // opaque, max 4096 chars
//   { type: 'm365.sync.intune_devices' }
//   { type: 'm365.sync.ca_policies' }
//   { type: 'm365.sync.skus' }
//   { type: 'm365.sync.secure_score', backfill?: boolean }
export const M365_SYNC_ACTION_IDS = [...six ids...] as const;
export type M365SyncActionId = typeof M365_SYNC_ACTION_IDS[number];
export function isM365SyncActionId(id: string): id is M365SyncActionId;

export type M365SyncSourceState = 'ok' | 'unlicensed' | 'permission_missing' | 'throttled' | 'error';
export interface M365SyncActionResult {
  success: true;
  kind: 'sync';
  items: Record<string, unknown>[];   // projected; per-action item shapes below
  truncated: boolean;
  continuation?: string;
  fetchedAt: string;                  // ISO
  sources: Record<string, M365SyncSourceState>;
}
export const m365SyncActionResultSchema: z.ZodType<M365SyncActionResult>;

// Per-action projected item shapes (M365_READ_ACTION_FIELDS entries list these keys):
// m365.sync.users:           { id, userPrincipalName, displayName, mail, accountEnabled, jobTitle,
//                              department, usageLocation, onPremisesSyncEnabled, createdDateTime,
//                              assignedLicenses: string[] /* skuId */,
//                              mfaRegistered: boolean|null, mfaCapable: boolean|null, defaultMfaMethod: string|null,
//                              adminRoles: { roleTemplateId: string; displayName: string; viaGroupId?: string }[] | null }
//   sources keys: users, mfaRegistration, roleAssignments
// m365.sync.signin_activity: { id, lastSuccessfulSignInAt: string|null }
//   sources keys: signInActivity
// m365.sync.intune_devices:  { id, deviceName, operatingSystem, osVersion, complianceState, lastSyncDateTime,
//                              userPrincipalName, managedDeviceOwnerType, enrolledDateTime, model, manufacturer,
//                              serialNumber, azureADDeviceId, managementAgent, jailBroken }
//   sources keys: managedDevices
// m365.sync.ca_policies:     { id, displayName, state, createdDateTime, modifiedDateTime, conditions, grantControls, sessionControls }
//   sources keys: policies
// m365.sync.skus:            { skuId, skuPartNumber, consumedUnits, prepaidUnits: { enabled, suspended, warning }, capabilityStatus, appliesTo }
//   sources keys: subscribedSkus
// m365.sync.secure_score:    { id, createdDateTime, currentScore, maxScore, activeUserCount, licensedUserCount,
//                              controlScores: { controlName, score, maxScore, implementationStatus }[] }
//   sources keys: secureScores, controlProfiles
```

### Executor (`apps/m365-graph-read-executor`)

- Route `POST /v1/sync-action`, operation name `'sync-action'` in the
  `ExecutorOperation` union used by `internalAuth` and `app.ts`.
- `/v1/read-action` returns `400 { code: 'action_not_allowed' }` for sync ids;
  `/v1/sync-action` returns the same for non-sync ids.
- `503 { code: 'sync_capacity', retryAfterSeconds: 30 }` + `Retry-After: 30`
  when the sync in-flight cap is reached.
- Env: `M365_SYNC_MAX_IN_FLIGHT` (default 4), `M365_MAX_IN_FLIGHT` (default
  32), `M365_SIGNIN_ACTIVITY_RPM` (default 4), `M365_SIGNIN_PAGES_PER_CALL`
  (default 5), `M365_SYNC_MAX_ITEMS_USERS` / `_DEVICES` (default 25 000),
  `M365_SYNC_MAX_ITEMS_CA` (500), `M365_SYNC_MAX_ITEMS_SKUS` (200).
- Graph client sync profile: `maxPageCount` 60, `maxItemCount` per env above,
  `maxResponseBytes` 64 MiB, deadline 110 s via `AbortController`.
- Errors surfaced as existing executor error codes plus `graph_throttled`
  (with `retryAfterSeconds`) and `sync_capacity`.

### API client (`apps/api/src/services/m365ControlPlane/graphReadExecutorClient.ts`)

```ts
// ExecutorOperation union gains 'sync-action' → path '/v1/sync-action'
// GraphReadExecutorClient gains:
syncAction(input: {
  correlationId: string;
  tenantId: string;
  action: M365SyncAction;             // z.infer of the six sync branches
}): Promise<M365SyncActionResult | GraphReadExecutorFailure>;
// timeoutMs 130_000, maxResponseBytes 32 MiB for this operation
// GraphReadExecutorFailure gains codes 'sync_capacity' | 'graph_throttled' with retryAfterSeconds?: number
```

### API control plane (`apps/api/src/services/m365ControlPlane/`)

```ts
// readActionService.ts
export interface M365ConnectionExecutionSnapshot {
  id: string; orgId: string; tenantId: string; consentGeneration: number;
  status: 'active' | 'degraded'; permissionManifestVersion: number;
  vaultRef: string; credentialVersion: string;
}
export async function callGraphReadExecutor(
  snapshot: M365ConnectionExecutionSnapshot,
  action: M365ReadAction,               // includes sync branches
  opts: { route: 'read' | 'sync'; correlationId: string; actorId?: string },
): Promise<M365ReadActionServiceResult | M365SyncCallResult>;
// DB-free: budget check (read family for route 'read', sync family for 'sync'),
// client call, metrics, audit event. Never opens a DB context.

// readActionBudget.ts
export const M365_SYNC_ACTIONS_PER_HOUR = 12;
export async function consumeM365SyncBudget(connectionId: string): Promise<M365ReadActionBudgetResult>;

// connectionService.ts (W01)
// GrantHealth already exists; DTOs expose:
//   grantHealth: GrantHealthState; manifestVersion: number; currentManifestVersion: number;
export const initiateCustomerGraphReadUpgradeConsent: (input: { connectionId: string; orgId: string; auth: AuthContext; returnTo?: string }) => Promise<InitiatedCustomerGraphReadConsent>;
// Route: POST /m365/connections/:id/upgrade-consent (MFA-gated), read profile; same for actions profile is out of scope.
```

### API sync service (`apps/api/src/services/m365Sync/`)

```ts
// types.ts
export interface M365SyncJobData {
  orgId: string; domain: M365SyncDomain; generation: number;
  connectionId: string; tenantId: string; consentGeneration: number;
  priority: 1 | 10;
}
export type M365SyncOutcome = 'success' | 'partial' | 'needs_consent' | 'throttled' | 'error';

// claim.ts
export async function claimDueDomains(opts: { limit: number; now?: Date }): Promise<M365SyncJobData[]>;  // system ctx; SKIP LOCKED; bumps generation, sets lease; does NOT touch next_sync_at
export async function claimAndEnqueue(orgId: string, domains: M365SyncDomain[], priority: 1 | 10): Promise<void>; // sets next_sync_at = now() then claims + enqueues
export function syncJobId(d: Pick<M365SyncJobData, 'orgId' | 'domain' | 'generation'>): string; // `m365-sync-${orgId}-${domain}-${generation}`
export async function reconcileEligibleConnections(): Promise<number>; // inserts missing state rows for executable read connections, ON CONFLICT DO NOTHING

// run.ts
export async function runSyncDomain(data: M365SyncJobData): Promise<M365SyncOutcome | 'fenced' | 'noop'>;
// Phase A snapshot (short system tx) → Phase B fetch (runOutsideDbContext) → Phase C fenced persist.

// domains/<domain>.ts — one module per domain, each exporting:
export interface DomainPersistResult { inserted: number; updated: number; stale: number; unchanged: number; counts: Record<string, number>; complete: boolean }
export async function persistUsers(ctx: PersistContext, result: M365SyncActionResult): Promise<DomainPersistResult>;
// …persistIntuneDevices, persistCaPolicies, persistSkus, persistSecureScore, persistSigninActivity
// PersistContext = { orgId, tenantId, connectionId, generation, existing: Map<graphId, { coreHash: string; isStale: boolean }>, now: Date }

// hash.ts
export function canonicalHash(record: Record<string, unknown>): string; // SHA-256 hex of JSON with sorted keys and sorted arrays of primitives

// rollup.ts
export async function upsertPostureRollup(orgId: string, tenantId: string, date: string): Promise<void>; // assembles from m365_sync_state.last_counts

// links.ts
export async function reconcileDeviceLinks(orgId: string): Promise<{ linkedBySerial: number; linkedByHostname: number; ambiguous: number }>;

// cadence.ts
export function nextInterval(domain: M365SyncDomain, current: number, outcome: M365SyncOutcome, signals: { truncated: boolean; latencyMs: number; capacity: boolean }): number;

// lifecycle.ts
export async function onConnectionConsented(conn: { id: string; orgId: string; tenantId: string; status: 'active' | 'degraded' }): Promise<void>;  // seeds 6 rows, claims at priority 1, backfill for secure_score
export async function onConnectionDisconnected(conn: { id: string; orgId: string }): Promise<void>; // deletes state + entity rows, keeps history
export async function onConnectionUpgraded(conn: { id: string; orgId: string }): Promise<void>;    // re-seeds unscheduled needs_consent domains

// flag (apps/api/src/config/env.ts)
export function isM365TenantSyncEnabled(): boolean; // envFlag('M365_TENANT_SYNC_ENABLED', false)
// env: M365_SYNC_CONCURRENCY (4), M365_SYNC_MAX_BACKLOG (500), M365_SYNC_TICK_BATCH (200)
```

### Jobs (`apps/api/src/jobs/m365SyncWorker.ts`)

- Queue name `m365-sync`; job names `tick` (repeat every 60 s, jobId
  `m365-sync-tick`) and `sync-domain`.
- `tick`: backpressure check (`waiting + prioritized + delayed + active`),
  `reconcileEligibleConnections()`, `claimDueDomains({ limit: batch })`,
  enqueue each with `jobId: syncJobId(d)`, `priority`, `removeOnComplete:
  true`, `removeOnFail: { count: 100 }`, `attempts: 3`, `backoff: { type:
  'custom' }` giving 30 s / 120 s / 480 s.
- Scheduled retention job key `m365-sync-retention` in `scheduleRegistry.ts`,
  daily tier (minute ≡ 3 mod 5; pick a free `(hour, minute)`).

### Tables (spec §3, exact names)

`m365_sync_state`, `m365_users`, `m365_intune_devices`, `m365_ca_policies`,
`m365_license_skus`, `m365_secure_score_snapshots`, `m365_posture_rollups`.
Enums `m365_sync_domain`, `m365_sync_status`. Drizzle file
`apps/api/src/db/schema/m365Sync.ts` exporting `m365SyncState`, `m365Users`,
`m365IntuneDevices`, `m365CaPolicies`, `m365LicenseSkus`,
`m365SecureScoreSnapshots`, `m365PostureRollups`.

### Metrics (spec §7, exact names)

`m365_sync_runs_total{domain,outcome}`, `m365_sync_items{domain,kind}`,
`m365_sync_executor_seconds{domain}`, `m365_sync_due_backlog`,
`m365_sync_queue_depth`, `m365_sync_ticker_utilisation`,
`m365_sync_ticker_skipped_total`, `m365_sync_fenced_total`,
`m365_sync_link_ambiguous_total`. Executor: `m365_sync_actions_total{action,outcome}`,
`m365_sync_in_flight`, `m365_in_flight_total`, `m365_sync_capacity_rejected_total`,
`m365_signin_limiter_tokens`.
