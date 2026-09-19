/**
 * Real-PostgreSQL proof for organization site-scope delegation.
 *
 * Run only against the disposable per-worktree stack. The production `db`
 * pool connects as `breeze_app`; fixture creation uses the test superuser.
 */
import './setup';

import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { organizationUsers } from '../../db/schema';
import { resolveDelegatedSiteIds } from '../../services/organizationMembershipDelegation';
import { getTestDb } from './setup';
import {
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
} from './db-utils';

const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
const writer = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function waitForBackendBlockedBy(blockerPid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rows = await getTestDb().execute<{ waiting: number }>(sql`
      SELECT count(*)::int AS waiting
      FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database()
        AND state = 'active'
        AND ${blockerPid} = ANY(pg_catalog.pg_blocking_pids(pid))
    `);
    if ((rows[0]?.waiting ?? 0) >= 1) return;
    if (Date.now() > deadline) throw new Error('delegation did not block on the inviter membership lock');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(options: { unrestricted?: boolean } = {}) {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: orgA.id, name: 'Visible A' });
  const siteA2 = await createSite({ orgId: orgA.id, name: 'Visible A2' });
  const siteB = await createSite({ orgId: orgB.id, name: 'Foreign B' });
  const role = await createRole({ scope: 'organization', orgId: orgA.id, partnerId: partner.id });
  const inviter = await createUser({ partnerId: partner.id, orgId: orgA.id });
  const invitee = await createUser({ partnerId: partner.id, orgId: orgA.id });

  await getTestDb().insert(organizationUsers).values({
    orgId: orgA.id,
    userId: inviter.id,
    roleId: role.id,
    siteIds: options.unrestricted ? null : [siteA.id, siteA2.id],
  });

  const context: DbAccessContext = {
    scope: 'organization',
    orgId: orgA.id,
    accessibleOrgIds: [orgA.id],
    accessiblePartnerIds: [partner.id],
    userId: inviter.id,
    currentPartnerId: partner.id,
  };
  return { partner, orgA, orgB, siteA, siteA2, siteB, role, inviter, invitee, context };
}

afterAll(async () => {
  await writer.end({ timeout: 5 });
});

describe('organization membership site-scope delegation', () => {
  it('persists omitted scope as the restricted inviter scope under breeze_app', async () => {
    const fx = await fixture();

    await withDbAccessContext(fx.context, () => db.transaction(async (tx) => {
      const siteIds = await resolveDelegatedSiteIds(tx, {
        inviterUserId: fx.inviter.id,
        orgId: fx.orgA.id,
      });
      await tx.insert(organizationUsers).values({
        orgId: fx.orgA.id,
        userId: fx.invitee.id,
        roleId: fx.role.id,
        siteIds,
      });
    }));

    const [membership] = await getTestDb()
      .select({ siteIds: organizationUsers.siteIds })
      .from(organizationUsers)
      .where(and(
        eq(organizationUsers.orgId, fx.orgA.id),
        eq(organizationUsers.userId, fx.invitee.id),
      ));
    expect(new Set(membership?.siteIds)).toEqual(new Set([fx.siteA.id, fx.siteA2.id]));
  });

  it('allows an own-org subset and denies hidden/foreign and cross-org membership writes', async () => {
    const fx = await fixture();

    await expect(withDbAccessContext(fx.context, () => db.transaction((tx) =>
      resolveDelegatedSiteIds(tx, {
        inviterUserId: fx.inviter.id,
        orgId: fx.orgA.id,
        requestedSiteIds: [fx.siteA.id],
      })))).resolves.toEqual([fx.siteA.id]);

    await expect(withDbAccessContext(fx.context, () => db.transaction((tx) =>
      resolveDelegatedSiteIds(tx, {
        inviterUserId: fx.inviter.id,
        orgId: fx.orgA.id,
        requestedSiteIds: [fx.siteB.id],
      })))).rejects.toMatchObject({ status: 403 });

    let crossOrgError: unknown;
    try {
      await withDbAccessContext(fx.context, () => db.insert(organizationUsers).values({
        orgId: fx.orgB.id,
        userId: fx.invitee.id,
        roleId: fx.role.id,
        siteIds: [fx.siteB.id],
      }));
    } catch (error) {
      crossOrgError = error;
    }
    expect(crossOrgError).toBeDefined();
    expect((crossOrgError as { cause?: { code?: string } }).cause?.code).toBe('42501');
  });

  it('serializes against a concurrent inviter-scope change and inherits the committed winner', async () => {
    const fx = await fixture();
    const writerChanged = deferred<void>();
    const releaseWriter = deferred<void>();
    const writerPid = (await writer<{ pid: number }[]>`
      SELECT pg_backend_pid()::int AS pid
    `)[0]?.pid;
    if (writerPid === undefined) throw new Error('could not determine membership-writer backend PID');

    const update = writer.begin(async (sql) => {
      await sql`
        UPDATE organization_users
        SET site_ids = ARRAY[${fx.siteA2.id}]::uuid[]
        WHERE org_id = ${fx.orgA.id} AND user_id = ${fx.inviter.id}
      `;
      writerChanged.resolve();
      await releaseWriter.promise;
    });
    await writerChanged.promise;

    const delegation = withDbAccessContext(fx.context, () => db.transaction((tx) =>
      resolveDelegatedSiteIds(tx, {
        inviterUserId: fx.inviter.id,
        orgId: fx.orgA.id,
      })));

    await waitForBackendBlockedBy(writerPid);

    releaseWriter.resolve();
    await update;
    await expect(delegation).resolves.toEqual([fx.siteA2.id]);
  });

  it('validates explicit sites even when the inviter is unrestricted', async () => {
    const fx = await fixture({ unrestricted: true });
    await expect(withDbAccessContext(fx.context, () => db.transaction((tx) =>
      resolveDelegatedSiteIds(tx, {
        inviterUserId: fx.inviter.id,
        orgId: fx.orgA.id,
        requestedSiteIds: [fx.siteB.id],
      })))).rejects.toMatchObject({ status: 400 });
  });
});
