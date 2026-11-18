/**
 * BRZ-8807 D2-A: the block-hours close-out DEFERS for a partner with billing
 * off. The candidate select excludes the org (so no overage invoice, hour
 * period or ledger row is ever attempted), and a flag that flips off after the
 * selection is a deferral, not an error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Mock } from 'vitest';
import { SQL } from 'drizzle-orm';

const { candidates, createManualInvoiceMock, captureExceptionMock, txState } = vi.hoisted(() => ({
  candidates: [] as Array<{ contractId: string }>,
  createManualInvoiceMock: vi.fn(),
  captureExceptionMock: vi.fn(),
  txState: { error: null as unknown },
}));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'selectDistinct', 'from', 'where', 'innerJoin', 'limit']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => Promise.resolve(candidates).then(resolve);
  // The per-candidate transaction re-reads the contract FOR UPDATE; make it throw.
  (chain as { for: unknown }).for = vi.fn(() => Promise.reject(txState.error));
  return {
    db: chain,
    assertInTransaction: vi.fn(),
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});
vi.mock('./invoiceService', () => ({ addContractLine: vi.fn(), createManualInvoice: createManualInvoiceMock }));
vi.mock('./sentry', () => ({ captureException: captureExceptionMock }));
vi.mock('./ticketRowLock', () => ({ lockTicketsForWrite: vi.fn() }));

import { db } from '../db';
import { runHourBlockCloseOutSweep } from './contractHourBlockClose';

const dialect = new PgDialect();
const asOf = new Date('2026-10-20T06:00:00Z');

describe('runHourBlockCloseOutSweep billing-off deferral (BRZ-8807 D2-A)', () => {
  beforeEach(() => { vi.clearAllMocks(); candidates.length = 0; txState.error = null; });

  it('excludes billing-off partners from the candidates (compiled SQL), so createManualInvoice is unreachable for them', async () => {
    const res = await runHourBlockCloseOutSweep(asOf);
    expect(res).toEqual({ contracts: 0, closes: 0, errors: 0 });
    const whereArg = (db as unknown as { where: Mock }).where.mock.calls[0]![0] as SQL;
    const { sql } = dialect.sqlToQuery(whereArg);
    expect(sql).toContain('billing_gate_partner.billing_enabled = false');
    expect(sql).toContain('billing_gate_org.id = "contracts"."org_id"');
    expect(sql).toContain('automation_eligible_org.id = "contracts"."org_id"');
    expect(createManualInvoiceMock).not.toHaveBeenCalled();
  });

  it('BILLING_DISABLED raised for a candidate is not an error and is not reported', async () => {
    candidates.push({ contractId: 'c1' });
    txState.error = Object.assign(new Error('Not found'), { code: 'BILLING_DISABLED' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await runHourBlockCloseOutSweep(asOf);
      expect(res).toEqual({ contracts: 1, closes: 0, errors: 0 });
      expect(captureExceptionMock).not.toHaveBeenCalled();
    } finally { err.mockRestore(); }
  });

  it('any other error still counts and is reported', async () => {
    candidates.push({ contractId: 'c1' });
    txState.error = new Error('boom');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await runHourBlockCloseOutSweep(asOf);
      expect(res.errors).toBe(1);
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    } finally { err.mockRestore(); }
  });
});
