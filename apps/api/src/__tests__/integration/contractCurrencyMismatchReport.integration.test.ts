/**
 * Multi-currency wave 6 (#3778), Task 15 — the CONTRACT-vs-ORG CURRENCY
 * MISMATCH REPORT, proved against real Postgres.
 *
 * WHY IT EXISTS. Pre-wave-2 contracts stamped 'USD' under a non-USD org bill
 * USD forever (wave 2 removed issueInvoice's partner-currency overwrite and
 * generateDueInvoice faithfully propagates the stale stamp). Operators need an
 * inventory of those anomalies — ALL statuses, not just the actionable ACTIVE
 * ones — plus, per row, whether the Task 14 escape hatch would actually accept
 * it right now and, if not, exactly why.
 *
 * The eligibility verdict comes from inspectContractCurrencyEligibility — the
 * SAME helper changeContractCurrency gates on — so the report can never
 * disagree with the mutation. That equivalence is asserted directly below
 * against the real mutation, not merely assumed.
 *
 * READ-ONLY by construction: no bulk restamp, no bulk fix (owner-fixed "no bulk
 * restamp of history").
 *
 * No fixture memoization: integration/setup.ts TRUNCATEs partners/organizations
 * before every test, so each test re-seeds fresh.
 */
import './setup';

import { describe, expect, it, vi } from 'vitest';

// Fire-and-forget BullMQ / SMTP side effects are not the correctness under test
// (same rationale as the wave-6 gate slices). Everything monetary is real.
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  activateContract, addContractLineToContract, cancelContract, changeContractCurrency,
  createContract, generateDueInvoice,
} from '../../services/contractService';
import { listContractCurrencyMismatches } from '../../services/contractCurrencyReportService';
import type { ContractActor } from '../../services/contractTypes';
import { seedGateOrg, type GateOrgFixture } from './multiCurrencyWave6GateFixtures';

const RUN = !!process.env.DATABASE_URL;

const START_DATE = '2026-07-01';
const ACTIVATE_AT = new Date('2026-07-01T00:00:00Z');
const BILL_AT = new Date('2026-07-01T06:00:00Z');

/** Route-populated actor carrying VERIFIED contracts:manage evidence. */
function manageActor(f: GateOrgFixture): ContractActor {
  return { ...f.actor, permissions: new Set(['contracts:read', 'contracts:write', 'contracts:manage']) };
}

async function seedContract(
  f: GateOrgFixture, name: string, currency: string,
  opts: { activate?: boolean; unitPrice?: string } = {},
): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const c = await createContract({
      orgId: f.orgId, name, billingTiming: 'advance', intervalMonths: 1,
      startDate: START_DATE, currencyCode: currency,
    }, f.actor);
    await addContractLineToContract(c.id, {
      lineType: 'flat', description: 'Managed services', unitPrice: opts.unitPrice ?? '500.00', taxable: false,
    } as never, f.actor);
    if (opts.activate !== false) await activateContract(c.id, f.actor, ACTIVATE_AT);
    return c.id;
  });
}

async function generate(contractId: string) {
  return runOutsideDbContext(() => withSystemDbAccessContext(() => generateDueInvoice(contractId, BILL_AT)));
}

function report(actor: ContractActor, query: Parameters<typeof listContractCurrencyMismatches>[0] = {}) {
  return withSystemDbAccessContext(() => listContractCurrencyMismatches(query, actor));
}

/**
 * The wave-6 anomaly fixture: a EUR org holding
 *  - `eligible`   USD ACTIVE, nothing billed          -> eligible
 *  - `blocked`    USD ACTIVE with a generated draft   -> UNBILLED_MONETARY_ROWS
 *  - `cancelled`  USD CANCELLED                       -> STATUS_NOT_ACTIVE (still listed)
 *  - `matching`   EUR ACTIVE                          -> ABSENT (no mismatch)
 */
async function seedAnomalies(f: GateOrgFixture) {
  const eligible = await seedContract(f, 'Legacy MSA (clean)', 'USD');
  const blocked = await seedContract(f, 'Legacy MSA (billed)', 'USD');
  await generate(blocked);
  const cancelled = await seedContract(f, 'Legacy MSA (cancelled)', 'USD');
  await withSystemDbAccessContext(() => cancelContract(cancelled, f.actor));
  const matching = await seedContract(f, 'Current MSA', 'EUR');
  return { eligible, blocked, cancelled, matching };
}

describe.runIf(RUN)('contract vs org currency mismatch report (#3778, Task 15)', () => {
  it('lists every mismatched contract in ALL statuses, with the exact eligibility verdict', async () => {
    const f = await seedGateOrg('EUR');
    const ids = await seedAnomalies(f);

    const res = await report(manageActor(f), { limit: 100 });
    const byId = new Map(res.items.map((i) => [i.contractId, i]));

    // The matching-currency contract is an anomaly-free row: it must never appear.
    expect(byId.has(ids.matching)).toBe(false);
    expect(res.items).toHaveLength(3);
    expect(res.nextCursor).toBeNull();

    const clean = byId.get(ids.eligible)!;
    expect(clean).toMatchObject({
      orgId: f.orgId, status: 'active',
      contractCurrencyCode: 'USD', orgCurrencyCode: 'EUR',
      draftMonetaryInvoiceCount: 0, blockingDraftInvoiceIds: [],
      orphanedBillingPeriodCount: 0,
      activeChangeEligible: true, ineligibleReason: null,
    });
    expect(clean.contractName).toBe('Legacy MSA (clean)');
    expect(clean.orgName).toEqual(expect.any(String));
    expect(clean.orgName.length).toBeGreaterThan(0);
    expect(clean.nextBillingAt).toEqual(expect.any(String));

    const blocked = byId.get(ids.blocked)!;
    expect(blocked).toMatchObject({
      status: 'active', contractCurrencyCode: 'USD', orgCurrencyCode: 'EUR',
      draftMonetaryInvoiceCount: 1,
      activeChangeEligible: false, ineligibleReason: 'UNBILLED_MONETARY_ROWS',
    });
    expect(blocked.blockingDraftInvoiceIds).toHaveLength(1);

    const cancelled = byId.get(ids.cancelled)!;
    expect(cancelled).toMatchObject({
      status: 'cancelled', contractCurrencyCode: 'USD', orgCurrencyCode: 'EUR',
      activeChangeEligible: false, ineligibleReason: 'STATUS_NOT_ACTIVE',
    });
  });

  it('agrees with the mutation: an eligible row restamps, a blocked row 409s with the SAME ids', async () => {
    const f = await seedGateOrg('EUR');
    const ids = await seedAnomalies(f);
    const actor = manageActor(f);

    const before = await report(actor, { limit: 100 });
    const blockedRow = before.items.find((i) => i.contractId === ids.blocked)!;

    await expect(withSystemDbAccessContext(() => changeContractCurrency(
      ids.blocked, { currencyCode: 'EUR', clearLines: true, confirmActiveChange: true }, actor,
    ))).rejects.toMatchObject({
      code: 'UNBILLED_MONETARY_ROWS', status: 409,
      details: { draftInvoiceIds: blockedRow.blockingDraftInvoiceIds },
    });

    // The row the report called eligible is exactly the row the mutation accepts.
    const changed = await withSystemDbAccessContext(() => changeContractCurrency(
      ids.eligible, { currencyCode: 'EUR', clearLines: true, confirmActiveChange: true }, actor,
    ));
    expect(changed.currencyCode).toBe('EUR');

    // ...and it leaves the report, because it is no longer a mismatch.
    const after = await report(actor, { limit: 100 });
    expect(after.items.map((i) => i.contractId)).not.toContain(ids.eligible);
    expect(after.items.map((i) => i.contractId).sort())
      .toEqual([ids.blocked, ids.cancelled].sort());
  });

  it('never leaks another partner\'s mismatched contract', async () => {
    const a = await seedGateOrg('EUR');
    const b = await seedGateOrg('EUR');
    const mine = await seedContract(a, 'Mine', 'USD');
    const theirs = await seedContract(b, 'Theirs', 'USD');

    const res = await report(manageActor(a), { limit: 100 });
    const listed = res.items.map((i) => i.contractId);
    expect(listed).toContain(mine);
    expect(listed).not.toContain(theirs);
    expect(res.items.every((i) => i.orgId === a.orgId)).toBe(true);
  });

  it('rejects an orgId the actor cannot access (ORG_DENIED 403)', async () => {
    const a = await seedGateOrg('EUR');
    const b = await seedGateOrg('EUR');
    await seedContract(b, 'Theirs', 'USD');

    await expect(report(manageActor(a), { orgId: b.orgId }))
      .rejects.toMatchObject({ code: 'ORG_DENIED', status: 403 });
  });

  it('filters by status without hiding the mismatch inventory shape', async () => {
    const f = await seedGateOrg('EUR');
    const ids = await seedAnomalies(f);

    const cancelledOnly = await report(manageActor(f), { status: 'cancelled', limit: 100 });
    expect(cancelledOnly.items.map((i) => i.contractId)).toEqual([ids.cancelled]);

    const activeOnly = await report(manageActor(f), { status: 'active', limit: 100 });
    expect(activeOnly.items.map((i) => i.contractId).sort())
      .toEqual([ids.eligible, ids.blocked].sort());
  });

  it('paginates by cursor, returning each mismatched contract exactly once', async () => {
    const f = await seedGateOrg('EUR');
    const ids = await seedAnomalies(f);
    const actor = manageActor(f);

    const seen: string[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await report(actor, { limit: 1, cursor: cursor ?? undefined });
      seen.push(...res.items.map((i) => i.contractId));
      cursor = res.nextCursor;
      if (cursor === null) break;
      expect(res.items).toHaveLength(1);
    }
    expect(cursor).toBeNull();
    expect(seen.sort()).toEqual([ids.eligible, ids.blocked, ids.cancelled].sort());
    expect(new Set(seen).size).toBe(3);
  });
});
