import './setup';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';
import { replayMigration } from './replayMigration';

const MIGRATION = '2026-12-19-100000-device-reliability-baselines.sql';
const system: DbAccessContext = { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null };

async function fixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner!.id });
  const other = await createOrganization({ partnerId: partner!.id });
  const site = await createSite({ orgId: org!.id });
  const [device] = await getTestDb().insert(devices).values({
    orgId: org!.id, siteId: site!.id, agentId: randomUUID(), hostname: 'baseline-a',
    osType: 'windows', osVersion: '11', architecture: 'x64', agentVersion: '1.0.0',
  }).returning();
  return { partner: partner!.id, org: org!.id, other: other!.id, device: device!.id };
}

const insertMarker = (deviceId: string, orgId: string, reason = 'reimaged', note: string | null = null) =>
  db.execute(sql`INSERT INTO device_reliability_baselines (org_id, device_id, baseline_at, reason, source, note)
                 VALUES (${orgId}, ${deviceId}, now(), ${reason}, 'manual', ${note})`);

describe('device_reliability_baselines tenancy', () => {
  it('forces four org policies and an immediate deferrable cascading composite FK', async () => {
    const rows = await getTestDb().execute(sql`
      SELECT c.relrowsecurity, c.relforcerowsecurity, f.condeferrable, f.condeferred, f.confupdtype, f.confdeltype
      FROM pg_class c JOIN pg_constraint f ON f.conrelid = c.oid
      WHERE c.oid = to_regclass('device_reliability_baselines')
        AND f.conname = 'device_reliability_baselines_device_org_fkey'`);
    expect(rows[0]).toMatchObject({
      relrowsecurity: true, relforcerowsecurity: true, condeferrable: true, condeferred: false,
      confupdtype: 'c', confdeltype: 'c',
    });
    const policies = await getTestDb().execute(sql`SELECT cmd FROM pg_policies WHERE tablename = 'device_reliability_baselines'`);
    expect(policies.map((p) => p.cmd).sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });

  it('denies forged cross-org writes and reads as breeze_app', async () => {
    const f = await fixture();
    const otherCtx: DbAccessContext = {
      scope: 'organization', orgId: f.other, accessibleOrgIds: [f.other], accessiblePartnerIds: [], currentPartnerId: f.partner,
    };
    await expect(withDbAccessContext(otherCtx, () => insertMarker(f.device, f.org)))
      .rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '42501');
    await expect(withDbAccessContext(system, () => insertMarker(f.device, f.other)))
      .rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23503');
    await withDbAccessContext(system, () => insertMarker(f.device, f.org));
    expect(await withDbAccessContext(otherCtx, () => db.execute(sql`SELECT * FROM device_reliability_baselines`))).toHaveLength(0);
  });

  it('requires a non-blank note for a manual remediated marker and rejects unknown reasons', async () => {
    const f = await fixture();
    await expect(withDbAccessContext(system, () => insertMarker(f.device, f.org, 'remediated', '   ')))
      .rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23514');
    await expect(withDbAccessContext(system, () => insertMarker(f.device, f.org, 'rebooted', null)))
      .rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23514');
    await withDbAccessContext(system, () => insertMarker(f.device, f.org, 'remediated', 'Replaced failing NIC driver'));
  });

  it('keeps automatic markers unique per recovery, including cleared rows', async () => {
    const f = await fixture();
    const recoveryId = randomUUID();
    const insertAuto = () => db.execute(sql`
      INSERT INTO device_reliability_baselines (org_id, device_id, baseline_at, reason, source, source_ref, cleared_at)
      VALUES (${f.org}, ${f.device}, now(), 'reimaged', 'bare_metal_recovery', ${recoveryId}, now())`);
    await withDbAccessContext(system, insertAuto);
    await expect(withDbAccessContext(system, insertAuto)).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23505');
  });

  it('replays idempotently without deleting markers', async () => {
    const f = await fixture();
    await withDbAccessContext(system, () => insertMarker(f.device, f.org));
    await replayMigration(MIGRATION);
    const rows = await withDbAccessContext(system, () => db.execute(sql`SELECT id FROM device_reliability_baselines WHERE device_id = ${f.device}`));
    expect(rows).toHaveLength(1);
  });
});
