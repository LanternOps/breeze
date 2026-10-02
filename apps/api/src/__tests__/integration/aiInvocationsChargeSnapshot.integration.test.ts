/** W10 (#7608) Task 5: the ledger's charge snapshot is shaped by SQL, not only by TS. */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { createOrganization, createPartner } from './db-utils';
import { closeRegistryFixtures, fixtureSql } from './aiModelRegistryFixtures';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

async function org(): Promise<string> {
  const p = await createPartner();
  return (await createOrganization({ partnerId: p.id })).id;
}
type Charge = { chargeable: boolean; ledger: string; profile: string | null; coverage: string | null;
  basis: string | null; currency: string | null; amount: string | null };
async function insert(orgId: string, c: Charge) {
  return fixtureSql`
    INSERT INTO ai_invocations (org_id, surface, funding_source, requested_model, served_model, ledger_mode,
      rate_snapshot, cost_cents, chargeable, charge_billing_profile_id, charge_coverage, charge_basis, charge_currency, charge_amount)
    VALUES (${orgId}, 'chat', 'platform', 'w10-test-m', 'w10-test-m', ${c.ledger}, '{}'::jsonb, 1, ${c.chargeable},
      ${c.profile}, ${c.coverage}, ${c.basis}, ${c.currency}, ${c.amount}) RETURNING id`;
}
const card = '11111111-1111-4111-8111-111111111111';
const ok: Charge = { chargeable: true, ledger: 'authoritative', profile: card, coverage: 'billable', basis: 'markup', currency: 'USD', amount: '1.000000' };

describe.runIf(RUN)('ai_invocations_charge_chk (#7608)', () => {
  it.each<[string, Charge]>([
    ['a priced markup row', ok],
    ['an unpriced chargeable row', { ...ok, basis: 'unpriced', amount: null }],
    ['an included (non-chargeable) row', { ...ok, chargeable: false, coverage: 'included', basis: null, currency: null, amount: null }],
    ['a no-card row', { ...ok, chargeable: false, profile: null, coverage: null, basis: null, currency: null, amount: null }],
    ['a legacy default row', { chargeable: false, ledger: 'shadow', profile: null, coverage: null, basis: null, currency: null, amount: null }],
  ])('accepts %s', async (_l, c) => {
    await expect(insert(await org(), c)).resolves.toHaveLength(1);
  });

  it.each<[string, Charge]>([
    ['a chargeable shadow row', { ...ok, ledger: 'shadow' }],
    ['chargeable without a currency', { ...ok, currency: null }],
    ['chargeable without a card', { ...ok, profile: null }],
    ['chargeable on a non-billable coverage', { ...ok, coverage: 'included' }],
    ['unpriced with an amount', { ...ok, basis: 'unpriced' }],
    ['priced without an amount', { ...ok, amount: null }],
    ['a negative amount', { ...ok, amount: '-0.000001' }],
    ['an amount on a non-chargeable row', { ...ok, chargeable: false, coverage: 'included', basis: null, currency: null }],
    ['an unknown basis', { ...ok, basis: 'flat' }],
    ['an unknown coverage', { ...ok, chargeable: false, coverage: 'free', basis: null, currency: null, amount: null }],
    ['chargeable with a NULL coverage (CHECK must not accept NULL)', { ...ok, coverage: null }],
  ])('rejects %s (23514)', async (_l, c) => {
    await expect(insert(await org(), c)).rejects.toMatchObject({ code: '23514' });
  });

  it('the stamp is immutable: the append-only trigger refuses a charge_* update', async () => {
    const orgId = await org();
    const [row] = await insert(orgId, ok);
    // 55000 = the append-only trigger (not a missing column or a CHECK).
    await expect(fixtureSql`UPDATE ai_invocations SET charge_amount = 2 WHERE id = ${row!.id}`)
      .rejects.toMatchObject({ code: '55000' });
  });
});
