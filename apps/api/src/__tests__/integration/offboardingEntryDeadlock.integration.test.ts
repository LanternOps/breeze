import './setup';

import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  db,
  runOutsideDbContext,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { deviceCommands, devices, organizations, partners } from '../../db/schema';
import {
  abortOrganizationOffboarding,
  beginOrganizationOffboarding,
  beginPartnerOffboarding,
  finalizeOrganizationOffboarding,
} from '../../services/tenantOffboarding';
import { revokeOrganizationTenantAccess } from '../../services/tenantLifecycle';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

/**
 * #2877 — offboarding entry self-deadlock.
 *
 * The PATCH /organizations/:id route runs inside the auth middleware's
 * request transaction: its own `UPDATE organizations ... RETURNING` takes the
 * org row lock, and begin/abort*Offboarding used to open a FRESH pooled
 * connection (runOutsideDbContext → withSystemDbAccessContext) that UPDATEd
 * the SAME row — waiting forever on a lock the request could only release
 * after the service returned. Postgres cannot detect the cycle (each side is
 * merely blocked/idle-in-transaction), so the request wedged indefinitely and
 * killing it tore the entry (status rolled back, side effects committed).
 *
 * The mocked unit suite structurally cannot catch this class — it has no
 * connections, no locks. These tests reproduce the exact route shape against
 * real Postgres: update the tenant row inside a held access-context
 * transaction, then invoke the service inside that same context. Under the
 * old code every one of these hangs until the suite timeout.
 */
const runDb = it.runIf(!!process.env.DATABASE_URL);

/** Fails fast with a diagnosis instead of eating the whole 30s test timeout. */
async function expectNoDeadlock<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(
        `${what} did not complete within 20s — the #2877 request-txn vs fresh-connection ` +
        'row-lock deadlock is back (same org/partner row updated from two connections).'
      )),
      20_000
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The request context the auth middleware builds for a partner-scoped operator. */
function partnerRequestContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
    currentPartnerId: partnerId,
    label: 'test.offboardingEntryDeadlock',
  };
}

async function seedDevice(orgId: string, siteId: string, label: string): Promise<{ id: string }> {
  const agentId = `agent-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [row] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId,
      hostname: `host-${label}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'offline',
    })
    .returning({ id: devices.id });
  return { id: row!.id };
}

async function readOrg(orgId: string) {
  const [row] = await getTestDb()
    .select({ status: organizations.status, startedAt: organizations.offboardingStartedAt })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return row!;
}

async function readUninstalls(deviceId: string) {
  return getTestDb()
    .select({
      id: deviceCommands.id,
      status: deviceCommands.status,
      createdAt: deviceCommands.createdAt,
      result: deviceCommands.result,
    })
    .from(deviceCommands)
    .where(and(eq(deviceCommands.deviceId, deviceId), eq(deviceCommands.type, 'self_uninstall')));
}

describe('#2877 offboarding entry inside the request transaction', () => {
  runDb('org entry completes with the org row already locked by the request txn, atomically', async () => {
    const partner = await createPartner({ status: 'active' });
    const org = await createOrganization({ partnerId: partner.id, status: 'active' });
    const site = await createSite({ orgId: org.id });
    const device = await seedDevice(org.id, site.id, 'entry');

    // Mirror updateOrgHandler exactly: status UPDATE (row lock) then the
    // service call, both inside ONE partner-scoped request transaction.
    await expectNoDeadlock(
      withDbAccessContext(partnerRequestContext(partner.id, [org.id]), async () => {
        const [updated] = await db
          .update(organizations)
          .set({ status: 'offboarding', updatedAt: new Date() })
          .where(eq(organizations.id, org.id))
          .returning({ id: organizations.id });
        expect(updated?.id).toBe(org.id);

        return beginOrganizationOffboarding(org.id, null);
      }),
      'organization offboarding entry'
    );

    // Everything committed together: status, drain stamp, queued uninstall.
    const after = await readOrg(org.id);
    expect(after.status).toBe('offboarding');
    expect(after.startedAt).not.toBeNull();

    const queued = await readUninstalls(device.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.status).toBe('pending');

    // The clock-skew half of #2877: the stamp comes from the DB clock inside
    // the same transaction as the insert, so the finalize report's
    // gte(created_at, stamp) window includes the entry's own command.
    expect(after.startedAt!.getTime()).toBeLessThanOrEqual(queued[0]!.createdAt.getTime());
  });

  runDb('a failure after entry, before commit, rolls back status + stamp + uninstalls together', async () => {
    const partner = await createPartner({ status: 'active' });
    const org = await createOrganization({ partnerId: partner.id, status: 'active' });
    const site = await createSite({ orgId: org.id });
    const device = await seedDevice(org.id, site.id, 'rollback');

    // The atomicity half of #2877: if any part of the drain work (stamp,
    // command cancel, self_uninstall insert) ever moves back onto its own
    // connection, it would COMMIT here despite the request transaction
    // rolling back — leaving pending self_uninstalls against an org whose
    // status reverted to active. This is the torn state QA observed, in the
    // worst direction, and the deadlock tests alone cannot catch it (a
    // fresh-connection INSERT takes no conflicting lock).
    await expect(
      withDbAccessContext(partnerRequestContext(partner.id, [org.id]), async () => {
        await db
          .update(organizations)
          .set({ status: 'offboarding', updatedAt: new Date() })
          .where(eq(organizations.id, org.id));
        await beginOrganizationOffboarding(org.id, null);
        throw new Error('simulated post-entry handler failure');
      })
    ).rejects.toThrow('simulated post-entry handler failure');

    const after = await readOrg(org.id);
    expect(after.status).toBe('active');
    expect(after.startedAt).toBeNull();
    expect(await readUninstalls(device.id)).toHaveLength(0);
  });

  runDb('finalize report counts the drain\'s completed uninstall (no JS/DB clock skew)', async () => {
    const partner = await createPartner({ status: 'active' });
    const org = await createOrganization({ partnerId: partner.id, status: 'active' });
    const site = await createSite({ orgId: org.id });
    const device = await seedDevice(org.id, site.id, 'report');

    await expectNoDeadlock(
      withDbAccessContext(partnerRequestContext(partner.id, [org.id]), async () => {
        await db
          .update(organizations)
          .set({ status: 'offboarding', updatedAt: new Date() })
          .where(eq(organizations.id, org.id));
        return beginOrganizationOffboarding(org.id, null);
      }),
      'organization offboarding entry'
    );

    // The agent completes its uninstall.
    await getTestDb()
      .update(deviceCommands)
      .set({ status: 'completed', completedAt: new Date() })
      .where(and(eq(deviceCommands.deviceId, device.id), eq(deviceCommands.type, 'self_uninstall')));

    const report = await withSystemDbAccessContext(() =>
      finalizeOrganizationOffboarding(org.id, { forcedByDeadline: false })
    );

    // Pre-fix this reported 0: the JS-clock stamp landed ~ms AFTER the
    // command's DB-clock created_at, so gte() excluded the drain's own work.
    expect(report).not.toBeNull();
    expect(report!.uninstallsCompleted).toBe(1);
    expect(report!.uninstallsFailed).toBe(0);
    expect(report!.neverDelivered).toHaveLength(0);
    expect(report!.deliveredUnconfirmed).toHaveLength(0);
  });

  runDb('leaving a drain (suspended) completes with the org row locked, and cancels the uninstall', async () => {
    const partner = await createPartner({ status: 'active' });
    const org = await createOrganization({ partnerId: partner.id, status: 'active' });
    const site = await createSite({ orgId: org.id });
    const device = await seedDevice(org.id, site.id, 'abort');

    // Enter the drain first (request-shaped, as above).
    await expectNoDeadlock(
      withDbAccessContext(partnerRequestContext(partner.id, [org.id]), async () => {
        await db
          .update(organizations)
          .set({ status: 'offboarding', updatedAt: new Date() })
          .where(eq(organizations.id, org.id));
        return beginOrganizationOffboarding(org.id, null);
      }),
      'organization offboarding entry'
    );

    // Mirror the suspended-transition branch of updateOrgHandler: row UPDATE,
    // then abort + revoke — abort's stamp-clear hits the same locked row.
    await expectNoDeadlock(
      withDbAccessContext(partnerRequestContext(partner.id, [org.id]), async () => {
        await db
          .update(organizations)
          .set({ status: 'suspended', updatedAt: new Date() })
          .where(eq(organizations.id, org.id));
        const abort = await abortOrganizationOffboarding(org.id);
        expect(abort.aborted).toBe(true);
        await revokeOrganizationTenantAccess(org.id);
      }),
      'organization offboarding abort'
    );

    const after = await readOrg(org.id);
    expect(after.status).toBe('suspended');
    expect(after.startedAt).toBeNull();

    const commands = await readUninstalls(device.id);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.status).toBe('cancelled');
    expect((commands[0]!.result as { reason?: string }).reason).toBe('organization_offboarding_aborted');
  });

  runDb('#2879 override shape: entry works when the ambient context cannot see the org', async () => {
    const partner = await createPartner({ status: 'active' });
    const org = await createOrganization({ partnerId: partner.id, status: 'suspended' });
    const site = await createSite({ orgId: org.id });
    const device = await seedDevice(org.id, site.id, 'override');

    // Mirror updateOrgHandler's suspended-lifecycle override (#2887): the
    // suspended org is EXCLUDED from the request context's allowlist, so the
    // route runs its status UPDATE on a short system-scoped connection and
    // the ambient partner transaction never touches (or even sees) the row.
    // The service must therefore NOT reuse the ambient transaction — a
    // partner-scoped stamp UPDATE would silently match zero rows — and its
    // fresh system context is deadlock-free because no ambient lock exists.
    await expectNoDeadlock(
      withDbAccessContext(partnerRequestContext(partner.id, [/* org NOT visible */]), async () => {
        const [updated] = await runOutsideDbContext(() =>
          withSystemDbAccessContext(async () =>
            db
              .update(organizations)
              .set({ status: 'offboarding', updatedAt: new Date() })
              .where(and(
                eq(organizations.id, org.id),
                eq(organizations.partnerId, partner.id),
                eq(organizations.status, 'suspended')
              ))
              .returning({ id: organizations.id })
          )
        );
        expect(updated?.id).toBe(org.id);

        return beginOrganizationOffboarding(org.id, null);
      }),
      'organization offboarding entry (suspended-lifecycle override)'
    );

    // The entry's side effects landed despite the caller's blind allowlist:
    // stamp set and the uninstall queued (via the system-context fallback).
    const after = await readOrg(org.id);
    expect(after.status).toBe('offboarding');
    expect(after.startedAt).not.toBeNull();

    const queued = await readUninstalls(device.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.status).toBe('pending');
  });

  runDb('partner entry completes with the partner row locked by the request txn', async () => {
    const partner = await createPartner({ status: 'active' });
    const org = await createOrganization({ partnerId: partner.id, status: 'active' });
    const site = await createSite({ orgId: org.id });
    const device = await seedDevice(org.id, site.id, 'partner');

    // PATCH /partners/:id is system-scope; mirror its request transaction.
    await expectNoDeadlock(
      withSystemDbAccessContext(async () => {
        await db
          .update(partners)
          .set({ status: 'offboarding', updatedAt: new Date() })
          .where(eq(partners.id, partner.id));
        return beginPartnerOffboarding(partner.id, null);
      }),
      'partner offboarding entry'
    );

    const [partnerRow] = await getTestDb()
      .select({ status: partners.status, startedAt: partners.offboardingStartedAt })
      .from(partners)
      .where(eq(partners.id, partner.id));
    expect(partnerRow!.status).toBe('offboarding');
    expect(partnerRow!.startedAt).not.toBeNull();

    const queued = await readUninstalls(device.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.status).toBe('pending');
  });
});
