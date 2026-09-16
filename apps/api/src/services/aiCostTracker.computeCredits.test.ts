/**
 * Execution plane W04 (spec §5.6) — the compute credit leg and the
 * reservation/settlement pair. The properties that matter:
 *   - `partner_key` is exempt from CREDITS but never from CHARGE;
 *   - a zero reservation never asks billing anything;
 *   - settling CLEARS the reservation in the same write that records the
 *     cents, so the admission sum can never double-count a settled run;
 *   - settling at 0 (the enqueue-failure release) still clears it, and still
 *     deducts nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const updates: Array<Record<string, unknown>> = [];
const inserts: Array<Record<string, unknown>> = [];

vi.mock('../db', () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return { where: async () => [] };
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
}));

import {
  checkComputeCredits, reserveComputeCents, settleComputeCents,
} from './aiCostTracker';

beforeEach(() => {
  updates.length = 0;
  inserts.length = 0;
  vi.restoreAllMocks();
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

  it('clears the reservation in the SAME write that records the cents', async () => {
    await settleComputeCents('org-1', 'run-1', 13, 'partner_key');
    // One statement, both fields: a two-statement settle could be interrupted
    // between them and leave the day double-counting this run.
    expect(updates[0]).toEqual({ computeCents: 13, computeReservedCents: null });
  });

  it('rolls the charge into both ai_cost_usage periods for partner_key too', async () => {
    await settleComputeCents('org-1', 'run-1', 13, 'partner_key');
    expect(inserts).toHaveLength(2);
    expect(inserts.map((i) => i.period)).toEqual(['daily', 'monthly']);
    expect(inserts.every((i) => i.computeCents === 13)).toBe(true);
  });

  it('settling at 0 releases the reservation and rolls up nothing', async () => {
    await settleComputeCents('org-1', 'run-1', 0, 'platform');
    expect(updates[0]).toEqual({ computeCents: 0, computeReservedCents: null });
    expect(inserts).toEqual([]);
  });

  it('rounds a fractional charge UP — a real run is never free', async () => {
    await settleComputeCents('org-1', 'run-1', 0.2, 'platform');
    expect(updates[0]).toMatchObject({ computeCents: 1 });
  });
});
