/**
 * Real-Postgres (+ real BullMQ/Redis) integration coverage for the archive
 * purge sweeper and the tenant-erasure worker's status guard (org-lifecycle
 * Wave 4, Task 4 — review fix round 1, finding I1).
 *
 * The mocked unit suite (`tenantOffboarding.test.ts`) injects candidate rows
 * directly past every WHERE clause, so it has zero discriminating power over
 * the actual SQL predicates: a purge CAS that matched EVERY archived org
 * (not just overdue ones), or a warning-marker guard that never checked
 * `status = 'archived'`, would still pass every existing unit test. This
 * file drives the real `sweepOffboardingTenants` against genuine Postgres
 * rows — with control rows that must NOT be touched — and the real
 * tenant-erasure BullMQ worker against a genuine "still active" org, to
 * prove the guard that stands between a status regression and a live
 * tenant's data being erased.
 *
 * Follows `orgMerge.integration.test.ts`'s harness conventions: seed via
 * `db.insert(...)` under `withSystemDbAccessContext` (real `breeze_app` pool,
 * RLS-legal because system scope), assert with raw `db.execute(sql\`...\`)`
 * reads, and use the real `getTenantErasureQueue()` singleton to prove a job
 * was actually handed to BullMQ rather than merely intended in-process.
 * Unlike that file, `bullmq` is left ENTIRELY unmocked here — the erasure
 * worker's guard test needs a genuine `Worker` consuming from genuine Redis
 * to prove the guard runs the way it will in production, not the way a
 * hand-invoked processor closure would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql, type SQL } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { organizations, partners, partnerUsers, roles, users } from '../../db/schema';
import {
  ARCHIVE_PURGE_WARN_14_SENT_AT_KEY,
  sweepOffboardingTenants,
} from '../../services/tenantOffboarding';
import { OrgArchiveStateError, restoreOrgFromArchive } from '../../services/orgArchive';
import { createTenantErasureWorker, enqueueTenantErasure, getTenantErasureQueue } from '../../jobs/tenantErasure';

const { sendEmailMock, getEmailServiceMock } = vi.hoisted(() => ({
  sendEmailMock: vi.fn(async (_mail: { to: string[]; subject: string; text: string; html: string }) => undefined),
  getEmailServiceMock: vi.fn(),
}));

// Only the email transport is mocked (no real SMTP in the integration stack).
// Everything the sweep actually decides with — the archived-only CAS, the
// warning-marker CAS, the recipient join, the erasure enqueue — runs for
// real, against real Postgres and real BullMQ/Redis.
vi.mock('../../services/email', () => ({
  getEmailService: (...args: unknown[]) => getEmailServiceMock(...(args as [])),
}));

const DAY_MS = 24 * 60 * 60 * 1000;

async function query<T = Record<string, unknown>>(statement: SQL): Promise<T[]> {
  return withSystemDbAccessContext(async () => (await db.execute(statement)) as unknown as T[]);
}

/** A partner with one active Partner Admin — the recipient the warning pass resolves. */
async function seedPartnerWithAdmin(label: string) {
  const suffix = `${label}-${randomUUID().slice(0, 8)}`;
  const partnerId = randomUUID();
  const roleId = randomUUID();
  const adminUserId = randomUUID();
  await withSystemDbAccessContext(async () => {
    await db.insert(partners).values({ id: partnerId, name: `Purge MSP ${suffix}`, slug: `purge-msp-${suffix}` });
    await db.insert(roles).values({ id: roleId, partnerId, scope: 'partner', name: 'Partner Admin' });
    await db.insert(users).values({
      id: adminUserId,
      partnerId,
      orgId: null,
      email: `admin-${suffix}@x.test`,
      name: 'Admin',
      status: 'active',
    });
    await db.insert(partnerUsers).values({ partnerId, userId: adminUserId, roleId, orgAccess: 'all' });
  });
  return { partnerId, adminUserId };
}

async function insertOrg(opts: {
  partnerId: string;
  status: 'archived' | 'active';
  purgeAt: Date | null;
  name: string;
  settings?: Record<string, unknown>;
}): Promise<string> {
  const orgId = randomUUID();
  await withSystemDbAccessContext(async () => {
    await db.insert(organizations).values({
      id: orgId,
      partnerId: opts.partnerId,
      name: opts.name,
      slug: `org-${orgId.slice(0, 8)}`,
      status: opts.status,
      currencyCode: 'USD',
      purgeAt: opts.purgeAt,
      settings: opts.settings ?? {},
    });
  });
  return orgId;
}

async function orgRow(orgId: string): Promise<{ status: string; settings: Record<string, unknown> | null } | null> {
  const rows = await withSystemDbAccessContext(() =>
    db
      .select({ status: organizations.status, settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1)
  );
  return (rows[0] as { status: string; settings: Record<string, unknown> | null } | undefined) ?? null;
}

async function erasureJobFor(orgId: string) {
  return getTenantErasureQueue().getJob(`tenant-erasure-${orgId}`);
}

async function waitForJobState(jobId: string, states: string[], timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await getTenantErasureQueue().getJob(jobId);
    if (job) {
      const state = await job.getState();
      if (states.includes(state)) return job;
    }
    if (Date.now() >= deadline) {
      throw new Error(`job ${jobId} did not reach one of [${states.join(', ')}] within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('archive purge sweep + tenant-erasure guard against real Postgres/BullMQ', () => {
  let worker: ReturnType<typeof createTenantErasureWorker> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    sendEmailMock.mockResolvedValue(undefined);
    getEmailServiceMock.mockReturnValue({ sendEmail: sendEmailMock });
  });

  afterEach(async () => {
    if (worker) {
      await worker.close();
      worker = null;
    }
  });

  it(
    'CASes an overdue archived org to purging, hands it to real BullMQ erasure, and blocks restore — while future/NULL purge_at controls stay untouched',
    async () => {
      const { partnerId } = await seedPartnerWithAdmin('due');
      const now = new Date();

      const dueOrgId = await insertOrg({
        partnerId,
        status: 'archived',
        purgeAt: new Date(now.getTime() - 60 * 60 * 1000), // 1h overdue
        name: 'Overdue Co',
      });
      const futureOrgId = await insertOrg({
        partnerId,
        status: 'archived',
        purgeAt: new Date(now.getTime() + 30 * DAY_MS),
        name: 'Future Co',
      });
      const foreverOrgId = await insertOrg({
        partnerId,
        status: 'archived',
        purgeAt: null,
        name: 'Forever Co',
      });

      const result = await sweepOffboardingTenants(now);

      expect(result.failures).toBe(0);
      expect(result.archivePurgesEnqueued).toBe(1);

      const due = await orgRow(dueOrgId);
      expect(due?.status).toBe('purging');
      // Controls: the predicate must discriminate on BOTH purge_at direction
      // and NULL, not just "archived".
      expect((await orgRow(futureOrgId))?.status).toBe('archived');
      expect((await orgRow(foreverOrgId))?.status).toBe('archived');

      // Real BullMQ: only the overdue org was handed off.
      const dueJob = await erasureJobFor(dueOrgId);
      expect(dueJob, 'the overdue archived org was never enqueued for erasure').toBeTruthy();
      expect((dueJob!.data as { orgId: string }).orgId).toBe(dueOrgId);
      expect(await erasureJobFor(futureOrgId)).toBeFalsy();
      expect(await erasureJobFor(foreverOrgId)).toBeFalsy();

      // Restore is blocked once the org has left `archived`. A service-level
      // CAS failure is sufficient here — the route's own translation to a
      // 410 is not this file's contract to prove.
      await expect(
        restoreOrgFromArchive({ orgId: dueOrgId, actor: null })
      ).rejects.toBeInstanceOf(OrgArchiveStateError);
      // The untouched controls must still restore cleanly.
      await expect(
        restoreOrgFromArchive({ orgId: futureOrgId, actor: null })
      ).resolves.toBeTruthy();
    },
    30_000
  );

  it(
    "the real tenant-erasure worker refuses a still-active org and writes an org-less refusal audit, without touching the org",
    async () => {
      const { partnerId } = await seedPartnerWithAdmin('guard');
      const activeOrgId = await insertOrg({
        partnerId,
        status: 'active',
        purgeAt: null,
        name: 'Still Active',
      });
      const actorId = randomUUID();
      await withSystemDbAccessContext(() =>
        db.insert(users).values({
          id: actorId,
          partnerId,
          orgId: null,
          email: `actor-${randomUUID().slice(0, 8)}@x.test`,
          name: 'Actor',
          status: 'active',
        })
      );

      worker = createTenantErasureWorker();
      // A source-less, non-admin-attributed payload — exactly what a
      // regressed status guard would need to wrongly erase a live org.
      await enqueueTenantErasure({ orgId: activeOrgId, performedBy: actorId });
      const job = await waitForJobState(`tenant-erasure-${activeOrgId}`, ['completed', 'failed']);
      expect(await job.getState()).toBe('completed');
      expect((job.returnvalue as { skipped?: boolean; reason?: string } | undefined)).toMatchObject({
        skipped: true,
        reason: 'status_guard',
      });

      // Never touched: still `active`, not deleted, not cascaded.
      const org = await orgRow(activeOrgId);
      expect(org?.status).toBe('active');

      const audits = await query<{ org_id: string | null; resource_id: string; result: string }>(sql`
        SELECT org_id, resource_id, result FROM audit_logs
        WHERE action = 'tenant.erasure.refused_status_guard' AND resource_id = ${activeOrgId}::uuid`);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.org_id).toBeNull();
      expect(audits[0]!.result).toBe('failure');
    },
    30_000
  );

  it(
    'claims the 14-day warning marker and attempts a send at 10 days out; does nothing at 20 days out',
    async () => {
      const { partnerId } = await seedPartnerWithAdmin('warn');
      const now = new Date();

      const tenDayOrgId = await insertOrg({
        partnerId,
        status: 'archived',
        purgeAt: new Date(now.getTime() + 10 * DAY_MS),
        name: 'Ten Day Co',
      });
      const twentyDayOrgId = await insertOrg({
        partnerId,
        status: 'archived',
        purgeAt: new Date(now.getTime() + 20 * DAY_MS),
        name: 'Twenty Day Co',
      });

      const result = await sweepOffboardingTenants(now);
      expect(result.failures).toBe(0);

      const tenDay = await orgRow(tenDayOrgId);
      expect(tenDay?.settings?.[ARCHIVE_PURGE_WARN_14_SENT_AT_KEY]).toBeTruthy();
      const twentyDay = await orgRow(twentyDayOrgId);
      expect(twentyDay?.settings?.[ARCHIVE_PURGE_WARN_14_SENT_AT_KEY]).toBeFalsy();

      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      expect(sendEmailMock.mock.calls[0]![0]).toMatchObject({
        subject: expect.stringContaining('Ten Day Co'),
      });
    },
    30_000
  );
});
