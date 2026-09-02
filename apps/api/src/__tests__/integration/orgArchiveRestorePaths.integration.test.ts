/**
 * Real-Postgres coverage for the archive EXIT paths added by the Wave 4 final
 * review fixes (I-3 status-preserving restore, I-4 drain abort, I-5 bounded
 * purging recovery).
 *
 * All three ship as raw `sql` statements — a CASE-validated enum cast, a
 * three-key jsonb subtraction, a `jsonb_typeof`-guarded int cast, an atomic
 * `jsonb_set` increment. The unit suites only COMPILE those, which is the exact
 * blind spot this repo has been bitten by before: a compiled-SQL assertion can
 * be perfectly right about the text and still describe a statement Postgres
 * executes differently (or refuses). Everything here runs against genuine rows
 * through the real `breeze_app` pool.
 *
 * Harness conventions follow orgArchivePurge.integration.test.ts: seed via
 * `db.insert` under `withSystemDbAccessContext`, assert with typed selects.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { organizations, partners } from '../../db/schema';
import {
  ARCHIVE_PRIOR_STATUS_KEY,
  beginOrgArchive,
  OrgArchiveStateError,
  restoreOrgFromArchive,
} from '../../services/orgArchive';
import {
  ARCHIVE_PURGE_WARN_14_SENT_AT_KEY,
  ARCHIVE_PURGING_RECOVERY_ATTEMPTS_KEY,
  ARCHIVE_PURGING_RECOVERY_MAX_ATTEMPTS,
  buildArchivePurgingRecoveryAttemptIncrement,
  buildArchivePurgingRecoveryCandidatesWhere,
} from '../../services/tenantOffboarding';

// No SMTP in the integration stack; nothing else about the paths under test
// touches email.
vi.mock('../../services/email', () => ({ getEmailService: () => null }));

type OrgStatus = 'active' | 'trial' | 'suspended' | 'archived' | 'offboarding' | 'purging';

let partnerId: string;

beforeEach(async () => {
  partnerId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  await withSystemDbAccessContext(async () => {
    await db.insert(partners).values({
      id: partnerId,
      name: `Archive MSP ${suffix}`,
      slug: `archive-msp-${suffix}`,
    });
  });
});

async function insertOrg(opts: {
  status: OrgStatus;
  settings?: Record<string, unknown>;
  offboardingTarget?: 'churn' | 'archive';
  purgeAt?: Date | null;
  type?: 'customer' | 'quick_support';
}): Promise<string> {
  const orgId = randomUUID();
  await withSystemDbAccessContext(async () => {
    await db.insert(organizations).values({
      id: orgId,
      partnerId,
      name: `Org ${orgId.slice(0, 8)}`,
      slug: `org-${orgId.slice(0, 8)}`,
      status: opts.status,
      type: opts.type ?? 'customer',
      currencyCode: 'USD',
      settings: opts.settings ?? {},
      ...(opts.offboardingTarget ? { offboardingTarget: opts.offboardingTarget } : {}),
      ...(opts.purgeAt !== undefined ? { purgeAt: opts.purgeAt } : {}),
      ...(opts.status === 'archived' ? { archivedAt: new Date() } : {}),
    });
  });
  return orgId;
}

async function orgRow(orgId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db
      .select({
        status: organizations.status,
        archivedAt: organizations.archivedAt,
        purgeAt: organizations.purgeAt,
        offboardingTarget: organizations.offboardingTarget,
        offboardingStartedAt: organizations.offboardingStartedAt,
        settings: organizations.settings,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1)
  );
  return row as {
    status: string;
    archivedAt: Date | null;
    purgeAt: Date | null;
    offboardingTarget: string;
    offboardingStartedAt: Date | null;
    settings: Record<string, unknown> | null;
  };
}

describe('archive prior-status round trip (I-3)', () => {
  it('stamps the pre-archive status and hands it back on restore — suspended stays suspended', async () => {
    // A suspended org skips the drain and finalizes to `archived` immediately.
    const orgId = await insertOrg({ status: 'suspended' });

    const begun = await beginOrgArchive({ orgId, retentionDays: 30, actor: null });
    expect(begun.status).toBe('archived');

    const archived = await orgRow(orgId);
    expect(archived.status).toBe('archived');
    expect(archived.settings?.[ARCHIVE_PRIOR_STATUS_KEY]).toBe('suspended');

    const restored = await restoreOrgFromArchive({ orgId, actor: null });

    // Before this fix restore hard-coded 'active' — a two-call suspension reset.
    expect(restored.status).toBe('suspended');
    expect(restored.aborted).toBe(false);

    const after = await orgRow(orgId);
    expect(after.status).toBe('suspended');
    expect(after.archivedAt).toBeNull();
    expect(after.purgeAt).toBeNull();
    expect(after.offboardingTarget).toBe('churn');
    // The key is consumed, and a re-archive gets a fresh warning cycle.
    expect(after.settings?.[ARCHIVE_PRIOR_STATUS_KEY]).toBeUndefined();
  });

  it('drops the warning markers in the SAME jsonb expression while preserving unrelated settings', async () => {
    const orgId = await insertOrg({
      status: 'archived',
      settings: {
        [ARCHIVE_PRIOR_STATUS_KEY]: 'trial',
        [ARCHIVE_PURGE_WARN_14_SENT_AT_KEY]: new Date().toISOString(),
        branding: { primaryColor: '#123456' },
      },
    });

    const restored = await restoreOrgFromArchive({ orgId, actor: null });

    expect(restored.status).toBe('trial');
    const after = await orgRow(orgId);
    expect(after.status).toBe('trial');
    expect(after.settings?.[ARCHIVE_PURGE_WARN_14_SENT_AT_KEY]).toBeUndefined();
    expect(after.settings?.[ARCHIVE_PRIOR_STATUS_KEY]).toBeUndefined();
    expect(after.settings?.branding).toEqual({ primaryColor: '#123456' });
  });

  // Review r3 (b): the lifecycle boundary is the other half of the defence —
  // even if a key were written some other way, entering an archive resets it,
  // so preseeding cannot ride into the purge that follows.
  it('clears every engine-owned key at archive ENTRY, including a preseeded recovery counter', async () => {
    const orgId = await insertOrg({
      status: 'suspended',
      settings: {
        [ARCHIVE_PURGING_RECOVERY_ATTEMPTS_KEY]: 4,
        [ARCHIVE_PURGE_WARN_14_SENT_AT_KEY]: '2020-01-01T00:00:00.000Z',
        branding: { primaryColor: '#123456' },
      },
    });

    await beginOrgArchive({ orgId, retentionDays: 30, actor: null });

    const after = await orgRow(orgId);
    expect(after.settings?.[ARCHIVE_PURGING_RECOVERY_ATTEMPTS_KEY]).toBeUndefined();
    expect(after.settings?.[ARCHIVE_PURGE_WARN_14_SENT_AT_KEY]).toBeUndefined();
    // ...and the tenant's own settings are untouched, with the fresh stamp on.
    expect(after.settings?.branding).toEqual({ primaryColor: '#123456' });
    expect(after.settings?.[ARCHIVE_PRIOR_STATUS_KEY]).toBe('suspended');
  });

  it('falls back to active for a missing or hand-edited prior status, never an enum cast error', async () => {
    const missing = await insertOrg({ status: 'archived', settings: {} });
    const bogus = await insertOrg({
      status: 'archived',
      settings: { [ARCHIVE_PRIOR_STATUS_KEY]: 'not-a-status' },
    });

    expect((await restoreOrgFromArchive({ orgId: missing, actor: null })).status).toBe('active');
    expect((await restoreOrgFromArchive({ orgId: bogus, actor: null })).status).toBe('active');
  });
});

describe('archive drain abort (I-4)', () => {
  it('restores an in-flight archive drain to its prior status and clears every archive marker', async () => {
    const orgId = await insertOrg({ status: 'trial' });

    const begun = await beginOrgArchive({ orgId, retentionDays: 30, actor: null });
    expect(begun.status).toBe('offboarding');

    const draining = await orgRow(orgId);
    expect(draining.offboardingTarget).toBe('archive');
    expect(draining.purgeAt).not.toBeNull();

    const restored = await restoreOrgFromArchive({ orgId, actor: null });

    expect(restored.aborted).toBe(true);
    expect(restored.status).toBe('trial');

    const after = await orgRow(orgId);
    expect(after.status).toBe('trial');
    expect(after.purgeAt).toBeNull();
    expect(after.archivedAt).toBeNull();
    expect(after.offboardingTarget).toBe('churn');
    // The drain stamp is cleared too, so the reaper cannot finalize it later.
    expect(after.offboardingStartedAt).toBeNull();
  });

  it('refuses a CHURN-target drain — that one-way exit is not this endpoint to undo', async () => {
    const orgId = await insertOrg({
      status: 'offboarding',
      offboardingTarget: 'churn',
    });

    await expect(restoreOrgFromArchive({ orgId, actor: null })).rejects.toBeInstanceOf(
      OrgArchiveStateError
    );

    expect((await orgRow(orgId)).status).toBe('offboarding');
  });
});

describe('quick_support archive refusal (I-7)', () => {
  it('refuses before any write, leaving the org untouched', async () => {
    const orgId = await insertOrg({ status: 'active', type: 'quick_support' });

    await expect(
      beginOrgArchive({ orgId, retentionDays: 30, actor: null })
    ).rejects.toBeInstanceOf(OrgArchiveStateError);

    const after = await orgRow(orgId);
    expect(after.status).toBe('active');
    expect(after.purgeAt).toBeNull();
  });
});

describe('bounded purging recovery (I-5)', () => {
  async function incrementAttempts(orgId: string) {
    return withSystemDbAccessContext(
      async () =>
        (await db.execute(
          buildArchivePurgingRecoveryAttemptIncrement(orgId)
        )) as unknown as Array<{ attempts: number }>
    );
  }

  it('increments atomically from absent, and leaves updated_at alone', async () => {
    const orgId = await insertOrg({ status: 'purging' });
    const before = await withSystemDbAccessContext(() =>
      db.select({ updatedAt: organizations.updatedAt }).from(organizations).where(eq(organizations.id, orgId)).limit(1)
    );

    const first = await incrementAttempts(orgId);
    const second = await incrementAttempts(orgId);

    expect(Number(first[0]!.attempts)).toBe(1);
    expect(Number(second[0]!.attempts)).toBe(2);

    const after = await withSystemDbAccessContext(() =>
      db.select({ updatedAt: organizations.updatedAt }).from(organizations).where(eq(organizations.id, orgId)).limit(1)
    );
    // Bumping updated_at would push the row past the sweep's 15-minute age
    // guard and silently turn the cadence into a 15-minute backoff.
    expect(after[0]!.updatedAt).toEqual(before[0]!.updatedAt);
  });

  it('matches nothing once the row has left purging', async () => {
    const orgId = await insertOrg({ status: 'archived' });
    expect(await incrementAttempts(orgId)).toHaveLength(0);
  });

  // Review r3: `settings` is CLIENT-WRITABLE and this expression runs inside
  // the FLEET-WIDE candidate snapshot, taken BEFORE the sweep's per-org
  // try/catch. So one tenant with a hostile value used to be able to abort the
  // sweep for every tenant. `jsonb_typeof` alone was not enough — it admits
  // fractional and out-of-range numbers, and `'0.5'::int` / `'1e400'::int`
  // still raise 22P02 / 22003.
  it.each([
    ['a non-numeric string', 'oops', 0],
    ['an object', { nested: true }, 0],
    ['an array', [1, 2, 3], 0],
    ['null', null, 0],
    ['a fractional number', 2.7, 2],
    ['a negative number', -9999, 0],
    ['an absurd magnitude', 1e40, 1000],
    ['a legitimate count', 3, 3],
  ])('reads %s without raising, clamped to a safe int', async (_label, seeded, expected) => {
    const orgId = await insertOrg({
      status: 'purging',
      settings: { [ARCHIVE_PURGING_RECOVERY_ATTEMPTS_KEY]: seeded },
    });

    // The increment reads the seeded value through the same expression, so its
    // RETURNING proves exactly what the candidate query would have computed.
    const [row] = await incrementAttempts(orgId);
    expect(Number(row!.attempts)).toBe(expected + 1);
  });

  it('a hostile value in ONE tenant cannot abort the fleet-wide candidate snapshot', async () => {
    // The poison row and two healthy neighbours, all purging and all aged past
    // the 15-minute floor.
    const poison = await insertOrg({
      status: 'purging',
      settings: { [ARCHIVE_PURGING_RECOVERY_ATTEMPTS_KEY]: 'not-a-number' },
    });
    const fractional = await insertOrg({
      status: 'purging',
      settings: { [ARCHIVE_PURGING_RECOVERY_ATTEMPTS_KEY]: 0.5 },
    });
    const healthy = await insertOrg({ status: 'purging' });

    await withSystemDbAccessContext(() =>
      db
        .update(organizations)
        .set({ updatedAt: new Date(Date.now() - 60 * 60 * 1000) })
        .where(eq(organizations.partnerId, partnerId))
    );

    // The snapshot itself must not throw — this is the statement that used to
    // take the whole sweep down.
    const candidates = await withSystemDbAccessContext(() =>
      db
        .select({ id: organizations.id })
        .from(organizations)
        .where(buildArchivePurgingRecoveryCandidatesWhere())
    );
    const ids = candidates.map((row) => row.id);

    // Every org still processes, the poisoned one included (it reads as 0).
    expect(ids).toContain(poison);
    expect(ids).toContain(fractional);
    expect(ids).toContain(healthy);
  });

  it('drops an exhausted row out of the candidate set, and survives a non-numeric counter', async () => {
    const fresh = await insertOrg({ status: 'purging' });
    const exhausted = await insertOrg({
      status: 'purging',
      settings: { [ARCHIVE_PURGING_RECOVERY_ATTEMPTS_KEY]: ARCHIVE_PURGING_RECOVERY_MAX_ATTEMPTS + 1 },
    });
    // A hand-edited string would raise 22P02 on an unguarded cast and take the
    // WHOLE sweep down, not just this org.
    const corrupt = await insertOrg({
      status: 'purging',
      settings: { [ARCHIVE_PURGING_RECOVERY_ATTEMPTS_KEY]: 'oops' },
    });

    // The predicate also carries a 15-minute age floor, so age the rows.
    await withSystemDbAccessContext(() =>
      db
        .update(organizations)
        .set({ updatedAt: new Date(Date.now() - 60 * 60 * 1000) })
        .where(eq(organizations.partnerId, partnerId))
    );

    const candidates = await withSystemDbAccessContext(() =>
      db
        .select({ id: organizations.id })
        .from(organizations)
        .where(buildArchivePurgingRecoveryCandidatesWhere())
    );
    const ids = candidates.map((row) => row.id);

    expect(ids).toContain(fresh);
    expect(ids).toContain(corrupt); // treated as 0 attempts, not an error
    expect(ids).not.toContain(exhausted);
  });
});
