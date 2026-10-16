---
tracking_issue: LanternOps/breeze#8844
wave: W01 (#8845)
---

# Connection Health W1 — Incident Core + OAuth Grant Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Breeze automatically revokes an OAuth grant (refresh-token reuse or code replay) and the app never re-authorizes, the grant's owner and the partner's connected-app admins get an in-app notice within about 15 minutes. The notice clears itself when the app is re-authorized.

**Architecture:**
- A pure transition function maps `(observations, tracked incidents, now)` to actions.
- A store applies those actions to `connection_health_incidents` in one transaction per kind.
- A durable `pending_notice` column acts as an outbox. The notifier drains it after commit.
- A 15-minute BullMQ reconciler orchestrates the run: due kinds, a time budget, a failure streak with an ops alert, a heartbeat and retention.
- W1 registers exactly one source, `oauth_grant`.

**Tech Stack:** Hono, Drizzle (queries only), hand-written SQL migrations, BullMQ, ioredis, Vitest, React (one NotificationCenter entry).

**Spec:** `docs/superpowers/specs/integrations/2026-10-15-connection-health-notifications-design.md`. Read §1–§4 and §8 before starting.

## Global Constraints

- Migrations sort after the newest committed migration. Today that is `2026-12-28-130000-pam-reconciliation-reset-capability.sql`; **re-check at rebase**.
- Migrations are idempotent, have no inner `BEGIN/COMMIT`, and run `SELECT set_config('breeze.scope', 'system', true);` first.
- A new enum value gets its own migration file, because it can't be used in the transaction that adds it.
- Every composite FK to `organizations(id, partner_id)` is `ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE`, in SQL only (Drizzle can't express deferrable).
- The reconciler runs on pattern `2,17,32,47 * * * *` with stable jobId `connection-health-reconcile`, at concurrency 1, with placement `global`.
- Per kind it uses `statement_timeout` 5s via `tightenStatementTimeout`. The whole run has a 60s budget.
- Transient incidents open on the **second consecutive** broken observation. Permanent ones open immediately. Resolution takes **2 consecutive** healthy observations. The reopen window is **60 minutes**.
- OAuth: the only automatic reason is `refresh-token-reuse` with `revoked_by_user_id IS NULL` (amended in the final fix wave: `provider-revoke-grant` is also written by deliberate RP revocation and end_session; code-replay detection is deferred to W4). The lookback is **30 days**. Classification follows spec §3 **OAuth detail** (latest automatic revoke E; only grants created after E count).
- Notice dedupe keys are `connection-health:<incidentId>:<openedAtEpochMs>` and `connection-health:<incidentId>:<openedAtEpochMs>:permanent`.
- No customer, host or infrastructure names in code or docs (public repo).
- All writes to `connection_health_incidents` happen in system scope from the reconciler. The route is GET-only.

## Spec amendments made by this plan

Fold these into spec §2.1 in Task 3's commit:
- `owner_fix_href text NULL` holds the owner's link (`/account/connected-apps`), which differs from the admin `fix_href`.
- `pending_notice text NULL CHECK (pending_notice IN ('opened','escalated','resolved'))` is a durable outbox, so a crash between commit and notify can't lose a notice.
- `notified_user_ids uuid[] NOT NULL DEFAULT '{}'` lets resolution mark exactly those users' notices read through the `(user_id, dedupe_key)` index, instead of scanning `user_notifications`.
- **Deviation from spec §8:** the `/admin/system` heartbeat display moves to W2, alongside the panel. W1 writes the heartbeat key and alerts on failure streaks.

## Review Focus

1. **A user deletes the notice, then the reconciler runs again.** The notice must not reappear. Dedupe holds because the key is unchanged and `pending_notice` was already cleared. Test: Task 6 "does not recreate a deleted notice".
2. **Redis is down.** The reconciler must still run every kind and must never seed (seeding would silently suppress notices). Test: Task 8 "treats every kind as due and never seeds without Redis".
3. **An `observe()` throws mid-run.** That kind's incidents must stay unchanged, and other kinds must still run. Test: Task 8 "a failing source leaves its incidents untouched and others still run".
4. **A hostile DCR `client_name`** (500 chars, control characters, markup) ends up in the notice title. It must be capped at 80 characters with control characters stripped. Test: Task 7 "caps and cleans client_name".
5. **The owner re-authorizes, then the new grant is revoked by the user.** The incident should resolve, and not reopen as broken, because a user revocation is deliberate. Test: Task 7 "user revocation after re-consent retires".

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/constants/notificationTypes.ts` | add `'integration'` |
| `apps/api/migrations/2026-12-29-100000-integration-notification-type.sql` | enum value |
| `apps/api/migrations/2026-12-29-100100-connection-health-incidents.sql` | table, indexes, RLS, grants, OAuth partial index |
| `apps/api/src/db/schema/connectionHealth.ts` | Drizzle model |
| `apps/api/src/services/connectionHealth/types.ts` | `HealthObservation`, `HealthSource`, `TrackedIncident`, `TransitionAction` |
| `apps/api/src/services/connectionHealth/transitions.ts` | pure `planTransitions()` |
| `apps/api/src/services/connectionHealth/store.ts` | `loadTracked()`, `applyActions()`, `deleteExpiredResolved()` |
| `apps/api/src/services/connectionHealth/recipients.ts` | `resolveIncidentRecipients()` |
| `apps/api/src/services/connectionHealth/notifier.ts` | `deliverPendingNotices()` |
| `apps/api/src/services/connectionHealth/sources/oauthGrant.ts` | OAuth source |
| `apps/api/src/services/connectionHealth/sources/index.ts` | `HEALTH_SOURCES` registry |
| `apps/api/src/services/connectionHealth/reconcile.ts` | `runReconcile()` orchestrator |
| `apps/api/src/jobs/connectionHealthReconcile.ts` | BullMQ queue and worker |
| `apps/api/src/routes/connectionHealth.ts` | `GET /connection-health/incidents` |
| `apps/api/src/services/usersWithPermission.ts` | add `resolvePartnerUsersWithPermission()` |
| `apps/api/src/services/userNotifications.ts` | `orgId` nullable; add `markNotificationsReadByDedupeKeys()` |
| `apps/web/src/components/layout/NotificationCenter.tsx` | `integration` type config and fallback |
| Registries | `tenantCascade.ts`, `orgMergeRegistry.ts`, `tenantExportPolicyRegistry.ts`, `rls-coverage.integration.test.ts`, `workerRegistry.ts` (+ `workerRegistry.test.ts`, `workerEntrypointClosure.contract.test.ts`), `workerReadinessManifest.ts`, `db/schema/index.ts`, `index.ts` (mount) |

---

### Task 1: `integration` notification type and nullable notice org

**Files:**
- Modify: `packages/shared/src/constants/notificationTypes.ts`
- Create: `apps/api/migrations/2026-12-29-100000-integration-notification-type.sql`
- Modify: `apps/api/src/services/userNotifications.ts:10-37` (input type), plus a new export
- Modify: `apps/web/src/components/layout/NotificationCenter.tsx:103` (type config) and the `buildHref` switch (`:154-193`)
- Test: `apps/api/src/services/userNotifications.test.ts`; `apps/api/src/__tests__/integration/userNotificationsRls.integration.test.ts`

**Interfaces:**
- Produces:
  - `NotificationType` now includes `'integration'`.
  - `CreateNotificationInput.orgId: string | null`.
  - `markNotificationsReadByDedupeKeys(userIds: readonly string[], dedupeKeys: readonly string[]): Promise<number>`, which must run in system scope and returns the number of rows updated.

- [ ] **Step 1: Write the failing tests**

In `userNotifications.test.ts`, add a test asserting that `createNotification({ userId, orgId: null, type: 'integration', title: 't' })` type-checks and passes `orgId: null` to the insert. Mirror the file's existing db mock.

```ts
it('accepts a partner-wide notice with no org (connection health)', async () => {
  await createNotification({ userId: USER_ID, orgId: null, type: 'integration', title: 'Huntress sync failing' });
  expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: null, type: 'integration' }));
});
```

In `userNotificationsRls.integration.test.ts`, add:

```ts
it('markNotificationsReadByDedupeKeys marks only the named users and keys', async () => {
  await withSystemDbAccessContext(async () => {
    await createNotification({ userId: userA, orgId: null, type: 'integration', title: 'x', dedupeKey: 'connection-health:i1:1' });
    await createNotification({ userId: userB, orgId: null, type: 'integration', title: 'x', dedupeKey: 'connection-health:i1:1' });
    await createNotification({ userId: userA, orgId: null, type: 'integration', title: 'y', dedupeKey: 'connection-health:i2:1' });
    const n = await markNotificationsReadByDedupeKeys([userA], ['connection-health:i1:1']);
    expect(n).toBe(1);
    const rows = await db.select().from(userNotifications).where(inArray(userNotifications.userId, [userA, userB]));
    const read = rows.filter((r) => r.read).map((r) => `${r.userId}:${r.dedupeKey}`);
    expect(read).toEqual([`${userA}:connection-health:i1:1`]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/services/userNotifications.test.ts`
Expected: FAIL with a type error that `'integration'` is not assignable, or that `null` is not assignable to `string`.

- [ ] **Step 3: Implement**

`packages/shared/src/constants/notificationTypes.ts`: append `'integration'` after `'billing'`.

`apps/api/migrations/2026-12-29-100000-integration-notification-type.sql`:

```sql
-- Its own migration: a new enum value cannot be used in the transaction that
-- adds it, and autoMigrate wraps each file in a transaction.
SELECT set_config('breeze.scope', 'system', true);
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'integration';
```

`userNotifications.ts`: change `orgId: string;` to:

```ts
  /**
   * Org the notice is about. NULL for partner-wide notices (connection health
   * for partner-owned connectors); RLS allows `org_id IS NULL` rows to their
   * own user only.
   */
  orgId: string | null;
```

Then add:

```ts
/**
 * Mark specific (user, dedupe key) notices read. Index-backed by
 * user_notifications_user_dedupe_key_uq; never scans by key alone. Caller
 * supplies a system context (same contract as createNotification).
 */
export async function markNotificationsReadByDedupeKeys(
  userIds: readonly string[],
  dedupeKeys: readonly string[],
): Promise<number> {
  if (userIds.length === 0 || dedupeKeys.length === 0) return 0;
  const rows = await db
    .update(userNotifications)
    .set({ read: true, readAt: new Date() })
    .where(and(
      inArray(userNotifications.userId, [...userIds]),
      inArray(userNotifications.dedupeKey, [...dedupeKeys]),
      eq(userNotifications.read, false),
    ))
    .returning({ id: userNotifications.id });
  return rows.length;
}
```

Add `and, eq, inArray` to the drizzle import if they're missing.

`NotificationCenter.tsx`: add `Plug` to the lucide import, then add this config entry after `billing`:

```ts
  integration: {
    label: 'nav.integrations',
    icon: Plug,
    className: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
  },
```

Add this case to `buildHref` before `'system'`:

```ts
    case 'integration':
      return '/integrations';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/userNotifications.test.ts && cd ../web && npx vitest run src/components/layout`
Expected: PASS. The integration test runs in Task 10 with the stack up.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/constants/notificationTypes.ts apps/api/migrations/2026-12-29-100000-integration-notification-type.sql apps/api/src/services/userNotifications.ts apps/api/src/services/userNotifications.test.ts apps/api/src/__tests__/integration/userNotificationsRls.integration.test.ts apps/web/src/components/layout/NotificationCenter.tsx
git commit -m "feat(notifications): integration notification type, partner-wide notices, mark-read by key (#8845)"
```

---

### Task 2: Types and the pure transition function

**Files:**
- Create: `apps/api/src/services/connectionHealth/types.ts`
- Create: `apps/api/src/services/connectionHealth/transitions.ts`
- Test: `apps/api/src/services/connectionHealth/transitions.test.ts`

**Interfaces:**
- Produces (exact):

```ts
// types.ts
import type { Permission } from '../permissions';

export const CONNECTION_SOURCE_KINDS = ['oauth_grant'] as const;   // W2+ appends
export type ConnectionSourceKind = (typeof CONNECTION_SOURCE_KINDS)[number];
export type HealthState = 'healthy' | 'broken' | 'unknown' | 'retired';
export type HealthSeverity = 'permanent' | 'transient';

export type HealthObservation = {
  sourceKind: ConnectionSourceKind;
  sourceId: string;
  partnerId: string;
  orgId: string | null;
  ownerUserId: string | null;
  state: HealthState;
  severity: HealthSeverity;
  condition: string;
  detail: string | null;
  displayName: string;
  fixHref: string;
  ownerFixHref: string | null;
  viewPermission: Permission;
  repairPermission: Permission;
  observedAt: Date;
};

export interface HealthSource {
  kind: ConnectionSourceKind;
  intervalMinutes: number;
  observe(now: Date, trackedSourceIds: readonly string[]): Promise<HealthObservation[]>;
}

/** An incident row as the reconciler sees it: open, pending (openedAt null), or resolved within the reopen window. */
export type TrackedIncident = {
  id: string;
  sourceId: string;
  severity: HealthSeverity;
  openedAt: Date | null;
  resolvedAt: Date | null;
  healthyStreak: number;
};

export type PendingNotice = 'opened' | 'escalated' | 'resolved';

export type TransitionAction =
  | { type: 'insertPending'; obs: HealthObservation }
  | { type: 'insertOpen'; obs: HealthObservation; notify: boolean }
  | { type: 'promotePending'; incidentId: string; obs: HealthObservation; notify: boolean }
  | { type: 'update'; incidentId: string; obs: HealthObservation; escalated: boolean }
  | { type: 'healthyTick'; incidentId: string; healthyStreak: number }
  | { type: 'resolve'; incidentId: string; resolution: 'recovered' | 'retired' }
  | { type: 'reopen'; incidentId: string; obs: HealthObservation }
  | { type: 'deletePending'; incidentId: string };

export const REOPEN_WINDOW_MS = 60 * 60 * 1000;
export const HEALTHY_TO_RESOLVE = 2;
```

```ts
// transitions.ts
export function planTransitions(input: {
  observations: readonly HealthObservation[];
  tracked: readonly TrackedIncident[];
  now: Date;
  seed: boolean;              // first run for this kind: open without notifying
}): TransitionAction[];
```

- [ ] **Step 1: Write the failing tests**

`transitions.test.ts` is table-driven. Every row of spec §1.2 gets a test.

```ts
import { describe, expect, it } from 'vitest';
import { planTransitions } from './transitions';
import type { HealthObservation, TrackedIncident } from './types';

const NOW = new Date('2026-10-15T12:00:00Z');
const obs = (over: Partial<HealthObservation> = {}): HealthObservation => ({
  sourceKind: 'oauth_grant', sourceId: 's1', partnerId: 'p1', orgId: null, ownerUserId: null,
  state: 'broken', severity: 'transient', condition: 'sync_failed', detail: null,
  displayName: 'X', fixHref: '/integrations', ownerFixHref: null,
  viewPermission: { resource: 'connected_apps', action: 'read' },
  repairPermission: { resource: 'connected_apps', action: 'manage' },
  observedAt: NOW, ...over,
});
const open = (over: Partial<TrackedIncident> = {}): TrackedIncident => ({
  id: 'i1', sourceId: 's1', severity: 'transient', openedAt: new Date('2026-10-15T10:00:00Z'),
  resolvedAt: null, healthyStreak: 0, ...over,
});
const plan = (o: HealthObservation[], t: TrackedIncident[], seed = false) =>
  planTransitions({ observations: o, tracked: t, now: NOW, seed });

describe('planTransitions', () => {
  it('opens a permanent failure immediately and notifies', () => {
    expect(plan([obs({ severity: 'permanent' })], [])).toEqual([
      { type: 'insertOpen', obs: obs({ severity: 'permanent' }), notify: true },
    ]);
  });
  it('records a first transient failure as pending only', () => {
    expect(plan([obs()], [])).toEqual([{ type: 'insertPending', obs: obs() }]);
  });
  it('promotes a pending transient on the second consecutive broken observation', () => {
    expect(plan([obs()], [open({ openedAt: null })])).toEqual([
      { type: 'promotePending', incidentId: 'i1', obs: obs(), notify: true },
    ]);
  });
  it('deletes a pending row when the connection is healthy', () => {
    expect(plan([obs({ state: 'healthy' })], [open({ openedAt: null })])).toEqual([
      { type: 'deletePending', incidentId: 'i1' },
    ]);
  });
  it('updates an open incident and flags escalation transient→permanent', () => {
    expect(plan([obs({ severity: 'permanent' })], [open()])).toEqual([
      { type: 'update', incidentId: 'i1', obs: obs({ severity: 'permanent' }), escalated: true },
    ]);
  });
  it('does not flag escalation for permanent→permanent', () => {
    expect(plan([obs({ severity: 'permanent' })], [open({ severity: 'permanent' })])[0])
      .toMatchObject({ type: 'update', escalated: false });
  });
  it('needs two consecutive healthy observations to resolve', () => {
    expect(plan([obs({ state: 'healthy' })], [open()])).toEqual([
      { type: 'healthyTick', incidentId: 'i1', healthyStreak: 1 },
    ]);
    expect(plan([obs({ state: 'healthy' })], [open({ healthyStreak: 1 })])).toEqual([
      { type: 'resolve', incidentId: 'i1', resolution: 'recovered' },
    ]);
  });
  it('a broken observation after one healthy tick resets the streak via update', () => {
    expect(plan([obs()], [open({ healthyStreak: 1 })])[0]).toMatchObject({ type: 'update', incidentId: 'i1' });
  });
  it('unknown never opens, resolves or ticks', () => {
    expect(plan([obs({ state: 'unknown' })], [])).toEqual([]);
    expect(plan([obs({ state: 'unknown' })], [open({ healthyStreak: 1 })])).toEqual([]);
    expect(plan([obs({ state: 'unknown' })], [open({ openedAt: null })])).toEqual([]);
  });
  it('retired resolves an open incident as retired and deletes a pending one', () => {
    expect(plan([obs({ state: 'retired' })], [open()])).toEqual([{ type: 'resolve', incidentId: 'i1', resolution: 'retired' }]);
    expect(plan([obs({ state: 'retired' })], [open({ openedAt: null })])).toEqual([{ type: 'deletePending', incidentId: 'i1' }]);
  });
  it('a tracked open id missing from the observations is retired', () => {
    expect(plan([], [open()])).toEqual([{ type: 'resolve', incidentId: 'i1', resolution: 'retired' }]);
  });
  it('reopens an incident resolved inside the 60-minute window instead of creating one', () => {
    const resolved = open({ resolvedAt: new Date('2026-10-15T11:30:00Z') });
    expect(plan([obs()], [resolved])).toEqual([{ type: 'reopen', incidentId: 'i1', obs: obs() }]);
  });
  it('ignores a recently resolved incident that stays healthy or is missing', () => {
    const resolved = open({ resolvedAt: new Date('2026-10-15T11:30:00Z') });
    expect(plan([obs({ state: 'healthy' })], [resolved])).toEqual([]);
    expect(plan([], [resolved])).toEqual([]);
  });
  it('seed mode opens without notifying, even for transient failures', () => {
    expect(plan([obs()], [], true)).toEqual([{ type: 'insertOpen', obs: obs(), notify: false }]);
    expect(plan([obs({ severity: 'permanent' })], [], true)).toEqual([
      { type: 'insertOpen', obs: obs({ severity: 'permanent' }), notify: false },
    ]);
  });
  it('a healthy observation with nothing tracked produces nothing', () => {
    expect(plan([obs({ state: 'healthy' })], [])).toEqual([]);
  });
  it('rejects duplicate observations for one source id', () => {
    expect(() => plan([obs(), obs()], [])).toThrow(/duplicate observation/i);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/connectionHealth/transitions.test.ts`
Expected: FAIL with `Cannot find module './transitions'`.

- [ ] **Step 3: Implement**

Write `types.ts` exactly as in Interfaces. Then `transitions.ts`:

```ts
import {
  HEALTHY_TO_RESOLVE, REOPEN_WINDOW_MS,
  type HealthObservation, type TrackedIncident, type TransitionAction,
} from './types';

/**
 * Spec §1.2 state machine, pure. One incident per (source_kind, source_id):
 * `tracked` holds that kind's open, pending (openedAt null) and
 * recently-resolved rows. Order of the result follows `tracked`, then new
 * observations, so tests and logs are deterministic.
 */
export function planTransitions(input: {
  observations: readonly HealthObservation[];
  tracked: readonly TrackedIncident[];
  now: Date;
  seed: boolean;
}): TransitionAction[] {
  const { observations, tracked, now, seed } = input;
  const bySource = new Map<string, HealthObservation>();
  for (const o of observations) {
    if (bySource.has(o.sourceId)) throw new Error(`duplicate observation for ${o.sourceKind}:${o.sourceId}`);
    bySource.set(o.sourceId, o);
  }

  const actions: TransitionAction[] = [];
  const handled = new Set<string>();

  for (const t of tracked) {
    handled.add(t.sourceId);
    const o = bySource.get(t.sourceId);

    if (t.resolvedAt) {
      // Recently resolved: only a broken observation inside the window matters.
      if (o?.state === 'broken' && now.getTime() - t.resolvedAt.getTime() <= REOPEN_WINDOW_MS) {
        actions.push({ type: 'reopen', incidentId: t.id, obs: o });
      }
      continue;
    }

    const pending = t.openedAt === null;
    if (!o || o.state === 'retired') {
      actions.push(pending
        ? { type: 'deletePending', incidentId: t.id }
        : { type: 'resolve', incidentId: t.id, resolution: 'retired' });
      continue;
    }
    if (o.state === 'unknown') continue;
    if (o.state === 'healthy') {
      if (pending) {
        actions.push({ type: 'deletePending', incidentId: t.id });
      } else if (t.healthyStreak + 1 >= HEALTHY_TO_RESOLVE) {
        actions.push({ type: 'resolve', incidentId: t.id, resolution: 'recovered' });
      } else {
        actions.push({ type: 'healthyTick', incidentId: t.id, healthyStreak: t.healthyStreak + 1 });
      }
      continue;
    }
    // broken
    if (pending) {
      actions.push({ type: 'promotePending', incidentId: t.id, obs: o, notify: !seed });
    } else {
      actions.push({
        type: 'update', incidentId: t.id, obs: o,
        escalated: t.severity === 'transient' && o.severity === 'permanent',
      });
    }
  }

  for (const o of observations) {
    if (handled.has(o.sourceId) || o.state !== 'broken') continue;
    if (seed || o.severity === 'permanent') {
      actions.push({ type: 'insertOpen', obs: o, notify: !seed });
    } else {
      actions.push({ type: 'insertPending', obs: o });
    }
  }
  return actions;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx vitest run src/services/connectionHealth/transitions.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/connectionHealth/types.ts apps/api/src/services/connectionHealth/transitions.ts apps/api/src/services/connectionHealth/transitions.test.ts
git commit -m "feat(connection-health): health-source contract and pure incident state machine (#8845)"
```

---

### Task 3: Incidents table, RLS and every registration

**Files:**
- Create: `apps/api/migrations/2026-12-29-100100-connection-health-incidents.sql`
- Create: `apps/api/src/db/schema/connectionHealth.ts`; modify `apps/api/src/db/schema/index.ts` (add `export * from './connectionHealth';`)
- Modify: `apps/api/src/services/tenantCascade.ts:255` list (alphabetical: after `'configuration_…'`, before `'contacts…'`; find the right spot by grep)
- Modify: `apps/api/src/services/orgMergeRegistry.ts:767` `REPOINT_TABLES` (alphabetical)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:51` (alphabetical)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:486` `DUAL_AXIS_TENANT_TABLES`
- Modify: spec §2.1 (the amendments listed above)
- Test: `apps/api/src/__tests__/integration/connectionHealthIncidentsRls.integration.test.ts`

**Interfaces:**
- Produces: Drizzle `connectionHealthIncidents` with camelCase fields matching the columns below. The partial unique index is named `connection_health_incidents_open_uniq`.

- [ ] **Step 1: Write the failing integration test**

`connectionHealthIncidentsRls.integration.test.ts`: copy the setup helpers (partner/org/user creation, `withDbAccessContext` builders) from `notificationRailsPartnerRls.integration.test.ts`.

```ts
describe('connection_health_incidents RLS', () => {
  // Seed: partner P with orgs A and B; partner Q with org C.
  // Incidents (inserted in system scope): iA (org A), iB (org B), iP (partner-wide, P), iC (org C).
  it('partner-scope full access sees its org and partner-wide incidents only', async () => {
    const ids = await asPartner(P, { orgAccess: 'all', orgIds: [A, B] }, () => selectIncidentIds());
    expect(ids.sort()).toEqual([iA, iB, iP].sort());
  });
  it('partner user with selected access to A does not see B', async () => {
    const ids = await asPartner(P, { orgAccess: 'selected', orgIds: [A] }, () => selectIncidentIds());
    expect(ids).toContain(iA);
    expect(ids).not.toContain(iB);
  });
  it('org-scope token never sees partner-wide rows', async () => {
    const ids = await asOrg(A, () => selectIncidentIds());
    expect(ids).toEqual([iA]);
  });
  it('a forged cross-tenant insert fails RLS', async () => {
    await expect(asPartner(P, { orgAccess: 'all', orgIds: [A, B] }, () => insertIncident({ partnerId: Q, orgId: C })))
      .rejects.toThrow(/row-level security/);
  });
  it('an org whose partner does not match is rejected by the composite FK', async () => {
    await expect(asSystem(() => insertIncident({ partnerId: P, orgId: C }))).rejects.toThrow(/connection_health_incidents_org_partner_fk/);
  });
  it('only one open row per source', async () => {
    await asSystem(() => insertIncident({ partnerId: P, orgId: A, sourceKind: 'oauth_grant', sourceId: 'dup' }));
    await expect(asSystem(() => insertIncident({ partnerId: P, orgId: A, sourceKind: 'oauth_grant', sourceId: 'dup' })))
      .rejects.toThrow(/connection_health_incidents_open_uniq/);
  });
  it('deleting org A cascades its incidents and leaves partner-wide rows', async () => {
    await asSystem(() => db.execute(sql`DELETE FROM organizations WHERE id = ${A}`));
    const ids = await asSystem(() => selectIncidentIds());
    expect(ids).not.toContain(iA);
    expect(ids).toContain(iP);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test-stack up && cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/connectionHealthIncidentsRls.integration.test.ts`
Expected: FAIL with `relation "connection_health_incidents" does not exist`.

- [ ] **Step 3: Write the migration**

`2026-12-29-100100-connection-health-incidents.sql`:

```sql
-- Connection health incidents (spec 2026-10-15 §2.1). Dual-axis (shape 4):
-- partner_id NOT NULL, org_id NULL only for partner-owned connections.
-- Written only by the reconciler in system scope; the API route is GET-only.
SELECT set_config('breeze.scope', 'system', true);

CREATE TABLE IF NOT EXISTS public.connection_health_incidents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id        uuid NOT NULL REFERENCES public.partners(id) ON DELETE CASCADE,
  org_id            uuid NULL,
  owner_user_id     uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
  source_kind       text NOT NULL,
  source_id         text NOT NULL,
  condition         text NOT NULL,
  severity          text NOT NULL CHECK (severity IN ('permanent','transient')),
  detail            text NULL CHECK (char_length(detail) <= 300),
  display_name      text NOT NULL CHECK (char_length(display_name) <= 120),
  fix_href          text NOT NULL CHECK (fix_href LIKE '/%' AND fix_href NOT LIKE '//%'),
  owner_fix_href    text NULL CHECK (owner_fix_href IS NULL OR (owner_fix_href LIKE '/%' AND owner_fix_href NOT LIKE '//%')),
  view_permission   text NOT NULL,
  repair_permission text NOT NULL,
  first_failed_at   timestamptz NOT NULL,
  opened_at         timestamptz NULL,
  last_observed_at  timestamptz NOT NULL,
  healthy_streak    smallint NOT NULL DEFAULT 0,
  flap_count        integer NOT NULL DEFAULT 0,
  resolved_at       timestamptz NULL,
  resolution        text NULL CHECK (resolution IN ('recovered','retired')),
  pending_notice    text NULL CHECK (pending_notice IN ('opened','escalated','resolved')),
  notified_user_ids uuid[] NOT NULL DEFAULT '{}',
  CONSTRAINT connection_health_incidents_resolution_chk
    CHECK ((resolved_at IS NULL) = (resolution IS NULL))
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'connection_health_incidents_org_partner_fk') THEN
    ALTER TABLE public.connection_health_incidents
      ADD CONSTRAINT connection_health_incidents_org_partner_fk
      FOREIGN KEY (org_id, partner_id) REFERENCES public.organizations(id, partner_id)
      ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS connection_health_incidents_open_uniq
  ON public.connection_health_incidents (source_kind, source_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS connection_health_incidents_partner_open_idx
  ON public.connection_health_incidents (partner_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS connection_health_incidents_kind_resolved_idx
  ON public.connection_health_incidents (source_kind, resolved_at) WHERE resolved_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS connection_health_incidents_pending_notice_idx
  ON public.connection_health_incidents (id) WHERE pending_notice IS NOT NULL;
CREATE INDEX IF NOT EXISTS connection_health_incidents_org_idx
  ON public.connection_health_incidents (org_id) WHERE org_id IS NOT NULL;

ALTER TABLE public.connection_health_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connection_health_incidents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS connection_health_incidents_isolation ON public.connection_health_incidents;
CREATE POLICY connection_health_incidents_isolation ON public.connection_health_incidents
  FOR ALL
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (org_id IS NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (org_id IS NULL AND public.breeze_has_partner_access(partner_id))
  );

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.connection_health_incidents TO breeze_app;
  END IF;
END $$;

-- OAuth source (W1): automatically revoked grants, newest first. Keeps the
-- broken-set query index-backed (spec §1.3) as oauth_grants grows.
CREATE INDEX IF NOT EXISTS oauth_grants_auto_revoked_idx
  ON public.oauth_grants (revoked_at)
  WHERE revoked_reason = 'refresh-token-reuse' AND revoked_by_user_id IS NULL;
```

- [ ] **Step 4: Drizzle model**

`apps/api/src/db/schema/connectionHealth.ts`:

```ts
import { index, integer, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { partners, organizations } from './orgs';
import { users } from './users';

// Composite FK (org_id, partner_id) → organizations(id, partner_id) is
// DEFERRABLE INITIALLY IMMEDIATE and lives in the migration only: drizzle's
// foreignKey() builder has no deferrable option.
export const connectionHealthIncidents = pgTable('connection_health_incidents', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id'),
  ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
  sourceKind: text('source_kind').notNull(),
  sourceId: text('source_id').notNull(),
  condition: text('condition').notNull(),
  severity: text('severity').notNull(),
  detail: text('detail'),
  displayName: text('display_name').notNull(),
  fixHref: text('fix_href').notNull(),
  ownerFixHref: text('owner_fix_href'),
  viewPermission: text('view_permission').notNull(),
  repairPermission: text('repair_permission').notNull(),
  firstFailedAt: timestamp('first_failed_at', { withTimezone: true }).notNull(),
  openedAt: timestamp('opened_at', { withTimezone: true }),
  lastObservedAt: timestamp('last_observed_at', { withTimezone: true }).notNull(),
  healthyStreak: smallint('healthy_streak').notNull().default(0),
  flapCount: integer('flap_count').notNull().default(0),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolution: text('resolution'),
  pendingNotice: text('pending_notice'),
  notifiedUserIds: uuid('notified_user_ids').array().notNull().default(sql`'{}'::uuid[]`),
}, (t) => ({
  openUniq: uniqueIndex('connection_health_incidents_open_uniq').on(t.sourceKind, t.sourceId).where(sql`${t.resolvedAt} IS NULL`),
  partnerOpenIdx: index('connection_health_incidents_partner_open_idx').on(t.partnerId).where(sql`${t.resolvedAt} IS NULL`),
  kindResolvedIdx: index('connection_health_incidents_kind_resolved_idx').on(t.sourceKind, t.resolvedAt).where(sql`${t.resolvedAt} IS NOT NULL`),
  pendingNoticeIdx: index('connection_health_incidents_pending_notice_idx').on(t.id).where(sql`${t.pendingNotice} IS NOT NULL`),
  orgIdx: index('connection_health_incidents_org_idx').on(t.orgId).where(sql`${t.orgId} IS NOT NULL`),
}));
```

Check how `partners` and `organizations` are imported in neighbouring schema files (`grep -n "import.*partners" apps/api/src/db/schema/backupProviders.ts`) and match that. Add the `oauth_grants_auto_revoked_idx` index to `oauthGrants` in `db/schema/oauth.ts` with the same `where`, so `db:check-drift` stays clean.

- [ ] **Step 5: Register everywhere**

- `tenantCascade.ts`: insert `'connection_health_incidents',` in alphabetical position.
- `orgMergeRegistry.ts` `REPOINT_TABLES`, alphabetical, with this comment:

```ts
  // Partner-wide rows (org_id NULL) never match the `WHERE org_id = <loser>`
  // repoint. A connection the merge deduplicates disappears from its source,
  // and the next reconcile retires the incident (spec §2.1).
  "connection_health_incidents",
```

- `tenantExportPolicyRegistry.ts`, alphabetical:

```ts
  "connection_health_incidents": tablePolicy("org_id", {"included":["id","partner_id","org_id","owner_user_id","source_kind","source_id","condition","severity","display_name","fix_href","owner_fix_href","view_permission","repair_permission","first_failed_at","opened_at","last_observed_at","healthy_streak","flap_count","resolved_at","resolution","pending_notice","notified_user_ids"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["detail"]}),
```

- `rls-coverage.integration.test.ts` `DUAL_AXIS_TENANT_TABLES`: add `'connection_health_incidents',` next to `'users'`.
- Spec §2.1: add the three columns from "Spec amendments" to the DDL block, and add one sentence on each.

- [ ] **Step 6: Run the tests and contract suites**

Run:
```bash
cd apps/api
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/connectionHealthIncidentsRls.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
npx vitest run src/services/orgMerge.test.ts
pnpm db:check-drift
```
Expected: all PASS; drift clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-12-29-100100-connection-health-incidents.sql apps/api/src/db/schema/connectionHealth.ts apps/api/src/db/schema/index.ts apps/api/src/db/schema/oauth.ts apps/api/src/services/tenantCascade.ts apps/api/src/services/orgMergeRegistry.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/__tests__/integration/connectionHealthIncidentsRls.integration.test.ts docs/superpowers/specs/integrations/2026-10-15-connection-health-notifications-design.md
git commit -m "feat(connection-health): incidents table with dual-axis RLS and tenancy registrations (#8845)"
```

---

### Task 4: Incident store

**Files:**
- Create: `apps/api/src/services/connectionHealth/store.ts`
- Test: `apps/api/src/__tests__/integration/connectionHealthStore.integration.test.ts`

**Interfaces:**
- Consumes: `TransitionAction`, `TrackedIncident`, `ConnectionSourceKind`, `REOPEN_WINDOW_MS` (Task 2); `connectionHealthIncidents` (Task 3).
- Produces (all run inside the caller's system context):
  - `loadTracked(kind: ConnectionSourceKind, now: Date): Promise<TrackedIncident[]>`
  - `applyActions(actions: readonly TransitionAction[], now: Date): Promise<{ opened: number; resolved: number; pending: number }>`
  - `deleteExpiredResolved(now: Date, limit?: number): Promise<number>` deletes resolved rows older than 90 days, default limit 1000.
  - `permissionToText(p: Permission): string` returns `'resource:action'`; `permissionFromText(s: string): Permission`.

- [ ] **Step 1: Write the failing integration test**

```ts
describe('connection health store', () => {
  it('insertOpen with notify sets opened_at and pending_notice=opened', async () => {
    await asSystem(() => applyActions([{ type: 'insertOpen', obs: obs(), notify: true }], NOW));
    const [row] = await asSystem(() => db.select().from(connectionHealthIncidents));
    expect(row).toMatchObject({ openedAt: NOW, pendingNotice: 'opened', firstFailedAt: NOW, repairPermission: 'connected_apps:manage' });
  });
  it('insertOpen in seed mode leaves pending_notice null', async () => {
    await asSystem(() => applyActions([{ type: 'insertOpen', obs: obs(), notify: false }], NOW));
    expect((await asSystem(() => db.select().from(connectionHealthIncidents)))[0]!.pendingNotice).toBeNull();
  });
  it('promotePending keeps first_failed_at from the pending row', async () => {
    await asSystem(() => applyActions([{ type: 'insertPending', obs: obs() }], EARLIER));
    const [p] = await asSystem(() => loadTracked('oauth_grant', NOW));
    await asSystem(() => applyActions([{ type: 'promotePending', incidentId: p!.id, obs: obs(), notify: true }], NOW));
    const [row] = await asSystem(() => db.select().from(connectionHealthIncidents));
    expect(row).toMatchObject({ firstFailedAt: EARLIER, openedAt: NOW, pendingNotice: 'opened' });
  });
  it('update resets healthy_streak and escalation sets pending_notice=escalated', async () => {
    await asSystem(() => applyActions([{ type: 'insertOpen', obs: obs(), notify: false }], EARLIER));
    const [t] = await asSystem(() => loadTracked('oauth_grant', NOW));
    await asSystem(() => applyActions([{ type: 'healthyTick', incidentId: t!.id, healthyStreak: 1 }], NOW));
    await asSystem(() => applyActions([{ type: 'update', incidentId: t!.id, obs: obs({ severity: 'permanent' }), escalated: true }], NOW));
    const [row] = await asSystem(() => db.select().from(connectionHealthIncidents));
    expect(row).toMatchObject({ healthyStreak: 0, severity: 'permanent', pendingNotice: 'escalated' });
  });
  it('resolve sets resolution and pending_notice=resolved only if anyone was notified', async () => {
    await asSystem(() => applyActions([{ type: 'insertOpen', obs: obs({ sourceId: 'a' }), notify: false }, { type: 'insertOpen', obs: obs({ sourceId: 'b' }), notify: false }], EARLIER));
    await asSystem(() => db.update(connectionHealthIncidents).set({ notifiedUserIds: [USER_A] }).where(eq(connectionHealthIncidents.sourceId, 'b')));
    const tracked = await asSystem(() => loadTracked('oauth_grant', NOW));
    await asSystem(() => applyActions(tracked.map((t) => ({ type: 'resolve' as const, incidentId: t.id, resolution: 'recovered' as const })), NOW));
    const rows = await asSystem(() => db.select().from(connectionHealthIncidents));
    expect(Object.fromEntries(rows.map((r) => [r.sourceId, [r.resolution, r.pendingNotice]])))
      .toEqual({ a: ['recovered', null], b: ['recovered', 'resolved'] });
  });
  it('reopen clears resolved_at, bumps flap_count, sets opened_at=now and pending_notice=opened', async () => {
    await asSystem(() => applyActions([{ type: 'insertOpen', obs: obs(), notify: false }], EARLIER));
    const [t] = await asSystem(() => loadTracked('oauth_grant', NOW));
    await asSystem(() => applyActions([{ type: 'resolve', incidentId: t!.id, resolution: 'recovered' }], EARLIER));
    await asSystem(() => applyActions([{ type: 'reopen', incidentId: t!.id, obs: obs() }], NOW));
    const [row] = await asSystem(() => db.select().from(connectionHealthIncidents));
    expect(row).toMatchObject({ resolvedAt: null, resolution: null, flapCount: 1, openedAt: NOW, pendingNotice: 'opened' });
  });
  it('loadTracked returns open, pending and recently-resolved-recovered rows only', async () => {
    await asSystem(async () => {
      await insertRow({ sourceId: 'open', openedAt: EARLIER });
      await insertRow({ sourceId: 'pending', openedAt: null });
      await insertRow({ sourceId: 'recent', openedAt: EARLIER, resolvedAt: minutesBefore(NOW, 30), resolution: 'recovered' });
      await insertRow({ sourceId: 'old', openedAt: EARLIER, resolvedAt: minutesBefore(NOW, 120), resolution: 'recovered' });
      await insertRow({ sourceId: 'retired', openedAt: EARLIER, resolvedAt: minutesBefore(NOW, 30), resolution: 'retired' });
    });
    const ids = (await asSystem(() => loadTracked('oauth_grant', NOW))).map((t) => t.sourceId).sort();
    expect(ids).toEqual(['open', 'pending', 'recent']);
  });
  it('deleteExpiredResolved removes only resolved rows older than 90 days, bounded by limit', async () => {
    await asSystem(async () => {
      for (const id of ['x1', 'x2', 'x3']) await insertRow({ sourceId: id, openedAt: daysBefore(NOW, 100), resolvedAt: daysBefore(NOW, 91), resolution: 'recovered' });
      await insertRow({ sourceId: 'keep', openedAt: daysBefore(NOW, 100), resolvedAt: daysBefore(NOW, 89), resolution: 'recovered' });
      await insertRow({ sourceId: 'openold', openedAt: daysBefore(NOW, 200) });
    });
    expect(await asSystem(() => deleteExpiredResolved(NOW, 2))).toBe(2);
    expect(await asSystem(() => deleteExpiredResolved(NOW, 2))).toBe(1);
    const left = (await asSystem(() => db.select().from(connectionHealthIncidents))).map((r) => r.sourceId).sort();
    expect(left).toEqual(['keep', 'openold']);
  });
});
```

Test helpers to define at the top of the file:
- `insertRow(over)` inserts a full row with defaults: partner P, kind `oauth_grant`, `firstFailedAt`/`lastObservedAt` = `EARLIER`.
- `asSystem(fn)` = `runOutsideDbContext(() => withSystemDbAccessContext(fn))`.
- `minutesBefore`, `daysBefore`.
- Truncate the table in `beforeEach`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/connectionHealthStore.integration.test.ts`
Expected: FAIL with `Cannot find module '…/store'`.

- [ ] **Step 3: Implement `store.ts`**

```ts
import { and, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import { connectionHealthIncidents as chi } from '../../db/schema';
import type { Permission } from '../permissions';
import { REOPEN_WINDOW_MS, type ConnectionSourceKind, type HealthObservation, type TrackedIncident, type TransitionAction } from './types';

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export const permissionToText = (p: Permission) => `${p.resource}:${p.action}`;
export function permissionFromText(s: string): Permission {
  const i = s.indexOf(':');
  if (i <= 0) throw new Error(`bad permission text: ${s}`);
  return { resource: s.slice(0, i), action: s.slice(i + 1) };
}

function observedColumns(o: HealthObservation, now: Date) {
  return {
    partnerId: o.partnerId,
    orgId: o.orgId,
    ownerUserId: o.ownerUserId,
    condition: o.condition,
    severity: o.severity,
    detail: o.detail,
    displayName: o.displayName,
    fixHref: o.fixHref,
    ownerFixHref: o.ownerFixHref,
    viewPermission: permissionToText(o.viewPermission),
    repairPermission: permissionToText(o.repairPermission),
    lastObservedAt: now,
  };
}

export async function loadTracked(kind: ConnectionSourceKind, now: Date): Promise<TrackedIncident[]> {
  const since = new Date(now.getTime() - REOPEN_WINDOW_MS);
  const rows = await db.select({
    id: chi.id, sourceId: chi.sourceId, severity: chi.severity, openedAt: chi.openedAt,
    resolvedAt: chi.resolvedAt, healthyStreak: chi.healthyStreak,
  }).from(chi).where(and(
    eq(chi.sourceKind, kind),
    or(isNull(chi.resolvedAt), and(gt(chi.resolvedAt, since), eq(chi.resolution, 'recovered'))),
  ));
  // A source can have one open row plus older recently-resolved rows; the open row wins.
  const bySource = new Map<string, TrackedIncident>();
  for (const r of rows) {
    const t = { ...r, severity: r.severity as TrackedIncident['severity'] };
    const prev = bySource.get(r.sourceId);
    if (!prev || (prev.resolvedAt && !t.resolvedAt) || (prev.resolvedAt && t.resolvedAt && t.resolvedAt > prev.resolvedAt)) {
      bySource.set(r.sourceId, t);
    }
  }
  return [...bySource.values()];
}

export async function applyActions(actions: readonly TransitionAction[], now: Date) {
  const counts = { opened: 0, resolved: 0, pending: 0 };
  for (const a of actions) {
    switch (a.type) {
      case 'insertPending':
        await db.insert(chi).values({ ...observedColumns(a.obs, now), sourceKind: a.obs.sourceKind, sourceId: a.obs.sourceId, firstFailedAt: now });
        counts.pending += 1;
        break;
      case 'insertOpen':
        await db.insert(chi).values({
          ...observedColumns(a.obs, now), sourceKind: a.obs.sourceKind, sourceId: a.obs.sourceId,
          firstFailedAt: now, openedAt: now, pendingNotice: a.notify ? 'opened' : null,
        });
        counts.opened += 1;
        break;
      case 'promotePending':
        await db.update(chi).set({ ...observedColumns(a.obs, now), openedAt: now, pendingNotice: a.notify ? 'opened' : null })
          .where(and(eq(chi.id, a.incidentId), isNull(chi.openedAt)));
        counts.opened += 1;
        break;
      case 'update':
        await db.update(chi).set({
          ...observedColumns(a.obs, now), healthyStreak: 0,
          ...(a.escalated ? { pendingNotice: 'escalated' } : {}),
        }).where(eq(chi.id, a.incidentId));
        break;
      case 'healthyTick':
        await db.update(chi).set({ healthyStreak: a.healthyStreak, lastObservedAt: now }).where(eq(chi.id, a.incidentId));
        break;
      case 'resolve':
        await db.update(chi).set({
          resolvedAt: now, resolution: a.resolution, lastObservedAt: now,
          pendingNotice: sql`CASE WHEN cardinality(${chi.notifiedUserIds}) > 0 THEN 'resolved' ELSE NULL END`,
        }).where(and(eq(chi.id, a.incidentId), isNull(chi.resolvedAt)));
        counts.resolved += 1;
        break;
      case 'reopen':
        await db.update(chi).set({
          ...observedColumns(a.obs, now), resolvedAt: null, resolution: null, openedAt: now,
          healthyStreak: 0, flapCount: sql`${chi.flapCount} + 1`, pendingNotice: 'opened',
        }).where(eq(chi.id, a.incidentId));
        counts.opened += 1;
        break;
      case 'deletePending':
        await db.delete(chi).where(and(eq(chi.id, a.incidentId), isNull(chi.openedAt)));
        break;
    }
  }
  return counts;
}

export async function deleteExpiredResolved(now: Date, limit = 1000): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_MS);
  const rows = await db.execute(sql`
    DELETE FROM connection_health_incidents WHERE id IN (
      SELECT id FROM connection_health_incidents
      WHERE resolved_at IS NOT NULL AND resolved_at < ${cutoff}
      LIMIT ${limit}
    ) RETURNING id`);
  return (rows as unknown as unknown[]).length;
}
```

**Reopen.** The note for the next step: "reopen" marks old notices read on the resolve that preceded it (Task 6), and the new `opened_at` gives the new notice a fresh dedupe key. Notifying `resolved` and then `opened` within one hour is intentional; the resolve notice is only a mark-read, never a new notice. Also check how `db.execute` returns rows elsewhere (`grep -rn "RETURNING id" apps/api/src/services | head -3`) and match that shape. Some call sites use `.rows`.

- [ ] **Step 4: Run to verify it passes**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/connectionHealth/store.ts apps/api/src/__tests__/integration/connectionHealthStore.integration.test.ts
git commit -m "feat(connection-health): incident store applying transition actions (#8845)"
```

---

### Task 5: Recipients

**Files:**
- Modify: `apps/api/src/services/usersWithPermission.ts` (extract the granting-roles query; add a function)
- Create: `apps/api/src/services/connectionHealth/recipients.ts`
- Test: `apps/api/src/services/usersWithPermission.test.ts` (extend); `apps/api/src/services/connectionHealth/recipients.test.ts`

**Interfaces:**
- Produces:
  - `resolvePartnerUsersWithPermission(partnerId: string, permission: PermissionPair, opts?: { orgId?: string }): Promise<string[]>`. It returns active partner users with a granting role. Without `orgId`, only users with `orgAccess = 'all'`. With `orgId`, users with `all` or `selected` covering that org. It never includes org members, and it runs in system scope (same escape as `resolveUsersWithPermissionForOrg`).
  - `resolveIncidentRecipients(incident: { partnerId: string; orgId: string | null; ownerUserId: string | null; repairPermission: string }): Promise<{ admins: string[]; owner: string | null }>`. `owner` is excluded from `admins`. The owner is returned only if active.

- [ ] **Step 1: Write the failing tests**

In `usersWithPermission.test.ts`, following its existing mock style:

```ts
describe('resolvePartnerUsersWithPermission', () => {
  it('partner-wide: only orgAccess=all partner users with a granting role', async () => {
    // mocks: granting role r1; partner users u1(all,r1) u2(selected [A],r1) u3(all, other role)
    expect(await resolvePartnerUsersWithPermission('P', PERM)).toEqual(['u1']);
  });
  it('org-scoped: all + selected covering the org; never org members', async () => {
    expect((await resolvePartnerUsersWithPermission('P', PERM, { orgId: 'A' })).sort()).toEqual(['u1', 'u2']);
  });
  it('returns [] when no role grants the permission', async () => {
    grantingRolesMock.mockResolvedValue([]);
    expect(await resolvePartnerUsersWithPermission('P', PERM)).toEqual([]);
    expect(partnerUsersQueryMock).not.toHaveBeenCalled();
  });
});
```

`recipients.test.ts` mocks `../usersWithPermission` and the users status lookup:

```ts
it('partner-wide incident → partner admins, owner separately, owner not duplicated', async () => {
  resolvePartnerUsersMock.mockResolvedValue(['u1', 'owner']);
  activeUsersMock.mockResolvedValue(['owner']);
  expect(await resolveIncidentRecipients({ partnerId: 'P', orgId: null, ownerUserId: 'owner', repairPermission: 'connected_apps:manage' }))
    .toEqual({ admins: ['u1'], owner: 'owner' });
  expect(resolvePartnerUsersMock).toHaveBeenCalledWith('P', { resource: 'connected_apps', action: 'manage' }, {});
});
it('org incident passes orgId through', async () => {
  resolvePartnerUsersMock.mockResolvedValue(['u1']);
  activeUsersMock.mockResolvedValue([]);
  await resolveIncidentRecipients({ partnerId: 'P', orgId: 'A', ownerUserId: null, repairPermission: 'organizations:write' });
  expect(resolvePartnerUsersMock).toHaveBeenCalledWith('P', { resource: 'organizations', action: 'write' }, { orgId: 'A' });
});
it('inactive owner is dropped', async () => {
  resolvePartnerUsersMock.mockResolvedValue(['u1']);
  activeUsersMock.mockResolvedValue([]);
  expect(await resolveIncidentRecipients({ partnerId: 'P', orgId: null, ownerUserId: 'gone', repairPermission: 'connected_apps:manage' }))
    .toEqual({ admins: ['u1'], owner: null });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/usersWithPermission.test.ts src/services/connectionHealth/recipients.test.ts`
Expected: FAIL; the exports don't exist.

- [ ] **Step 3: Implement**

In `usersWithPermission.ts`, extract the first query of `resolveUsersWithPermissionForOrg` into a private helper `grantingRoleIdsFor(permission)` and reuse it there. Then add:

```ts
/**
 * Partner-scope users (never org members) whose role grants `permission`.
 * Without `orgId`: only full-partner users (`orgAccess = 'all'`) — the audience
 * for partner-owned connections. With `orgId`: `all` or `selected` covering it.
 * Same system-scope escape as resolveUsersWithPermissionForOrg.
 */
export async function resolvePartnerUsersWithPermission(
  partnerId: string,
  permission: PermissionPair,
  opts: { orgId?: string } = {},
): Promise<string[]> {
  const read = async (): Promise<string[]> => {
    const grantingRoleIds = await grantingRoleIdsFor(permission);
    if (grantingRoleIds.length === 0) return [];
    const rows = await db
      .select({ userId: partnerUsers.userId, orgAccess: partnerUsers.orgAccess, orgIds: partnerUsers.orgIds })
      .from(partnerUsers)
      .innerJoin(users, eq(users.id, partnerUsers.userId))
      .where(and(eq(partnerUsers.partnerId, partnerId), inArray(partnerUsers.roleId, grantingRoleIds), eq(users.status, 'active')));
    const out = new Set<string>();
    for (const r of rows) {
      if (r.orgAccess === 'all') out.add(r.userId);
      else if (opts.orgId && r.orgAccess === 'selected' && r.orgIds?.includes(opts.orgId)) out.add(r.userId);
    }
    return [...out];
  };
  const ambientScope = getCurrentDbAccessContext()?.scope;
  if (ambientScope === 'system') return read();
  return runOutsideDbContext(() => withSystemDbAccessContext(read, 'usersWithPermission.resolvePartnerUsers'));
}
```

`recipients.ts`:

```ts
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { users } from '../../db/schema';
import { resolvePartnerUsersWithPermission } from '../usersWithPermission';
import { permissionFromText } from './store';

async function activeUserIds(ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db.select({ id: users.id }).from(users).where(and(inArray(users.id, [...ids]), eq(users.status, 'active')));
  return rows.map((r) => r.id);
}

/** Spec §4 (W1: customer admins off — partner-scope recipients only, plus the owner). Runs in system scope. */
export async function resolveIncidentRecipients(incident: {
  partnerId: string; orgId: string | null; ownerUserId: string | null; repairPermission: string;
}): Promise<{ admins: string[]; owner: string | null }> {
  const admins = await resolvePartnerUsersWithPermission(
    incident.partnerId,
    permissionFromText(incident.repairPermission),
    incident.orgId ? { orgId: incident.orgId } : {},
  );
  const owner = incident.ownerUserId && (await activeUserIds([incident.ownerUserId])).length > 0 ? incident.ownerUserId : null;
  return { admins: admins.filter((id) => id !== owner), owner };
}
```

`recipients.test.ts` mocks `activeUserIds` through the `db` mock. It is simplest to export `activeUserIds` and spy on it.

- [ ] **Step 4: Run to verify they pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/usersWithPermission.ts apps/api/src/services/usersWithPermission.test.ts apps/api/src/services/connectionHealth/recipients.ts apps/api/src/services/connectionHealth/recipients.test.ts
git commit -m "feat(connection-health): partner-scope recipient resolution (#8845)"
```

---

### Task 6: Notifier (drains the `pending_notice` outbox)

**Files:**
- Create: `apps/api/src/services/connectionHealth/notifier.ts`
- Test: `apps/api/src/__tests__/integration/connectionHealthNotifier.integration.test.ts`

**Interfaces:**
- Consumes: `resolveIncidentRecipients` (Task 5); `createNotification` and `markNotificationsReadByDedupeKeys` (Task 1); the `connectionHealthIncidents` table.
- Produces:
  - `deliverPendingNotices(now: Date, opts?: { limit?: number }): Promise<{ delivered: number; failed: number }>`. Default limit 200. Each incident is processed in its own system-scope transaction.
  - `noticeDedupeKeys(incidentId: string, openedAt: Date): { opened: string; permanent: string }`.

- [ ] **Step 1: Write the failing integration test**

```ts
describe('deliverPendingNotices', () => {
  it('opened → one notice per recipient, owner gets owner_fix_href, ids recorded, outbox cleared', async () => {
    // seed: partner P, admin u1 (connected_apps:manage, orgAccess all), owner o1 (org user)
    // incident: partner-wide, owner o1, fix '/settings/connected-apps', owner fix '/account/connected-apps', pending 'opened'
    await asSystem(() => deliverPendingNotices(NOW));
    const notes = await asSystem(() => db.select().from(userNotifications));
    expect(notes.map((n) => [n.userId, n.link, n.type, n.priority]).sort()).toEqual([
      ['o1', '/account/connected-apps', 'integration', 'high'],
      ['u1', '/settings/connected-apps', 'integration', 'high'],
    ].sort());
    const [inc] = await asSystem(() => db.select().from(connectionHealthIncidents));
    expect(inc!.pendingNotice).toBeNull();
    expect([...inc!.notifiedUserIds].sort()).toEqual(['o1', 'u1'].sort());
  });
  it('escalated → a second notice with the :permanent key', async () => {
    await asSystem(() => deliverPendingNotices(NOW));
    await asSystem(() => db.update(connectionHealthIncidents).set({ pendingNotice: 'escalated' }));
    await asSystem(() => deliverPendingNotices(NOW));
    const keys = (await asSystem(() => db.select().from(userNotifications).where(eq(userNotifications.userId, 'u1')))).map((n) => n.dedupeKey).sort();
    const { opened, permanent } = noticeDedupeKeys(incidentId, OPENED_AT);
    expect(keys).toEqual([opened, permanent].sort());
  });
  it("resolved → marks exactly the recorded users' notices read, creates nothing", async () => {
    await asSystem(() => deliverPendingNotices(NOW));
    await asSystem(() => createNotification({ userId: 'u1', orgId: null, type: 'integration', title: 'other', dedupeKey: 'unrelated' }));
    await asSystem(() => db.update(connectionHealthIncidents).set({ pendingNotice: 'resolved', resolvedAt: NOW, resolution: 'recovered' }));
    await asSystem(() => deliverPendingNotices(NOW));
    const notes = await asSystem(() => db.select().from(userNotifications));
    expect(notes).toHaveLength(3);
    expect(notes.filter((n) => n.read).map((n) => n.userId).sort()).toEqual(['o1', 'u1']);
    expect(notes.find((n) => n.dedupeKey === 'unrelated')!.read).toBe(false);
    const [inc] = await asSystem(() => db.select().from(connectionHealthIncidents));
    expect(inc).toMatchObject({ pendingNotice: null, notifiedUserIds: [] });
  });
  it('does not recreate a deleted notice on a later run', async () => {
    await asSystem(() => deliverPendingNotices(NOW));
    await asSystem(() => db.delete(userNotifications).where(eq(userNotifications.userId, 'u1')));
    await asSystem(() => deliverPendingNotices(NOW));   // outbox already empty
    expect(await asSystem(() => db.select().from(userNotifications).where(eq(userNotifications.userId, 'u1')))).toHaveLength(0);
  });
  it('a recipient failure leaves pending_notice set so the next run retries', async () => {
    const spy = vi.spyOn(userNotificationsModule, 'createNotification').mockRejectedValueOnce(new Error('db blip'));
    const result = await asSystem(() => deliverPendingNotices(NOW));
    expect(result.failed).toBe(1);
    expect((await asSystem(() => db.select().from(connectionHealthIncidents)))[0]!.pendingNotice).toBe('opened');
    spy.mockRestore();
    expect((await asSystem(() => deliverPendingNotices(NOW))).delivered).toBe(1);
  });
  it('zero recipients logs a warning and clears the outbox', async () => {
    await asSystem(() => db.update(connectionHealthIncidents).set({ ownerUserId: null, repairPermission: 'nobody:has' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await asSystem(() => deliverPendingNotices(NOW));
    expect(warn.mock.calls.some((c) => String(c[0]).includes('connection_health_zero_recipients'))).toBe(true);
    expect((await asSystem(() => db.select().from(connectionHealthIncidents)))[0]!.pendingNotice).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/connectionHealthNotifier.integration.test.ts`
Expected: FAIL; the module is missing.

- [ ] **Step 3: Implement `notifier.ts`**

```ts
import { eq, isNotNull, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { connectionHealthIncidents as chi } from '../../db/schema';
import { createNotification, markNotificationsReadByDedupeKeys } from '../userNotifications';
import { resolveIncidentRecipients } from './recipients';

export function noticeDedupeKeys(incidentId: string, openedAt: Date) {
  const base = `connection-health:${incidentId}:${openedAt.getTime()}`;
  return { opened: base, permanent: `${base}:permanent` };
}

function noticeText(row: typeof chi.$inferSelect, escalated: boolean) {
  const title = escalated ? `${row.displayName} now needs attention` : `${row.displayName} is not working`;
  const message = row.detail ?? (row.severity === 'permanent'
    ? 'This connection needs to be reconnected or re-authorized.'
    : 'This connection has been failing. Breeze will clear this notice once it recovers.');
  return { title: title.slice(0, 255), message };
}

async function deliverOne(row: typeof chi.$inferSelect): Promise<void> {
  const openedAt = row.openedAt ?? row.firstFailedAt;
  const keys = noticeDedupeKeys(row.id, openedAt);

  if (row.pendingNotice === 'resolved') {
    await markNotificationsReadByDedupeKeys(row.notifiedUserIds, [keys.opened, keys.permanent]);
    await db.update(chi).set({ pendingNotice: null, notifiedUserIds: sql`'{}'::uuid[]` }).where(eq(chi.id, row.id));
    return;
  }

  const escalated = row.pendingNotice === 'escalated';
  const { admins, owner } = await resolveIncidentRecipients(row);
  const { title, message } = noticeText(row, escalated);
  const base = {
    orgId: row.orgId, type: 'integration' as const, title, message,
    priority: row.severity === 'permanent' ? 'high' as const : 'normal' as const,
    metadata: { incidentId: row.id, sourceKind: row.sourceKind, condition: row.condition },
    dedupeKey: escalated ? keys.permanent : keys.opened,
  };
  for (const userId of admins) await createNotification({ ...base, userId, link: row.fixHref });
  if (owner) await createNotification({ ...base, userId: owner, link: row.ownerFixHref ?? row.fixHref });

  const recipients = owner ? [...admins, owner] : admins;
  if (recipients.length === 0) {
    console.warn(JSON.stringify({ event: 'connection_health_zero_recipients', incidentId: row.id, sourceKind: row.sourceKind, partnerId: row.partnerId }));
  }
  await db.update(chi).set({
    pendingNotice: null,
    // Merge in JS: drizzle expands a JS array in sql`` into a value list, not an
    // array literal. The reconciler runs at concurrency 1, so there's no racing writer.
    notifiedUserIds: [...new Set([...row.notifiedUserIds, ...recipients])],
  }).where(eq(chi.id, row.id));
}

/** Drain the outbox. Each incident in its own system transaction, so one failure never blocks the rest. */
export async function deliverPendingNotices(_now: Date, opts: { limit?: number } = {}) {
  const limit = opts.limit ?? 200;
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(
    () => db.select().from(chi).where(isNotNull(chi.pendingNotice)).limit(limit),
    'connectionHealth.pendingNotices'));
  let delivered = 0; let failed = 0;
  for (const row of rows) {
    try {
      await runOutsideDbContext(() => withSystemDbAccessContext(() => deliverOne(row), 'connectionHealth.deliver'));
      delivered += 1;
    } catch (err) {
      failed += 1;
      console.error(JSON.stringify({ event: 'connection_health_notice_failed', incidentId: row.id, error: err instanceof Error ? err.message : String(err) }));
    }
  }
  return { delivered, failed };
}
```

For the spy in the failure test to work, `notifier.ts` must call `createNotification` through the module namespace: `import * as userNotificationsModule from '../userNotifications'`, then `userNotificationsModule.createNotification(...)`. Use the repo's logger if `services/connectionHealth` neighbours use one: check `grep -rn "from '../../lib/logger'\|createLogger" apps/api/src/services | head -3` and replace `console.*` to match. If the transaction failed, a retry recreates notices that already exist; `createNotification` dedupe returns null for those, which is why the dedupe key exists.

- [ ] **Step 4: Run to verify it passes**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/connectionHealth/notifier.ts apps/api/src/__tests__/integration/connectionHealthNotifier.integration.test.ts
git commit -m "feat(connection-health): durable notice outbox and delivery (#8845)"
```

---

### Task 7: OAuth grant source

**Files:**
- Create: `apps/api/src/services/connectionHealth/sources/oauthGrant.ts`
- Create: `apps/api/src/services/connectionHealth/sources/index.ts`
- Test: `apps/api/src/__tests__/integration/connectionHealthOauthSource.integration.test.ts`

**Interfaces:**
- Consumes: `HealthSource`, `HealthObservation` (Task 2); the `oauthGrants` and `oauthClients` tables.
- Produces:
  - `oauthGrantSource: HealthSource` with kind `'oauth_grant'` and `intervalMinutes: 15`. `sourceId` = `` `${accountId}:${clientId}` ``.
  - `HEALTH_SOURCES: readonly HealthSource[]`, which is `[oauthGrantSource]`.
  - `cleanDisplayName(raw: unknown, fallback: string): string`.

**Semantics (spec §3):**
> **Amended in the final fix wave.** The rule below and the code in this task are superseded by spec §3 **OAuth detail** and by `sources/oauthGrant.ts`: only `refresh-token-reuse` is automatic, and a pair is broken when no partner-attributed grant was created after its latest automatic revoke E (an older active grant no longer hides it).

- **broken / permanent (original, superseded):** the newest grant for an (account, client) pair was revoked within 30 days with reason `refresh-token-reuse` (condition `grant_revoked_reuse`) or `provider-revoke-grant` (condition `grant_revoked_code_replay`), with `revoked_by_user_id IS NULL` and `partner_id IS NOT NULL`. No active grant exists for the pair (one with `revoked_at IS NULL AND expires_at > now`), and the client isn't disabled.
- **healthy:** an active grant exists for a tracked pair.
- **retired:** a tracked pair whose newest grant is deliberately revoked, older than 30 days, expired with no replacement, gone, or whose client is disabled.
- **Fixed fields:**
  - `fixHref` = `/settings/connected-apps`
  - `ownerFixHref` = `/account/connected-apps`
  - `viewPermission` = `connected_apps:read`
  - `repairPermission` = `connected_apps:manage`
  - `ownerUserId` = `accountId`
  - `orgId` = the grant's `org_id`
  - `detail` = `null`

- [ ] **Step 1: Write the failing integration test**

```ts
describe('oauthGrantSource', () => {
  it('reports a reuse-revoked grant with no replacement as broken/permanent', async () => {
    const g = await seedGrant({ revokedAt: daysAgo(10), revokedReason: 'refresh-token-reuse' });
    const out = await asSystem(() => oauthGrantSource.observe(NOW, []));
    expect(out).toEqual([expect.objectContaining({
      sourceKind: 'oauth_grant', sourceId: `${g.accountId}:${g.clientId}`, state: 'broken', severity: 'permanent',
      condition: 'grant_revoked_reuse', ownerUserId: g.accountId, partnerId: g.partnerId,
      fixHref: '/settings/connected-apps', ownerFixHref: '/account/connected-apps',
    })]);
  });
  it('a newer active grant for the same pair makes it healthy when tracked, absent when not', async () => {
    const g = await seedGrant({ revokedAt: daysAgo(2), revokedReason: 'refresh-token-reuse' });
    await seedGrant({ accountId: g.accountId, clientId: g.clientId, createdAt: daysAgo(1) });
    expect(await asSystem(() => oauthGrantSource.observe(NOW, []))).toEqual([]);
    const tracked = await asSystem(() => oauthGrantSource.observe(NOW, [`${g.accountId}:${g.clientId}`]));
    expect(tracked).toEqual([expect.objectContaining({ state: 'healthy' })]);
  });
  it('user revocation after re-consent retires', async () => {
    const g = await seedGrant({ revokedAt: daysAgo(3), revokedReason: 'refresh-token-reuse' });
    await seedGrant({ accountId: g.accountId, clientId: g.clientId, createdAt: daysAgo(2), revokedAt: daysAgo(1), revokedByUserId: g.accountId });
    const out = await asSystem(() => oauthGrantSource.observe(NOW, [`${g.accountId}:${g.clientId}`]));
    expect(out).toEqual([expect.objectContaining({ state: 'retired' })]);
  });
  it('a tracked pair with no grants left, or a malformed tracked id, yields no observation (the reconciler retires absent ids)', async () => {
    expect(await asSystem(() => oauthGrantSource.observe(NOW, ['00000000-0000-0000-0000-000000000000:gone', 'not-a-uuid:x', 'nocolon'])))
      .toEqual([]);
  });
  it('a disabled client is retired when tracked and absent when not', async () => {
    const g = await seedGrant({ revokedAt: daysAgo(1), revokedReason: 'refresh-token-reuse', clientDisabledAt: daysAgo(0) });
    expect(await asSystem(() => oauthGrantSource.observe(NOW, []))).toEqual([]);
    expect(await asSystem(() => oauthGrantSource.observe(NOW, [`${g.accountId}:${g.clientId}`])))
      .toEqual([expect.objectContaining({ state: 'retired' })]);
  });
  it('maps provider-revoke-grant to grant_revoked_code_replay', async () => {
    await seedGrant({ revokedAt: daysAgo(1), revokedReason: 'provider-revoke-grant' });
    expect((await asSystem(() => oauthGrantSource.observe(NOW, [])))[0]).toMatchObject({ condition: 'grant_revoked_code_replay' });
  });
  it('ignores deliberate revocations and null reasons', async () => {
    const owner = await seedUser();
    await seedGrant({ revokedAt: daysAgo(1), revokedReason: 'refresh-token-reuse', revokedByUserId: owner });
    await seedGrant({ revokedAt: daysAgo(1), revokedReason: null });
    expect(await asSystem(() => oauthGrantSource.observe(NOW, []))).toEqual([]);
  });
  it('ignores revocations older than 30 days', async () => {
    await seedGrant({ revokedAt: daysAgo(31), revokedReason: 'refresh-token-reuse' });
    expect(await asSystem(() => oauthGrantSource.observe(NOW, []))).toEqual([]);
  });
  it('caps and cleans client_name', async () => {
    await seedGrant({ revokedAt: daysAgo(1), revokedReason: 'refresh-token-reuse', clientName: `\u0000<b>${'x'.repeat(500)}\n` });
    const [o] = await asSystem(() => oauthGrantSource.observe(NOW, []));
    expect(o!.displayName.length).toBeLessThanOrEqual(80);
    expect(o!.displayName).not.toMatch(/[\u0000-\u001f]/);
  });
  it('returns one observation per pair when several revoked grants exist', async () => {
    const g = await seedGrant({ revokedAt: daysAgo(3), revokedReason: 'refresh-token-reuse' });
    await seedGrant({ accountId: g.accountId, clientId: g.clientId, createdAt: daysAgo(2), revokedAt: daysAgo(2), revokedReason: 'refresh-token-reuse' });
    expect(await asSystem(() => oauthGrantSource.observe(NOW, []))).toHaveLength(1);
  });
});
```

Test helper `seedGrant(over)` creates a partner, a user and an `oauth_clients` row (metadata `{ client_name }`, optional `disabled_at`) when they aren't given, then an `oauth_grants` row. Defaults: `createdAt` = `daysAgo(5)`, `expiresAt` = `createdAt` + 14 days, not revoked. It returns `{ accountId, clientId, partnerId }`.

Tracked ids are validated with a uuid regex before any SQL cast. A malformed id is skipped, which makes it absent, and an absent id is retired by `planTransitions`. That way there's one mechanism, not two.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/connectionHealthOauthSource.integration.test.ts`
Expected: FAIL; the module is missing.

- [ ] **Step 3: Implement**

`sources/oauthGrant.ts`:

```ts
import { sql } from 'drizzle-orm';
import { db } from '../../../db';
import { PERMISSIONS } from '../../permissions';
import type { HealthObservation, HealthSource } from '../types';

const LOOKBACK_DAYS = 30;
const AUTO_REASONS: Record<string, string> = {
  'refresh-token-reuse': 'grant_revoked_reuse',
  'provider-revoke-grant': 'grant_revoked_code_replay',
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// DCR client_name is attacker-controlled: strip control chars, collapse space, cap.
export function cleanDisplayName(raw: unknown, fallback: string): string {
  const s = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return (s || fallback).slice(0, 80);
}

type PairRow = {
  account_id: string; client_id: string; partner_id: string | null; org_id: string | null;
  revoked_at: Date | null; revoked_reason: string | null; revoked_by_user_id: string | null;
  has_active: boolean; client_disabled: boolean; client_name: unknown;
};

function toObservation(r: PairRow, now: Date): HealthObservation | null {
  if (!r.partner_id) return null;
  const sourceId = `${r.account_id}:${r.client_id}`;
  const cutoff = now.getTime() - LOOKBACK_DAYS * 86_400_000;
  const condition = r.revoked_reason ? AUTO_REASONS[r.revoked_reason] : undefined;
  let state: HealthObservation['state'];
  if (r.client_disabled) state = 'retired';
  else if (r.has_active) state = 'healthy';
  else if (condition && !r.revoked_by_user_id && r.revoked_at && r.revoked_at.getTime() >= cutoff) state = 'broken';
  else state = 'retired';
  return {
    sourceKind: 'oauth_grant', sourceId, partnerId: r.partner_id, orgId: r.org_id, ownerUserId: r.account_id,
    state, severity: 'permanent', condition: condition ?? 'grant_revoked', detail: null,
    displayName: cleanDisplayName(r.client_name, r.client_id),
    fixHref: '/settings/connected-apps', ownerFixHref: '/account/connected-apps',
    viewPermission: PERMISSIONS.CONNECTED_APPS_READ, repairPermission: PERMISSIONS.CONNECTED_APPS_MANAGE,
    observedAt: now,
  };
}

// Newest grant per (account, client) among `pairs`, plus whether any grant is active.
const pairQuery = (pairsSql: ReturnType<typeof sql>, now: Date) => sql`
  WITH pairs(account_id, client_id) AS (${pairsSql}),
  newest AS (
    SELECT DISTINCT ON (g.account_id, g.client_id)
      g.account_id, g.client_id, g.partner_id, g.org_id, g.revoked_at, g.revoked_reason, g.revoked_by_user_id
    FROM oauth_grants g JOIN pairs p ON p.account_id = g.account_id AND p.client_id = g.client_id
    ORDER BY g.account_id, g.client_id, g.created_at DESC
  )
  SELECT n.*,
    EXISTS (SELECT 1 FROM oauth_grants a WHERE a.account_id = n.account_id AND a.client_id = n.client_id
            AND a.revoked_at IS NULL AND a.expires_at > ${now}) AS has_active,
    (c.disabled_at IS NOT NULL) AS client_disabled,
    c.metadata->'client_name' AS client_name
  FROM newest n LEFT JOIN oauth_clients c ON c.id = n.client_id`;

export const oauthGrantSource: HealthSource = {
  kind: 'oauth_grant',
  intervalMinutes: 15,
  async observe(now, trackedSourceIds) {
    const cutoff = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000);
    // (a) broken candidates: index-backed by oauth_grants_auto_revoked_idx.
    const candidates = sql`
      SELECT DISTINCT account_id, client_id FROM oauth_grants
      WHERE revoked_at >= ${cutoff}
        AND revoked_reason IN ('refresh-token-reuse','provider-revoke-grant')
        AND revoked_by_user_id IS NULL`;
    // (b) tracked pairs, validated before any cast; malformed ids are skipped (absent ⇒ retired).
    const tracked: Array<[string, string]> = [];
    for (const id of trackedSourceIds) {
      const i = id.indexOf(':');
      const acct = i > 0 ? id.slice(0, i) : '';
      if (UUID_RE.test(acct) && i < id.length - 1) tracked.push([acct, id.slice(i + 1)]);
    }
    const trackedValues = tracked.length
      ? sql`SELECT * FROM (VALUES ${sql.join(tracked.map(([a, c]) => sql`(${a}::uuid, ${c}::text)`), sql`, `)}) AS t(account_id, client_id)`
      : sql`SELECT NULL::uuid, NULL::text WHERE false`;
    const rows = (await db.execute(pairQuery(sql`${candidates} UNION ${trackedValues}`, now))) as unknown as PairRow[];

    const out: HealthObservation[] = [];
    const trackedSet = new Set(trackedSourceIds);
    for (const r of rows) {
      const o = toObservation(r, now);
      // Untracked pairs only matter when broken (spec §1.3: never report the healthy set).
      if (o && (o.state === 'broken' || trackedSet.has(o.sourceId))) out.push(o);
    }
    return out;
  },
};
```

Confirm `db.execute`'s row shape (see Task 4) and that `revoked_at` comes back as a `Date`; convert it with `new Date()` if it's a string.

`sources/index.ts`:

```ts
import type { HealthSource } from '../types';
import { oauthGrantSource } from './oauthGrant';

/** Every connection kind the reconciler observes. A new integration registers here (spec §1.1). */
export const HEALTH_SOURCES: readonly HealthSource[] = [oauthGrantSource];
```

- [ ] **Step 4: Run to verify it passes**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/connectionHealth/sources apps/api/src/__tests__/integration/connectionHealthOauthSource.integration.test.ts
git commit -m "feat(connection-health): OAuth grant health source (#8845)"
```

---

### Task 8: Reconciler orchestrator and BullMQ worker

**Files:**
- Create: `apps/api/src/services/connectionHealth/reconcile.ts`
- Create: `apps/api/src/jobs/connectionHealthReconcile.ts`
- Modify: `apps/api/src/services/workerRegistry.ts` (entry after `aiBudgetAlertDeliveryWorker`, `:210`); `apps/api/src/services/workerRegistry.test.ts:44` `EXPECTED_WORKER_NAMES` (same position); `apps/api/src/services/workerEntrypointClosure.contract.test.ts:283` `EXPECTED_NAMES`; `apps/api/src/jobs/workerReadinessManifest.ts:273` (`consumers('connectionHealthReconcileWorker', ['connection-health-reconcile'])`)
- Test: `apps/api/src/services/connectionHealth/reconcile.test.ts` (unit, deps injected); `apps/api/src/__tests__/integration/connectionHealthReconcile.integration.test.ts` (end to end)

**Interfaces:**
- Consumes: everything from Tasks 2–7, plus `tightenStatementTimeout` (`db/lockTimeout.ts:147`), `sendOpsAlert` (`services/opsAlerts.ts:86`) and `getRedis` (`services/redis.ts:125`).
- Produces:

```ts
export type ReconcileDeps = {
  sources: readonly HealthSource[];
  now: () => Date;
  redis: Pick<Redis, 'get' | 'set' | 'incr' | 'del'> | null;
  budgetMs: number;                      // 60_000
  runKind: (source: HealthSource, now: Date, seed: boolean) => Promise<{ opened: number; resolved: number; pending: number; observations: number }>;
  deliver: (now: Date) => Promise<{ delivered: number; failed: number }>;
  retention: (now: Date) => Promise<number>;
  alert: (msg: { title: string; body: string }) => Promise<boolean>;
};
export type KindResult = { kind: string; status: 'ok' | 'failed' | 'skipped_not_due' | 'skipped_budget'; durationMs: number; error?: string } & Partial<{ opened: number; resolved: number; pending: number; observations: number }>;
export async function runReconcile(deps?: Partial<ReconcileDeps>): Promise<{ kinds: KindResult[]; notices: { delivered: number; failed: number }; retained: number }>;
export async function runKindInSystemScope(source: HealthSource, now: Date, seed: boolean): ReturnType<ReconcileDeps['runKind']>;
```

Redis keys (no TTL unless noted):
- `connection-health:kind:<kind>:last-ok`, epoch ms
- `connection-health:kind:<kind>:seeded`, `'1'`
- `connection-health:kind:<kind>:failures`, a counter, deleted on success
- `connection-health:reconcile:heartbeat`, ISO time, `EX 3600`

- [ ] **Step 1: Write the failing unit tests**

`reconcile.test.ts` uses a fake Redis (a `Map`) and fake sources. Helpers:
- `fakeRedis()` returns `{ store: Map, get, set(k, v, ..._ex), incr, del }`, all async.
- `src(kind, intervalMinutes)` builds a `HealthSource` whose `observe` is never called (the tests inject `runKind`).
- `okCounts = { opened: 0, resolved: 0, pending: 0, observations: 0 }`.
- `noops = { deliver: async () => ({ delivered: 0, failed: 0 }), retention: async () => 0, alert: async () => true }`.
- `noopsExceptAlert` is `noops` without `alert`.
- `T0` is a fixed Date; `plusMin(d, m)` adds minutes.

```ts
describe('runReconcile', () => {
  it('runs a due kind, records last-ok, and seeds on its first run only', async () => {
    const redis = fakeRedis();
    const runKind = vi.fn().mockResolvedValue({ opened: 1, resolved: 0, pending: 0, observations: 1 });
    await runReconcile({ sources: [src('a', 15)], redis, runKind, now: () => T0, ...noops });
    expect(runKind).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'a' }), T0, true);
    await runReconcile({ sources: [src('a', 15)], redis, runKind, now: () => plusMin(T0, 15), ...noops });
    expect(runKind).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'a' }), plusMin(T0, 15), false);
  });
  it('skips a kind whose interval has not elapsed', async () => {
    const redis = fakeRedis(); const runKind = vi.fn().mockResolvedValue(okCounts);
    await runReconcile({ sources: [src('a', 60)], redis, runKind, now: () => T0, ...noops });
    const r = await runReconcile({ sources: [src('a', 60)], redis, runKind, now: () => plusMin(T0, 15), ...noops });
    expect(r.kinds[0]!.status).toBe('skipped_not_due');
    expect(runKind).toHaveBeenCalledTimes(1);
  });
  it('treats every kind as due and never seeds without Redis', async () => {
    const runKind = vi.fn().mockResolvedValue(okCounts);
    await runReconcile({ sources: [src('a', 60)], redis: null, runKind, now: () => T0, ...noops });
    await runReconcile({ sources: [src('a', 60)], redis: null, runKind, now: () => plusMin(T0, 1), ...noops });
    expect(runKind).toHaveBeenCalledTimes(2);
    expect(runKind.mock.calls.every((c) => c[2] === false)).toBe(true);
  });
  it('a failing source leaves its incidents untouched and others still run', async () => {
    const runKind = vi.fn(async (s: HealthSource) => { if (s.kind === 'a') throw new Error('boom'); return okCounts; });
    const r = await runReconcile({ sources: [src('a', 15), src('b', 15)], redis: fakeRedis(), runKind, now: () => T0, ...noops });
    expect(r.kinds.map((k) => [k.kind, k.status])).toEqual([['a', 'failed'], ['b', 'ok']]);
  });
  it('alerts ops exactly once when a kind fails three runs in a row, and resets on success', async () => {
    const redis = fakeRedis(); const alert = vi.fn().mockResolvedValue(true);
    const failing = vi.fn().mockRejectedValue(new Error('boom'));
    for (let i = 0; i < 4; i += 1) await runReconcile({ sources: [src('a', 15)], redis, runKind: failing, alert, now: () => plusMin(T0, 15 * i), ...noopsExceptAlert });
    expect(alert).toHaveBeenCalledTimes(1);
    await runReconcile({ sources: [src('a', 15)], redis, runKind: vi.fn().mockResolvedValue(okCounts), alert, now: () => plusMin(T0, 60), ...noopsExceptAlert });
    expect(redis.store.has('connection-health:kind:a:failures')).toBe(false);
    for (let i = 0; i < 3; i += 1) await runReconcile({ sources: [src('a', 15)], redis, runKind: failing, alert, now: () => plusMin(T0, 75 + 15 * i), ...noopsExceptAlert });
    expect(alert).toHaveBeenCalledTimes(2);
  });
  it('stops starting kinds once the budget is spent and marks the rest skipped_budget', async () => {
    let t = T0.getTime();
    const now = () => new Date(t);
    const runKind = vi.fn(async () => { t += 40_000; return okCounts; });
    const r = await runReconcile({ sources: [src('a', 15), src('b', 15), src('c', 15)], redis: fakeRedis(), runKind, now, budgetMs: 60_000, ...noops });
    expect(r.kinds.map((k) => k.status)).toEqual(['ok', 'ok', 'skipped_budget']);
  });
  it('delivers notices and runs retention after kinds, and writes the heartbeat', async () => {
    const redis = fakeRedis(); const deliver = vi.fn().mockResolvedValue({ delivered: 0, failed: 0 }); const retention = vi.fn().mockResolvedValue(0);
    await runReconcile({ sources: [src('a', 15)], redis, runKind: vi.fn().mockResolvedValue(okCounts), deliver, retention, alert: vi.fn(), now: () => T0 });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(retention).toHaveBeenCalledTimes(1);
    expect(redis.store.get('connection-health:reconcile:heartbeat')).toBe(T0.toISOString());
  });
  it('does not mark a kind seeded when the seed run failed', async () => {
    const redis = fakeRedis();
    const runKind = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(okCounts);
    await runReconcile({ sources: [src('a', 15)], redis, runKind, now: () => T0, ...noops });
    await runReconcile({ sources: [src('a', 15)], redis, runKind, now: () => plusMin(T0, 15), ...noops });
    expect(runKind.mock.calls.map((c) => c[2])).toEqual([true, true]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/connectionHealth/reconcile.test.ts`
Expected: FAIL; the module is missing.

- [ ] **Step 3: Implement `reconcile.ts`**

```ts
import type Redis from 'ioredis';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { tightenStatementTimeout } from '../../db/lockTimeout';
import { sendOpsAlert } from '../opsAlerts';
import { getRedis } from '../redis';
import { deliverPendingNotices } from './notifier';
import { HEALTH_SOURCES } from './sources';
import { applyActions, deleteExpiredResolved, loadTracked } from './store';
import { planTransitions } from './transitions';
import type { HealthSource } from './types';

const KIND_STATEMENT_TIMEOUT_MS = 5_000;
const RUN_BUDGET_MS = 60_000;
const FAILURE_ALERT_AT = 3;
const key = (kind: string, k: string) => `connection-health:kind:${kind}:${k}`;

export async function runKindInSystemScope(source: HealthSource, now: Date, seed: boolean) {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    await tightenStatementTimeout(db, KIND_STATEMENT_TIMEOUT_MS);
    const tracked = await loadTracked(source.kind, now);
    const observations = await source.observe(now, tracked.map((t) => t.sourceId));
    const actions = planTransitions({ observations, tracked, now, seed });
    const counts = await applyActions(actions, now);
    return { ...counts, observations: observations.length };
  }, `connectionHealth.reconcile.${source.kind}`));
}

const defaults = (): ReconcileDeps => ({
  sources: HEALTH_SOURCES,
  now: () => new Date(),
  redis: getRedis(),
  budgetMs: RUN_BUDGET_MS,
  runKind: runKindInSystemScope,
  deliver: (now) => deliverPendingNotices(now),
  retention: (now) => runOutsideDbContext(() => withSystemDbAccessContext(() => deleteExpiredResolved(now), 'connectionHealth.retention')),
  alert: sendOpsAlert,
});

export async function runReconcile(overrides: Partial<ReconcileDeps> = {}) {
  const d = { ...defaults(), ...overrides };
  const started = d.now();
  const kinds: KindResult[] = [];

  for (const source of d.sources) {
    const t0 = d.now();
    if (t0.getTime() - started.getTime() >= d.budgetMs) {
      kinds.push({ kind: source.kind, status: 'skipped_budget', durationMs: 0 });
      continue;
    }
    if (d.redis) {
      const lastOk = Number(await d.redis.get(key(source.kind, 'last-ok')) ?? 0);
      if (lastOk && t0.getTime() - lastOk < source.intervalMinutes * 60_000 - 30_000) {
        kinds.push({ kind: source.kind, status: 'skipped_not_due', durationMs: 0 });
        continue;
      }
    }
    // Seed only when Redis can remember that we did; without Redis, notify normally.
    const seed = d.redis ? (await d.redis.get(key(source.kind, 'seeded'))) === null : false;
    try {
      const counts = await d.runKind(source, t0, seed);
      if (d.redis) {
        await d.redis.set(key(source.kind, 'last-ok'), String(t0.getTime()));
        if (seed) await d.redis.set(key(source.kind, 'seeded'), '1');
        await d.redis.del(key(source.kind, 'failures'));
      }
      kinds.push({ kind: source.kind, status: 'ok', durationMs: d.now().getTime() - t0.getTime(), ...counts });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      kinds.push({ kind: source.kind, status: 'failed', durationMs: d.now().getTime() - t0.getTime(), error: message.slice(0, 300) });
      if (d.redis) {
        const n = await d.redis.incr(key(source.kind, 'failures'));
        if (n === FAILURE_ALERT_AT) {
          await d.alert({ title: `Connection health: ${source.kind} source failing`, body: `observe() failed ${n} runs in a row: ${message.slice(0, 300)}` });
        }
      }
    }
  }

  const notices = await d.deliver(d.now());
  const retained = await d.retention(d.now());
  if (d.redis) await d.redis.set('connection-health:reconcile:heartbeat', d.now().toISOString(), 'EX', 3600);
  console.info(JSON.stringify({ event: 'connection_health_reconcile', durationMs: d.now().getTime() - started.getTime(), kinds, notices, retained }));
  return { kinds, notices, retained };
}
```

The `-30_000` slack keeps a 15-minute kind due on every 15-minute tick despite job jitter. The fake Redis `set` must accept the `'EX', 3600` arguments. Use the repo logger in place of `console.*` if Task 6 found one.

`jobs/connectionHealthReconcile.ts`, modelled on `aiBudgetAlertDelivery.ts:379`:

```ts
import { Queue, Worker } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';
import { runReconcile } from '../services/connectionHealth/reconcile';

export const CONNECTION_HEALTH_QUEUE = 'connection-health-reconcile';
let queue: Queue | null = null;
let worker: Worker | null = null;

export function getConnectionHealthQueue(): Queue {
  if (!queue) queue = new Queue(CONNECTION_HEALTH_QUEUE, { connection: getBullMQConnection() });
  return queue;
}

export async function initializeConnectionHealthReconcileWorker(): Promise<void> {
  if (worker) return;
  worker = new Worker(CONNECTION_HEALTH_QUEUE, async () => { await runReconcile(); }, { connection: getBullMQConnection(), concurrency: 1 });
  attachWorkerObservability(worker, CONNECTION_HEALTH_QUEUE);
  // Sub-hourly (every 15 minutes), so it is exempt from scheduleRegistry.ts.
  await getConnectionHealthQueue().add('reconcile', {}, {
    jobId: 'connection-health-reconcile',
    repeat: { pattern: '2,17,32,47 * * * *' },
    removeOnComplete: { count: 5 },
    removeOnFail: { count: 10 },
  });
}

export async function shutdownConnectionHealthReconcileWorker(): Promise<void> {
  await worker?.close(); worker = null;
  await queue?.close(); queue = null;
}
```

Check `attachWorkerObservability`'s signature (is the third argument optional?) in `jobs/workerObservability.ts`.

`workerRegistry.ts` entry:

```ts
  {
    name: 'connectionHealthReconcileWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/connectionHealthReconcile');
      return { init: m.initializeConnectionHealthReconcileWorker, shutdown: m.shutdownConnectionHealthReconcileWorker };
    },
  },
```

Add `'connectionHealthReconcileWorker'` at the same position in `EXPECTED_WORKER_NAMES` and `EXPECTED_NAMES`, and add the manifest line.

- [ ] **Step 4: End-to-end integration test**

`connectionHealthReconcile.integration.test.ts`, with real DB, real OAuth source and fake Redis:

```ts
it('end to end: reuse-revoked grant → incident + notices to owner and admin → re-consent → resolved after two runs → notices read', async () => {
  // seed partner P, admin u1 (connected_apps:manage, all), owner o1, revoked grant (reuse, 1 day ago)
  const redis = fakeRedis(); redis.store.set('connection-health:kind:oauth_grant:seeded', '1');
  await runReconcile({ redis, now: () => T0 });
  expect(await noticesFor(['u1', 'o1'])).toHaveLength(2);
  await seedGrant({ accountId: o1, clientId, createdAt: T0 });            // re-consent
  await runReconcile({ redis, now: () => plusMin(T0, 15) });              // healthy 1
  await runReconcile({ redis, now: () => plusMin(T0, 30) });              // healthy 2 → resolved
  const [inc] = await asSystem(() => db.select().from(connectionHealthIncidents));
  expect(inc).toMatchObject({ resolution: 'recovered', pendingNotice: null });
  expect((await noticesFor(['u1', 'o1'])).every((n) => n.read)).toBe(true);
});
it('a tracked incident whose grants were deleted is retired', async () => {
  const redis = fakeRedis(); redis.store.set('connection-health:kind:oauth_grant:seeded', '1');
  await asSystem(() => insertRow({ sourceId: `${o1}:vanished-client`, openedAt: T0 }));
  await runReconcile({ redis, now: () => plusMin(T0, 15) });
  const [inc] = await asSystem(() => db.select().from(connectionHealthIncidents).where(eq(connectionHealthIncidents.sourceId, `${o1}:vanished-client`)));
  expect(inc).toMatchObject({ resolution: 'retired' });
});
it('first run seeds without notices', async () => {
  await runReconcile({ redis: fakeRedis(), now: () => T0 });
  expect(await asSystem(() => db.select().from(connectionHealthIncidents))).toHaveLength(1);
  expect(await noticesFor(['u1', 'o1'])).toHaveLength(0);
});
```

- [ ] **Step 5: Run everything for this task**

Run:
```bash
cd apps/api
npx vitest run src/services/connectionHealth src/services/workerRegistry.test.ts src/services/workerEntrypointClosure.contract.test.ts src/jobs/workerReadinessManifest.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/connectionHealthReconcile.integration.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/connectionHealth/reconcile.ts apps/api/src/services/connectionHealth/reconcile.test.ts apps/api/src/jobs/connectionHealthReconcile.ts apps/api/src/services/workerRegistry.ts apps/api/src/services/workerRegistry.test.ts apps/api/src/services/workerEntrypointClosure.contract.test.ts apps/api/src/jobs/workerReadinessManifest.ts apps/api/src/__tests__/integration/connectionHealthReconcile.integration.test.ts
git commit -m "feat(connection-health): 15-minute reconciler with budget, failure alerts and heartbeat (#8845)"
```

---

### Task 9: Read API

**Files:**
- Create: `apps/api/src/routes/connectionHealth.ts`
- Modify: `apps/api/src/index.ts` (mount next to `api.route('/edr', edrRoutes);`, `:859`)
- Test: `apps/api/src/routes/connectionHealth.test.ts`

**Interfaces:**
- Produces: `connectionHealthRoutes`. `GET /api/v1/connection-health/incidents?status=open|recent` (default `open`; `recent` = resolved in the last 7 days).
  - Scope: `partner` and `system`.
  - Gate: `requirePermission(PERMISSIONS.ORGS_READ)`.
  - Rows are filtered by RLS (request context), then by `hasPermission(perms, view_permission)`.
  - Response: `{ data: Array<{ id, sourceKind, orgId, condition, severity, detail, displayName, fixHref, firstFailedAt, openedAt, lastObservedAt, resolvedAt, resolution }> }`.
  - Pending rows (`opened_at IS NULL`) are never returned. There are no write methods.

- [ ] **Step 1: Write the failing route test**

Follow `routes/devices/billing.test.ts`'s auth and db mocking:

```ts
// The db mock returns whatever `rowsMock` holds; the route's WHERE does the
// pending/resolved filtering in SQL, so the tests also assert the built query.
it('returns only incidents whose view permission the caller holds', async () => {
  rowsMock.mockResolvedValue([row({ id: 'a', viewPermission: 'connected_apps:read' }), row({ id: 'b', viewPermission: 'backup:read' })]);
  const res = await get('/connection-health/incidents', partnerAuth({ permissions: [{ resource: 'organizations', action: 'read' }, { resource: 'connected_apps', action: 'read' }] }));
  expect(res.status).toBe(200);
  expect((await res.json()).data.map((d: { id: string }) => d.id)).toEqual(['a']);
});
it('system scope sees every row without the permission filter', async () => {
  rowsMock.mockResolvedValue([row({ id: 'a' }), row({ id: 'b', viewPermission: 'backup:read' })]);
  const res = await get('/connection-health/incidents', systemAuth());
  expect((await res.json()).data).toHaveLength(2);
});
it('status=recent queries resolved rows from the last 7 days', async () => {
  rowsMock.mockResolvedValue([]);
  await get('/connection-health/incidents?status=recent', partnerAuth());
  expect(lastWhereSql()).toMatch(/resolved_at.*is not null/i);
});
it('rejects organization scope with 403', async () => {
  const res = await get('/connection-health/incidents', orgAuth());
  expect(res.status).toBe(403);
});
it('exposes no write methods', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = await app.request('/connection-health/incidents', { method, headers: authHeaders });
    expect([404, 405]).toContain(res.status);
  }
});
it('rejects an unknown status value with 400', async () => {
  expect((await get('/connection-health/incidents?status=all', partnerAuth())).status).toBe(400);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/connectionHealth.test.ts`
Expected: FAIL; the module is missing.

- [ ] **Step 3: Implement**

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, gt, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../db';
import { connectionHealthIncidents as chi } from '../db/schema';
import { authMiddleware, requirePermission, requireScope } from '../middleware/auth';
import { PERMISSIONS, hasPermission } from '../services/permissions';
import { permissionFromText } from '../services/connectionHealth/store';

const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const query = z.object({ status: z.enum(['open', 'recent']).default('open') });

export const connectionHealthRoutes = new Hono();
connectionHealthRoutes.use('*', authMiddleware);

connectionHealthRoutes.get('/incidents',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  zValidator('query', query),
  async (c) => {
    const { status } = c.req.valid('query');
    const perms = c.get('permissions');
    const where = status === 'open'
      ? and(isNull(chi.resolvedAt), isNotNull(chi.openedAt))
      : and(isNotNull(chi.resolvedAt), isNotNull(chi.openedAt), gt(chi.resolvedAt, new Date(Date.now() - RECENT_MS)));
    const rows = await db.select().from(chi).where(where).orderBy(desc(chi.openedAt)).limit(500);
    const auth = c.get('auth');
    const data = rows
      .filter((r) => {
        if (auth.scope === 'system') return true;
        const p = permissionFromText(r.viewPermission);
        return !!perms && hasPermission(perms, p.resource, p.action);
      })
      .map((r) => ({
        id: r.id, sourceKind: r.sourceKind, orgId: r.orgId, condition: r.condition, severity: r.severity,
        detail: r.detail, displayName: r.displayName, fixHref: r.fixHref, firstFailedAt: r.firstFailedAt,
        openedAt: r.openedAt, lastObservedAt: r.lastObservedAt, resolvedAt: r.resolvedAt, resolution: r.resolution,
      }));
    return c.json({ data });
  });
```

Match the repo's zod validator import and its error shape for 400s: look at how neighbouring routes validate queries, and whether there is a shared `validateQuery` helper or `ERROR_CODES`. Mount it with `api.route('/connection-health', connectionHealthRoutes);`. If a route-mount-order or route-inventory test exists (`grep -rln "api.route(" apps/api/src/*.test.ts apps/api/src/__tests__ | head`), register the route there too.

- [ ] **Step 4: Run to verify it passes**

Run the Step 2 command, plus any route-inventory test you touched. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/connectionHealth.ts apps/api/src/routes/connectionHealth.test.ts apps/api/src/index.ts
git commit -m "feat(connection-health): read-only incidents API (#8845)"
```

---

### Task 10: Full verification and PR

- [ ] **Step 1: Rebase and re-check the migration ordering**

```bash
git fetch origin && git rebase origin/main
git ls-tree --name-only origin/main apps/api/migrations/ | grep -E '/2' | sort | tail -1
```
If anything sorts after `2026-12-29-100100-…`, rename both new migrations so they sort last (they haven't shipped yet), then re-run Task 3 Step 6.

- [ ] **Step 2: Full suites**

```bash
pnpm test-stack up
cd apps/api && npx vitest run                                   # full API unit (catches orgMerge.test.ts)
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/connectionHealth* src/__tests__/integration/userNotificationsRls.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
pnpm db:check-drift
cd ../web && npx vitest run src/components/layout
cd ../.. && npx tsc --build apps/api/tsconfig.tests.json; echo "tsc exit $?"
pnpm test-stack down
```
Expected: everything green and tsc exit 0. Don't pipe tsc to `tail`, because a heap OOM looks green that way.

- [ ] **Step 3: Verify as `breeze_app` (tenancy-rls workflow step 6)**

With the test stack up, connect as `breeze_app`, set a partner context for partner P, and attempt `INSERT INTO connection_health_incidents (…partner_id = Q…)`. Expected: `new row violates row-level security policy`.

- [ ] **Step 4: Open the PR**

Branch: `feature/8844-connection-health/wave-8845`. Run `start_wave` (feature-lifecycle) before the first push. The PR body has these sections:
- **Summary.** What W1 does, plus the spec amendments (three columns, heartbeat UI moved to W2).
- **Merge danger:** two-way door. New table, new enum value, new global worker. Blast radius: in-app notices to partner connected-app admins and grant owners.
- **Testing:** the list from Step 2.
- **Settings rule 9:** N/A; W1 adds no setting.
- `Closes #8845`.

---

## Self-review notes (plan author)

- **Spec coverage, W1 scope:**
  - §1.1 contract → Task 2
  - §1.2 transitions, reopen, seed → Tasks 2 and 8
  - §1.3 index-backed broken set → Task 3 (`oauth_grants_auto_revoked_idx`) and Task 7; cadence and budget → Task 8. Nudges are W4.
  - §2.1 → Task 3
  - §2.4 notification type → Task 1
  - §3 OAuth → Task 7
  - §4 in-app recipients, dedupe, mark-read → Tasks 5 and 6
  - §8 → Task 8 (the `/admin/system` UI moves to W2, as noted)
  - Read API → Task 9
- **Not in W1:** digest (§4 email, §5, §6, §2.2, §2.3) → W3. Sanitizer §7 → W2; the OAuth source carries no provider text.
- **Type names used across tasks:** `planTransitions`, `TrackedIncident`, `TransitionAction`, `loadTracked`, `applyActions`, `deleteExpiredResolved`, `permissionToText`/`permissionFromText`, `resolvePartnerUsersWithPermission`, `resolveIncidentRecipients`, `deliverPendingNotices`, `noticeDedupeKeys`, `oauthGrantSource`, `HEALTH_SOURCES`, `runReconcile`, `runKindInSystemScope`, `connectionHealthRoutes`. Each is defined once in its producing task.
