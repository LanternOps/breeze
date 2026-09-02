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
  accountingConnectionId: string;
  catalogItemId: string;
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
    INSERT INTO organizations (partner_id, name, slug, status, currency_code, created_at, updated_at)
    VALUES (${partnerId}, 'Org To Erase', ${eraseSlug}, 'active', 'USD', now(), now())
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [control] = (await testDb.execute(sql`
    INSERT INTO organizations (partner_id, name, slug, status, currency_code, created_at, updated_at)
    VALUES (${partnerId}, 'Control Org', ${controlSlug}, 'active', 'USD', now(), now())
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

  // QuickBooks entity mappings (Phase B). The table is partner-axis with a
  // POLYMORPHIC (breeze_entity_type, breeze_entity_id) Breeze side — no org_id
  // column, no FK — so it is invisible to the cascade contract test's org_id
  // enumeration and is cleared by an explicit ASSOCIATED_SYSTEM_SCOPED_TABLES
  // pre-clear instead. Three rows: the erased org's mapping (must go), the
  // control org's (must survive), and a partner-scoped catalog_item mapping
  // (must survive — it belongs to no org at all).
  const [connection] = (await testDb.execute(sql`
    INSERT INTO accounting_connections (partner_id, provider, environment, status, home_currency)
    VALUES (${partnerId}, 'quickbooks', 'sandbox', 'connected', 'USD')
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const accountingConnectionId = connection!.id;

  const [catalogItem] = (await testDb.execute(sql`
    INSERT INTO catalog_items (partner_id, item_type, name, unit_price, cost_currency)
    VALUES (${partnerId}, 'service', 'Managed Service', 100.00, 'USD')
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const catalogItemId = catalogItem!.id;

  await testDb.execute(sql`
    INSERT INTO accounting_entity_mappings
      (integration_id, partner_id, breeze_entity_type, breeze_entity_id, remote_entity_type, remote_entity_id, link_status, sync_status)
    VALUES
      (${accountingConnectionId}, ${partnerId}, 'org', ${orgIdToErase}, 'Customer', 'qbo-cust-erased', 'confirmed', 'synced'),
      (${accountingConnectionId}, ${partnerId}, 'org', ${orgIdControl}, 'Customer', 'qbo-cust-control', 'confirmed', 'synced'),
      (${accountingConnectionId}, ${partnerId}, 'catalog_item', ${catalogItemId}, 'Item', 'qbo-item-1', 'confirmed', 'synced')
  `);

  return {
    partnerId,
    orgIdToErase,
    orgIdControl,
    userId,
    siteIdErased,
    siteIdControl,
    accountingConnectionId,
    catalogItemId,
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

  it('erases the QuickBooks entity mapping that names the erased org and keeps the others', async () => {
    const testDb = getTestDb();
    const stats = await cascadeDeleteOrg(handles.orgIdToErase, handles.userId);

    expect(stats.tablesDeleted.accounting_entity_mappings).toBe(1);

    const survivors = (await testDb.execute(sql`
      SELECT breeze_entity_type, breeze_entity_id, remote_entity_id
        FROM accounting_entity_mappings
       WHERE integration_id = ${handles.accountingConnectionId}
       ORDER BY remote_entity_id
    `)) as unknown as Array<{
      breeze_entity_type: string;
      breeze_entity_id: string;
      remote_entity_id: string;
    }>;

    // The erased org's UUID and the QuickBooks Customer id it was billed under
    // are BOTH gone — that pairing is exactly what erasure exists to remove.
    expect(survivors.map((r) => r.remote_entity_id)).toEqual(['qbo-cust-control', 'qbo-item-1']);
    expect(survivors.some((r) => r.breeze_entity_id === handles.orgIdToErase)).toBe(false);
    // The partner's catalog_item mapping belongs to no org and must not be
    // collateral damage.
    expect(survivors).toContainEqual(
      expect.objectContaining({ breeze_entity_type: 'catalog_item', breeze_entity_id: handles.catalogItemId }),
    );
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
