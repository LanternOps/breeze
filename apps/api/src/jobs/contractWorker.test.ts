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
const { dueRows } = vi.hoisted(() => ({ dueRows: [] as Array<{ id: string }> }));
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
    generateDueInvoiceMock.mockResolvedValue({ generated: true, invoiceId: 'inv1', autoIssue: false, priceBookGaps: [], uncoveredDevices: null });
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
    generateDueInvoiceMock.mockResolvedValue({ generated: true, invoiceId: 'inv1', autoIssue: false, priceBookGaps: [], uncoveredDevices: uncovered });
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
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runContractBillingSweep(new Date('2026-07-01T06:00:00Z'));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
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
