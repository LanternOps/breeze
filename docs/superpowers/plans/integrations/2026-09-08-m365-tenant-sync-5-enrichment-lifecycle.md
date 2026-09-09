# M365 Tenant Sync — Wave 5: Enrichment, sign-in continuation, Secure Score, rollup, cadence, device links, lifecycle, on-demand

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task's code steps carry real code — nothing here is a sketch.

**Goal:** finish the sync worker W04 started. Users gain their MFA/role enrichment written only from sources that actually succeeded; `signin_activity` becomes a resumable domain that re-claims itself until its continuation is exhausted; `secure_score` persists Graph-dated snapshots with a first-run 90-day backfill; every completed run assembles the daily posture rollup and (for Intune) reconciles Breeze device links; adaptive cadence sets the next due time; and the connection lifecycle (consent, disconnect, upgrade) plus an MFA-gated on-demand route drive the schedule from the product surface.

**Architecture:** W04 owns the three-phase `sync-domain` job and two extension seams — `applyCadence(state, outcome, signals)` (what the completion transaction writes to `interval_seconds` / `next_sync_at`) and `afterDomainPersisted(ctx)` (called inside the completion transaction, after the sync-state completion write). This wave fills both seams and adds four domain persisters/extensions plus `lifecycle.ts`. Everything that can schedule work is gated by `M365_TENANT_SYNC_ENABLED`. Persisters stay change-only and set-based; the worker holds a system DB context, so every statement filters by the `org_id` it was enqueued with.

**Tech stack:** TypeScript, Hono (API routes), Drizzle ORM + hand-written SQL (`sql` fragments, data-modifying CTEs), BullMQ + Redis (`claimAndEnqueue`, on-demand limiter), Zod (`@breeze/shared/m365`), Vitest (unit + integration), React + i18next (web card).

**Spec:** `docs/superpowers/specs/integrations/2026-09-08-m365-tenant-sync-foundation-design.md` — this wave implements §5.5, §5.6, §5.7, §5.8, §5.9, §5.2 (on-demand + seeding), §6 (enrichment/continuation/unlicensed rows), §3.3 (Secure Score keying), §10 (flag gating of every entry point).

**Plan overview + shared interface contract:** `docs/superpowers/plans/integrations/2026-09-08-m365-tenant-sync-0-overview.md`.

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

## Execution baseline — verify W02/W03/W04 shipped before Task 1

This wave consumes W04's modules by name. Run this block first; every line must
succeed. If one fails, W04 is not on your base branch — rebase, do not stub.

```bash
test -f apps/api/src/db/schema/m365Sync.ts                          # W02
grep -q "m365SyncState" apps/api/src/db/schema/m365Sync.ts           # W02
grep -q "m365.sync.secure_score" packages/shared/src/m365/readActions.ts   # W03
test -f apps/api/src/services/m365Sync/types.ts                     # W04
test -f apps/api/src/services/m365Sync/claim.ts                     # W04
test -f apps/api/src/services/m365Sync/run.ts                       # W04
test -f apps/api/src/services/m365Sync/hash.ts                      # W04
test -f apps/api/src/services/m365Sync/metrics.ts                   # W04
test -f apps/api/src/services/m365Sync/domains/users.ts             # W04
test -f apps/api/src/services/m365Sync/domains/intuneDevices.ts     # W04
grep -q "applyCadence"          apps/api/src/services/m365Sync/cadence.ts
grep -q "afterDomainPersisted"  apps/api/src/services/m365Sync/run.ts
grep -q "isM365TenantSyncEnabled" apps/api/src/config/env.ts        # W04
```

**Seam contract this wave assumes** (verify by reading, and reconcile against
the code if W04 diverged — the code is the authority, the contract is the
intent):

```ts
// cadence.ts (W04 ships a stub; Task 5 replaces the body)
export interface CadenceSignals { truncated: boolean; latencyMs: number; capacity: boolean }
export function applyCadence(
  state: { domain: M365SyncDomain; intervalSeconds: number },
  outcome: M365SyncOutcome,
  signals: CadenceSignals,
): { intervalSeconds: number; nextSyncAt: Date | null };

// run.ts — invoked INSIDE the completion transaction, AFTER the sync-state
// completion UPDATE (so the rollup sees this run's last_counts).
export interface AfterDomainPersistedContext extends PersistContext {
  domain: M365SyncDomain;
  persisted: DomainPersistResult;
}
export async function afterDomainPersisted(ctx: AfterDomainPersistedContext): Promise<void>;
```

**If `afterDomainPersisted` is called BEFORE the state-completion write in
W04's `run.ts`, move the call after it in Task 6** — the rollup reads
`m365_sync_state.last_counts` and would otherwise assemble yesterday's numbers
for the domain that just ran. Task 6 step 1 has the regression test that
catches this.

## Decisions this plan makes (each is a recorded deviation or an open item resolved)

1. **`runSyncDomain`'s return union gains `'partial-continue'`; `M365SyncOutcome`
   does not.** `m365_sync_status` is a shipped Postgres enum (W02) whose values
   are `success | partial | needs_consent | throttled | error`; a seventh value
   would need a migration, and spec §6 explicitly says the sync state is
   "unchanged until exhausted" while a continuation is outstanding. So
   `'partial-continue'` is a control-flow/metrics value only: it never reaches
   `last_status`. Signature becomes
   `Promise<M365SyncOutcome | 'fenced' | 'noop' | 'partial-continue'>`.
   **Contract deviation — the overview is updated in the same PR (Task 3).**
2. **`CadenceSignals` gains `unlicensed: boolean`, `authFailure: boolean` and
   `now: Date`.** Spec §6 needs `unlicensed` → interval to max and auth failure
   → `next_sync_at = NULL`; neither is derivable from the outcome alone
   (`unlicensed` is a `success`, and an auth failure is an `error` just like a
   persist fault). `now` makes the jitter test deterministic.
   **Contract deviation — overview updated in Task 5.**
3. **Enrichment counters are omitted from `last_counts`, not zeroed, when their
   source is not `ok`.** The in-memory items carry `mfaRegistered: null` for
   every user when the registration report failed, but the stored column keeps
   yesterday's value — counting the items would report "0 registered" for a
   tenant that is fully registered. Omitted key → the rollup writes NULL →
   the "unknown" columns spec §3.3 exists for. No extra count query is issued
   (spec §5.9's "zero count queries" holds).
4. **`is_admin` is derived from `admin_roles` inside the same statement.** On
   the conflict branch it is
   `jsonb_array_length(coalesce(excluded.admin_roles, '[]'::jsonb)) > 0`; on the
   insert branch it comes from the same array literal that populates
   `admin_roles` in that VALUES row. The two can never disagree because there is
   exactly one array.
5. **`backfill` travels as no column at all.** The state row's
   `last_success_at IS NULL` is the first-run test (spec §5.8: "the first
   `secure_score` run passes `backfill: true`"). After a disconnect the state
   rows are deleted, so a rebind re-backfills — which is what we want, the
   tenant changed.
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
8. **The DTO's `sync` block is added by this wave; W06 renders the "last synced"
   line from it.** This wave ships `syncEnabled` + `sync` on the read envelope
   and the "Sync now" button that uses `syncEnabled`. W06 owns the presentation
   of `sync.domains` beyond the button's gate. Say so in the PR body so W06 does
   not re-add the fields.
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
  W04's users primary projection: use `usersPrimaryProjection(item)` if
  `domains/users.ts` exports it; **if it does not, define and export it in this
  task** from the primary `/users` fields only (`id`,
  `userPrincipalName`, `displayName`, `mail`, `accountEnabled`, `jobTitle`,
  `department`, `usageLocation`, `onPremisesSyncEnabled`, `createdDateTime`,
  `assignedLicenses`) — enrichment is never in `core_hash` (§5.4).
- Produces (consumed by Task 6 and W06):
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
  Consumed by Task 3 (`run.ts`) and Task 5 (cadence signals).

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

### Task 3: `run.ts` — the sign-in continuation loop and `'partial-continue'`

Spec §5.7 ("a run that returns a continuation re-claims itself immediately at
priority 10, new generation"), §6 row 5, §5.2 priority lanes.

**Files:**
- Modify: `apps/api/src/services/m365Sync/run.ts`
- Modify: `apps/api/src/services/m365Sync/run.test.ts`
- Modify: `docs/superpowers/plans/integrations/2026-09-08-m365-tenant-sync-0-overview.md`

**Interfaces:**
- Consumes: `M365SyncJobData`, `M365SyncOutcome` (`m365Sync/types.ts`, W04);
  `claimAndEnqueue` (`m365Sync/claim.ts`, W04); `persistSigninActivity`
  (Task 2); `m365SyncState` (W02).
- Produces: `runSyncDomain(data): Promise<M365SyncOutcome | 'fenced' | 'noop' | 'partial-continue'>`
  — the added union member is **Decision 1**, a contract deviation recorded in
  the overview by this task.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/m365Sync/run.test.ts` (extend the existing
mocks in that file; do not add a second `vi.mock` for the same module):

```ts
import { claimAndEnqueue } from './claim';
import { persistSigninActivity } from './domains/signinActivity';

// add to the file's existing vi.mock list:
vi.mock('./domains/signinActivity', () => ({ persistSigninActivity: vi.fn() }));

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
    // continuation is outstanding (spec §6 "unchanged until exhausted").
    const set = capturedStateCompletionSet();
    expect(set).toHaveProperty('continuation', 'blob-2');
    expect(set).toHaveProperty('leaseUntil', null);
    expect(set).not.toHaveProperty('lastStatus');
    expect(set).not.toHaveProperty('lastSuccessAt');
    expect(set).not.toHaveProperty('nextSyncAt');
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

  it('omits continuation from the action when none is stored', async () => {
    persistSigninMock.mockResolvedValue({
      inserted: 0, updated: 0, stale: 0, unchanged: 0, counts: {},
      complete: true, continuation: null, unlicensed: false,
    });
    installExecutableSnapshot({ continuation: null });
    installExecutorResult({ items: [], sources: { signInActivity: 'ok' } });

    await runSyncDomain(SIGNIN_JOB);

    expect(capturedExecutorAction()).toEqual({ type: 'm365.sync.signin_activity' });
  });

  it('does NOT re-claim when the re-claim itself would run under a stale generation', async () => {
    // Fencing already returns before Phase C; prove no enqueue leaks from a
    // fenced run (a late job must never resurrect the loop).
    installFencedSnapshot();
    const outcome = await runSyncDomain(SIGNIN_JOB);
    expect(outcome).toBe('fenced');
    expect(claimAndEnqueueMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/m365Sync/run.test.ts`
Expected: FAIL — `runSyncDomain` never returns `'partial-continue'` and never
calls `claimAndEnqueue`.

- [ ] **Step 3: Implement**

In `apps/api/src/services/m365Sync/run.ts`:

1. Widen the return type and add the domain branch:

```ts
import { claimAndEnqueue } from './claim';
import { persistSigninActivity } from './domains/signinActivity';

export type M365SyncRunResult = M365SyncOutcome | 'fenced' | 'noop' | 'partial-continue';

export async function runSyncDomain(data: M365SyncJobData): Promise<M365SyncRunResult> { … }
```

2. Phase B — build the `signin_activity` action from the stored continuation
   (the snapshot loaded in Phase A already carries the state row):

```ts
function buildSyncAction(domain: M365SyncDomain, state: SyncStateSnapshot): M365SyncAction {
  switch (domain) {
    case 'signin_activity':
      return state.continuation
        ? { type: 'm365.sync.signin_activity', continuation: state.continuation }
        : { type: 'm365.sync.signin_activity' };
    case 'secure_score':
      // Task 4: the first run of a (re)connected tenant backfills 90 days.
      return { type: 'm365.sync.secure_score', backfill: state.lastSuccessAt === null };
    default:
      return { type: `m365.sync.${domain}` } as M365SyncAction;
  }
}
```

3. Phase C — the completion write for a continuation run is deliberately
   narrower than a normal completion:

```ts
if (data.domain === 'signin_activity') {
  const persisted = await persistSigninActivity(ctx, executorResult);

  if (persisted.continuation !== null) {
    // Spec §6: the sync state is "unchanged until exhausted". Only the
    // continuation, last_run_at and the lease move; last_status,
    // last_success_at, last_complete_snapshot_at and next_sync_at are left
    // exactly as the previous completed run set them, so a mid-loop crash
    // still leaves an honest "as of" for the UI.
    await tx.update(m365SyncState).set({
      continuation: persisted.continuation,
      lastRunAt: ctx.now,
      lastItemCount: executorResult.items.length,
      sources: executorResult.sources,
      leaseUntil: null,
      updatedAt: ctx.now,
    }).where(and(
      eq(m365SyncState.orgId, data.orgId),
      eq(m365SyncState.domain, data.domain),
      eq(m365SyncState.runGeneration, data.generation),
    ));
    recordSyncRun(data.domain, 'partial-continue');
    // Enqueue AFTER the transaction commits — an enqueue inside the tx that
    // then rolls back would run a job against a generation that never
    // existed. claimAndEnqueue bumps the generation itself.
    scheduleAfterCommit = () => claimAndEnqueue(data.orgId, ['signin_activity'], 10);
    return 'partial-continue';
  }
  // exhausted: fall through to the normal completion path with
  // `continuation: null` in the set.
}
```

   `scheduleAfterCommit` is a `(() => Promise<void>) | null` declared outside
   the transaction callback and awaited immediately after the transaction
   returns, inside a `try { … } catch` that logs and swallows: a failed
   re-enqueue is recovered by the ticker (the row's `next_sync_at` is still in
   the past and the lease is cleared).

4. `applyCadence` is **not** called on the `'partial-continue'` path — the
   continuation loop must not stretch the interval for making progress. Guard
   the existing call site:

```ts
if (outcome !== 'partial-continue') {
  const cadence = applyCadence({ domain: data.domain, intervalSeconds: state.intervalSeconds }, outcome, signals);
  …
}
```

5. Record the deviation in the overview. In
   `docs/superpowers/plans/integrations/2026-09-08-m365-tenant-sync-0-overview.md`,
   replace the `run.ts` block with:

```ts
// run.ts
export type M365SyncRunResult = M365SyncOutcome | 'fenced' | 'noop' | 'partial-continue';
export async function runSyncDomain(data: M365SyncJobData): Promise<M365SyncRunResult>;
// 'partial-continue' (W05): a signin_activity run that returned a continuation.
// It is a control-flow/metrics value only and NEVER reaches
// m365_sync_state.last_status — that column is the shipped m365_sync_status
// enum (W02), and spec §6 keeps the state "unchanged until exhausted".
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/m365Sync/run.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365Sync/run.ts \
        apps/api/src/services/m365Sync/run.test.ts \
        docs/superpowers/plans/integrations/2026-09-08-m365-tenant-sync-0-overview.md
git commit -m "feat(m365): sign-in continuation loop with 'partial-continue'

Spec §5.7/§6. A signin_activity run that comes back with a continuation stores
the opaque blob, leaves last_status/last_success_at/next_sync_at untouched,
clears its lease, and re-claims itself at priority 10 for a new generation.
The loop ends when the executor returns no continuation, and only then does the
run complete and advance cadence.

Contract deviation, recorded in the overview: runSyncDomain's return union
gains 'partial-continue'. M365SyncOutcome is unchanged — m365_sync_status is a
shipped Postgres enum and the spec keeps the state unchanged until exhausted.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 4: `domains/secureScore.ts` — Graph-dated snapshots with first-run backfill

Spec §3.3, §4.1 (`$top` 90 vs 3), §5.9 counts.

**Files:**
- Create: `apps/api/src/services/m365Sync/domains/secureScore.ts`
- Create: `apps/api/src/services/m365Sync/domains/secureScore.test.ts`

**Interfaces:**
- Consumes: `PersistContext`, `DomainPersistResult` (W04); `db`;
  `M365SyncActionResult` (W03); table `m365_secure_score_snapshots` (W02).
  The `backfill` flag is set by `buildSyncAction` in Task 3 from
  `state.lastSuccessAt === null` — this module never sees it.
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

The backfill flag itself carries no column: run.ts sets it from the state row's
last_success_at IS NULL, so a rebind (which deletes state) re-backfills.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 5: `cadence.ts` — adaptive interval and the `applyCadence` seam

Spec §5.7, §6 (rows: truncated ×2, throttled/capacity ×1.5, unlicensed → max,
needs_consent / auth failure → `next_sync_at NULL`).

**Files:**
- Modify: `apps/api/src/services/m365Sync/cadence.ts`
- Create: `apps/api/src/services/m365Sync/cadence.test.ts`
- Modify: `apps/api/src/services/m365Sync/run.ts` (signal assembly)
- Modify: `docs/superpowers/plans/integrations/2026-09-08-m365-tenant-sync-0-overview.md`

**Interfaces:**
- Consumes: `M365_SYNC_DOMAIN_INTERVAL_BOUNDS`,
  `M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS`, `M365SyncDomain`
  (`@breeze/shared/m365`, W03); `M365SyncOutcome` (W04).
- Produces: `nextInterval(domain, current, outcome, signals): number`;
  `applyCadence(state, outcome, signals): { intervalSeconds; nextSyncAt: Date | null }`;
  `export interface CadenceSignals { truncated: boolean; latencyMs: number; capacity: boolean; unlicensed: boolean; authFailure: boolean; now: Date }`
  (**Decision 2**, contract deviation recorded here).

- [ ] **Step 1: Write the failing test**

`apps/api/src/services/m365Sync/cadence.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyCadence, nextInterval, type CadenceSignals } from './cadence';

const NOW = new Date('2026-09-08T12:00:00.000Z');

function signals(overrides: Partial<CadenceSignals> = {}): CadenceSignals {
  return {
    truncated: false, latencyMs: 1_000, capacity: false,
    unlicensed: false, authFailure: false, now: NOW,
    ...overrides,
  };
}

afterEach(() => { vi.restoreAllMocks(); });

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
  it('schedules now + interval + jitter for a completed run', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const out = applyCadence({ domain: 'users', intervalSeconds: 21_600 }, 'success', signals());
    expect(out.intervalSeconds).toBe(21_600);
    expect(out.nextSyncAt).toEqual(new Date(NOW.getTime() + 21_600_000));
  });

  it('adds at most 10% jitter, never negative', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999_999);
    const out = applyCadence({ domain: 'users', intervalSeconds: 21_600 }, 'success', signals());
    const delta = out.nextSyncAt!.getTime() - NOW.getTime();
    expect(delta).toBeGreaterThanOrEqual(21_600_000);
    expect(delta).toBeLessThanOrEqual(21_600_000 * 1.1);
  });

  it('unschedules on needs_consent', () => {
    const out = applyCadence({ domain: 'ca_policies', intervalSeconds: 86_400 }, 'needs_consent', signals());
    expect(out.nextSyncAt).toBeNull();
    expect(out.intervalSeconds).toBe(86_400);
  });

  it('unschedules on a connection auth failure', () => {
    const out = applyCadence({ domain: 'users', intervalSeconds: 21_600 }, 'error', signals({ authFailure: true }));
    expect(out.nextSyncAt).toBeNull();
  });

  it('still schedules a non-auth terminal error so the ticker retries on cadence', () => {
    const out = applyCadence({ domain: 'users', intervalSeconds: 21_600 }, 'error', signals());
    expect(out.nextSyncAt).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/m365Sync/cadence.test.ts`
Expected: FAIL — the W04 stub returns the default interval unconditionally and
has no `unlicensed`/`authFailure`/`now` signals.

- [ ] **Step 3: Implement**

Replace the body of `apps/api/src/services/m365Sync/cadence.ts`:

```ts
import {
  M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS,
  M365_SYNC_DOMAIN_INTERVAL_BOUNDS,
  type M365SyncDomain,
} from '@breeze/shared/m365';
import type { M365SyncOutcome } from './types';

export interface CadenceSignals {
  /** The executor hit its item/page cap: the tenant is bigger than one run. */
  truncated: boolean;
  /** Wall time of the executor call. >60s means we are stressing the tenant. */
  latencyMs: number;
  /** Executor answered 503 sync_capacity for this run. */
  capacity: boolean;
  /** Sub-source reported `unlicensed` (sign-in activity without Entra P1). */
  unlicensed: boolean;
  /** Connection credential/tenant is no longer usable — stop scheduling. */
  authFailure: boolean;
  now: Date;
}

const SLOW_EXECUTOR_MS = 60_000;
const JITTER_FRACTION = 0.1;

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
  state: { domain: M365SyncDomain; intervalSeconds: number },
  outcome: M365SyncOutcome,
  signals: CadenceSignals,
): { intervalSeconds: number; nextSyncAt: Date | null } {
  const intervalSeconds = nextInterval(state.domain, state.intervalSeconds, outcome, signals);
  if (outcome === 'needs_consent' || signals.authFailure) {
    return { intervalSeconds, nextSyncAt: null };
  }
  // Jitter is additive and one-sided so a fleet that all completed in the same
  // tick spreads forward, never backward into the tick that just ran.
  const jitterSeconds = Math.floor(intervalSeconds * JITTER_FRACTION * Math.random());
  return {
    intervalSeconds,
    nextSyncAt: new Date(signals.now.getTime() + (intervalSeconds + jitterSeconds) * 1_000),
  };
}
```

In `run.ts`, assemble the signals at the call site (Task 3 already guards the
`'partial-continue'` path):

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
  'graph_permission_missing',
]);
```

Update the overview's `cadence.ts` block to the six-field `CadenceSignals` and
note "W05: `unlicensed`, `authFailure`, `now` added — see W05 Decision 2".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/m365Sync/cadence.test.ts src/services/m365Sync/run.test.ts`
Expected: PASS (both files)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365Sync/cadence.ts \
        apps/api/src/services/m365Sync/cadence.test.ts \
        apps/api/src/services/m365Sync/run.ts \
        docs/superpowers/plans/integrations/2026-09-08-m365-tenant-sync-0-overview.md
git commit -m "feat(m365): adaptive sync cadence (spec §5.7)

Truncated or slow (>60s) runs double the interval; throttled or executor
sync_capacity multiply by 1.5; a plain success decays 25% toward the domain
default; an unlicensed sub-source jumps straight to the domain ceiling. Every
result is clamped to M365_SYNC_DOMAIN_INTERVAL_BOUNDS, so sign-in activity can
never be pulled below its 24h floor.

needs_consent and a connection auth failure return next_sync_at NULL, taking
the row out of the ticker until a consent or retest re-seeds it. A non-auth
terminal error still schedules — otherwise one bad run would silently retire a
domain.

Contract deviation, recorded in the overview: CadenceSignals gains unlicensed,
authFailure and now. None is derivable from the outcome (unlicensed IS a
success; an auth failure is an error like any other).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 6: `rollup.ts` — daily posture rollup and the `afterDomainPersisted` seam

Spec §3.3 (`m365_posture_rollups`), §5.9 (assembled from the six
`last_counts` + `last_complete_snapshot_at`, one read + one upsert).

**Files:**
- Create: `apps/api/src/services/m365Sync/rollup.ts`
- Create: `apps/api/src/services/m365Sync/rollup.test.ts`
- Modify: `apps/api/src/services/m365Sync/run.ts` (seam body + call order)

**Interfaces:**
- Consumes: `M365_SYNC_DOMAINS`, `M365SyncDomain` (W03); `m365SyncState`,
  `m365PostureRollups` (W02); `db`; `AfterDomainPersistedContext` (W04).
- Produces: `upsertPostureRollup(orgId, tenantId, date): Promise<void>`;
  `export const ROLLUP_COUNTER_SOURCES` (the domain → column map, exported so
  W06's integration suite can assert it covers every rollup column).

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

Add to `run.test.ts` the ordering regression this seam depends on:

```ts
it('runs afterDomainPersisted AFTER the sync-state completion write', async () => {
  const order: string[] = [];
  capturedStateCompletionHook(() => order.push('state'));
  vi.mocked(upsertPostureRollup).mockImplementation(async () => { order.push('rollup'); });
  await runSyncDomain(USERS_JOB);
  expect(order).toEqual(['state', 'rollup']);
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
 * Called from `afterDomainPersisted` inside the completion transaction, AFTER
 * the sync-state completion write, so the domain that just ran contributes its
 * fresh `last_counts`.
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

In `run.ts`, give the seam a body:

```ts
export async function afterDomainPersisted(ctx: AfterDomainPersistedContext): Promise<void> {
  // Runs inside the completion transaction, after the sync-state completion
  // write. Both hooks are best-effort in the sense that they cannot be
  // partially applied — a throw rolls the whole completion back and the ticker
  // reclaims the row on lease expiry, which is the correct failure mode: a
  // committed completion with a stale rollup would lie to the org tab.
  if (ctx.domain === 'intune_devices') {
    const links = await reconcileDeviceLinks(ctx.orgId);       // Task 7
    if (links.ambiguous > 0) recordSyncLinkAmbiguous(ctx.orgId, links.ambiguous);
  }
  await upsertPostureRollup(ctx.orgId, ctx.tenantId, utcDate(ctx.now));
}

/** UTC calendar day of the run, the key of `m365_posture_rollups`. */
function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}
```

**Verify the call order** in W04's `run.ts` completion transaction: the
sync-state completion `UPDATE` must precede `await afterDomainPersisted(…)`.
Move the call if it does not.

`recordSyncLinkAmbiguous` is W04's `m365Sync/metrics.ts` recorder for the
contracted metric `m365_sync_link_ambiguous_total`. If W04 named it
differently, use its name — **the metric name is the contract, the function
name is not.** If W04 shipped no recorder for it, add
`export function recordSyncLinkAmbiguous(orgId: string, count: number): void`
to `m365Sync/metrics.ts` following the counter pattern already in that file
(labels must stay bounded: label by nothing, or by `domain`, never by `orgId`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/m365Sync/rollup.test.ts src/services/m365Sync/run.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365Sync/rollup.ts \
        apps/api/src/services/m365Sync/rollup.test.ts \
        apps/api/src/services/m365Sync/run.ts \
        apps/api/src/services/m365Sync/metrics.ts
git commit -m "feat(m365): daily posture rollup wired into afterDomainPersisted

Spec §3.3/§5.9. One indexed read of the org's six m365_sync_state rows plus one
upsert on (org_id, rollup_date) — no COUNT queries. Counters no domain has
reported stay NULL, never 0: 'we do not know' and 'there are none' are
different facts and the *_unknown columns exist precisely so partial enrichment
is never reported as absence. domains_fresh carries asOf/complete for all six
domains, including ones with no state row yet.

The seam runs inside the completion transaction AFTER the sync-state write, so
the domain that just finished contributes its fresh last_counts; run.test.ts
pins that ordering.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 7: `links.ts` — set-based Breeze↔Intune device link reconciliation

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
  — consumed by Task 6's `afterDomainPersisted`.

- [ ] **Step 1: Write the failing test**

`apps/api/src/services/m365Sync/links.test.ts` — the shape/statement-count
proof; Task 8 is the behavioural proof against real Postgres.

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

### Task 8: real-Postgres proof for device link reconciliation

Spec §9 ("link reconciliation over unlinked rows, ambiguous serial skipped").
Two set-based statements with four CTEs each are exactly the kind of SQL a
mock cannot validate — this is the discriminating test for Task 7.

**Files:**
- Create: `apps/api/src/__tests__/integration/m365SyncLinks.integration.test.ts`

**Interfaces:**
- Consumes: `reconcileDeviceLinks` (Task 7); `createPartner`,
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

Expected: FAIL before Task 7's implementation is complete. If Task 7 already
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

### Task 9: `lifecycle.ts` — consent seeding, disconnect erasure, upgrade re-seed, on-demand request

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
  Consumed by Tasks 10, 11, 13.

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
 * Idempotent, so it is safe to call from both the upgrade-consent promotion
 * branch and the ordinary identity-verification success branch.
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
 * Rate limiting, MFA and the connection check live in the route (Task 13).
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

### Task 10: wire the disconnect hook into `connectionService.disconnectConnection`

Spec §5.8 first bullet, §6 last rows. `disconnectConnection`
(`connectionService.ts:715-757`) sets `revoked` and clears the tenant but keeps
the row, so no FK cascade fires — the erasure must be explicit.

**Files:**
- Modify: `apps/api/src/services/m365ControlPlane/connectionService.ts`
- Modify: `apps/api/src/services/m365ControlPlane/connectionService.test.ts`

**Interfaces:**
- Consumes: `onConnectionDisconnected` (Task 9).
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

```ts
      const nextAttemptId = randomUUID();
      const disconnected = requireCasRow(await db.update(m365Connections).set({
        …unchanged…
      }).where(attemptPredicate({ … })).returning());

      // Spec §5.8: the row survives a disconnect (status 'revoked', tenant
      // cleared), so no FK cascade fires and the synced tenant snapshot would
      // otherwise outlive the connection that authorised it. The erasure runs
      // in THIS transaction — a committed disconnect that left m365_users
      // behind is a privacy defect — and is profile-agnostic because the sync
      // tables belong to the org, not to one profile's connection.
      await onConnectionDisconnected({ id: disconnected.id, orgId: disconnected.orgId });

      return disconnected;
```

Note the call is inside `withSystemDbAccessContext`, so `onConnectionDisconnected`
must not open its own (Task 9 asserts it does not).

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

### Task 11: wire consent seeding and the upgrade re-seed into the consent callback

Spec §5.8 bullets 2-3, §10.1 (every entry point flag-gated). The callback
already knows `applied.status` and the drift outcome at
`m365ConsentCallback.ts:588-600`.

**Files:**
- Modify: `apps/api/src/routes/m365ConsentCallback.ts`
- Modify: `apps/api/src/routes/m365ConsentCallback.test.ts`

**Interfaces:**
- Consumes: `onConnectionConsented`, `onConnectionUpgraded` (Task 9);
  `isM365TenantSyncEnabled` (W04).
- Produces: no new export.

**W01 tolerance — this task works whether W01 lands before or after.** Decide
the wiring point by inspection, not assumption:

```bash
# Does W01's dedicated upgrade-consent promotion branch exist yet?
grep -n "upgrade-consent" apps/api/src/routes/m365CustomerGraphRead.ts
grep -n "permissionManifestVersion" apps/api/src/routes/m365ConsentCallback.ts
```

- **W01 landed** (an explicit promotion branch exists): call
  `onConnectionUpgraded` **from that branch**, immediately after
  `permissionManifestVersion` is promoted, and keep the `onConnectionConsented`
  call in the identity-verification success branch below.
- **W01 not landed** (no promotion branch): put both calls in the
  identity-verification success branch as written below, keyed on
  `driftOutcome === 'manifest_stale'` being cleared. The hooks are idempotent,
  so when W01 lands it can add its own `onConnectionUpgraded` call without
  removing this one.

Either way the call is a plain import of a hook, so nothing here breaks if
W01's branch appears later.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/routes/m365ConsentCallback.test.ts`:

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

describe('sync seeding on consent success', () => {
  beforeEach(() => { syncFlagMock.mockReturnValue(true); });

  it('seeds when the applied connection is active', async () => {
    const response = await completeIdentityVerification({ appliedStatus: 'active', lastErrorCode: null });
    expect(response.status).toBe(302);
    expect(consentedMock).toHaveBeenCalledWith({
      id: CONNECTION_ID, orgId: ORG_ID, tenantId: VERIFIED_TENANT, status: 'active',
    });
  });

  it('seeds when the applied connection is DEGRADED', async () => {
    await completeIdentityVerification({ appliedStatus: 'degraded', lastErrorCode: 'grant_missing' });
    expect(consentedMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'degraded' }));
  });

  it('does not seed when verification failed', async () => {
    await completeIdentityVerification({ appliedStatus: 'pending-consent', lastErrorCode: 'consent_expired' });
    expect(consentedMock).not.toHaveBeenCalled();
    expect(upgradedMock).not.toHaveBeenCalled();
  });

  it('does not seed when the flag is off', async () => {
    syncFlagMock.mockReturnValue(false);
    await completeIdentityVerification({ appliedStatus: 'active', lastErrorCode: null });
    expect(consentedMock).not.toHaveBeenCalled();
    expect(upgradedMock).not.toHaveBeenCalled();
  });

  it('re-seeds unscheduled needs_consent domains once manifest_stale is cleared', async () => {
    await completeIdentityVerification({ appliedStatus: 'active', lastErrorCode: null });
    expect(upgradedMock).toHaveBeenCalledWith({ id: CONNECTION_ID, orgId: ORG_ID });
  });

  it('does NOT re-seed while the manifest is still stale', async () => {
    await completeIdentityVerification({ appliedStatus: 'degraded', lastErrorCode: 'manifest_stale' });
    expect(consentedMock).toHaveBeenCalledOnce();
    expect(upgradedMock).not.toHaveBeenCalled();
  });

  it('still redirects successfully when a hook rejects', async () => {
    consentedMock.mockRejectedValueOnce(new Error('seed boom'));
    const response = await completeIdentityVerification({ appliedStatus: 'active', lastErrorCode: null });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('active');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/m365ConsentCallback.test.ts`
Expected: FAIL — no hook is called.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/m365ConsentCallback.ts`:

```ts
import { isM365TenantSyncEnabled } from '../config/env';
import { onConnectionConsented, onConnectionUpgraded } from '../services/m365Sync/lifecycle';
```

Inside the existing success branch, after the audit events and before
`return terminalRedirect(outcome);`:

```ts
        // Spec §5.8/§10.1. Seeding is gated by the tenant-sync flag, runs for
        // `degraded` as well as `active` (a connection missing one optional
        // grant still syncs every other domain), and is deliberately
        // fire-and-await-with-swallow: a Microsoft consent that actually
        // succeeded must never redirect the admin to a failure page because
        // our scheduler had a bad minute. The hooks log and the ticker's
        // reconciliation re-seeds on the next tick.
        if (isM365TenantSyncEnabled() && applied.tenantId) {
          try {
            await onConnectionConsented({
              id: applied.id,
              orgId: applied.orgId,
              tenantId: applied.tenantId,
              status: applied.status,
            });
            // An upgrade-consent promotes the manifest in place; the domains
            // that had been parked on `needs_consent` for want of a v3 scope
            // are re-armed only once the stale-manifest drift is actually
            // cleared. Idempotent, so W01's dedicated promotion branch may
            // also call it.
            if (driftOutcome !== 'manifest_stale') {
              await onConnectionUpgraded({ id: applied.id, orgId: applied.orgId });
            }
          } catch (err) {
            console.error(
              `[m365ConsentCallback] Sync lifecycle hook failed for connection=${applied.id}:`,
              err,
            );
          }
        }
```

`applied.status` is narrowed to `'active' | 'degraded'` by the enclosing `if`;
if TypeScript does not carry the narrowing through, assert with a local
`const status = applied.status === 'active' ? 'active' as const : 'degraded' as const;`
rather than casting the object.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/m365ConsentCallback.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/m365ConsentCallback.ts \
        apps/api/src/routes/m365ConsentCallback.test.ts
git commit -m "feat(m365): seed tenant sync from the consent callback

Spec §5.8/§10.1. A verified consent that leaves the connection active OR
degraded seeds all six sync domains due now at priority 1, so the org tab has
data within a tick. When the stale-manifest drift is cleared in the same
callback, the upgrade hook additionally re-arms domains that had been parked on
needs_consent for want of a v3 scope.

Both calls are flag-gated and wrapped: a Microsoft consent that actually
succeeded must never redirect the admin to a failure page because our scheduler
had a bad minute — the hooks log and the ticker reconciliation re-seeds.

The upgrade hook is idempotent, so W01's dedicated upgrade-consent promotion
branch can call it from there as well when it lands.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 12: `onDemandLimiter.ts` — one sync per org per 15 minutes

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

### Task 13: `POST /m365/connections/:id/sync` — MFA-gated on-demand route

Spec §5.2 ("MFA-gated like retest"), §10.1 (flag gates every entry point).
Copies the retest route's middleware chain
(`m365CustomerGraphRead.ts:252-298`) exactly: `requireOrgsWrite`,
`requireMfa()`, `zValidator('param', idParam)`, then `mutationOrg(c)`.

**Files:**
- Modify: `apps/api/src/routes/m365CustomerGraphRead.ts`
- Modify: `apps/api/src/routes/m365CustomerGraphRead.test.ts`
- Modify: `apps/api/src/services/m365ControlPlane/metrics.ts`
- Modify: `apps/api/src/services/m365ControlPlane/metrics.test.ts`

**Interfaces:**
- Consumes: `consumeOnDemandSyncSlot`, `ON_DEMAND_SYNC_WINDOW_SECONDS`
  (Task 12); `requestOnDemandSync`, `ON_DEMAND_SYNC_DOMAINS` (Task 9);
  `isM365TenantSyncEnabled` (W04); `listCustomerGraphReadConnections`,
  `requireMfa`, `requirePermission` (shipped).
- Produces: the route; the audit event
  `'m365.customer_graph_read.sync_requested'`.

- [ ] **Step 1: Write the failing tests**

First extend `apps/api/src/services/m365ControlPlane/metrics.test.ts` — the
existing case asserts "exactly the seven fixed lifecycle events" and must be
updated in the same commit, or the added event reds Test API:

```ts
  it('exposes exactly the eight fixed lifecycle events and a bounded outcome enum', () => {
    expect(M365_CUSTOMER_GRAPH_READ_EVENTS).toEqual([
      'm365.customer_graph_read.consent_initiated',
      'm365.customer_graph_read.admin_consent_returned',
      'm365.customer_graph_read.tenant_binding_verified',
      'm365.customer_graph_read.verification_failed',
      'm365.customer_graph_read.grant_drift_detected',
      'm365.customer_graph_read.retested',
      'm365.customer_graph_read.disconnected',
      'm365.customer_graph_read.sync_requested',
    ]);
    expect(new Set(M365_CUSTOMER_GRAPH_READ_OUTCOMES).size)
      .toBe(M365_CUSTOMER_GRAPH_READ_OUTCOMES.length);
  });
```

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
Expected: FAIL — the route 404s as an unknown path and the event list has seven
entries.

- [ ] **Step 3: Implement**

In `apps/api/src/services/m365ControlPlane/metrics.ts`, append to
`M365_CUSTOMER_GRAPH_READ_EVENTS`:

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

Adds the eighth lifecycle audit event, m365.customer_graph_read.sync_requested.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 14: read-envelope DTO — `syncEnabled` and the per-domain `sync` block

Spec §6 "Surfaced" column (org tab "as of" per fact), §2.2 item 1's DTO
precedent. **Coordination:** this wave adds the fields and the button's gate;
**W06 renders the "last synced" line from `sync.domains`.** W06 must not
re-add these fields — say so in the PR body.

**Files:**
- Create: `apps/api/src/services/m365Sync/summary.ts`
- Create: `apps/api/src/services/m365Sync/summary.test.ts`
- Modify: `apps/api/src/routes/m365CustomerGraphRead.ts`
- Modify: `apps/api/src/routes/m365CustomerGraphRead.test.ts`

**Interfaces:**
- Consumes: `M365_SYNC_DOMAINS`, `M365SyncDomain` (W03); `m365SyncState` (W02);
  `db`; `isM365TenantSyncEnabled` (W04).
- Produces:
  ```ts
  export interface M365SyncDomainSummary {
    domain: M365SyncDomain;
    status: 'success' | 'partial' | 'needs_consent' | 'throttled' | 'error' | null;
    lastSuccessAt: string | null;
    truncated: boolean;
    needsConsent: boolean;
  }
  export interface M365SyncSummary { lastSuccessAt: string | null; domains: M365SyncDomainSummary[] }
  export async function loadSyncSummary(orgId: string): Promise<M365SyncSummary | null>;
  ```
  plus `CustomerGraphReadEnvelope` gaining `syncEnabled: boolean` and
  `sync: M365SyncSummary | null`.

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

function rows(values: unknown[]) {
  const where = vi.fn(async () => values);
  vi.mocked(db.select).mockReturnValue({ from: vi.fn(() => ({ where })) } as never);
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

  it('returns null when the org has no state rows at all', async () => {
    rows([]);
    await expect(loadSyncSummary(ORG)).resolves.toBeNull();
  });

  it('lists all six domains in canonical order, filling gaps as never-synced', async () => {
    rows([{ domain: 'users', lastStatus: 'success', lastSuccessAt: new Date('2026-09-08T06:00:00.000Z'), truncated: false }]);
    const summary = (await loadSyncSummary(ORG))!;
    expect(summary.domains.map((d) => d.domain)).toEqual([
      'users', 'signin_activity', 'intune_devices', 'ca_policies', 'skus', 'secure_score',
    ]);
    expect(summary.domains[0]).toEqual({
      domain: 'users', status: 'success',
      lastSuccessAt: '2026-09-08T06:00:00.000Z', truncated: false, needsConsent: false,
    });
    expect(summary.domains[1]).toEqual({
      domain: 'signin_activity', status: null,
      lastSuccessAt: null, truncated: false, needsConsent: false,
    });
  });

  it('reports the NEWEST successful domain as the envelope lastSuccessAt', async () => {
    rows([
      { domain: 'users', lastStatus: 'success', lastSuccessAt: new Date('2026-09-08T06:00:00.000Z'), truncated: false },
      { domain: 'skus', lastStatus: 'success', lastSuccessAt: new Date('2026-09-08T09:00:00.000Z'), truncated: false },
      { domain: 'ca_policies', lastStatus: 'needs_consent', lastSuccessAt: null, truncated: false },
    ]);
    const summary = (await loadSyncSummary(ORG))!;
    expect(summary.lastSuccessAt).toBe('2026-09-08T09:00:00.000Z');
  });

  it('flags needsConsent and truncated per domain', async () => {
    rows([
      { domain: 'ca_policies', lastStatus: 'needs_consent', lastSuccessAt: null, truncated: false },
      { domain: 'users', lastStatus: 'partial', lastSuccessAt: new Date('2026-09-08T06:00:00.000Z'), truncated: true },
    ]);
    const summary = (await loadSyncSummary(ORG))!;
    const byDomain = Object.fromEntries(summary.domains.map((d) => [d.domain, d]));
    expect(byDomain.ca_policies!.needsConsent).toBe(true);
    expect(byDomain.users!.truncated).toBe(true);
    expect(byDomain.users!.needsConsent).toBe(false);
  });

  it('is null-safe on an unknown stored status', async () => {
    rows([{ domain: 'users', lastStatus: 'weird', lastSuccessAt: null, truncated: false }]);
    const summary = (await loadSyncSummary(ORG))!;
    expect(summary.domains[0]!.status).toBeNull();
  });
});
```

Append to `apps/api/src/routes/m365CustomerGraphRead.test.ts`:

```ts
describe('GET /m365/connections exposes the sync block', () => {
  it('carries syncEnabled true and the summary when the flag is on', async () => {
    syncFlagMock.mockReturnValue(true);
    summaryMock.mockResolvedValue({ lastSuccessAt: '2026-09-08T09:00:00.000Z', domains: [] });
    const body = await (await getConnections()).json();
    expect(body.syncEnabled).toBe(true);
    expect(body.sync).toEqual({ lastSuccessAt: '2026-09-08T09:00:00.000Z', domains: [] });
  });

  it('carries syncEnabled false and a null sync block when the flag is off', async () => {
    syncFlagMock.mockReturnValue(false);
    summaryMock.mockResolvedValue(null);
    const body = await (await getConnections()).json();
    expect(body.syncEnabled).toBe(false);
    expect(body.sync).toBeNull();
  });

  it('keeps the envelope key set exact so the web parser stays strict', async () => {
    const body = await (await getConnections()).json();
    expect(Object.keys(body).sort()).toEqual([
      'connection', 'onboardingEnabled', 'profile', 'sync', 'syncEnabled',
    ]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/m365Sync/summary.test.ts src/routes/m365CustomerGraphRead.test.ts`
Expected: FAIL — module missing, envelope lacks the keys.

- [ ] **Step 3: Implement**

`apps/api/src/services/m365Sync/summary.ts`:

```ts
import { eq } from 'drizzle-orm';
import { M365_SYNC_DOMAINS, type M365SyncDomain } from '@breeze/shared/m365';
import { isM365TenantSyncEnabled } from '../../config/env';
import { db } from '../../db';
import { m365SyncState } from '../../db/schema/m365Sync';

const STATUSES = ['success', 'partial', 'needs_consent', 'throttled', 'error'] as const;
export type M365SyncDomainStatus = typeof STATUSES[number];

export interface M365SyncDomainSummary {
  domain: M365SyncDomain;
  status: M365SyncDomainStatus | null;
  lastSuccessAt: string | null;
  truncated: boolean;
  needsConsent: boolean;
}

export interface M365SyncSummary {
  /** Newest successful run across all domains — the card's "last synced". */
  lastSuccessAt: string | null;
  domains: M365SyncDomainSummary[];
}

function status(value: unknown): M365SyncDomainStatus | null {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
    ? value as M365SyncDomainStatus
    : null;
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Per-domain freshness for the Integrations card and the org tab. Read on the
 * request's own DB context, so RLS (shape 1) is the tenant boundary — no
 * system context, no cross-org read.
 *
 * Every domain is represented even when it has no state row, so the UI can say
 * "never synced" for one domain without implying the whole connection is idle;
 * that distinction is the whole point of per-domain "as of" (spec §6).
 */
export async function loadSyncSummary(orgId: string): Promise<M365SyncSummary | null> {
  if (!isM365TenantSyncEnabled()) return null;

  const rows = await db
    .select({
      domain: m365SyncState.domain,
      lastStatus: m365SyncState.lastStatus,
      lastSuccessAt: m365SyncState.lastSuccessAt,
      truncated: m365SyncState.truncated,
    })
    .from(m365SyncState)
    .where(eq(m365SyncState.orgId, orgId));

  if (rows.length === 0) return null;

  const byDomain = new Map(rows.map((row) => [row.domain as M365SyncDomain, row]));
  const domains: M365SyncDomainSummary[] = M365_SYNC_DOMAINS.map((domain) => {
    const row = byDomain.get(domain);
    const value = status(row?.lastStatus);
    return {
      domain,
      status: value,
      lastSuccessAt: iso(row?.lastSuccessAt ?? null),
      truncated: row?.truncated === true,
      needsConsent: value === 'needs_consent',
    };
  });

  const successes = domains
    .map((d) => d.lastSuccessAt)
    .filter((value): value is string => value !== null)
    .sort();

  return { lastSuccessAt: successes.at(-1) ?? null, domains };
}
```

In `m365CustomerGraphRead.ts`, extend the envelope (it becomes async — the
only caller is the GET route):

```ts
export interface CustomerGraphReadEnvelope {
  profile: { … unchanged … };
  onboardingEnabled: boolean;
  connection: CustomerGraphReadConnectionDto | null;
  /** W05: tenant sync is available in this deployment. Gates the Sync now button. */
  syncEnabled: boolean;
  /** W05: per-domain freshness. Null when the flag is off or nothing is seeded. W06 renders it. */
  sync: M365SyncSummary | null;
}

async function envelope(
  orgId: string,
  connection: ConnectionWithHealth | null,
): Promise<CustomerGraphReadEnvelope> {
  return {
    profile: { … unchanged … },
    onboardingEnabled: isM365CustomerGraphReadOnboardingEnabledForOrg(orgId),
    connection: connection ? toConnectionDto(connection) : null,
    syncEnabled: isM365TenantSyncEnabled(),
    sync: await loadSyncSummary(orgId),
  };
}
```

and in the GET handler: `return c.json(await envelope(resolved.orgId, connections[0] ?? null));`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/m365Sync/summary.test.ts src/routes/m365CustomerGraphRead.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365Sync/summary.ts \
        apps/api/src/services/m365Sync/summary.test.ts \
        apps/api/src/routes/m365CustomerGraphRead.ts \
        apps/api/src/routes/m365CustomerGraphRead.test.ts
git commit -m "feat(m365): expose syncEnabled and per-domain sync freshness on the read DTO

Spec §6. The read envelope gains syncEnabled (gates the Sync now button) and a
sync block listing all six domains with status, lastSuccessAt, truncated and
needsConsent, plus the newest successful run across domains. Every domain is
represented even with no state row, so the UI can say 'never synced' for one
domain without implying the whole connection is idle — that per-fact 'as of' is
the point of the spec's error table.

Read on the request's own DB context, so shape-1 RLS is the tenant boundary.

W06 renders the 'last synced' line from these fields; it should not re-add them.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 15: web — "Sync now" button on the Customer Graph Read card

Spec §2.2 item 3's card, §5.2 on-demand. The card's `parseEnvelope` uses
`hasExactKeys`, so the two new DTO fields are a **required** parser change, not
an optional one — without it the whole card falls to its "unavailable" state.

**Files:**
- Modify: `apps/web/src/components/integrations/M365CustomerGraphReadCard.tsx`
- Modify: `apps/web/src/components/integrations/M365CustomerGraphReadCard.test.tsx`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/integrations.json`

**Interfaces:**
- Consumes: the Task 14 DTO fields; `runAction`, `handleActionError`
  (`lib/runAction`); `fetchWithAuth`.
- Produces: no exports; `data-testid` is not used by this card (it queries by
  role/name), so follow the existing convention and keep it that way.

- [ ] **Step 1: Write the failing tests**

Append to `M365CustomerGraphReadCard.test.tsx` (the file's `envelope()` helper
must gain the two keys or every existing test fails on `hasExactKeys` — do that
first, in the same edit):

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
```

Also extend the existing parameterised action tables in the file
(`["retest", "Retest"]`, `["retest", "Retest", "complete"]`, …) with
`["sync", "Sync now"]` entries so the shared disabled-while-busy and
scope-isolation matrices cover the new action.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/web && npx vitest run src/components/integrations/M365CustomerGraphReadCard.test.tsx`
Expected: FAIL — no such button; and, before the helper is updated, the existing
tests fail on `hasExactKeys` once the API sends the new keys.

- [ ] **Step 3: Implement**

In `M365CustomerGraphReadCard.tsx`:

```ts
type SyncDomainStatus = "success" | "partial" | "needs_consent" | "throttled" | "error";
const SYNC_DOMAINS = [
  "users", "signin_activity", "intune_devices", "ca_policies", "skus", "secure_score",
] as const;
type SyncDomain = (typeof SYNC_DOMAINS)[number];

type SyncDomainSummary = {
  domain: SyncDomain;
  status: SyncDomainStatus | null;
  lastSuccessAt: string | null;
  truncated: boolean;
  needsConsent: boolean;
};
type SyncSummary = { lastSuccessAt: string | null; domains: SyncDomainSummary[] };

type ActionName = "consent" | "retest" | "disconnect" | "sync";
```

Parsers, in the same defensive style as `parseConnection` (an unparseable
block degrades to `null`, never to a thrown render):

```ts
function parseSyncDomain(value: unknown): SyncDomainSummary | null {
  const keys = ["domain", "status", "lastSuccessAt", "truncated", "needsConsent"];
  if (!isRecord(value) || !hasExactKeys(value, keys)) return null;
  const lastSuccessAt = parseTimestamp(value.lastSuccessAt);
  if (
    typeof value.domain !== "string" || !(SYNC_DOMAINS as readonly string[]).includes(value.domain)
    || (value.status !== null && typeof value.status !== "string")
    || lastSuccessAt === undefined
    || typeof value.truncated !== "boolean"
    || typeof value.needsConsent !== "boolean"
  ) return null;
  return {
    domain: value.domain as SyncDomain,
    status: (value.status as SyncDomainStatus | null),
    lastSuccessAt,
    truncated: value.truncated,
    needsConsent: value.needsConsent,
  };
}

function parseSync(value: unknown): SyncSummary | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, ["lastSuccessAt", "domains"])) return undefined;
  const lastSuccessAt = parseTimestamp(value.lastSuccessAt);
  if (lastSuccessAt === undefined || !Array.isArray(value.domains) || value.domains.length > 16) return undefined;
  const domains = value.domains.map(parseSyncDomain);
  if (domains.some((domain) => domain === null)) return undefined;
  return { lastSuccessAt, domains: domains as SyncDomainSummary[] };
}
```

In `parseEnvelope`, widen the key set and add the two fields:

```ts
  if (!isRecord(value) || !hasExactKeys(value, [
    "profile", "onboardingEnabled", "connection", "syncEnabled", "sync",
  ])) return null;
  …
  const sync = parseSync(value.sync);
  if (
    …existing checks…
    || typeof value.syncEnabled !== "boolean"
    || sync === undefined
  ) return null;
  return { …, syncEnabled: value.syncEnabled, sync };
```

The handler, cloned from `retest` (same scoped-request/`perform` discipline, so
a deferred Org A call cannot land on Org B):

```ts
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

Add three keys under `m365CustomerGraphRead.actions` in **all eight** locale
files — `localeParity.test.ts` asserts an exact key match per locale, so a
missing one reds Test Web:

```json
"syncNow": "Sync now",
"syncFailed": "Tenant sync could not be requested.",
"syncSucceeded": "Tenant sync requested."
```

Translate for the seven non-`en` locales rather than copying English; keep the
repo's existing terminology (`apps/web/src/locales/TERMINOLOGY.md`).

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/web && npx vitest run src/components/integrations/M365CustomerGraphReadCard.test.tsx
cd apps/web && npx vitest run src/lib/i18n
```
Expected: PASS (the second run must include `localeParity` and `keyUsage`).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/integrations/M365CustomerGraphReadCard.tsx \
        apps/web/src/components/integrations/M365CustomerGraphReadCard.test.tsx \
        apps/web/src/locales/*/integrations.json
git commit -m "feat(m365): Sync now button on the Customer Graph Read card

Posts the on-demand sync through runAction, so a 429 from the limiter surfaces
as a toast instead of a silent no-op, and reuses the card's scoped-request
discipline so a deferred Org A call cannot land on Org B. Shown only when the
DTO reports syncEnabled and the connection is active or degraded.

The card's parseEnvelope uses hasExactKeys, so the two new DTO fields are a
required parser change: without it the whole card would fall to its unavailable
state the moment the API starts sending them.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 16: full verification and the pull request

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
that directory — if the count is smaller than the number of test files you
added plus W04's, a file is not being matched and a green run means nothing.

```bash
# Web card + i18n parity
cd apps/web && npx vitest run \
  src/components/integrations/M365CustomerGraphReadCard.test.tsx \
  src/lib/i18n
```

- [ ] **Step 2: Run the real-database suites**

```bash
cd apps/api && pnpm test:docker:up
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/m365SyncLinks.integration.test.ts
```

Expected: PASS with 9 tests **executed**. `it.runIf(!!process.env.DATABASE_URL)`
skips silently without a database, and an all-skipped file reports green.

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

- [ ] **Step 4: Merge main and re-verify**

PR CI tests the merge commit, not your branch tip, so a locally green branch on
a stale base still reds CI:

```bash
git fetch origin main && git merge origin/main
cd apps/api && npx vitest run src/services/m365Sync src/routes/m365CustomerGraphRead.test.ts
```

If W01, W02, W03 or W04 moved under you, reconcile against the code (it is the
authority) and note any contract delta in the PR body.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(m365): tenant sync W05 — enrichment, continuation, Secure Score, rollup, cadence, links, lifecycle, on-demand" --body "$(cat <<'BODY'
Wave 5 of the M365 tenant sync foundation. Finishes the sync worker W04 started.

Spec: `docs/superpowers/specs/integrations/2026-09-08-m365-tenant-sync-foundation-design.md` (§5.5–§5.9, §3.3, §6, §10)
Plan: `docs/superpowers/plans/integrations/2026-09-08-m365-tenant-sync-5-enrichment-lifecycle.md`

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
  returned continuation stores the opaque blob, leaves the state otherwise
  untouched, and re-claims at priority 10 for a new generation until exhausted.
- **Secure Score (§3.3).** Snapshots keyed on the UTC day of Graph's own
  `createdDateTime`, computed in SQL; two scores for one Graph day collapse
  newest-wins; the 90-day backfill is driven by the state row's
  `last_success_at IS NULL`, so no flag column exists.
- **Rollup (§5.9)** into `afterDomainPersisted`: one indexed read of the six
  `last_counts` plus one upsert, no COUNT queries. Counters no domain reported
  stay **NULL, not 0**.
- **Adaptive cadence (§5.7)** into `applyCadence`, with the domain bounds;
  `needs_consent` and connection auth failure unschedule.
- **Device links (§5.6).** Two data-modifying-CTE statements per Intune run,
  1:1 on both sides, ambiguity counted and skipped, hostname fallback, relink on
  mismatch — proven against real Postgres.
- **Lifecycle (§5.8).** Consent success (active **or** degraded) seeds all six
  domains at priority 1; disconnect erases state and the four entity tables in
  the caller's transaction and keeps the tenant-stamped history; upgrade-consent
  re-arms `needs_consent` domains.
- **On-demand (§5.2).** `POST /m365/connections/:id/sync`, MFA-gated like
  retest, Redis-limited to one per org per 15 min (429 + `Retry-After`), flag
  first so a disabled feature never burns a slot, sign-in excluded because its
  Graph budget is app-wide. Plus the `syncEnabled` / `sync` DTO fields and the
  card's "Sync now" button.

## Contract deviations (overview updated in this PR)

1. `runSyncDomain`'s return union gains `'partial-continue'`. `M365SyncOutcome`
   is unchanged — `m365_sync_status` is a shipped Postgres enum (W02) and spec
   §6 keeps the sync state "unchanged until exhausted", so the value is
   control-flow and metrics only and never reaches `last_status`.
2. `CadenceSignals` gains `unlicensed`, `authFailure` and `now`. Neither of the
   first two is derivable from the outcome (`unlicensed` *is* a success; an auth
   failure is an `error` like any other), and `now` makes the jitter testable.
3. Lifecycle hooks differ in DB-context posture on purpose:
   `onConnectionDisconnected` runs on the caller's ambient system context and
   **throws**; `onConnectionConsented` / `onConnectionUpgraded` open their own
   and **never throw**. Rationale in the plan's Decision 6.

## Coordination

- **W06:** this PR adds `syncEnabled` and `sync: { lastSuccessAt, domains[] }`
  to the read envelope and the "Sync now" button. W06 renders the "last synced"
  line from those fields — do not re-add them.
- **W01:** `onConnectionUpgraded` is wired from the identity-verification
  success branch keyed on `manifest_stale` being cleared. It is idempotent, so
  W01's dedicated upgrade-consent promotion branch can also call it without
  removing this call.

## Verification

- `apps/api`: `m365Sync`, `m365ControlPlane`, `routes/m365CustomerGraphRead`,
  `routes/m365ConsentCallback` unit suites.
- `apps/api` integration: `m365SyncLinks.integration.test.ts` (9 tests, real
  Postgres — confirmed executed, not skipped).
- `apps/web`: card suite + `localeParity` / `keyUsage` across all eight locales.
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

- [ ] **Step 6: Confirm CI actually ran**

```bash
gh pr checks --watch ; true
```

`gh pr checks` exits non-zero while checks are pending, so a `&&`/`|| continue`
poll loop never fires — parse the text, and do not trust a "green" that is
really "nothing ran". If this PR is stacked on a sibling branch rather than
`main`, `ci.yml`'s `pull_request: branches: [main]` trigger means **no CI runs
at all**; dispatch it explicitly with `gh workflow run CI --ref <branch>`.
