import './setup';

import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { auditLogs, deviceCommands, devices, enrollmentKeys, organizations, partners } from '../../db/schema';
import { sweepOffboardingTenants } from '../../services/tenantOffboarding';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

/**
 * #4036 — the offboarding repair's `FOR UPDATE` on the tenant row, proved
 * against real Postgres with a second, uncommitted transaction.
 *
 * WHY THIS EXISTS. #4034 made `repairIncompleteEntry` re-read `status` +
 * `offboarding_started_at` under its row lock and abandon when the precondition
 * has moved (#4022). Six real-Postgres cases cover that recheck in
 * `offboardingRepairRecheck.integration.test.ts` — but every abort there
 * COMMITS before the repair starts, so the recheck alone catches all of them
 * and deleting `.for('update')` leaves that file green.
 *
 * The lock is nonetheless load-bearing: it is the only reason the values the
 * recheck reads cannot change between the check and the drain prep, queue and
 * stamp that follow. And it only holds because `withSystemDbAccessContext` →
 * `withDbAccessContext` opens a real transaction and keeps it open for the
 * whole callback to keep the `SET LOCAL` RLS GUCs alive (`db/index.ts`), with
 * the sweep calling the repair inside that callback. So the lock's lifetime is
 * a side effect of how RLS context is established: any future change to that
 * mechanism — per-statement context, a connection-scoped GUC, a pool-level
 * `SET` — silently reverts #4022 with a fully green suite.
 *
 * THE RACE STAGED HERE is the one the committed-abort cases cannot reach:
 *
 *     sweep:    SELECT candidates -> {org, startedAt: null}   (committed read)
 *     operator: UPDATE organizations SET status='active'      (NOT yet committed)
 *     sweep:    repairIncompleteEntry -> SELECT ... FOR UPDATE  <-- must BLOCK
 *     operator: COMMIT
 *     sweep:    re-read under the lock -> 'active' -> abandon
 *
 * Without `.for('update')` the repair does not queue behind the operator: it
 * reads its own snapshot (still `offboarding`, still unstamped), runs drain
 * prep, queues fresh `self_uninstall` rows and stamps the row — against a
 * tenant that commits to `active` moments later, where `getAgentTenantState`
 * no longer reports `'draining'` and the fleet collects those uninstalls as
 * ordinary commands. The audit row records `offboarding_entry_repaired` with a
 * success result, so nothing looks wrong afterwards. That is #4022 exactly.
 *
 * HARNESS. A dedicated postgres.js client stages the operator's abort as an
 * uncommitted `UPDATE` (taking the tenant row's exclusive lock), the real
 * `sweepOffboardingTenants` entry point is driven against the app pool, and
 * `pg_blocking_pids` — scoped to the holder's OWN backend pid, so a sibling
 * worktree's traffic cannot satisfy it — proves the sweep is genuinely queued
 * behind that row before the abort commits.
 *
 * TWO LAYERS OF DISCRIMINATION, because the barrier alone is not enough:
 *
 *  1. The BLOCKED STATEMENT's text must be the repair's `SELECT ... FOR
 *     UPDATE`. Deleting the lock does not stop the sweep from blocking on this
 *     row eventually — the repair's closing `UPDATE organizations SET
 *     offboarding_started_at = ...` blocks on it too — but it blocks AFTER the
 *     drain prep and the queue, and it arrives as an `update`, not a locking
 *     select. Asserting the text is what keeps this from passing on the
 *     lock-free code.
 *  2. The COMMITTED OUTCOME: no uninstall queued, no stamp, no audit row, and
 *     the enrollment key still unexpired (the probe that proves drain prep
 *     never ran at all — see the recheck suite's note on why the audit row
 *     alone cannot cover that).
 *
 * VERIFIED TO DISCRIMINATE — two mutation runs against `repairIncompleteEntry`,
 * both restored afterwards:
 *
 *  1. `.for('update')` DELETED from both selects. All three barrier cases red.
 *     The blocked statement is reported as `update "organizations" set ...
 *     "offboarding_started_at" = now()` (and the `partners` equivalent) — the
 *     closing stamp, not the locking select — and the abort cases then fail the
 *     committed-outcome assertion with one `self_uninstall` queued against the
 *     rescued tenant. The positive control stays green, as it must: it never
 *     contends for the row.
 *  2. `.for('update', { skipLocked: true })` — a plausible "optimization" that
 *     silently turns contention into a zero-row read. All three barrier cases
 *     red in ~200ms each, on the sweep-completion arm of the race rather than
 *     on the poll, because a sweep that FINISHES while the row is held proves
 *     the repair never queued behind it.
 *
 * The layer-1 assertions are `expect.soft` precisely so a future regression
 * reports both halves in one run instead of stopping at the first.
 *
 * FOUR CASES. Two abort barriers (organization and partner — `.for('update')`
 * appears at two separate call sites in `repairIncompleteEntry`, so pinning
 * only one leaves the other uncovered), then:
 *
 *  - THE OTHER ALLOWED OUTCOME: the same barrier with a BENIGN uncommitted
 *    write, where the repair waits, re-reads, finds the entry still torn and
 *    must PROCEED. Blocking is only half the contract — a repair that queued
 *    correctly and then abandoned anyway would still be a silent no-op of the
 *    #2774 class, and no other case here asserts that second half: the two
 *    abort cases expect abandon by construction, and the positive control never
 *    contends for the row at all.
 *
 *    Stated precisely, because it is easy to overclaim: this case is not known
 *    to be the SOLE catcher of any particular regression. Both mutations tried
 *    below red it together with the abort cases. It is here to cover the second
 *    of the two allowed outcomes, which would otherwise be untested.
 *  - THE POSITIVE CONTROL, with nothing holding the row at all. It is what
 *    keeps the barrier cases from passing vacuously: it proves this file's
 *    `sweepOffboardingTenants` entry point really does reach the repair for a
 *    torn tenant, so a barrier that observed nothing is a genuine regression
 *    rather than a sweep that silently skipped the candidate.
 *
 * The fixtures and probes below are duplicated from
 * `offboardingRepairRecheck.integration.test.ts` on purpose (CLAUDE.md permits
 * local helper duplication). One caveat for anyone reading both: `repairAudits`
 * shares that file's NAME but not its filter — this one keys on
 * `resourceId` + a scope-derived action so it can serve the partner cases too.
 */

const RUN = !!process.env.DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

// ---------------------------------------------------------------------------
// Race harness (pattern: orgCurrencyCreationBarrier.integration.test.ts)
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function closeRaceClients(...clients: Sql[]): Promise<void> {
  const results = await Promise.allSettled(clients.map((c) => c.end({ timeout: 1 })));
  const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
  if (failures.length > 0) throw new AggregateError(failures, 'failed to close race client(s)');
}

/**
 * Wait until some backend is blocked BY `holderPid` specifically, and return
 * the statement it is stuck on.
 *
 * Scoping to the holder's own pid, rather than counting "any blocked backend"
 * as the currency barrier does: requiring the holder in the blocking set is
 * strictly stronger, and it keeps the assertion unsatisfiable by unrelated lock
 * waits on a shared default `:5433` (a per-worktree `pnpm test-stack` cluster
 * would not show them at all, but this must not depend on which stack it runs
 * against). The holder is idle-in-transaction and never blocked itself, so the
 * only backend that can match is the sweep queued behind the tenant row.
 *
 * Reads `a.query`, which requires the poller to be superuser or the same role
 * — `getTestDb()` is the bootstrap superuser `breeze_test`, and the sweep runs
 * as `breeze_app`. Under a non-privileged poller `state` and `query` would both
 * come back NULL, the `state = 'active'` filter would drop every row, and this
 * would time out rather than fail loudly, so the privilege is load-bearing.
 */
async function waitForStatementBlockedBy(holderPid: number, what: string): Promise<string> {
  const admin = getTestDb();
  const deadline = Date.now() + 15_000;
  for (;;) {
    const rows = await admin.execute<{ query: string }>(sql`
      SELECT a.query AS query
      FROM pg_catalog.pg_stat_activity a
      WHERE a.state = 'active'
        AND ${holderPid}::int4 = ANY (pg_catalog.pg_blocking_pids(a.pid))
      ORDER BY a.query_start
      LIMIT 1
    `);
    const query = rows[0]?.query;
    if (query) return query;
    if (Date.now() > deadline) {
      // Deliberately does NOT name a cause. A sweep that is still running at
      // 15s without ever appearing blocked could be a missing lock OR a loaded
      // box that has not reached the repair yet, and this poll cannot tell them
      // apart. The caller's `Promise.race` against the sweep itself is what
      // diagnoses the missing lock, because a COMPLETED sweep proves it.
      throw new Error(
        `${what}: no statement was observed queued behind the tenant row within 15s, and the ` +
        'sweep had not finished either — could not confirm the repair took the row lock (#4036)'
      );
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

type SweepResult = Awaited<ReturnType<typeof sweepOffboardingTenants>>;

/** The benign holder's write — a rename, which moves nothing the recheck reads. */
const BENIGN_RENAME = 'renamed-under-the-barrier';

/**
 * Runs the real sweep while a dedicated client holds an UNCOMMITTED write on
 * the tenant row. Asserts the sweep blocks, then commits that write and returns
 * the sweep's result together with the statement it was stuck on.
 *
 * `write` picks which contention is staged, and both take the same
 * `FOR NO KEY UPDATE` row lock, so the barrier half is identical:
 *   - `abort`  — `SET status = 'active'`, the operator rescuing the tenant.
 *     The repair must re-read under its lock and ABANDON.
 *   - `benign` — a rename. Nothing the recheck predicate reads has moved, so
 *     the repair must re-read under its lock and PROCEED. This is the other
 *     allowed outcome, and the only case that would catch an over-strict
 *     recheck (or a move to REPEATABLE READ, where the re-read raises 40001
 *     instead of seeing the new row version) silently turning every contended
 *     repair into a no-op — with both abort cases still green.
 */
async function sweepAgainstUncommittedWrite(
  scope: 'organization' | 'partner',
  id: string,
  write: 'abort' | 'benign',
  what: string,
): Promise<{ result: SweepResult; blockedQuery: string }> {
  const lockHeld = deferred<number>();
  const release = deferred<void>();
  const holder = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  let holderWork: Promise<void> | undefined;
  let running: Promise<SweepResult> | undefined;
  try {
    holderWork = holder.begin(async (tx) => {
      const [row] = await tx<{ pid: number }[]>`SELECT pg_backend_pid()::int4 AS pid`;
      // Taken BEFORE the barrier is signalled, so the lock is provably held by
      // the time the sweep starts. The transaction commits when this callback
      // returns, i.e. only after `release`.
      if (scope === 'organization') {
        if (write === 'abort') {
          await tx`UPDATE public.organizations SET status = 'active' WHERE id = ${id}`;
        } else {
          await tx`UPDATE public.organizations SET name = ${BENIGN_RENAME} WHERE id = ${id}`;
        }
      } else if (write === 'abort') {
        await tx`UPDATE public.partners SET status = 'active' WHERE id = ${id}`;
      } else {
        await tx`UPDATE public.partners SET name = ${BENIGN_RENAME} WHERE id = ${id}`;
      }
      lockHeld.resolve(row!.pid);
      await release.promise;
    });
    // Pre-attached so a holder failure is never an unhandled rejection. The
    // race and the `await holderWork` below surface it on the normal paths;
    // the `finally`'s allSettled deliberately swallows it, because by then the
    // primary error has already won.
    holderWork.catch(() => { /* see above */ });
    const holderPid = await Promise.race([
      lockHeld.promise,
      holderWork.then(() => { throw new Error(`${what}: holder transaction ended before it took the row lock`); }),
    ]);

    // The sweep's candidate select reads the COMMITTED row, so it still sees
    // {offboarding, startedAt: null} and hands the repair that stale snapshot —
    // which is the whole point: this is the window #4022 lives in.
    running = sweepOffboardingTenants(new Date());
    // Raced against the sweep itself, not just polled: a sweep that RUNS TO
    // COMPLETION while another transaction holds the tenant row proves the
    // repair never queued behind it. That is a fact this can establish, unlike
    // the poll's timeout, and it fails in milliseconds instead of 15s.
    // `Promise.race` subscribes to both arms, so neither derived rejection can
    // escape as unhandled once the race has settled.
    const blockedQuery = await Promise.race([
      waitForStatementBlockedBy(holderPid, what),
      running.then(() => {
        throw new Error(
          `${what}: the sweep ran to completion while another transaction held the tenant row ` +
          '— the repair never queued behind it, so it read status/stamp WITHOUT the row lock ' +
          'and a tenant rescued mid-sweep can still be drained (#4036)'
        );
      }),
    ]);
    release.resolve();
    await holderWork;
    return { result: await running, blockedQuery };
  } finally {
    release.resolve();
    if (holderWork) await Promise.allSettled([holderWork]);
    // Drain the sweep before returning. On a failure path it is still blocked
    // on the holder, and the line above has just released it — leaving it in
    // flight lets a writer that touches enrollment_keys, devices,
    // device_commands, organizations AND Redis run straight into the NEXT
    // file's `beforeEach` TRUNCATE ... CASCADE. Files run sequentially and the
    // setup retries deadlocks only three times, so an orphan here fails an
    // unrelated suite.
    if (running) await Promise.allSettled([running]);
    await closeRaceClients(holder);
  }
}

// ---------------------------------------------------------------------------
// Fixtures + probes (shapes mirror offboardingRepairRecheck.integration.test.ts)
// ---------------------------------------------------------------------------

async function seedDevice(orgId: string, siteId: string, label: string): Promise<string> {
  const [row] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `agent-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      hostname: `host-${label}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'offline',
    })
    .returning({ id: devices.id });
  return row!.id;
}

/**
 * `prepareAgentDrainForOrgIds` expires every unexpired enrollment key for the
 * org. A far-future expiry therefore makes drain prep DB-observable: the audit
 * row cannot serve as that probe (it is written only after prep, queue and
 * stamp, and `writeAuditEvent` is fire-and-forget), so this is what proves the
 * repair abandoned before touching anything rather than merely before the
 * audit.
 */
const FAR_FUTURE = new Date('2099-01-01T00:00:00Z');

async function seedEnrollmentKey(orgId: string, label: string): Promise<string> {
  const [row] = await getTestDb()
    .insert(enrollmentKeys)
    .values({
      orgId,
      name: `key-${label}`,
      key: `k-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      expiresAt: FAR_FUTURE,
    })
    .returning({ id: enrollmentKeys.id });
  return row!.id;
}

async function keyStillUnexpired(keyId: string): Promise<boolean> {
  const [row] = await getTestDb()
    .select({ expiresAt: enrollmentKeys.expiresAt })
    .from(enrollmentKeys)
    .where(eq(enrollmentKeys.id, keyId));
  return row?.expiresAt?.getTime() === FAR_FUTURE.getTime();
}

async function repairAudits(scope: 'organization' | 'partner', scopeId: string): Promise<number> {
  const rows = await getTestDb()
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.action, `${scope}.offboarding_entry_repaired`),
        eq(auditLogs.resourceId, scopeId)
      )
    );
  return rows.length;
}

async function pendingUninstalls(deviceId: string): Promise<number> {
  const rows = await getTestDb()
    .select({ id: deviceCommands.id })
    .from(deviceCommands)
    .where(and(eq(deviceCommands.deviceId, deviceId), eq(deviceCommands.type, 'self_uninstall')));
  return rows.length;
}

async function orgState(
  orgId: string
): Promise<{ status: string; startedAt: Date | null; name: string } | undefined> {
  const [row] = await getTestDb()
    .select({
      status: organizations.status,
      startedAt: organizations.offboardingStartedAt,
      name: organizations.name,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return row;
}

async function partnerState(partnerId: string): Promise<{ status: string; startedAt: Date | null } | undefined> {
  const [row] = await getTestDb()
    .select({ status: partners.status, startedAt: partners.offboardingStartedAt })
    .from(partners)
    .where(eq(partners.id, partnerId));
  return row;
}

/** The torn state the sweep looks for: offboarding, no drain stamp. */
async function tearOrg(orgId: string): Promise<void> {
  await getTestDb()
    .update(organizations)
    .set({ status: 'offboarding', offboardingStartedAt: null })
    .where(eq(organizations.id, orgId));
}

async function tearPartner(partnerId: string): Promise<void> {
  await getTestDb()
    .update(partners)
    .set({ status: 'offboarding', offboardingStartedAt: null })
    .where(eq(partners.id, partnerId));
}

// ---------------------------------------------------------------------------

describe.runIf(RUN)('#4036 — the offboarding repair blocks on the tenant row it rechecks', () => {
  it('organization: the repair queues behind an uncommitted abort and abandons once it commits', async () => {
    const partner = await createPartner({ status: 'active' });
    const org = await createOrganization({ partnerId: partner.id, status: 'active' });
    const site = await createSite({ orgId: org.id });
    const deviceId = await seedDevice(org.id, site.id, 'org-lock');
    const keyId = await seedEnrollmentKey(org.id, 'org-lock');
    await tearOrg(org.id);

    const { result, blockedQuery } = await sweepAgainstUncommittedWrite(
      'organization', org.id, 'abort', 'organization repair'
    );

    // Layer 1: it is the LOCKING SELECT that waited, not the closing stamp
    // UPDATE. A repair that read the row unlocked still blocks here — but only
    // after it has already prepped the drain and queued the uninstalls.
    const q = blockedQuery.toLowerCase();
    expect.soft(q, `blocked on "${blockedQuery}" — expected the repair's locking SELECT`).toContain('for update');
    // Defense in depth rather than a third discriminating leg: `queueDrainUninstalls`
    // also takes `devices FOR UPDATE`, and this rules that out — though the holder's
    // non-key UPDATE cannot actually block a child-row write's FOR KEY SHARE.
    expect.soft(q, `blocked on "${blockedQuery}" — expected a lock on organizations`).toContain('organizations');
    expect.soft(q.startsWith('select'), `blocked on "${blockedQuery}" — a bare UPDATE means the lock is gone`).toBe(true);

    // Layer 2: nothing was done to the rescued tenant.
    // `failures` DOES discriminate — a throw out of the repair, or a 40001 from
    // the re-read, flips it. `orgsFinalized` does not: the repair branch returns
    // before finalizing either way, so it is a shape check, not a discriminator.
    expect(result.failures).toBe(0);
    expect(result.orgsFinalized).toBe(0);
    expect(await pendingUninstalls(deviceId)).toBe(0);
    // Secondary only: `writeAuditEvent` is fire-and-forget, so its ABSENCE can
    // never false-fail — the enrollment key below is the probe that carries
    // the weight, because drain prep expires it synchronously.
    expect(await repairAudits('organization', org.id)).toBe(0);
    expect(await keyStillUnexpired(keyId), 'drain prep ran against a rescued tenant').toBe(true);

    const after = await orgState(org.id);
    expect(after?.status).toBe('active');
    expect(after?.startedAt).toBeNull();
  });

  it('partner: the repair queues behind an uncommitted abort and abandons once it commits', async () => {
    const partner = await createPartner({ status: 'active' });
    const org = await createOrganization({ partnerId: partner.id, status: 'active' });
    const site = await createSite({ orgId: org.id });
    const deviceId = await seedDevice(org.id, site.id, 'partner-lock');
    const keyId = await seedEnrollmentKey(org.id, 'partner-lock');
    // Only the PARTNER is torn — the child org stays active so the sweep's org
    // pass has nothing to do and the partner pass is the only repair in play.
    await tearPartner(partner.id);

    const { result, blockedQuery } = await sweepAgainstUncommittedWrite(
      'partner', partner.id, 'abort', 'partner repair'
    );

    const q = blockedQuery.toLowerCase();
    expect.soft(q, `blocked on "${blockedQuery}" — expected the repair's locking SELECT`).toContain('for update');
    expect.soft(q, `blocked on "${blockedQuery}" — expected a lock on partners`).toContain('partners');
    expect.soft(q.startsWith('select'), `blocked on "${blockedQuery}" — a bare UPDATE means the lock is gone`).toBe(true);

    expect(result.failures).toBe(0);
    // Shape check, not a discriminator — see the organization case above.
    expect(result.partnersFinalized).toBe(0);
    expect(await pendingUninstalls(deviceId)).toBe(0);
    // Secondary only, same reason as the organization case above.
    expect(await repairAudits('partner', partner.id)).toBe(0);
    expect(await keyStillUnexpired(keyId), 'drain prep ran against a rescued tenant').toBe(true);

    const after = await partnerState(partner.id);
    expect(after?.status).toBe('active');
    expect(after?.startedAt).toBeNull();
  });

  it('organization: a repair that waits on the row and still finds it torn PROCEEDS', async () => {
    const partner = await createPartner({ status: 'active' });
    const org = await createOrganization({ partnerId: partner.id, status: 'active' });
    const site = await createSite({ orgId: org.id });
    const deviceId = await seedDevice(org.id, site.id, 'org-benign');
    const keyId = await seedEnrollmentKey(org.id, 'org-benign');
    await tearOrg(org.id);

    // Same barrier, benign contention: the holder renames the org, so when the
    // repair finally takes the lock the recheck predicate is still satisfied.
    const { result, blockedQuery } = await sweepAgainstUncommittedWrite(
      'organization', org.id, 'benign', 'organization repair (benign contention)'
    );

    const q = blockedQuery.toLowerCase();
    expect.soft(q, `blocked on "${blockedQuery}" — expected the repair's locking SELECT`).toContain('for update');
    expect.soft(q, `blocked on "${blockedQuery}" — expected a lock on organizations`).toContain('organizations');
    expect.soft(q.startsWith('select'), `blocked on "${blockedQuery}" — a bare UPDATE means the lock is gone`).toBe(true);

    expect(result.failures).toBe(0);
    // The repair WAITED and then did its job — the outcome no other case here
    // asserts (both abort cases expect abandon; the positive control never
    // contends). This is the assertion that would notice a repair which queues
    // on the row correctly and then declines to heal the entry anyway.
    expect(await pendingUninstalls(deviceId), 'the repair abandoned despite the entry still being torn').toBeGreaterThan(0);
    expect(await keyStillUnexpired(keyId)).toBe(false);

    const after = await orgState(org.id);
    expect(after?.status).toBe('offboarding');
    expect(after?.startedAt).not.toBeNull();
    // Proves the contention was real and committed mid-repair, not a no-op write.
    expect(after?.name).toBe(BENIGN_RENAME);
  });

  it('positive control: with nothing holding the row, the sweep repairs a genuinely torn organization', async () => {
    const partner = await createPartner({ status: 'active' });
    const org = await createOrganization({ partnerId: partner.id, status: 'active' });
    const site = await createSite({ orgId: org.id });
    const deviceId = await seedDevice(org.id, site.id, 'org-torn');
    const keyId = await seedEnrollmentKey(org.id, 'org-torn');
    await tearOrg(org.id);

    const result = await sweepOffboardingTenants(new Date());

    expect(result.failures).toBe(0);
    // The repair branch returns before finalizing; the NEXT sweep finalizes.
    expect(result.orgsFinalized).toBe(0);
    expect(await pendingUninstalls(deviceId)).toBeGreaterThan(0);
    // Deliberately NOT asserting the audit row here. `writeAuditEvent` is
    // fire-and-forget in the repair, so a present-row assertion is a race the
    // sweep's return gives no barrier for — it failed on the first green run.
    // The two synchronous effects below are the ones that actually pin
    // "the repair ran": the queue and the drain prep.
    expect(await keyStillUnexpired(keyId)).toBe(false);

    const after = await orgState(org.id);
    expect(after?.status).toBe('offboarding');
    expect(after?.startedAt).not.toBeNull();
  });
});
