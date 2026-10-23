/**
 * Execution plane W04 (spec §5.6) — the compute credit leg and the
 * reservation/settlement pair. The properties that matter:
 *   - `partner_key` is exempt from CREDITS but never from CHARGE;
 *   - a zero reservation never asks billing anything;
 *   - settling CLEARS the reservation in the same write that records the
 *     cents, so the admission sum can never double-count a settled run;
 *   - settling at 0 (the enqueue-failure release) still clears it, and still
 *     debits nothing;
 *   - #9451: that write is also the per-attempt CLAIM — a second settle of the
 *     same attempt rolls up nothing and debits nothing — and platform compute
 *     is debited KEYED through the durable outbox (real-DB proof:
 *     aiInvocationSettlement.integration.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const updates: Array<Record<string, unknown>> = [];
const inserts: Array<Record<string, unknown>> = [];
// What the claim UPDATE ... RETURNING yields: one row = this call won the
// attempt's settlement; none = it was already settled.
let claimRows: Array<{ debitKey: string }> = [];
const KEY = 'ai-compute:run-1:1700000000000000';

const ctx = vi.hoisted(() => ({ ambient: undefined as { scope: string } | undefined, ownTransactions: 0 }));

const outbox = vi.hoisted(() => ({
  insertCreditDebitIntent: vi.fn(),
  deliverCreditDebit: vi.fn(),
}));

vi.mock('./aiCreditDebitOutbox', () => ({
  computeDebitKeySql: () => 'COMPUTE_DEBIT_KEY_SQL',
  insertCreditDebitIntent: outbox.insertCreditDebitIntent,
  deliverCreditDebit: outbox.deliverCreditDebit,
}));

vi.mock('../db', () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return { where: () => Object.assign(Promise.resolve([]), { returning: async () => claimRows }) };
      },
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserts.push(values);
        return { onConflictDoUpdate: async () => [] };
      },
    }),
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ partnerId: 'partner-1' }] }) }),
    }),
  },
  withSystemDbAccessContext: (fn: () => Promise<unknown>) => fn(),
  runOutsideDbContext: (fn: () => Promise<unknown>) => { ctx.ownTransactions++; return fn(); },
  getCurrentDbAccessContext: () => ctx.ambient,
}));

import {
  checkComputeCredits, reserveComputeCents, settleComputeCents,
} from './aiCostTracker';

beforeEach(() => {
  updates.length = 0;
  inserts.length = 0;
  claimRows = [{ debitKey: KEY }];
  ctx.ambient = undefined;
  ctx.ownTransactions = 0;
  vi.restoreAllMocks();
  outbox.insertCreditDebitIntent.mockReset().mockImplementation(async (input: Record<string, unknown>) => ({
    id: 'debit-1', orgId: input.orgId, source: input.source, idempotencyKey: input.idempotencyKey, costCents: input.costCents,
  }));
  outbox.deliverCreditDebit.mockReset().mockResolvedValue('debited');
  delete process.env.BILLING_SERVICE_URL;
  delete process.env.BILLING_SERVICE_API_KEY;
});

describe('checkComputeCredits', () => {
  it('returns null for partner_key without asking billing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await checkComputeCredits('org-1', 'partner_key', 25)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null for a zero reservation', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await checkComputeCredits('org-1', 'platform', 0)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls open (null) when no billing service is configured — the self-hosted default', async () => {
    expect(await checkComputeCredits('org-1', 'platform', 25)).toBeNull();
  });
});

describe('reserveComputeCents / settleComputeCents', () => {
  it('stamps the reservation on the run row', async () => {
    await reserveComputeCents('org-1', 'run-1', 25, 'platform');
    expect(updates).toEqual([{ computeReservedCents: 25 }]);
  });

  it('writes nothing for a non-positive reservation', async () => {
    await reserveComputeCents('org-1', 'run-1', 0, 'platform');
    expect(updates).toEqual([]);
  });

  it('clears the reservation in the SAME write that records the cents, and that write is the claim', async () => {
    await settleComputeCents('org-1', 'run-1', 13, 'partner_key');
    // One statement, all fields: a two-statement settle could be interrupted
    // between them and leave the day double-counting this run.
    expect(updates[0]).toMatchObject({ computeCents: 13, computeReservedCents: null });
    expect(updates[0]).toHaveProperty('computeSettledAt');
  });

  it('rolls the charge into both ai_cost_usage periods for partner_key too, and debits nothing', async () => {
    await settleComputeCents('org-1', 'run-1', 13, 'partner_key');
    expect(inserts).toHaveLength(2);
    expect(inserts.map((i) => i.period)).toEqual(['daily', 'monthly']);
    expect(inserts.every((i) => i.computeCents === 13)).toBe(true);
    expect(outbox.insertCreditDebitIntent).not.toHaveBeenCalled();
    expect(outbox.deliverCreditDebit).not.toHaveBeenCalled();
  });

  it('platform: writes a keyed debit intent in the claim transaction, then delivers it', async () => {
    await settleComputeCents('org-1', 'run-1', 13, 'platform');
    expect(outbox.insertCreditDebitIntent).toHaveBeenCalledWith({
      orgId: 'org-1', source: 'compute', sourceId: 'run-1', idempotencyKey: KEY, costCents: 13,
    });
    expect(outbox.deliverCreditDebit).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: KEY, costCents: 13 }));
  });

  it('inside an ambient SYSTEM transaction (the reaper inside admission) it joins it and leaves delivery to the sweep', async () => {
    // A second connection would block on the run row the caller's open
    // transaction already updated, while the caller awaits us: self-deadlock.
    ctx.ambient = { scope: 'system' };
    await settleComputeCents('org-1', 'run-1', 13, 'platform');
    expect(ctx.ownTransactions).toBe(0);
    expect(outbox.insertCreditDebitIntent).toHaveBeenCalled();
    expect(outbox.deliverCreditDebit).not.toHaveBeenCalled();
  });

  it('outside one it opens its own transaction and delivers after it commits', async () => {
    await settleComputeCents('org-1', 'run-1', 13, 'platform');
    expect(ctx.ownTransactions).toBe(1);
    expect(outbox.deliverCreditDebit).toHaveBeenCalled();
  });

  it('a second settle of the same attempt (claim lost) rolls up nothing and debits nothing', async () => {
    claimRows = [];
    await settleComputeCents('org-1', 'run-1', 25, 'platform');
    expect(inserts).toEqual([]);
    expect(outbox.insertCreditDebitIntent).not.toHaveBeenCalled();
    expect(outbox.deliverCreditDebit).not.toHaveBeenCalled();
  });

  it('settling at 0 releases the reservation and rolls up / debits nothing', async () => {
    await settleComputeCents('org-1', 'run-1', 0, 'platform');
    expect(updates[0]).toMatchObject({ computeCents: 0, computeReservedCents: null });
    expect(inserts).toEqual([]);
    expect(outbox.insertCreditDebitIntent).not.toHaveBeenCalled();
  });

  it('rounds a fractional charge UP — a real run is never free', async () => {
    await settleComputeCents('org-1', 'run-1', 0.2, 'platform');
    expect(updates[0]).toMatchObject({ computeCents: 1 });
    expect(outbox.insertCreditDebitIntent).toHaveBeenCalledWith(expect.objectContaining({ costCents: 1 }));
  });
});
