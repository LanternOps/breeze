/** W10 (#7608) Task 7: charge tables are shape-1 org-isolated, composite-FK pinned, merge-safe. */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { createOrganization, createPartner, createUser } from './db-utils';
import { closeRegistryFixtures, fixtureSql, orgContext, partnerContext } from './aiModelRegistryFixtures';
import { seedAiCard, seedChargeableInvocation } from './aiChargebackFixtures';
import { getOrgMergePolicies } from '../../services/orgMergeRegistry';
import { ORG_CASCADE_DELETE_ORDER } from '../../services/tenantCascade';
import { executeOrgMerge } from '../../services/orgMerge';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

async function seedCharge(orgId: string, partnerId: string, status = 'not_billed', runId: string = randomUUID()): Promise<string> {
  const [row] = await fixtureSql`
    INSERT INTO ai_usage_charges (org_id, partner_id, run_id, period_start, period_end, usage_period_start,
      currency_code, served_model, model_label, priced, invocation_count, amount_exact, amount, billing_status)
    VALUES (${orgId}, ${partnerId}, ${runId}, '2026-11-01', '2026-12-01', '2026-11-01', 'USD',
      'w10-test-model', 'W10 Test', true, 1, 1.5, 1.50, ${status}) RETURNING id`;
  return String(row!.id);
}

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? (result as T[]));
}

describe.runIf(RUN)('ai_usage_charges / runs / claims tenancy (#7608)', () => {
  it('an org token cannot read another org\'s charges', async () => {
    const p = await createPartner();
    const a = await createOrganization({ partnerId: p.id });
    const b = await createOrganization({ partnerId: p.id });
    await seedCharge(a.id, p.id);
    const seen = await withDbAccessContext(orgContext(b.id, p.id), () =>
      db.execute(sql`SELECT id FROM ai_usage_charges WHERE org_id = ${a.id}`));
    expect((seen as unknown as unknown[]).length).toBe(0);
    // Control: the owning org does see it (the read above is not vacuously empty).
    const own = await withDbAccessContext(orgContext(a.id, p.id), () =>
      db.execute(sql`SELECT id FROM ai_usage_charges WHERE org_id = ${a.id}`));
    expect((own as unknown as unknown[]).length).toBe(1);
  });

  it('an org token cannot mark another org\'s charge billed (0 rows); the owning org can (control)', async () => {
    const p = await createPartner();
    const a = await createOrganization({ partnerId: p.id });
    const b = await createOrganization({ partnerId: p.id });
    const aCharge = await seedCharge(a.id, p.id);
    const flip = (orgId: string) => withDbAccessContext(orgContext(orgId, p.id), async () => rowsOf<{ id: string }>(await db.execute(sql`
      UPDATE ai_usage_charges SET billing_status = 'billed' WHERE id = ${aCharge} RETURNING id`)));
    expect(await flip(b.id)).toEqual([]);
    const [still] = await fixtureSql`SELECT billing_status FROM ai_usage_charges WHERE id = ${aCharge}`;
    expect(still!.billing_status).toBe('not_billed');
    expect((await flip(a.id)).map((r) => String(r.id))).toEqual([aCharge]);
    const [flipped] = await fixtureSql`SELECT billing_status FROM ai_usage_charges WHERE id = ${aCharge}`;
    expect(flipped!.billing_status).toBe('billed');
  });

  it('an org token cannot read another org\'s runs or claims; the owning org can (control)', async () => {
    const p = await createPartner();
    const a = await createOrganization({ partnerId: p.id });
    const b = await createOrganization({ partnerId: p.id });
    const [run] = await fixtureSql`INSERT INTO ai_usage_charge_runs (org_id, partner_id, period_start, period_end)
      VALUES (${a.id}, ${p.id}, '2026-11-01', '2026-12-01') RETURNING id`;
    const charge = await seedCharge(a.id, p.id, 'not_billed', String(run!.id));
    await fixtureSql`INSERT INTO ai_usage_charge_claims (invocation_id, org_id, run_id, charge_id)
      VALUES (${randomUUID()}, ${a.id}, ${run!.id}, ${charge})`;
    const seen = (orgId: string) => withDbAccessContext(orgContext(orgId, p.id), async () => ({
      runs: rowsOf(await db.execute(sql`SELECT id FROM ai_usage_charge_runs WHERE org_id = ${a.id}`)).length,
      claims: rowsOf(await db.execute(sql`SELECT invocation_id FROM ai_usage_charge_claims WHERE org_id = ${a.id}`)).length,
    }));
    expect(await seen(b.id)).toEqual({ runs: 0, claims: 0 });
    expect(await seen(a.id)).toEqual({ runs: 1, claims: 1 });
  });

  it('a partner context cannot forge a charge for an org it cannot access (42501)', async () => {
    const p = await createPartner(); const other = await createPartner();
    const victim = await createOrganization({ partnerId: other.id });
    await expect(withDbAccessContext(partnerContext(p.id, []), () => db.execute(sql`
      INSERT INTO ai_usage_charges (org_id, partner_id, run_id, period_start, period_end, usage_period_start,
        currency_code, served_model, model_label, priced, invocation_count, billing_status)
      VALUES (${victim.id}, ${other.id}, ${randomUUID()}, '2026-11-01', '2026-12-01', '2026-11-01', 'USD',
        'w10-test-model', 'x', false, 1, 'unpriced')`))).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('(org_id, partner_id) must match the org\'s partner (composite FK 23503)', async () => {
    const p = await createPartner(); const other = await createPartner();
    const o = await createOrganization({ partnerId: p.id });
    await expect(seedCharge(o.id, other.id)).rejects.toMatchObject({ code: '23503' });
  });

  it.each([
    ['priced without an amount', `priced = true, amount = NULL, amount_exact = NULL`],
    ['unpriced status on a priced charge', `billing_status = 'unpriced'`],
    ['an unknown status', `billing_status = 'paid'`],
    ['usage after the billing period', `usage_period_start = '2026-12-01'`],
    ['a period that is not a calendar month', `period_end = '2026-11-30'`],
  ])('rejects %s (23514)', async (_label, set) => {
    const p = await createPartner(); const o = await createOrganization({ partnerId: p.id });
    const id = await seedCharge(o.id, p.id);
    await expect(fixtureSql.unsafe(`UPDATE ai_usage_charges SET ${set} WHERE id = '${id}'`))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('one run per org per month (23505)', async () => {
    const p = await createPartner(); const o = await createOrganization({ partnerId: p.id });
    const insert = () => fixtureSql`INSERT INTO ai_usage_charge_runs (org_id, partner_id, period_start, period_end)
      VALUES (${o.id}, ${p.id}, '2026-11-01', '2026-12-01')`;
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: '23505' });
  });

  it('an invocation is claimed at most once (PK 23505)', async () => {
    const p = await createPartner(); const o = await createOrganization({ partnerId: p.id });
    const charge = await seedCharge(o.id, p.id);
    const inv = randomUUID();
    const claim = () => fixtureSql`INSERT INTO ai_usage_charge_claims (invocation_id, org_id, run_id, charge_id)
      VALUES (${inv}, ${o.id}, ${randomUUID()}, ${charge})`;
    await claim();
    await expect(claim()).rejects.toMatchObject({ code: '23505' });
  });

  it('a claim cannot point at another org\'s charge (composite FK 23503)', async () => {
    const p = await createPartner();
    const a = await createOrganization({ partnerId: p.id });
    const b = await createOrganization({ partnerId: p.id });
    const bCharge = await seedCharge(b.id, p.id);
    await expect(fixtureSql`INSERT INTO ai_usage_charge_claims (invocation_id, org_id, run_id, charge_id)
      VALUES (${randomUUID()}, ${a.id}, ${randomUUID()}, ${bCharge})`).rejects.toMatchObject({ code: '23503' });
  });

  it('breeze_app cannot rewrite a claim (write-once; only org_id is updatable)', async () => {
    const p = await createPartner(); const o = await createOrganization({ partnerId: p.id });
    const charge = await seedCharge(o.id, p.id);
    const other = await seedCharge(o.id, p.id);
    const inv = randomUUID();
    await fixtureSql`INSERT INTO ai_usage_charge_claims (invocation_id, org_id, run_id, charge_id)
      VALUES (${inv}, ${o.id}, ${randomUUID()}, ${charge})`;
    // The code-under-test pool must really be the unprivileged app role, or the
    // 42501 below would be vacuous (a superuser can UPDATE anything).
    const [who] = rowsOf<{ u: string }>(await withSystemDbAccessContext(() => db.execute(sql`SELECT current_user AS u`)));
    expect(who?.u).toBe('breeze_app');
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      UPDATE ai_usage_charge_claims SET charge_id = ${other} WHERE invocation_id = ${inv}`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      UPDATE ai_usage_charge_claims SET run_id = ${randomUUID()} WHERE invocation_id = ${inv}`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
    // The org-merge repoint statement (UPDATE … SET org_id) is still permitted.
    await withSystemDbAccessContext(() => db.execute(sql`
      UPDATE ai_usage_charge_claims SET org_id = ${o.id} WHERE invocation_id = ${inv}`));
    const [after] = await fixtureSql`SELECT charge_id FROM ai_usage_charge_claims WHERE invocation_id = ${inv}`;
    expect(String(after!.charge_id)).toBe(charge);
  });

  it('is registered for cascade (claims before charges) and merge', () => {
    const order = [...ORG_CASCADE_DELETE_ORDER];
    for (const t of ['ai_usage_charge_claims', 'ai_usage_charge_runs', 'ai_usage_charges']) expect(order).toContain(t);
    expect(order.indexOf('ai_usage_charge_claims')).toBeLessThan(order.indexOf('ai_usage_charges'));
    const policies = getOrgMergePolicies(); // a ReadonlyMap
    expect(policies.get('ai_usage_charges')).toEqual({ kind: 'repoint' });
    expect(policies.get('ai_usage_charge_claims')).toEqual({ kind: 'repoint' });
    expect(policies.get('ai_usage_charge_runs')?.kind).toBe('leave-for-erasure');
  });

  it('an org merge moves the loser\'s charges and claims to the survivor; its runs stay behind', async () => {
    const p = await createPartner();
    const survivor = await createOrganization({ partnerId: p.id });
    const loser = await createOrganization({ partnerId: p.id });
    const actor = await createUser({ partnerId: p.id });
    const card = await seedAiCard(p.id);
    // Both orgs closed November: a repoint of the loser's run would collide on
    // UNIQUE (org_id, period_start), which is why runs are leave-for-erasure.
    const [survivorRun] = await fixtureSql`INSERT INTO ai_usage_charge_runs (org_id, partner_id, period_start, period_end, completed_at)
      VALUES (${survivor.id}, ${p.id}, '2026-11-01', '2026-12-01', now()) RETURNING id`;
    const [loserRun] = await fixtureSql`INSERT INTO ai_usage_charge_runs (org_id, partner_id, period_start, period_end, completed_at)
      VALUES (${loser.id}, ${p.id}, '2026-11-01', '2026-12-01', now()) RETURNING id`;
    const inv = await seedChargeableInvocation({ orgId: loser.id, cardId: card, createdAt: '2026-11-05T00:00:00Z' });
    const charge = await seedCharge(loser.id, p.id, 'not_billed', String(loserRun!.id));
    await fixtureSql`INSERT INTO ai_usage_charge_claims (invocation_id, org_id, run_id, charge_id)
      VALUES (${inv}, ${loser.id}, ${loserRun!.id}, ${charge})`;

    await executeOrgMerge({ loserOrgId: loser.id, survivorOrgId: survivor.id, partnerId: p.id, performedBy: actor.id });

    const [c] = await fixtureSql`SELECT org_id, run_id, billing_status FROM ai_usage_charges WHERE id = ${charge}`;
    expect(c).toMatchObject({ org_id: survivor.id, run_id: loserRun!.id, billing_status: 'not_billed' });
    const [cl] = await fixtureSql`SELECT org_id, charge_id FROM ai_usage_charge_claims WHERE invocation_id = ${inv}`;
    expect(cl).toMatchObject({ org_id: survivor.id, charge_id: charge });
    const [i] = await fixtureSql`SELECT org_id FROM ai_invocations WHERE id = ${inv}`;
    expect(i!.org_id).toBe(survivor.id);
    const runs = await fixtureSql`SELECT id, org_id FROM ai_usage_charge_runs WHERE period_start = '2026-11-01' ORDER BY org_id`;
    expect(runs.map((r) => [String(r.id), String(r.org_id)]).sort()).toEqual([
      [String(loserRun!.id), loser.id],
      [String(survivorRun!.id), survivor.id],
    ].sort());
  }, 120_000);
});
