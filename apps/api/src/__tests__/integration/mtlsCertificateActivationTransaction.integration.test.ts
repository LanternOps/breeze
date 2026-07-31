/**
 * Real-Postgres proof of the Wave 5 Task 4 demote-before-promote invariant,
 * parked at Task 4 review time for Task 10 to close (see progress.md:
 * "txn ordering proven mocked-only (→Task 10 gate)").
 *
 * `device_mtls_certificates_one_active_uq` is a real, non-deferrable partial
 * unique index on (device_id) WHERE state = 'active' — Postgres enforces it
 * at each statement, not at commit, so a promote-before-demote ordering
 * inside a single transaction genuinely fails with 23505 against the real
 * index (a mocked `db` can't exercise this at all: the mock chains in
 * deviceMtlsCertificateLifecycle.test.ts never touch a constraint).
 *
 * Both `/renew-cert` (legacy, no protocolVersion) and `/renew-cert/confirm`
 * (routes/agents/mtls.ts) compose the IDENTICAL sequence inside their own
 * `db.transaction`: select the device's current `active` row, demote it via
 * `queueCertificateRevocationCore(tx, existingActive.id)`, THEN promote the
 * new row to `active`. This file drives that exact shared function against
 * the real schema/constraints, in the shape both routes use, and proves the
 * reverse ordering is genuinely rejected by the database (not just "the
 * code happens to call things in the right order") — the single piece of
 * machinery both routes depend on for the invariant to hold.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { deviceMtlsCertificates, devices } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { queueCertificateRevocationCore } from '../../services/deviceMtlsCertificateLifecycle';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seedDeviceWithActiveCert(unique: string) {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const [device] = await db
      .insert(devices)
      .values({
        orgId: org.id,
        siteId: site.id,
        agentId: `mtls-activate-agent-${unique}`,
        hostname: `mtls-activate-host-${unique}`,
        osType: 'windows',
        osVersion: '11',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'offline',
      })
      .returning({ id: devices.id });
    if (!device) throw new Error('failed to seed device');

    const [oldCert] = await db
      .insert(deviceMtlsCertificates)
      .values({
        orgId: org.id,
        deviceId: device.id,
        providerCertificateId: `prov-old-${unique}`,
        serialNumber: `serial-old-${unique}`,
        fingerprintSha256: 'a'.repeat(64),
        legacyProvenance: false,
        state: 'active',
        issuedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        activatedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      })
      .returning();
    if (!oldCert) throw new Error('failed to seed old active cert');

    return { org, device, oldCert };
  });
}

async function seedPendingActivationRow(orgId: string, deviceId: string, unique: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .insert(deviceMtlsCertificates)
      .values({
        orgId,
        deviceId,
        providerCertificateId: `prov-new-${unique}`,
        serialNumber: `serial-new-${unique}`,
        fingerprintSha256: 'b'.repeat(64),
        legacyProvenance: false,
        state: 'pending_activation',
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        activationExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
      })
      .returning();
    if (!row) throw new Error('failed to seed pending_activation row');
    return row;
  });
}

async function activeRowsFor(deviceId: string) {
  return withSystemDbAccessContext(() =>
    db
      .select({ id: deviceMtlsCertificates.id })
      .from(deviceMtlsCertificates)
      .where(and(eq(deviceMtlsCertificates.deviceId, deviceId), eq(deviceMtlsCertificates.state, 'active'))),
  );
}

describe('demote-before-promote against the real one-active-per-device partial unique index', () => {
  runDb(
    'legacy /renew-cert path: demote-then-promote in one transaction leaves exactly one active row',
    async () => {
      const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-legacy`;
      const { org, device, oldCert } = await seedDeviceWithActiveCert(unique);
      const newCert = await seedPendingActivationRow(org.id, device.id, unique);

      await withSystemDbAccessContext(() =>
        db.transaction(async (tx) => {
          const demoted = await queueCertificateRevocationCore(tx, oldCert.id);
          expect(demoted).toBe(true); // a replacement (newCert, pending_activation) exists

          const activated = await tx
            .update(deviceMtlsCertificates)
            .set({ state: 'active', activatedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(deviceMtlsCertificates.id, newCert.id), eq(deviceMtlsCertificates.state, 'pending_activation')))
            .returning({ id: deviceMtlsCertificates.id });
          expect(activated).toHaveLength(1);
        }),
      );

      const active = await activeRowsFor(device.id);
      expect(active).toHaveLength(1);
      expect(active[0]?.id).toBe(newCert.id);

      const oldRow = await withSystemDbAccessContext(() =>
        db.select({ state: deviceMtlsCertificates.state }).from(deviceMtlsCertificates).where(eq(deviceMtlsCertificates.id, oldCert.id)).limit(1),
      );
      expect(oldRow[0]?.state).toBe('pending_revocation');
    },
  );

  runDb(
    '/renew-cert/confirm path: the identical demote-then-promote composition also leaves exactly one active row',
    async () => {
      const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-confirm`;
      const { org, device, oldCert } = await seedDeviceWithActiveCert(unique);
      const pendingCert = await seedPendingActivationRow(org.id, device.id, unique);

      // Mirrors /renew-cert/confirm's transaction body verbatim: look up the
      // CURRENT active row (not passed in — the route re-selects it fresh
      // inside the transaction), demote it, then activate the pending row
      // named by the (already-authenticated) certificateId.
      await withSystemDbAccessContext(() =>
        db.transaction(async (tx) => {
          const [existingActive] = await tx
            .select({ id: deviceMtlsCertificates.id })
            .from(deviceMtlsCertificates)
            .where(and(eq(deviceMtlsCertificates.deviceId, device.id), eq(deviceMtlsCertificates.state, 'active')))
            .limit(1);
          expect(existingActive?.id).toBe(oldCert.id);

          const demoted = await queueCertificateRevocationCore(tx, existingActive!.id);
          expect(demoted).toBe(true);

          const activated = await tx
            .update(deviceMtlsCertificates)
            .set({ state: 'active', activatedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(deviceMtlsCertificates.id, pendingCert.id), eq(deviceMtlsCertificates.state, 'pending_activation')))
            .returning({ id: deviceMtlsCertificates.id });
          expect(activated).toHaveLength(1);
        }),
      );

      const active = await activeRowsFor(device.id);
      expect(active).toHaveLength(1);
      expect(active[0]?.id).toBe(pendingCert.id);
    },
  );

  runDb(
    'promote-before-demote (the WRONG order) is genuinely rejected by the real partial unique index (23505), proving the ordering is load-bearing',
    async () => {
      const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-wrong-order`;
      const { org, device, oldCert } = await seedDeviceWithActiveCert(unique);
      const pendingCert = await seedPendingActivationRow(org.id, device.id, unique);

      let caught: unknown;
      try {
        await withSystemDbAccessContext(() =>
          db.transaction(async (tx) => {
            // WRONG order: promote the new row to active BEFORE demoting the
            // old one — both rows would be `active` for the same device at
            // once, which the partial unique index must never allow.
            await tx
              .update(deviceMtlsCertificates)
              .set({ state: 'active', activatedAt: new Date(), updatedAt: new Date() })
              .where(and(eq(deviceMtlsCertificates.id, pendingCert.id), eq(deviceMtlsCertificates.state, 'pending_activation')));
          }),
        );
      } catch (err) {
        caught = err;
      }

      expect(caught, 'promoting a second row to active while one is already active must be rejected').toBeDefined();
      const cause = (caught as { cause?: { code?: string; message?: string } } | undefined)?.cause;
      expect(cause?.code).toBe('23505'); // unique_violation
      expect(cause?.message).toMatch(/device_mtls_certificates_one_active_uq/);

      // Confirm nothing was left corrupted: the old row is still the sole
      // active row (the transaction aborted, rolling back the failed
      // promote), and the pending row is untouched.
      const active = await activeRowsFor(device.id);
      expect(active).toHaveLength(1);
      expect(active[0]?.id).toBe(oldCert.id);
    },
  );
});
