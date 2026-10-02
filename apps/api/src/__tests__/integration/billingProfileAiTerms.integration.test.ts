/** W10 (#7608) Task 3: AI terms on the card through the real service + RLS. */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { createOrganization, createPartner } from './db-utils';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import {
  cloneProfile, createProfile, getProfile, listAiModelChoices, loadCardsForOrg, saveProfile, updateProfile,
} from '../../services/billingProfileService';

const RUN = !!process.env.DATABASE_URL;
const writer = { scope: 'partner', partnerOrgAccess: 'all' } as const;
const rate = (modelId: string) => ({ modelId, inputPricePerM: '3.600000', outputPricePerM: '18.000000',
  cacheReadPricePerM: '0.360000', cacheWritePricePerM: '4.500000' });

async function fixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const ctx: DbAccessContext = { scope: 'partner', orgId: null, accessibleOrgIds: [org.id],
    accessiblePartnerIds: [partner.id], currentPartnerId: partner.id, userId: null };
  const run = <T>(fn: () => Promise<T>) => withDbAccessContext(ctx, fn);
  return { partner, org, run };
}
const base = { currencyCode: 'USD', baseCoverage: 'billable' as const, baseHourlyRate: null };

describe.runIf(RUN)('billing profile AI terms (#7608)', () => {
  it('creates a card with coverage, markup and a price list, and reads them back', async () => {
    const f = await fixture();
    const created = await f.run(() => createProfile(writer, f.partner.id, { ...base, name: `AI ${randomUUID()}`,
      aiCoverage: 'billable', aiMarkupPercent: '25.00', aiRates: [rate('w10-test-a')] }));
    const card = await f.run(() => getProfile(created.id, f.partner.id));
    expect(card).toMatchObject({ aiCoverage: 'billable', aiMarkupPercent: '25.00' });
    expect(card.aiRates.map((r) => r.modelId)).toEqual(['w10-test-a']);
  });

  it('save without aiRates keeps the price list; [] clears it; a list replaces it', async () => {
    const f = await fixture();
    const created = await f.run(() => createProfile(writer, f.partner.id, { ...base, name: `AI ${randomUUID()}`,
      aiCoverage: 'billable', aiRates: [rate('w10-test-a')] }));
    const save = (extra: object) => f.run(() => saveProfile(writer, created.id, f.partner.id,
      { ...base, name: created.name, rows: [], aiCoverage: 'billable', ...extra }));
    expect((await save({})).aiRates.map((r) => r.modelId)).toEqual(['w10-test-a']);
    expect((await save({ aiRates: [rate('w10-test-b'), rate('w10-test-c')] })).aiRates.map((r) => r.modelId))
      .toEqual(['w10-test-b', 'w10-test-c']);
    expect((await save({ aiRates: [] })).aiRates).toEqual([]);
  });

  it.each([
    ['a markup on a non-billable card', { aiCoverage: 'non_billable' as const, aiMarkupPercent: '10.00' }],
    ['a price list on an included card', { aiCoverage: 'included' as const, aiRates: [rate('w10-test-a')] }],
  ])('rejects %s with INVALID_AI_TERMS', async (_label, ai) => {
    const f = await fixture();
    await expect(f.run(() => createProfile(writer, f.partner.id, { ...base, name: `AI ${randomUUID()}`, ...ai })))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_AI_TERMS' });
  });

  it('switching coverage away from billable clears the markup and the price list', async () => {
    const f = await fixture();
    const created = await f.run(() => createProfile(writer, f.partner.id, { ...base, name: `AI ${randomUUID()}`,
      aiCoverage: 'billable', aiMarkupPercent: '15.00', aiRates: [rate('w10-test-a')] }));
    await f.run(() => updateProfile(writer, created.id, f.partner.id, { aiCoverage: 'included' }));
    const card = await f.run(() => getProfile(created.id, f.partner.id));
    expect(card).toMatchObject({ aiCoverage: 'included', aiMarkupPercent: null });
    expect(card.aiRates).toEqual([]);
  });

  it('clone copies coverage, markup and the price list', async () => {
    const f = await fixture();
    const created = await f.run(() => createProfile(writer, f.partner.id, { ...base, name: `AI ${randomUUID()}`,
      aiCoverage: 'billable', aiMarkupPercent: '30.00', aiRates: [rate('w10-test-a')] }));
    const clone = await f.run(() => cloneProfile(writer, created.id, f.partner.id, `Clone ${randomUUID()}`));
    const card = await f.run(() => getProfile(clone.id, f.partner.id));
    expect(card).toMatchObject({ aiCoverage: 'billable', aiMarkupPercent: '30.00' });
    expect(card.aiRates.map((r) => r.modelId)).toEqual(['w10-test-a']);
  });

  it('a card with a price list cannot change currency (PROFILE_CURRENCY_LOCKED)', async () => {
    const f = await fixture();
    const created = await f.run(() => createProfile(writer, f.partner.id, { ...base, name: `AI ${randomUUID()}`,
      aiCoverage: 'billable', aiRates: [rate('w10-test-a')] }));
    await expect(f.run(() => updateProfile(writer, created.id, f.partner.id, { currencyCode: 'EUR' })))
      .rejects.toMatchObject({ code: 'PROFILE_CURRENCY_LOCKED' });
  });

  it('a markup is a price: a markup-only card cannot change currency until the markup is cleared', async () => {
    const f = await fixture();
    const created = await f.run(() => createProfile(writer, f.partner.id, { ...base, name: `AI ${randomUUID()}`,
      aiCoverage: 'billable', aiMarkupPercent: '25.00' }));
    await expect(f.run(() => updateProfile(writer, created.id, f.partner.id, { currencyCode: 'EUR' })))
      .rejects.toMatchObject({ status: 409, code: 'PROFILE_CURRENCY_LOCKED' });
    expect(await f.run(() => getProfile(created.id, f.partner.id))).toMatchObject({ currencyCode: 'USD', aiMarkupPercent: '25.00' });
    await f.run(() => updateProfile(writer, created.id, f.partner.id, { aiMarkupPercent: null }));
    const moved = await f.run(() => updateProfile(writer, created.id, f.partner.id, { currencyCode: 'EUR' }));
    expect(moved).toMatchObject({ currencyCode: 'EUR', aiMarkupPercent: null, aiCoverage: 'billable' });
  });

  it('the drawer save: switching to included with no aiRates clears the markup and the price list', async () => {
    const f = await fixture();
    const created = await f.run(() => createProfile(writer, f.partner.id, { ...base, name: `AI ${randomUUID()}`,
      aiCoverage: 'billable', aiMarkupPercent: '15.00', aiRates: [rate('w10-test-a')] }));
    const saved = await f.run(() => saveProfile(writer, created.id, f.partner.id,
      { ...base, name: created.name, rows: [], aiCoverage: 'included' }));
    expect(saved).toMatchObject({ aiCoverage: 'included', aiMarkupPercent: null, aiRates: [] });
    expect(await f.run(() => getProfile(created.id, f.partner.id))).toMatchObject({ aiCoverage: 'included', aiMarkupPercent: null, aiRates: [] });
  });

  it('the drawer save: included with a non-empty price list is INVALID_AI_TERMS and changes nothing', async () => {
    const f = await fixture();
    const created = await f.run(() => createProfile(writer, f.partner.id, { ...base, name: `AI ${randomUUID()}`,
      aiCoverage: 'billable', aiMarkupPercent: '15.00', aiRates: [rate('w10-test-a')] }));
    await expect(f.run(() => saveProfile(writer, created.id, f.partner.id,
      { ...base, name: created.name, rows: [], aiCoverage: 'included', aiRates: [rate('w10-test-b')] })))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_AI_TERMS' });
    const card = await f.run(() => getProfile(created.id, f.partner.id));
    expect(card).toMatchObject({ aiCoverage: 'billable', aiMarkupPercent: '15.00' });
    expect(card.aiRates.map((r) => r.modelId)).toEqual(['w10-test-a']);
  });

  it('loadCardsForOrg returns aiRates on the cards it resolves', async () => {
    const f = await fixture();
    await f.run(() => createProfile(writer, f.partner.id, { ...base, name: `Default ${randomUUID()}`, isDefault: true,
      aiCoverage: 'billable', aiRates: [rate('w10-test-a')] }));
    const cards = await f.run(() => loadCardsForOrg(f.org.id, f.partner.id, 'USD'));
    expect(cards.partnerDefaultCard?.aiRates.map((r) => r.modelId)).toEqual(['w10-test-a']);
  });

  it('model choices list enabled offerings and recently served models, never another partner\'s', async () => {
    const f = await fixture();
    const other = await fixture();
    const db = getTestDb();
    const pm = randomUUID();
    try {
      await db.execute(sql`INSERT INTO ai_platform_models (id, provider, model_id, display_name)
        VALUES (${pm}, 'anthropic', ${'w10-test-' + pm}, 'W10 Test Model')`);
      await db.execute(sql`INSERT INTO partner_ai_models (partner_id, platform_model_id, source, enabled)
        VALUES (${f.partner.id}, ${pm}, 'platform', true), (${other.partner.id}, ${pm}, 'platform', true)`);
      await db.execute(sql`INSERT INTO ai_invocations (org_id, surface, funding_source, requested_model, served_model, ledger_mode, rate_snapshot, cost_cents)
        VALUES (${f.org.id}, 'chat', 'platform', 'w10-test-served', 'w10-test-served', 'authoritative', '{}'::jsonb, 1),
               (${other.org.id}, 'chat', 'platform', 'w10-test-foreign', 'w10-test-foreign', 'authoritative', '{}'::jsonb, 1)`);

      // W03: a disconnected connection keeps its rows but every reader excludes it.
      // The offering is seeded ENABLED (superuser, no DB guard forbids it) so the
      // connection-status filter, not the enabled flag, is what must exclude it.
      // CONTROL: the same shape on an ACTIVE connection is listed.
      const [disconnected] = await db.execute(sql`INSERT INTO partner_ai_connections (partner_id, kind, name, base_url, status)
        VALUES (${f.partner.id}, 'openai_compatible', 'W10 gone', 'https://llm.example.test/v1', 'disconnected') RETURNING id`);
      const [active] = await db.execute(sql`INSERT INTO partner_ai_connections (partner_id, kind, name, base_url, status)
        VALUES (${f.partner.id}, 'openai_compatible', 'W10 live', 'https://llm.example.test/v1', 'active') RETURNING id`);
      await db.execute(sql`INSERT INTO partner_ai_models (partner_id, connection_id, model_id, source, display_name, enabled)
        VALUES (${f.partner.id}, ${String(disconnected!.id)}, 'w10-test-disconnected', 'manual', 'W10 Disconnected', true),
               (${f.partner.id}, ${String(active!.id)}, 'w10-test-live', 'manual', 'W10 Live', true)`);

      const choices = await f.run(() => listAiModelChoices(f.partner.id));
      expect(choices).toEqual(expect.arrayContaining([
        { modelId: 'w10-test-' + pm, label: 'W10 Test Model', source: 'offering' },
        { modelId: 'w10-test-served', label: 'w10-test-served', source: 'recent_usage' },
        { modelId: 'w10-test-live', label: 'W10 Live', source: 'offering' },
      ]));
      expect(choices.map((c) => c.modelId)).not.toContain('w10-test-foreign');
      expect(choices.map((c) => c.modelId)).not.toContain('w10-test-disconnected');
    } finally {
      // ai_platform_models is global (not reached by the tenant-root truncate).
      await db.execute(sql`DELETE FROM partner_ai_models WHERE platform_model_id = ${pm}`);
      await db.execute(sql`DELETE FROM ai_platform_models WHERE id = ${pm}`);
    }
  });
});
