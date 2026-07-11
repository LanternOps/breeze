/**
 * Real-driver cross-tenant forge test for device_recovery_keys /
 * recovery_key_access_events (issue #2021 — BitLocker/FileVault recovery-key
 * escrow, Task 1).
 *
 * Both tables are direct org-axis tables (org_id + policies using
 * breeze_has_org_access) — RLS shape #1, modeled on
 * deviceVulnerabilities-rls.integration.test.ts.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { deviceRecoveryKeys, recoveryKeyAccessEvents, devices } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgCtx(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    currentPartnerId: null,
  };
}

async function seed() {
  return withSystemDbAccessContext(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: orgA.id });

    const [device] = await db
      .insert(devices)
      .values({
        orgId: orgA.id,
        siteId: site.id,
        agentId: `recovery-rls-agent-${unique}`,
        hostname: `recovery-rls-host-${unique}`,
        osType: 'windows',
        osVersion: '11',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'offline',
      })
      .returning({ id: devices.id });
    if (!device) throw new Error('failed to seed device');

    return { partner, orgA, orgB, device };
  });
}

describe('device_recovery_keys / recovery_key_access_events RLS', () => {
  runDb('cross-org forged insert is rejected with 42501; same-org insert succeeds', async () => {
    const { orgA, orgB, device } = await seed();

    // Same-org insert succeeds.
    const inserted = await withDbAccessContext(orgCtx(orgA.id), async () => {
      const [row] = await db.insert(deviceRecoveryKeys).values({
        deviceId: device.id,
        orgId: orgA.id,
        keyType: 'bitlocker_recovery_password',
        volumeMount: 'C:',
        protectorId: '11111111-2222-3333-4444-555555555555',
        encryptedKey: 'enc:test-not-real',
        keyFingerprint: 'a'.repeat(64),
        status: 'active',
      }).returning({ id: deviceRecoveryKeys.id, orgId: deviceRecoveryKeys.orgId });
      return row;
    });
    expect(inserted?.orgId).toBe(orgA.id);

    // Cross-tenant forge: org B context inserting an org A row must fail.
    //
    // The try/catch MUST wrap the `withDbAccessContext` call itself, not sit
    // inside its callback: Postgres aborts the whole transaction the instant
    // one statement fails, so postgres.js's `client.begin()` wrapper rejects
    // the outer transaction promise on commit regardless of whether the
    // callback locally swallowed the error (no savepoint is used here). See
    // deviceVulnerabilities-rls.integration.test.ts for the same pattern.
    let caught: unknown;
    try {
      await withDbAccessContext(orgCtx(orgB.id), () =>
        db.insert(deviceRecoveryKeys).values({
          deviceId: device.id,
          orgId: orgA.id,
          keyType: 'bitlocker_recovery_password',
          volumeMount: 'D:',
          encryptedKey: 'enc:forged',
          keyFingerprint: 'b'.repeat(64),
          status: 'active',
        })
      );
    } catch (err) {
      caught = err;
    }
    expect(caught, 'cross-org insert must be rejected by RLS').toBeDefined();
    const cause = (caught as { cause?: { message?: string; code?: string } } | undefined)?.cause;
    expect(cause?.code).toBe('42501');
    expect(cause?.message).toMatch(
      /new row violates row-level security policy for table "device_recovery_keys"/
    );

    // Org B cannot read org A's key rows.
    const visibleToB = await withDbAccessContext(orgCtx(orgB.id), () =>
      db.select({ id: deviceRecoveryKeys.id }).from(deviceRecoveryKeys)
        .where(eq(deviceRecoveryKeys.deviceId, device.id))
    );
    expect(visibleToB).toHaveLength(0);

    // Access-events table: forged cross-org insert also rejected.
    let eventCaught: unknown;
    try {
      await withDbAccessContext(orgCtx(orgB.id), () =>
        db.insert(recoveryKeyAccessEvents).values({
          keyId: inserted!.id,
          deviceId: device.id,
          orgId: orgA.id,
          userId: '99999999-9999-4999-8999-999999999999',
          userEmail: 'forger@example.com',
          action: 'revealed',
        })
      );
    } catch (err) {
      eventCaught = err;
    }
    expect(eventCaught, 'cross-org access-event insert must be rejected by RLS').toBeDefined();
    expect((eventCaught as { cause?: { code?: string } })?.cause?.code).toBe('42501');
  });
});
