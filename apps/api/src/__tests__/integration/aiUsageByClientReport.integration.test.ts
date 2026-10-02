/**
 * #7608 W10 — ai_usage_by_client against REAL Postgres as the forced-RLS
 * `breeze_app` role. Proofs: per-org / per-model totals; shadow rows and
 * out-of-window rows excluded; a foreign partner's org never appears (explicit
 * predicate AND RLS); billed / unbilled split from the claim join; per-currency
 * rounding done once; request-context vs system-context PARITY.
 */
import './setup';

import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import type { AiUsageByClientSummary } from '@breeze/shared';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import { buildDbAccessContext, computeAccessibleOrgIds } from '../../middleware/auth';
import { generateReport, type ReportResult } from '../../services/reportGenerationService';
import { organizationScope, reportScopeFromAuthority } from '../../services/reportScope';
import {
  resolveLivePartnerReportAuthority,
  type ReportExecutionAuthority,
  type UserReportExecutionAuthority,
} from '../../services/siteScope';
import {
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(Boolean(process.env.DATABASE_URL));

const AUGUST = { kind: 'custom' as const, start: '2026-08-01', end: '2026-08-31' };

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

async function seedFixture() {
  const partner = await createPartner({});
  const acme = await createOrganization({ partnerId: partner.id, name: 'Acme' });
  const globex = await createOrganization({ partnerId: partner.id, name: 'Globex' });
  const otherPartner = await createPartner({});
  const foreignOrg = await createOrganization({ partnerId: otherPartner.id, name: 'Initech' });

  const user = await createUser({
    partnerId: partner.id,
    name: 'Dana Tech',
    email: `ai-usage-report-${randomUUID()}@example.com`,
  });
  const role = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(role.id, [
    { resource: 'reports', action: 'read' },
    { resource: 'invoices', action: 'read' },
    { resource: 'ai_sessions', action: 'read_all' },
  ]);
  await assignUserToPartner(user.id, partner.id, role.id, 'all');

  return { partner, acme, globex, otherPartner, foreignOrg, user };
}

type InvocationSeed = {
  orgId: string;
  model: string;
  createdAt?: string;
  ledgerMode?: 'shadow' | 'authoritative';
  costCents: number;
  chargeable: boolean;
  coverage: 'billable' | 'included' | 'non_billable' | 'not_eligible' | null;
  basis: 'price_list' | 'markup' | 'unpriced' | null;
  currency: string | null;
  amount: string | null;
};

/** A card id stamped on seeded rows. charge_billing_profile_id is a snapshot id
 *  with no FK (Task 5), so any uuid satisfies ai_invocations_charge_chk. */
const CARD_ID = randomUUID();

/** Seeded as the superuser (no RLS). Satisfies ai_invocations_shape_chk
 *  (rate_snapshot and cost_cents priced together) and ai_invocations_charge_chk
 *  (Task 5: a chargeable row carries a card, a currency and a basis; a
 *  non-chargeable row carries none of basis/currency/amount). */
async function seedInvocation(o: InvocationSeed): Promise<string> {
  const id = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO ai_invocations (id, org_id, surface, funding_source, requested_model, served_model,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      rate_snapshot, cost_cents, chargeable, ledger_mode, created_at,
      charge_billing_profile_id, charge_coverage, charge_basis, charge_currency, charge_amount)
    VALUES (${id}, ${o.orgId}, 'chat', 'platform', ${o.model}, ${o.model},
      1000, 200, 10, 5,
      '{}'::jsonb, ${o.costCents}, ${o.chargeable}, ${o.ledgerMode ?? 'authoritative'},
      ${o.createdAt ?? '2026-08-10T12:00:00Z'},
      ${o.coverage === null ? null : CARD_ID}, ${o.coverage}, ${o.basis}, ${o.currency}, ${o.amount})`);
  return id;
}

/** One monthly charge (and its run) claiming the given invocations. See the
 *  Interfaces note: the three INSERTs follow Task 7's columns. */
async function seedCharge(o: {
  orgId: string;
  partnerId: string;
  status: 'billed' | 'not_billed';
  invocationIds: string[];
  currency: string;
  model: string;
  amount: string;
  /** The billing run's month. A second charge for the same org + model goes in a
   *  LATER run (a straggler line) so neither the (org, month) run key nor the
   *  (run, usage month, currency, model, priced) charge key collides
   *  (Codex review finding 11). Usage month is always August. */
  period: '2026-08-01' | '2026-09-01';
}): Promise<void> {
  const db = getTestDb();
  const runId = randomUUID();
  const chargeId = randomUUID();
  const periodEnd = o.period === '2026-08-01' ? '2026-09-01' : '2026-10-01';
  await db.execute(sql`
    INSERT INTO ai_usage_charge_runs (id, org_id, partner_id, period_start, period_end)
    VALUES (${runId}, ${o.orgId}, ${o.partnerId}, ${o.period}, ${periodEnd})`);
  await db.execute(sql`
    INSERT INTO ai_usage_charges (id, org_id, partner_id, run_id, period_start, period_end, usage_period_start,
      currency_code, served_model, model_label, priced, invocation_count, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, amount_exact, amount, billing_status)
    VALUES (${chargeId}, ${o.orgId}, ${o.partnerId}, ${runId}, ${o.period}, ${periodEnd}, '2026-08-01',
      ${o.currency}, ${o.model}, ${o.model}, true, ${o.invocationIds.length}, 0, 0, 0, 0,
      ${o.amount}, ${o.amount}, ${o.status})`);
  for (const invocationId of o.invocationIds) {
    await db.execute(sql`
      INSERT INTO ai_usage_charge_claims (invocation_id, org_id, run_id, charge_id)
      VALUES (${invocationId}, ${o.orgId}, ${runId}, ${chargeId})`);
  }
}

async function seedUsage(f: Fixture) {
  const base = { chargeable: true } as const;
  const a1 = await seedInvocation({ ...base, orgId: f.acme.id, model: 'model-alpha', costCents: 800, coverage: 'billable', basis: 'price_list', currency: 'USD', amount: '12.345678' });
  const a2 = await seedInvocation({ ...base, orgId: f.acme.id, model: 'model-alpha', costCents: 250, coverage: 'billable', basis: 'markup', currency: 'USD', amount: '3.100000' });
  await seedInvocation({ ...base, orgId: f.acme.id, model: 'model-beta', costCents: 40, coverage: 'billable', basis: 'unpriced', currency: 'USD', amount: null });
  await seedInvocation({ orgId: f.acme.id, model: 'model-alpha', costCents: 500, chargeable: false, coverage: 'included', basis: null, currency: null, amount: null });
  // Shadow row: never counted.
  await seedInvocation({ orgId: f.acme.id, model: 'model-alpha', ledgerMode: 'shadow', costCents: 9999, chargeable: false, coverage: null, basis: null, currency: null, amount: null });
  // Outside [Aug 1, Sep 1) UTC: one second before, and exactly at the exclusive end.
  await seedInvocation({ ...base, orgId: f.acme.id, model: 'model-alpha', createdAt: '2026-07-31T23:59:59Z', costCents: 700, coverage: 'billable', basis: 'price_list', currency: 'USD', amount: '99.000000' });
  await seedInvocation({ ...base, orgId: f.acme.id, model: 'model-alpha', createdAt: '2026-09-01T00:00:00Z', costCents: 700, coverage: 'billable', basis: 'price_list', currency: 'USD', amount: '99.000000' });
  await seedInvocation({ ...base, orgId: f.globex.id, model: 'model-beta', costCents: 1500, coverage: 'billable', basis: 'price_list', currency: 'EUR', amount: '20.005000' });
  await seedInvocation({ orgId: f.globex.id, model: 'model-beta', costCents: 100, chargeable: false, coverage: 'non_billable', basis: null, currency: null, amount: null });
  // Another partner's org: must never appear.
  await seedInvocation({ ...base, orgId: f.foreignOrg.id, model: 'model-alpha', costCents: 100000, coverage: 'billable', basis: 'price_list', currency: 'USD', amount: '999.000000' });

  await seedCharge({ orgId: f.acme.id, partnerId: f.partner.id, status: 'billed', invocationIds: [a1], currency: 'USD', model: 'model-alpha', amount: '12.35', period: '2026-08-01' });
  await seedCharge({ orgId: f.acme.id, partnerId: f.partner.id, status: 'not_billed', invocationIds: [a2], currency: 'USD', model: 'model-alpha', amount: '3.10', period: '2026-09-01' });
}

async function livePartnerAuthority(f: Fixture): Promise<UserReportExecutionAuthority> {
  const result = await resolveLivePartnerReportAuthority(f.user.id, f.partner.id, 'read');
  if (!result.ok) throw new Error(`partner authority refused: ${result.reason}`);
  return result.authority;
}

async function partnerRequestContext(f: Fixture): Promise<DbAccessContext> {
  const { orgIds } = await computeAccessibleOrgIds('partner', f.partner.id, null, f.user.id);
  return buildDbAccessContext({ scope: 'partner', orgId: null, accessibleOrgIds: orgIds, partnerId: f.partner.id, userId: f.user.id });
}

function orgAuthority(orgId: string, userId: string): ReportExecutionAuthority {
  return {
    principalKind: 'user',
    principalUserId: userId,
    scope: { version: 1, kind: 'unrestricted', orgId },
    capturedAt: new Date(),
    fingerprint: 'f'.repeat(64),
  };
}

const withoutGeneratedAt = (result: ReportResult): unknown => {
  const summary = { ...(result.summary ?? {}) } as Record<string, unknown>;
  delete summary.generatedAt;
  return { rows: result.rows, rowCount: result.rowCount, summary };
};

async function runPartner(f: Fixture, config: Record<string, unknown> = {}) {
  const authority = await livePartnerAuthority(f);
  const scope = await reportScopeFromAuthority({ partnerId: f.partner.id }, authority);
  return generateReport('ai_usage_by_client', scope, { period: AUGUST, ...config }, authority);
}

describe('ai_usage_by_client — real Postgres (#7608 W10)', () => {
  runDb('per-organization totals: shadow, out-of-window and foreign-partner rows are excluded; money is per currency, rounded once', async () => {
    const f = await seedFixture();
    await seedUsage(f);

    const s = (await runPartner(f)).summary as AiUsageByClientSummary;

    expect(s.groupBy).toBe('organization');
    expect(s.scope).toEqual({ kind: 'partner', partnerId: f.partner.id, orgCount: 2 });
    const byKey = Object.fromEntries(s.groups.map((g) => [g.groupLabel, g]));
    expect(Object.keys(byKey).sort()).toEqual(['Acme', 'Globex']);

    expect(byKey.Acme).toMatchObject({
      requests: 4, inputTokens: 4000, outputTokens: 800, cacheReadTokens: 40, cacheWriteTokens: 20,
      costUsd: '15.90', includedCostUsd: '5.00', unpricedRequests: 1,
    });
    expect(byKey.Acme!.charges).toEqual([{ currencyCode: 'USD', amount: '15.45', billed: '12.35', unbilled: '3.10' }]);

    expect(byKey.Globex).toMatchObject({ requests: 2, costUsd: '16.00', includedCostUsd: '0.00', unpricedRequests: 0 });
    // 20.005 rounds half-up to 20.01; no claim yet => entirely unbilled.
    expect(byKey.Globex!.charges).toEqual([{ currencyCode: 'EUR', amount: '20.01', billed: '0.00', unbilled: '20.01' }]);

    expect(s.overall).toMatchObject({ requests: 6, costUsd: '31.90', includedCostUsd: '5.00', unpricedRequests: 1 });
    expect(s.overall.charges).toEqual([
      { currencyCode: 'EUR', amount: '20.01', billed: '0.00', unbilled: '20.01' },
      { currencyCode: 'USD', amount: '15.45', billed: '12.35', unbilled: '3.10' },
    ]);
    // The foreign org's $999 and 100000 cents appear nowhere. Matched as
    // decimals, never a bare '999': a random uuid in the summary can contain
    // that digit run, and a uuid never contains a '.'.
    const everything = JSON.stringify(s);
    expect(everything).not.toContain('Initech');
    expect(everything).not.toContain(f.foreignOrg.id);
    expect(everything).not.toMatch(/999\.\d|1000\.\d/);
    expect(s.notes.join(' ')).toMatch(/Charges bill by UTC calendar month/);
  });

  runDb('groupBy model reconciles to the same overall totals', async () => {
    const f = await seedFixture();
    await seedUsage(f);

    const s = (await runPartner(f, { groupBy: 'model' })).summary as AiUsageByClientSummary;

    expect(s.groupBy).toBe('model');
    const byModel = Object.fromEntries(s.groups.map((g) => [g.groupKey, g]));
    expect(byModel['model-alpha']).toMatchObject({ requests: 3, costUsd: '15.50' });
    expect(byModel['model-beta']).toMatchObject({ requests: 3, costUsd: '16.40' });
    expect(s.groups.reduce((n, g) => n + g.requests, 0)).toBe(s.overall.requests);
  });

  runDb('detail rows are organization x model x currency, the no-charge usage carries null money', async () => {
    const f = await seedFixture();
    await seedUsage(f);

    const s = (await runPartner(f)).summary as AiUsageByClientSummary;

    // Ordered by Breeze cost DESC. Non-chargeable rows (included / non-billable)
    // carry a NULL charge_currency (Task 5 CHECK), so they form their own row.
    expect(s.rows.map((r) => [r.orgName, r.model, r.currencyCode, r.requests])).toEqual([
      ['Globex', 'model-beta', 'EUR', 1],   // 1500 c
      ['Acme', 'model-alpha', 'USD', 2],    // 800 + 250 c
      ['Acme', 'model-alpha', null, 1],     // 500 c, included
      ['Globex', 'model-beta', null, 1],    // 100 c, non-billable
      ['Acme', 'model-beta', 'USD', 1],     // 40 c, unpriced
    ]);
    const noCharge = s.rows.find((r) => r.currencyCode === null)!;
    expect(noCharge).toMatchObject({ amount: null, billed: null, unbilled: null });
    expect(s.detail).toMatchObject({ cap: 5000, stored: 5, available: 5, truncated: false });
  });

  runDb('the explicit org predicate fences even with no RLS: a scope naming one org never sees its sibling', async () => {
    const f = await seedFixture();
    await seedUsage(f);
    const authority = await livePartnerAuthority(f);

    // System context (no ambient RLS). Only the predicate stands between Acme and Globex/Initech.
    const result = await generateReport(
      'ai_usage_by_client',
      { kind: 'partner', partnerId: f.partner.id, orgIds: [f.acme.id] },
      { period: AUGUST },
      authority,
    );
    const s = result.summary as AiUsageByClientSummary;
    expect(s.groups.map((g) => g.groupLabel)).toEqual(['Acme']);
    expect(s.overall.requests).toBe(4);
    expect(JSON.stringify(s)).not.toContain('Globex');
  });

  runDb('org scope under a PARTNER context: only that org, default axis is model', async () => {
    const f = await seedFixture();
    await seedUsage(f);

    const s = await withDbAccessContext(await partnerRequestContext(f), async () =>
      (await generateReport('ai_usage_by_client', organizationScope(f.globex.id), { period: AUGUST },
        orgAuthority(f.globex.id, f.user.id))).summary as AiUsageByClientSummary);

    expect(s.groupBy).toBe('model');
    expect(s.scope).toEqual({ kind: 'organization', orgId: f.globex.id, orgName: 'Globex' });
    expect(s.overall.requests).toBe(2);
    expect(s.rows.every((r) => r.orgId === f.globex.id)).toBe(true);
  });

  runDb('PARITY: a partner-scope RLS request context and the system context produce identical reports', async () => {
    const f = await seedFixture();
    await seedUsage(f);
    const authority = await livePartnerAuthority(f);
    const scope = await reportScopeFromAuthority({ partnerId: f.partner.id }, authority);

    for (const groupBy of ['organization', 'model'] as const) {
      const config = { period: AUGUST, groupBy };
      const viaRequest = await withDbAccessContext(await partnerRequestContext(f), () =>
        generateReport('ai_usage_by_client', scope, config, authority));
      const viaSystem = await generateReport('ai_usage_by_client', scope, config, authority);
      expect(withoutGeneratedAt(viaRequest), groupBy).toEqual(withoutGeneratedAt(viaSystem));
      expect((viaSystem.summary as AiUsageByClientSummary).overall.requests, groupBy).toBe(6);
    }
  });

  runDb('a period with no usage is a real empty report, not an error', async () => {
    const f = await seedFixture();
    await seedUsage(f);

    const s = (await runPartner(f, { period: { kind: 'custom', start: '2025-01-01', end: '2025-01-31' } })).summary as AiUsageByClientSummary;
    expect(s.groups).toEqual([]);
    expect(s.rows).toEqual([]);
    expect(s.overall).toMatchObject({ requests: 0, costUsd: '0.00', charges: [] });
  });
});
