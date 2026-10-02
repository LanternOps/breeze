/** W10 (#7608): a short ledger retention never deletes chargeable usage before its close. */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { createOrganization, createPartner } from './db-utils';
import { closeRegistryFixtures, fixtureSql } from './aiModelRegistryFixtures';
import { seedAiCard, seedChargeableInvocation } from './aiChargebackFixtures';
import { CHARGEBACK_RETENTION_FLOOR_DAYS, pruneAiInvocations } from '../../jobs/aiInvocationRetention';
import { withSystemDbAccessContext } from '../../db';
import { runOrgChargePeriod } from '../../services/aiChargeback/chargeRun';
import { lookbackStartIso, monthPeriod } from '../../services/aiChargeback/chargePeriods';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

const DAY = 86_400_000;
const daysAgo = (n: number, from = Date.now()) => new Date(from - n * DAY).toISOString();

async function seedPlain(orgId: string, createdAt: string): Promise<string> {
  const [row] = await fixtureSql`INSERT INTO ai_invocations (org_id, surface, funding_source, requested_model, served_model,
    ledger_mode, rate_snapshot, cost_cents, created_at)
    VALUES (${orgId}, 'chat', 'platform', 'w10-test-m', 'w10-test-m', 'authoritative', '{}'::jsonb, 1, ${createdAt}::timestamptz)
    RETURNING id`;
  return String(row!.id);
}

describe.runIf(RUN)('ai_invocations retention vs chargeback (#7608)', () => {
  it('a 7-day window prunes old non-chargeable rows but keeps chargeable rows inside the chargeback floor', async () => {
    const p = await createPartner(); const o = await createOrganization({ partnerId: p.id });
    const card = await seedAiCard(p.id);
    const chargeable = await seedChargeableInvocation({ orgId: o.id, cardId: card, createdAt: daysAgo(30) });
    const plain = await seedPlain(o.id, daysAgo(30));
    const fresh = await seedPlain(o.id, daysAgo(1));
    await pruneAiInvocations({ retentionDays: 7 });
    const left = await fixtureSql`SELECT id FROM ai_invocations WHERE id IN (${chargeable}, ${plain}, ${fresh}) ORDER BY created_at`;
    expect(left.map((r) => String(r.id))).toEqual([chargeable, fresh]);
  });

  it('brackets the floor exactly: a chargeable row a day inside it is kept, a day past it is pruned', async () => {
    const p = await createPartner(); const o = await createOrganization({ partnerId: p.id });
    const card = await seedAiCard(p.id);
    const now = Date.now();
    const inside = await seedChargeableInvocation({ orgId: o.id, cardId: card, createdAt: daysAgo(CHARGEBACK_RETENTION_FLOOR_DAYS - 1, now) });
    const past = await seedChargeableInvocation({ orgId: o.id, cardId: card, createdAt: daysAgo(CHARGEBACK_RETENTION_FLOOR_DAYS + 1, now) });
    await pruneAiInvocations({ retentionDays: 7, now: new Date(now) });
    const left = await fixtureSql`SELECT id FROM ai_invocations WHERE id IN (${inside}, ${past})`;
    expect(left.map((r) => String(r.id))).toEqual([inside]);
  });

  it('keeps the oldest row the next on-time close counts as newly expired, so the expired count is real', async () => {
    const p = await createPartner(); const o = await createOrganization({ partnerId: p.id });
    const card = await seedAiCard(p.id);
    // The sweep closes November at 05:28 on 1 December. That close counts the
    // rows that aged out of October's lookback: [lookbackStart(Oct), lookbackStart(Nov)).
    const closeAt = new Date('2026-12-01T05:28:00Z');
    const oldestCounted = new Date(new Date(lookbackStartIso(monthPeriod('2026-10-01'))).getTime() + 60_000).toISOString();
    const id = await seedChargeableInvocation({ orgId: o.id, cardId: card, createdAt: oldestCounted });
    // A retention run just before the close, with a far shorter window.
    await pruneAiInvocations({ retentionDays: 7, now: new Date(closeAt.getTime() - 60 * 60_000) });
    expect(await fixtureSql`SELECT 1 FROM ai_invocations WHERE id = ${id}`).toHaveLength(1);
    expect(await withSystemDbAccessContext(() => runOrgChargePeriod({ orgId: o.id, periodStart: '2026-11-01', now: closeAt })))
      .toMatchObject({ kind: 'charged', invocationCount: 0, expiredInvocationCount: 1 });
  });

  it('a claimed chargeable row inside the floor is kept too (the floor is by age, not claim state)', async () => {
    const p = await createPartner(); const o = await createOrganization({ partnerId: p.id });
    const card = await seedAiCard(p.id);
    const createdAt = daysAgo(100);
    const id = await seedChargeableInvocation({ orgId: o.id, cardId: card, createdAt });
    const periodStart = `${createdAt.slice(0, 7)}-01`;
    expect(await withSystemDbAccessContext(() => runOrgChargePeriod({ orgId: o.id, periodStart })))
      .toMatchObject({ kind: 'charged', invocationCount: 1 });
    expect(await fixtureSql`SELECT 1 FROM ai_usage_charge_claims WHERE invocation_id = ${id}`).toHaveLength(1);
    await pruneAiInvocations({ retentionDays: 7 });
    expect(await fixtureSql`SELECT 1 FROM ai_invocations WHERE id = ${id}`).toHaveLength(1);
  });

  it('beyond the floor, chargeable rows follow the configured window again', async () => {
    const p = await createPartner(); const o = await createOrganization({ partnerId: p.id });
    const card = await seedAiCard(p.id);
    const id = await seedChargeableInvocation({ orgId: o.id, cardId: card, createdAt: daysAgo(200) });
    const plain = await seedPlain(o.id, daysAgo(200));
    await pruneAiInvocations({ retentionDays: 7 });
    expect(await fixtureSql`SELECT 1 FROM ai_invocations WHERE id IN (${id}, ${plain})`).toHaveLength(0);
  });

  it('a window longer than the floor governs chargeable rows unchanged', async () => {
    const p = await createPartner(); const o = await createOrganization({ partnerId: p.id });
    const card = await seedAiCard(p.id);
    const young = await seedChargeableInvocation({ orgId: o.id, cardId: card, createdAt: daysAgo(200) });
    const old = await seedChargeableInvocation({ orgId: o.id, cardId: card, createdAt: daysAgo(500) });
    await pruneAiInvocations({ retentionDays: 400 });
    const left = await fixtureSql`SELECT id FROM ai_invocations WHERE id IN (${young}, ${old})`;
    expect(left.map((r) => String(r.id))).toEqual([young]);
  });
});
