/**
 * Functional RLS and integrity proof for accounting_entity_mappings.
 *
 * The polymorphic breeze_entity_id cannot use an ordinary FK, so the migration
 * supplies an ownership trigger. These tests exercise the table through the
 * real unprivileged breeze_app pool and prove both the RLS axis and trigger.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { accountingConnections, catalogItems, organizations } from '../../db/schema';
import { createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function partnerContext(partnerId: string, accessibleOrgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

async function seedPartnerFixture(label: string) {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const [connection] = await db.insert(accountingConnections).values({
      partnerId: partner.id,
      provider: 'quickbooks',
      environment: 'sandbox',
    }).returning({ id: accountingConnections.id });
    const [org] = await db.insert(organizations).values({
      partnerId: partner.id,
      name: `${label} Organization`,
      slug: `${label.toLowerCase()}-${partner.id.slice(0, 8)}`,
      type: 'customer',
      currencyCode: 'USD',
    }).returning({ id: organizations.id });
    const [item] = await db.insert(catalogItems).values({
      partnerId: partner.id,
      itemType: 'service',
      name: `${label} Service`,
      billingType: 'one_time',
      unitPrice: '100.00',
      costCurrency: 'USD',
    }).returning({ id: catalogItems.id });
    if (!connection || !org || !item) throw new Error('failed to seed accounting mapping fixture');
    return { partner, connection, org, item };
  });
}

function sqlCause(error: unknown): { code?: string; message?: string } {
  return (error as { cause?: { code?: string; message?: string } }).cause ?? {};
}

describe('accounting_entity_mappings RLS and integrity', () => {
  runDb('allows a partner to map its own organization', async () => {
    const fx = await seedPartnerFixture('Own');

    const rows = await withDbAccessContext(partnerContext(fx.partner.id, [fx.org.id]), () => db.execute(sql`
      INSERT INTO accounting_entity_mappings (
        integration_id, partner_id, breeze_entity_type, breeze_entity_id,
        remote_entity_type, remote_entity_id, remote_sync_token, link_status, sync_status
      ) VALUES (
        ${fx.connection.id}, ${fx.partner.id}, 'org', ${fx.org.id},
        'Customer', 'qbo-customer-1', '0', 'confirmed', 'synced'
      )
      RETURNING remote_entity_id
    `)) as unknown as Array<{ remote_entity_id: string }>;

    expect(rows).toEqual([{ remote_entity_id: 'qbo-customer-1' }]);
  });

  runDb('rejects a partner mapping an organization owned by another partner', async () => {
    const partnerA = await seedPartnerFixture('Partner A');
    const partnerB = await seedPartnerFixture('Partner B');

    let caught: unknown;
    try {
      await withDbAccessContext(partnerContext(partnerB.partner.id, [partnerB.org.id]), () => db.execute(sql`
        INSERT INTO accounting_entity_mappings (
          integration_id, partner_id, breeze_entity_type, breeze_entity_id,
          remote_entity_type, link_status, sync_status
        ) VALUES (
          ${partnerB.connection.id}, ${partnerB.partner.id}, 'org', ${partnerA.org.id},
          'Customer', 'suggested', 'pending'
        )
      `));
    } catch (error) {
      caught = error;
    }

    expect(sqlCause(caught).code).toBe('23514');
    expect(sqlCause(caught).message).toMatch(/does not belong to partner/i);
  });

  runDb('prevents two Breeze entities from claiming one remote item', async () => {
    const fx = await seedPartnerFixture('Duplicate');
    const [secondItem] = await withSystemDbAccessContext(() => db.insert(catalogItems).values({
      partnerId: fx.partner.id,
      itemType: 'service',
      name: 'Second Service',
      billingType: 'one_time',
      unitPrice: '50.00',
      costCurrency: 'USD',
    }).returning({ id: catalogItems.id }));
    if (!secondItem) throw new Error('failed to seed second catalog item');

    await withDbAccessContext(partnerContext(fx.partner.id, [fx.org.id]), () => db.execute(sql`
      INSERT INTO accounting_entity_mappings (
        integration_id, partner_id, breeze_entity_type, breeze_entity_id,
        remote_entity_type, remote_entity_id, link_status, sync_status
      ) VALUES (
        ${fx.connection.id}, ${fx.partner.id}, 'catalog_item', ${fx.item.id},
        'Item', 'qbo-item-9', 'confirmed', 'synced'
      )
    `));

    let caught: unknown;
    try {
      await withDbAccessContext(partnerContext(fx.partner.id, [fx.org.id]), () => db.execute(sql`
        INSERT INTO accounting_entity_mappings (
          integration_id, partner_id, breeze_entity_type, breeze_entity_id,
          remote_entity_type, remote_entity_id, link_status, sync_status
        ) VALUES (
          ${fx.connection.id}, ${fx.partner.id}, 'catalog_item', ${secondItem.id},
          'Item', 'qbo-item-9', 'confirmed', 'synced'
        )
      `));
    } catch (error) {
      caught = error;
    }

    expect(sqlCause(caught).code).toBe('23505');
  });

  runDb('cascades mappings when the accounting connection is deleted', async () => {
    const fx = await seedPartnerFixture('Cascade');
    await withDbAccessContext(partnerContext(fx.partner.id, [fx.org.id]), () => db.execute(sql`
      INSERT INTO accounting_entity_mappings (
        integration_id, partner_id, breeze_entity_type, breeze_entity_id,
        remote_entity_type, remote_entity_id, link_status, sync_status
      ) VALUES (
        ${fx.connection.id}, ${fx.partner.id}, 'org', ${fx.org.id},
        'Customer', 'qbo-cascade', 'confirmed', 'synced'
      )
    `));

    await withSystemDbAccessContext(() => db.delete(accountingConnections));
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT id FROM accounting_entity_mappings WHERE integration_id = ${fx.connection.id}
    `));

    expect(rows).toHaveLength(0);
  });
});
