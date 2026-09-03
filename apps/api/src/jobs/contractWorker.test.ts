import { describe, it, expect, vi, beforeEach } from 'vitest';

// Multi-currency wave 3 (#3775): the billing sweep must surface every
// price-book gap generateDueInvoice reports — one structured warning per gap —
// so "billed at the contract snapshot" is never silent. Service + queue layers
// are mocked; only the sweep's wiring is under test.
const { generateDueInvoiceMock, issueInvoiceMock, sendInvoiceEmailMock, captureExceptionMock } = vi.hoisted(() => ({
  generateDueInvoiceMock: vi.fn(),
  issueInvoiceMock: vi.fn(),
  sendInvoiceEmailMock: vi.fn(),
  captureExceptionMock: vi.fn(),
}));
vi.mock('../services/contractService', () => ({ generateDueInvoice: generateDueInvoiceMock }));
vi.mock('../services/contractRenewal', () => ({ runContractRenewalSweep: vi.fn() }));
vi.mock('../services/invoiceService', () => ({ issueInvoice: issueInvoiceMock }));
vi.mock('../services/invoicePdf', () => ({ sendInvoiceEmail: sendInvoiceEmailMock }));
vi.mock('../services/sentry', () => ({ captureException: captureExceptionMock }));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('bullmq', () => ({ Queue: class {}, Worker: class {}, Job: class {} }));

// The due-contract select resolves to whatever `dueRows` holds.
const { dueRows } = vi.hoisted(() => ({ dueRows: [] as Array<{ id: string; orgId?: string }> }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => Promise.resolve(dueRows).then(resolve);
  return {
    db: chain,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Mock } from 'vitest';
import { db } from '../db';
import { runContractBillingSweep } from './contractWorker';

describe('runContractBillingSweep price-book gap logging (#3775)', () => {
  beforeEach(() => { vi.clearAllMocks(); dueRows.length = 0; });

  it('logs one structured console.warn per gap and still counts the contract as billed', async () => {
    dueRows.push({ id: 'c1' });
    generateDueInvoiceMock.mockResolvedValue({
      generated: true, invoiceId: 'inv1', autoIssue: false, actor: { userId: null, partnerId: 'p1', accessibleOrgIds: ['org1'] },
      priceBookGaps: [
        { contractLineId: 'cl-1', catalogItemId: 'cat-1', itemName: 'Managed endpoint', currencyCode: 'EUR' },
        { contractLineId: 'cl-2', catalogItemId: 'cat-2', itemName: 'Backup', currencyCode: 'EUR' },
      ],
      uncoveredDevices: null,
      overages: [],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await runContractBillingSweep(new Date('2026-07-01T06:00:00Z'));
      expect(res).toEqual({ billed: 1, failed: 0 });
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenNthCalledWith(1, expect.stringContaining('price-book gap'), 'c1', 'cl-1', 'cat-1', 'EUR');
      expect(warn).toHaveBeenNthCalledWith(2, expect.stringContaining('price-book gap'), 'c1', 'cl-2', 'cat-2', 'EUR');
      expect(captureExceptionMock).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('logs nothing when there are no gaps', async () => {
    dueRows.push({ id: 'c1' });
    generateDueInvoiceMock.mockResolvedValue({ generated: true, invoiceId: 'inv1', autoIssue: false, priceBookGaps: [], uncoveredDevices: null, overages: [] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runContractBillingSweep(new Date('2026-07-01T06:00:00Z'));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('logs one structured warning when generated billing leaves devices uncovered', async () => {
    dueRows.push({ id: 'c1' });
    const uncovered = { total: 3, byRole: { unknown: 2, printer: 1 } };
    generateDueInvoiceMock.mockResolvedValue({ generated: true, invoiceId: 'inv1', autoIssue: false, priceBookGaps: [], uncoveredDevices: uncovered, overages: [] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runContractBillingSweep(new Date('2026-07-01T06:00:00Z'));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('uncovered devices'), 'c1', 3, JSON.stringify(uncovered.byRole));
    } finally {
      warn.mockRestore();
    }
  });

  it('logs both price-book and uncovered-device warnings when both apply', async () => {
    dueRows.push({ id: 'c1' });
    const uncovered = { total: 3, byRole: { unknown: 2, printer: 1 } };
    generateDueInvoiceMock.mockResolvedValue({
      generated: true, invoiceId: 'inv1', autoIssue: false,
      priceBookGaps: [{ contractLineId: 'cl-1', catalogItemId: 'cat-1', itemName: 'Managed endpoint', currencyCode: 'EUR' }],
      uncoveredDevices: uncovered,
      overages: [],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runContractBillingSweep(new Date('2026-07-01T06:00:00Z'));
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenNthCalledWith(1, expect.stringContaining('price-book gap'), 'c1', 'cl-1', 'cat-1', 'EUR');
      expect(warn).toHaveBeenNthCalledWith(2, expect.stringContaining('uncovered devices'), 'c1', 3, JSON.stringify(uncovered.byRole));
    } finally {
      warn.mockRestore();
    }
  });

  it('does not log an uncovered-device warning when the uncovered total is zero', async () => {
    dueRows.push({ id: 'c1' });
    generateDueInvoiceMock.mockResolvedValue({
      generated: true, invoiceId: 'inv1', autoIssue: false, priceBookGaps: [],
      uncoveredDevices: { total: 0, byRole: {} },
      overages: [],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runContractBillingSweep(new Date('2026-07-01T06:00:00Z'));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('a GROUP_EVALUATION_FAILED contract is logged and reported, and the next contract still generates', async () => {
    dueRows.push({ id: 'c1' }, { id: 'c2' });
    generateDueInvoiceMock
      .mockRejectedValueOnce(Object.assign(new Error('group failed'), { code: 'GROUP_EVALUATION_FAILED' }))
      .mockResolvedValueOnce({ generated: true, invoiceId: 'inv2', autoIssue: false, priceBookGaps: [], uncoveredDevices: null, overages: [] });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const summary = await runContractBillingSweep(new Date('2026-07-01T06:00:00Z'));
      expect(generateDueInvoiceMock).toHaveBeenCalledTimes(2);
      expect(err).toHaveBeenCalledWith('[ContractWorker] generation failed', 'contractId=c1', 'group failed');
      expect(summary).toMatchObject({ billed: 1, failed: 1 });
    } finally {
      err.mockRestore();
    }
  });

  it('a SITE_DELETED contract is rolled back, reported, and the next contract still generates', async () => {
    dueRows.push({ id: 'c1' }, { id: 'c2' });
    const siteDeleted = Object.assign(new Error('site deleted'), { code: 'SITE_DELETED' });
    generateDueInvoiceMock
      .mockRejectedValueOnce(siteDeleted)
      .mockResolvedValueOnce({ generated: true, invoiceId: 'inv2', autoIssue: false, priceBookGaps: [], uncoveredDevices: null, overages: [] });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const summary = await runContractBillingSweep(new Date('2026-07-01T06:00:00Z'));
      expect(generateDueInvoiceMock).toHaveBeenCalledTimes(2);
      expect(err).toHaveBeenCalledWith('[ContractWorker] generation failed', 'contractId=c1', 'site deleted');
      expect(captureExceptionMock).toHaveBeenCalledWith(siteDeleted);
      expect(summary).toEqual({ billed: 1, failed: 1 });
    } finally {
      err.mockRestore();
    }
  });

  it('warns once per FLAGGED overage and never for a billed one (#3205 W04)', async () => {
    dueRows.push({ id: 'c1', orgId: 'org1' });
    generateDueInvoiceMock.mockResolvedValue({
      generated: true, invoiceId: 'inv1', autoIssue: false,
      actor: { userId: null, partnerId: 'p1', accessibleOrgIds: ['org1'] },
      priceBookGaps: [], uncoveredDevices: null,
      overages: [
        { contractLineId: 'cl-1', invoiceLineId: null, description: 'SECRET-TOKEN-123', counted: 30, included: 25, overage: 5, mode: 'flag' },
        { contractLineId: 'cl-2', description: 'Servers', counted: 12, included: 10, overage: 2, mode: 'bill' },
      ],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await runContractBillingSweep(new Date('2026-07-01T06:00:00Z'));
      expect(res).toEqual({ billed: 1, failed: 0 });
      // Billed overage is on the invoice — that is not silence, so no warning.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('flagged overage'), 'c1', 'org1', 'cl-1', 30, 25, 5, 'flag',
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET-TOKEN-123');
    } finally { warn.mockRestore(); }
  });

  it('an empty overages array warns nothing and leaves the other warnings intact', async () => {
    dueRows.push({ id: 'c1' });
    generateDueInvoiceMock.mockResolvedValue({
      generated: true, invoiceId: 'inv1', autoIssue: false,
      actor: { userId: null, partnerId: 'p1', accessibleOrgIds: ['org1'] },
      priceBookGaps: [], uncoveredDevices: { total: 2, byRole: { unknown: 2 } }, overages: [],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runContractBillingSweep(new Date('2026-07-01T06:00:00Z'));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('uncovered devices'), 'c1', 2, '{"unknown":2}');
    } finally { warn.mockRestore(); }
  });
});

// ── billing sweep tenant scope (org-lifecycle Wave 4 review fix C-A.2) ──────
// Structurally identical to the overdue/renewal sweeps: fleet-wide select
// under a system context, so an ARCHIVED tenant would keep generating (and
// auto-issuing + emailing) invoices from inside its purge countdown.
describe('runContractBillingSweep tenant scope', () => {
  const dialect = new PgDialect();

  beforeEach(() => { vi.clearAllMocks(); dueRows.length = 0; });

  it('restricts the due-contract select to automation-eligible orgs (compiled SQL)', async () => {
    await runContractBillingSweep(new Date('2026-08-26T06:00:00Z'));

    const whereArg = (db as unknown as { where: Mock }).where.mock.calls[0]![0] as SQL;
    const { sql, params } = dialect.sqlToQuery(whereArg);
    expect(sql).toContain('automation_eligible_org.id = "contracts"."org_id"');
    expect(params).not.toContain('archived');
    expect(params).not.toContain('purging');
    expect(params).not.toContain('merging');
    // Pre-existing predicates survive alongside it.
    expect(sql).toContain('"contracts"."next_billing_at" <=');
  });
});
