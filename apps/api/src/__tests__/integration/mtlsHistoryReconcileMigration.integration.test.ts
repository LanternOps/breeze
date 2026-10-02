/**
 * Live-Postgres proof for
 * 2026-12-03-120100-device-mtls-history-reconcile-issued-certs.sql (#7431 /
 * #7432): devices whose current certificate (the legacy devices.mtls_cert_*
 * columns) never reached device_mtls_certificates get it imported as the
 * active row, a stale active row is demoted for revocation, and everything
 * else is left alone.
 *
 * setup.ts has already applied every migration to an empty database, so each
 * test seeds the pre-fix state and replays the file.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq, inArray, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { deviceMtlsCertificates, devices } from '../../db/schema';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const MIGRATION = '2026-12-03-120100-device-mtls-history-reconcile-issued-certs.sql';
const migrationSql = readFileSync(new URL(`../../../migrations/${MIGRATION}`, import.meta.url), 'utf8');

async function replayMigration() {
  await getTestDb().transaction(async (tx) => {
    await tx.execute(sql.raw(migrationSql));
  });
}

const DAY = 24 * 3_600_000;
const serial = () => randomUUID().replace(/-/g, '').toUpperCase();

interface Legacy {
  cfId: string | null;
  serial: string | null;
  issuedAt: Date | null;
  expiresAt: Date | null;
}

function legacyCert(overrides: Partial<Legacy> = {}): Legacy {
  return {
    cfId: `cf-${randomUUID()}`,
    serial: serial(),
    // Whole seconds: devices.mtls_cert_* is `timestamp` and round-trips via UTC.
    issuedAt: new Date(Math.floor((Date.now() - 5 * DAY) / 1000) * 1000),
    expiresAt: new Date(Math.floor((Date.now() + 85 * DAY) / 1000) * 1000),
    ...overrides,
  };
}

async function seedDevice(legacy: Legacy, orgId?: string): Promise<{ orgId: string; deviceId: string }> {
  const org = orgId ?? (await createOrganization({ partnerId: (await createPartner()).id })).id;
  const site = await createSite({ orgId: org });
  const suffix = randomUUID().slice(0, 8);
  const [row] = await getTestDb()
    .insert(devices)
    .values({
      orgId: org,
      siteId: site.id,
      agentId: `mtls-reconcile-${suffix}`,
      hostname: `mtls-reconcile-${suffix}`,
      osType: 'linux',
      osVersion: 'test',
      architecture: 'x64',
      agentVersion: '0.0.0-test',
      status: 'online',
      mtlsCertCfId: legacy.cfId,
      mtlsCertSerialNumber: legacy.serial,
      mtlsCertIssuedAt: legacy.issuedAt,
      mtlsCertExpiresAt: legacy.expiresAt,
    })
    .returning({ id: devices.id });
  return { orgId: org, deviceId: row!.id };
}

async function seedHistoryRow(
  target: { orgId: string; deviceId: string },
  values: { providerCertificateId: string; serialNumber: string; state: 'active' | 'revoked' },
) {
  const [row] = await getTestDb()
    .insert(deviceMtlsCertificates)
    .values({
      orgId: target.orgId,
      deviceId: target.deviceId,
      providerCertificateId: values.providerCertificateId,
      serialNumber: values.serialNumber,
      fingerprintSha256: 'd'.repeat(64),
      publicKeySpki: 'MFkw-test-spki',
      legacyProvenance: false,
      state: values.state,
      issuedAt: new Date(Date.now() - 100 * DAY),
      expiresAt: new Date(Date.now() - 10 * DAY),
      activatedAt: new Date(Date.now() - 100 * DAY),
      revokedAt: values.state === 'revoked' ? new Date(Date.now() - 9 * DAY) : null,
    })
    .returning();
  return row!;
}

async function historyFor(deviceId: string) {
  return getTestDb().select().from(deviceMtlsCertificates).where(eq(deviceMtlsCertificates.deviceId, deviceId));
}

describe(MIGRATION, () => {
  runDb('imports the legacy certificate as the active row for a device with no history (#7431)', async () => {
    const legacy = legacyCert();
    const device = await seedDevice(legacy);

    await replayMigration();

    const rows = await historyFor(device.deviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId: device.orgId,
      providerCertificateId: legacy.cfId,
      serialNumber: legacy.serial,
      state: 'active',
      legacyProvenance: true,
      fingerprintSha256: null,
      publicKeySpki: null,
    });
    expect(rows[0]!.issuedAt.toISOString()).toBe(legacy.issuedAt!.toISOString());
    expect(rows[0]!.expiresAt.toISOString()).toBe(legacy.expiresAt!.toISOString());
    expect(rows[0]!.activatedAt?.toISOString()).toBe(legacy.issuedAt!.toISOString());
  });

  runDb('demotes a stale active row for revocation and imports the current certificate (#7432)', async () => {
    const legacy = legacyCert();
    const device = await seedDevice(legacy);
    const stale = await seedHistoryRow(device, { providerCertificateId: `cf-old-${randomUUID()}`, serialNumber: serial(), state: 'active' });

    const before = Date.now();
    await replayMigration();

    const rows = await historyFor(device.deviceId);
    const staleAfter = rows.find((r) => r.id === stale.id)!;
    expect(staleAfter.state).toBe('pending_revocation');
    expect(staleAfter.nextRevokeAttemptAt).not.toBeNull();
    // Due now, so the revocation sweep picks it up on its next pass.
    expect(staleAfter.nextRevokeAttemptAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(staleAfter.nextRevokeAttemptAt!.getTime()).toBeGreaterThanOrEqual(before - 5_000);

    const active = rows.filter((r) => r.state === 'active');
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ providerCertificateId: legacy.cfId, serialNumber: legacy.serial, legacyProvenance: true });
  });

  runDb('imports the current certificate when the device has only non-active history', async () => {
    const legacy = legacyCert();
    const device = await seedDevice(legacy);
    await seedHistoryRow(device, { providerCertificateId: `cf-revoked-${randomUUID()}`, serialNumber: serial(), state: 'revoked' });

    await replayMigration();

    const active = (await historyFor(device.deviceId)).filter((r) => r.state === 'active');
    expect(active).toHaveLength(1);
    expect(active[0]!.providerCertificateId).toBe(legacy.cfId);
  });

  runDb('leaves devices alone whose history already agrees, whose legacy columns are incomplete, or that share a certificate', async () => {
    // Agreeing: the active row IS the legacy certificate.
    const agreeingLegacy = legacyCert();
    const agreeing = await seedDevice(agreeingLegacy);
    const agreeingRow = await seedHistoryRow(agreeing, {
      providerCertificateId: agreeingLegacy.cfId!, serialNumber: agreeingLegacy.serial!, state: 'active',
    });

    // Incomplete legacy columns: not enough provenance to import.
    const incomplete = await seedDevice(legacyCert({ serial: null }));

    // Two devices naming one certificate: ambiguous, so neither is touched —
    // including the stale active row on the first.
    const shared = legacyCert();
    const sharedA = await seedDevice(shared);
    const sharedAStale = await seedHistoryRow(sharedA, { providerCertificateId: `cf-old-${randomUUID()}`, serialNumber: serial(), state: 'active' });
    const sharedB = await seedDevice({ ...shared, serial: serial() }, sharedA.orgId);

    // Same org, same serial, different provider ids: also ambiguous.
    const sameSerial = legacyCert();
    const sameSerialA = await seedDevice(sameSerial);
    const sameSerialB = await seedDevice({ ...sameSerial, cfId: `cf-${randomUUID()}` }, sameSerialA.orgId);

    await replayMigration();

    const [agreeingAfter] = await historyFor(agreeing.deviceId);
    expect(await historyFor(agreeing.deviceId)).toHaveLength(1);
    expect(agreeingAfter).toMatchObject({ id: agreeingRow.id, state: 'active' });
    expect(agreeingAfter!.updatedAt.toISOString()).toBe(agreeingRow.updatedAt.toISOString());

    expect(await historyFor(incomplete.deviceId)).toHaveLength(0);

    const sharedRows = await getTestDb()
      .select({ id: deviceMtlsCertificates.id, state: deviceMtlsCertificates.state })
      .from(deviceMtlsCertificates)
      .where(inArray(deviceMtlsCertificates.deviceId, [sharedA.deviceId, sharedB.deviceId]));
    expect(sharedRows).toEqual([{ id: sharedAStale.id, state: 'active' }]);
    expect(await historyFor(sameSerialA.deviceId)).toHaveLength(0);
    expect(await historyFor(sameSerialB.deviceId)).toHaveLength(0);
  });

  runDb('is idempotent: a second replay changes nothing', async () => {
    const device = await seedDevice(legacyCert());
    await seedHistoryRow(device, { providerCertificateId: `cf-old-${randomUUID()}`, serialNumber: serial(), state: 'active' });

    await replayMigration();
    const first = await historyFor(device.deviceId);
    await replayMigration();
    const second = await historyFor(device.deviceId);

    const byId = (rows: typeof first) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
    expect(byId(second)).toEqual(byId(first));
  });
});
