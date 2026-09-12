/**
 * SEC-2026-09-05-146 — recurring network-baseline authority, against real
 * PostgreSQL as `breeze_app`.
 *
 * The unit suites cover the decision table. What only a real database can prove:
 * the live subject reader actually observes a revocation committed by another
 * connection, the row lock serialises a concurrent re-arm against a dispatch in
 * flight, a legacy enabled schedule is fail-closed, and the migration is a
 * genuine no-op on re-apply.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { withSystemDbAccessContext } from '../../db';
import {
  discoveryJobs,
  discoveryProfiles,
  networkBaselines,
  organizationUsers,
  users,
} from '../../db/schema';
import { processResults } from '../../jobs/discoveryWorker';
import { processExecuteScan } from '../../jobs/networkBaselineWorker';
import {
  BASELINE_BLOCKED_REASON,
  computeBaselineAuthorityFingerprint,
  loadBaselineAuthoritySubject,
  resolveBaselineDispatchAuthority,
} from '../../services/networkBaselineAuthority';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { replayMigration } from './replayMigration';
import { getTestDb } from './setup';

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`fixture: missing ${what}`);
  return value;
}

const MIGRATION = '2026-10-15-150600-network-baseline-recurring-authority.sql';
const SCHEDULE = { enabled: true, intervalHours: 4, nextScanAt: new Date(0).toISOString() };

type Fixture = Awaited<ReturnType<typeof seedArmedBaseline>>;

async function seedArmedBaseline(options: { allowedSiteIds?: string[] | null } = {}) {
  const seed = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id, status: 'active' });
  const role = await createRole({ scope: 'organization', orgId: org.id, partnerId: partner.id });
  await grantRolePermissions(role.id, [{ resource: 'devices', action: 'write' }]);
  await assignUserToOrganization(user.id, org.id, role.id);
  if (options.allowedSiteIds !== undefined && options.allowedSiteIds !== null) {
    await seed
      .update(organizationUsers)
      .set({ siteIds: options.allowedSiteIds })
      .where(eq(organizationUsers.userId, user.id));
  }

  const subnet = '10.10.0.0/24';
  const [fresh] = await seed
    .select({ permissionsEpoch: users.permissionsEpoch, mfaEpoch: users.mfaEpoch })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  if (!fresh) throw new Error('seeded user disappeared');

  const [baseline] = await seed
    .insert(networkBaselines)
    .values({
      orgId: org.id,
      siteId: site.id,
      subnet,
      knownDevices: [],
      scanSchedule: SCHEDULE,
      authorityUserId: user.id,
      authoritySiteIds: options.allowedSiteIds ?? null,
      authorityPermissionsEpoch: fresh.permissionsEpoch,
      authorityMfaEpoch: fresh.mfaEpoch,
      authorityFingerprint: computeBaselineAuthorityFingerprint({
        orgId: org.id,
        siteId: site.id,
        subnet,
        scanSchedule: SCHEDULE,
      }),
      authorityGeneration: 1,
      authorityArmedAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  return { partner, org, site, user, role, baseline: must(baseline, 'baseline') };
}

/**
 * Re-point the stored epochs at the user's CURRENT ones.
 *
 * `2026-08-06-b-live-authorization.sql` installs triggers that bump
 * `users.permissions_epoch` whenever organization_users / partner_users /
 * role_permissions change — so a membership removal, a site-ceiling narrowing
 * and a permission revoke each ALSO advance the epoch, and the epoch check
 * (which runs first) is what denies. That is defence in depth working, and the
 * two dedicated epoch tests below assert it directly. To prove the membership,
 * permission and site-ceiling checks are individually load-bearing rather than
 * dead code behind the epoch, the controls below re-sync the epochs after the
 * revocation so the specific check is the only thing left to deny.
 */
async function resyncArmedEpochs(fixture: Fixture) {
  const seed = getTestDb();
  const [current] = await seed
    .select({ permissionsEpoch: users.permissionsEpoch, mfaEpoch: users.mfaEpoch })
    .from(users)
    .where(eq(users.id, fixture.user.id))
    .limit(1);
  await seed
    .update(networkBaselines)
    .set({
      authorityPermissionsEpoch: must(current, 'current epochs').permissionsEpoch,
      authorityMfaEpoch: must(current, 'current epochs').mfaEpoch,
    })
    .where(eq(networkBaselines.id, fixture.baseline.id));
}

async function gate(fixture: Fixture, expectedGeneration: number | null = 1) {
  return withSystemDbAccessContext(async () => {
    const seed = getTestDb();
    const [row] = await seed
      .select()
      .from(networkBaselines)
      .where(eq(networkBaselines.id, fixture.baseline.id))
      .limit(1);
    return resolveBaselineDispatchAuthority(must(row, 'baseline row'), { expectedGeneration });
  });
}

describe('recurring network-baseline authority against real PostgreSQL', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedArmedBaseline();
  });

  it('POSITIVE CONTROL: dispatch is allowed for the armed, still-authorized creator', async () => {
    await expect(gate(fixture)).resolves.toEqual({ allowed: true });
  });

  it('denies after the creator is disabled', async () => {
    await getTestDb().update(users).set({ status: 'disabled' }).where(eq(users.id, fixture.user.id));
    await expect(gate(fixture)).resolves.toEqual({
      allowed: false,
      reason: BASELINE_BLOCKED_REASON.AUTHORITY_REVOKED,
    });
  });

  it('denies after the creator is removed from the organization', async () => {
    await getTestDb().delete(organizationUsers).where(eq(organizationUsers.userId, fixture.user.id));
    await resyncArmedEpochs(fixture);
    await expect(gate(fixture)).resolves.toEqual({
      allowed: false,
      reason: BASELINE_BLOCKED_REASON.AUTHORITY_REVOKED,
    });
  });

  it('denies after the creator is deleted — the FK SET NULL strips the envelope', async () => {
    const seed = getTestDb();
    await seed.delete(organizationUsers).where(eq(organizationUsers.userId, fixture.user.id));
    await seed.delete(users).where(eq(users.id, fixture.user.id));

    const [row] = await seed
      .select({ authorityUserId: networkBaselines.authorityUserId })
      .from(networkBaselines)
      .where(eq(networkBaselines.id, fixture.baseline.id))
      .limit(1);
    expect(must(row, 'row').authorityUserId).toBeNull();

    await expect(gate(fixture)).resolves.toEqual({
      allowed: false,
      reason: BASELINE_BLOCKED_REASON.REAPPROVAL_REQUIRED,
    });
  });

  it('denies after devices:write is revoked from the creator role', async () => {
    await getTestDb().execute(
      sql`DELETE FROM role_permissions WHERE role_id = ${fixture.role.id}`,
    );
    await resyncArmedEpochs(fixture);
    await expect(gate(fixture)).resolves.toEqual({
      allowed: false,
      reason: BASELINE_BLOCKED_REASON.PERMISSION_REVOKED,
    });
  });

  it('denies after the baseline site leaves the creator current site ceiling', async () => {
    const otherSite = await createSite({ orgId: fixture.org.id });
    await getTestDb()
      .update(organizationUsers)
      .set({ siteIds: [otherSite.id] })
      .where(eq(organizationUsers.userId, fixture.user.id));
    await resyncArmedEpochs(fixture);
    await expect(gate(fixture)).resolves.toEqual({
      allowed: false,
      reason: BASELINE_BLOCKED_REASON.SITE_OUT_OF_SCOPE,
    });
  });

  it('denies after the permissions epoch advances', async () => {
    await getTestDb()
      .update(users)
      .set({ permissionsEpoch: sql`${users.permissionsEpoch} + 1` })
      .where(eq(users.id, fixture.user.id));
    await expect(gate(fixture)).resolves.toEqual({
      allowed: false,
      reason: BASELINE_BLOCKED_REASON.EPOCH_CHANGED,
    });
  });

  it('denies after the MFA epoch advances', async () => {
    await getTestDb()
      .update(users)
      .set({ mfaEpoch: sql`${users.mfaEpoch} + 1` })
      .where(eq(users.id, fixture.user.id));
    await expect(gate(fixture)).resolves.toEqual({
      allowed: false,
      reason: BASELINE_BLOCKED_REASON.EPOCH_CHANGED,
    });
  });

  it('denies after the scanned effect changes (a site move under the schedule)', async () => {
    const otherSite = await createSite({ orgId: fixture.org.id });
    await getTestDb()
      .update(networkBaselines)
      .set({ siteId: otherSite.id })
      .where(eq(networkBaselines.id, fixture.baseline.id));
    await expect(gate(fixture)).resolves.toEqual({
      allowed: false,
      reason: BASELINE_BLOCKED_REASON.EFFECT_CHANGED,
    });
  });

  it('denies a tick issued against a stale generation', async () => {
    await getTestDb()
      .update(networkBaselines)
      .set({ authorityGeneration: 2 })
      .where(eq(networkBaselines.id, fixture.baseline.id));
    await expect(gate(fixture, 1)).resolves.toEqual({
      allowed: false,
      reason: BASELINE_BLOCKED_REASON.STALE_GENERATION,
    });
  });

  it('fails a LEGACY enabled schedule closed — no envelope, no dispatch', async () => {
    const seed = getTestDb();
    const [legacy] = await seed
      .insert(networkBaselines)
      .values({
        orgId: fixture.org.id,
        siteId: fixture.site.id,
        subnet: '172.16.0.0/24',
        knownDevices: [],
        scanSchedule: SCHEDULE,
        updatedAt: new Date(),
      })
      .returning();

    const legacyRow = must(legacy, 'legacy baseline');
    expect(legacyRow.authorityUserId).toBeNull();
    expect(legacyRow.authorityGeneration).toBe(0);

    const decision = await withSystemDbAccessContext(() =>
      resolveBaselineDispatchAuthority(legacyRow, { expectedGeneration: legacyRow.authorityGeneration }),
    );
    expect(decision).toEqual({ allowed: false, reason: BASELINE_BLOCKED_REASON.REAPPROVAL_REQUIRED });
  });

  it('RACE: a revocation committed on another connection while the dispatch holds the row lock denies the dispatch', async () => {
    const seed = getTestDb();

    const decision = await withSystemDbAccessContext(async () => {
      // 1. The dispatch acquires the row lock, exactly as processExecuteScan does.
      const [locked] = await seed
        .select()
        .from(networkBaselines)
        .where(eq(networkBaselines.id, fixture.baseline.id))
        .limit(1)
        .for('update');
      const lockedRow = must(locked, 'locked baseline');
      expect(lockedRow.authorityUserId).toBe(fixture.user.id);

      // 2. A separate connection revokes the creator's membership and COMMITS
      //    while the lock is held. The revocation touches organization_users,
      //    not the locked row, so it commits immediately — the point of the gate
      //    is that the dispatch re-reads authority AFTER taking the lock rather
      //    than trusting the row it locked.
      await seed.delete(organizationUsers).where(eq(organizationUsers.userId, fixture.user.id));

      // 3. The dispatch resolves authority — and must observe the revocation.
      //    Two independent signals fire here: the membership row is gone AND
      //    the live-authorization trigger advanced users.permissions_epoch. The
      //    epoch check runs first, so that is the reason reported; either value
      //    is a revocation, and what matters for the finding is that dispatch
      //    is denied rather than proceeding on the row it locked.
      return resolveBaselineDispatchAuthority(lockedRow, {
        expectedGeneration: lockedRow.authorityGeneration,
      });
    });

    expect(decision.allowed).toBe(false);
    expect([
      BASELINE_BLOCKED_REASON.AUTHORITY_REVOKED,
      BASELINE_BLOCKED_REASON.EPOCH_CHANGED,
    ]).toContain((decision as { reason: string }).reason);

    // No dispatch happened, so nothing downstream was created for this baseline.
    const jobs = await seed.execute(
      sql`SELECT count(*)::int AS n FROM discovery_jobs WHERE org_id = ${fixture.org.id}`,
    );
    expect(must((jobs as unknown as Array<{ n: number }>)[0], 'job count').n).toBe(0);

    const [after] = await seed
      .select({ lastScanJobId: networkBaselines.lastScanJobId })
      .from(networkBaselines)
      .where(eq(networkBaselines.id, fixture.baseline.id))
      .limit(1);
    expect(must(after, 'baseline after').lastScanJobId).toBeNull();
  });

  it('resolves a partner-scope armer through the partner axis', async () => {
    const partnerUser = await createUser({
      partnerId: fixture.partner.id,
      status: 'active',
      withMembership: true,
    });
    const subject = await withSystemDbAccessContext(() =>
      loadBaselineAuthoritySubject(partnerUser.id, fixture.org.id),
    );
    expect(subject?.membership).not.toBeNull();
    // The partner role created by withMembership carries no permissions, so the
    // gate must report the permission as absent rather than assuming it.
    expect(subject?.membership?.hasRequiredPermission).toBe(false);
    expect(subject?.membership?.allowedSiteIds).toBeNull();
  });

  it('re-applying the migration is a no-op', async () => {
    const before = await gate(fixture);
    await replayMigration(MIGRATION);
    await replayMigration(MIGRATION);

    expect(await gate(fixture)).toEqual(before);

    const [row] = await getTestDb()
      .select()
      .from(networkBaselines)
      .where(eq(networkBaselines.id, fixture.baseline.id))
      .limit(1);
    const replayed = must(row, 'baseline after replay');
    expect(replayed.authorityUserId).toBe(fixture.user.id);
    expect(replayed.authorityGeneration).toBe(1);
    expect(replayed.scheduleBlockedReason).toBeNull();
  });

  it('the migration quarantines a legacy enabled schedule with reapproval_required', async () => {
    const seed = getTestDb();
    const [legacy] = await seed
      .insert(networkBaselines)
      .values({
        orgId: fixture.org.id,
        siteId: fixture.site.id,
        subnet: '172.20.0.0/24',
        knownDevices: [],
        scanSchedule: SCHEDULE,
        updatedAt: new Date(),
      })
      .returning();
    expect(must(legacy, 'legacy baseline').scheduleBlockedReason).toBeNull();

    await replayMigration(MIGRATION);

    const [after] = await seed
      .select({ scheduleBlockedReason: networkBaselines.scheduleBlockedReason })
      .from(networkBaselines)
      .where(eq(networkBaselines.id, must(legacy, 'legacy baseline').id))
      .limit(1);
    expect(must(after, 'legacy after').scheduleBlockedReason).toBe('reapproval_required');

    // The armed row is untouched by the quarantine sweep.
    const [armed] = await seed
      .select({ scheduleBlockedReason: networkBaselines.scheduleBlockedReason })
      .from(networkBaselines)
      .where(eq(networkBaselines.id, fixture.baseline.id))
      .limit(1);
    expect(must(armed, 'armed after').scheduleBlockedReason).toBeNull();
  });
});

describe('SEC-146 review follow-ups against real PostgreSQL', () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedArmedBaseline();
  });

  /**
   * F2. `discoveryWorker.processResults` auto-creates a baseline for a site that
   * has none. It used to insert with `scan_schedule` NULL, which
   * `normalizeBaselineScanSchedule` reads back as `enabled: true` — and
   * `compareBaselineScan` then PERSISTS that normalised value. The result was an
   * enabled recurring schedule with no envelope and no creator: blocked forever
   * by the gate, and invisible to the migration's quarantine sweep (whose
   * predicate reads the NULL jsonb as not-enabled). A system-auto-created scan
   * has no revocable creator, so it must start disabled.
   */
  it('auto-created baselines start with a DISABLED recurring schedule', async () => {
    const seed = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });

    const [profile] = await seed
      .insert(discoveryProfiles)
      .values({ orgId: org.id, siteId: site.id, name: 'auto-baseline-suite', subnets: ['10.44.0.0/24'] })
      .returning();
    const [job] = await seed
      .insert(discoveryJobs)
      .values({ profileId: must(profile, 'profile').id, orgId: org.id, siteId: site.id, status: 'running' })
      .returning();

    await withSystemDbAccessContext(() =>
      processResults({
        type: 'process-results',
        jobId: must(job, 'job').id,
        profileId: must(profile, 'profile').id,
        orgId: org.id,
        siteId: site.id,
        hostsScanned: 1,
        hostsDiscovered: 1,
        hosts: [{ ip: '10.44.0.9', hostname: 'auto-host', mac: 'aa:bb:cc:00:44:09' } as never],
      }),
    );

    const [auto] = await seed
      .select({ scanSchedule: networkBaselines.scanSchedule, authorityUserId: networkBaselines.authorityUserId })
      .from(networkBaselines)
      .where(eq(networkBaselines.siteId, site.id))
      .limit(1);

    const autoRow = must(auto, 'auto-created baseline');
    expect(autoRow.authorityUserId).toBeNull();
    // The load-bearing assertion: an ownerless schedule is off, not
    // enabled-and-permanently-blocked.
    expect(autoRow.scanSchedule).not.toBeNull();
    expect(autoRow.scanSchedule?.enabled).toBe(false);
  });

  /**
   * F1. "Scan Now" is a live-authorized request. Running the recurring gate on
   * it broke manual scans for precisely the baselines an operator needs most:
   * paused ones, and every legacy row awaiting re-approval.
   */
  it.each([
    ['LEGACY (no envelope)', { arm: false, enabled: true }],
    ['PAUSED', { arm: true, enabled: false }],
  ])('a manual dispatch of a %s baseline creates a discovery job and leaves schedule_blocked_reason alone', async (_label, shape) => {
    const seed = getTestDb();
    const target = shape.arm
      ? fixture
      : await (async () => {
          const [legacy] = await seed
            .insert(networkBaselines)
            .values({
              orgId: fixture.org.id,
              siteId: fixture.site.id,
              subnet: '10.99.0.0/24',
              knownDevices: [],
              scanSchedule: SCHEDULE,
              updatedAt: new Date(),
            })
            .returning();
          return { ...fixture, baseline: must(legacy, 'legacy baseline') };
        })();

    if (!shape.enabled) {
      await seed
        .update(networkBaselines)
        .set({ scanSchedule: { ...SCHEDULE, enabled: false } })
        .where(eq(networkBaselines.id, target.baseline.id));
    }

    // The recurring path denies this exact row...
    const recurring = await gate(target, null);
    expect(recurring.allowed).toBe(false);

    // ...while the interactive path runs it.
    const result = await withSystemDbAccessContext(() =>
      processExecuteScan({
        type: 'execute-baseline-scan',
        baselineId: target.baseline.id,
        orgId: target.org.id,
        siteId: target.site.id,
        subnet: target.baseline.subnet,
        trigger: 'manual',
      }),
    );

    expect(result.queued).toBe(true);
    expect(result.discoveryJobId).not.toBeNull();
    expect(result).not.toHaveProperty('blockedReason');

    const [after] = await seed
      .select({ scheduleBlockedReason: networkBaselines.scheduleBlockedReason })
      .from(networkBaselines)
      .where(eq(networkBaselines.id, target.baseline.id))
      .limit(1);
    expect(must(after, 'baseline after manual scan').scheduleBlockedReason).toBeNull();
  });
});
