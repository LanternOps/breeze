/**
 * AI model registry W09 (#7607): failover + escalation against real Postgres.
 * Schema cases (Task 2) and resolution cases (Task 5).
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeRegistryFixtures, fixtureSql, seedOffering } from './aiModelRegistryFixtures';
import { resolveModel } from '../../services/aiModels/resolveModel';
import { seedFailoverPartner, setPartnerFallbacks, type SeededFailoverPartner } from './helpers/aiModelFailoverSeed';
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

describe.runIf(RUN)('W09 resolution walk against real rows', () => {
  let f: SeededFailoverPartner;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  beforeEach(async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-w09-integration-placeholder';
    f = await seedFailoverPartner();
  });
  afterAll(() => { if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey; });

  it('walks to the next eligible fallback when the default is disabled', async () => {
    await setPartnerFallbacks(f, 'script_reviewer', [f.platformOffering2Id], false);
    await fixtureSql`UPDATE partner_ai_models SET enabled = false WHERE id = ${f.platformOfferingId}`;
    const r = await resolveModel({ partnerId: f.partnerId, orgId: f.orgId, surface: 'script_reviewer' });
    expect(r).toMatchObject({ ok: true, offering: { id: f.platformOffering2Id }, funding: 'platform',
      failover: { fromOfferingId: f.platformOfferingId, hop: 1, cause: 'ineligible' } });
  });

  it('a fallback whose connection went into error is skipped', async () => {
    await setPartnerFallbacks(f, 'script_reviewer', [f.byokOfferingId], true);
    await fixtureSql`UPDATE partner_ai_connections SET status = 'error' WHERE id = ${f.byokConnectionId}`;
    const r = await resolveModel({
      partnerId: f.partnerId, orgId: f.orgId, surface: 'script_reviewer',
      excludeOfferingIds: [f.platformOfferingId], failoverCause: 'overloaded',
    });
    expect(r).toMatchObject({ ok: false });
  });

  it('cross-funding: off -> unavailable; partner on -> served; an org override OFF beats partner ON', async () => {
    await setPartnerFallbacks(f, 'script_reviewer', [f.byokOfferingId], false);
    const ask = () => resolveModel({
      partnerId: f.partnerId, orgId: f.orgId, surface: 'script_reviewer',
      excludeOfferingIds: [f.platformOfferingId], failoverCause: 'overloaded',
    });
    expect(await ask()).toMatchObject({ ok: false });
    await setPartnerFallbacks(f, 'script_reviewer', [f.byokOfferingId], true);
    expect(await ask()).toMatchObject({ ok: true, offering: { id: f.byokOfferingId }, funding: 'partner_key',
      failover: { fromOfferingId: f.platformOfferingId, hop: 1, cause: 'overloaded' } });
    await fixtureSql`
      INSERT INTO ai_model_assignments (org_id, offering_partner_id, surface, role, fallback_may_cross_funding)
      VALUES (${f.orgId}, ${f.partnerId}, 'script_reviewer', 'default', false)`;
    expect(await ask()).toMatchObject({ ok: false });
  });

  it('a triage run resolves the partner triage default under an org ai_agents default override (D2)', async () => {
    await fixtureSql`
      INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface, role, default_offering_id, allow_user_choice)
      VALUES (${f.partnerId}, ${f.partnerId}, 'ai_agents', 'triage', ${f.platformOffering2Id}, true)`;
    await fixtureSql`
      INSERT INTO ai_model_assignments (org_id, offering_partner_id, surface, role, default_offering_id)
      VALUES (${f.orgId}, ${f.partnerId}, 'ai_agents', 'default', ${f.platformOfferingId})`;
    const triage = await resolveModel({ partnerId: f.partnerId, orgId: f.orgId, surface: 'ai_agents', role: 'triage' });
    const deflt = await resolveModel({ partnerId: f.partnerId, orgId: f.orgId, surface: 'ai_agents' });
    expect(triage).toMatchObject({ ok: true, role: 'triage', offering: { id: f.platformOffering2Id } });
    expect(deflt).toMatchObject({ ok: true, role: 'default', offering: { id: f.platformOfferingId } });
  });

  it('the served hop is bound at ITS OWN rate, never the primary\'s', async () => {
    await setPartnerFallbacks(f, 'script_reviewer', [f.platformOffering2Id], false);
    const r = await resolveModel({
      partnerId: f.partnerId, orgId: f.orgId, surface: 'script_reviewer',
      excludeOfferingIds: [f.platformOfferingId], failoverCause: 'overloaded',
    });
    expect(r).toMatchObject({ ok: true, offering: { id: f.platformOffering2Id },
      rateSnapshot: { standard: { inputCentsPerM: 400, outputCentsPerM: 2000 } } });
  });
});
