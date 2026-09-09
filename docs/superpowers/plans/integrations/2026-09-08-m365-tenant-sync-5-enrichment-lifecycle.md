# M365 Tenant Sync — Wave 5: Enrichment, sign-in continuation, Secure Score, rollup, cadence, device links, lifecycle, on-demand

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task's code steps carry real code — nothing here is a sketch.

**Goal:** finish the sync worker W04 started. Users gain their MFA/role enrichment written only from sources that actually succeeded; `signin_activity` becomes a resumable domain that re-claims itself until its continuation is exhausted; `secure_score` persists Graph-dated snapshots with a first-run 90-day backfill; every completed run assembles the daily posture rollup and (for Intune) reconciles Breeze device links; adaptive cadence sets the next due time; the two remaining domains are switched on in `DOMAIN_PERSISTERS` and `M365_SYNC_IMPLEMENTED_DOMAINS`; and the connection lifecycle (consent, disconnect, upgrade) plus an MFA-gated on-demand route drive the schedule from the product surface. This wave also owns **every** change to the Customer Graph Read card — the "Sync now" button, the last-synced line and the per-domain chips.

**Architecture:** W04 owns the three-phase `sync-domain` job and two extension seams it ships as tested stubs:

- `applyCadence(domain, state, outcome, signals)` in `services/m365Sync/cadence.ts` — what the completion transaction writes to `interval_seconds` / `next_sync_at`.
- `afterDomainPersisted(ctx)` in `services/m365Sync/hooks.ts` — invoked **after `writeCompletion` has committed**, on its own `withSystemDbAccessContext`. It is not part of the completion transaction and cannot roll it back.

Both files already exist; this wave **modifies** them, it never creates them. It adds four domain persisters/extensions, registers the two missing ones in `DOMAIN_PERSISTERS`, widens `M365_SYNC_IMPLEMENTED_DOMAINS` to all six, and adds `lifecycle.ts`. Everything that can schedule work is gated by `M365_TENANT_SYNC_ENABLED`. Persisters stay change-only and set-based; the worker holds a system DB context, so every statement filters by the `org_id` it was enqueued with.

**Tech stack:** TypeScript, Hono (API routes), Drizzle ORM + hand-written SQL (`sql` fragments, data-modifying CTEs), BullMQ + Redis (`claimAndEnqueue`, on-demand limiter), Zod (`@breeze/shared/m365`), Vitest (unit + integration), React + i18next (web card).

**Spec:** `docs/superpowers/specs/integrations/2026-09-08-m365-tenant-sync-foundation-design.md` — this wave implements §5.5, §5.6, §5.7, §5.8, §5.9, §5.2 (on-demand + seeding), §6 (enrichment/continuation/unlicensed rows), §3.3 (Secure Score keying), §10 (flag gating of every entry point).

**Plan overview + shared interface contract:** `docs/superpowers/plans/integrations/2026-09-08-m365-tenant-sync-0-overview.md`. **The contract is the orchestrator's file: this wave does not edit it.** Every name this plan uses is already in it; if the shipped code diverges, follow the code and record the delta in the PR body.

**Depends on W01 and W04.** W01 because Task 12 turns W01's `// W05: onConnectionUpgraded(...)` seam comment into a call and Tasks 14-16 edit the route, DTO and card W01 has already changed; W04 because every module below extends one of its.

## Global constraints (copied from the overview; this wave inherits them)

- Migration file name must sort after the newest committed migration
  (`2026-10-14-100500-…` as of 2026-09-08; re-check with
  `ls apps/api/migrations | sort | tail -1`). Idempotent, no inner
  `BEGIN/COMMIT`, RLS enabled + forced + policies in the same file.
  **This wave adds no migration.** If you find yourself writing one, stop: the
  schema is W02's and a second file on the same tables is a merge hazard.
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

## Execution baseline — verify W01/W02/W03/W04 shipped before Task 1

This wave consumes W04's modules and W01's callback restructure by name. Run this
block first; every line must succeed. If one fails, that wave is not on your base
branch — rebase, do not stub.

```bash
test -f apps/api/src/db/schema/m365Sync.ts                          # W02
grep -q "m365SyncState" apps/api/src/db/schema/m365Sync.ts           # W02
grep -q "m365.sync.secure_score" packages/shared/src/m365/readActions.ts   # W03
test -f apps/api/src/services/m365Sync/types.ts                     # W04
test -f apps/api/src/services/m365Sync/claim.ts                     # W04
test -f apps/api/src/services/m365Sync/run.ts                       # W04
test -f apps/api/src/services/m365Sync/hash.ts                      # W04
test -f apps/api/src/services/m365Sync/metrics.ts                   # W04
test -f apps/api/src/services/m365Sync/cadence.ts                   # W04 stub — this wave MODIFIES it
test -f apps/api/src/services/m365Sync/hooks.ts                     # W04 stub — this wave MODIFIES it
test -f apps/api/src/services/m365Sync/domains/users.ts             # W04
test -f apps/api/src/services/m365Sync/domains/intuneDevices.ts     # W04
grep -q "usersPrimaryProjection" apps/api/src/services/m365Sync/domains/users.ts   # W04 exports it
grep -q "applyCadence"          apps/api/src/services/m365Sync/cadence.ts
grep -q "CadenceSignals"        apps/api/src/services/m365Sync/cadence.ts
grep -q "afterDomainPersisted"  apps/api/src/services/m365Sync/hooks.ts
grep -q "partial-continue"      apps/api/src/services/m365Sync/types.ts        # M365SyncRunResult already has it
grep -q "M365_SYNC_IMPLEMENTED_DOMAINS" apps/api/src/services/m365Sync/types.ts
grep -rq "export function m365SyncActionFor" apps/api/src/services/m365Sync/   # types.ts in W04
grep -q "DOMAIN_PERSISTERS"     apps/api/src/services/m365Sync/run.ts
grep -q "recordM365SyncLinkAmbiguous" apps/api/src/services/m365Sync/metrics.ts
grep -q "isM365TenantSyncEnabled" apps/api/src/config/env.ts        # W04
grep -q "W05: onConnectionUpgraded" apps/api/src/routes/m365ConsentCallback.ts  # W01 seam comment
grep -q "applyUpgradeResult"    apps/api/src/routes/m365ConsentCallback.ts     # W01
grep -q "grantHealth"           apps/api/src/routes/m365CustomerGraphRead.ts   # W01 DTO
grep -q "upgrade-consent"       apps/api/src/routes/m365CustomerGraphRead.ts   # W01 route
```

**Seam contract this wave assumes** (it is the overview's, verbatim; verify by
reading, and reconcile against the code if a wave diverged — the code is the
authority, the contract is the intent):

```ts
// types.ts (W04) — do NOT redeclare any of these in this wave. The contract
// lists m365SyncActionFor under run.ts and W04 shipped it in types.ts; import it
// from wherever it actually lives rather than writing a second one.
export type M365SyncRunResult = M365SyncOutcome | 'fenced' | 'noop' | 'partial-continue';
export let M365_SYNC_IMPLEMENTED_DOMAINS: readonly M365SyncDomain[];   // W04: four; Task 4 widens to six
export function m365SyncActionFor(
  domain: M365SyncDomain,
  opts: { continuation?: string | null; backfill?: boolean },
): M365SyncAction;

// run.ts (W04)
export interface SyncRunContext {
  snapshot: M365ConnectionExecutionSnapshot;
  state: {
    intervalSeconds: number;
    continuation: string | null;
    lastCompleteSnapshotAt: Date | null;
    lastSuccessAt: Date | null;          // selected by W04's Phase A — drives Task 5's backfill flag
  };
  existing: Map<string, { coreHash: string; isStale: boolean }>;
}
export const DOMAIN_PERSISTERS: Record<M365SyncDomain, Persister | undefined>;
// writeCompletion(ctx, …) is ONE short system transaction. It supports a
// continuation mode: writeCompletion(ctx, { mode: 'continuation', continuation }).

// cadence.ts (W04 ships the interface, the jitter helper and a stub body;
// Task 6 replaces the applyCadence body and adds nextInterval)
export interface CadenceSignals {
  truncated: boolean; latencyMs: number; capacity: boolean;
  unlicensed: boolean; authFailure: boolean; now: Date;
}
export function nextSyncAt(now: Date, intervalSeconds: number, rng?: () => number): Date; // ±10% jitter
export function applyCadence(
  domain: M365SyncDomain,
  state: { intervalSeconds: number },
  outcome: M365SyncOutcome,
  signals: CadenceSignals,
  rng?: () => number,        // W04's injectable jitter source; the 4-arg contract call still type-checks
): { intervalSeconds: number; nextSyncAt: Date | null };

// hooks.ts (W04 ships a no-op; Task 7 replaces the body)
export async function afterDomainPersisted(
  ctx: PersistContext & {
    domain: M365SyncDomain;
    outcome: M365SyncOutcome;
    persisted: DomainPersistResult;
  },
): Promise<void>;

// metrics.ts (W04)
export function recordM365SyncLinkAmbiguous(count: number): void;   // no orgId label
```

**`afterDomainPersisted` runs AFTER `writeCompletion` commits, not inside it.**
It opens its own `withSystemDbAccessContext`, so the rollup reads a
`m365_sync_state` row that is already durable — including this run's
`last_counts` — and a throw inside the hook is logged and metered but cannot
undo the completion. Task 7 step 1 pins both halves of that: the ordering, and
the fact that a hook failure leaves the persisted state unchanged.

## Decisions this plan makes (each is a recorded deviation or an open item resolved)

1. **`'partial-continue'` is consumed, not introduced.** `M365SyncRunResult` in
   `types.ts` already carries it (W04, per the contract): it is a
   control-flow/metrics value that never reaches `last_status`, because
   `m365_sync_status` is a shipped Postgres enum (W02) whose values are
   `success | partial | needs_consent | throttled | error` and spec §6 keeps the
   sync state "unchanged until exhausted" while a continuation is outstanding.
   **This wave imports the type from `types.ts` and never redefines it**, and it
   does not touch the overview.
2. **`CadenceSignals` is imported from `cadence.ts`, never redeclared.** The
   six-field shape (`truncated`, `latencyMs`, `capacity`, `unlicensed`,
   `authFailure`, `now`) is already in the contract and in W04's stub: spec §6
   needs `unlicensed` → interval to max and auth failure → `next_sync_at = NULL`,
   neither derivable from the outcome alone (`unlicensed` is a `success`, and an
   auth failure is an `error` just like a persist fault), and `now` makes the
   jitter test deterministic. Task 6 replaces the function body only.
3. **Enrichment counters are omitted from `last_counts`, not zeroed, when their
   source is not `ok`.** The in-memory items carry `mfaRegistered: null` for
   every user when the registration report failed, but the stored column keeps
   yesterday's value — counting the items would report "0 registered" for a
   tenant that is fully registered. Omitted key → the rollup writes NULL →
   the "unknown" columns spec §3.3 exists for. No extra count query is issued
   (spec §5.9's "zero count queries" holds). Every key this wave writes into
   `counts` is one of the contract's snake_case rollup column names:
   `users_total`, `users_enabled`, `users_mfa_registered`, `users_mfa_unknown`,
   `users_admin`, `admins_without_mfa`, `admins_mfa_unknown`, `devices_total`,
   `devices_compliant`, `devices_noncompliant`, `devices_in_grace`,
   `devices_unknown`, `ca_policies_enabled`, `ca_policies_report_only`,
   `ca_policies_disabled`, `seats_purchased`, `seats_consumed`, `secure_score`,
   `secure_score_max`. No other key is ever written.
4. **`is_admin` is derived from `admin_roles` inside the same statement.** On
   the conflict branch it is
   `jsonb_array_length(coalesce(excluded.admin_roles, '[]'::jsonb)) > 0`; on the
   insert branch it comes from the same array literal that populates
   `admin_roles` in that VALUES row. The two can never disagree because there is
   exactly one array.
5. **`backfill` travels as no column at all.** The state row's
   `last_success_at IS NULL` is the first-run test (spec §5.8: "the first
   `secure_score` run passes `backfill: true`"), and W04's Phase A already
   selects `lastSuccessAt` into `SyncRunContext.state`, so `run.ts` builds the
   action with `m365SyncActionFor(domain, { backfill: state.lastSuccessAt === null })`.
   After a disconnect the state rows are deleted, so a rebind re-backfills —
   which is what we want, the tenant changed.
6. **Lifecycle hooks differ in DB-context posture, deliberately.**
   `onConnectionDisconnected` runs on the **ambient** system context (the caller
   — `disconnectConnection` — already holds one, so the entity deletes commit in
   the same transaction as the status flip) and is allowed to throw: a partially
   erased tenant that commits is worse than a disconnect the operator retries.
   `onConnectionConsented` / `onConnectionUpgraded` open their **own**
   `runOutsideDbContext(() => withSystemDbAccessContext(…))` (the consent
   callback holds no context at the call site) and never throw: seeding is
   recoverable by the ticker's `reconcileEligibleConnections()` step (spec §10.2),
   and a seeding fault must not turn a successful consent into a terminal
   failure redirect.
7. **The on-demand route returns `404` when the flag is off**, matching the
   shipped convention for a disabled M365 feature
   (`m365CustomerGraphRead.ts:216-218` returns 404 for onboarding-disabled), and
   checks the flag *before* the limiter so a disabled feature never burns a slot.
8. **This wave owns the ENTIRE card change set, and the DTO fields sit on the
   ENVELOPE.** `syncEnabled` and `sync` are added to `CustomerGraphReadEnvelope`
   (not to the connection DTO), so the web parser change is in `parseEnvelope`.
   Task 16 ships the "Sync now" button, the "Last synced … · N users · M devices"
   line, the per-domain chips, `formatRelativeTime`, and every locale key for all
   of it. **W06 adds no card code** — say so in the PR body so it does not
   re-add any of it.
9. **Link reconciliation writes only `breeze_device_id`.** It never touches
   `last_changed_at` or `core_hash`: a link is Breeze-side state, not a Graph
   change, and bumping the change timestamp would make sub-project 3's change
   alerts fire on every agent enrolment.

---

### Task 1: users enrichment — source-gated columns and counters

Spec §5.5, §6 rows 2-3, §3.2. Extends W04's `persistUsers`; primary-field
persistence, hashing, stale marking and `users_total`/`users_enabled` are
already there and must not be re-implemented.

**Files:**
- Modify: `apps/api/src/services/m365Sync/domains/users.ts`
- Modify: `apps/api/src/services/m365Sync/domains/users.test.ts`

**Interfaces:**
- Consumes: `canonicalHash` (`m365Sync/hash.ts`, W04); `PersistContext`,
  `DomainPersistResult` (`m365Sync/types.ts`, W04); `m365Users`
  (`db/schema/m365Sync.ts`, W02); `M365SyncActionResult`,
  `M365SyncSourceState` (`@breeze/shared/m365`, W03); `db` (`../../db`).
  `usersPrimaryProjection(item)` — **W04 already exports it from this same
  module** (it is in the contract). Import and call it; never redefine it and
  never inline an equivalent field list. It projects the primary `/users` fields
  only (`id`, `userPrincipalName`, `displayName`, `mail`, `accountEnabled`,
  `jobTitle`, `department`, `usageLocation`, `onPremisesSyncEnabled`,
  `createdDateTime`, `assignedLicenses`), because enrichment is never in
  `core_hash` (§5.4).
- Produces (consumed by `persistUsers` in this file, and read back through
  `last_counts` by Task 7's rollup):
  - `export function usersEnrichmentInsertColumns(item, sources): Partial<M365UserInsert>`
  - `export function usersEnrichmentUpdateSet(sources): Record<string, SQL>`
  - `export function usersEnrichmentCounts(items, sources): Record<string, number>`
  - `export function deriveIsAdmin(adminRoles: unknown): boolean`

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/services/m365Sync/domains/users.test.ts`. These are real
assertions on the statement the persister builds — a capturing `db.insert` mock
records the VALUES rows and the `onConflictDoUpdate` set object, so a version
that writes the enrichment unconditionally fails on the *absence* assertion.

```ts
import {
  deriveIsAdmin,
  persistUsers,
  usersEnrichmentCounts,
  usersEnrichmentInsertColumns,
  usersEnrichmentUpdateSet,
} from './users';

const ORG = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '33333333-3333-4333-8333-333333333333';

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    userPrincipalName: 'ann@contoso.example',
    displayName: 'Ann',
    mail: 'ann@contoso.example',
    accountEnabled: true,
    jobTitle: null,
    department: null,
    usageLocation: 'US',
    onPremisesSyncEnabled: false,
    createdDateTime: '2026-01-01T00:00:00.000Z',
    assignedLicenses: [],
    mfaRegistered: true,
    mfaCapable: true,
    defaultMfaMethod: 'microsoftAuthenticatorPush',
    adminRoles: [],
    ...overrides,
  };
}

function result(items: unknown[], sources: Record<string, string>) {
  return {
    success: true as const,
    kind: 'sync' as const,
    items: items as Record<string, unknown>[],
    truncated: false,
    fetchedAt: '2026-09-08T00:00:00.000Z',
    sources,
  };
}

function ctx() {
  return {
    orgId: ORG,
    tenantId: TENANT,
    connectionId: CONNECTION,
    generation: 4,
    existing: new Map<string, { coreHash: string; isStale: boolean }>(),
    now: new Date('2026-09-08T12:00:00.000Z'),
  };
}

describe('users enrichment is written only from sources that succeeded', () => {
  it('writes every enrichment column when both secondary sources are ok', () => {
    const columns = usersEnrichmentInsertColumns(user(), {
      users: 'ok', mfaRegistration: 'ok', roleAssignments: 'ok',
    });
    expect(Object.keys(columns).sort()).toEqual([
      'adminRoles', 'defaultMfaMethod', 'isAdmin', 'mfaCapable', 'mfaRegistered',
    ]);
    const set = usersEnrichmentUpdateSet({
      users: 'ok', mfaRegistration: 'ok', roleAssignments: 'ok',
    });
    expect(Object.keys(set).sort()).toEqual([
      'adminRoles', 'defaultMfaMethod', 'isAdmin', 'mfaCapable', 'mfaRegistered',
    ]);
  });

  it('omits the mfa columns entirely when the registration report failed', () => {
    for (const state of ['permission_missing', 'throttled', 'error', 'unlicensed'] as const) {
      const columns = usersEnrichmentInsertColumns(user(), {
        users: 'ok', mfaRegistration: state, roleAssignments: 'ok',
      });
      expect(columns).not.toHaveProperty('mfaRegistered');
      expect(columns).not.toHaveProperty('mfaCapable');
      expect(columns).not.toHaveProperty('defaultMfaMethod');
      expect(Object.keys(usersEnrichmentUpdateSet({
        users: 'ok', mfaRegistration: state, roleAssignments: 'ok',
      })).sort()).toEqual(['adminRoles', 'isAdmin']);
    }
  });

  it('omits admin_roles AND is_admin together when role assignments failed', () => {
    const set = usersEnrichmentUpdateSet({
      users: 'ok', mfaRegistration: 'ok', roleAssignments: 'error',
    });
    expect(Object.keys(set).sort()).toEqual(['defaultMfaMethod', 'mfaCapable', 'mfaRegistered']);
  });

  it('stores mfa_registered NULL for a user missing from a SUCCESSFUL report', () => {
    const columns = usersEnrichmentInsertColumns(
      user({ mfaRegistered: null, mfaCapable: null, defaultMfaMethod: null }),
      { users: 'ok', mfaRegistration: 'ok', roleAssignments: 'ok' },
    );
    expect(columns).toHaveProperty('mfaRegistered', null);
    expect(columns).toHaveProperty('mfaCapable', null);
  });

  it('derives is_admin from the same array that populates admin_roles', () => {
    const roles = [{ roleTemplateId: 'r1', displayName: 'Global Administrator' }];
    const columns = usersEnrichmentInsertColumns(user({ adminRoles: roles }), {
      users: 'ok', mfaRegistration: 'ok', roleAssignments: 'ok',
    });
    expect(columns.adminRoles).toEqual(roles);
    expect(columns.isAdmin).toBe(true);
    expect(deriveIsAdmin(roles)).toBe(true);
    expect(deriveIsAdmin([])).toBe(false);
    expect(deriveIsAdmin(null)).toBe(false);
    expect(deriveIsAdmin('not-an-array')).toBe(false);
  });

  it('splices the enrichment into the real upsert statement', async () => {
    const captured = installCapturingInsert();   // helper below
    await persistUsers(ctx(), result([user()], {
      users: 'ok', mfaRegistration: 'error', roleAssignments: 'ok',
    }));
    expect(captured.values[0]).not.toHaveProperty('mfaRegistered');
    expect(captured.values[0]).toHaveProperty('adminRoles');
    expect(Object.keys(captured.set)).not.toContain('mfaRegistered');
    expect(Object.keys(captured.set)).toContain('isAdmin');
  });
});

describe('users enrichment counters', () => {
  const both = { users: 'ok', mfaRegistration: 'ok', roleAssignments: 'ok' } as const;

  it('counts registered, unknown, admins, admins without mfa and admins unknown', () => {
    const admin = [{ roleTemplateId: 'r1', displayName: 'Global Administrator' }];
    const counts = usersEnrichmentCounts([
      user({ id: 'u1', mfaRegistered: true }),
      user({ id: 'u2', mfaRegistered: null }),
      user({ id: 'u3', mfaRegistered: false, adminRoles: admin }),
      user({ id: 'u4', mfaRegistered: null, adminRoles: admin }),
      user({ id: 'u5', mfaRegistered: true, adminRoles: admin }),
    ], both);
    expect(counts).toEqual({
      users_mfa_registered: 2,
      users_mfa_unknown: 2,
      users_admin: 3,
      admins_without_mfa: 1,
      admins_mfa_unknown: 1,
    });
  });

  it('omits (never zeroes) the mfa counters when the report failed', () => {
    const counts = usersEnrichmentCounts([user({ mfaRegistered: null })], {
      users: 'ok', mfaRegistration: 'error', roleAssignments: 'ok',
    });
    expect(counts).toEqual({ users_admin: 0 });
    expect(counts).not.toHaveProperty('users_mfa_registered');
    expect(counts).not.toHaveProperty('users_mfa_unknown');
    expect(counts).not.toHaveProperty('admins_without_mfa');
  });

  it('omits every admin counter when role assignments failed', () => {
    const counts = usersEnrichmentCounts([user()], {
      users: 'ok', mfaRegistration: 'ok', roleAssignments: 'permission_missing',
    });
    expect(Object.keys(counts).sort()).toEqual(['users_mfa_registered', 'users_mfa_unknown']);
  });
});
```

Add the capturing-insert helper next to the file's existing mocks (the file
already mocks `../../../db` for W04's tests; extend that mock rather than
adding a second `vi.mock` for the same path):

```ts
interface CapturedInsert { values: Record<string, unknown>[]; set: Record<string, unknown> }

function installCapturingInsert(): CapturedInsert {
  const captured: CapturedInsert = { values: [], set: {} };
  vi.mocked(db.insert).mockImplementation((() => ({
    values: (rows: Record<string, unknown>[]) => {
      captured.values.push(...rows);
      return {
        onConflictDoUpdate: (arg: { set: Record<string, unknown> }) => {
          captured.set = arg.set;
          return Promise.resolve(undefined);
        },
      };
    },
  })) as unknown as typeof db.insert);
  return captured;
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/m365Sync/domains/users.test.ts`
Expected: FAIL — `usersEnrichmentInsertColumns` etc. are not exported.

- [ ] **Step 3: Implement**

In `apps/api/src/services/m365Sync/domains/users.ts`:

```ts
import { sql, type SQL } from 'drizzle-orm';
import type { M365SyncActionResult, M365SyncSourceState } from '@breeze/shared/m365';
import { m365Users } from '../../../db/schema/m365Sync';

type Sources = M365SyncActionResult['sources'];

/**
 * Active directory-role assignments for one user, as projected by the executor
 * (`{ roleTemplateId, displayName, viaGroupId? }[]`). Anything that is not an
 * array is treated as "no roles" rather than throwing: the value is customer
 * data from a foreign API and must never be able to fail a whole chunk.
 */
export function deriveIsAdmin(adminRoles: unknown): boolean {
  return Array.isArray(adminRoles) && adminRoles.length > 0;
}

function sourceOk(sources: Sources, key: string): boolean {
  return (sources[key] as M365SyncSourceState | undefined) === 'ok';
}

/**
 * Enrichment columns for ONE inserted row. Spec §5.5/§6: a column whose source
 * did not return `ok` is omitted entirely, so an insert leaves it NULL
 * ("unknown") and an update leaves the stored value alone. A user missing from
 * a SUCCESSFUL registration report arrives with `mfaRegistered: null` and that
 * null is written — the report is authoritative, the source just does not know
 * about this account.
 */
export function usersEnrichmentInsertColumns(
  item: Record<string, unknown>,
  sources: Sources,
): Record<string, unknown> {
  const columns: Record<string, unknown> = {};
  if (sourceOk(sources, 'mfaRegistration')) {
    columns.mfaRegistered = (item.mfaRegistered ?? null) as boolean | null;
    columns.mfaCapable = (item.mfaCapable ?? null) as boolean | null;
    columns.defaultMfaMethod = (item.defaultMfaMethod ?? null) as string | null;
  }
  if (sourceOk(sources, 'roleAssignments')) {
    const roles = Array.isArray(item.adminRoles) ? item.adminRoles : [];
    columns.adminRoles = roles;
    columns.isAdmin = deriveIsAdmin(roles);
  }
  return columns;
}

/**
 * The ON CONFLICT branch of the SAME statement. `is_admin` is recomputed from
 * `excluded.admin_roles` in SQL so the pair cannot drift even if a future edit
 * changes only one of them, and the two keys are always added or omitted
 * together.
 */
export function usersEnrichmentUpdateSet(sources: Sources): Record<string, SQL> {
  const set: Record<string, SQL> = {};
  if (sourceOk(sources, 'mfaRegistration')) {
    set.mfaRegistered = sql`excluded.mfa_registered`;
    set.mfaCapable = sql`excluded.mfa_capable`;
    set.defaultMfaMethod = sql`excluded.default_mfa_method`;
  }
  if (sourceOk(sources, 'roleAssignments')) {
    set.adminRoles = sql`excluded.admin_roles`;
    set.isAdmin = sql`jsonb_array_length(coalesce(excluded.admin_roles, '[]'::jsonb)) > 0`;
  }
  return set;
}

/**
 * Counters for `m365_sync_state.last_counts`, computed in memory from the
 * fetched items (spec §5.9 — no count query). A counter whose source failed is
 * OMITTED, not zeroed: the stored columns still hold the previous run's values,
 * so counting this run's all-null items would report a fully-registered tenant
 * as "0 registered". An omitted key becomes NULL in the rollup, which is the
 * "unknown" the spec's §3.3 columns exist for.
 */
export function usersEnrichmentCounts(
  items: Record<string, unknown>[],
  sources: Sources,
): Record<string, number> {
  const counts: Record<string, number> = {};
  const mfaOk = sourceOk(sources, 'mfaRegistration');
  const rolesOk = sourceOk(sources, 'roleAssignments');
  if (mfaOk) {
    counts.users_mfa_registered = items.filter((i) => i.mfaRegistered === true).length;
    counts.users_mfa_unknown = items.filter((i) => i.mfaRegistered === null || i.mfaRegistered === undefined).length;
  }
  if (rolesOk) {
    const admins = items.filter((i) => deriveIsAdmin(i.adminRoles));
    counts.users_admin = admins.length;
    if (mfaOk) {
      counts.admins_without_mfa = admins.filter((i) => i.mfaRegistered === false).length;
      counts.admins_mfa_unknown = admins.filter((i) => i.mfaRegistered === null || i.mfaRegistered === undefined).length;
    }
  }
  return counts;
}
```

Then splice all three into W04's `persistUsers`:

1. In the VALUES builder, after the primary columns:
   `...usersEnrichmentInsertColumns(item, result.sources),`
2. In the `onConflictDoUpdate({ target: [...], set: { … } })` object, after the
   primary `excluded.*` assignments:
   `...usersEnrichmentUpdateSet(result.sources),`
3. In the returned `DomainPersistResult.counts`:
   `...usersEnrichmentCounts(result.items, result.sources),`

**Do not add an unconditional `lastChangedAt: sql\`now()\`` to the set.** If
W04's conflict set already bumps it unconditionally, guard it now — enrichment
must not count as a primary change (§5.4):

```ts
lastChangedAt: sql`CASE WHEN excluded.core_hash IS DISTINCT FROM ${m365Users.coreHash}
                        THEN now() ELSE ${m365Users.lastChangedAt} END`,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/m365Sync/domains/users.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365Sync/domains/users.ts \
        apps/api/src/services/m365Sync/domains/users.test.ts
git commit -m "feat(m365): source-gated user enrichment columns and counters

Spec §5.5/§6. mfa_registered/mfa_capable/default_mfa_method are written only
when sources.mfaRegistration === 'ok'; admin_roles and is_admin only when
sources.roleAssignments === 'ok'. Both pairs are added to, or omitted from,
the SAME upsert statement, and is_admin is recomputed from
excluded.admin_roles in SQL so the two can never disagree. A user missing from
a successful registration report gets mfa_registered NULL, never false.

Enrichment counters are omitted from last_counts when their source failed
rather than zeroed: the stored columns keep the previous run's values, so
counting this run's all-null items would report a registered tenant as zero.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 2: `domains/signinActivity.ts` — field-wise update, continuation, unlicensed

Spec §5.5 (last paragraph), §6 rows 3 and 5, §4.1.

**Files:**
- Create: `apps/api/src/services/m365Sync/domains/signinActivity.ts`
- Create: `apps/api/src/services/m365Sync/domains/signinActivity.test.ts`

**Interfaces:**
- Consumes: `PersistContext`, `DomainPersistResult` (`m365Sync/types.ts`, W04);
  `db` (`../../../db`); `M365SyncActionResult` (`@breeze/shared/m365`, W03);
  table `m365_users` (W02).
- Produces: `persistSigninActivity(ctx, result): Promise<SigninPersistResult>`
  where `SigninPersistResult = DomainPersistResult & { continuation: string | null; unlicensed: boolean }`.
  Consumed by Task 4 (persister registration), Task 5 (`run.ts`) and Task 6
  (cadence signals).

- [ ] **Step 1: Write the failing test**

`apps/api/src/services/m365Sync/domains/signinActivity.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../db';
import { persistSigninActivity } from './signinActivity';

vi.mock('../../../db', () => ({
  db: { execute: vi.fn(async () => [{ updated: 0 }]) },
}));

const executeMock = vi.mocked(db.execute);
const ORG = '11111111-1111-4111-8111-111111111111';

function ctx() {
  return {
    orgId: ORG,
    tenantId: '22222222-2222-4222-8222-222222222222',
    connectionId: '33333333-3333-4333-8333-333333333333',
    generation: 7,
    existing: new Map<string, { coreHash: string; isStale: boolean }>(),
    now: new Date('2026-09-08T12:00:00.000Z'),
  };
}

function result(items: unknown[], extra: Record<string, unknown> = {}) {
  return {
    success: true as const,
    kind: 'sync' as const,
    items: items as Record<string, unknown>[],
    truncated: false,
    fetchedAt: '2026-09-08T00:00:00.000Z',
    sources: { signInActivity: 'ok' as const },
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  executeMock.mockResolvedValue([{ updated: 0 }] as never);
});

describe('persistSigninActivity', () => {
  it('issues one field-wise UPDATE for the page set and reports the updated count', async () => {
    executeMock.mockResolvedValueOnce([{ updated: 2 }] as never);
    const out = await persistSigninActivity(ctx(), result([
      { id: 'aaaaaaaa-0000-4000-8000-000000000001', lastSuccessfulSignInAt: '2026-09-01T10:00:00.000Z' },
      { id: 'aaaaaaaa-0000-4000-8000-000000000002', lastSuccessfulSignInAt: null },
    ]));
    expect(executeMock).toHaveBeenCalledOnce();
    expect(out.updated).toBe(2);
    expect(out.inserted).toBe(0);
    expect(out.stale).toBe(0);
    expect(out.continuation).toBeNull();
  });

  it('binds timestamps as ISO strings, never Date objects', async () => {
    await persistSigninActivity(ctx(), result([
      { id: 'aaaaaaaa-0000-4000-8000-000000000001', lastSuccessfulSignInAt: '2026-09-01T10:00:00.000Z' },
    ]));
    const params = (executeMock.mock.calls[0]![0] as { params: unknown[] }).params;
    expect(params.some((p) => p instanceof Date)).toBe(false);
    expect(params).toContain('2026-09-01T10:00:00.000Z');
  });

  it('issues NO statement and reports a complete run for an empty page set', async () => {
    const out = await persistSigninActivity(ctx(), result([]));
    expect(executeMock).not.toHaveBeenCalled();
    expect(out.updated).toBe(0);
    expect(out.complete).toBe(true);
  });

  it('carries the continuation through and marks the run incomplete', async () => {
    const out = await persistSigninActivity(ctx(), result(
      [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', lastSuccessfulSignInAt: null }],
      { continuation: 'opaque-blob' },
    ));
    expect(out.continuation).toBe('opaque-blob');
    expect(out.complete).toBe(false);
  });

  it('treats an unlicensed tenant as a complete, zero-update success', async () => {
    const out = await persistSigninActivity(ctx(), {
      success: true, kind: 'sync', items: [], truncated: false,
      fetchedAt: '2026-09-08T00:00:00.000Z',
      sources: { signInActivity: 'unlicensed' },
    });
    expect(executeMock).not.toHaveBeenCalled();
    expect(out.unlicensed).toBe(true);
    expect(out.complete).toBe(true);
    expect(out.counts).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/m365Sync/domains/signinActivity.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

`apps/api/src/services/m365Sync/domains/signinActivity.ts`:

```ts
import { sql } from 'drizzle-orm';
import type { M365SyncActionResult } from '@breeze/shared/m365';
import { db } from '../../../db';
import type { DomainPersistResult, PersistContext } from '../types';

export interface SigninPersistResult extends DomainPersistResult {
  /** Opaque executor blob; non-null means more pages remain (spec §4.1). */
  continuation: string | null;
  /** Tenant has no Entra P1: success with zero updates, interval → max (§6). */
  unlicensed: boolean;
}

interface SigninItem { id: string; lastSuccessfulSignInAt: string | null }

function parseItems(items: Record<string, unknown>[]): SigninItem[] {
  const seen = new Set<string>();
  const parsed: SigninItem[] = [];
  for (const item of items) {
    const id = typeof item.id === 'string' ? item.id : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const raw = item.lastSuccessfulSignInAt;
    parsed.push({ id, lastSuccessfulSignInAt: typeof raw === 'string' ? raw : null });
  }
  return parsed;
}

/**
 * Sign-in activity is NOT an entity domain: it never inserts, never marks
 * stale, and never touches core_hash. It updates one nullable column on rows
 * that already exist, matched by (org_id, graph_id). Users the users domain has
 * not yet seen are simply not matched — the next users run inserts them and the
 * next sign-in run fills the timestamp (spec §5.5).
 *
 * `IS DISTINCT FROM` keeps this change-only: a tenant whose people did not sign
 * in since the last run writes zero rows. Timestamps are bound as ISO strings
 * and cast in SQL — a JS `Date` inside a raw drizzle fragment throws in
 * postgres.js at bind time (Buffer.byteLength on a Date), which compiled-SQL
 * unit tests do not catch.
 */
export async function persistSigninActivity(
  ctx: PersistContext,
  result: M365SyncActionResult,
): Promise<SigninPersistResult> {
  const unlicensed = result.sources.signInActivity === 'unlicensed';
  const continuation = typeof result.continuation === 'string' && result.continuation.length > 0
    ? result.continuation
    : null;
  const base: SigninPersistResult = {
    inserted: 0,
    updated: 0,
    stale: 0,
    unchanged: 0,
    counts: {},
    // A page that still has a continuation has not enumerated the tenant, so it
    // is not a complete snapshot; an unlicensed tenant IS complete (there is
    // nothing to enumerate).
    complete: continuation === null && result.sources.signInActivity !== 'error',
    continuation,
    unlicensed,
  };
  if (unlicensed) return { ...base, complete: true };

  const items = parseItems(result.items);
  if (items.length === 0) return base;

  const values = sql.join(
    items.map((item) => sql`(${item.id}::text, ${item.lastSuccessfulSignInAt}::timestamptz)`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    WITH page (graph_id, signed_in_at) AS (VALUES ${values}),
    updated AS (
      UPDATE m365_users u
      SET last_successful_sign_in_at = p.signed_in_at
      FROM page p
      WHERE u.org_id = ${ctx.orgId}::uuid
        AND u.graph_id = p.graph_id
        AND u.last_successful_sign_in_at IS DISTINCT FROM p.signed_in_at
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM updated)::int AS updated
  `)) as unknown as Array<{ updated: number }>;

  const updated = Number(rows[0]?.updated ?? 0);
  return { ...base, updated, unchanged: Math.max(items.length - updated, 0) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/m365Sync/domains/signinActivity.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365Sync/domains/signinActivity.ts \
        apps/api/src/services/m365Sync/domains/signinActivity.test.ts
git commit -m "feat(m365): sign-in activity persister (field-wise, change-only)

Spec §5.5/§6. One set-based UPDATE ... FROM (VALUES ...) keyed on
(org_id, graph_id) over the page set; users m365_users has not seen yet are
simply unmatched. IS DISTINCT FROM keeps it change-only. Timestamps are bound
as ISO strings and cast in SQL — a JS Date inside a raw drizzle fragment
throws at bind time in postgres.js and compiled-SQL tests do not catch it.

An unlicensed tenant (no Entra P1) is a complete, zero-update success; a
returned continuation marks the run incomplete and is handed back to run.ts.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 3: `domains/secureScore.ts` — Graph-dated snapshots with first-run backfill

Spec §3.3, §4.1 (`$top` 90 vs 3), §5.9 counts.

**Files:**
- Create: `apps/api/src/services/m365Sync/domains/secureScore.ts`
- Create: `apps/api/src/services/m365Sync/domains/secureScore.test.ts`

**Interfaces:**
- Consumes: `PersistContext`, `DomainPersistResult` (W04); `db`;
  `M365SyncActionResult` (W03); table `m365_secure_score_snapshots` (W02).
  The `backfill` flag never reaches this module: `run.ts` builds the action with
  W04's `m365SyncActionFor(domain, { backfill: state.lastSuccessAt === null })`
  (Task 5), and `state.lastSuccessAt` is already selected by W04's Phase A.
- Produces: `persistSecureScore(ctx, result): Promise<DomainPersistResult>`.

- [ ] **Step 1: Write the failing test**

`apps/api/src/services/m365Sync/domains/secureScore.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../db';
import { persistSecureScore } from './secureScore';

vi.mock('../../../db', () => ({ db: { execute: vi.fn(async () => [{ written: 0 }]) } }));

const executeMock = vi.mocked(db.execute);
const ORG = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';

function ctx() {
  return {
    orgId: ORG, tenantId: TENANT,
    connectionId: '33333333-3333-4333-8333-333333333333',
    generation: 2,
    existing: new Map<string, { coreHash: string; isStale: boolean }>(),
    now: new Date('2026-09-08T12:00:00.000Z'),
  };
}

function score(overrides: Record<string, unknown> = {}) {
  return {
    id: 'score-1',
    createdDateTime: '2026-09-07T02:00:00.000Z',
    currentScore: 412.5,
    maxScore: 600,
    activeUserCount: 120,
    licensedUserCount: 150,
    controlScores: [{ controlName: 'MFA', score: 10, maxScore: 20, implementationStatus: 'partial' }],
    ...overrides,
  };
}

function result(items: unknown[]) {
  return {
    success: true as const, kind: 'sync' as const,
    items: items as Record<string, unknown>[],
    truncated: false, fetchedAt: '2026-09-08T00:00:00.000Z',
    sources: { secureScores: 'ok' as const, controlProfiles: 'ok' as const },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  executeMock.mockResolvedValue([{ written: 0 }] as never);
});

describe('persistSecureScore', () => {
  it('keys the row on the UTC date of the Graph createdDateTime, not the fetch day', async () => {
    await persistSecureScore(ctx(), result([score()]));
    const params = (executeMock.mock.calls[0]![0] as { params: unknown[] }).params;
    expect(params).toContain('2026-09-07T02:00:00.000Z');
    // the fetch day (2026-09-08) must never be bound as a score_date
    expect(params).not.toContain('2026-09-08');
  });

  it('binds the connection tenant on every row', async () => {
    await persistSecureScore(ctx(), result([score(), score({ id: 'score-2', createdDateTime: '2026-09-06T02:00:00.000Z' })]));
    const params = (executeMock.mock.calls[0]![0] as { params: unknown[] }).params;
    expect(params.filter((p) => p === TENANT).length).toBe(2);
  });

  it('reports secure_score and secure_score_max from the NEWEST score', async () => {
    const out = await persistSecureScore(ctx(), result([
      score({ id: 'old', createdDateTime: '2026-09-01T02:00:00.000Z', currentScore: 100, maxScore: 600 }),
      score({ id: 'new', createdDateTime: '2026-09-07T02:00:00.000Z', currentScore: 412.5, maxScore: 600 }),
      score({ id: 'mid', createdDateTime: '2026-09-04T02:00:00.000Z', currentScore: 300, maxScore: 600 }),
    ]));
    expect(out.counts).toEqual({ secure_score: 412.5, secure_score_max: 600 });
  });

  it('collapses two scores from the same Graph day to one row (last write wins)', async () => {
    await persistSecureScore(ctx(), result([
      score({ id: 'a', createdDateTime: '2026-09-07T02:00:00.000Z', currentScore: 400 }),
      score({ id: 'b', createdDateTime: '2026-09-07T18:00:00.000Z', currentScore: 420 }),
    ]));
    expect(executeMock).toHaveBeenCalledOnce();
    const params = (executeMock.mock.calls[0]![0] as { params: unknown[] }).params;
    expect(params).toContain(420);
    expect(params).not.toContain(400);
  });

  it('drops a score with an unparseable createdDateTime rather than failing the chunk', async () => {
    const out = await persistSecureScore(ctx(), result([
      score({ id: 'bad', createdDateTime: 'not-a-date' }),
      score({ id: 'good' }),
    ]));
    expect(out.inserted + out.updated).toBeGreaterThanOrEqual(0);
    const params = (executeMock.mock.calls[0]![0] as { params: unknown[] }).params;
    expect(params).not.toContain('not-a-date');
  });

  it('issues no statement and stays complete for an empty score list', async () => {
    const out = await persistSecureScore(ctx(), result([]));
    expect(executeMock).not.toHaveBeenCalled();
    expect(out.complete).toBe(true);
    expect(out.counts).toEqual({});
  });

  it('is not complete when the primary source failed', async () => {
    const out = await persistSecureScore(ctx(), {
      success: true, kind: 'sync', items: [], truncated: false,
      fetchedAt: '2026-09-08T00:00:00.000Z',
      sources: { secureScores: 'error', controlProfiles: 'ok' },
    });
    expect(out.complete).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/m365Sync/domains/secureScore.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

`apps/api/src/services/m365Sync/domains/secureScore.ts`:

```ts
import { sql } from 'drizzle-orm';
import type { M365SyncActionResult } from '@breeze/shared/m365';
import { db } from '../../../db';
import type { DomainPersistResult, PersistContext } from '../types';

interface ParsedScore {
  createdDateTime: string;
  currentScore: number | null;
  maxScore: number | null;
  activeUserCount: number | null;
  licensedUserCount: number | null;
  controlScores: unknown[];
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Newest-first, deduped by the UTC calendar day of Graph's own
 * `createdDateTime`. Graph revises the last day or two, and a backfill call
 * ($top=90) can return two entries for one day; the unique key is
 * (org_id, score_date), so the newest entry for a day must be the one that
 * survives — hence the sort BEFORE the dedupe.
 */
function parseScores(items: Record<string, unknown>[]): ParsedScore[] {
  const parsed = items.flatMap((item) => {
    const created = typeof item.createdDateTime === 'string' ? item.createdDateTime : null;
    if (!created || !Number.isFinite(Date.parse(created))) return [];
    return [{
      createdDateTime: created,
      currentScore: num(item.currentScore),
      maxScore: num(item.maxScore),
      activeUserCount: num(item.activeUserCount),
      licensedUserCount: num(item.licensedUserCount),
      controlScores: Array.isArray(item.controlScores) ? item.controlScores : [],
    }];
  });
  parsed.sort((a, b) => Date.parse(b.createdDateTime) - Date.parse(a.createdDateTime));
  const byDay = new Map<string, ParsedScore>();
  for (const score of parsed) {
    const day = score.createdDateTime.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, score);
  }
  return [...byDay.values()];
}

/**
 * Secure Score is a time series, not an entity table: nothing is ever marked
 * stale and there is no core_hash. Rows are keyed by Graph's own date so a
 * backfill lands on the days it describes rather than the day it was fetched
 * (spec §3.3), and the date is computed in SQL from the bound ISO timestamp so
 * the API process's local zone can never shift a day boundary.
 */
export async function persistSecureScore(
  ctx: PersistContext,
  result: M365SyncActionResult,
): Promise<DomainPersistResult> {
  const complete = result.sources.secureScores === 'ok' && !result.truncated;
  const scores = parseScores(result.items);
  const base: DomainPersistResult = {
    inserted: 0, updated: 0, stale: 0, unchanged: 0, counts: {}, complete,
  };
  if (scores.length === 0) return base;

  const values = sql.join(
    scores.map((s) => sql`(
      ${ctx.orgId}::uuid,
      ${ctx.tenantId}::uuid,
      ((${s.createdDateTime}::timestamptz) AT TIME ZONE 'UTC')::date,
      ${s.currentScore}::numeric(8,2),
      ${s.maxScore}::numeric(8,2),
      ${s.activeUserCount}::int,
      ${s.licensedUserCount}::int,
      ${JSON.stringify(s.controlScores)}::jsonb
    )`),
    sql`, `,
  );

  const rows = (await db.execute(sql`
    WITH written AS (
      INSERT INTO m365_secure_score_snapshots (
        org_id, tenant_id, score_date, current_score, max_score,
        active_user_count, licensed_user_count, control_scores
      )
      VALUES ${values}
      ON CONFLICT (org_id, score_date) DO UPDATE SET
        tenant_id = excluded.tenant_id,
        current_score = excluded.current_score,
        max_score = excluded.max_score,
        active_user_count = excluded.active_user_count,
        licensed_user_count = excluded.licensed_user_count,
        control_scores = excluded.control_scores
      RETURNING (xmax = 0) AS inserted
    )
    SELECT
      (SELECT count(*) FROM written WHERE inserted)::int      AS inserted,
      (SELECT count(*) FROM written WHERE NOT inserted)::int  AS updated
  `)) as unknown as Array<{ inserted: number; updated: number }>;

  const newest = scores[0]!;
  const counts: Record<string, number> = {};
  if (newest.currentScore !== null) counts.secure_score = newest.currentScore;
  if (newest.maxScore !== null) counts.secure_score_max = newest.maxScore;

  return {
    ...base,
    inserted: Number(rows[0]?.inserted ?? 0),
    updated: Number(rows[0]?.updated ?? 0),
    counts,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/m365Sync/domains/secureScore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365Sync/domains/secureScore.ts \
        apps/api/src/services/m365Sync/domains/secureScore.test.ts
git commit -m "feat(m365): Secure Score snapshots keyed by Graph's own date

Spec §3.3/§4.1. Rows are keyed (org_id, score_date) where score_date is the UTC
calendar day of Graph's createdDateTime, computed in SQL from the bound ISO
timestamp so the API process zone cannot shift a day boundary — a 90-day
backfill therefore lands on the days it describes, not the fetch day. Two
scores for one Graph day collapse newest-wins before the insert, because the
unique key would otherwise make the order of a single VALUES list decide.

The backfill flag itself carries no column: run.ts passes
m365SyncActionFor(domain, { backfill: state.lastSuccessAt === null }), so a
rebind (which deletes the state rows) re-backfills.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 4: switch the last two domains on — `DOMAIN_PERSISTERS` and `M365_SYNC_IMPLEMENTED_DOMAINS`

Spec §5.2 (the ticker only claims what it can run), §10.2. W04 deliberately
shipped four of six: `signin_activity` and `secure_score` had no persister, so
`DOMAIN_PERSISTERS` left them `undefined` (every run returns `'noop'`) and
`M365_SYNC_IMPLEMENTED_DOMAINS` excluded them (`reconcileEligibleConnections`
never seeded them, so they could not be claimed with nothing to run and burn a
ticker slot every minute forever). Tasks 2 and 3 landed both persisters; this
task is the single switch that turns the two domains on, and it is deliberately
its own task so the flip is one reviewable commit rather than a line buried in a
persister.

**Files:**
- Modify: `apps/api/src/services/m365Sync/run.ts` (the `DOMAIN_PERSISTERS` map)
- Modify: `apps/api/src/services/m365Sync/run.test.ts`
- Modify: `apps/api/src/services/m365Sync/types.ts` (`M365_SYNC_IMPLEMENTED_DOMAINS`)
- Modify: `apps/api/src/services/m365Sync/claim.sql.test.ts`
- Modify: `apps/api/src/__tests__/integration/m365SyncClaim.integration.test.ts`

**Interfaces:**
- Consumes: `persistSigninActivity` (Task 2), `persistSecureScore` (Task 3),
  `M365_SYNC_DOMAINS` (`@breeze/shared/m365`, W03).
- Produces: no new export. `DOMAIN_PERSISTERS` becomes total over
  `M365SyncDomain`, and `M365_SYNC_IMPLEMENTED_DOMAINS` becomes
  `M365_SYNC_DOMAINS`.

**Two W04 assertions are inverted here, not deleted.** Both are marked in W04's
plan as "W05 inverts this"; they exist precisely so this flip cannot happen by
accident. Inverting them in the same commit as the constant is what keeps the
constant and the SQL that reads it in step.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/services/m365Sync/run.test.ts` (extend the file's
existing mocks; do not add a second `vi.mock` for a module it already mocks):

```ts
import { persistSecureScore } from './domains/secureScore';
import { persistSigninActivity } from './domains/signinActivity';

// add to the file's existing vi.mock list:
vi.mock('./domains/signinActivity', () => ({ persistSigninActivity: vi.fn() }));
vi.mock('./domains/secureScore', () => ({ persistSecureScore: vi.fn() }));

describe('every domain has a persister', () => {
  const persisted = {
    inserted: 0, updated: 0, stale: 0, unchanged: 0, counts: {}, complete: true,
  };

  it.each([
    ['signin_activity', () => vi.mocked(persistSigninActivity).mockResolvedValue({
      ...persisted, continuation: null, unlicensed: false,
    })],
    ['secure_score', () => vi.mocked(persistSecureScore).mockResolvedValue(persisted)],
  ] as const)('runs %s instead of returning noop', async (domain, arm) => {
    arm();
    installExecutableSnapshot({});                 // helpers already in this file
    installExecutorResult({ items: [], sources: {} });

    const outcome = await runSyncDomain({ ...USERS_JOB, domain });

    // 'noop' is what W04 returns when DOMAIN_PERSISTERS[domain] is undefined —
    // the exact regression this task exists to close.
    expect(outcome).not.toBe('noop');
  });

  it('has an entry for all six contracted domains', () => {
    expect(Object.keys(DOMAIN_PERSISTERS).sort()).toEqual([...M365_SYNC_DOMAINS].sort());
    for (const domain of M365_SYNC_DOMAINS) {
      expect(DOMAIN_PERSISTERS[domain]).toBeTypeOf('function');
    }
  });
});

describe('M365_SYNC_IMPLEMENTED_DOMAINS', () => {
  it('is now the full contracted domain set', () => {
    expect([...M365_SYNC_IMPLEMENTED_DOMAINS].sort()).toEqual([...M365_SYNC_DOMAINS].sort());
    expect(M365_SYNC_IMPLEMENTED_DOMAINS).toHaveLength(6);
  });
});
```

with `DOMAIN_PERSISTERS`, `M365_SYNC_IMPLEMENTED_DOMAINS` and `M365_SYNC_DOMAINS`
added to the file's imports.

Then **invert** W04's two exclusions in
`apps/api/src/services/m365Sync/claim.sql.test.ts` — the case is currently named
`'seeds ONLY the domains this wave can persist'` and its last two lines are the
ones marked "W05 inverts this":

```ts
  it('seeds every contracted domain', () => {
    const { params } = dialect.sqlToQuery(buildReconcileEligibleSql(NOW));
    expect(params).toContain('users');
    expect(params).toContain('intune_devices');
    expect(params).toContain('ca_policies');
    expect(params).toContain('skus');
    // W05 inverted these two: both domains now have persisters, so seeding them
    // gives the ticker work to do rather than a row it can only re-claim.
    expect(params).toContain('signin_activity');
    expect(params).toContain('secure_score');
  });
```

and update the interval assertion in the sibling case so the sign-in floor is
covered:

```ts
  it('seeds each domain with its own default interval', () => {
    const { params } = dialect.sqlToQuery(buildReconcileEligibleSql(NOW));
    expect(params).toContain(6 * 3600);   // users, intune_devices
    expect(params).toContain(24 * 3600);  // ca_policies, skus, secure_score, signin_activity
  });
```

Then update W04's real-Postgres reconcile case in
`apps/api/src/__tests__/integration/m365SyncClaim.integration.test.ts` — the
count and the domain list both move:

```ts
  runDb('reconcile seeds all six domains once and is idempotent', async () => {
    const t = await seedConnection();

    expect(await reconcileEligibleConnections()).toBe(6);
    expect(await reconcileEligibleConnections()).toBe(0);

    const rows = await withSystemDbAccessContext(() =>
      db.select().from(m365SyncState).where(eq(m365SyncState.orgId, t.orgId)));
    expect(rows.map((r) => r.domain).sort()).toEqual([
      'ca_policies', 'intune_devices', 'secure_score', 'signin_activity', 'skus', 'users',
    ]);
    for (const row of rows) {
      const ahead = row.nextSyncAt!.getTime() - Date.now();
      expect(ahead).toBeGreaterThanOrEqual(-5_000);
      expect(ahead).toBeLessThanOrEqual(3_600_000 + 5_000);
    }
    expect(rows.find((r) => r.domain === 'users')!.intervalSeconds).toBe(21600);
    expect(rows.find((r) => r.domain === 'skus')!.intervalSeconds).toBe(86400);
    expect(rows.find((r) => r.domain === 'signin_activity')!.intervalSeconds).toBe(86400);
  });
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd apps/api && npx vitest run \
  src/services/m365Sync/run.test.ts \
  src/services/m365Sync/claim.sql.test.ts
```

Expected: FAIL — `runSyncDomain` returns `'noop'` for both new domains,
`DOMAIN_PERSISTERS` has four keys, `M365_SYNC_IMPLEMENTED_DOMAINS` has four
entries, and the reconcile SQL still omits the two domain literals.

- [ ] **Step 3: Register the persisters**

In `apps/api/src/services/m365Sync/run.ts`, import both and add them to the map
W04 left partial:

```ts
import { persistSecureScore } from './domains/secureScore';
import { persistSigninActivity } from './domains/signinActivity';

// Total over M365SyncDomain as of W05. An `undefined` entry means the worker
// answers 'noop' and the state row is completed as domain_not_implemented, so
// a missing key here is a silently dead domain, not a type error.
export const DOMAIN_PERSISTERS: Record<M365SyncDomain, M365DomainPersister | undefined> = {
  users: persistUsers,
  signin_activity: persistSigninActivity,
  intune_devices: persistIntuneDevices,
  ca_policies: persistCaPolicies,
  skus: persistSkus,
  secure_score: persistSecureScore,
};
```

`persistSigninActivity` returns `SigninPersistResult`, a structural superset of
`DomainPersistResult`, so it satisfies `M365DomainPersister` without a cast;
Task 5 narrows it back to the richer type at its own call site, which is where
the continuation is actually read.

- [ ] **Step 4: Widen the implemented set**

In `apps/api/src/services/m365Sync/types.ts`, replace W04's four-entry literal:

```ts
/**
 * Domains the worker can actually persist. `reconcileEligibleConnections` seeds
 * exactly these. W04 shipped four because `signin_activity` and `secure_score`
 * had no persister and would have been re-claimed every tick with nothing to
 * run; W05 landed both persisters (see DOMAIN_PERSISTERS in run.ts), so the set
 * is now the whole contracted domain list.
 */
export const M365_SYNC_IMPLEMENTED_DOMAINS: readonly M365SyncDomain[] = M365_SYNC_DOMAINS;
```

with `M365_SYNC_DOMAINS` imported from `@breeze/shared/m365`. Assigning the
shared constant rather than retyping the six literals is deliberate: a seventh
domain added to the contract then cannot be silently left unseeded.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd apps/api && npx vitest run \
  src/services/m365Sync/run.test.ts \
  src/services/m365Sync/claim.sql.test.ts \
  src/services/m365Sync/claim.test.ts
```
Expected: PASS.

The integration case is verified with the rest of the real-database work in
Task 17 (it needs `DATABASE_URL`); run it now if your test database is already
up:

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/m365SyncClaim.integration.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/m365Sync/run.ts \
        apps/api/src/services/m365Sync/run.test.ts \
        apps/api/src/services/m365Sync/types.ts \
        apps/api/src/services/m365Sync/claim.sql.test.ts \
        apps/api/src/__tests__/integration/m365SyncClaim.integration.test.ts
git commit -m "feat(m365): enable signin_activity and secure_score sync domains

W04 shipped four of the six contracted domains: the other two had no persister,
so DOMAIN_PERSISTERS left them undefined (every run answered 'noop') and
M365_SYNC_IMPLEMENTED_DOMAINS excluded them so the ticker would not seed rows it
could only re-claim forever. Both persisters landed in this wave, so this
registers them and widens the constant to M365_SYNC_DOMAINS — assigning the
shared list rather than retyping six literals, so a future seventh domain cannot
be silently left unseeded.

The two W04 assertions marked 'W05 inverts this' are inverted here rather than
deleted, and the real-Postgres reconcile case moves from four rows to six.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 5: `run.ts` — the sign-in continuation loop

Spec §5.7 ("a run that returns a continuation re-claims itself immediately at
priority 10, new generation"), §6 row 5, §5.2 priority lanes.

**Files:**
- Modify: `apps/api/src/services/m365Sync/run.ts`
- Modify: `apps/api/src/services/m365Sync/run.test.ts`

**Interfaces:**
- Consumes: `M365SyncJobData`, `M365SyncOutcome`, **`M365SyncRunResult`** and
  `m365SyncActionFor` (`m365Sync/types.ts`, W04); `claimAndEnqueue`
  (`m365Sync/claim.ts`, W04); `writeCompletion` and `SyncRunContext`
  (`m365Sync/run.ts`, W04); `persistSigninActivity` (Task 2); `m365SyncState`
  (W02).
- Produces: **no new export and no signature change.** `runSyncDomain` already
  returns `Promise<M365SyncRunResult>`, and `M365SyncRunResult` already includes
  `'partial-continue'` (contract; Decision 1). **Do not redeclare the type in
  this file** — import it from `./types`. This task only makes `runSyncDomain`
  actually *return* the value on the sign-in path.

**Two W04 helpers do the work; this task writes no new plumbing.**

- The action is built by `m365SyncActionFor(data.domain, { continuation: loaded.state.continuation, backfill: loaded.state.lastSuccessAt === null })`.
  There is **no local `buildSyncAction`** — W04 owns the domain→action map, and a
  second builder would drift from `M365_SYNC_DOMAIN_ACTION_ID`.
  `loaded.state.lastSuccessAt` is already selected by W04's Phase A, so nothing
  extra is queried for the Secure Score backfill flag.
- The narrow completion write is `writeCompletion(ctx, { mode: 'continuation', continuation })`,
  W04's documented continuation mode. **Do not open a transaction or hand-write
  a `tx.update(m365SyncState)` here** — the completion write is W04's single
  place for lease release, audit event and structured log, and a second writer
  would bypass all three.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/m365Sync/run.test.ts` (extend the existing
mocks in that file; Task 4 already added the `./domains/signinActivity` mock —
do not add a second `vi.mock` for the same module):

```ts
import { claimAndEnqueue } from './claim';
import { persistSigninActivity } from './domains/signinActivity';

const claimAndEnqueueMock = vi.mocked(claimAndEnqueue);
const persistSigninMock = vi.mocked(persistSigninActivity);

const SIGNIN_JOB = {
  orgId: '11111111-1111-4111-8111-111111111111',
  domain: 'signin_activity' as const,
  generation: 3,
  connectionId: '33333333-3333-4333-8333-333333333333',
  tenantId: '22222222-2222-4222-8222-222222222222',
  consentGeneration: 1,
  priority: 10 as const,
};

describe('sign-in continuation loop', () => {
  it('returns partial-continue and re-claims a NEW generation at priority 10', async () => {
    persistSigninMock.mockResolvedValue({
      inserted: 0, updated: 5, stale: 0, unchanged: 0, counts: {},
      complete: false, continuation: 'blob-2', unlicensed: false,
    });
    installExecutableSnapshot({ continuation: 'blob-1' });   // helper in this file
    installExecutorResult({ continuation: 'blob-2', items: [], sources: { signInActivity: 'ok' } });

    const outcome = await runSyncDomain(SIGNIN_JOB);

    expect(outcome).toBe('partial-continue');
    expect(claimAndEnqueueMock).toHaveBeenCalledWith(SIGNIN_JOB.orgId, ['signin_activity'], 10);
    // last_status / last_success_at / next_sync_at are untouched while a
    // continuation is outstanding (spec §6 "unchanged until exhausted"), which
    // is exactly what writeCompletion's continuation mode guarantees: it stores
    // the blob, clears the lease, and writes no audit event.
    const set = capturedStateCompletionSet();
    expect(set).toHaveProperty('continuation', 'blob-2');
    expect(set).toHaveProperty('leaseUntil', null);
    expect(set).not.toHaveProperty('lastStatus');
    expect(set).not.toHaveProperty('lastSuccessAt');
    expect(set).not.toHaveProperty('nextSyncAt');
    expect(recordRunEventMock).not.toHaveBeenCalled();
  });

  it('does not advance cadence or run the post-commit hook on a continuation page', async () => {
    persistSigninMock.mockResolvedValue({
      inserted: 0, updated: 5, stale: 0, unchanged: 0, counts: {},
      complete: false, continuation: 'blob-2', unlicensed: false,
    });
    installExecutableSnapshot({ continuation: 'blob-1' });
    installExecutorResult({ continuation: 'blob-2', items: [], sources: { signInActivity: 'ok' } });

    await runSyncDomain(SIGNIN_JOB);

    // Making progress must not stretch the interval, and there is no complete
    // snapshot to roll up yet.
    expect(applyCadenceMock).not.toHaveBeenCalled();
    expect(afterDomainPersistedMock).not.toHaveBeenCalled();
  });

  it('clears the continuation and completes normally on the last page', async () => {
    persistSigninMock.mockResolvedValue({
      inserted: 0, updated: 1, stale: 0, unchanged: 0, counts: {},
      complete: true, continuation: null, unlicensed: false,
    });
    installExecutableSnapshot({ continuation: 'blob-1' });
    installExecutorResult({ items: [], sources: { signInActivity: 'ok' } });

    const outcome = await runSyncDomain(SIGNIN_JOB);

    expect(outcome).toBe('success');
    expect(claimAndEnqueueMock).not.toHaveBeenCalled();
    const set = capturedStateCompletionSet();
    expect(set).toHaveProperty('continuation', null);
    expect(set).toHaveProperty('lastStatus', 'success');
    expect(set).toHaveProperty('nextSyncAt');
    expect(applyCadenceMock).toHaveBeenCalledOnce();
    expect(afterDomainPersistedMock).toHaveBeenCalledOnce();
  });

  it('passes the stored continuation into the executor action', async () => {
    persistSigninMock.mockResolvedValue({
      inserted: 0, updated: 0, stale: 0, unchanged: 0, counts: {},
      complete: true, continuation: null, unlicensed: false,
    });
    installExecutableSnapshot({ continuation: 'stored-blob' });
    installExecutorResult({ items: [], sources: { signInActivity: 'ok' } });

    await runSyncDomain(SIGNIN_JOB);

    expect(capturedExecutorAction()).toEqual({
      type: 'm365.sync.signin_activity',
      continuation: 'stored-blob',
    });
  });

  it('restarts from page 1 once W04 has cleared an invalid continuation', async () => {
    // The executor answering { code: 'continuation_invalid' } is handled ENTIRELY
    // by W04: run.ts clears m365_sync_state.continuation and re-claims the
    // domain. This wave adds no branch for that code. All it must guarantee is
    // that the re-claimed run — whose state row now carries continuation NULL —
    // asks for page 1 instead of resending a blob the executor rejected.
    persistSigninMock.mockResolvedValue({
      inserted: 0, updated: 0, stale: 0, unchanged: 0, counts: {},
      complete: true, continuation: null, unlicensed: false,
    });
    installExecutableSnapshot({ continuation: null });
    installExecutorResult({ items: [], sources: { signInActivity: 'ok' } });

    await runSyncDomain(SIGNIN_JOB);

    expect(capturedExecutorAction()).toEqual({ type: 'm365.sync.signin_activity' });
  });

  it('builds the secure_score action with backfill on a never-succeeded state row', async () => {
    installExecutableSnapshot({ lastSuccessAt: null });
    installExecutorResult({ items: [], sources: { secureScores: 'ok' } });

    await runSyncDomain({ ...SIGNIN_JOB, domain: 'secure_score' });

    expect(capturedExecutorAction()).toEqual({ type: 'm365.sync.secure_score', backfill: true });
  });

  it('does NOT re-claim from a fenced run', async () => {
    // Fencing already returns before Phase C; prove no enqueue leaks from a
    // fenced run (a late job must never resurrect the loop).
    installFencedSnapshot();
    const outcome = await runSyncDomain(SIGNIN_JOB);
    expect(outcome).toBe('fenced');
    expect(claimAndEnqueueMock).not.toHaveBeenCalled();
  });
});
```

`writeCompletion` is module-private in W04's `run.ts`, so do **not** try to spy
on it. `capturedStateCompletionSet()` is a small helper next to the file's
existing `installExecutorResult` that reads the `m365_sync_state` update payload
out of the `../../db` mock `run.test.ts` already installs — the completion write
is observable there. `applyCadenceMock`, `afterDomainPersistedMock` and
`recordRunEventMock` are the mocks W04's own seam test already installs for
`./cadence`, `./hooks` and `./audit`. Reuse all of them rather than adding new
ones.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/m365Sync/run.test.ts`
Expected: FAIL — `runSyncDomain` never returns `'partial-continue'`, never calls
`claimAndEnqueue`, and never uses `writeCompletion`'s continuation mode.

- [ ] **Step 3: Implement**

In `apps/api/src/services/m365Sync/run.ts`:

1. Import the loop's two collaborators. **Nothing about the signature changes** —
   `runSyncDomain` already returns `Promise<M365SyncRunResult>` and that type
   already contains `'partial-continue'`:

```ts
import { claimAndEnqueue } from './claim';
import { persistSigninActivity } from './domains/signinActivity';
// M365SyncRunResult stays imported from './types' — do not redeclare it here.
```

2. Phase B — build the action with W04's builder. There is no local
   `buildSyncAction`; both options come straight off the snapshot Phase A
   already loaded:

```ts
    const action = m365SyncActionFor(data.domain, {
      continuation: loaded.state.continuation,
      backfill: loaded.state.lastSuccessAt === null,
    });
```

   `m365SyncActionFor` ignores `continuation` for every domain but
   `signin_activity` and `backfill` for every domain but `secure_score`, so one
   call site covers all six.

3. Phase C — a continuation page takes W04's narrow completion mode instead of
   the normal one:

```ts
if (data.domain === 'signin_activity') {
  const persisted = await persistSigninActivity(ctx, executorResult);

  if (persisted.continuation !== null) {
    // Spec §6: the sync state is "unchanged until exhausted". writeCompletion's
    // continuation mode moves only the continuation, last_run_at and the lease;
    // last_status, last_success_at, last_complete_snapshot_at and next_sync_at
    // are left exactly as the previous completed run set them, so a mid-loop
    // crash still leaves an honest "as of" for the UI. It is still ONE short
    // system transaction, with the same lease release, audit event and log line
    // as any other completion — which is why this path must not hand-write its
    // own UPDATE.
    await writeCompletion(ctx, { mode: 'continuation', continuation: persisted.continuation });
    recordM365SyncRun(data.domain, 'partial-continue');
    // Enqueue AFTER the completion write commits — an enqueue that raced a
    // rollback would run a job against a generation that never existed.
    // claimAndEnqueue bumps the generation itself.
    scheduleAfterCommit = () => claimAndEnqueue(data.orgId, ['signin_activity'], 10);
    return 'partial-continue';
  }
  // Exhausted: fall through to the normal completion path, which writes
  // continuation: null along with the rest of the completion.
}
```

   `scheduleAfterCommit` is a `(() => Promise<void>) | null` declared outside the
   completion call and awaited immediately after it returns, inside a
   `try { … } catch` that logs and swallows: a failed re-enqueue is recovered by
   the ticker (the row's `next_sync_at` is still in the past and the lease is
   cleared).

4. `applyCadence` and `afterDomainPersisted` are **not** reached on the
   `'partial-continue'` path — the loop must not stretch the interval for making
   progress, and there is no complete snapshot to roll up. The early `return`
   above is what guarantees it; the second test in Step 1 pins it so a later
   refactor that moves the cadence call earlier fails loudly.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/m365Sync/run.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365Sync/run.ts \
        apps/api/src/services/m365Sync/run.test.ts
git commit -m "feat(m365): sign-in continuation loop

Spec §5.7/§6. A signin_activity run that comes back with a continuation stores
the opaque blob through writeCompletion's continuation mode — which leaves
last_status/last_success_at/next_sync_at untouched, clears the lease and keeps
the single audit event and log line — then re-claims itself at priority 10 for a
new generation. The loop ends when the executor returns no continuation, and
only then does the run complete, advance cadence and run the post-commit hook.

The action is built by W04's m365SyncActionFor from the Phase A snapshot, so
there is no second domain-to-action map, and secure_score's backfill flag comes
from the same call via state.lastSuccessAt === null.

A continuation the executor rejects is W04's path: it clears the stored blob and
re-claims, and the re-claimed run simply asks for page 1.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 6: `cadence.ts` — adaptive interval behind the `applyCadence` seam

Spec §5.7, §6 (rows: truncated ×2, throttled/capacity ×1.5, unlicensed → max,
needs_consent / auth failure → `next_sync_at NULL`).

**Files:**
- Modify: `apps/api/src/services/m365Sync/cadence.ts` (W04 stub — **modify, never create**)
- Modify: `apps/api/src/services/m365Sync/cadence.test.ts` (W04 created it for the stub)
- Modify: `apps/api/src/services/m365Sync/run.ts` (signal assembly)

**Interfaces:**
- Consumes: `M365_SYNC_DOMAIN_INTERVAL_BOUNDS`,
  `M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS`, `M365SyncDomain`
  (`@breeze/shared/m365`, W03); `M365SyncOutcome` (W04); **`CadenceSignals`,
  already declared in this file by W04** — import the type at the `run.ts` call
  site, do not redeclare it anywhere (Decision 2).
- Produces: `nextInterval(domain, current, outcome, signals): number` (new);
  a real body for the contracted
  `applyCadence(domain, state, outcome, signals, rng?): { intervalSeconds; nextSyncAt: Date | null }`.
  Neither the signature nor `CadenceSignals` changes — this task is a body
  replacement, so there is nothing to record in the overview. **W04's exported
  `nextSyncAt(now, intervalSeconds, rng?)` (±10 % jitter) and the optional `rng`
  parameter stay exactly as they are**: `applyCadence` computes its due time by
  calling that helper, so there is one jitter implementation and the tests
  inject `rng` instead of stubbing `Math.random`.

**W04's `describe('applyCadence (W04 stub — W05 replaces the body)')` block is
replaced by this task's cases** — its "returns the STORED interval unchanged on
every outcome" assertion becomes false the moment the body is real. Keep W04's
`describe('nextSyncAt')` block untouched.

- [ ] **Step 1: Write the failing test**

In `apps/api/src/services/m365Sync/cadence.test.ts`, widen the import to pick up
`nextInterval` and reuse W04's existing `NOW` / `signals()` helpers rather than
declaring second copies — the snippet below shows them for reference only:

```ts
import { describe, expect, it } from 'vitest';
import { applyCadence, nextInterval, nextSyncAt, type CadenceSignals } from './cadence';

// Already in the file (W04) — do not duplicate:
const NOW = new Date('2026-09-08T12:00:00.000Z');
function signals(overrides: Partial<CadenceSignals> = {}): CadenceSignals {
  return {
    truncated: false, latencyMs: 1_000, capacity: false,
    unlicensed: false, authFailure: false, now: NOW,
    ...overrides,
  };
}

describe('nextInterval', () => {
  const cases: Array<[string, Parameters<typeof nextInterval>, number]> = [
    ['success at the default stays at the default',
      ['users', 21_600, 'success', signals()], 21_600],
    ['success above the default decays 25% toward it',
      ['users', 43_200, 'success', signals()], 37_800],
    ['success below the default decays 25% toward it (upward)',
      ['users', 7_200, 'success', signals()], 10_800],
    ['truncated doubles',
      ['users', 21_600, 'partial', signals({ truncated: true })], 43_200],
    ['slow executor (>60s) doubles even on success',
      ['users', 21_600, 'success', signals({ latencyMs: 61_000 })], 43_200],
    ['truncated wins over the success decay',
      ['users', 43_200, 'success', signals({ truncated: true })], 86_400],
    ['throttled multiplies by 1.5',
      ['users', 3_600, 'throttled', signals()], 5_400],
    ['executor sync_capacity multiplies by 1.5',
      ['users', 3_600, 'success', signals({ capacity: true })], 5_400],
    ['doubling clamps to the domain max',
      ['users', 172_800, 'partial', signals({ truncated: true })], 172_800],
    ['decay clamps to the domain min',
      ['users', 3_600, 'success', signals()], 7_200],
    ['unlicensed jumps straight to the domain max',
      ['signin_activity', 86_400, 'success', signals({ unlicensed: true })], 604_800],
    ['sign-in bounds are its own, not the shared ones',
      ['signin_activity', 86_400, 'partial', signals({ truncated: true })], 172_800],
    ['needs_consent leaves the interval alone',
      ['users', 21_600, 'needs_consent', signals()], 21_600],
    ['a terminal error leaves the interval alone',
      ['users', 21_600, 'error', signals()], 21_600],
  ];

  it.each(cases)('%s', (_name, args, expected) => {
    expect(nextInterval(...args)).toBe(expected);
  });

  it('never returns a non-integer', () => {
    expect(Number.isInteger(nextInterval('users', 3_601, 'throttled', signals()))).toBe(true);
  });
});

describe('applyCadence', () => {
  it('schedules the new interval through the shared jitter helper', () => {
    const out = applyCadence('users', { intervalSeconds: 21_600 }, 'success', signals(), () => 0.5);
    expect(out.intervalSeconds).toBe(21_600);
    // rng 0.5 is the midpoint of nextSyncAt's ±10% band, i.e. no offset.
    expect(out.nextSyncAt).toEqual(new Date(NOW.getTime() + 21_600_000));
  });

  it('spreads a cohort across the full ±10% band', () => {
    const early = applyCadence('users', { intervalSeconds: 21_600 }, 'success', signals(), () => 0);
    const late = applyCadence('users', { intervalSeconds: 21_600 }, 'success', signals(), () => 1);
    expect(early.nextSyncAt!.getTime() - NOW.getTime()).toBe(21_600_000 * 0.9);
    expect(late.nextSyncAt!.getTime() - NOW.getTime()).toBe(21_600_000 * 1.1);
  });

  it('decays the interval BEFORE scheduling, so the new value is what is stored and used', () => {
    const out = applyCadence('users', { intervalSeconds: 43_200 }, 'success', signals(), () => 0.5);
    expect(out.intervalSeconds).toBe(37_800);
    expect(out.nextSyncAt).toEqual(new Date(NOW.getTime() + 37_800_000));
  });

  it('unschedules on needs_consent', () => {
    const out = applyCadence('ca_policies', { intervalSeconds: 86_400 }, 'needs_consent', signals(), () => 0.5);
    expect(out.nextSyncAt).toBeNull();
    expect(out.intervalSeconds).toBe(86_400);
  });

  it('unschedules on a connection auth failure', () => {
    const out = applyCadence('users', { intervalSeconds: 21_600 }, 'error', signals({ authFailure: true }), () => 0.5);
    expect(out.nextSyncAt).toBeNull();
  });

  it('still schedules a non-auth terminal error so the ticker retries on cadence', () => {
    const out = applyCadence('users', { intervalSeconds: 21_600 }, 'error', signals(), () => 0.5);
    expect(out.nextSyncAt).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/m365Sync/cadence.test.ts`
Expected: FAIL — `nextInterval` does not exist, and W04's `applyCadence` stub
returns `state.intervalSeconds` unchanged and schedules `now + interval + jitter`
for every outcome, so it ignores `truncated`, `capacity`, `unlicensed`,
`authFailure` and `needs_consent`.

- [ ] **Step 3: Implement**

Replace the two function bodies in
`apps/api/src/services/m365Sync/cadence.ts`. **`CadenceSignals` is already
declared in this file by W04 with exactly these six fields — leave the interface
and its doc comments alone**; only `nextInterval` (new) and `applyCadence`'s body
change:

```ts
import {
  M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS,
  M365_SYNC_DOMAIN_INTERVAL_BOUNDS,
  type M365SyncDomain,
} from '@breeze/shared/m365';
import type { M365SyncOutcome } from './types';
// CadenceSignals and nextSyncAt(now, intervalSeconds, rng?) are declared above
// this line by W04. Do not redeclare either, and do not inline a second jitter
// calculation.

const SLOW_EXECUTOR_MS = 60_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Spec §5.7. Rules are ordered by how strong a signal they are, not by how
 * they read in the spec table: a truncated or slow run is evidence about the
 * tenant's size and must not be softened by the success decay that would
 * otherwise apply to the same run (a truncated run is a `partial`, but a slow
 * run is a `success`).
 */
export function nextInterval(
  domain: M365SyncDomain,
  current: number,
  outcome: M365SyncOutcome,
  signals: CadenceSignals,
): number {
  const { min, max } = M365_SYNC_DOMAIN_INTERVAL_BOUNDS[domain];
  const target = M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS[domain];

  // A tenant that cannot use the feature at all should not be polled at the
  // default cadence forever — go straight to the domain ceiling.
  if (signals.unlicensed) return max;

  let next = current;
  if (signals.truncated || signals.latencyMs > SLOW_EXECUTOR_MS) {
    next = current * 2;
  } else if (outcome === 'throttled' || signals.capacity) {
    next = current * 1.5;
  } else if (outcome === 'success') {
    next = current + (target - current) * 0.25;
  }
  return clamp(Math.round(next), min, max);
}

/**
 * The `applyCadence` seam W04's completion transaction calls. Returns what the
 * sync-state row should carry: the new interval, and the next due time — or
 * NULL, which takes the row out of the ticker's due set entirely until a
 * successful (upgrade-)consent or retest re-seeds it (spec §5.7, §5.8).
 */
export function applyCadence(
  domain: M365SyncDomain,
  state: { intervalSeconds: number },
  outcome: M365SyncOutcome,
  signals: CadenceSignals,
  rng: () => number = Math.random,
): { intervalSeconds: number; nextSyncAt: Date | null } {
  const intervalSeconds = nextInterval(domain, state.intervalSeconds, outcome, signals);
  if (outcome === 'needs_consent' || signals.authFailure) {
    return { intervalSeconds, nextSyncAt: null };
  }
  // The NEW interval is what gets scheduled, not the old one, and the ±10%
  // jitter comes from W04's shared helper so there is exactly one place that
  // decides how a cohort spreads.
  return { intervalSeconds, nextSyncAt: nextSyncAt(signals.now, intervalSeconds, rng) };
}
```

In `run.ts`, assemble the signals at the call site (Task 5's early `return`
already keeps the `'partial-continue'` path away from here), importing the type
rather than restating it — `import { applyCadence, type CadenceSignals } from './cadence';`:

```ts
const signals: CadenceSignals = {
  truncated: executorResult.truncated === true,
  latencyMs: executorElapsedMs,
  capacity: executorFailure?.code === 'sync_capacity',
  unlicensed: Object.values(executorResult.sources ?? {}).includes('unlicensed'),
  authFailure: AUTH_FAILURE_CODES.has(executorFailure?.code ?? ''),
  now: ctx.now,
};
```

with, next to it:

```ts
/**
 * Codes that mean the CONNECTION is no longer usable, as opposed to a
 * transient fault. Spec §6: these unschedule the domain and leave connection
 * health to retest; they are deliberately not sent to Sentry (Huntress rule).
 */
const AUTH_FAILURE_CODES = new Set([
  'credential_unavailable',
  'application_token_invalid',
  'tenant_mismatch',
]);
```

**`graph_permission_missing` is deliberately NOT in that set.** Per the contract
it maps to the `needs_consent` outcome, and W04's run.ts already does that
mapping: a tenant that has not granted a scope is a consent problem the
administrator fixes from the card, not a dead credential. `applyCadence` then
unschedules it through the `outcome === 'needs_consent'` branch, so adding the
code here would only make an already-unscheduled domain unschedule twice — while
mislabelling a consent gap as an auth failure everywhere the flag is read.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/m365Sync/cadence.test.ts src/services/m365Sync/run.test.ts`
Expected: PASS (both files)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365Sync/cadence.ts \
        apps/api/src/services/m365Sync/cadence.test.ts \
        apps/api/src/services/m365Sync/run.ts
git commit -m "feat(m365): adaptive sync cadence (spec §5.7)

Truncated or slow (>60s) runs double the interval; throttled or executor
sync_capacity multiply by 1.5; a plain success decays 25% toward the domain
default; an unlicensed sub-source jumps straight to the domain ceiling. Every
result is clamped to M365_SYNC_DOMAIN_INTERVAL_BOUNDS, so sign-in activity can
never be pulled below its 24h floor.

needs_consent and a connection auth failure return next_sync_at NULL, taking
the row out of the ticker until a consent or retest re-seeds it. A non-auth
terminal error still schedules — otherwise one bad run would silently retire a
domain. graph_permission_missing is not an auth failure: it maps to
needs_consent, which unschedules through its own branch.

This fills W04's stub body; the applyCadence signature and the six-field
CadenceSignals are unchanged from the shared contract.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 7: `rollup.ts` — daily posture rollup behind the `afterDomainPersisted` seam

Spec §3.3 (`m365_posture_rollups`), §5.9 (assembled from the six
`last_counts` + `last_complete_snapshot_at`, one read + one upsert).

**Files:**
- Create: `apps/api/src/services/m365Sync/rollup.ts`
- Create: `apps/api/src/services/m365Sync/rollup.test.ts`
- Modify: `apps/api/src/services/m365Sync/hooks.ts` (W04 no-op seam — **modify, never create**)
- Create: `apps/api/src/services/m365Sync/hooks.test.ts` (W04 shipped `hooks.ts` with no suite of its own)
- Modify: `apps/api/src/services/m365Sync/run.test.ts` (the post-commit ordering proof)

**Interfaces:**
- Consumes: `M365_SYNC_DOMAINS`, `M365SyncDomain` (W03); `m365SyncState`,
  `m365PostureRollups` (W02); `db`, `withSystemDbAccessContext` (`../../db`);
  the `afterDomainPersisted` context type — `PersistContext & { domain; outcome; persisted }`
  (`m365Sync/hooks.ts`, W04); `reconcileDeviceLinks` (Task 8);
  `recordM365SyncLinkAmbiguous` (`m365Sync/metrics.ts`, W04).
- Produces: `upsertPostureRollup(orgId, tenantId, date): Promise<void>`;
  `export const ROLLUP_COUNTER_SOURCES` (the domain → column map, exported so
  W06's integration suite can assert it covers every rollup column).

**Where the seam runs.** `afterDomainPersisted` is called by W04's `run.ts`
**after `writeCompletion` has committed**, and it opens its **own**
`withSystemDbAccessContext`. That is what makes the rollup correct: the
`m365_sync_state` row it reads — including the `last_counts` the run just wrote —
is already durable, so no read-your-own-uncommitted-write assumption is needed.
It also means a throw here **cannot** roll the completion back: the run stays
completed, the hook's failure is logged and metered, and the next run for that
org rebuilds the rollup. Do not reintroduce a "throw rolls the completion back"
rationale — a committed run whose hook failed is recoverable; a run that keeps
un-completing because a rollup query is slow is not.

- [ ] **Step 1: Write the failing test**

`apps/api/src/services/m365Sync/rollup.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db';
import { ROLLUP_COUNTER_SOURCES, upsertPostureRollup } from './rollup';

vi.mock('../../db', () => ({
  db: { select: vi.fn(), insert: vi.fn() },
}));

const ORG = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';

interface Captured { values: Record<string, unknown>[]; set: Record<string, unknown> }
const captured: Captured = { values: [], set: {} };

function mockStateRows(rows: unknown[]) {
  const where = vi.fn(async () => rows);
  vi.mocked(db.select).mockReturnValue({ from: vi.fn(() => ({ where })) } as never);
}

function state(domain: string, counts: Record<string, number> | null, completeAt: Date | null) {
  return { domain, lastCounts: counts, lastCompleteSnapshotAt: completeAt };
}

beforeEach(() => {
  vi.clearAllMocks();
  captured.values = [];
  captured.set = {};
  vi.mocked(db.insert).mockImplementation((() => ({
    values: (rows: Record<string, unknown>[]) => {
      captured.values.push(...(Array.isArray(rows) ? rows : [rows]));
      return {
        onConflictDoUpdate: (arg: { set: Record<string, unknown> }) => {
          captured.set = arg.set;
          return Promise.resolve(undefined);
        },
      };
    },
  })) as never);
});

describe('upsertPostureRollup', () => {
  it('assembles every counter from the six last_counts with ONE read and ONE upsert', async () => {
    mockStateRows([
      state('users', {
        users_total: 120, users_enabled: 118, users_mfa_registered: 100,
        users_mfa_unknown: 5, users_admin: 4, admins_without_mfa: 1, admins_mfa_unknown: 0,
      }, new Date('2026-09-08T06:00:00.000Z')),
      state('intune_devices', {
        devices_total: 90, devices_compliant: 80, devices_noncompliant: 6,
        devices_in_grace: 2, devices_unknown: 2,
      }, new Date('2026-09-08T05:00:00.000Z')),
      state('ca_policies', {
        ca_policies_enabled: 7, ca_policies_report_only: 2, ca_policies_disabled: 1,
      }, new Date('2026-09-08T04:00:00.000Z')),
      state('skus', { seats_purchased: 150, seats_consumed: 120 }, new Date('2026-09-08T03:00:00.000Z')),
      state('secure_score', { secure_score: 412.5, secure_score_max: 600 }, new Date('2026-09-08T02:00:00.000Z')),
      state('signin_activity', {}, new Date('2026-09-07T02:00:00.000Z')),
    ]);

    await upsertPostureRollup(ORG, TENANT, '2026-09-08');

    expect(db.select).toHaveBeenCalledOnce();
    expect(db.insert).toHaveBeenCalledOnce();
    const row = captured.values[0]!;
    expect(row).toMatchObject({
      orgId: ORG, tenantId: TENANT, rollupDate: '2026-09-08',
      usersTotal: 120, usersEnabled: 118, usersMfaRegistered: 100, usersMfaUnknown: 5,
      usersAdmin: 4, adminsWithoutMfa: 1, adminsMfaUnknown: 0,
      devicesTotal: 90, devicesCompliant: 80, devicesNoncompliant: 6,
      devicesInGrace: 2, devicesUnknown: 2,
      caPoliciesEnabled: 7, caPoliciesReportOnly: 2, caPoliciesDisabled: 1,
      seatsPurchased: 150, seatsConsumed: 120,
      secureScore: 412.5, secureScoreMax: 600,
    });
  });

  it('writes NULL — never 0 — for a counter whose source never reported it', async () => {
    mockStateRows([
      state('users', { users_total: 10, users_enabled: 10 }, new Date('2026-09-08T06:00:00.000Z')),
    ]);
    await upsertPostureRollup(ORG, TENANT, '2026-09-08');
    const row = captured.values[0]!;
    expect(row.usersTotal).toBe(10);
    expect(row.usersMfaRegistered).toBeNull();
    expect(row.usersMfaUnknown).toBeNull();
    expect(row.adminsWithoutMfa).toBeNull();
    expect(row.devicesTotal).toBeNull();
    expect(row.secureScore).toBeNull();
  });

  it('records domains_fresh per domain from last_complete_snapshot_at', async () => {
    mockStateRows([
      state('users', { users_total: 1 }, new Date('2026-09-08T06:00:00.000Z')),
      state('skus', null, null),
    ]);
    await upsertPostureRollup(ORG, TENANT, '2026-09-08');
    const fresh = captured.values[0]!.domainsFresh as Record<string, unknown>;
    expect(fresh.users).toEqual({ asOf: '2026-09-08T06:00:00.000Z', complete: true });
    expect(fresh.skus).toEqual({ asOf: null, complete: false });
    // A domain with no state row at all is still represented, as unknown.
    expect(fresh.secure_score).toEqual({ asOf: null, complete: false });
    expect(Object.keys(fresh).sort()).toEqual([
      'ca_policies', 'intune_devices', 'secure_score', 'signin_activity', 'skus', 'users',
    ]);
  });

  it('upserts on (org_id, rollup_date) and refreshes the tenant', async () => {
    mockStateRows([state('users', { users_total: 1 }, new Date())]);
    await upsertPostureRollup(ORG, TENANT, '2026-09-08');
    expect(Object.keys(captured.set)).toContain('tenantId');
    expect(Object.keys(captured.set)).toContain('computedAt');
    expect(Object.keys(captured.set)).toContain('domainsFresh');
  });

  it('covers every counter column of m365_posture_rollups', () => {
    const mapped = Object.values(ROLLUP_COUNTER_SOURCES).flatMap((m) => Object.values(m));
    expect(new Set(mapped).size).toBe(mapped.length);          // no column claimed twice
    expect(mapped).toContain('secureScoreMax');
    expect(mapped).toContain('adminsMfaUnknown');
  });
});
```

Add to `run.test.ts` the two properties the seam depends on — that it is invoked
only after the completion write has **resolved**, and that a throw inside it
leaves the persisted state exactly as the completion wrote it:

```ts
it('invokes afterDomainPersisted only after the completion write resolves', async () => {
  const order: string[] = [];
  let releaseCompletion!: () => void;
  writeCompletionMock.mockImplementation(async () => {
    // Resolve on a later turn so an implementation that fires the hook
    // concurrently with (rather than after) the completion is caught.
    await new Promise<void>((resolve) => { releaseCompletion = resolve; });
    order.push('completion');
  });
  afterDomainPersistedMock.mockImplementation(async () => { order.push('hook'); });

  const run = runSyncDomain(USERS_JOB);
  await Promise.resolve();
  expect(order).toEqual([]);            // nothing has run while the write is in flight
  releaseCompletion();
  await run;

  expect(order).toEqual(['completion', 'hook']);
});

it('a throw inside afterDomainPersisted does not change the persisted state', async () => {
  afterDomainPersistedMock.mockRejectedValue(new Error('rollup boom'));

  const outcome = await runSyncDomain(USERS_JOB);

  // The completion already committed: the run keeps its outcome, the state
  // write is not retried or reverted, and the job does not fail.
  expect(outcome).toBe('success');
  expect(writeCompletionMock).toHaveBeenCalledOnce();
  expect(writeCompletionMock.mock.calls[0]![1]).toMatchObject({ outcome: 'success' });
});
```

and, in `hooks.test.ts`, the hook's own contract:

```ts
it('opens its own system context rather than inheriting one', async () => {
  await afterDomainPersisted(hookCtx({ domain: 'users' }));
  expect(withSystemDbAccessContextMock).toHaveBeenCalledOnce();
});

it('reconciles device links only for intune_devices, and reports ambiguity unlabelled', async () => {
  reconcileDeviceLinksMock.mockResolvedValue({ linkedBySerial: 2, linkedByHostname: 1, ambiguous: 3 });

  await afterDomainPersisted(hookCtx({ domain: 'users' }));
  expect(reconcileDeviceLinksMock).not.toHaveBeenCalled();

  await afterDomainPersisted(hookCtx({ domain: 'intune_devices' }));
  expect(reconcileDeviceLinksMock).toHaveBeenCalledWith(ORG);
  // One numeric argument — the metric carries no orgId label (cardinality).
  expect(recordM365SyncLinkAmbiguousMock).toHaveBeenCalledWith(3);
});

it('does not record the ambiguity metric when there is none', async () => {
  reconcileDeviceLinksMock.mockResolvedValue({ linkedBySerial: 1, linkedByHostname: 0, ambiguous: 0 });
  await afterDomainPersisted(hookCtx({ domain: 'intune_devices' }));
  expect(recordM365SyncLinkAmbiguousMock).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/m365Sync/rollup.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

`apps/api/src/services/m365Sync/rollup.ts`:

```ts
import { eq } from 'drizzle-orm';
import { M365_SYNC_DOMAINS, type M365SyncDomain } from '@breeze/shared/m365';
import { db } from '../../db';
import { m365PostureRollups, m365SyncState } from '../../db/schema/m365Sync';

/**
 * Which domain's `last_counts` key feeds which rollup column. Exported so the
 * end-to-end suite (W06) can assert the map covers the table and claims no
 * column twice — a silently unmapped column would report NULL forever.
 */
export const ROLLUP_COUNTER_SOURCES: Record<string, Record<string, string>> = {
  users: {
    users_total: 'usersTotal',
    users_enabled: 'usersEnabled',
    users_mfa_registered: 'usersMfaRegistered',
    users_mfa_unknown: 'usersMfaUnknown',
    users_admin: 'usersAdmin',
    admins_without_mfa: 'adminsWithoutMfa',
    admins_mfa_unknown: 'adminsMfaUnknown',
  },
  intune_devices: {
    devices_total: 'devicesTotal',
    devices_compliant: 'devicesCompliant',
    devices_noncompliant: 'devicesNoncompliant',
    devices_in_grace: 'devicesInGrace',
    devices_unknown: 'devicesUnknown',
  },
  ca_policies: {
    ca_policies_enabled: 'caPoliciesEnabled',
    ca_policies_report_only: 'caPoliciesReportOnly',
    ca_policies_disabled: 'caPoliciesDisabled',
  },
  skus: {
    seats_purchased: 'seatsPurchased',
    seats_consumed: 'seatsConsumed',
  },
  secure_score: {
    secure_score: 'secureScore',
    secure_score_max: 'secureScoreMax',
  },
  signin_activity: {},
};

const COUNTER_COLUMNS = Object.values(ROLLUP_COUNTER_SOURCES)
  .flatMap((map) => Object.values(map));

function counterOf(counts: unknown, key: string): number | null {
  if (counts === null || typeof counts !== 'object') return null;
  const value = (counts as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Assembles today's posture row from the six sync-state rows: one indexed read
 * and one upsert, no COUNT queries (spec §5.9). Counters the domains have not
 * reported stay NULL rather than 0 — "we do not know" and "there are none" are
 * different facts, and reporting the second when the first is true is exactly
 * the false-negative the spec's `*_unknown` columns exist to prevent.
 *
 * Called from `afterDomainPersisted` after the completion transaction has
 * committed, so the domain that just ran contributes its fresh, durable
 * `last_counts`.
 */
export async function upsertPostureRollup(
  orgId: string,
  tenantId: string,
  date: string,
): Promise<void> {
  const rows = await db
    .select({
      domain: m365SyncState.domain,
      lastCounts: m365SyncState.lastCounts,
      lastCompleteSnapshotAt: m365SyncState.lastCompleteSnapshotAt,
    })
    .from(m365SyncState)
    .where(eq(m365SyncState.orgId, orgId));

  const byDomain = new Map(rows.map((row) => [row.domain as M365SyncDomain, row]));

  const counters: Record<string, number | null> = {};
  for (const column of COUNTER_COLUMNS) counters[column] = null;
  for (const [domain, keyMap] of Object.entries(ROLLUP_COUNTER_SOURCES)) {
    const row = byDomain.get(domain as M365SyncDomain);
    if (!row) continue;
    for (const [countsKey, column] of Object.entries(keyMap)) {
      counters[column] = counterOf(row.lastCounts, countsKey);
    }
  }

  const domainsFresh: Record<string, { asOf: string | null; complete: boolean }> = {};
  for (const domain of M365_SYNC_DOMAINS) {
    const at = byDomain.get(domain)?.lastCompleteSnapshotAt ?? null;
    domainsFresh[domain] = {
      asOf: at ? new Date(at).toISOString() : null,
      complete: at !== null,
    };
  }

  const computedAt = new Date();
  await db.insert(m365PostureRollups).values({
    orgId,
    tenantId,
    rollupDate: date,
    ...counters,
    domainsFresh,
    computedAt,
  }).onConflictDoUpdate({
    target: [m365PostureRollups.orgId, m365PostureRollups.rollupDate],
    set: {
      tenantId,
      ...counters,
      domainsFresh,
      computedAt,
    },
  });
}
```

In `apps/api/src/services/m365Sync/hooks.ts`, replace W04's no-op body — keep
the exported name and the contracted parameter type exactly as they are:

```ts
import { withSystemDbAccessContext } from '../../db';
import { reconcileDeviceLinks } from './links';          // Task 8
import { recordM365SyncLinkAmbiguous } from './metrics'; // W04
import { upsertPostureRollup } from './rollup';

/**
 * Called by run.ts AFTER writeCompletion has COMMITTED, never inside it. That
 * ordering is what lets the rollup read this run's own `last_counts` from a
 * durable row, and it is why this hook opens its own system context instead of
 * inheriting one — run.ts is holding no context by the time it calls here.
 *
 * A throw is logged and metered by the caller and cannot undo the completion:
 * a committed run with a stale rollup is repaired by the next run of any domain
 * in the org, whereas a run that keeps un-completing because a rollup query was
 * slow would never make progress at all.
 */
export async function afterDomainPersisted(ctx: PersistContext & {
  domain: M365SyncDomain;
  outcome: M365SyncOutcome;
  persisted: DomainPersistResult;
}): Promise<void> {
  await withSystemDbAccessContext(async () => {
    if (ctx.domain === 'intune_devices') {
      const links = await reconcileDeviceLinks(ctx.orgId);
      // One numeric argument: the metric is m365_sync_link_ambiguous_total and
      // carries no orgId label, by contract (cardinality).
      if (links.ambiguous > 0) recordM365SyncLinkAmbiguous(links.ambiguous);
    }
    await upsertPostureRollup(ctx.orgId, ctx.tenantId, utcDate(ctx.now));
  }, 'm365SyncAfterDomainPersisted');
}

/** UTC calendar day of the run, the key of `m365_posture_rollups`. */
function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/m365Sync/rollup.test.ts src/services/m365Sync/hooks.test.ts src/services/m365Sync/run.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365Sync/rollup.ts \
        apps/api/src/services/m365Sync/rollup.test.ts \
        apps/api/src/services/m365Sync/hooks.ts \
        apps/api/src/services/m365Sync/hooks.test.ts \
        apps/api/src/services/m365Sync/run.test.ts
git commit -m "feat(m365): daily posture rollup wired into afterDomainPersisted

Spec §3.3/§5.9. One indexed read of the org's six m365_sync_state rows plus one
upsert on (org_id, rollup_date) — no COUNT queries. Counters no domain has
reported stay NULL, never 0: 'we do not know' and 'there are none' are
different facts and the *_unknown columns exist precisely so partial enrichment
is never reported as absence. domains_fresh carries asOf/complete for all six
domains, including ones with no state row yet.

The seam runs AFTER the completion transaction commits, on its own system
context, so the domain that just finished contributes durable last_counts and a
hook failure cannot un-complete a run that already succeeded. run.test.ts pins
both: the hook fires only once the completion write has resolved, and a throw
inside it leaves the persisted state unchanged.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 8: `links.ts` — set-based Breeze↔Intune device link reconciliation

Spec §5.6, §3.2 (`breeze_device_id` composite FK, column-specific `SET NULL`),
§3.4 (device org move detaches — W02 owns that half).

**Files:**
- Create: `apps/api/src/services/m365Sync/links.ts`
- Create: `apps/api/src/services/m365Sync/links.test.ts`

**Interfaces:**
- Consumes: `db` (`../../db`); tables `m365_intune_devices` (W02),
  `device_hardware` / `devices` (`db/schema/devices.ts` — `deviceHardware.serialNumber`
  is `varchar(100)`, `devices.hostname` is `varchar(255) NOT NULL`, `device_hardware`
  carries its own `org_id`, and `devices` has **no** soft-delete column).
- Produces: `reconcileDeviceLinks(orgId): Promise<{ linkedBySerial: number; linkedByHostname: number; ambiguous: number }>`
  — consumed by Task 7's `afterDomainPersisted` hook body.

- [ ] **Step 1: Write the failing test**

`apps/api/src/services/m365Sync/links.test.ts` — the shape/statement-count
proof; Task 9 is the behavioural proof against real Postgres.

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db';
import { reconcileDeviceLinks } from './links';

vi.mock('../../db', () => ({ db: { execute: vi.fn() } }));

const executeMock = vi.mocked(db.execute);
const ORG = '11111111-1111-4111-8111-111111111111';

function sqlOf(call: number): string {
  return (executeMock.mock.calls[call]![0] as { queryChunks?: unknown[]; sql?: string }).sql
    ?? JSON.stringify(executeMock.mock.calls[call]![0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  executeMock
    .mockResolvedValueOnce([{ linked: 3, ambiguous: 1 }] as never)
    .mockResolvedValueOnce([{ linked: 2 }] as never);
});

describe('reconcileDeviceLinks', () => {
  it('issues exactly two statements: serial then hostname', async () => {
    const out = await reconcileDeviceLinks(ORG);
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ linkedBySerial: 3, linkedByHostname: 2, ambiguous: 1 });
  });

  it('binds the org id on every statement', async () => {
    await reconcileDeviceLinks(ORG);
    for (const call of executeMock.mock.calls) {
      const params = (call[0] as { params: unknown[] }).params;
      expect(params).toContain(ORG);
    }
  });

  it('reconciles rows whose link no longer matches, not only unlinked rows', async () => {
    await reconcileDeviceLinks(ORG);
    expect(sqlOf(0)).toContain('IS DISTINCT FROM');
  });

  it('restricts the hostname pass to rows still unlinked after the serial pass', async () => {
    await reconcileDeviceLinks(ORG);
    expect(sqlOf(1)).toContain('breeze_device_id IS NULL');
  });

  it('never writes last_changed_at or core_hash', async () => {
    await reconcileDeviceLinks(ORG);
    expect(sqlOf(0)).not.toContain('last_changed_at');
    expect(sqlOf(0)).not.toContain('core_hash');
    expect(sqlOf(1)).not.toContain('last_changed_at');
  });

  it('reports zero rather than throwing when a statement returns no row', async () => {
    executeMock.mockReset();
    executeMock.mockResolvedValue([] as never);
    await expect(reconcileDeviceLinks(ORG)).resolves.toEqual({
      linkedBySerial: 0, linkedByHostname: 0, ambiguous: 0,
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/m365Sync/links.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

`apps/api/src/services/m365Sync/links.ts`:

```ts
import { sql } from 'drizzle-orm';
import { db } from '../../db';

export interface DeviceLinkReconciliation {
  linkedBySerial: number;
  linkedByHostname: number;
  /** Normalised keys present on both sides but not 1:1 — deliberately skipped. */
  ambiguous: number;
}

function count(rows: unknown, key: string): number {
  const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
  const value = row?.[key];
  return typeof value === 'number' ? value : Number(value ?? 0) || 0;
}

/**
 * Spec §5.6. Two set-based passes over ALL of the org's non-stale Intune rows —
 * not only the rows this run changed — so a Breeze agent enrolled after the
 * last Intune snapshot links on the next run without waiting for the Graph row
 * to change.
 *
 * Matching is 1:1 only, on both sides. A serial duplicated across two Breeze
 * devices (chassis swaps, imaging templates that leave "To Be Filled By
 * O.E.M.", VMs) or across two Intune rows is skipped and counted, never
 * guessed: a wrong link puts one customer's Intune posture on another
 * machine's device page, and the operator can see the ambiguity in
 * `m365_sync_link_ambiguous_total`.
 *
 * The predicate is "unlinked OR linked to something that no longer matches"
 * (`IS DISTINCT FROM`), which is what makes a re-imaged machine re-link
 * instead of keeping a dead pointer. Rows whose device was deleted are already
 * NULLed by the composite FK's column-specific ON DELETE SET NULL.
 *
 * Runs inside the sync worker's system DB context (cross-org scheduler), so
 * every CTE filters `org_id` explicitly — RLS is not doing that work here.
 * Only `breeze_device_id` is written: a link is Breeze-side state, and bumping
 * `last_changed_at` would make sub-project 3's change alerts fire on every
 * agent enrolment.
 */
export async function reconcileDeviceLinks(orgId: string): Promise<DeviceLinkReconciliation> {
  const serialRows = await db.execute(sql`
    WITH intune AS (
      SELECT i.id, lower(btrim(i.serial_number)) AS key
      FROM m365_intune_devices i
      WHERE i.org_id = ${orgId}::uuid
        AND i.is_stale = false
        AND i.serial_number IS NOT NULL
        AND btrim(i.serial_number) <> ''
    ),
    breeze AS (
      SELECT d.id AS device_id, lower(btrim(h.serial_number)) AS key
      FROM device_hardware h
      JOIN devices d ON d.id = h.device_id AND d.org_id = h.org_id
      WHERE h.org_id = ${orgId}::uuid
        AND d.is_ephemeral = false
        AND h.serial_number IS NOT NULL
        AND btrim(h.serial_number) <> ''
    ),
    intune_counts AS (SELECT key, count(*) AS n FROM intune GROUP BY key),
    breeze_counts AS (SELECT key, count(*) AS n FROM breeze GROUP BY key),
    matched AS (
      SELECT i.id, b.device_id
      FROM intune i
      JOIN intune_counts ic ON ic.key = i.key AND ic.n = 1
      JOIN breeze b         ON b.key  = i.key
      JOIN breeze_counts bc ON bc.key = b.key AND bc.n = 1
    ),
    ambiguous AS (
      SELECT ic.key
      FROM intune_counts ic
      JOIN breeze_counts bc ON bc.key = ic.key
      WHERE ic.n > 1 OR bc.n > 1
    ),
    linked AS (
      UPDATE m365_intune_devices t
      SET breeze_device_id = m.device_id
      FROM matched m
      WHERE t.id = m.id
        AND t.org_id = ${orgId}::uuid
        AND t.breeze_device_id IS DISTINCT FROM m.device_id
      RETURNING 1
    )
    SELECT
      (SELECT count(*) FROM linked)::int    AS linked,
      (SELECT count(*) FROM ambiguous)::int AS ambiguous
  `);

  const hostnameRows = await db.execute(sql`
    WITH intune AS (
      SELECT i.id, lower(btrim(i.device_name)) AS key
      FROM m365_intune_devices i
      WHERE i.org_id = ${orgId}::uuid
        AND i.is_stale = false
        AND i.breeze_device_id IS NULL
        AND i.device_name IS NOT NULL
        AND btrim(i.device_name) <> ''
    ),
    breeze AS (
      SELECT d.id AS device_id, lower(btrim(d.hostname)) AS key
      FROM devices d
      WHERE d.org_id = ${orgId}::uuid
        AND d.is_ephemeral = false
        AND btrim(d.hostname) <> ''
        AND NOT EXISTS (
          SELECT 1 FROM m365_intune_devices x
          WHERE x.org_id = ${orgId}::uuid AND x.breeze_device_id = d.id
        )
    ),
    intune_counts AS (SELECT key, count(*) AS n FROM intune GROUP BY key),
    breeze_counts AS (SELECT key, count(*) AS n FROM breeze GROUP BY key),
    matched AS (
      SELECT i.id, b.device_id
      FROM intune i
      JOIN intune_counts ic ON ic.key = i.key AND ic.n = 1
      JOIN breeze b         ON b.key  = i.key
      JOIN breeze_counts bc ON bc.key = b.key AND bc.n = 1
    ),
    linked AS (
      UPDATE m365_intune_devices t
      SET breeze_device_id = m.device_id
      FROM matched m
      WHERE t.id = m.id
        AND t.org_id = ${orgId}::uuid
        AND t.breeze_device_id IS NULL
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM linked)::int AS linked
  `);

  return {
    linkedBySerial: count(serialRows, 'linked'),
    linkedByHostname: count(hostnameRows, 'linked'),
    ambiguous: count(serialRows, 'ambiguous'),
  };
}
```

Two details that are load-bearing, not style:

- The hostname pass excludes Breeze devices that any Intune row already points
  at (`NOT EXISTS`). Without it, a device linked by serial to Intune row A
  could also be claimed by hostname from Intune row B, and both rows would
  render on the same device page.
- `is_ephemeral = false` keeps Quick Support devices (purged 6 h after the
  session) out of the candidate set; linking them would churn the table daily
  and leave dangling-then-NULLed links.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/m365Sync/links.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365Sync/links.ts \
        apps/api/src/services/m365Sync/links.test.ts
git commit -m "feat(m365): set-based Intune device link reconciliation

Spec §5.6. Two data-modifying-CTE statements per Intune run: serial via
device_hardware joined to devices for the org, trimmed and case-folded, 1:1 on
BOTH sides; then hostname over what is still unlinked, excluding Breeze devices
another Intune row already claims. Ambiguous keys are counted and skipped, not
guessed — a wrong link puts one machine's Intune posture on another's device
page.

The predicate is 'unlinked OR the link no longer matches' (IS DISTINCT FROM),
so a re-imaged machine re-links instead of keeping a dead pointer, and the pass
covers ALL non-stale rows so a newly enrolled agent links without waiting for
its Graph row to change. Only breeze_device_id is written.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 9: real-Postgres proof for device link reconciliation

Spec §9 ("link reconciliation over unlinked rows, ambiguous serial skipped").
Two set-based statements with four CTEs each are exactly the kind of SQL a
mock cannot validate — this is the discriminating test for Task 8.

**Files:**
- Create: `apps/api/src/__tests__/integration/m365SyncLinks.integration.test.ts`

**Interfaces:**
- Consumes: `reconcileDeviceLinks` (Task 8); `createPartner`,
  `createOrganization`, `createSite` (`./db-utils`); `getTestDb` (`./setup`);
  `withSystemDbAccessContext` (`../../db`); `devices`, `deviceHardware`
  (`db/schema/devices.ts`); `m365IntuneDevices` (`db/schema/m365Sync.ts`, W02).
- Produces: nothing importable.

The file lives under `src/__tests__/integration/`, so
`vitest.integration.config.ts`'s `src/__tests__/integration/**/*.test.ts`
include picks it up and the unit config's matching exclude drops it — no config
edit, and no risk of the "integration test in the wrong directory runs in zero
CI jobs" trap.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * Real-Postgres proof for m365Sync/links.ts (spec §5.6). The reconciliation is
 * two set-based statements with four CTEs each and 1:1 guards on BOTH sides;
 * a Drizzle mock can only assert that some SQL was sent. Everything asserted
 * here — the case/whitespace folding, the ambiguity skip, the hostname
 * fallback, the relink on mismatch — is a property of the SQL itself.
 *
 * Fixtures are re-seeded per test: the integration setup truncates tenant data
 * between tests, so memoized fixtures would be stale and vacuous.
 */
import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withSystemDbAccessContext } from '../../db';
import { deviceHardware, devices } from '../../db/schema/devices';
import { m365IntuneDevices } from '../../db/schema/m365Sync';
import { reconcileDeviceLinks } from '../../services/m365Sync/links';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

let orgId: string;
let siteId: string;
let seq = 0;

/**
 * Seeds through the TEST client, like every db-utils factory and deliberately
 * NOT inside a system DB context — the partner-export statement triggers
 * enforce a lock hierarchy that a single seeding transaction would violate.
 * The reconciliation under test still runs under a real system context.
 */
async function seedBreezeDevice(hostname: string, serial: string | null): Promise<string> {
  seq += 1;
  const [device] = await getTestDb().insert(devices).values({
    orgId, siteId,
    agentId: `agent-m365-link-${Date.now()}-${seq}`,
    hostname, osType: 'windows', osVersion: '11',
    architecture: 'x64', agentVersion: '1.0.0',
  }).returning({ id: devices.id });
  await getTestDb().insert(deviceHardware).values({
    deviceId: device!.id, orgId, serialNumber: serial,
  });
  return device!.id;
}

async function seedIntuneRow(input: {
  deviceName: string; serialNumber: string | null; breezeDeviceId?: string | null; isStale?: boolean;
}): Promise<string> {
  seq += 1;
  const [row] = await getTestDb().insert(m365IntuneDevices).values({
    orgId,
    graphId: `graph-${Date.now()}-${seq}`,
    deviceName: input.deviceName,
    serialNumber: input.serialNumber,
    complianceState: 'compliant',
    coreHash: 'f'.repeat(64),
    breezeDeviceId: input.breezeDeviceId ?? null,
    isStale: input.isStale ?? false,
  }).returning({ id: m365IntuneDevices.id });
  return row!.id;
}

async function linkOf(id: string): Promise<string | null> {
  const [row] = await getTestDb().select({ link: m365IntuneDevices.breezeDeviceId })
    .from(m365IntuneDevices).where(eq(m365IntuneDevices.id, id));
  return row?.link ?? null;
}

const reconcile = () => withSystemDbAccessContext(() => reconcileDeviceLinks(orgId));

beforeEach(async () => {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner!.id });
  orgId = org!.id;
  siteId = (await createSite({ orgId }))!.id;
});

describe('m365Sync device link reconciliation (real Postgres)', () => {
  runDb('links a 1:1 serial match, case- and whitespace-insensitively', async () => {
    const deviceId = await seedBreezeDevice('WS-001', '  abc-123  ');
    const intuneId = await seedIntuneRow({ deviceName: 'somethingelse', serialNumber: 'ABC-123' });

    const out = await reconcile();

    expect(out.linkedBySerial).toBe(1);
    expect(out.linkedByHostname).toBe(0);
    expect(await linkOf(intuneId)).toBe(deviceId);
  });

  runDb('skips and counts an ambiguous serial duplicated on the Breeze side', async () => {
    await seedBreezeDevice('WS-001', 'DUP-1');
    await seedBreezeDevice('WS-002', 'dup-1');
    const intuneId = await seedIntuneRow({ deviceName: 'WS-999', serialNumber: 'DUP-1' });

    const out = await reconcile();

    expect(out.linkedBySerial).toBe(0);
    expect(out.ambiguous).toBe(1);
    expect(await linkOf(intuneId)).toBeNull();
  });

  runDb('skips and counts an ambiguous serial duplicated on the Intune side', async () => {
    await seedBreezeDevice('WS-001', 'DUP-2');
    const a = await seedIntuneRow({ deviceName: 'A', serialNumber: 'DUP-2' });
    const b = await seedIntuneRow({ deviceName: 'B', serialNumber: 'dup-2' });

    const out = await reconcile();

    expect(out.linkedBySerial).toBe(0);
    expect(out.ambiguous).toBe(1);
    expect(await linkOf(a)).toBeNull();
    expect(await linkOf(b)).toBeNull();
  });

  runDb('falls back to a 1:1 hostname match when serials are absent', async () => {
    const deviceId = await seedBreezeDevice('ws-fallback', null);
    const intuneId = await seedIntuneRow({ deviceName: 'WS-Fallback', serialNumber: null });

    const out = await reconcile();

    expect(out.linkedBySerial).toBe(0);
    expect(out.linkedByHostname).toBe(1);
    expect(await linkOf(intuneId)).toBe(deviceId);
  });

  runDb('does not claim by hostname a device another Intune row already owns', async () => {
    const deviceId = await seedBreezeDevice('WS-SHARED', 'SER-1');
    const bySerial = await seedIntuneRow({ deviceName: 'unrelated', serialNumber: 'SER-1' });
    const byHostname = await seedIntuneRow({ deviceName: 'WS-SHARED', serialNumber: null });

    const out = await reconcile();

    expect(await linkOf(bySerial)).toBe(deviceId);
    expect(await linkOf(byHostname)).toBeNull();
    expect(out.linkedByHostname).toBe(0);
  });

  runDb('re-links a row whose stored link no longer matches its serial', async () => {
    const oldDevice = await seedBreezeDevice('WS-OLD', 'OLD-SERIAL');
    const newDevice = await seedBreezeDevice('WS-NEW', 'NEW-SERIAL');
    const intuneId = await seedIntuneRow({
      deviceName: 'WS-NEW', serialNumber: 'NEW-SERIAL', breezeDeviceId: oldDevice,
    });

    const out = await reconcile();

    expect(out.linkedBySerial).toBe(1);
    expect(await linkOf(intuneId)).toBe(newDevice);
  });

  runDb('is idempotent: a second pass writes nothing', async () => {
    await seedBreezeDevice('WS-IDEM', 'IDEM-1');
    await seedIntuneRow({ deviceName: 'WS-IDEM', serialNumber: 'IDEM-1' });

    await reconcile();
    const second = await reconcile();

    expect(second).toEqual({ linkedBySerial: 0, linkedByHostname: 0, ambiguous: 0 });
  });

  runDb('ignores stale Intune rows and empty/whitespace serials', async () => {
    const deviceId = await seedBreezeDevice('WS-STALE', 'STALE-1');
    const stale = await seedIntuneRow({ deviceName: 'WS-STALE', serialNumber: 'STALE-1', isStale: true });
    await seedBreezeDevice('WS-BLANK', '   ');
    const blank = await seedIntuneRow({ deviceName: 'nope', serialNumber: '   ' });

    const out = await reconcile();

    expect(await linkOf(stale)).toBeNull();
    expect(await linkOf(blank)).toBeNull();
    expect(out.linkedBySerial).toBe(0);
    expect(deviceId).toBeTruthy();
  });

  runDb('never links across organizations', async () => {
    const otherPartner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: otherPartner!.id });
    const otherSite = await createSite({ orgId: otherOrg!.id });
    seq += 1;
    const [foreign] = await getTestDb().insert(devices).values({
      orgId: otherOrg!.id, siteId: otherSite!.id,
      agentId: `agent-foreign-${Date.now()}-${seq}`,
      hostname: 'WS-CROSS', osType: 'windows', osVersion: '11',
      architecture: 'x64', agentVersion: '1.0.0',
    }).returning({ id: devices.id });
    await getTestDb().insert(deviceHardware).values({
      deviceId: foreign!.id, orgId: otherOrg!.id, serialNumber: 'CROSS-1',
    });
    const intuneId = await seedIntuneRow({ deviceName: 'WS-CROSS', serialNumber: 'CROSS-1' });

    const out = await reconcile();

    expect(out.linkedBySerial).toBe(0);
    expect(out.linkedByHostname).toBe(0);
    expect(await linkOf(intuneId)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

The suite needs the test database up:

```bash
cd apps/api && pnpm test:docker:up
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/m365SyncLinks.integration.test.ts
```

Expected: FAIL before Task 8's implementation is complete. If Task 8 already
landed, expect PASS here and confirm the suite actually **ran** (the reported
file/test count must be non-zero — `it.runIf` silently skips everything when
`DATABASE_URL` is unset, which reads as green).

- [ ] **Step 3: Fix anything the real database rejects**

Likely deltas from the mock-level task: the exact column names of
`m365_intune_devices` (W02 owns them — `device_name`, `serial_number`,
`breeze_device_id`, `is_stale`, `core_hash`), and whether `core_hash` /
`compliance_state` are NOT NULL. Adjust the fixtures, not the production SQL,
unless a real constraint proves the SQL wrong.

- [ ] **Step 4: Run and confirm the count**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/m365SyncLinks.integration.test.ts
```
Expected: PASS, 9 tests executed (not skipped).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/m365SyncLinks.integration.test.ts
git commit -m "test(m365): real-Postgres proof for Intune device link reconciliation

Nine cases against a live database: case/whitespace-folded serial match,
ambiguity on either side skipped and counted, hostname fallback, a device
already claimed by another Intune row not re-claimed, relink on a stale
pointer, idempotence, stale/blank rows ignored, and no cross-org link.

The reconciliation is two data-modifying-CTE statements with 1:1 guards on both
sides; a Drizzle mock can only assert that some SQL was sent, so this is the
discriminating test for the SQL itself.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 10: `lifecycle.ts` — consent seeding, disconnect erasure, upgrade re-seed, on-demand request

Spec §5.8, §5.2 (priority lanes), §10 (every entry point flag-gated).

**Files:**
- Create: `apps/api/src/services/m365Sync/lifecycle.ts`
- Create: `apps/api/src/services/m365Sync/lifecycle.test.ts`

**Interfaces:**
- Consumes: `M365_SYNC_DOMAINS`,
  `M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS`, `M365SyncDomain` (W03);
  `claimAndEnqueue` (`m365Sync/claim.ts`, W04);
  `isM365TenantSyncEnabled` (`config/env.ts`, W04);
  `m365SyncState`, `m365Users`, `m365IntuneDevices`, `m365CaPolicies`,
  `m365LicenseSkus` (W02); `db`, `runOutsideDbContext`,
  `withSystemDbAccessContext` (`../../db`).
- Produces:
  - `onConnectionConsented(conn: { id; orgId; tenantId; status: 'active' | 'degraded' }): Promise<void>`
  - `onConnectionDisconnected(conn: { id; orgId }): Promise<void>`
  - `onConnectionUpgraded(conn: { id; orgId }): Promise<void>`
  - `requestOnDemandSync(input: { orgId; connectionId }): Promise<void>`
  - `export const ON_DEMAND_SYNC_DOMAINS: readonly M365SyncDomain[]`
  Consumed by Tasks 11, 12 and 14.

- [ ] **Step 1: Write the failing test**

`apps/api/src/services/m365Sync/lifecycle.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { isM365TenantSyncEnabled } from '../../config/env';
import { claimAndEnqueue } from './claim';
import {
  ON_DEMAND_SYNC_DOMAINS,
  onConnectionConsented,
  onConnectionDisconnected,
  onConnectionUpgraded,
  requestOnDemandSync,
} from './lifecycle';

vi.mock('../../db', () => ({
  db: { insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../../config/env', () => ({ isM365TenantSyncEnabled: vi.fn(() => true) }));
vi.mock('./claim', () => ({ claimAndEnqueue: vi.fn(async () => undefined) }));

const claimMock = vi.mocked(claimAndEnqueue);
const flagMock = vi.mocked(isM365TenantSyncEnabled);
const ORG = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '33333333-3333-4333-8333-333333333333';

let insertedRows: Record<string, unknown>[] = [];
let conflictSet: Record<string, unknown> = {};
const deletedTables: string[] = [];
let updateSet: Record<string, unknown> = {};

beforeEach(() => {
  vi.clearAllMocks();
  insertedRows = [];
  conflictSet = {};
  deletedTables.length = 0;
  updateSet = {};
  flagMock.mockReturnValue(true);
  vi.mocked(runOutsideDbContext).mockImplementation(((fn: () => unknown) => fn()) as never);
  vi.mocked(withSystemDbAccessContext).mockImplementation((async (fn: () => Promise<unknown>) => fn()) as never);
  vi.mocked(db.insert).mockImplementation((() => ({
    values: (rows: Record<string, unknown>[]) => {
      insertedRows.push(...rows);
      return { onConflictDoUpdate: (a: { set: Record<string, unknown> }) => { conflictSet = a.set; return Promise.resolve(); } };
    },
  })) as never);
  vi.mocked(db.delete).mockImplementation(((table: { _: { name?: string } }) => {
    deletedTables.push(String((table as unknown as { [k: string]: unknown })[Symbol.for('drizzle:Name') as unknown as string] ?? table?._?.name ?? 'unknown'));
    return { where: vi.fn(async () => undefined) };
  }) as never);
  vi.mocked(db.update).mockImplementation((() => ({
    set: (payload: Record<string, unknown>) => { updateSet = payload; return { where: vi.fn(async () => [{ domain: 'users' }, { domain: 'ca_policies' }]) }; },
  })) as never);
});

describe('onConnectionConsented', () => {
  it('seeds all six domains due now and claims them at priority 1', async () => {
    await onConnectionConsented({ id: CONNECTION, orgId: ORG, tenantId: TENANT, status: 'active' });
    expect(insertedRows).toHaveLength(6);
    expect(insertedRows.map((r) => r.domain).sort()).toEqual([
      'ca_policies', 'intune_devices', 'secure_score', 'signin_activity', 'skus', 'users',
    ]);
    for (const row of insertedRows) {
      expect(row.orgId).toBe(ORG);
      expect(row.connectionId).toBe(CONNECTION);
      expect(row.nextSyncAt).toBeInstanceOf(Date);
      expect(typeof row.intervalSeconds).toBe('number');
    }
    expect(claimMock).toHaveBeenCalledWith(ORG, expect.arrayContaining(['users', 'signin_activity']), 1);
  });

  it('seeds on a DEGRADED connection too', async () => {
    await onConnectionConsented({ id: CONNECTION, orgId: ORG, tenantId: TENANT, status: 'degraded' });
    expect(insertedRows).toHaveLength(6);
    expect(claimMock).toHaveBeenCalledOnce();
  });

  it('re-points and re-arms existing rows on conflict without resetting history', async () => {
    await onConnectionConsented({ id: CONNECTION, orgId: ORG, tenantId: TENANT, status: 'active' });
    expect(Object.keys(conflictSet).sort()).toEqual(['connectionId', 'nextSyncAt', 'updatedAt']);
    expect(Object.keys(conflictSet)).not.toContain('lastSuccessAt');
    expect(Object.keys(conflictSet)).not.toContain('lastCompleteSnapshotAt');
  });

  it('does nothing when the flag is off', async () => {
    flagMock.mockReturnValue(false);
    await onConnectionConsented({ id: CONNECTION, orgId: ORG, tenantId: TENANT, status: 'active' });
    expect(db.insert).not.toHaveBeenCalled();
    expect(claimMock).not.toHaveBeenCalled();
  });

  it('never throws — a seeding fault must not fail a successful consent', async () => {
    vi.mocked(db.insert).mockImplementation((() => { throw new Error('boom'); }) as never);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(onConnectionConsented({ id: CONNECTION, orgId: ORG, tenantId: TENANT, status: 'active' }))
      .resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
  });
});

describe('onConnectionDisconnected', () => {
  it('deletes the four entity tables and the state rows, keeping history', async () => {
    await onConnectionDisconnected({ id: CONNECTION, orgId: ORG });
    expect(db.delete).toHaveBeenCalledTimes(5);
    expect(claimMock).not.toHaveBeenCalled();
  });

  it('runs on the AMBIENT context — it never opens its own', async () => {
    await onConnectionDisconnected({ id: CONNECTION, orgId: ORG });
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
    expect(runOutsideDbContext).not.toHaveBeenCalled();
  });

  it('THROWS on failure so the caller transaction rolls back', async () => {
    vi.mocked(db.delete).mockImplementation((() => { throw new Error('boom'); }) as never);
    await expect(onConnectionDisconnected({ id: CONNECTION, orgId: ORG })).rejects.toThrow('boom');
  });

  it('erases regardless of the flag — a disconnect must not leave data behind', async () => {
    flagMock.mockReturnValue(false);
    await onConnectionDisconnected({ id: CONNECTION, orgId: ORG });
    expect(db.delete).toHaveBeenCalledTimes(5);
  });
});

describe('onConnectionUpgraded', () => {
  it('re-arms only unscheduled needs_consent rows and claims the ones it armed', async () => {
    await onConnectionUpgraded({ id: CONNECTION, orgId: ORG });
    expect(Object.keys(updateSet)).toEqual(expect.arrayContaining(['nextSyncAt', 'updatedAt']));
    expect(claimMock).toHaveBeenCalledWith(ORG, ['users', 'ca_policies'], 1);
  });

  it('claims nothing when no row was re-armed', async () => {
    vi.mocked(db.update).mockImplementation((() => ({
      set: () => ({ where: vi.fn(async () => []) }),
    })) as never);
    await onConnectionUpgraded({ id: CONNECTION, orgId: ORG });
    expect(claimMock).not.toHaveBeenCalled();
  });

  it('does nothing when the flag is off, and never throws', async () => {
    flagMock.mockReturnValue(false);
    await expect(onConnectionUpgraded({ id: CONNECTION, orgId: ORG })).resolves.toBeUndefined();
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe('requestOnDemandSync', () => {
  it('claims the five non-sign-in domains at priority 1', async () => {
    expect(ON_DEMAND_SYNC_DOMAINS).not.toContain('signin_activity');
    expect(ON_DEMAND_SYNC_DOMAINS).toHaveLength(5);
    await requestOnDemandSync({ orgId: ORG, connectionId: CONNECTION });
    expect(claimMock).toHaveBeenCalledWith(ORG, [...ON_DEMAND_SYNC_DOMAINS], 1);
  });

  it('does nothing when the flag is off', async () => {
    flagMock.mockReturnValue(false);
    await requestOnDemandSync({ orgId: ORG, connectionId: CONNECTION });
    expect(claimMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/m365Sync/lifecycle.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

`apps/api/src/services/m365Sync/lifecycle.ts`:

```ts
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  M365_SYNC_DOMAINS,
  M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS,
  type M365SyncDomain,
} from '@breeze/shared/m365';
import { isM365TenantSyncEnabled } from '../../config/env';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  m365CaPolicies,
  m365IntuneDevices,
  m365LicenseSkus,
  m365SyncState,
  m365Users,
} from '../../db/schema/m365Sync';
import { claimAndEnqueue } from './claim';

/**
 * Sign-in activity is excluded from on-demand: its Graph limit is 10 requests
 * per minute for the WHOLE app across every tenant (spec §4.1), so one
 * technician pressing "Sync now" must not be able to spend the region's budget.
 */
export const ON_DEMAND_SYNC_DOMAINS: readonly M365SyncDomain[] =
  M365_SYNC_DOMAINS.filter((domain) => domain !== 'signin_activity');

/**
 * Consent (first-time or re-consent) succeeded and the connection is executable.
 * Seeds all six domains due now and claims them at priority 1 so the org tab
 * has data within a tick instead of within six hours.
 *
 * Opens its OWN system context: the consent callback holds none at the call
 * site, and the enqueue must happen after the seeding commits.
 *
 * Never throws. A seeding fault must not turn a successful Microsoft consent
 * into a terminal failure redirect, and the ticker's
 * `reconcileEligibleConnections()` step re-seeds any executable connection
 * missing its rows on the next tick (spec §10.2).
 */
export async function onConnectionConsented(conn: {
  id: string;
  orgId: string;
  tenantId: string;
  status: 'active' | 'degraded';
}): Promise<void> {
  if (!isM365TenantSyncEnabled()) return;
  try {
    const now = new Date();
    await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      await db.insert(m365SyncState).values(M365_SYNC_DOMAINS.map((domain) => ({
        orgId: conn.orgId,
        connectionId: conn.id,
        domain,
        nextSyncAt: now,
        intervalSeconds: M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS[domain],
      }))).onConflictDoUpdate({
        target: [m365SyncState.orgId, m365SyncState.domain],
        // Re-point at the surviving connection and re-arm. History
        // (last_success_at, last_complete_snapshot_at, last_counts) is
        // deliberately NOT reset: a re-consent to the SAME tenant should not
        // make the org tab claim it has never synced. A rebind to a different
        // tenant goes through onConnectionDisconnected first, which deletes
        // these rows outright.
        set: {
          connectionId: sql`excluded.connection_id`,
          nextSyncAt: sql`excluded.next_sync_at`,
          updatedAt: sql`now()`,
        },
      });
    }));
    await claimAndEnqueue(conn.orgId, [...M365_SYNC_DOMAINS], 1);
  } catch (err) {
    console.error(
      `[m365Sync/lifecycle] Seeding failed for org=${conn.orgId} connection=${conn.id}; `
      + 'the ticker reconciliation will retry:',
      err,
    );
  }
}

/**
 * The connection was disconnected. Spec §5.8: delete the org's sync state and
 * every entity row; KEEP the time series (`m365_secure_score_snapshots`,
 * `m365_posture_rollups`) — those carry `tenant_id` and are filtered to the
 * current connection's tenant at read time, so history survives a rebind.
 *
 * Runs on the caller's AMBIENT system context: `disconnectConnection` already
 * holds one, so these deletes commit in the same transaction as the status
 * flip — a disconnect can never half-happen.
 *
 * Deliberately THROWS on failure, unlike the consent hook. A committed
 * disconnect that left a customer's user directory in our database is a
 * privacy defect; a failed disconnect the operator retries is not.
 */
export async function onConnectionDisconnected(conn: {
  id: string;
  orgId: string;
}): Promise<void> {
  await db.delete(m365Users).where(eq(m365Users.orgId, conn.orgId));
  await db.delete(m365IntuneDevices).where(eq(m365IntuneDevices.orgId, conn.orgId));
  await db.delete(m365CaPolicies).where(eq(m365CaPolicies.orgId, conn.orgId));
  await db.delete(m365LicenseSkus).where(eq(m365LicenseSkus.orgId, conn.orgId));
  await db.delete(m365SyncState).where(eq(m365SyncState.orgId, conn.orgId));
}

/**
 * An upgrade-consent promoted the manifest in place. Domains that had been
 * unscheduled for want of a scope are re-armed; domains that are already
 * scheduled keep their adaptive cadence (spec §5.7 last bullet).
 *
 * Called from W01's upgrade-apply branch in the consent callback (Task 12), at
 * the `// W05: onConnectionUpgraded(...)` seam. Idempotent by construction: it
 * only touches rows that are BOTH unscheduled and last_status = 'needs_consent',
 * so an approval that granted nothing costs one indexed UPDATE of zero rows and
 * a repeated call is free.
 */
export async function onConnectionUpgraded(conn: {
  id: string;
  orgId: string;
}): Promise<void> {
  if (!isM365TenantSyncEnabled()) return;
  try {
    const rearmed = await runOutsideDbContext(() => withSystemDbAccessContext(async () => db
      .update(m365SyncState)
      .set({ nextSyncAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(m365SyncState.orgId, conn.orgId),
        isNull(m365SyncState.nextSyncAt),
        eq(m365SyncState.lastStatus, 'needs_consent'),
      ))
      .returning({ domain: m365SyncState.domain })));
    const domains = rearmed.map((row) => row.domain as M365SyncDomain);
    if (domains.length > 0) await claimAndEnqueue(conn.orgId, domains, 1);
  } catch (err) {
    console.error(
      `[m365Sync/lifecycle] Upgrade re-seed failed for org=${conn.orgId} connection=${conn.id}:`,
      err,
    );
  }
}

/**
 * The on-demand route's effect. `claimAndEnqueue` sets `next_sync_at = now()`
 * and claims in one place, so nothing here duplicates the claim protocol.
 * Rate limiting, MFA and the connection check live in the route (Task 14).
 */
export async function requestOnDemandSync(input: {
  orgId: string;
  connectionId: string;
}): Promise<void> {
  if (!isM365TenantSyncEnabled()) return;
  await claimAndEnqueue(input.orgId, [...ON_DEMAND_SYNC_DOMAINS], 1);
}
```

`inArray` is imported for the disconnect variant reviewers often suggest
(one `DELETE` per table is clearer and each is a single indexed range on
`org_id`); drop the import if unused rather than restructuring.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/m365Sync/lifecycle.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365Sync/lifecycle.ts \
        apps/api/src/services/m365Sync/lifecycle.test.ts
git commit -m "feat(m365): sync lifecycle hooks (consent seed, disconnect, upgrade)

Spec §5.8/§5.2/§10. Consent success on active OR degraded seeds all six domains
due now and claims at priority 1, re-pointing existing rows at the surviving
connection without resetting their history. Disconnect deletes state and the
four entity tables and keeps the tenant-stamped time series. Upgrade-consent
re-arms only the rows left unscheduled with needs_consent.

The two hooks differ in DB posture on purpose: disconnect runs on the caller's
ambient system context (so the erasure commits with the status flip) and
throws, because a committed disconnect that left a customer's directory behind
is a privacy defect. Consent seeding opens its own context and never throws,
because a seeding fault must not turn a successful Microsoft consent into a
failure redirect — the ticker reconciliation retries it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 11: wire the disconnect hook into `connectionService.disconnectConnection`

Spec §5.8 first bullet, §6 last rows. `disconnectConnection`
(`connectionService.ts:715-757`) sets `revoked` and clears the tenant but keeps
the row, so no FK cascade fires — the erasure must be explicit.

**Files:**
- Modify: `apps/api/src/services/m365ControlPlane/connectionService.ts`
- Modify: `apps/api/src/services/m365ControlPlane/connectionService.test.ts`

**Interfaces:**
- Consumes: `onConnectionDisconnected` (Task 10).
- Produces: no new export; `disconnectConnection`'s observable behaviour gains
  the erasure.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/m365ControlPlane/connectionService.test.ts`:

```ts
vi.mock('../m365Sync/lifecycle', () => ({
  onConnectionDisconnected: vi.fn(async () => undefined),
  onConnectionConsented: vi.fn(async () => undefined),
  onConnectionUpgraded: vi.fn(async () => undefined),
}));
const onDisconnectedMock = vi.mocked(onConnectionDisconnected);

describe('disconnectConnection erases synced tenant data', () => {
  it('calls the sync disconnect hook inside the same system transaction', async () => {
    installConnectionRow({ id: CONNECTION_ID, orgId: ORG_ID, status: 'active' });
    await disconnectCustomerGraphReadConnection({ id: CONNECTION_ID, orgId: ORG_ID, actorId: ACTOR });
    expect(onDisconnectedMock).toHaveBeenCalledWith({ id: CONNECTION_ID, orgId: ORG_ID });
    // The hook must run under the context the service already opened, not a
    // nested one: exactly one system context for the whole disconnect.
    expect(withSystemDbAccessContextMock).toHaveBeenCalledOnce();
  });

  it('propagates a hook failure so the whole disconnect rolls back', async () => {
    installConnectionRow({ id: CONNECTION_ID, orgId: ORG_ID, status: 'active' });
    onDisconnectedMock.mockRejectedValueOnce(new Error('erase failed'));
    await expect(disconnectCustomerGraphReadConnection({
      id: CONNECTION_ID, orgId: ORG_ID, actorId: ACTOR,
    })).rejects.toThrow('erase failed');
  });

  it('runs the erasure for the actions profile too', async () => {
    installConnectionRow({ id: CONNECTION_ID, orgId: ORG_ID, status: 'active', profile: 'customer-graph-actions' });
    await disconnectCustomerGraphActionsConnection({ id: CONNECTION_ID, orgId: ORG_ID, actorId: ACTOR });
    expect(onDisconnectedMock).toHaveBeenCalledWith({ id: CONNECTION_ID, orgId: ORG_ID });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/m365ControlPlane/connectionService.test.ts`
Expected: FAIL — the hook is never called.

- [ ] **Step 3: Implement**

In `connectionService.ts`, import the hook and call it inside the existing
system context, after the CAS update produced its row:

```ts
import { onConnectionDisconnected } from '../m365Sync/lifecycle';
```

The shipped tail of `disconnectConnection` `return`s the CAS row directly. Bind
it to a local first, call the hook, then return it — the whole change is those
three lines plus the comment:

```ts
      const nextAttemptId = randomUUID();
      const disconnected = await requireCasRow(await db.update(m365Connections).set({
        consentAttemptId: nextAttemptId,
        tenantId: null,
        clientId: '',
        displayName: null,
        permissionManifestVersion: current.permissionManifestVersion,
        observedGrants: [],
        grantsVerifiedAt: null,
        lastVerifiedAt: null,
        consentedAt: null,
        expiresAt: null,
        status: 'revoked',
        revokedAt: new Date(),
        lastErrorCode: null,
        updatedAt: new Date(),
      }).where(attemptPredicate({
        id: current.id,
        orgId: current.orgId,
        profile,
        consentAttemptId: current.consentAttemptId,
        status: current.status,
      })).returning());

      // Spec §5.8: the row survives a disconnect (status 'revoked', tenant
      // cleared), so no FK cascade fires and the synced tenant snapshot would
      // otherwise outlive the connection that authorised it. The erasure runs
      // in THIS transaction — a committed disconnect that left m365_users
      // behind is a privacy defect — and is profile-agnostic because the sync
      // tables belong to the org, not to one profile's connection.
      await onConnectionDisconnected({ id: disconnected.id, orgId: disconnected.orgId });

      return disconnected;
```

Do not change any other field in that `set` object: the manifest version,
attempt rotation and grant clearing are the shipped disconnect semantics, and
W01's attempt-rotation fix (its Task 7) already touched the consent-session
deletion just above it.

Note the call is inside `withSystemDbAccessContext`, so `onConnectionDisconnected`
must not open its own (Task 10 asserts it does not).

**This task applies on top of W01's changes to `connectionService.ts`** (the
upgrade-consent service functions `initiateCustomerGraphReadUpgradeConsent`,
`transitionUpgradeConsentToIdentity`, `applyUpgradeVerificationResult`, the
`manifest_current` lifecycle error code, and the consent-session supersede fix):
re-read `disconnectConnection` before editing rather than applying the line
numbers above verbatim.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/m365ControlPlane/connectionService.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365ControlPlane/connectionService.ts \
        apps/api/src/services/m365ControlPlane/connectionService.test.ts
git commit -m "feat(m365): erase synced tenant data on disconnect

Spec §5.8. disconnectConnection sets status 'revoked' and clears the tenant but
keeps the row, so no FK cascade fires and the synced snapshot of the customer's
users, devices, CA policies and SKUs would outlive the consent that authorised
it. The hook now runs inside the same system transaction as the status flip, so
the disconnect cannot half-happen, and a hook failure rolls the whole thing
back rather than committing a partial erasure.

The tenant-stamped time series is kept: it survives a rebind and is filtered by
tenant_id at read time.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 12: wire consent seeding and the upgrade re-seed into W01's consent callback

Spec §5.8 bullets 2-3, §10.1 (every entry point flag-gated).

**This task depends on W01 and targets its restructured callback.** W01's Task 10
split the apply block into an explicit two-branch form and left this wave a seam:

```ts
      if (isUpgrade) {
        applied = await dependencies.applyUpgradeResult(attempt, result);
        // W05: onConnectionUpgraded(connection) is called here after in-place promotion
        outcome = upgradeOutcome(applied, currentManifestVersion);
      } else {
        applied = await dependencies.applyIdentityResult(attempt, result);
        outcome = outcomeFromConnection(applied);
      }
```

The two hooks map one-to-one onto those two branches: `onConnectionUpgraded` at
the seam comment in the upgrade branch, `onConnectionConsented` in the identity
branch. **There is no `driftOutcome`-keyed fallback and no "works either landing
order" alternative** — W05 is stacked on W01, so the branch exists. If the seam
comment is not in the file, stop and rebase; do not re-derive the wiring point
from `driftOutcome`.

**Files:**
- Modify: `apps/api/src/routes/m365ConsentCallback.ts`
- Modify: `apps/api/src/routes/m365ConsentCallback.test.ts`

**Interfaces:**
- Consumes: `onConnectionConsented`, `onConnectionUpgraded` (Task 10);
  `isM365TenantSyncEnabled` (W04); W01's `readSessionPurpose`,
  `applyUpgradeResult` and `applyIdentityResult` dependency members.
- Produces: no new export.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/routes/m365ConsentCallback.test.ts`, using the file's
`createM365ConsentCallbackRoutes({ … })` override style — the same style W01's
`upgrade consent callback` describe block already uses, so the upgrade cases
below drive W01's real `applyUpgradeResult` path rather than a synthesised one:

```ts
vi.mock('../services/m365Sync/lifecycle', () => ({
  onConnectionConsented: vi.fn(async () => undefined),
  onConnectionUpgraded: vi.fn(async () => undefined),
  onConnectionDisconnected: vi.fn(async () => undefined),
}));
vi.mock('../config/env', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isM365TenantSyncEnabled: vi.fn(() => true),
}));

const consentedMock = vi.mocked(onConnectionConsented);
const upgradedMock = vi.mocked(onConnectionUpgraded);
const syncFlagMock = vi.mocked(isM365TenantSyncEnabled);

/** Drives W01's identity branch: applyIdentityResult, purpose 'initial'. */
async function completeInitialConsent(applied: {
  status: 'active' | 'degraded' | 'pending-consent';
  lastErrorCode: string | null;
}) {
  const routes = createM365ConsentCallbackRoutes({
    verifyBindingCookie: vi.fn(() => identityBinding),
    readSessionPurpose: vi.fn(async () => 'initial' as const),
    loadAttempt: vi.fn(async () => ({
      id: CONNECTION_ID, orgId: ORG_ID, profile: 'customer-graph-read' as const,
      consentAttemptId: ATTEMPT_ID, status: 'verifying' as const,
    })),
    consumeSession: vi.fn(async () => ({
      userId: USER_ID, purpose: 'initial',
      tenantHintHash: tenantHintHash(TENANT_ID), nonce: 'n', codeVerifier: 'v',
    })),
    completeIdentity: vi.fn(async () => ({ success: true, tenantId: TENANT_ID })),
    applyIdentityResult: vi.fn(async () => ({
      id: CONNECTION_ID, orgId: ORG_ID, tenantId: TENANT_ID,
      status: applied.status, lastErrorCode: applied.lastErrorCode,
      permissionManifestVersion: 3,
    })),
    audit: vi.fn(),
    metric: vi.fn(),
  });
  const app = new Hono();
  app.route('/api/v1/m365', routes);
  return app.request('/api/v1/m365/consent/callback?state=identity-state&code=auth-code', {
    headers: { cookie: bindingCookie(identityBinding) },
  });
}

/** Drives W01's upgrade branch: applyUpgradeResult, purpose 'upgrade'. */
async function completeUpgradeConsent(manifestVersion: number) {
  const routes = createM365ConsentCallbackRoutes({
    verifyBindingCookie: vi.fn(() => identityBinding),
    readSessionPurpose: vi.fn(async () => 'upgrade' as const),
    loadAttempt: vi.fn(async () => ({
      id: CONNECTION_ID, orgId: ORG_ID, profile: 'customer-graph-read' as const,
      consentAttemptId: ATTEMPT_ID, status: 'active' as const,
    })),
    consumeSession: vi.fn(async () => ({
      userId: USER_ID, purpose: 'upgrade',
      tenantHintHash: tenantHintHash(TENANT_ID), nonce: 'n', codeVerifier: 'v',
    })),
    completeIdentity: vi.fn(async () => ({ success: true, tenantId: TENANT_ID })),
    applyUpgradeResult: vi.fn(async () => ({
      id: CONNECTION_ID, orgId: ORG_ID, tenantId: TENANT_ID,
      status: 'active' as const, lastErrorCode: null,
      permissionManifestVersion: manifestVersion,
    })),
    applyIdentityResult: vi.fn(),
    audit: vi.fn(),
    metric: vi.fn(),
  });
  const app = new Hono();
  app.route('/api/v1/m365', routes);
  return app.request('/api/v1/m365/consent/callback?state=identity-state&code=auth-code', {
    headers: { cookie: bindingCookie(identityBinding) },
  });
}

describe('sync seeding on consent success', () => {
  beforeEach(() => { syncFlagMock.mockReturnValue(true); });

  it('seeds when the applied connection is active', async () => {
    const response = await completeInitialConsent({ status: 'active', lastErrorCode: null });
    expect(response.status).toBe(302);
    expect(consentedMock).toHaveBeenCalledWith({
      id: CONNECTION_ID, orgId: ORG_ID, tenantId: TENANT_ID, status: 'active',
    });
    expect(upgradedMock).not.toHaveBeenCalled();
  });

  it('seeds when the applied connection is DEGRADED', async () => {
    await completeInitialConsent({ status: 'degraded', lastErrorCode: 'grant_missing' });
    expect(consentedMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'degraded' }));
  });

  it('does not seed when verification failed', async () => {
    await completeInitialConsent({ status: 'pending-consent', lastErrorCode: 'consent_expired' });
    expect(consentedMock).not.toHaveBeenCalled();
    expect(upgradedMock).not.toHaveBeenCalled();
  });

  it('does not seed when the flag is off', async () => {
    syncFlagMock.mockReturnValue(false);
    await completeInitialConsent({ status: 'active', lastErrorCode: null });
    expect(consentedMock).not.toHaveBeenCalled();
  });

  it('still redirects successfully when the seeding hook rejects', async () => {
    consentedMock.mockRejectedValueOnce(new Error('seed boom'));
    const response = await completeInitialConsent({ status: 'active', lastErrorCode: null });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('active');
  });
});

describe('sync re-seed on upgrade consent', () => {
  beforeEach(() => { syncFlagMock.mockReturnValue(true); });

  it('re-arms unscheduled needs_consent domains from W01 upgrade-apply branch', async () => {
    const response = await completeUpgradeConsent(3);
    expect(response.status).toBe(302);
    expect(upgradedMock).toHaveBeenCalledWith({ id: CONNECTION_ID, orgId: ORG_ID });
    // The upgrade branch is not a fresh consent: the six state rows already
    // exist and their history must not be re-pointed.
    expect(consentedMock).not.toHaveBeenCalled();
  });

  it('is called before the outcome is derived, so a promotion is never reported as stale', async () => {
    const response = await completeUpgradeConsent(3);
    expect(response.headers.get('location')).toContain('active');
    expect(upgradedMock).toHaveBeenCalledOnce();
  });

  it('is still called when the version did not move — the hook is idempotent', async () => {
    // An approval that granted nothing leaves the connection executable and the
    // manifest stale. Re-arming is a no-op in that case (the domains are still
    // needs_consent after the next run), and making the call unconditional
    // keeps the seam a single line with no outcome logic in it.
    const response = await completeUpgradeConsent(2);
    expect(response.headers.get('location')).toContain('manifest_stale');
    expect(upgradedMock).toHaveBeenCalledOnce();
  });

  it('does not re-seed when the flag is off', async () => {
    syncFlagMock.mockReturnValue(false);
    await completeUpgradeConsent(3);
    expect(upgradedMock).not.toHaveBeenCalled();
  });

  it('still redirects successfully when the upgrade hook rejects', async () => {
    upgradedMock.mockRejectedValueOnce(new Error('reseed boom'));
    const response = await completeUpgradeConsent(3);
    expect(response.status).toBe(302);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/m365ConsentCallback.test.ts`
Expected: FAIL — no hook is called on either branch.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/m365ConsentCallback.ts`:

```ts
import { isM365TenantSyncEnabled } from '../config/env';
import { onConnectionConsented, onConnectionUpgraded } from '../services/m365Sync/lifecycle';
```

Add one small local helper next to `outcomeFromConnection`, so neither branch
carries a try/catch of its own:

```ts
/**
 * Spec §10.1. Every sync entry point is flag-gated, and a Microsoft consent that
 * actually succeeded must never redirect the administrator to a failure page
 * because our scheduler had a bad minute. The lifecycle hooks already log; the
 * ticker's reconciliation re-seeds on the next tick.
 */
async function runSyncLifecycleHook(label: string, run: () => Promise<void>): Promise<void> {
  if (!isM365TenantSyncEnabled()) return;
  try {
    await run();
  } catch (err) {
    console.error(`[m365ConsentCallback] ${label} failed:`, err);
  }
}
```

Then fill W01's two branches. The upgrade call replaces the seam comment
verbatim, immediately after the in-place promotion and before the outcome is
derived:

```ts
    try {
      let applied: CallbackConnectionSnapshot;
      let outcome: PublicOutcome;
      if (isUpgrade) {
        applied = await dependencies.applyUpgradeResult(attempt, result);
        // Spec §5.8: an upgrade-consent promotes the manifest in place, so the
        // domains parked on `needs_consent` for want of a v3 scope are re-armed.
        // Unconditional and idempotent: onConnectionUpgraded only touches rows
        // that are BOTH unscheduled and last_status = 'needs_consent', so an
        // approval that granted nothing costs one indexed UPDATE of zero rows.
        await runSyncLifecycleHook(
          `sync re-seed for connection=${applied.id}`,
          () => onConnectionUpgraded({ id: applied.id, orgId: applied.orgId }),
        );
        outcome = upgradeOutcome(applied, currentManifestVersion);
      } else {
        applied = await dependencies.applyIdentityResult(attempt, result);
        // A verified first-time (or re-)consent seeds all six domains due now at
        // priority 1, for `degraded` as well as `active` — a connection missing
        // one optional grant still syncs every other domain.
        if (applied.tenantId && (applied.status === 'active' || applied.status === 'degraded')) {
          const status = applied.status;
          await runSyncLifecycleHook(
            `sync seeding for connection=${applied.id}`,
            () => onConnectionConsented({
              id: applied.id, orgId: applied.orgId, tenantId: applied.tenantId!, status,
            }),
          );
        }
        outcome = outcomeFromConnection(applied);
      }
```

`applied.status` is narrowed to `'active' | 'degraded'` by the enclosing `if`; if
TypeScript does not carry the narrowing into the closure, the local
`const status = applied.status` above does it explicitly — never cast the object.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/m365ConsentCallback.test.ts`
Expected: PASS — including every pre-existing W01 upgrade case.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/m365ConsentCallback.ts \
        apps/api/src/routes/m365ConsentCallback.test.ts
git commit -m "feat(m365): seed tenant sync from the consent callback

Spec §5.8/§10.1. W01 split the callback's apply block into an explicit
isUpgrade ? applyUpgradeResult : applyIdentityResult form and left a seam
comment in the upgrade branch; this fills both halves. The identity branch seeds
all six sync domains due now at priority 1 whenever the applied connection is
active OR degraded, so the org tab has data within a tick. The upgrade branch
calls onConnectionUpgraded at the seam, right after the in-place manifest
promotion, re-arming the domains that had been parked on needs_consent for want
of a v3 scope.

Both calls are flag-gated and wrapped by one shared helper: a Microsoft consent
that actually succeeded must never redirect the administrator to a failure page
because our scheduler had a bad minute — the hooks log and the ticker
reconciliation re-seeds. The upgrade hook is unconditional because it is
idempotent: it only touches rows that are both unscheduled and needs_consent.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 13: `onDemandLimiter.ts` — one sync per org per 15 minutes

Spec §5.2 ("Redis-limited to one call per org per 15 min"), fail-closed
discipline from `readActionBudget.ts`.

**Files:**
- Create: `apps/api/src/services/m365Sync/onDemandLimiter.ts`
- Create: `apps/api/src/services/m365Sync/onDemandLimiter.test.ts`

**Interfaces:**
- Consumes: `getRedis` (`services/redis.ts`).
- Produces: `consumeOnDemandSyncSlot(orgId): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }>`;
  `export const ON_DEMAND_SYNC_WINDOW_SECONDS = 900`.

- [ ] **Step 1: Write the failing test**

`apps/api/src/services/m365Sync/onDemandLimiter.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRedis } from '../redis';
import { ON_DEMAND_SYNC_WINDOW_SECONDS, consumeOnDemandSyncSlot } from './onDemandLimiter';

vi.mock('../redis', () => ({ getRedis: vi.fn() }));

const ORG = '11111111-1111-4111-8111-111111111111';
const set = vi.fn();
const ttl = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRedis).mockReturnValue({ set, ttl } as never);
});

describe('consumeOnDemandSyncSlot', () => {
  it('allows the first call in the window and reserves the slot with NX+EX', async () => {
    set.mockResolvedValueOnce('OK');
    await expect(consumeOnDemandSyncSlot(ORG)).resolves.toEqual({ allowed: true });
    expect(set).toHaveBeenCalledWith(
      `m365-sync-on-demand-${ORG}`, '1', 'EX', ON_DEMAND_SYNC_WINDOW_SECONDS, 'NX',
    );
  });

  it('denies a second call and reports the remaining TTL', async () => {
    set.mockResolvedValueOnce(null);
    ttl.mockResolvedValueOnce(412);
    await expect(consumeOnDemandSyncSlot(ORG)).resolves.toEqual({
      allowed: false, retryAfterSeconds: 412,
    });
  });

  it('falls back to the full window when the TTL is missing or non-positive', async () => {
    set.mockResolvedValue(null);
    for (const value of [-1, -2, 0, null, undefined, 'x']) {
      ttl.mockResolvedValueOnce(value as never);
      await expect(consumeOnDemandSyncSlot(ORG)).resolves.toEqual({
        allowed: false, retryAfterSeconds: ON_DEMAND_SYNC_WINDOW_SECONDS,
      });
    }
  });

  it('fails CLOSED when Redis is unavailable', async () => {
    vi.mocked(getRedis).mockReturnValue(null as never);
    await expect(consumeOnDemandSyncSlot(ORG)).resolves.toEqual({
      allowed: false, retryAfterSeconds: ON_DEMAND_SYNC_WINDOW_SECONDS,
    });
  });

  it('fails CLOSED when Redis throws', async () => {
    set.mockRejectedValueOnce(new Error('connection reset'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(consumeOnDemandSyncSlot(ORG)).resolves.toEqual({
      allowed: false, retryAfterSeconds: ON_DEMAND_SYNC_WINDOW_SECONDS,
    });
    expect(spy).toHaveBeenCalled();
  });

  it('scopes the key per org', async () => {
    set.mockResolvedValue('OK');
    await consumeOnDemandSyncSlot('22222222-2222-4222-8222-222222222222');
    expect(set.mock.calls[0]![0]).toBe('m365-sync-on-demand-22222222-2222-4222-8222-222222222222');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/m365Sync/onDemandLimiter.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

`apps/api/src/services/m365Sync/onDemandLimiter.ts`:

```ts
import { getRedis } from '../redis';

/**
 * One on-demand sync per org per 15 minutes (spec §5.2). A `SET NX EX`
 * reservation rather than a counter: the semantics are "a slot is held", the
 * remaining TTL is exactly the retry hint the client needs, and there is no
 * window-boundary burst where two calls land back to back.
 *
 * Fails CLOSED, matching readActionBudget.ts: a limit we cannot evaluate must
 * not authorise an unbounded number of whole-tenant Graph pulls. The cost of
 * a false denial is one technician waiting 15 minutes.
 */
export const ON_DEMAND_SYNC_WINDOW_SECONDS = 900;

export type OnDemandSyncSlot =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

function key(orgId: string): string {
  return `m365-sync-on-demand-${orgId}`;
}

function denied(retryAfterSeconds = ON_DEMAND_SYNC_WINDOW_SECONDS): OnDemandSyncSlot {
  return { allowed: false, retryAfterSeconds };
}

export async function consumeOnDemandSyncSlot(orgId: string): Promise<OnDemandSyncSlot> {
  try {
    const redis = getRedis();
    if (!redis) {
      console.error(`[m365Sync/onDemandLimiter] Redis unavailable, failing closed for org=${orgId}`);
      return denied();
    }
    const reserved = await redis.set(key(orgId), '1', 'EX', ON_DEMAND_SYNC_WINDOW_SECONDS, 'NX');
    if (reserved === 'OK') return { allowed: true };

    // -1 (no expiry) and -2 (no key — it expired between SET and TTL) both mean
    // "we cannot say"; fall back to the full window rather than inventing a
    // shorter hint that would invite an immediate retry.
    const remaining = await redis.ttl(key(orgId));
    const seconds = typeof remaining === 'number' && remaining > 0 ? remaining : ON_DEMAND_SYNC_WINDOW_SECONDS;
    return denied(seconds);
  } catch (err) {
    console.error(`[m365Sync/onDemandLimiter] Redis error for org=${orgId}, failing closed:`, err);
    return denied();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/m365Sync/onDemandLimiter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365Sync/onDemandLimiter.ts \
        apps/api/src/services/m365Sync/onDemandLimiter.test.ts
git commit -m "feat(m365): Redis limiter for on-demand tenant sync (1 per org / 15 min)

Spec §5.2. A SET NX EX reservation rather than a fixed-window counter: the
remaining TTL is exactly the retry hint the caller needs and there is no
boundary burst where two whole-tenant pulls land back to back. Fails closed on
Redis unavailability or error, matching readActionBudget.ts — the cost of a
false denial is one technician waiting, the cost of a false allow is unbounded
Graph load on a customer tenant.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 14: `POST /m365/connections/:id/sync` — MFA-gated on-demand route

Spec §5.2 ("MFA-gated like retest"), §10.1 (flag gates every entry point).
Copies the retest route's middleware chain
(`m365CustomerGraphRead.ts:252-298`) exactly: `requireOrgsWrite`,
`requireMfa()`, `zValidator('param', idParam)`, then `mutationOrg(c)`.

**This task applies on top of W01's changes to `m365CustomerGraphRead.ts`** —
`toConnectionDto` already returns `grantHealth` / `manifestVersion` /
`currentManifestVersion`, and `POST /connections/:id/upgrade-consent` is already
mounted in this file. Re-read the file before editing and add this route beside
that one; the line numbers above are pre-W01.

**Files:**
- Modify: `apps/api/src/routes/m365CustomerGraphRead.ts`
- Modify: `apps/api/src/routes/m365CustomerGraphRead.test.ts`
- Modify: `apps/api/src/services/m365ControlPlane/metrics.ts`
- Modify: `apps/api/src/services/m365ControlPlane/metrics.test.ts`

**Interfaces:**
- Consumes: `consumeOnDemandSyncSlot`, `ON_DEMAND_SYNC_WINDOW_SECONDS`
  (Task 13); `requestOnDemandSync`, `ON_DEMAND_SYNC_DOMAINS` (Task 10);
  `isM365TenantSyncEnabled` (W04); `listCustomerGraphReadConnections`,
  `requireMfa`, `requirePermission` (shipped).
- Produces: the route; the audit event
  `'m365.customer_graph_read.sync_requested'`.

- [ ] **Step 1: Write the failing tests**

First extend `apps/api/src/services/m365ControlPlane/metrics.test.ts`. The case
asserts the exact event array; the shipped seven became **eight** when W01
inserted `upgrade_consent_initiated` immediately after `consent_initiated`, and
this wave appends the ninth at the end. Order matters — the assertion is
`toEqual` on an array, and the overview fixes both positions:

```ts
  it('exposes exactly the nine fixed lifecycle events and a bounded outcome enum', () => {
    expect(M365_CUSTOMER_GRAPH_READ_EVENTS).toEqual([
      'm365.customer_graph_read.consent_initiated',
      // W01, position 2 — inserted directly after consent_initiated.
      'm365.customer_graph_read.upgrade_consent_initiated',
      'm365.customer_graph_read.admin_consent_returned',
      'm365.customer_graph_read.tenant_binding_verified',
      'm365.customer_graph_read.verification_failed',
      'm365.customer_graph_read.grant_drift_detected',
      'm365.customer_graph_read.retested',
      'm365.customer_graph_read.disconnected',
      // W05, appended last.
      'm365.customer_graph_read.sync_requested',
    ]);
    expect(M365_CUSTOMER_GRAPH_READ_EVENTS).toHaveLength(9);
    expect(new Set(M365_CUSTOMER_GRAPH_READ_OUTCOMES).size)
      .toBe(M365_CUSTOMER_GRAPH_READ_OUTCOMES.length);
  });
```

If `upgrade_consent_initiated` is not already in the shipped array, W01 is not on
your base branch — rebase rather than adding it here.

Then append to `apps/api/src/routes/m365CustomerGraphRead.test.ts`:

```ts
vi.mock('../services/m365Sync/onDemandLimiter', () => ({
  ON_DEMAND_SYNC_WINDOW_SECONDS: 900,
  consumeOnDemandSyncSlot: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('../services/m365Sync/lifecycle', () => ({
  ON_DEMAND_SYNC_DOMAINS: ['users', 'intune_devices', 'ca_policies', 'skus', 'secure_score'],
  requestOnDemandSync: vi.fn(async () => undefined),
}));

const slotMock = vi.mocked(consumeOnDemandSyncSlot);
const requestSyncMock = vi.mocked(requestOnDemandSync);
const syncFlagMock = vi.mocked(isM365TenantSyncEnabled);

async function postSync(headers: Record<string, string> = {}) {
  return app.request(`/m365/connections/${CONNECTION_ID}/sync?orgId=${ORG_ID}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${MFA_TOKEN}`, ...headers },
  });
}

describe('POST /m365/connections/:id/sync', () => {
  beforeEach(() => {
    syncFlagMock.mockReturnValue(true);
    slotMock.mockResolvedValue({ allowed: true });
    installConnections([{ id: CONNECTION_ID, orgId: ORG_ID, status: 'active' }]);
  });

  it('requests the five non-sign-in domains and echoes them', async () => {
    const response = await postSync();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      requested: true,
      domains: ['users', 'intune_devices', 'ca_policies', 'skus', 'secure_score'],
    });
    expect(requestSyncMock).toHaveBeenCalledWith({ orgId: ORG_ID, connectionId: CONNECTION_ID });
  });

  it('is MFA-gated exactly like retest', async () => {
    const response = await app.request(`/m365/connections/${CONNECTION_ID}/sync?orgId=${ORG_ID}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${NON_MFA_TOKEN}` },
    });
    expect(response.status).toBe(403);
    expect(requestSyncMock).not.toHaveBeenCalled();
  });

  it('requires organizations:write', async () => {
    const response = await app.request(`/m365/connections/${CONNECTION_ID}/sync?orgId=${ORG_ID}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${READ_ONLY_MFA_TOKEN}` },
    });
    expect(response.status).toBe(403);
    expect(requestSyncMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the tenant-sync flag is off, WITHOUT burning a slot', async () => {
    syncFlagMock.mockReturnValue(false);
    const response = await postSync();
    expect(response.status).toBe(404);
    expect(slotMock).not.toHaveBeenCalled();
    expect(requestSyncMock).not.toHaveBeenCalled();
  });

  it('returns 429 with retryAfter and a Retry-After header when limited', async () => {
    slotMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 412 });
    const response = await postSync();
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('412');
    await expect(response.json()).resolves.toMatchObject({ retryAfter: 412 });
    expect(requestSyncMock).not.toHaveBeenCalled();
  });

  it('404s an unknown connection id before consuming a slot', async () => {
    installConnections([]);
    const response = await postSync();
    expect(response.status).toBe(404);
    expect(slotMock).not.toHaveBeenCalled();
  });

  it('404s a connection that is not executable', async () => {
    installConnections([{ id: CONNECTION_ID, orgId: ORG_ID, status: 'revoked' }]);
    const response = await postSync();
    expect(response.status).toBe(404);
    expect(slotMock).not.toHaveBeenCalled();
  });

  it('404s a connection belonging to another org', async () => {
    installConnections([{ id: CONNECTION_ID, orgId: OTHER_ORG_ID, status: 'active' }]);
    const response = await postSync();
    expect(response.status).toBe(404);
  });

  it('records the sync_requested audit event', async () => {
    await postSync();
    expect(recordEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'm365.customer_graph_read.sync_requested',
      orgId: ORG_ID,
      connectionId: CONNECTION_ID,
      outcome: 'initiated',
    }));
  });

  it('accepts a degraded connection — a missing optional grant still syncs the rest', async () => {
    installConnections([{ id: CONNECTION_ID, orgId: ORG_ID, status: 'degraded' }]);
    expect((await postSync()).status).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/routes/m365CustomerGraphRead.test.ts src/services/m365ControlPlane/metrics.test.ts`
Expected: FAIL — the route 404s as an unknown path and the event list has W01's
eight entries, not nine.

- [ ] **Step 3: Implement**

In `apps/api/src/services/m365ControlPlane/metrics.ts`, append to
`M365_CUSTOMER_GRAPH_READ_EVENTS` (append only — W01 owns the position of
`upgrade_consent_initiated` near the top of the array and it must not move):

```ts
  'm365.customer_graph_read.disconnected',
  // On-demand tenant sync requested by a technician (spec §5.2). Outcome is
  // always 'initiated' — the run's own outcome is the sync worker's audit
  // event, not this one.
  'm365.customer_graph_read.sync_requested',
] as const;
```

In `apps/api/src/routes/m365CustomerGraphRead.ts`:

```ts
import { isM365TenantSyncEnabled } from '../config/env';
import {
  ON_DEMAND_SYNC_DOMAINS,
  requestOnDemandSync,
} from '../services/m365Sync/lifecycle';
import { consumeOnDemandSyncSlot } from '../services/m365Sync/onDemandLimiter';
```

```ts
m365CustomerGraphReadRoutes.post(
  '/connections/:id/sync',
  requireOrgsWrite,
  requireMfa(),
  zValidator('param', idParam),
  async (c) => {
    const resolved = mutationOrg(c);
    if (resolved instanceof Response) return resolved;
    if (!('orgId' in resolved)) return c.json({ error: 'Connection not found' }, 404);
    // Flag first: a disabled feature must never consume a rate-limit slot, and
    // the 404 matches how onboarding-disabled is reported on the consent route.
    if (!isM365TenantSyncEnabled()) {
      return c.json({ error: 'Microsoft 365 tenant sync is not enabled' }, 404);
    }
    const { id } = c.req.valid('param');

    // Resolve the connection before the limiter so a 404 is free: probing a
    // wrong id must not lock a legitimate technician out for 15 minutes.
    const connections = await listCustomerGraphReadConnections(resolved.orgId);
    const connection = connections.find((value) => value.id === id) ?? null;
    if (!connection || !(connection.status === 'active' || connection.status === 'degraded')) {
      return c.json({ error: 'Connection not found' }, 404);
    }

    const slot = await consumeOnDemandSyncSlot(resolved.orgId);
    if (!slot.allowed) {
      c.header('Retry-After', String(slot.retryAfterSeconds));
      return c.json({
        error: 'A tenant sync was requested recently. Try again shortly.',
        retryAfter: slot.retryAfterSeconds,
      }, 429);
    }

    try {
      await requestOnDemandSync({ orgId: resolved.orgId, connectionId: connection.id });
    } catch (error) {
      return lifecycleFailure(c, error);
    }

    const auth = c.get('auth');
    recordM365CustomerGraphReadEvent(c, {
      event: 'm365.customer_graph_read.sync_requested',
      orgId: resolved.orgId,
      connectionId: connection.id,
      profile: PROFILE_ID,
      consentAttemptId: connection.consentAttemptId,
      manifestVersion: connection.permissionManifestVersion,
      outcome: 'initiated',
      correlationId: randomUUID(),
      actorId: auth.user.id,
      actorEmail: auth.user.email,
    });
    return c.json({ requested: true, domains: [...ON_DEMAND_SYNC_DOMAINS] });
  },
);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/m365CustomerGraphRead.test.ts src/services/m365ControlPlane/metrics.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/m365CustomerGraphRead.ts \
        apps/api/src/routes/m365CustomerGraphRead.test.ts \
        apps/api/src/services/m365ControlPlane/metrics.ts \
        apps/api/src/services/m365ControlPlane/metrics.test.ts
git commit -m "feat(m365): MFA-gated on-demand tenant sync route

Spec §5.2/§10.1. POST /m365/connections/:id/sync copies the retest route's
middleware chain (organizations:write + requireMfa + org resolution) and claims
the five non-sign-in domains at priority 1; sign-in activity is excluded
because its Graph limit is app-wide, so one 'Sync now' must not spend the
region's budget.

Order is deliberate: the flag is checked first so a disabled feature never
burns a slot, the connection is resolved before the limiter so probing a wrong
id cannot lock a technician out for 15 minutes, and a limited call answers 429
with both a retryAfter body field and a Retry-After header.

Adds the ninth lifecycle audit event, m365.customer_graph_read.sync_requested,
appended after W01's eight.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 15: read-envelope DTO — `syncEnabled` and the per-domain `sync` block

Spec §6 "Surfaced" column (org tab "as of" per fact), §2.2 item 1's DTO
precedent. **The two fields go on the ENVELOPE, not on the connection DTO** —
that is what the shared contract fixes, and it is why the web change in Task 16
is a `parseEnvelope` change rather than a `parseConnection` one. Both the API
shape and every pixel that renders it belong to this wave; **W06 adds no card
code and re-adds no field.** Say so in the PR body.

**This task applies on top of W01's changes to `m365CustomerGraphRead.ts`:**
`toConnectionDto` already returns `grantHealth`, `manifestVersion` and
`currentManifestVersion`, the envelope's `profile.manifestVersion` literal has
already been widened from `2` to `number`, and `POST /connections/:id/upgrade-consent`
is already mounted. Re-read the file before editing.

**Files:**
- Create: `apps/api/src/services/m365Sync/summary.ts`
- Create: `apps/api/src/services/m365Sync/summary.test.ts`
- Modify: `apps/api/src/routes/m365CustomerGraphRead.ts`
- Modify: `apps/api/src/routes/m365CustomerGraphRead.test.ts`

**Interfaces:**
- Consumes: `M365_SYNC_DOMAINS`, `M365SyncDomain` (W03); `M365SyncOutcome`
  (`m365Sync/types.ts`, W04); `m365SyncState`, `m365PostureRollups` (W02);
  `db`; `isM365TenantSyncEnabled` (W04).
- Produces — **exactly the contract's shape, no more and no less**:
  ```ts
  export interface M365SyncDomainSummary {
    domain: M365SyncDomain;
    status: M365SyncOutcome | 'never';   // 'never' when last_status IS NULL
    asOf: string | null;                 // last_complete_snapshot_at
    truncated: boolean;
    unlicensed: boolean;                 // sources.signInActivity === 'unlicensed'
  }
  export interface M365SyncSummary {
    lastSuccessAt: string | null;
    users: number | null;                // m365_posture_rollups.users_total (latest row)
    devices: number | null;              // m365_posture_rollups.devices_total (latest row)
    domains: M365SyncDomainSummary[];
  }
  export async function loadSyncSummary(orgId: string): Promise<M365SyncSummary | null>;
  ```
  plus `CustomerGraphReadEnvelope` gaining `syncEnabled: boolean` and
  `sync: M365SyncSummary | null`.

  **There is no `needsConsent` field.** `needs_consent` is one of the five
  `M365SyncOutcome` values `status` already carries; a separate boolean would be
  a second encoding of the same fact and the card would have to decide which one
  wins.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/m365Sync/summary.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db';
import { isM365TenantSyncEnabled } from '../../config/env';
import { loadSyncSummary } from './summary';

vi.mock('../../db', () => ({ db: { select: vi.fn() } }));
vi.mock('../../config/env', () => ({ isM365TenantSyncEnabled: vi.fn(() => true) }));

const ORG = '11111111-1111-4111-8111-111111111111';

/**
 * The service issues two selects: the org's sync-state rows, then the newest
 * posture rollup. Queue the results in that order.
 */
function selects(stateRows: unknown[], rollupRows: unknown[]) {
  const stateChain = { from: vi.fn(() => ({ where: vi.fn(async () => stateRows) })) };
  const rollupChain = {
    from: vi.fn(() => ({
      where: vi.fn(() => ({ orderBy: vi.fn(() => ({ limit: vi.fn(async () => rollupRows) })) })),
    })),
  };
  vi.mocked(db.select)
    .mockReturnValueOnce(stateChain as never)
    .mockReturnValueOnce(rollupChain as never);
}

function state(overrides: Record<string, unknown>) {
  return {
    domain: 'users',
    lastStatus: 'success',
    lastSuccessAt: new Date('2026-09-08T06:00:00.000Z'),
    lastCompleteSnapshotAt: new Date('2026-09-08T06:00:00.000Z'),
    truncated: false,
    sources: { users: 'ok' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isM365TenantSyncEnabled).mockReturnValue(true);
});

describe('loadSyncSummary', () => {
  it('returns null and issues NO query when the flag is off', async () => {
    vi.mocked(isM365TenantSyncEnabled).mockReturnValue(false);
    await expect(loadSyncSummary(ORG)).resolves.toBeNull();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns null, and never reads the rollup, when the org has no state rows', async () => {
    selects([], []);
    await expect(loadSyncSummary(ORG)).resolves.toBeNull();
    expect(db.select).toHaveBeenCalledOnce();
  });

  it('lists all six domains in canonical order, filling gaps as never-synced', async () => {
    selects([state({})], []);
    const summary = (await loadSyncSummary(ORG))!;
    expect(summary.domains.map((d) => d.domain)).toEqual([
      'users', 'signin_activity', 'intune_devices', 'ca_policies', 'skus', 'secure_score',
    ]);
    expect(summary.domains[0]).toEqual({
      domain: 'users', status: 'success',
      asOf: '2026-09-08T06:00:00.000Z', truncated: false, unlicensed: false,
    });
    expect(summary.domains[1]).toEqual({
      domain: 'signin_activity', status: 'never',
      asOf: null, truncated: false, unlicensed: false,
    });
  });

  it("reports status 'never' when last_status is NULL, and asOf from last_complete_snapshot_at", async () => {
    selects([state({
      lastStatus: null,
      lastSuccessAt: null,
      lastCompleteSnapshotAt: null,
    })], []);
    const summary = (await loadSyncSummary(ORG))!;
    expect(summary.domains[0]!.status).toBe('never');
    expect(summary.domains[0]!.asOf).toBeNull();
  });

  it('does NOT use last_success_at as asOf — asOf is the complete-snapshot time', async () => {
    selects([state({
      lastSuccessAt: new Date('2026-09-08T09:00:00.000Z'),
      lastCompleteSnapshotAt: new Date('2026-09-08T06:00:00.000Z'),
    })], []);
    const summary = (await loadSyncSummary(ORG))!;
    expect(summary.domains[0]!.asOf).toBe('2026-09-08T06:00:00.000Z');
  });

  it('reports the NEWEST successful domain as the envelope lastSuccessAt', async () => {
    selects([
      state({ domain: 'users', lastSuccessAt: new Date('2026-09-08T06:00:00.000Z') }),
      state({ domain: 'skus', lastSuccessAt: new Date('2026-09-08T09:00:00.000Z') }),
      state({ domain: 'ca_policies', lastStatus: 'needs_consent', lastSuccessAt: null, lastCompleteSnapshotAt: null }),
    ], []);
    const summary = (await loadSyncSummary(ORG))!;
    expect(summary.lastSuccessAt).toBe('2026-09-08T09:00:00.000Z');
  });

  it('carries needs_consent, throttled and error through as statuses, not booleans', async () => {
    selects([
      state({ domain: 'ca_policies', lastStatus: 'needs_consent' }),
      state({ domain: 'skus', lastStatus: 'throttled' }),
      state({ domain: 'secure_score', lastStatus: 'error' }),
    ], []);
    const summary = (await loadSyncSummary(ORG))!;
    const byDomain = Object.fromEntries(summary.domains.map((d) => [d.domain, d]));
    expect(byDomain.ca_policies!.status).toBe('needs_consent');
    expect(byDomain.skus!.status).toBe('throttled');
    expect(byDomain.secure_score!.status).toBe('error');
    expect(byDomain.ca_policies).not.toHaveProperty('needsConsent');
  });

  it('flags truncated per domain and unlicensed only from sources.signInActivity', async () => {
    selects([
      state({ domain: 'users', lastStatus: 'partial', truncated: true }),
      state({ domain: 'signin_activity', sources: { signInActivity: 'unlicensed' } }),
      state({ domain: 'skus', sources: { subscribedSkus: 'unlicensed' } }),
    ], []);
    const summary = (await loadSyncSummary(ORG))!;
    const byDomain = Object.fromEntries(summary.domains.map((d) => [d.domain, d]));
    expect(byDomain.users!.truncated).toBe(true);
    expect(byDomain.signin_activity!.unlicensed).toBe(true);
    // Only the signInActivity key means "the tenant has no Entra ID P1"; an
    // unlicensed value on any other source key is not that fact.
    expect(byDomain.skus!.unlicensed).toBe(false);
  });

  it('takes users and devices from the NEWEST posture rollup row', async () => {
    selects([state({})], [{ usersTotal: 128, devicesTotal: 96 }]);
    const summary = (await loadSyncSummary(ORG))!;
    expect(summary.users).toBe(128);
    expect(summary.devices).toBe(96);
  });

  it('reports users and devices as null when there is no rollup yet, or the counter is NULL', async () => {
    selects([state({})], []);
    await expect(loadSyncSummary(ORG)).resolves.toMatchObject({ users: null, devices: null });

    selects([state({})], [{ usersTotal: 10, devicesTotal: null }]);
    await expect(loadSyncSummary(ORG)).resolves.toMatchObject({ users: 10, devices: null });
  });

  it("is null-safe on an unknown stored status, reporting 'never' rather than leaking it", async () => {
    selects([state({ lastStatus: 'weird' })], []);
    const summary = (await loadSyncSummary(ORG))!;
    expect(summary.domains[0]!.status).toBe('never');
  });
});
```

Append to `apps/api/src/routes/m365CustomerGraphRead.test.ts`:

```ts
describe('GET /m365/connections exposes the sync block on the envelope', () => {
  it('carries syncEnabled true and the summary when the flag is on', async () => {
    syncFlagMock.mockReturnValue(true);
    summaryMock.mockResolvedValue({
      lastSuccessAt: '2026-09-08T09:00:00.000Z',
      users: 128,
      devices: 96,
      domains: [],
    });
    const body = await (await getConnections()).json();
    expect(body.syncEnabled).toBe(true);
    expect(body.sync).toEqual({
      lastSuccessAt: '2026-09-08T09:00:00.000Z', users: 128, devices: 96, domains: [],
    });
  });

  it('carries syncEnabled false and a null sync block when the flag is off', async () => {
    syncFlagMock.mockReturnValue(false);
    summaryMock.mockResolvedValue(null);
    const body = await (await getConnections()).json();
    expect(body.syncEnabled).toBe(false);
    expect(body.sync).toBeNull();
  });

  it('puts the fields on the ENVELOPE, never on the connection DTO', async () => {
    const body = await (await getConnections()).json();
    expect(body.connection).not.toHaveProperty('sync');
    expect(body.connection).not.toHaveProperty('syncEnabled');
  });

  it('keeps the envelope key set exact so the web parser stays strict', async () => {
    const body = await (await getConnections()).json();
    expect(Object.keys(body).sort()).toEqual([
      'connection', 'onboardingEnabled', 'profile', 'sync', 'syncEnabled',
    ]);
  });

  it("does not disturb W01's connection DTO fields", async () => {
    const body = await (await getConnections()).json();
    expect(body.connection).toMatchObject({
      grantHealth: expect.any(String),
      manifestVersion: expect.any(Number),
      currentManifestVersion: expect.any(Number),
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/m365Sync/summary.test.ts src/routes/m365CustomerGraphRead.test.ts`
Expected: FAIL — module missing, envelope lacks the keys.

- [ ] **Step 3: Implement**

`apps/api/src/services/m365Sync/summary.ts`:

```ts
import { desc, eq } from 'drizzle-orm';
import { M365_SYNC_DOMAINS, type M365SyncDomain } from '@breeze/shared/m365';
import { isM365TenantSyncEnabled } from '../../config/env';
import { db } from '../../db';
import { m365PostureRollups, m365SyncState } from '../../db/schema/m365Sync';
import type { M365SyncOutcome } from './types';

const STATUSES = ['success', 'partial', 'needs_consent', 'throttled', 'error'] as const;

export interface M365SyncDomainSummary {
  domain: M365SyncDomain;
  /** The stored m365_sync_status, or 'never' when the domain has not run. */
  status: M365SyncOutcome | 'never';
  /** last_complete_snapshot_at — the honest "as of" for this fact (spec §6). */
  asOf: string | null;
  truncated: boolean;
  /** sources.signInActivity === 'unlicensed': the tenant has no Entra ID P1. */
  unlicensed: boolean;
}

export interface M365SyncSummary {
  /** Newest successful run across all domains — the card's "last synced". */
  lastSuccessAt: string | null;
  /** users_total / devices_total from the newest posture rollup, or null. */
  users: number | null;
  devices: number | null;
  domains: M365SyncDomainSummary[];
}

function status(value: unknown): M365SyncOutcome | 'never' {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
    ? value as M365SyncOutcome
    : 'never';
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function count(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isUnlicensed(sources: unknown): boolean {
  return (
    sources !== null && typeof sources === 'object'
    && (sources as Record<string, unknown>).signInActivity === 'unlicensed'
  );
}

/**
 * Per-domain freshness for the Integrations card. Read on the request's own DB
 * context, so RLS (shape 1) is the tenant boundary — no system context, no
 * cross-org read.
 *
 * Every domain is represented even when it has no state row, so the UI can say
 * "never synced" for one domain without implying the whole connection is idle;
 * that distinction is the whole point of per-domain "as of" (spec §6).
 *
 * `asOf` is `last_complete_snapshot_at`, NOT `last_success_at`: a partial run
 * succeeds without having enumerated the tenant, and showing its timestamp as
 * the "as of" would claim freshness the data does not have.
 */
export async function loadSyncSummary(orgId: string): Promise<M365SyncSummary | null> {
  if (!isM365TenantSyncEnabled()) return null;

  const rows = await db
    .select({
      domain: m365SyncState.domain,
      lastStatus: m365SyncState.lastStatus,
      lastSuccessAt: m365SyncState.lastSuccessAt,
      lastCompleteSnapshotAt: m365SyncState.lastCompleteSnapshotAt,
      truncated: m365SyncState.truncated,
      sources: m365SyncState.sources,
    })
    .from(m365SyncState)
    .where(eq(m365SyncState.orgId, orgId));

  if (rows.length === 0) return null;

  // The entity counts come from the rollup rather than a COUNT over m365_users /
  // m365_intune_devices: the rollup is already the one place those totals are
  // assembled (spec §5.9), and the card must not add two table scans to a page
  // load. One indexed read of the newest row.
  const [rollup] = await db
    .select({ users: m365PostureRollups.usersTotal, devices: m365PostureRollups.devicesTotal })
    .from(m365PostureRollups)
    .where(eq(m365PostureRollups.orgId, orgId))
    .orderBy(desc(m365PostureRollups.rollupDate))
    .limit(1);

  const byDomain = new Map(rows.map((row) => [row.domain as M365SyncDomain, row]));
  const domains: M365SyncDomainSummary[] = M365_SYNC_DOMAINS.map((domain) => {
    const row = byDomain.get(domain);
    return {
      domain,
      status: status(row?.lastStatus),
      asOf: iso(row?.lastCompleteSnapshotAt ?? null),
      truncated: row?.truncated === true,
      unlicensed: isUnlicensed(row?.sources ?? null),
    };
  });

  const successes = rows
    .map((row) => iso(row.lastSuccessAt))
    .filter((value): value is string => value !== null)
    .sort();

  return {
    lastSuccessAt: successes.at(-1) ?? null,
    users: count(rollup?.users),
    devices: count(rollup?.devices),
    domains,
  };
}
```

In `m365CustomerGraphRead.ts`, extend the envelope. It becomes `async` — the GET
handler is its only caller — and the `profile` block is reproduced in full so
W01's widened `manifestVersion` type is carried through verbatim:

```ts
export interface CustomerGraphReadEnvelope {
  profile: {
    id: typeof PROFILE_ID;
    displayName: string;
    /** W01 widened this from the literal `2`; it is the current manifest version. */
    manifestVersion: number;
    requiredGrants: M365ApplicationGrant[];
  };
  onboardingEnabled: boolean;
  connection: CustomerGraphReadConnectionDto | null;
  /** W05: tenant sync is available in this deployment. Gates the Sync now button. */
  syncEnabled: boolean;
  /** W05: per-domain freshness plus entity counts. Null when the flag is off or nothing is seeded. */
  sync: M365SyncSummary | null;
}

async function envelope(
  orgId: string,
  connection: ConnectionWithHealth | null,
): Promise<CustomerGraphReadEnvelope> {
  return {
    profile: {
      id: PROFILE_ID,
      displayName: PROFILE_DISPLAY_NAME,
      manifestVersion: profileManifest.version,
      requiredGrants: [...(profileManifest.applicationPermissionAssignments ?? [])],
    },
    onboardingEnabled: isM365CustomerGraphReadOnboardingEnabledForOrg(orgId),
    connection: connection ? toConnectionDto(connection) : null,
    syncEnabled: isM365TenantSyncEnabled(),
    sync: await loadSyncSummary(orgId),
  };
}
```

`toConnectionDto` is W01's and is **not** touched — the sync fields are
envelope-level by contract.

In the GET handler: `return c.json(await envelope(resolved.orgId, connections[0] ?? null));`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/m365Sync/summary.test.ts src/routes/m365CustomerGraphRead.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365Sync/summary.ts \
        apps/api/src/services/m365Sync/summary.test.ts \
        apps/api/src/routes/m365CustomerGraphRead.ts \
        apps/api/src/routes/m365CustomerGraphRead.test.ts
git commit -m "feat(m365): expose syncEnabled and per-domain sync freshness on the read envelope

Spec §6. The read ENVELOPE — not the connection DTO — gains syncEnabled (gates
the Sync now button) and a sync block: the newest successful run across domains,
users/devices from the newest m365_posture_rollups row, and all six domains with
status, asOf, truncated and unlicensed. Every domain is represented even with no
state row, so the UI can say 'never synced' for one domain without implying the
whole connection is idle — that per-fact 'as of' is the point of the spec's
error table.

asOf is last_complete_snapshot_at, not last_success_at: a partial run succeeds
without enumerating the tenant, and its timestamp would claim freshness the data
does not have. needs_consent is a status, not a separate boolean, so the card
cannot end up with two encodings of one fact.

Read on the request's own DB context, so shape-1 RLS is the tenant boundary.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 16: web — the whole Customer Graph Read card change set

Spec §2.2 item 3 (card presentation), §5.2 (on-demand), §6 (what each state
surfaces). **This wave owns every card change for the tenant-sync feature**: the
"Sync now" button, the "Last synced … · N users · M devices" line, the
per-domain chips, and `formatRelativeTime`. It absorbs what an earlier draft had
put in W06 Task 13 — **W06 adds no card code, no locale key and no
`dateTimeFormat` change**, and the PR body says so.

The card's `parseEnvelope` uses `hasExactKeys`, so the two new envelope fields
are a **required** parser change, not an optional one: without it the whole card
falls to its "unavailable" state the moment the API starts sending them. The
change is in `parseEnvelope`, **not** `parseConnection` — Task 15 put the fields
on the envelope.

**This task applies on top of W01's card changes**: `parseConnection` already
validates `grantHealth` and `currentManifestVersion`, `ActionName` already
includes `"upgrade"`, and the amber `manifest-stale` banner and "Approve new
permissions" button already exist. Re-read the file and extend those lists
rather than retyping them.

**Files:**
- Modify: `apps/web/src/lib/dateTimeFormat.ts`
- Modify: `apps/web/src/lib/dateTimeFormat.test.ts`
- Modify: `apps/web/src/components/integrations/M365CustomerGraphReadCard.tsx`
- Modify: `apps/web/src/components/integrations/M365CustomerGraphReadCard.test.tsx`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/integrations.json`

**Interfaces:**
- Consumes: the Task 15 envelope fields; `runAction`, `handleActionError`
  (`lib/runAction`); `fetchWithAuth`; the card's existing `scopedRequest` /
  `perform` / `isCurrent` scope discipline.
- Produces: `formatRelativeTime` in `lib/dateTimeFormat.ts`. No other export;
  `data-testid` is used for the two new blocks (`m365-sync-summary`,
  `m365-sync-chip`) because a chip list has no accessible name to query by,
  while the buttons keep the file's role/name convention.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/src/lib/dateTimeFormat.test.ts`:

```ts
import { formatRelativeTime } from './dateTimeFormat';

describe('formatRelativeTime', () => {
  const now = new Date('2026-09-08T12:00:00.000Z');

  it('renders recent timestamps in minutes and hours', () => {
    expect(formatRelativeTime('2026-09-08T11:58:00.000Z', { now, locale: 'en-US' })).toBe('2 minutes ago');
    expect(formatRelativeTime('2026-09-08T09:00:00.000Z', { now, locale: 'en-US' })).toBe('3 hours ago');
  });

  it('renders older timestamps in days', () => {
    expect(formatRelativeTime('2026-09-05T12:00:00.000Z', { now, locale: 'en-US' })).toBe('3 days ago');
  });

  it('treats anything under a minute as just now', () => {
    expect(formatRelativeTime('2026-09-08T11:59:40.000Z', { now, locale: 'en-US' })).toBe('now');
  });

  it('returns the fallback for an unparseable or null value', () => {
    expect(formatRelativeTime(null, { now, fallback: '—' })).toBe('—');
    expect(formatRelativeTime('not a date', { now, fallback: '—' })).toBe('—');
  });
});
```

In `M365CustomerGraphReadCard.test.tsx`, first extend the existing
`@/lib/dateTimeFormat` mock — the card imports a second symbol from it and the
current factory returns only `formatDateTime`, which would break every test in
the file:

```ts
vi.mock("@/lib/dateTimeFormat", () => ({
  formatDateTime: vi.fn((value: string) => `formatted ${value}`),
  formatRelativeTime: vi.fn((value: string) => `relative ${value}`),
}));
```

Then extend the file's `envelope()` helper with the two ENVELOPE-level keys —
do this first, in the same edit, or every existing test fails on `hasExactKeys`:

```ts
    syncEnabled: true,
    sync: {
      lastSuccessAt: "2026-09-08T11:30:00.000Z",
      users: 128,
      devices: 96,
      domains: [
        { domain: "users", status: "success", asOf: "2026-09-08T11:30:00.000Z", truncated: false, unlicensed: false },
        { domain: "signin_activity", status: "success", asOf: "2026-09-08T06:00:00.000Z", truncated: false, unlicensed: false },
        { domain: "intune_devices", status: "success", asOf: "2026-09-08T11:00:00.000Z", truncated: false, unlicensed: false },
        { domain: "ca_policies", status: "success", asOf: "2026-09-08T02:00:00.000Z", truncated: false, unlicensed: false },
        { domain: "skus", status: "success", asOf: "2026-09-08T02:00:00.000Z", truncated: false, unlicensed: false },
        { domain: "secure_score", status: "success", asOf: "2026-09-08T02:00:00.000Z", truncated: false, unlicensed: false },
      ],
    },
```

Then the new cases:

```ts
describe("Sync now", () => {
  it("is hidden when the DTO says sync is disabled", async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse(envelope({ syncEnabled: false, sync: null })));
    render(<M365CustomerGraphReadCard />);
    await screen.findByRole("button", { name: "Retest" });
    expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull();
  });

  it("is hidden when there is no connection", async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse(envelope({ connection: null, syncEnabled: true })));
    render(<M365CustomerGraphReadCard />);
    await screen.findByRole("button", { name: "Connect" });
    expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull();
  });

  it("is hidden for a revoked connection", async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse(envelope({
      syncEnabled: true, connection: { ...baseConnection, status: "revoked" },
    })));
    render(<M365CustomerGraphReadCard />);
    await screen.findByRole("button", { name: "Re-consent" });
    expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull();
  });

  it("posts through runAction, prevents duplicate clicks, and reloads", async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse(envelope({ syncEnabled: true })));
    render(<M365CustomerGraphReadCard />);
    const button = await screen.findByRole("button", { name: "Sync now" });
    fetchWithAuthMock.mockResolvedValue(jsonResponse({ requested: true, domains: [] }));

    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        `/m365/connections/${CONNECTION_ID}/sync?orgId=${ORG_A}`,
        { method: "POST" },
      );
    });
    expect(runActionMock).toHaveBeenCalledOnce();
    expect(state.successMessages).toContain("Tenant sync requested.");
  });

  it("surfaces a failure through runAction rather than silently no-opping", async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse(envelope({ syncEnabled: true })));
    render(<M365CustomerGraphReadCard />);
    const button = await screen.findByRole("button", { name: "Sync now" });
    fetchWithAuthMock.mockResolvedValue(jsonResponse({ error: "rate limited" }, 429));

    fireEvent.click(button);

    await waitFor(() => {
      expect(state.errorMessages).toContain("Tenant sync could not be requested.");
    });
  });

  it("is disabled without organizations:write", async () => {
    state.canWrite = false;
    fetchWithAuthMock.mockResolvedValue(jsonResponse(envelope({ syncEnabled: true })));
    render(<M365CustomerGraphReadCard />);
    expect(await screen.findByRole("button", { name: "Sync now" })).toBeDisabled();
  });

  it("does not let a deferred Org A sync block Org B actions", async () => {
    // mirrors the existing retest scope test in this file
    await expectScopeIsolation("sync", "Sync now");
  });
});

describe("sync summary line and chips", () => {
  it("shows the last-synced line with user and device counts", async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse(envelope({ syncEnabled: true })));
    render(<M365CustomerGraphReadCard />);

    const summary = await screen.findByTestId("m365-sync-summary");
    expect(summary).toHaveTextContent("Last synced relative 2026-09-08T11:30:00.000Z");
    expect(summary).toHaveTextContent("128 users");
    expect(summary).toHaveTextContent("96 devices");
    expect(screen.queryAllByTestId("m365-sync-chip")).toHaveLength(0);
  });

  it("says not synced yet before the first successful run", async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse(envelope({
      syncEnabled: true,
      sync: { lastSuccessAt: null, users: null, devices: null, domains: [] },
    })));
    render(<M365CustomerGraphReadCard />);

    expect(await screen.findByTestId("m365-sync-summary")).toHaveTextContent("Not synced yet");
  });

  it("renders a chip per degraded domain, in a fixed precedence, and none for healthy ones", async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse(envelope({
      syncEnabled: true,
      sync: {
        lastSuccessAt: "2026-09-08T11:30:00.000Z",
        users: 10,
        devices: 5,
        domains: [
          { domain: "users", status: "partial", asOf: "2026-09-08T11:30:00.000Z", truncated: true, unlicensed: false },
          { domain: "signin_activity", status: "success", asOf: null, truncated: false, unlicensed: true },
          { domain: "intune_devices", status: "throttled", asOf: null, truncated: false, unlicensed: false },
          { domain: "ca_policies", status: "needs_consent", asOf: null, truncated: false, unlicensed: false },
          { domain: "skus", status: "error", asOf: null, truncated: false, unlicensed: false },
          { domain: "secure_score", status: "never", asOf: null, truncated: false, unlicensed: false },
        ],
      },
    })));
    render(<M365CustomerGraphReadCard />);

    const chips = await screen.findAllByTestId("m365-sync-chip");
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "Users: partial",
      "Sign-in activity needs Entra ID P1",
      "Intune devices: throttled",
      "Conditional Access: needs consent",
      "Licenses: error",
    ]);
    // 'never' and 'success' are not problems; a domain nobody has run yet is
    // reported by the summary line, not by a warning chip.
  });

  it("hides the sync summary entirely when tenant sync is off", async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse(envelope({ syncEnabled: false, sync: null })));
    render(<M365CustomerGraphReadCard />);

    expect(await screen.findByRole("heading", { name: "Customer Graph Read" })).toBeInTheDocument();
    expect(screen.queryByTestId("m365-sync-summary")).not.toBeInTheDocument();
  });

  it("rejects an envelope whose sync block has an unknown domain", async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse(envelope({
      syncEnabled: true,
      sync: {
        lastSuccessAt: null, users: null, devices: null,
        domains: [{ domain: "mailboxes", status: "success", asOf: null, truncated: false, unlicensed: false }],
      },
    })));
    render(<M365CustomerGraphReadCard />);

    expect(await screen.findByText("Connection details are unavailable.")).toBeInTheDocument();
  });

  it("rejects an envelope whose sync block has an unknown status", async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse(envelope({
      syncEnabled: true,
      sync: {
        lastSuccessAt: null, users: null, devices: null,
        domains: [{ domain: "users", status: "weird", asOf: null, truncated: false, unlicensed: false }],
      },
    })));
    render(<M365CustomerGraphReadCard />);

    expect(await screen.findByText("Connection details are unavailable.")).toBeInTheDocument();
  });
});
```

Also extend the existing parameterised action tables in the file
(`["retest", "Retest"]`, `["retest", "Retest", "complete"]`, …) with
`["sync", "Sync now"]` entries so the shared disabled-while-busy and
scope-isolation matrices cover the new action.

- [ ] **Step 2: Run to verify they fail**

```bash
cd apps/web && npx vitest run src/lib/dateTimeFormat.test.ts
cd apps/web && npx vitest run src/components/integrations/M365CustomerGraphReadCard.test.tsx
```
Expected: FAIL — `formatRelativeTime` does not exist, there is no such button or
summary block, and the existing tests fail on `hasExactKeys` until the envelope
helper and the parser both carry the new keys.

- [ ] **Step 3: Implement `formatRelativeTime`**

Append to `apps/web/src/lib/dateTimeFormat.ts`:

```ts
const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3_600_000],
  ['month', 30 * 24 * 3_600_000],
  ['day', 24 * 3_600_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/**
 * "3 hours ago" / "in 5 minutes", in the user's formatting locale.
 *
 * Anything inside a minute renders as the locale's "now" rather than
 * "0 seconds ago", because a sync that finished 12 seconds ago and one that
 * finished 50 seconds ago are the same fact to the reader.
 */
export function formatRelativeTime(
  value: DateInput,
  options: { now?: Date; locale?: Intl.LocalesArgument; fallback?: string } = {},
): string {
  const date = parseDate(value);
  if (!date) return fallbackFor(value, options.fallback);
  const locale = options.locale ?? resolvedFormattingLocale();
  const deltaMs = date.getTime() - (options.now ?? new Date()).getTime();
  try {
    const formatter = new Intl.RelativeTimeFormat(locale as Intl.LocalesArgument, { numeric: 'auto' });
    for (const [unit, ms] of RELATIVE_UNITS) {
      if (Math.abs(deltaMs) >= ms) return formatter.format(Math.round(deltaMs / ms), unit);
    }
    return formatter.format(0, 'second');
  } catch {
    return fallbackFor(value, options.fallback);
  }
}
```

- [ ] **Step 4: Types and parsers (defined ONCE, at envelope level)**

In `M365CustomerGraphReadCard.tsx`, next to the existing `STATUSES` /
`GRANT_HEALTH_STATES` constants:

```tsx
const SYNC_DOMAINS = [
  "users", "signin_activity", "intune_devices", "ca_policies", "skus", "secure_score",
] as const;
type SyncDomain = (typeof SYNC_DOMAINS)[number];

const SYNC_STATUSES = [
  "success", "partial", "needs_consent", "throttled", "error", "never",
] as const;
type SyncStatus = (typeof SYNC_STATUSES)[number];

type SyncDomainState = {
  domain: SyncDomain;
  status: SyncStatus;
  asOf: string | null;
  truncated: boolean;
  unlicensed: boolean;
};
type SyncSummary = {
  lastSuccessAt: string | null;
  users: number | null;
  devices: number | null;
  domains: SyncDomainState[];
};
```

and widen the existing `ActionName` union (W01 already added `"upgrade"`) with
`"sync"`.

The two parsers are written **once**, in the same defensive style as
`parseConnection` — an unparseable block fails the envelope rather than throwing
during render, and closed unions mean an unknown domain or status is a rejection,
not a silently rendered string:

```tsx
function parseCount(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
  return value;
}

function parseSyncDomain(value: unknown): SyncDomainState | null {
  if (!isRecord(value) || !hasExactKeys(value, ["domain", "status", "asOf", "truncated", "unlicensed"])) return null;
  const asOf = parseTimestamp(value.asOf);
  if (
    typeof value.domain !== "string" || !(SYNC_DOMAINS as readonly string[]).includes(value.domain)
    || typeof value.status !== "string" || !(SYNC_STATUSES as readonly string[]).includes(value.status)
    || asOf === undefined
    || typeof value.truncated !== "boolean"
    || typeof value.unlicensed !== "boolean"
  ) return null;
  return {
    domain: value.domain as SyncDomain,
    status: value.status as SyncStatus,
    asOf,
    truncated: value.truncated,
    unlicensed: value.unlicensed,
  };
}

/** `null` is a legitimate value (flag off / nothing seeded); `undefined` is a parse failure. */
function parseSync(value: unknown): SyncSummary | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, ["lastSuccessAt", "users", "devices", "domains"])) return undefined;
  const lastSuccessAt = parseTimestamp(value.lastSuccessAt);
  const users = parseCount(value.users);
  const devices = parseCount(value.devices);
  if (
    !Array.isArray(value.domains) || value.domains.length > SYNC_DOMAINS.length
    || lastSuccessAt === undefined || users === undefined || devices === undefined
  ) return undefined;
  const domains = value.domains.map(parseSyncDomain);
  if (domains.some((domain) => domain === null)) return undefined;
  return { lastSuccessAt, users, devices, domains: domains as SyncDomainState[] };
}
```

In `parseEnvelope` — **not** `parseConnection` — widen the key set, add two
checks and return two fields. The whole function after this task, with W01's
`manifestVersion: TRUSTED_PROFILE.version` already in place:

```tsx
function parseEnvelope(value: unknown): Envelope | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "profile", "onboardingEnabled", "connection", "syncEnabled", "sync",
  ])) return null;
  if (!isRecord(value.profile) || !hasExactKeys(value.profile, ["id", "displayName", "manifestVersion", "requiredGrants"])) return null;
  const grants = parseGrants(value.profile.requiredGrants);
  const connection = parseConnection(value.connection);
  const sync = parseSync(value.sync);
  if (
    value.profile.id !== "customer-graph-read"
    || typeof value.profile.displayName !== "string"
    || value.profile.manifestVersion !== TRUSTED_PROFILE.version
    || grants === null || !matchesTrustedManifest(grants)
    || typeof value.onboardingEnabled !== "boolean"
    || connection === undefined
    || typeof value.syncEnabled !== "boolean"
    || sync === undefined
  ) return null;
  return {
    profile: {
      id: "customer-graph-read",
      displayName: value.profile.displayName,
      manifestVersion: TRUSTED_PROFILE.version,
      requiredGrants: grants,
    },
    onboardingEnabled: value.onboardingEnabled,
    connection,
    syncEnabled: value.syncEnabled,
    sync,
  };
}
```

and add `syncEnabled: boolean; sync: SyncSummary | null;` to the `Envelope` type.
`parseConnection` is untouched: W01's `grantHealth` / `manifestVersion` /
`currentManifestVersion` stay where they are.

- [ ] **Step 5: The action, the summary line and the chips**

The handler, cloned from `retest` (same scoped-request/`perform` discipline, so
a deferred Org A call cannot land on Org B):

```tsx
  const syncNow = useCallback(() => {
    if (
      !orgId || !data?.connection || !canWrite || !data.syncEnabled
      || !(["active", "degraded"] as ConnectionStatus[]).includes(data.connection.status)
    ) return;
    const target = scope;
    const connectionId = data.connection.id;
    void perform(target, "sync", async () => {
      try {
        await runAction({
          request: () => scopedRequest(
            target,
            () => fetchWithAuth(`/m365/connections/${connectionId}/sync?orgId=${target.orgId}`, { method: "POST" }),
            {},
          ),
          errorFallback: t("m365CustomerGraphRead.actions.syncFailed"),
          successMessage: () => isCurrent(target)
            ? t("m365CustomerGraphRead.actions.syncSucceeded")
            : "",
        });
        if (isCurrent(target)) await load(target);
      } catch (error) {
        if (isCurrent(target)) {
          handleActionError(error, t("m365CustomerGraphRead.actions.syncFailed"));
        }
      }
    });
  }, [canWrite, data, isCurrent, load, orgId, perform, scope, scopedRequest, t]);
```

The chips, next to the card's other `useMemo` blocks. The precedence is fixed
and ordered worst-first per domain, so exactly one chip can come from one domain
and the rendered list is deterministic:

```tsx
  const syncChips = useMemo(() => {
    const chips: { key: string; label: string }[] = [];
    for (const entry of data?.sync?.domains ?? []) {
      const domain = t(/* i18n-dynamic */ `m365CustomerGraphRead.sync.domains.${entry.domain}`);
      if (entry.unlicensed) {
        // Its own sentence, not "{{domain}}: unlicensed": the actionable fact is
        // that the TENANT needs Entra ID P1, not that a sync went wrong.
        chips.push({ key: `${entry.domain}:unlicensed`, label: t("m365CustomerGraphRead.sync.chips.unlicensed") });
      } else if (entry.status === "throttled") {
        chips.push({ key: `${entry.domain}:throttled`, label: t("m365CustomerGraphRead.sync.chips.throttled", { domain }) });
      } else if (entry.status === "needs_consent") {
        chips.push({ key: `${entry.domain}:needs-consent`, label: t("m365CustomerGraphRead.sync.chips.needsConsent", { domain }) });
      } else if (entry.status === "error") {
        chips.push({ key: `${entry.domain}:error`, label: t("m365CustomerGraphRead.sync.chips.error", { domain }) });
      } else if (entry.status === "partial" || entry.truncated) {
        chips.push({ key: `${entry.domain}:partial`, label: t("m365CustomerGraphRead.sync.chips.partial", { domain }) });
      }
      // 'success' and 'never' get no chip: the summary line already says whether
      // anything has ever synced, and a chip per healthy domain is noise.
    }
    return chips;
  }, [data, t]);
```

The button, beside Retest inside the `connection &&` fragment:

```tsx
                {data.syncEnabled && canRetestConnection && (
                  <button type="button" onClick={syncNow} disabled={!canWrite || action !== null} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50">
                    <RefreshCcwDot aria-hidden="true" className={`h-4 w-4 ${action === "sync" ? "animate-spin" : ""}`} />{t("m365CustomerGraphRead.actions.syncNow")}
                  </button>
                )}
```

with `RefreshCcwDot` added to the `lucide-react` import (a different glyph from
Retest's `RefreshCw`, so the two buttons are distinguishable at a glance).

The summary block, immediately after the connection details `</dl>`'s closing
`</div>`:

```tsx
          {data.syncEnabled && data.sync && (
            <div className="border-t pt-5" data-testid="m365-sync-summary">
              <p className="text-sm text-foreground">
                {data.sync.lastSuccessAt
                  ? `${t("m365CustomerGraphRead.sync.lastSynced", {
                      relative: formatRelativeTime(data.sync.lastSuccessAt),
                    })} · ${t("m365CustomerGraphRead.sync.counts", {
                      users: data.sync.users ?? 0,
                      devices: data.sync.devices ?? 0,
                    })}`
                  : t("m365CustomerGraphRead.sync.never")}
              </p>
              {syncChips.length > 0 && (
                <ul className="mt-3 flex flex-wrap gap-2">
                  {syncChips.map((chip) => (
                    <li
                      key={chip.key}
                      data-testid="m365-sync-chip"
                      className="inline-flex items-center rounded-full border border-warning/40 bg-warning/10 px-2.5 py-1 text-xs font-medium text-foreground"
                    >
                      {chip.label}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
```

with `formatRelativeTime` added to the `@/lib/dateTimeFormat` import.

- [ ] **Step 6: Add the i18n keys to all eight catalogs**

`localeParity.test.ts` asserts an exact key match per locale, so a missing key in
any one of the eight reds Test Web. Every locale gets both blocks under
`m365CustomerGraphRead`: three `actions.*` keys and the whole `sync` block.
Translate rather than copying English, and keep the repo's terminology
(`apps/web/src/locales/TERMINOLOGY.md`).

`en`:

```json
"actions": { "syncNow": "Sync now", "syncFailed": "Tenant sync could not be requested.", "syncSucceeded": "Tenant sync requested." },
"sync": {
  "lastSynced": "Last synced {{relative}}",
  "counts": "{{users}} users · {{devices}} devices",
  "never": "Not synced yet",
  "chips": {
    "partial": "{{domain}}: partial",
    "needsConsent": "{{domain}}: needs consent",
    "throttled": "{{domain}}: throttled",
    "error": "{{domain}}: error",
    "unlicensed": "Sign-in activity needs Entra ID P1"
  },
  "domains": {
    "users": "Users",
    "signin_activity": "Sign-in activity",
    "intune_devices": "Intune devices",
    "ca_policies": "Conditional Access",
    "skus": "Licenses",
    "secure_score": "Secure Score"
  }
}
```

`pt-BR`:

```json
"actions": { "syncNow": "Sincronizar agora", "syncFailed": "Não foi possível solicitar a sincronização do locatário.", "syncSucceeded": "Sincronização do locatário solicitada." },
"sync": {
  "lastSynced": "Última sincronização {{relative}}",
  "counts": "{{users}} usuários · {{devices}} dispositivos",
  "never": "Ainda não sincronizado",
  "chips": {
    "partial": "{{domain}}: parcial",
    "needsConsent": "{{domain}}: precisa de consentimento",
    "throttled": "{{domain}}: limitado",
    "error": "{{domain}}: erro",
    "unlicensed": "A atividade de entrada exige o Entra ID P1"
  },
  "domains": {
    "users": "Usuários",
    "signin_activity": "Atividade de entrada",
    "intune_devices": "Dispositivos do Intune",
    "ca_policies": "Acesso Condicional",
    "skus": "Licenças",
    "secure_score": "Pontuação de segurança"
  }
}
```

`es-419`:

```json
"actions": { "syncNow": "Sincronizar ahora", "syncFailed": "No se pudo solicitar la sincronización del inquilino.", "syncSucceeded": "Sincronización del inquilino solicitada." },
"sync": {
  "lastSynced": "Última sincronización {{relative}}",
  "counts": "{{users}} usuarios · {{devices}} dispositivos",
  "never": "Aún no sincronizado",
  "chips": {
    "partial": "{{domain}}: parcial",
    "needsConsent": "{{domain}}: requiere consentimiento",
    "throttled": "{{domain}}: limitado",
    "error": "{{domain}}: error",
    "unlicensed": "La actividad de inicio de sesión requiere Entra ID P1"
  },
  "domains": {
    "users": "Usuarios",
    "signin_activity": "Actividad de inicio de sesión",
    "intune_devices": "Dispositivos de Intune",
    "ca_policies": "Acceso condicional",
    "skus": "Licencias",
    "secure_score": "Puntuación de seguridad"
  }
}
```

`fr-FR` and `fr-CA` (identical values; both catalogs still need their own copy):

```json
"actions": { "syncNow": "Synchroniser maintenant", "syncFailed": "Impossible de demander la synchronisation du locataire.", "syncSucceeded": "Synchronisation du locataire demandée." },
"sync": {
  "lastSynced": "Dernière synchronisation {{relative}}",
  "counts": "{{users}} utilisateurs · {{devices}} appareils",
  "never": "Pas encore synchronisé",
  "chips": {
    "partial": "{{domain}} : partiel",
    "needsConsent": "{{domain}} : consentement requis",
    "throttled": "{{domain}} : limité",
    "error": "{{domain}} : erreur",
    "unlicensed": "L'activité de connexion nécessite Entra ID P1"
  },
  "domains": {
    "users": "Utilisateurs",
    "signin_activity": "Activité de connexion",
    "intune_devices": "Appareils Intune",
    "ca_policies": "Accès conditionnel",
    "skus": "Licences",
    "secure_score": "Niveau de sécurité"
  }
}
```

`de-DE`:

```json
"actions": { "syncNow": "Jetzt synchronisieren", "syncFailed": "Die Mandantensynchronisierung konnte nicht angefordert werden.", "syncSucceeded": "Mandantensynchronisierung angefordert." },
"sync": {
  "lastSynced": "Zuletzt synchronisiert {{relative}}",
  "counts": "{{users}} Benutzer · {{devices}} Geräte",
  "never": "Noch nicht synchronisiert",
  "chips": {
    "partial": "{{domain}}: unvollständig",
    "needsConsent": "{{domain}}: Zustimmung erforderlich",
    "throttled": "{{domain}}: gedrosselt",
    "error": "{{domain}}: Fehler",
    "unlicensed": "Anmeldeaktivität erfordert Entra ID P1"
  },
  "domains": {
    "users": "Benutzer",
    "signin_activity": "Anmeldeaktivität",
    "intune_devices": "Intune-Geräte",
    "ca_policies": "Bedingter Zugriff",
    "skus": "Lizenzen",
    "secure_score": "Sicherheitsbewertung"
  }
}
```

`it-IT`:

```json
"actions": { "syncNow": "Sincronizza ora", "syncFailed": "Non è stato possibile richiedere la sincronizzazione del tenant.", "syncSucceeded": "Sincronizzazione del tenant richiesta." },
"sync": {
  "lastSynced": "Ultima sincronizzazione {{relative}}",
  "counts": "{{users}} utenti · {{devices}} dispositivi",
  "never": "Non ancora sincronizzato",
  "chips": {
    "partial": "{{domain}}: parziale",
    "needsConsent": "{{domain}}: consenso richiesto",
    "throttled": "{{domain}}: limitato",
    "error": "{{domain}}: errore",
    "unlicensed": "L'attività di accesso richiede Entra ID P1"
  },
  "domains": {
    "users": "Utenti",
    "signin_activity": "Attività di accesso",
    "intune_devices": "Dispositivi Intune",
    "ca_policies": "Accesso condizionale",
    "skus": "Licenze",
    "secure_score": "Punteggio sicuro"
  }
}
```

`tr-TR`:

```json
"actions": { "syncNow": "Şimdi eşitle", "syncFailed": "Kiracı eşitlemesi istenemedi.", "syncSucceeded": "Kiracı eşitlemesi istendi." },
"sync": {
  "lastSynced": "Son eşitleme {{relative}}",
  "counts": "{{users}} kullanıcı · {{devices}} cihaz",
  "never": "Henüz eşitlenmedi",
  "chips": {
    "partial": "{{domain}}: kısmi",
    "needsConsent": "{{domain}}: onay gerekiyor",
    "throttled": "{{domain}}: kısıtlandı",
    "error": "{{domain}}: hata",
    "unlicensed": "Oturum açma etkinliği Entra ID P1 gerektirir"
  },
  "domains": {
    "users": "Kullanıcılar",
    "signin_activity": "Oturum açma etkinliği",
    "intune_devices": "Intune cihazları",
    "ca_policies": "Koşullu Erişim",
    "skus": "Lisanslar",
    "secure_score": "Güvenlik Puanı"
  }
}
```

The three `actions.*` keys go **into** the existing `m365CustomerGraphRead.actions`
object in each catalog — do not add a second `actions` key. Every translated
value differs from its English counterpart, so no `translationCoverage.test.ts`
duplicate baseline needs bumping; if one trips the duplicate check, translate it
further rather than raising the baseline.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd apps/web && npx vitest run \
  src/lib/dateTimeFormat.test.ts \
  src/components/integrations/M365CustomerGraphReadCard.test.tsx
cd apps/web && npx vitest run src/lib/i18n
```
Expected: PASS (the second run must include `localeParity`, `keyUsage`,
`translationCoverage` and `terminologyQuality`).

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/dateTimeFormat.ts \
        apps/web/src/lib/dateTimeFormat.test.ts \
        apps/web/src/components/integrations/M365CustomerGraphReadCard.tsx \
        apps/web/src/components/integrations/M365CustomerGraphReadCard.test.tsx \
        apps/web/src/locales/*/integrations.json
git commit -m "feat(m365): Sync now, last-synced line and per-domain chips on the Customer Graph Read card

The whole card change set for tenant sync, in one wave. 'Sync now' posts the
on-demand request through runAction, so a 429 from the limiter surfaces as a
toast instead of a silent no-op, and reuses the card's scoped-request discipline
so a deferred Org A call cannot land on Org B. The summary line renders
'Last synced <relative> · N users · M devices' from the envelope's sync block,
and a chip appears per degraded domain — unlicensed sign-in, throttled, needs
consent, error, partial — in a fixed precedence so at most one chip comes from
one domain. Healthy and never-run domains get no chip; the line already says
whether anything has synced.

The envelope parser gains the two new fields with closed unions for the six
domains and six statuses, so an unknown domain or status fails the envelope
rather than rendering. It is parseEnvelope, not parseConnection: the fields are
envelope-level, and without the parser change the whole card would fall to its
unavailable state the moment the API started sending them.

Adds formatRelativeTime to the shared date helpers and both key blocks to all
eight locale catalogs.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 17: full verification and the pull request

**Files:**
- No production changes. Fix whatever the runs below surface, in the task that
  owns the file, and amend that task's commit rather than adding a "fix" commit.

**Interfaces:**
- Consumes: everything above.
- Produces: the wave's PR.

- [ ] **Step 1: Run every suite this wave touched**

```bash
# Sync service + control plane + routes (unit)
cd apps/api && npx vitest run \
  src/services/m365Sync \
  src/services/m365ControlPlane \
  src/routes/m365CustomerGraphRead.test.ts \
  src/routes/m365ConsentCallback.test.ts
```

Check the reported **file count**, not just the colour: vitest's path filter is
a plain substring match, so `src/services/m365Sync` picks up every file under
that directory. It must include W04's files plus this wave's
`cadence.test.ts`, `hooks.test.ts`, `rollup.test.ts`, `links.test.ts`,
`lifecycle.test.ts`, `onDemandLimiter.test.ts`, `summary.test.ts`,
`domains/signinActivity.test.ts` and `domains/secureScore.test.ts`, and the
edited `run.test.ts`, `claim.sql.test.ts` and `domains/users.test.ts`. If the
count is lower, a file is not being matched and a green run means nothing.

```bash
# Web card, date helpers and i18n parity
cd apps/web && npx vitest run \
  src/lib/dateTimeFormat.test.ts \
  src/components/integrations/M365CustomerGraphReadCard.test.tsx \
  src/lib/i18n
```

- [ ] **Step 2: Run the real-database suites**

```bash
cd apps/api && pnpm test:docker:up
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/m365SyncLinks.integration.test.ts \
  src/__tests__/integration/m365SyncClaim.integration.test.ts
```

Expected: PASS with 9 link tests and W04's 13 claim tests **executed** —
`it.runIf(!!process.env.DATABASE_URL)` skips silently without a database, and an
all-skipped file reports green. `m365SyncClaim.integration.test.ts` is W04's
suite; Task 4 edited its reconcile case from four rows to six, so confirm that
case in particular passes rather than trusting the file's overall colour.

This wave adds no table and no column, so the tenancy contract suites
(`rls-coverage`, `tenantCascade`, `tenant-export-policy`,
`tenantExportErasureRoundtrip`) are W02's and are not re-run here. If your diff
touched `apps/api/src/db/schema/` or `apps/api/migrations/`, stop — that is
W02's surface and this wave has strayed.

- [ ] **Step 3: Typecheck and lint**

```bash
NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/api/tsconfig.json
NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/web/tsconfig.json
pnpm lint
```

Run both in the foreground with a generous timeout; a backgrounded typecheck is
how these stall.

- [ ] **Step 4: Confirm the plan file is the only doc this wave touched**

```bash
git diff --stat origin/main... -- docs/
```

The overview
(`docs/superpowers/plans/integrations/2026-09-08-m365-tenant-sync-0-overview.md`)
must **not** appear: contract edits are the orchestrator's, and every name this
wave uses is already in the contract. If something genuinely diverged, leave the
file alone and describe the delta in the PR body instead.

- [ ] **Step 5: Merge main and re-verify**

PR CI tests the merge commit, not your branch tip, so a locally green branch on
a stale base still reds CI:

```bash
git fetch origin main && git merge origin/main
cd apps/api && npx vitest run src/services/m365Sync src/routes/m365CustomerGraphRead.test.ts src/routes/m365ConsentCallback.test.ts
```

If W01, W02, W03 or W04 moved under you, reconcile against the code (it is the
authority) and note any contract delta in the PR body. Pay particular attention
to W01's callback seam and DTO — Tasks 12, 14, 15 and 16 all build on them.

- [ ] **Step 6: Open the PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(m365): tenant sync W05 — enrichment, continuation, Secure Score, rollup, cadence, links, lifecycle, on-demand, card" --body "$(cat <<'BODY'
Wave 5 of the M365 tenant sync foundation. Finishes the sync worker W04 started
and ships the whole product surface for it.

Spec: `docs/superpowers/specs/integrations/2026-09-08-m365-tenant-sync-foundation-design.md` (§5.5–§5.9, §3.3, §6, §10)
Plan: `docs/superpowers/plans/integrations/2026-09-08-m365-tenant-sync-5-enrichment-lifecycle.md`

Depends on **W01** (the consent-callback restructure and the connection DTO) and
**W04** (the worker, its seams and its types).

## What ships

- **Users enrichment (§5.5).** `mfa_registered` / `mfa_capable` /
  `default_mfa_method` are written only when `sources.mfaRegistration === 'ok'`;
  `admin_roles` and `is_admin` only when `sources.roleAssignments === 'ok'`.
  Both pairs are added to, or omitted from, the same upsert statement, and
  `is_admin` is recomputed from `excluded.admin_roles` in SQL. A user missing
  from a *successful* report gets `mfa_registered NULL`, never `false`.
- **Sign-in activity (§5.5, §6).** Its own domain: one set-based, change-only
  UPDATE by `(org_id, graph_id)`; unknown users ignored; `unlicensed` is a
  complete zero-update success that pushes the interval to its ceiling; a
  returned continuation is stored through `writeCompletion`'s continuation mode,
  leaving the state otherwise untouched, and the run re-claims at priority 10 for
  a new generation until exhausted.
- **Secure Score (§3.3).** Snapshots keyed on the UTC day of Graph's own
  `createdDateTime`, computed in SQL; two scores for one Graph day collapse
  newest-wins; the 90-day backfill is driven by the state row's
  `last_success_at IS NULL` through `m365SyncActionFor`, so no flag column exists.
- **Both remaining domains switched on.** `DOMAIN_PERSISTERS` gains
  `signin_activity` and `secure_score`, and `M365_SYNC_IMPLEMENTED_DOMAINS`
  becomes `M365_SYNC_DOMAINS`, so the ticker seeds and claims all six. W04's two
  assertions marked "W05 inverts this" are inverted, and its real-Postgres
  reconcile case moves from four rows to six.
- **Rollup (§5.9)** in `hooks.ts`: one indexed read of the six `last_counts`
  plus one upsert, no COUNT queries, run **after** the completion transaction
  commits on the hook's own system context. Counters no domain reported stay
  **NULL, not 0**.
- **Adaptive cadence (§5.7)** as the body of W04's `applyCadence` seam, with the
  domain bounds; `needs_consent` and connection auth failure unschedule.
  `graph_permission_missing` is not an auth failure — it maps to `needs_consent`.
- **Device links (§5.6).** Two data-modifying-CTE statements per Intune run,
  1:1 on both sides, ambiguity counted through `recordM365SyncLinkAmbiguous` and
  skipped, hostname fallback, relink on mismatch — proven against real Postgres.
- **Lifecycle (§5.8).** Consent success (active **or** degraded) seeds all six
  domains at priority 1 from W01's identity branch; disconnect erases state and
  the four entity tables in the caller's transaction and keeps the tenant-stamped
  history; W01's upgrade-apply seam calls `onConnectionUpgraded`, re-arming
  `needs_consent` domains.
- **On-demand (§5.2).** `POST /m365/connections/:id/sync`, MFA-gated like
  retest, Redis-limited to one per org per 15 min (429 + `Retry-After`), flag
  first so a disabled feature never burns a slot, sign-in excluded because its
  Graph budget is app-wide. Ninth lifecycle audit event `sync_requested`,
  appended after W01's eight.
- **DTO + card.** The read **envelope** gains `syncEnabled` and
  `sync: { lastSuccessAt, users, devices, domains[] }`, and the card gains the
  "Sync now" button, the "Last synced … · N users · M devices" line, per-domain
  chips, `formatRelativeTime` and all eight locale catalogs.

## Contract conformance

No contract deviations, and the overview is **not** edited by this PR. Every
name used here is already in the shared contract:

- `M365SyncRunResult` (with `'partial-continue'`), `M365_SYNC_IMPLEMENTED_DOMAINS`
  and `m365SyncActionFor` are imported from `types.ts`, never redeclared.
- `CadenceSignals` (six fields) is imported from `cadence.ts`; `applyCadence`
  and `afterDomainPersisted` keep their contracted signatures — this wave
  replaces bodies in files W04 created.
- `afterDomainPersisted` runs after `writeCompletion` commits, on its own system
  context; a throw there cannot roll a completion back.
- `recordM365SyncLinkAmbiguous(count)` takes one numeric argument, no `orgId`
  label.
- The `sync` block sits on `CustomerGraphReadEnvelope`, so the web change is in
  `parseEnvelope`; `needs_consent` is a `status`, not a separate boolean.

## Coordination

- **W06:** this PR owns the ENTIRE card change set — button, last-synced line,
  chips, `formatRelativeTime`, locale keys — and the `syncEnabled` / `sync`
  envelope fields. **W06 adds no card code and re-adds no field**; it tests them.
- **W01:** `onConnectionUpgraded` is wired at W01's
  `// W05: onConnectionUpgraded(...)` seam inside the upgrade-apply branch, and
  `onConnectionConsented` in the identity branch. The route and DTO edits in
  Tasks 14–16 sit on top of W01's `grantHealth` / `manifestVersion` /
  `currentManifestVersion` and its upgrade-consent route.

## Verification

- `apps/api`: `m365Sync`, `m365ControlPlane`, `routes/m365CustomerGraphRead`,
  `routes/m365ConsentCallback` unit suites.
- `apps/api` integration: `m365SyncLinks.integration.test.ts` (9 tests) and
  W04's `m365SyncClaim.integration.test.ts` (13 tests, reconcile now 6 rows) —
  both confirmed executed against real Postgres, not skipped.
- `apps/web`: card suite, `dateTimeFormat`, and `localeParity` / `keyUsage` /
  `translationCoverage` across all eight locales.
- `tsc --noEmit` for `apps/api` and `apps/web`; `pnpm lint`.
- No migration, no schema change: the tenancy contract suites are W02's surface.

Closes #5332

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
BODY
)"
```

The wave sub-issue is #5332 (already substituted above).
`get_feature_status` before running the command — `Closes` is what auto-closes
the wave on merge.

- [ ] **Step 7: Confirm CI actually ran**

```bash
gh pr checks --watch ; true
```

`gh pr checks` exits non-zero while checks are pending, so a `&&`/`|| continue`
poll loop never fires — parse the text, and do not trust a "green" that is
really "nothing ran". This wave is stacked on W01/W04, so if the PR targets a
sibling branch rather than `main`, `ci.yml`'s `pull_request: branches: [main]`
trigger means **no CI runs at all**; dispatch it explicitly with
`gh workflow run CI --ref <branch>`.
