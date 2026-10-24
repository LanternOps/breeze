/**
 * #8972 W1 Review Focus #1 (spec §3.2): org erasure deletes survivors and
 * their merged tombstones together. `tickets_merged_into_org_fk` is
 * ON DELETE NO ACTION, so a cascade that deleted a survivor in an earlier
 * statement or batch than its tombstone would fail 23503 mid-erasure.
 * `tenantCascade.deleteOrgRows` deletes every `tickets` row of the org in one
 * statement, where the NO ACTION check runs at statement end.
 */
import './setup';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function insertTicket(orgId: string, partnerId: string): Promise<string> {
  const rows = (await getTestDb().execute(sql`
    INSERT INTO tickets (org_id, partner_id, subject, source, priority, ticket_number)
    VALUES (${orgId}::uuid, ${partnerId}::uuid, 'erasure', 'api', 'normal', ${`ERS-${crypto.randomUUID().slice(0, 8)}`})
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return rows[0]!.id;
}

describe('org erasure with merged tickets (#8972 W1, Review Focus #1)', () => {
  runDb('org erasure deletes survivors and tombstones together', async () => {
    const partner = await createPartner({ name: 'MergeErasure-Partner' });
    const user = await createUser({ partnerId: partner.id });
    const org = await createOrganization({ partnerId: partner.id, name: 'MergeErasure-Org' });
    const control = await createOrganization({ partnerId: partner.id, name: 'MergeErasure-Control' });

    // Insert the survivor LAST so a physical-order delete would reach the
    // tombstones after it; the statement-level check must not care.
    const tombA = await insertTicket(org.id, partner.id);
    const tombB = await insertTicket(org.id, partner.id);
    const survivor = await insertTicket(org.id, partner.id);
    await getTestDb().execute(sql`
      UPDATE tickets SET merged_into_ticket_id = ${survivor}::uuid, merged_at = now()
       WHERE id IN (${tombA}::uuid, ${tombB}::uuid)
    `);
    await getTestDb().execute(sql`
      INSERT INTO ticket_comments (ticket_id, user_id, author_type, comment_type, content, is_public, merged_from_ticket_id)
      VALUES (${survivor}::uuid, ${user.id}::uuid, 'internal', 'internal', 'moved', false, ${tombA}::uuid)
    `);
    const controlSurvivor = await insertTicket(control.id, partner.id);
    const controlTomb = await insertTicket(control.id, partner.id);
    await getTestDb().execute(sql`
      UPDATE tickets SET merged_into_ticket_id = ${controlSurvivor}::uuid, merged_at = now() WHERE id = ${controlTomb}::uuid
    `);

    await cascadeDeleteOrg(org.id, user.id);

    const left = (await getTestDb().execute(sql`
      SELECT count(*)::int AS n FROM tickets WHERE org_id = ${org.id}::uuid
    `)) as unknown as Array<{ n: number }>;
    expect(left[0]!.n).toBe(0);
    const kept = (await getTestDb().execute(sql`
      SELECT count(*)::int AS n FROM tickets WHERE org_id = ${control.id}::uuid
    `)) as unknown as Array<{ n: number }>;
    expect(kept[0]!.n).toBe(2);
  }, 120_000);
});
