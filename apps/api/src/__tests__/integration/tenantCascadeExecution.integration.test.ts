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
 *
 * Scope note (#3880): this file is the REGRESSION suite — its fixture is
 * shaped around specific shipped bugs (#4100, the QuickBooks polymorphic
 * mapping pre-clear, the #3258 composite portal_users FK) and it asserts
 * named tables. Breadth (zero residual rows across the WHOLE cascade list,
 * self-referencing chains, device-scoped denormalized org_id, partner-wide
 * org_id-NULL rows) and the mid-walk failure semantics live in
 * `tenantCascadeErasureBreadth.integration.test.ts`. Add a new named
 * regression fixture here; add a new shape class there.
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
  invoiceIdErased: string;
  invoiceIdControl: string;
  invoicePaymentIdErased: string;
  invoicePaymentIdControl: string;
  webhookIdErased: string;
  webhookIdControl: string;
  webhookDeliveryIdErased: string;
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

  // QuickBooks entity mappings (Phase B/C). The table is partner-axis with a
  // POLYMORPHIC (breeze_entity_type, breeze_entity_id) Breeze side — no org_id
  // column, no FK — so it is invisible to the cascade contract test's org_id
  // enumeration and is cleared by an explicit ASSOCIATED_SYSTEM_SCOPED_TABLES
  // pre-clear instead. Rows: the erased org's mapping (must go), the control
  // org's (must survive), a partner-scoped catalog_item mapping (must
  // survive — it belongs to no org at all), plus Phase C invoice/payment
  // mappings on each org (erased org's must go, control org's must survive).
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

  // Phase C: one invoice + one payment per org, so the invoice/payment
  // mapping arms have a real breeze_entity_id to join through.
  const [invoiceErased] = (await testDb.execute(sql`
    INSERT INTO invoices (partner_id, org_id, currency_code, status)
    VALUES (${partnerId}, ${orgIdToErase}, 'USD', 'sent')
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const invoiceIdErased = invoiceErased!.id;

  const [invoiceControl] = (await testDb.execute(sql`
    INSERT INTO invoices (partner_id, org_id, currency_code, status)
    VALUES (${partnerId}, ${orgIdControl}, 'USD', 'sent')
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const invoiceIdControl = invoiceControl!.id;

  const [paymentErased] = (await testDb.execute(sql`
    INSERT INTO invoice_payments (invoice_id, org_id, amount, method, received_at)
    VALUES (${invoiceIdErased}, ${orgIdToErase}, 50.00, 'card', now())
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const invoicePaymentIdErased = paymentErased!.id;

  const [paymentControl] = (await testDb.execute(sql`
    INSERT INTO invoice_payments (invoice_id, org_id, amount, method, received_at)
    VALUES (${invoiceIdControl}, ${orgIdControl}, 50.00, 'card', now())
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const invoicePaymentIdControl = paymentControl!.id;

  await testDb.execute(sql`
    INSERT INTO accounting_entity_mappings
      (integration_id, partner_id, breeze_entity_type, breeze_entity_id, remote_entity_type, remote_entity_id, link_status, sync_status)
    VALUES
      (${accountingConnectionId}, ${partnerId}, 'org', ${orgIdToErase}, 'Customer', 'qbo-cust-erased', 'confirmed', 'synced'),
      (${accountingConnectionId}, ${partnerId}, 'org', ${orgIdControl}, 'Customer', 'qbo-cust-control', 'confirmed', 'synced'),
      (${accountingConnectionId}, ${partnerId}, 'catalog_item', ${catalogItemId}, 'Item', 'qbo-item-1', 'confirmed', 'synced'),
      (${accountingConnectionId}, ${partnerId}, 'invoice', ${invoiceIdErased}, 'Invoice', 'qbo-inv-erased', 'confirmed', 'synced'),
      (${accountingConnectionId}, ${partnerId}, 'invoice', ${invoiceIdControl}, 'Invoice', 'qbo-inv-control', 'confirmed', 'synced'),
      (${accountingConnectionId}, ${partnerId}, 'payment', ${invoicePaymentIdErased}, 'Payment', 'qbo-pay-erased', 'confirmed', 'synced'),
      (${accountingConnectionId}, ${partnerId}, 'payment', ${invoicePaymentIdControl}, 'Payment', 'qbo-pay-control', 'confirmed', 'synced')
  `);

  // Regression fixture for #4100: webhooks IS in CORE_ORG_CASCADE_DELETE_ORDER,
  // but webhook_deliveries has no org_id column (invisible to the cascade
  // contract test's org_id auto-discovery) and formerly had no ON DELETE
  // action on its webhook_id FK — so a populated delivery row made the plain
  // `DELETE FROM webhooks WHERE org_id = ...` below raise 23503 and abort the
  // whole erasure. One webhook + delivery per org, mirroring the
  // erased/control shape used throughout this fixture.
  const [webhookErased] = (await testDb.execute(sql`
    INSERT INTO webhooks (org_id, name, url, events)
    VALUES (${orgIdToErase}, 'Erase Webhook', 'https://example.com/erase', ARRAY['ticket.created'])
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [webhookControl] = (await testDb.execute(sql`
    INSERT INTO webhooks (org_id, name, url, events)
    VALUES (${orgIdControl}, 'Control Webhook', 'https://example.com/control', ARRAY['ticket.created'])
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const webhookIdErased = webhookErased!.id;
  const webhookIdControl = webhookControl!.id;

  const [deliveryErased] = (await testDb.execute(sql`
    INSERT INTO webhook_deliveries (webhook_id, event_type, event_id, payload)
    VALUES (${webhookIdErased}, 'ticket.created', 'evt-erased-1', '{}'::jsonb)
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  await testDb.execute(sql`
    INSERT INTO webhook_deliveries (webhook_id, event_type, event_id, payload)
    VALUES (${webhookIdControl}, 'ticket.created', 'evt-control-1', '{}'::jsonb)
  `);
  const webhookDeliveryIdErased = deliveryErased!.id;

  return {
    partnerId,
    orgIdToErase,
    orgIdControl,
    userId,
    siteIdErased,
    siteIdControl,
    accountingConnectionId,
    catalogItemId,
    invoiceIdErased,
    invoiceIdControl,
    invoicePaymentIdErased,
    invoicePaymentIdControl,
    webhookIdErased,
    webhookIdControl,
    webhookDeliveryIdErased,
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

    // org + invoice + payment mapping rows for the erased org.
    expect(stats.tablesDeleted.accounting_entity_mappings).toBe(3);

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
    // Same for the erased org's invoice and payment mappings (Phase C).
    expect(survivors.map((r) => r.remote_entity_id)).toEqual([
      'qbo-cust-control',
      'qbo-inv-control',
      'qbo-item-1',
      'qbo-pay-control',
    ]);
    expect(survivors.some((r) => r.breeze_entity_id === handles.orgIdToErase)).toBe(false);
    expect(survivors.some((r) => r.breeze_entity_id === handles.invoiceIdErased)).toBe(false);
    expect(survivors.some((r) => r.breeze_entity_id === handles.invoicePaymentIdErased)).toBe(false);
    // The partner's catalog_item mapping belongs to no org and must not be
    // collateral damage.
    expect(survivors).toContainEqual(
      expect.objectContaining({ breeze_entity_type: 'catalog_item', breeze_entity_id: handles.catalogItemId }),
    );
    // Control org's invoice/payment mappings must survive untouched.
    expect(survivors).toContainEqual(
      expect.objectContaining({ breeze_entity_type: 'invoice', breeze_entity_id: handles.invoiceIdControl }),
    );
    expect(survivors).toContainEqual(
      expect.objectContaining({ breeze_entity_type: 'payment', breeze_entity_id: handles.invoicePaymentIdControl }),
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

  // Regression test for #4100.
  it('erases an org with a populated webhook_deliveries row instead of aborting on FK violation', async () => {
    const testDb = getTestDb();

    // Before the fix, this threw a 23503 FK violation (webhook_deliveries.
    // webhook_id had no ON DELETE action) and the erasure aborted entirely —
    // the assertion that matters here is that this does NOT throw.
    const stats = await cascadeDeleteOrg(handles.orgIdToErase, handles.userId);

    expect(stats.tablesDeleted.webhooks).toBe(1);

    const erasedWebhookRows = (await testDb.execute(
      sql`SELECT id FROM webhooks WHERE id = ${handles.webhookIdErased}`,
    )) as unknown as unknown[];
    expect(erasedWebhookRows.length).toBe(0);

    // The delivery row has no org_id of its own — it is gone because
    // ON DELETE CASCADE removed it when its parent webhook was deleted, not
    // because the cascade loop targeted webhook_deliveries directly.
    const erasedDeliveryRows = (await testDb.execute(
      sql`SELECT id FROM webhook_deliveries WHERE id = ${handles.webhookDeliveryIdErased}`,
    )) as unknown as unknown[];
    expect(erasedDeliveryRows.length).toBe(0);

    // Control org's webhook + delivery are untouched.
    const controlWebhookRows = (await testDb.execute(
      sql`SELECT id FROM webhooks WHERE id = ${handles.webhookIdControl}`,
    )) as unknown as unknown[];
    expect(controlWebhookRows.length).toBe(1);

    const controlDeliveryRows = (await testDb.execute(
      sql`SELECT id FROM webhook_deliveries WHERE webhook_id = ${handles.webhookIdControl}`,
    )) as unknown as unknown[];
    expect(controlDeliveryRows.length).toBe(1);
  });

  // #3258 follow-up: portal_users.contact_id became a COMPOSITE
  // (contact_id, org_id) -> contacts (id, org_id) FK, which adds a new edge to
  // the graph topologicalCascadeOrder() reads. Its pg_constraint query counts
  // every FK edge regardless of `confdeltype`, so the new edge makes
  // `portal_users` a CHILD of `contacts` and moves it EARLIER in the erasure.
  //
  // Two failure modes this rules out: a 23503 if the order had come out
  // parents-first, and a 23502 if the referential action had been a BARE
  // composite `SET NULL` (which would target the NOT NULL org_id) and fired
  // here. Neither is visible from the cascade-list contract test, which reads
  // the Drizzle schema and never deletes a row.
  it('erases an org whose portal login is linked to one of its contacts', async () => {
    const testDb = getTestDb();

    const [contact] = (await testDb.execute(sql`
      INSERT INTO contacts (org_id, name, email, created_at, updated_at)
      VALUES (${handles.orgIdToErase}, 'Erased Person', ${`erase-${Date.now()}@example.test`}, now(), now())
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    const [login] = (await testDb.execute(sql`
      INSERT INTO portal_users (org_id, email, name, contact_id, created_at, updated_at)
      VALUES (${handles.orgIdToErase}, ${`erase-login-${Date.now()}@example.test`}, 'Erased Login', ${contact!.id}, now(), now())
      RETURNING id
    `)) as unknown as Array<{ id: string }>;

    // The assertion that matters: this does not throw.
    const stats = await cascadeDeleteOrg(handles.orgIdToErase, handles.userId);
    expect(stats.tablesDeleted.contacts).toBe(1);
    expect(stats.tablesDeleted.portal_users).toBe(1);

    // No orphan on either side.
    const remainingLogins = (await testDb.execute(
      sql`SELECT id FROM portal_users WHERE id = ${login!.id}`,
    )) as unknown as unknown[];
    expect(remainingLogins.length).toBe(0);
    const remainingContacts = (await testDb.execute(
      sql`SELECT id FROM contacts WHERE id = ${contact!.id}`,
    )) as unknown as unknown[];
    expect(remainingContacts.length).toBe(0);
  });
});
