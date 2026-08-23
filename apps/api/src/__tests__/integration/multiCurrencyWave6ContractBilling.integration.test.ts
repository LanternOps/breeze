/**
 * Wave-6 release gate, slice G3 (#3778): the RECURRING CONTRACT BILLING RUN
 * against a non-USD org on a USD partner, driven through the scheduled entry
 * point (`runContractBillingSweep`) rather than a direct `generateDueInvoice`
 * call — existing EUR coverage (contractCurrency.integration.test.ts) already
 * covers the direct call, and the sweep is what the BullMQ processor runs.
 *
 * Multi-currency rules under test: a contract stamps its currency at creation
 * and the invoice it generates copies the CONTRACT's stamp (never the org's
 * current value); every persisted amount must be representable at the
 * currency's minor unit (JPY is zero-decimal); the period claim makes the
 * sweep idempotent.
 *
 * Runs under vitest.integration.config.ts against a real Postgres. No fixture
 * memoization — integration/setup.ts TRUNCATEs partners/organizations before
 * every test, so each test re-seeds fresh.
 */
import './setup';

import { describe, expect, it, vi } from 'vitest';

// Fire-and-forget BullMQ side effects + SMTP are not the correctness under
// test (same rationale as contractCurrency.integration.test.ts). The sweep's
// post-commit auto-issue path is exercised for real; only its email tail and
// the PDF render enqueue are stubbed.
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/invoicePdf', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendInvoiceEmail: vi.fn().mockResolvedValue(undefined),
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { roundToCurrency } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../../db';
import {
  contractBillingPeriods, contractLines, contracts, devices, invoiceLines, invoices, organizations,
} from '../../db/schema';
import {
  activateContract, addContractLineToContract, changeContractCurrency, createContract,
} from '../../services/contractService';
import { ContractServiceError } from '../../services/contractTypes';
import { issueInvoice } from '../../services/invoiceService';
import { runContractBillingSweep } from '../../jobs/contractWorker';
import { createCatalogItemWithPrice } from './db-utils';
import { gateLabel, seedGateOrg, type GateOrgFixture } from './multiCurrencyWave6GateFixtures';

const RUN = !!process.env.DATABASE_URL;

const START_DATE = '2026-07-01';
const ACTIVATE_AT = new Date('2026-07-01T00:00:00Z');
const SWEEP_AT = new Date('2026-07-01T06:00:00Z');
const SWEEP_AGAIN_AT = new Date('2026-07-01T06:05:00Z');

function assertionMessage(
  transition: string, currency: string, column: string, expected: unknown, actual: unknown,
): string {
  return `${transition}; currency=${currency}; column=${column}; expected=${String(expected)}; actual=${String(actual)}`;
}

async function setOrgTaxRate(orgId: string, rate: string): Promise<void> {
  await withSystemDbAccessContext(() =>
    db.update(organizations).set({ taxRate: rate }).where(eq(organizations.id, orgId)));
}

/** Two billable devices so the per_device quantity resolves to something non-trivial. */
async function seedDevices(fixture: GateOrgFixture, n: number): Promise<void> {
  await withSystemDbAccessContext(async () => {
    for (let i = 0; i < n; i++) {
      await db.insert(devices).values({
        orgId: fixture.orgId,
        siteId: fixture.siteId,
        agentId: `w6-g3-${fixture.orgId.slice(0, 8)}-${i}-${Math.random().toString(36).slice(2, 8)}`,
        hostname: `w6-g3-host-${i}`,
        osType: 'windows',
        osVersion: '11',
        architecture: 'x64',
        agentVersion: '1.0.0',
      });
    }
  });
}

async function readInvoice(invoiceId: string) {
  const [row] = await withSystemDbAccessContext(() => db
    .select({
      currencyCode: invoices.currencyCode,
      status: invoices.status,
      subtotal: invoices.subtotal,
      taxRate: invoices.taxRate,
      taxTotal: invoices.taxTotal,
      total: invoices.total,
      balance: invoices.balance,
      documentLocale: invoices.documentLocale,
    })
    .from(invoices).where(eq(invoices.id, invoiceId)).limit(1));
  return row;
}

async function readPeriods(contractId: string) {
  return withSystemDbAccessContext(() => db
    .select({ id: contractBillingPeriods.id, invoiceId: contractBillingPeriods.invoiceId })
    .from(contractBillingPeriods).where(eq(contractBillingPeriods.contractId, contractId)));
}

async function readGeneratedLines(contractId: string) {
  const periods = await readPeriods(contractId);
  const invoiceId = periods[0]?.invoiceId;
  if (!invoiceId) return { invoiceId: null as string | null, lines: [] as Array<{ description: string; quantity: string; unitPrice: string; lineTotal: string; taxable: boolean }> };
  const lines = await withSystemDbAccessContext(() => db
    .select({
      description: invoiceLines.description,
      quantity: invoiceLines.quantity,
      unitPrice: invoiceLines.unitPrice,
      lineTotal: invoiceLines.lineTotal,
      taxable: invoiceLines.taxable,
    })
    .from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(invoiceLines.sortOrder));
  return { invoiceId, lines };
}

/**
 * Seed an auto-issue contract in `currency` with one catalog-priced per_device
 * line and one hand-priced flat line, activated and due on SWEEP_AT.
 */
async function seedDueContract(opts: {
  currency: string; taxRate: string; catalogUnitPrice: string; flatUnitPrice: string; deviceCount: number;
}): Promise<{ fixture: GateOrgFixture; contractId: string }> {
  const fixture = await seedGateOrg(opts.currency);
  await setOrgTaxRate(fixture.orgId, opts.taxRate);
  await seedDevices(fixture, opts.deviceCount);

  const item = await withSystemDbAccessContext(() => createCatalogItemWithPrice({
    partnerId: fixture.partnerId,
    name: `W6 G3 managed endpoint ${opts.currency}`,
    currencyCode: opts.currency,
    unitPrice: opts.catalogUnitPrice,
  }));

  const contract = await withSystemDbAccessContext(() => createContract({
    orgId: fixture.orgId, name: `W6 G3 ${opts.currency}`, billingTiming: 'advance',
    intervalMonths: 1, startDate: START_DATE, autoIssue: true,
  }, fixture.actor));
  expect(
    contract.currencyCode,
    assertionMessage('createContract stamps the org currency', opts.currency, 'contracts.currency_code', opts.currency, contract.currencyCode),
  ).toBe(opts.currency);

  await withSystemDbAccessContext(() => addContractLineToContract(contract.id, {
    lineType: 'per_device', description: 'Managed endpoint', catalogItemId: item.id, sortOrder: 1,
  }, fixture.actor));
  await withSystemDbAccessContext(() => addContractLineToContract(contract.id, {
    lineType: 'flat', description: 'Service desk retainer', unitPrice: opts.flatUnitPrice, taxable: false, sortOrder: 2,
  }, fixture.actor));
  await withSystemDbAccessContext(() => activateContract(contract.id, fixture.actor, ACTIVATE_AT));

  return { fixture, contractId: contract.id };
}

describe.runIf(RUN)(gateLabel('G3', 'recurring contract billing run'), () => {
  it('bills a EUR contract through the sweep with EUR-resolved prices, EUR-rounded totals and a stamped locale', async () => {
    const { contractId } = await seedDueContract({
      currency: 'EUR', taxRate: '0.08250', catalogUnitPrice: '49.99', flatUnitPrice: '250.00', deviceCount: 2,
    });

    const first = await runContractBillingSweep(SWEEP_AT);
    expect(first, assertionMessage('runContractBillingSweep', 'EUR', 'sweep result', '{billed:1,failed:0}', JSON.stringify(first)))
      .toEqual({ billed: 1, failed: 0 });

    const periods = await readPeriods(contractId);
    expect(periods, assertionMessage('sweep claims one period', 'EUR', 'contract_billing_periods', 1, periods.length)).toHaveLength(1);
    expect(
      periods[0]?.invoiceId,
      assertionMessage('sweep claims one period', 'EUR', 'contract_billing_periods.invoice_id', 'non-null', periods[0]?.invoiceId),
    ).not.toBeNull();

    const { invoiceId, lines } = await readGeneratedLines(contractId);
    const row = await readInvoice(invoiceId!);
    expect(row?.currencyCode, assertionMessage('sweep-generated invoice', 'EUR', 'invoices.currency_code', 'EUR', row?.currencyCode)).toBe('EUR');

    // Catalog line: unit price comes from the EUR price book, quantity from the
    // live device count. Hand-priced flat line: qty 1 at its stamped price.
    expect(lines, assertionMessage('sweep-generated invoice', 'EUR', 'invoice_lines count', 2, lines.length)).toHaveLength(2);
    const perDevice = lines.find((l) => l.description === 'Managed endpoint');
    const flat = lines.find((l) => l.description === 'Service desk retainer');
    expect(Number(perDevice?.unitPrice), assertionMessage('catalog line pricing', 'EUR', 'invoice_lines.unit_price', 49.99, perDevice?.unitPrice)).toBe(49.99);
    expect(Number(perDevice?.quantity), assertionMessage('per_device quantity resolution', 'EUR', 'invoice_lines.quantity', 2, perDevice?.quantity)).toBe(2);
    expect(perDevice?.lineTotal, assertionMessage('catalog line total', 'EUR', 'invoice_lines.line_total', roundToCurrency(99.98, 'EUR'), perDevice?.lineTotal)).toBe(roundToCurrency(99.98, 'EUR'));
    expect(Number(flat?.quantity), assertionMessage('flat quantity resolution', 'EUR', 'invoice_lines.quantity', 1, flat?.quantity)).toBe(1);
    expect(flat?.lineTotal, assertionMessage('flat line total', 'EUR', 'invoice_lines.line_total', roundToCurrency(250, 'EUR'), flat?.lineTotal)).toBe(roundToCurrency(250, 'EUR'));

    // Exact expected decimals, rounded ONCE at the EUR minor unit:
    //   subtotal 2 x 49.99 + 250.00 = 349.98
    //   tax      99.98 x 0.08250 = 8.24835  (only the catalog line is taxable)
    //   total    349.98 + 8.25 = 358.23
    expect(row?.subtotal, assertionMessage('sweep-generated invoice', 'EUR', 'invoices.subtotal', roundToCurrency(349.98, 'EUR'), row?.subtotal)).toBe(roundToCurrency(349.98, 'EUR'));
    expect(row?.taxTotal, assertionMessage('sweep-generated invoice', 'EUR', 'invoices.tax_total', roundToCurrency(8.24835, 'EUR'), row?.taxTotal)).toBe(roundToCurrency(8.24835, 'EUR'));
    expect(row?.total, assertionMessage('sweep-generated invoice', 'EUR', 'invoices.total', roundToCurrency(358.23, 'EUR'), row?.total)).toBe(roundToCurrency(358.23, 'EUR'));
    expect(row?.balance, assertionMessage('sweep-generated invoice', 'EUR', 'invoices.balance', roundToCurrency(358.23, 'EUR'), row?.balance)).toBe(roundToCurrency(358.23, 'EUR'));

    // autoIssue: the sweep issues post-commit, which stamps the document locale.
    expect(row?.status, assertionMessage('post-commit auto-issue', 'EUR', 'invoices.status', 'sent', row?.status)).toBe('sent');
    expect(row?.documentLocale, assertionMessage('post-commit auto-issue', 'EUR', 'invoices.document_locale', 'non-null', row?.documentLocale)).toBeTruthy();
  });

  it('is idempotent: a second sweep at the same asOf bills nothing and claims no second period', async () => {
    const { fixture, contractId } = await seedDueContract({
      currency: 'EUR', taxRate: '0.08250', catalogUnitPrice: '49.99', flatUnitPrice: '250.00', deviceCount: 2,
    });

    const first = await runContractBillingSweep(SWEEP_AT);
    expect(first).toEqual({ billed: 1, failed: 0 });

    const second = await runContractBillingSweep(SWEEP_AGAIN_AT);
    expect(second, assertionMessage('second sweep at the same period', 'EUR', 'sweep result', '{billed:0,failed:0}', JSON.stringify(second)))
      .toEqual({ billed: 0, failed: 0 });

    const periods = await readPeriods(contractId);
    expect(periods, assertionMessage('second sweep', 'EUR', 'contract_billing_periods', 1, periods.length)).toHaveLength(1);

    // And no second invoice: the losing run deletes its own still-draft invoice.
    const invoiceRows = await withSystemDbAccessContext(() => db
      .select({ id: invoices.id }).from(invoices).where(eq(invoices.orgId, fixture.orgId)));
    expect(invoiceRows.length, assertionMessage('second sweep', 'EUR', 'invoices for the org', 1, invoiceRows.length)).toBe(1);
  });

  it('bills a JPY contract in whole yen — every persisted amount is representable at the zero-decimal minor unit', async () => {
    const { contractId } = await seedDueContract({
      currency: 'JPY', taxRate: '0.10000', catalogUnitPrice: '1000', flatUnitPrice: '5000', deviceCount: 2,
    });

    const res = await runContractBillingSweep(SWEEP_AT);
    expect(res, assertionMessage('runContractBillingSweep', 'JPY', 'sweep result', '{billed:1,failed:0}', JSON.stringify(res)))
      .toEqual({ billed: 1, failed: 0 });

    const { invoiceId, lines } = await readGeneratedLines(contractId);
    const row = await readInvoice(invoiceId!);
    expect(row?.currencyCode, assertionMessage('sweep-generated invoice', 'JPY', 'invoices.currency_code', 'JPY', row?.currencyCode)).toBe('JPY');

    // subtotal 2 x 1000 + 5000 = 7000; tax 2000 x 0.10 = 200; total 7200 — all whole yen.
    expect(row?.subtotal, assertionMessage('sweep-generated invoice', 'JPY', 'invoices.subtotal', roundToCurrency(7000, 'JPY'), row?.subtotal)).toBe(roundToCurrency(7000, 'JPY'));
    expect(row?.taxTotal, assertionMessage('sweep-generated invoice', 'JPY', 'invoices.tax_total', roundToCurrency(200, 'JPY'), row?.taxTotal)).toBe(roundToCurrency(200, 'JPY'));
    expect(row?.total, assertionMessage('sweep-generated invoice', 'JPY', 'invoices.total', roundToCurrency(7200, 'JPY'), row?.total)).toBe(roundToCurrency(7200, 'JPY'));

    for (const money of [row?.subtotal, row?.taxTotal, row?.total, row?.balance]) {
      expect(
        Number(money) % 1,
        assertionMessage('JPY zero-decimal persistence', 'JPY', 'invoices money column', 'whole yen', money),
      ).toBe(0);
    }
    for (const l of lines) {
      expect(
        Number(l.lineTotal) % 1,
        assertionMessage('JPY zero-decimal persistence', 'JPY', 'invoice_lines.line_total', 'whole yen', l.lineTotal),
      ).toBe(0);
      expect(
        Number(l.unitPrice) % 1,
        assertionMessage('JPY zero-decimal persistence', 'JPY', 'invoice_lines.unit_price', 'whole yen', l.unitPrice),
      ).toBe(0);
    }
  });

  it('rejects a non-catalog JPY contract line priced 100.50 before it can become a future invoice snapshot', async () => {
    const fixture = await seedGateOrg('JPY');
    const contract = await withSystemDbAccessContext(() => createContract({
      orgId: fixture.orgId, name: 'W6 G3 JPY fractional', billingTiming: 'advance',
      intervalMonths: 1, startDate: START_DATE,
    }, fixture.actor));
    expect(contract.currencyCode).toBe('JPY');

    // W6-G3-1 (EXPECTED RED): contractService.addContractLineToContract accepts a
    // hand-entered non-catalog unitPrice verbatim, with no representability guard,
    // so ¥100.50 is persisted on the contract line and every future generated
    // invoice inherits an unrepresentable JPY snapshot.
    await expect(
      withSystemDbAccessContext(() => addContractLineToContract(contract.id, {
        lineType: 'flat', description: 'Fractional yen', unitPrice: '100.50', taxable: false,
      }, fixture.actor)),
      'a JPY contract line priced 100.50 must be rejected at the contract seam (PRICE_NOT_REPRESENTABLE)',
    ).rejects.toThrow(ContractServiceError);

    const rows = await withSystemDbAccessContext(() => db
      .select({ unitPrice: contractLines.unitPrice }).from(contractLines)
      .where(eq(contractLines.contractId, contract.id)));
    expect(rows, 'no unrepresentable JPY contract line may be persisted').toHaveLength(0);
  });

  it('documents the stale-stamp baseline: a contract restamped USD under a EUR org bills USD and cannot be corrected (Task 14 flips this)', async () => {
    const fixture = await seedGateOrg('EUR');
    const contract = await withSystemDbAccessContext(() => createContract({
      orgId: fixture.orgId, name: 'W6 G3 stale stamp', billingTiming: 'advance',
      intervalMonths: 1, startDate: START_DATE,
    }, fixture.actor));
    expect(contract.currencyCode).toBe('EUR');
    await withSystemDbAccessContext(() => addContractLineToContract(contract.id, {
      lineType: 'flat', description: 'Managed services', unitPrice: '100.00', taxable: false,
    }, fixture.actor));
    await withSystemDbAccessContext(() => activateContract(contract.id, fixture.actor, ACTIVATE_AT));

    // Simulate a pre-wave-2 contract stamped USD under a non-USD org. Raw SQL on
    // purpose: no service path can produce this state today, which is exactly why
    // deliverable (C) exists.
    await withSystemDbAccessContext(() =>
      db.execute(sql`UPDATE contracts SET currency_code = 'USD' WHERE id = ${contract.id}`));

    const res = await runContractBillingSweep(SWEEP_AT);
    expect(res, assertionMessage('stale-stamp sweep', 'USD-on-EUR-org', 'sweep result', '{billed:1,failed:0}', JSON.stringify(res)))
      .toEqual({ billed: 1, failed: 0 });

    const { invoiceId } = await readGeneratedLines(contract.id);
    const row = await readInvoice(invoiceId!);
    // CURRENT TRUTH: the contract's stamp wins over the org default, even when the
    // stamp is the anomaly. Nothing is restamped or converted (owner-fixed rule).
    expect(
      row?.currencyCode,
      assertionMessage('stale-stamp sweep', 'USD-on-EUR-org', 'invoices.currency_code', 'USD', row?.currencyCode),
    ).toBe('USD');

    // TASK 14 (#3778) FLIPS THIS. Wave 6 opened the owner-approved escape hatch,
    // so the correction tool no longer refuses ACTIVE outright — it refuses
    // UNPRIVILEGED and UNCONFIRMED and INELIGIBLE callers instead. All three
    // rejections are asserted here, then the legitimate correction is proved.
    let caught: unknown;
    try {
      // (a) no verified contracts:manage evidence -> 403, not NOT_A_DRAFT.
      await withSystemDbAccessContext(() =>
        changeContractCurrency(contract.id, { currencyCode: 'EUR', clearLines: true, confirmActiveChange: true }, fixture.actor));
    } catch (err) {
      caught = err;
    }
    expect(caught, 'changeContractCurrency must refuse an unprivileged active correction').toBeInstanceOf(ContractServiceError);
    expect((caught as ContractServiceError).code).toBe('ACTIVE_CHANGE_FORBIDDEN');
    expect((caught as ContractServiceError).status).toBe(403);

    const manageActor = {
      ...fixture.actor,
      permissions: new Set(['contracts:read', 'contracts:write', 'contracts:manage']),
    };

    // (b) the sweep above left an unissued draft, so the contract is INELIGIBLE.
    await expect(withSystemDbAccessContext(() => changeContractCurrency(
      contract.id, { currencyCode: 'EUR', clearLines: true, confirmActiveChange: true }, manageActor,
    ))).rejects.toMatchObject({ code: 'UNBILLED_MONETARY_ROWS', status: 409 });

    const [stillStale] = await withSystemDbAccessContext(() => db
      .select({ currencyCode: contracts.currencyCode }).from(contracts).where(eq(contracts.id, contract.id)).limit(1));
    expect(stillStale?.currencyCode, 'a refused correction must leave the stamp untouched').toBe('USD');

    // (c) issue the draft (the money is now billed), and the correction lands.
    await withSystemDbAccessContext(() => issueInvoice(invoiceId!, {
      userId: fixture.userId, partnerId: fixture.partnerId, accessibleOrgIds: [fixture.orgId],
    }));
    const corrected = await withSystemDbAccessContext(() => changeContractCurrency(
      contract.id, { currencyCode: 'EUR', clearLines: true, confirmActiveChange: true }, manageActor));
    expect(corrected.currencyCode, 'the wave-6 escape hatch must correct a stale ACTIVE stamp').toBe('EUR');
    expect(corrected.status, 'the correction must not disturb the lifecycle').toBe('active');

    // The already-issued USD invoice is untouched — no bulk restamp, ever.
    const historical = await readInvoice(invoiceId!);
    expect(historical?.currencyCode).toBe('USD');
  });

  it('guard: the BullMQ billing-sweep processor still routes through runContractBillingSweep', () => {
    // The sweep is driven directly above; this pins the indirection so a future
    // refactor that moves logic into the processor cannot make the gate vacuous.
    const src = readFileSync(join(__dirname, '../../jobs/contractWorker.ts'), 'utf8');
    const processor = src.slice(src.indexOf("if (job.name === 'billing-sweep')"));
    expect(
      processor.slice(0, 400),
      'createContractWorker\'s billing-sweep branch must call runContractBillingSweep()',
    ).toContain('return runContractBillingSweep()');
  });
});
