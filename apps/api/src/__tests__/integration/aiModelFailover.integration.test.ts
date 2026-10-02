/**
 * AI model registry W09 (#7607): failover + escalation against real Postgres.
 * Schema cases (Task 2) and resolution cases (Task 5).
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeRegistryFixtures, fixtureSql, seedOffering } from './aiModelRegistryFixtures';
import { seedPricedPlatformModel, seedRegistryPartner, type SeededRegistryPartner } from './helpers/aiModelRegistrySeed';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

async function sqlState(p: Promise<unknown>): Promise<string | null> {
  try { await p; return null; } catch (e) { return (e as { code?: string }).code ?? 'unknown'; }
}

function ledgerInsert(s: SeededRegistryPartner, over: { hop: number; cause: string | null; from: string | null }) {
  return fixtureSql`
    INSERT INTO ai_invocations (org_id, surface, role, offering_id, funding_source, requested_model, served_model,
                                ledger_mode, failover_from_offering_id, failover_hop, failover_cause)
    VALUES (${s.orgId}, 'chat', 'default', ${s.offeringId}, 'platform', ${s.modelId}, ${s.modelId},
            'authoritative', ${over.from}, ${over.hop}, ${over.cause})`;
}

describe.runIf(RUN)('W09 schema: failover provenance', () => {
  let s: SeededRegistryPartner;
  let other: SeededRegistryPartner;
  beforeEach(async () => {
    s = await seedRegistryPartner('platform');
    other = await seedRegistryPartner('platform');
  });

  it('accepts a hop row whose source is an offering of the same partner', async () => {
    const from = await seedOffering({ partnerId: s.partnerId, platformModelId: await seedPricedPlatformModel(), enabled: true });
    expect(await sqlState(ledgerInsert(s, { hop: 1, cause: 'overloaded', from }))).toBeNull();
  });

  it('rejects a failover source owned by another partner (23503)', async () => {
    expect(await sqlState(ledgerInsert(s, { hop: 1, cause: 'overloaded', from: other.offeringId }))).toBe('23503');
  });

  it('rejects a failover source that names no offering at all (23503)', async () => {
    expect(await sqlState(ledgerInsert(s, { hop: 1, cause: 'overloaded', from: randomUUID() }))).toBe('23503');
  });

  it.each([
    ['hop 0 with a cause', { hop: 0, cause: 'overloaded', from: null }],
    ['hop 1 without a cause', { hop: 1, cause: null, from: null }],
    ['an unknown cause', { hop: 1, cause: 'flaky', from: null }],
    ['hop 7', { hop: 7, cause: 'overloaded', from: null }],
  ] as const)('rejects %s (23514)', async (_l, over) => {
    expect(await sqlState(ledgerInsert(s, over))).toBe('23514');
  });

  it('rejects hop 0 that names a source (23514)', async () => {
    expect(await sqlState(ledgerInsert(s, { hop: 0, cause: null, from: s.offeringId }))).toBe('23514');
  });

  it('accepts hop > 0 with no source (the stored choice no longer exists)', async () => {
    expect(await sqlState(ledgerInsert(s, { hop: 1, cause: 'ineligible', from: null }))).toBeNull();
  });

  it('an assignment cannot list its own default as a fallback, nor more than five (23514)', async () => {
    const extra = await Promise.all(Array.from({ length: 6 }, async () =>
      seedOffering({ partnerId: s.partnerId, platformModelId: await seedPricedPlatformModel(), enabled: true })));
    expect(await sqlState(fixtureSql`
      UPDATE ai_model_assignments SET fallback_offering_ids = ARRAY[${s.offeringId}]::uuid[]
       WHERE partner_id = ${s.partnerId} AND surface = 'chat'`)).toBe('23514');
    expect(await sqlState(fixtureSql`
      UPDATE ai_model_assignments SET fallback_offering_ids = ${extra}::uuid[]
       WHERE partner_id = ${s.partnerId} AND surface = 'chat'`)).toBe('23514');
    expect(await sqlState(fixtureSql`
      UPDATE ai_model_assignments SET fallback_offering_ids = ${extra.slice(0, 5)}::uuid[]
       WHERE partner_id = ${s.partnerId} AND surface = 'chat'`)).toBeNull();
  });

  it('an agent run records the served offering, funding, hop and cause together or not at all (23514)', async () => {
    const [agent] = await fixtureSql`
      INSERT INTO ai_agents (org_id, kind, name, created_by) VALUES (${s.orgId}, 'triage', 'w09', ${s.userId}) RETURNING id`;
    const insertRun = (served: { id: string | null; funding: string | null; hop: number | null; cause?: string | null }) => fixtureSql`
      INSERT INTO ai_agent_runs (agent_id, org_id, trigger_kind, dedupe_key, mode_at_start, policy_snapshot,
                                 served_offering_id, served_funding_source, served_failover_hop, served_failover_cause)
      VALUES (${agent!.id}, ${s.orgId}, 'manual', ${`w09-${randomUUID()}`}, 'shadow', '{}'::jsonb,
              ${served.id}, ${served.funding}, ${served.hop},
              ${served.cause !== undefined ? served.cause : served.hop ? 'overloaded' : null})`;
    expect(await sqlState(insertRun({ id: null, funding: null, hop: null }))).toBeNull();
    expect(await sqlState(insertRun({ id: s.offeringId, funding: 'platform', hop: 1 }))).toBeNull();
    expect(await sqlState(insertRun({ id: s.offeringId, funding: null, hop: 1 }))).toBe('23514');
    expect(await sqlState(insertRun({ id: s.offeringId, funding: 'platform', hop: 0 }))).toBe('23514');
    expect(await sqlState(insertRun({ id: s.offeringId, funding: 'platform', hop: 1, cause: null }))).toBe('23514');
    expect(await sqlState(insertRun({ id: s.offeringId, funding: 'platform', hop: 1, cause: 'flaky' }))).toBe('23514');
  });
});
