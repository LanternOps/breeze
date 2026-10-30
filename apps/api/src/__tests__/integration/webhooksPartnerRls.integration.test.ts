/** Partner-owned webhooks are partner-private plumbing (OD1); deliveries follow parent authority. */
import './setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { createOrganization, createPartner, createUser } from './db-utils';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import { executeOrgMerge } from '../../services/orgMerge';

const SYSTEM: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};
const partnerContext = (partnerId: string, orgIds: string[] = []): DbAccessContext => ({
  scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], userId: null,
});
const orgContext = (orgId: string, partnerId: string): DbAccessContext => ({
  scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [],
  currentPartnerId: partnerId, userId: null,
});

async function insertWebhook(partnerId: string | null, orgId: string | null) {
  const rows = await db.execute(sql`
    INSERT INTO webhooks (partner_id, org_id, name, url)
    VALUES (${partnerId}, ${orgId}, 'RLS webhook', 'https://example.com/webhook') RETURNING id
  `);
  return String(rows[0]!.id);
}
async function insertDelivery(webhookId: string, orgId: string | null, eventId = crypto.randomUUID()) {
  return db.execute(sql`
    INSERT INTO webhook_deliveries (webhook_id, org_id, event_type, event_id, payload)
    VALUES (${webhookId}, ${orgId}, 'alert.triggered', ${eventId}, '{}'::jsonb) RETURNING id, org_id
  `);
}

// SQL builders intentionally name the new columns so the red run reaches Postgres,
// rather than failing on a not-yet-added Drizzle property.
describe('webhooks partner ownership RLS', () => {
  it('rejects a cross-partner insert forge with 42501', async () => {
    const a = await createPartner();
    const b = await createPartner();
    await expect(withDbAccessContext(partnerContext(a.id), () => insertWebhook(b.id, null)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('rejects an org session forging a partner owner even when currentPartnerId matches', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await expect(withDbAccessContext(orgContext(org.id, partner.id), () => insertWebhook(partner.id, null)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it.each(['UPDATE', 'DELETE'] as const)('another partner cannot %s a partner webhook', async (command) => {
    const owner = await createPartner();
    const other = await createPartner();
    const webhookId = await withDbAccessContext(SYSTEM, () => insertWebhook(owner.id, null));
    const affected = await withDbAccessContext(partnerContext(other.id), () => db.execute(command === 'UPDATE'
      ? sql`UPDATE webhooks SET name = 'Forged edit' WHERE id = ${webhookId} RETURNING id`
      : sql`DELETE FROM webhooks WHERE id = ${webhookId} RETURNING id`));
    expect(affected).toHaveLength(0);
    const unchanged = await withDbAccessContext(SYSTEM, () => db.execute(sql`
      SELECT partner_id, org_id, name FROM webhooks WHERE id = ${webhookId}
    `));
    expect(unchanged).toEqual([{ partner_id: owner.id, org_id: null, name: 'RLS webhook' }]);
  });

  it('rejects re-owning an accessible webhook to another partner via WITH CHECK', async () => {
    const owner = await createPartner();
    const other = await createPartner();
    const webhookId = await withDbAccessContext(SYSTEM, () => insertWebhook(owner.id, null));
    await expect(withDbAccessContext(partnerContext(owner.id), () => db.execute(sql`
      UPDATE webhooks SET partner_id = ${other.id} WHERE id = ${webhookId}
    `))).rejects.toMatchObject({ cause: { code: '42501' } });
    const unchanged = await withDbAccessContext(SYSTEM, () => db.execute(sql`
      SELECT partner_id FROM webhooks WHERE id = ${webhookId}
    `));
    expect(unchanged[0]!.partner_id).toBe(owner.id);
  });

  it('rejects a delivery inserted by another partner under a partner webhook', async () => {
    const owner = await createPartner();
    const other = await createPartner();
    const org = await createOrganization({ partnerId: owner.id });
    const webhookId = await withDbAccessContext(SYSTEM, () => insertWebhook(owner.id, null));
    await expect(withDbAccessContext(partnerContext(other.id), () => insertDelivery(webhookId, org.id)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it.each(['both', 'neither'])('rejects %s owners with 23514', async (shape) => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await expect(withDbAccessContext(SYSTEM, () => insertWebhook(
      shape === 'both' ? partner.id : null, shape === 'both' ? org.id : null,
    ))).rejects.toMatchObject({ cause: { code: '23514', constraint_name: 'webhooks_one_owner_chk' } });
  });

  it('partner reads its own parent and deliveries; org and other-partner sessions read neither', async () => {
    const partner = await createPartner();
    const otherPartner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const webhookId = await withDbAccessContext(partnerContext(partner.id), () => insertWebhook(partner.id, null));
    await withDbAccessContext(SYSTEM, () => insertDelivery(webhookId, org.id));
    for (const context of [partnerContext(partner.id), orgContext(org.id, partner.id), partnerContext(otherPartner.id)]) {
      await withDbAccessContext(context, async () => {
        const parents = await db.execute(sql`SELECT id FROM webhooks WHERE id = ${webhookId}`);
        const children = await db.execute(sql`SELECT id FROM webhook_deliveries WHERE webhook_id = ${webhookId}`);
        const expected = context.scope === 'partner' && context.accessiblePartnerIds?.includes(partner.id) ? 1 : 0;
        expect(parents).toHaveLength(expected);
        expect(children).toHaveLength(expected);
      });
    }
  });

  it('org parent still grants org sessions read access to its deliveries', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const webhookId = await withDbAccessContext(SYSTEM, () => insertWebhook(null, org.id));
    await withDbAccessContext(SYSTEM, () => insertDelivery(webhookId, org.id));
    const rows = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      db.execute(sql`SELECT id FROM webhook_deliveries WHERE webhook_id = ${webhookId}`));
    expect(rows).toHaveLength(1);
  });

  it('rejects a foreign org on a partner webhook even in system scope', async () => {
    const partner = await createPartner();
    const foreignPartner = await createPartner();
    const foreign = await createOrganization({ partnerId: foreignPartner.id });
    const webhookId = await withDbAccessContext(SYSTEM, () => insertWebhook(partner.id, null));
    await expect(withDbAccessContext(SYSTEM, () => insertDelivery(webhookId, foreign.id)))
      .rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('rejects an org mismatch on an org webhook and auto-fills omitted org_id', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const otherOrg = await createOrganization({ partnerId: partner.id });
    const webhookId = await withDbAccessContext(SYSTEM, () => insertWebhook(null, org.id));
    await expect(withDbAccessContext(SYSTEM, () => insertDelivery(webhookId, otherOrg.id)))
      .rejects.toMatchObject({ cause: { code: '23514' } });
    const rows = await withDbAccessContext(SYSTEM, () => db.execute(sql`
      INSERT INTO webhook_deliveries (webhook_id, event_type, event_id, payload)
      VALUES (${webhookId}, 'alert.triggered', ${crypto.randomUUID()}, '{}'::jsonb) RETURNING org_id
    `));
    expect(rows[0]!.org_id).toBe(org.id);
  });

  it('permits NULL event org only for test- event ids, regardless of event type', async () => {
    const partner = await createPartner();
    const webhookId = await withDbAccessContext(SYSTEM, () => insertWebhook(partner.id, null));
    await expect(withDbAccessContext(SYSTEM, () => insertDelivery(webhookId, null)))
      .rejects.toMatchObject({ cause: { code: '23514' } });
    const rows = await withDbAccessContext(SYSTEM, () => insertDelivery(webhookId, null, `test-${crypto.randomUUID()}`));
    expect(rows[0]!.org_id).toBeNull();
  });

  it('org erasure deletes its partner-webhook deliveries but preserves the parent and other org events', async () => {
    const partner = await createPartner();
    const erased = await createOrganization({ partnerId: partner.id });
    const survivor = await createOrganization({ partnerId: partner.id });
    const webhookId = await withDbAccessContext(SYSTEM, () => insertWebhook(partner.id, null));
    await withDbAccessContext(SYSTEM, async () => {
      await insertDelivery(webhookId, erased.id);
      await insertDelivery(webhookId, survivor.id);
    });
    await cascadeDeleteOrg(erased.id, '00000000-0000-0000-0000-000000000000');
    await withDbAccessContext(SYSTEM, async () => {
      expect(await db.execute(sql`SELECT id FROM webhooks WHERE id = ${webhookId}`)).toHaveLength(1);
      const deliveries = await db.execute(sql`SELECT org_id FROM webhook_deliveries WHERE webhook_id = ${webhookId}`);
      expect(deliveries.map(row => row.org_id)).toEqual([survivor.id]);
    });
  });

  it('the merge engine repoints a partner-webhook delivery from loser to survivor and retains the partner webhook', async () => {
    const partner = await createPartner();
    const loser = await createOrganization({ partnerId: partner.id });
    const survivor = await createOrganization({ partnerId: partner.id });
    const actor = await createUser({ partnerId: partner.id });
    const webhookId = await withDbAccessContext(SYSTEM, () => insertWebhook(partner.id, null));
    const [delivery] = await withDbAccessContext(SYSTEM, () => insertDelivery(webhookId, loser.id));

    const priorDrain = process.env.ORG_MERGE_FENCE_DRAIN_MS;
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
    try {
      await executeOrgMerge({
        loserOrgId: loser.id,
        survivorOrgId: survivor.id,
        partnerId: partner.id,
        performedBy: actor.id,
        performedByEmail: actor.email,
      });
    } finally {
      if (priorDrain === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
      else process.env.ORG_MERGE_FENCE_DRAIN_MS = priorDrain;
    }

    await withDbAccessContext(SYSTEM, async () => {
      const deliveries = await db.execute(sql`
        SELECT org_id, webhook_id, payload FROM webhook_deliveries WHERE id = ${delivery!.id}
      `);
      expect(deliveries).toEqual([{ org_id: survivor.id, webhook_id: webhookId, payload: {} }]);
      const parents = await db.execute(sql`SELECT partner_id, org_id FROM webhooks WHERE id = ${webhookId}`);
      expect(parents).toEqual([{ partner_id: partner.id, org_id: null }]);
    });
  });
});
