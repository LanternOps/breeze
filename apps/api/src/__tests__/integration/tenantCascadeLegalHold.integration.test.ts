/**
 * End-to-end proof that `cascadeDeleteOrg` refuses org erasure while a
 * backup snapshot for that org is under an active legal hold, and that it
 * erases normally once no hold is active.
 *
 * Real Postgres, a privileged seed connection via `getTestDb()`, and the actual
 * `cascadeDeleteOrg` service (breeze_app pool). Complements the structural
 * cascade-list contract in `tenantCascade.integration.test.ts` and the
 * breadth suite in `tenantCascadeErasureBreadth.integration.test.ts`.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { cascadeDeleteOrg, TenantCascadeRefusalError } from '../../services/tenantCascade';

const PERFORMED_BY = '00000000-0000-0000-0000-0000000000aa';

interface SeededOrg {
  orgId: string;
  siteId: string;
  deviceId: string;
  snapshotId: string;
}

async function seedOrgWithSnapshot(legalHold: boolean): Promise<SeededOrg> {
  const testDb = getTestDb();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const partnerSlug = `legal-hold-test-${suffix}`;

  const [partner] = (await testDb.execute(sql`
    INSERT INTO partners (name, slug, status, created_at, updated_at)
    VALUES ('Legal Hold Test Partner', ${partnerSlug}, 'active', now(), now())
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const partnerId = partner!.id;

  const [org] = (await testDb.execute(sql`
    INSERT INTO organizations (partner_id, name, slug, status, currency_code, created_at, updated_at)
    VALUES (${partnerId}, 'Legal Hold Test Org', ${`org-${suffix}`}, 'active', 'USD', now(), now())
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const orgId = org!.id;

  const [site] = (await testDb.execute(sql`
    INSERT INTO sites (org_id, name, created_at, updated_at)
    VALUES (${orgId}, 'Legal Hold Test Site', now(), now())
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const siteId = site!.id;

  const [device] = (await testDb.execute(sql`
    INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
    VALUES (${orgId}, ${siteId}, ${crypto.randomUUID()}, 'legal-hold-fixture', 'windows', '11', 'amd64', '1.0.0')
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const deviceId = device!.id;

  const [config] = (await testDb.execute(sql`
    INSERT INTO backup_configs (org_id, name, type, provider, provider_config)
    VALUES (${orgId}, 'Legal hold fixture', 'file', 'local', '{}') RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [job] = (await testDb.execute(sql`
    INSERT INTO backup_jobs (org_id, config_id, device_id)
    VALUES (${orgId}, ${config!.id}, ${deviceId}) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [snapshot] = (await testDb.execute(sql`
    INSERT INTO backup_snapshots (org_id, job_id, device_id, snapshot_id, legal_hold)
    VALUES (${orgId}, ${job!.id}, ${deviceId}, ${crypto.randomUUID()}, ${legalHold})
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const snapshotId = snapshot!.id;

  return { orgId, siteId, deviceId, snapshotId };
}

describe('cascadeDeleteOrg — active legal hold refusal (real Postgres)', () => {
  it('refuses erasure and deletes NOTHING while a snapshot is under legal hold', async () => {
    const testDb = getTestDb();
    const { orgId, siteId, deviceId, snapshotId } = await seedOrgWithSnapshot(true);

    await expect(cascadeDeleteOrg(orgId, PERFORMED_BY)).rejects.toThrow(
      TenantCascadeRefusalError,
    );

    // Nothing was deleted: org, site, device and snapshot all still exist.
    const [org] = (await testDb.execute(
      sql`SELECT id FROM organizations WHERE id = ${orgId}`,
    )) as unknown as Array<{ id: string }>;
    const [site] = (await testDb.execute(
      sql`SELECT id FROM sites WHERE id = ${siteId}`,
    )) as unknown as Array<{ id: string }>;
    const [device] = (await testDb.execute(
      sql`SELECT id FROM devices WHERE id = ${deviceId}`,
    )) as unknown as Array<{ id: string }>;
    const [snapshot] = (await testDb.execute(
      sql`SELECT id FROM backup_snapshots WHERE id = ${snapshotId}`,
    )) as unknown as Array<{ id: string }>;
    expect(org?.id).toBe(orgId);
    expect(site?.id).toBe(siteId);
    expect(device?.id).toBe(deviceId);
    expect(snapshot?.id).toBe(snapshotId);

    // The refusal itself was audited (org_id NULL system-scope row).
    const [auditRow] = (await testDb.execute(sql`
      SELECT action, result FROM audit_logs
       WHERE action = 'tenant.erasure.refused_legal_hold'
         AND resource_id = ${orgId}
       ORDER BY timestamp DESC
       LIMIT 1
    `)) as unknown as Array<{ action: string; result: string }>;
    expect(auditRow?.action).toBe('tenant.erasure.refused_legal_hold');
    expect(auditRow?.result).toBe('failure');
  });

  it('erases normally when no snapshot is under legal hold', async () => {
    const testDb = getTestDb();
    const { orgId, siteId, deviceId, snapshotId } = await seedOrgWithSnapshot(false);

    const stats = await cascadeDeleteOrg(orgId, PERFORMED_BY);
    expect(stats.orgId).toBe(orgId);

    const orgRows = (await testDb.execute(
      sql`SELECT id FROM organizations WHERE id = ${orgId}`,
    )) as unknown as Array<{ id: string }>;
    const siteRows = (await testDb.execute(
      sql`SELECT id FROM sites WHERE id = ${siteId}`,
    )) as unknown as Array<{ id: string }>;
    const deviceRows = (await testDb.execute(
      sql`SELECT id FROM devices WHERE id = ${deviceId}`,
    )) as unknown as Array<{ id: string }>;
    const snapshotRows = (await testDb.execute(
      sql`SELECT id FROM backup_snapshots WHERE id = ${snapshotId}`,
    )) as unknown as Array<{ id: string }>;
    expect(orgRows).toHaveLength(0);
    expect(siteRows).toHaveLength(0);
    expect(deviceRows).toHaveLength(0);
    expect(snapshotRows).toHaveLength(0);
  });
});
