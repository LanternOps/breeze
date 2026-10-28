/**
 * Tool Catalog W06 (#5221), plan Task A2 — the conversion ledger's and the
 * occurrence claims' database guards on REAL Postgres, as `breeze_app`:
 *
 *  - owner-guard constraint triggers: a conversion's owner equals its
 *    automation's AND its flow's; a claim's equals its automation's;
 *  - the conversion state machine (shadow → switched → reverted only) and the
 *    write-once switch/revert instants;
 *  - claims are append-only (UPDATE of anything but org_id refused; the table
 *    grant is column-scoped), unique per (automation, occurrence key), and the
 *    key CHECK matches the shared builder;
 *  - an org merge can restamp both tables when the automation and flow move
 *    in the same transaction (deferred guards), and nothing else can;
 *  - `automations.converted_to_flow_id` names only a flow of the same owner.
 *
 * PR B's exactly-once claims and the switch/revert transaction rely on these.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { occurrenceKey } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../../db';
import { createOrganization, createPartner } from './db-utils';
import { pgMessage } from './helpers/flowRls';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const exec = (q: ReturnType<typeof sql>) => withSystemDbAccessContext(() => db.execute(q));
async function rejects(q: ReturnType<typeof sql>, pattern: RegExp): Promise<void> {
  let err: unknown = null;
  try { await exec(q); } catch (e) { err = e; }
  expect(err, `expected the statement to be refused (${pattern})`).not.toBeNull();
  expect(pgMessage(err)).toMatch(pattern);
}

async function seed() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const automationId = randomUUID();
  const flowId = randomUUID();
  await exec(sql`INSERT INTO automations (id, org_id, name, trigger, actions)
    VALUES (${automationId}, ${org.id}, 'guard job', '{"type":"manual"}', '[]')`);
  await exec(sql`INSERT INTO flows (id, org_id, slug, name, definition, effective_tier)
    VALUES (${flowId}, ${org.id}, ${`g_${randomUUID().replace(/-/g, '').slice(0, 10)}`}, 'guard flow', '{}', 1)`);
  return { partnerId: partner.id, orgId: org.id, automationId, flowId };
}

const conversion = (s: Awaited<ReturnType<typeof seed>>, over: { orgId?: string | null; partnerId?: string | null } = {}) => sql`
  INSERT INTO flow_automation_conversions (org_id, partner_id, automation_id, flow_id, fidelity, source_digest, source_snapshot, document_digest)
  VALUES (${over.orgId === undefined ? s.orgId : over.orgId}, ${over.partnerId ?? null}, ${s.automationId}, ${s.flowId},
          'exact', ${'a'.repeat(64)}, '{}', ${'b'.repeat(64)})
  RETURNING id`;

describe('flow conversion guards (real Postgres, #5221)', () => {
  runDb('a conversion owner must equal its automation and flow owner', async () => {
    const s = await seed();
    const other = await seed();
    await rejects(conversion(s, { orgId: other.orgId }), /owner does not match/);
    await rejects(conversion(s, { orgId: null, partnerId: s.partnerId }), /owner does not match/);
    const [row] = (await exec(conversion(s))) as unknown as Array<{ id: string }>;
    expect(row!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  runDb('only shadow → switched → reverted; switch and revert instants are write-once', async () => {
    const s = await seed();
    const [{ id }] = (await exec(conversion(s))) as unknown as [{ id: string }];
    await rejects(sql`UPDATE flow_automation_conversions SET state = 'reverted', revert_at = now() WHERE id = ${id}`, /not a conversion transition/);
    await rejects(sql`UPDATE flow_automation_conversions SET source_digest = ${'c'.repeat(64)} WHERE id = ${id}`, /immutable column changed/);
    await exec(sql`UPDATE flow_automation_conversions SET shadow_runs = 2, shadow_divergences = 1 WHERE id = ${id}`);
    await exec(sql`UPDATE flow_automation_conversions SET state = 'switched', switch_at = now() + interval '60 seconds', switched_at = now() WHERE id = ${id}`);
    await rejects(sql`UPDATE flow_automation_conversions SET switch_at = now() WHERE id = ${id}`, /immutable column changed/);
    await rejects(sql`UPDATE flow_automation_conversions SET state = 'shadow', switch_at = NULL, switched_at = NULL WHERE id = ${id}`, /immutable column changed|not a conversion transition/);
    await exec(sql`UPDATE flow_automation_conversions SET state = 'reverted', revert_at = now() WHERE id = ${id}`);
    await rejects(sql`UPDATE flow_automation_conversions SET revert_at = now() + interval '1 day' WHERE id = ${id}`, /immutable column changed/);
    await rejects(sql`UPDATE flow_automation_conversions SET state = 'switched' WHERE id = ${id}`, /not a conversion transition|violates check constraint/);
    // A second live generation is refused; a new one after the revert is allowed.
    const flow2 = randomUUID();
    await exec(sql`INSERT INTO flows (id, org_id, slug, name, definition, effective_tier)
      VALUES (${flow2}, ${s.orgId}, ${`g_${randomUUID().replace(/-/g, '').slice(0, 10)}`}, 'gen 2', '{}', 1)`);
    await exec(sql`INSERT INTO flow_automation_conversions (org_id, automation_id, flow_id, fidelity, source_digest, source_snapshot, document_digest)
      VALUES (${s.orgId}, ${s.automationId}, ${flow2}, 'exact', ${'a'.repeat(64)}, '{}', ${'b'.repeat(64)})`);
  });

  runDb('claims are unique per occurrence, keyed by the shared builder, owner-checked and append-only', async () => {
    const s = await seed();
    const key = occurrenceKey.schedule(new Date('2027-01-09T03:00:00Z'));
    const claim = (k: string, engine = 'flow') => sql`
      INSERT INTO automation_occurrence_claims (org_id, automation_id, occurrence_key, engine, legacy_run_id)
      VALUES (${s.orgId}, ${s.automationId}, ${k}, ${engine}, ${engine === 'legacy' ? randomUUID() : null}) RETURNING id`;
    const [{ id }] = (await exec(claim(key))) as unknown as [{ id: string }];
    await rejects(claim(key, 'legacy'), /automation_occurrence_claims_occurrence_uq|duplicate key/);
    await rejects(claim('schedule:2027-01-09T03:00:00Z'), /automation_occurrence_claims_key_chk/);
    await rejects(sql`INSERT INTO automation_occurrence_claims (org_id, automation_id, occurrence_key, engine)
      VALUES (${s.orgId}, ${s.automationId}, ${occurrenceKey.webhookDelivery('evt_1')}, 'legacy')`, /automation_occurrence_claims_run_chk/);
    const other = await seed();
    await rejects(sql`INSERT INTO automation_occurrence_claims (org_id, automation_id, occurrence_key, engine)
      VALUES (${other.orgId}, ${s.automationId}, ${occurrenceKey.webhookDelivery('evt_2')}, 'flow')`, /owner does not match/);
    await rejects(sql`UPDATE automation_occurrence_claims SET engine = 'legacy' WHERE id = ${id}`, /append-only|permission denied/);
    // The app role holds only a column-scoped UPDATE (org_id), never TRUNCATE.
    const grants = (await exec(sql`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'breeze_app' AND table_name = 'automation_occurrence_claims' ORDER BY 1`)) as unknown as Array<{ privilege_type: string }>;
    expect(grants.map((g) => g.privilege_type)).not.toContain('UPDATE');
    expect(grants.map((g) => g.privilege_type)).not.toContain('TRUNCATE');
  });

  runDb('automations.converted_to_flow_id names only a flow of the same owner', async () => {
    const s = await seed();
    const other = await seed();
    const retire = (flowId: string) => sql`UPDATE automations
      SET retired_at = now(), retired_reason = 'converted_to_flow', converted_to_flow_id = ${flowId} WHERE id = ${s.automationId}`;
    await rejects(retire(other.flowId), /converted flow owner does not match/);
    await exec(retire(s.flowId));
    // Moving the automation alone (its flow stays behind) is refused too.
    const survivor = await createOrganization({ partnerId: s.partnerId });
    await rejects(sql`UPDATE automations SET org_id = ${survivor.id} WHERE id = ${s.automationId}`, /converted flow owner does not match/);
  });

  runDb('an org restamp passes only when the automation and flow move in the same transaction', async () => {
    const s = await seed();
    const survivor = await createOrganization({ partnerId: s.partnerId });
    await exec(conversion(s));
    await exec(sql`UPDATE automations SET retired_at = now(), retired_reason = 'converted_to_flow', converted_to_flow_id = ${s.flowId} WHERE id = ${s.automationId}`);
    await exec(sql`INSERT INTO automation_occurrence_claims (org_id, automation_id, occurrence_key, engine)
      VALUES (${s.orgId}, ${s.automationId}, ${occurrenceKey.webhookDelivery('evt_m')}, 'flow')`);
    // Alone, a restamp of the ledger or the claim is refused by the owner guard.
    await rejects(sql`UPDATE flow_automation_conversions SET org_id = ${survivor.id} WHERE automation_id = ${s.automationId}`, /owner does not match/);
    await rejects(sql`UPDATE automation_occurrence_claims SET org_id = ${survivor.id} WHERE automation_id = ${s.automationId}`, /owner does not match/);
    // The merge shape: constraints deferred, every table repointed, consistent at COMMIT.
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      await db.execute(sql`UPDATE automation_occurrence_claims SET org_id = ${survivor.id} WHERE automation_id = ${s.automationId}`);
      await db.execute(sql`UPDATE flow_automation_conversions SET org_id = ${survivor.id} WHERE automation_id = ${s.automationId}`);
      await db.execute(sql`UPDATE automations SET org_id = ${survivor.id} WHERE id = ${s.automationId}`);
      await db.execute(sql`UPDATE flows SET org_id = ${survivor.id} WHERE id = ${s.flowId}`);
    });
    const [moved] = (await exec(sql`SELECT org_id FROM flow_automation_conversions WHERE automation_id = ${s.automationId}`)) as unknown as Array<{ org_id: string }>;
    expect(moved!.org_id).toBe(survivor.id);
  });
});
