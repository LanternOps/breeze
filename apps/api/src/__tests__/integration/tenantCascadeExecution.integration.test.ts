/**
 * End-to-end integration test for `cascadeDeleteOrg` (Task 30).
 *
 * Seeds a partner + 2 orgs, plus a few rows in 4 tenant-scoped tables
 * for each org, then erases ONE org and verifies:
 *   1. Every row keyed on the erased org is gone.
 *   2. Every row keyed on the control org is still there (the cascade
 *      did not leak across tenants).
 *   3. The `tenant.erasure.started` + `tenant.erasure.completed` audit
 *      events were written with org_id = NULL (system scope) so they
 *      survived the cascade.
 *   4. The org row itself is gone.
 *
 * The test exercises real Postgres, the breeze_audit_admin role
 * bypass for audit_logs, and the topological FK order against the
 * actual schema. Runs under the integration config which connects to
 * the test docker-compose stack.
 */
import './setup';
import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { cascadeDeleteOrg } from '../../services/tenantCascade';

interface SeedHandles {
  partnerId: string;
  orgIdToErase: string;
  orgIdControl: string;
  userId: string;
  siteIdErased: string;
  siteIdControl: string;
}

async function seed(): Promise<SeedHandles> {
  const testDb = getTestDb();

  // Use superuser test client (no RLS) so we can side-step org-scope
  // for the seed. This mirrors how other integration tests seed.
  // Unique slug suffix to avoid collisions across reruns.
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const partnerSlug = `cascade-test-${suffix}`;
  const userEmail = `cascade-test-${suffix}@example.com`;
  const eraseSlug = `org-erase-${suffix}`;
  const controlSlug = `org-control-${suffix}`;

  const [partner] = (await testDb.execute(sql`
    INSERT INTO partners (name, slug, status, created_at, updated_at)
    VALUES ('Cascade Test Partner', ${partnerSlug}, 'active', now(), now())
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const partnerId = partner!.id;

  const [user] = (await testDb.execute(sql`
    INSERT INTO users (partner_id, email, name, status, created_at, updated_at)
    VALUES (${partnerId}, ${userEmail}, 'Cascade Tester', 'active', now(), now())
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const userId = user!.id;

  // Two orgs under the same partner.
  const [erased] = (await testDb.execute(sql`
    INSERT INTO organizations (partner_id, name, slug, status, created_at, updated_at)
    VALUES (${partnerId}, 'Org To Erase', ${eraseSlug}, 'active', now(), now())
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [control] = (await testDb.execute(sql`
    INSERT INTO organizations (partner_id, name, slug, status, created_at, updated_at)
    VALUES (${partnerId}, 'Control Org', ${controlSlug}, 'active', now(), now())
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const orgIdToErase = erased!.id;
  const orgIdControl = control!.id;

  // Sites for each org.
  const [siteE] = (await testDb.execute(sql`
    INSERT INTO sites (org_id, name, created_at, updated_at)
    VALUES (${orgIdToErase}, 'Erase Site', now(), now())
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [siteC] = (await testDb.execute(sql`
    INSERT INTO sites (org_id, name, created_at, updated_at)
    VALUES (${orgIdControl}, 'Control Site', now(), now())
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const siteIdErased = siteE!.id;
  const siteIdControl = siteC!.id;

  // An alert template per org — simpler schema than devices, exercises
  // a non-FK-chained org-scoped row.
  await testDb.execute(sql`
    INSERT INTO alert_templates (org_id, name, conditions, severity, title_template, message_template)
    VALUES (${orgIdToErase}, 'Erase Template', '{}'::jsonb, 'info', 't', 'm')
  `);
  await testDb.execute(sql`
    INSERT INTO alert_templates (org_id, name, conditions, severity, title_template, message_template)
    VALUES (${orgIdControl}, 'Control Template', '{}'::jsonb, 'info', 't', 'm')
  `);

  // A pre-existing audit row for the erased org — verifies the
  // breeze_audit_admin bypass actually deletes it.
  await testDb.execute(sql`
    INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result, timestamp)
    VALUES (${orgIdToErase}, 'user', ${userId}, 'test.seed', 'test', 'success', now())
  `);
  await testDb.execute(sql`
    INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result, timestamp)
    VALUES (${orgIdControl}, 'user', ${userId}, 'test.seed', 'test', 'success', now())
  `);

  return {
    partnerId,
    orgIdToErase,
    orgIdControl,
    userId,
    siteIdErased,
    siteIdControl,
  };
}

describe('cascadeDeleteOrg — end-to-end', () => {
  let handles: SeedHandles;

  beforeEach(async () => {
    handles = await seed();
  });

  it('removes every row keyed on the erased org and leaves the control org intact', async () => {
    const testDb = getTestDb();
    const stats = await cascadeDeleteOrg(handles.orgIdToErase, handles.userId);

    // Sanity: stats summary.
    expect(stats.orgId).toBe(handles.orgIdToErase);
    expect(stats.totalRowsDeleted).toBeGreaterThan(0);
    expect(stats.tablesDeleted.organizations).toBe(1);
    expect(stats.tablesDeleted.sites).toBe(1);
    expect(stats.tablesDeleted.alert_templates).toBe(1);
    expect(stats.tablesDeleted.audit_logs ?? 0).toBeGreaterThanOrEqual(1);

    // Erased rows gone.
    const erasedSiteRows = (await testDb.execute(
      sql`SELECT id FROM sites WHERE id = ${handles.siteIdErased}`,
    )) as unknown as unknown[];
    expect(erasedSiteRows.length).toBe(0);

    const erasedOrgRows = (await testDb.execute(
      sql`SELECT id FROM organizations WHERE id = ${handles.orgIdToErase}`,
    )) as unknown as unknown[];
    expect(erasedOrgRows.length).toBe(0);

    const erasedAuditRows = (await testDb.execute(
      sql`SELECT id FROM audit_logs WHERE org_id = ${handles.orgIdToErase}`,
    )) as unknown as unknown[];
    expect(erasedAuditRows.length).toBe(0);

    const erasedAlertTemplateRows = (await testDb.execute(
      sql`SELECT id FROM alert_templates WHERE org_id = ${handles.orgIdToErase}`,
    )) as unknown as unknown[];
    expect(erasedAlertTemplateRows.length).toBe(0);

    // Control rows untouched.
    const controlSiteRows = (await testDb.execute(
      sql`SELECT id FROM sites WHERE id = ${handles.siteIdControl}`,
    )) as unknown as unknown[];
    expect(controlSiteRows.length).toBe(1);

    const controlOrgRows = (await testDb.execute(
      sql`SELECT id FROM organizations WHERE id = ${handles.orgIdControl}`,
    )) as unknown as unknown[];
    expect(controlOrgRows.length).toBe(1);

    const controlAuditRows = (await testDb.execute(
      sql`SELECT id FROM audit_logs WHERE org_id = ${handles.orgIdControl}`,
    )) as unknown as unknown[];
    expect(controlAuditRows.length).toBe(1);

    const controlAlertTemplateRows = (await testDb.execute(
      sql`SELECT id FROM alert_templates WHERE org_id = ${handles.orgIdControl}`,
    )) as unknown as unknown[];
    expect(controlAlertTemplateRows.length).toBe(1);
  });

  it('writes tenant.erasure.started and tenant.erasure.completed events with org_id = NULL', async () => {
    const testDb = getTestDb();
    await cascadeDeleteOrg(handles.orgIdToErase, handles.userId);

    const auditRows = (await testDb.execute(sql`
      SELECT action, org_id, actor_id, result, details
      FROM audit_logs
      WHERE resource_id = ${handles.orgIdToErase}
        AND action LIKE 'tenant.erasure.%'
      ORDER BY timestamp ASC
    `)) as unknown as Array<{
      action: string;
      org_id: string | null;
      actor_id: string;
      result: string;
      details: Record<string, unknown>;
    }>;

    expect(auditRows.length).toBeGreaterThanOrEqual(2);
    const actions = auditRows.map((r) => r.action);
    expect(actions).toContain('tenant.erasure.started');
    expect(actions).toContain('tenant.erasure.completed');

    for (const row of auditRows) {
      expect(row.org_id).toBeNull();
      expect(row.actor_id).toBe(handles.userId);
      expect(row.result).toBe('success');
    }
  });

  it('is idempotent — a re-run on an already-erased org deletes zero rows', async () => {
    await cascadeDeleteOrg(handles.orgIdToErase, handles.userId);
    const stats = await cascadeDeleteOrg(handles.orgIdToErase, handles.userId);
    // Org was already erased; every cascade-list table matches zero rows.
    expect(stats.totalRowsDeleted).toBe(0);
  });
});
