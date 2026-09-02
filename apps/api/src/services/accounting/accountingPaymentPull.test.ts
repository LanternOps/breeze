import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The Phase-D QuickBooks payment applier (Task 3 —
 * .superpowers/sdd/2026-09-02-quickbooks-phase-d-payment-pullback/task-3-brief.md).
 *
 * Mocking follows the neighbouring `accountingInvoicePush.test.ts`: mock `db`,
 * `recomputeInvoiceStatus`, the audit writer and Sentry, then drive the REAL
 * applier against a small stateful fake DB. Two properties this file exists to
 * prove mechanically rather than by prose:
 *
 *  1. LOCK ORDER (accountingCurrency.ts item 4 / invoiceService.recordPayment):
 *     the invoice row is locked FOR UPDATE before any payment-mapping read,
 *     any invoice_payments write, and before the balance recompute. Every
 *     statement the applier issues is appended to `stmts` in order, so the
 *     assertion is on the real sequence, not on "a mock was called".
 *  2. WHERE-CLAUSE SHAPE: conditions are compiled with the real PgDialect
 *     (`compiledSql`/`paramsOf`), so a filter that silently disappeared —
 *     the partner scope, the `id = $1` on a DELETE — fails here instead of
 *     passing vacuously against a mock that ignores its `where` argument
 *     (memory/vacuous_drizzle_where_clause_assertions).
 *
 * The fake context runner (`runCtx`) also emulates ROLLBACK: state captured on
 * entry is restored when the callback throws. Without that, the
 * unique-violation replay case would assert against a transaction whose
 * invoice_payments insert impossibly survived.
 */
const {
  selectMock,
  insertMock,
  updateMock,
  deleteMock,
  recomputeMock,
  writeAuditEventMock,
  captureExceptionMock,
} = vi.hoisted(() => ({
  selectMock: vi.fn(),
  insertMock: vi.fn(),
  updateMock: vi.fn(),
  deleteMock: vi.fn(),
  recomputeMock: vi.fn(),
  writeAuditEventMock: vi.fn(),
  captureExceptionMock: vi.fn(),
}));

/**
 * Stands in for the real AsyncLocalStorage context stack (same shape as
 * accountingInvoicePush.test.ts). The db mock's `hasDbAccessContext` reads the
 * same depth, so the real (unmocked) `assertNoAmbientDbContext` runs its real
 * logic.
 */
const ctx = vi.hoisted(() => ({ depth: 0, events: [] as string[] }));

vi.mock('../../db', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: deleteMock },
  hasDbAccessContext: () => ctx.depth > 0,
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

vi.mock('../invoiceService', () => ({ recomputeInvoiceStatus: recomputeMock }));
vi.mock('../auditEvents', () => ({
  writeAuditEvent: writeAuditEventMock,
  requestLikeFromSnapshot: () => ({ req: { header: () => undefined } }),
}));
vi.mock('../sentry', () => ({ captureException: captureExceptionMock }));

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { accountingEntityMappings, invoicePayments, invoices } from '../../db/schema';
import { db } from '../../db';
import type { AccountingConnection } from './accountingConnectionService';
import type { ChangeSetPaymentLine } from './types';
import {
  applyAccountingPayment,
  clearPaymentMappingForInvoicePayment,
  mapQboPaymentMethod,
  markInvoiceDeletedRemotely,
  paymentMappingRemoteId,
  reverseAccountingPayment,
  reverseStaleAllocations,
} from './accountingPaymentPull';

const PARTNER = 'partner-1';
const ORG = 'org-1';
const CONN_ID = 'conn-1';
const INVOICE_ID = 'invoice-1';
const QBO_INVOICE_ID = '145';
const QBO_PAYMENT_ID = '180';

const LINE: ChangeSetPaymentLine = {
  remoteInvoiceId: QBO_INVOICE_ID,
  remotePaymentId: QBO_PAYMENT_ID,
  amountMinor: 15000,
  currency: 'USD',
  txnDate: '2026-09-02',
  remotePaymentSyncToken: '0',
  paymentMethodName: 'Check',
  paymentRefNum: '10441',
};

function conn(overrides: Partial<AccountingConnection> = {}): AccountingConnection {
  return {
    id: CONN_ID,
    partnerId: PARTNER,
    provider: 'quickbooks',
    realmId: 'realm-1',
    accessToken: null,
    refreshToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    environment: 'sandbox',
    homeCurrency: 'USD',
    multiCurrencyEnabled: false,
    defaultIncomeAccountRef: null,
    defaultTaxCodeRef: null,
    pushMode: 'auto',
    status: 'connected',
    createdAt: null,
    updatedAt: null,
    lastError: null,
    realmIdFingerprint: null,
    pullPayments: true,
    lastReconcileAt: null,
    cdcCursor: null,
    ...overrides,
  } as AccountingConnection;
}

// ---------------------------------------------------------------------------
// Compiled-SQL helpers (real PgDialect — no mock is consulted)
// ---------------------------------------------------------------------------

const dialect = new PgDialect();
/** The compiled SQL text of a builder call's `.where(...)` argument. */
const compiledSql = (whereArg: unknown): string => dialect.sqlToQuery(whereArg as SQL).sql;
/** The bound parameters of a builder call's `.where(...)` argument. */
const paramsOf = (whereArg: unknown): unknown[] => dialect.sqlToQuery(whereArg as SQL).params;
const boundTo = (whereArg: unknown, value: unknown): boolean => paramsOf(whereArg).includes(value);

// ---------------------------------------------------------------------------
// Stateful fake DB
// ---------------------------------------------------------------------------

interface InvoiceRow {
  id: string; partnerId: string; orgId: string; status: string; currencyCode: string;
  total: string; invoiceNumber: string | null;
}
interface PaymentRow {
  id: string; invoiceId: string; orgId: string; amount: string; method: string;
  reference: string | null; receivedAt: string; recordedBy: string | null; note: string | null;
}
interface MappingRow {
  id: string; integrationId: string; partnerId: string; breezeEntityType: string; breezeEntityId: string;
  remoteEntityType: string; remoteEntityId: string | null; remoteSyncToken: string | null;
  linkStatus: string; syncStatus: string; lastError: string | null;
}

type StmtKind = 'select' | 'insert' | 'update' | 'delete' | 'recompute';
interface Stmt {
  kind: StmtKind;
  table: string;
  forUpdate?: boolean;
  where?: unknown;
  values?: Record<string, unknown>;
  set?: Record<string, unknown>;
}

let currentInvoices: InvoiceRow[] = [];
let currentPayments: PaymentRow[] = [];
let currentMappings: MappingRow[] = [];
let stmts: Stmt[] = [];
let generatedIds = 0;

/** Per-table insert behaviour override for the failure cases. */
let mappingInsertViolation: string | null = null;
/** The mapping row a racing writer "committed" while our transaction aborted. */
let racerMappingRow: MappingRow | null = null;
let paymentInsertReturnsZeroRows = false;

function tableName(table: unknown): string {
  if (table === invoices) return 'invoices';
  if (table === invoicePayments) return 'invoice_payments';
  if (table === accountingEntityMappings) return 'accounting_entity_mappings';
  return 'unknown';
}

function pgUniqueViolation(constraint: string) {
  return Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
    code: '23505',
    constraint_name: constraint,
  });
}

function invoiceRow(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: INVOICE_ID, partnerId: PARTNER, orgId: ORG, status: 'sent', currencyCode: 'USD',
    total: '150.00', invoiceNumber: 'INV-0001', ...overrides,
  };
}

function invoiceMappingRow(overrides: Partial<MappingRow> = {}): MappingRow {
  return {
    id: 'map-invoice-1', integrationId: CONN_ID, partnerId: PARTNER,
    breezeEntityType: 'invoice', breezeEntityId: INVOICE_ID,
    remoteEntityType: 'Invoice', remoteEntityId: QBO_INVOICE_ID, remoteSyncToken: '3',
    linkStatus: 'confirmed', syncStatus: 'synced', lastError: null, ...overrides,
  };
}

function paymentMappingRow(overrides: Partial<MappingRow> = {}): MappingRow {
  return {
    id: 'map-payment-1', integrationId: CONN_ID, partnerId: PARTNER,
    breezeEntityType: 'payment', breezeEntityId: 'pay-qbo-1',
    remoteEntityType: 'Payment', remoteEntityId: `${QBO_PAYMENT_ID}/${QBO_INVOICE_ID}`, remoteSyncToken: '0',
    linkStatus: 'confirmed', syncStatus: 'synced', lastError: null, ...overrides,
  };
}

function paymentRow(overrides: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id: 'pay-qbo-1', invoiceId: INVOICE_ID, orgId: ORG, amount: '150.00', method: 'check',
    reference: '10441', receivedAt: '2026-09-02', recordedBy: null, note: 'Pulled from QuickBooks',
    ...overrides,
  };
}

/**
 * Rows a select over `table` with condition `cond` resolves to. Matching is by
 * the COMPILED bound parameters, so a condition that lost a filter resolves
 * differently here rather than silently returning the same rows.
 */
function selectRows(table: unknown, cond: unknown): unknown[] {
  if (!boundTo(cond, PARTNER) && table !== invoicePayments) {
    throw new Error('query issued without partner scoping — every mapping/invoice read must filter by partnerId');
  }
  if (table === invoices) {
    return currentInvoices.filter((r) => boundTo(cond, r.id) && boundTo(cond, r.partnerId));
  }
  if (table === invoicePayments) {
    return currentPayments.filter((r) => boundTo(cond, r.id));
  }
  if (table === accountingEntityMappings) {
    const params = paramsOf(cond);
    const likePattern = params.find((p): p is string => typeof p === 'string' && p.endsWith('/%'));
    if (likePattern) {
      const prefix = likePattern.slice(0, -1);
      return currentMappings.filter((r) => r.remoteEntityId?.startsWith(prefix) && boundTo(cond, r.breezeEntityType));
    }
    // `breeze_entity_type` is only filtered on by the by-remote-id lookups; the
    // by-id lookup binds just (id, partner_id), so honour the type filter only
    // when the compiled condition actually carries one.
    const filtersEntityType = params.includes('payment') || params.includes('invoice');
    return currentMappings.filter((r) => {
      const identified = boundTo(cond, r.id)
        || (r.remoteEntityId !== null && boundTo(cond, r.remoteEntityId));
      if (!identified) return false;
      return !filtersEntityType || params.includes(r.breezeEntityType);
    });
  }
  return [];
}

function installDbMocks() {
  selectMock.mockImplementation(() => ({
    from: (table: unknown) => ({
      where: (cond: unknown) => {
        const stmt: Stmt = { kind: 'select', table: tableName(table), where: cond, forUpdate: false };
        const settle = () => { stmts.push(stmt); return Promise.resolve(selectRows(table, cond)); };
        const limited = {
          for: (mode: string) => { stmt.forUpdate = mode === 'update'; return settle(); },
          then: (resolve: (v: unknown[]) => unknown) => settle().then(resolve),
        };
        return {
          limit: () => limited,
          then: (resolve: (v: unknown[]) => unknown) => settle().then(resolve),
        };
      },
    }),
  }));

  insertMock.mockImplementation((table: unknown) => ({
    values: (values: Record<string, unknown>) => ({
      returning: () => {
        stmts.push({ kind: 'insert', table: tableName(table), values });
        if (table === invoicePayments) {
          if (paymentInsertReturnsZeroRows) return Promise.resolve([]);
          const row = { id: `gen-payment-${++generatedIds}`, ...values } as unknown as PaymentRow;
          currentPayments.push(row);
          return Promise.resolve([{ id: row.id }]);
        }
        if (table === accountingEntityMappings) {
          if (mappingInsertViolation) {
            // The racer's row is "already committed" — it must survive our
            // rollback, so it is written into the enclosing context's snapshot.
            if (racerMappingRow) commitOutsideCurrentTransaction(racerMappingRow);
            return Promise.reject(pgUniqueViolation(mappingInsertViolation));
          }
          const row = { id: `gen-mapping-${++generatedIds}`, lastError: null, ...values } as unknown as MappingRow;
          currentMappings.push(row);
          return Promise.resolve([row]);
        }
        return Promise.resolve([]);
      },
    }),
  }));

  updateMock.mockImplementation((table: unknown) => ({
    set: (patch: Record<string, unknown>) => ({
      where: (cond: unknown) => ({
        returning: () => {
          stmts.push({ kind: 'update', table: tableName(table), where: cond, set: patch });
          if (table === invoicePayments) {
            const matched = currentPayments.filter((r) => boundTo(cond, r.id));
            for (const row of matched) Object.assign(row, patch);
            return Promise.resolve(matched.map((r) => ({ id: r.id })));
          }
          if (table === accountingEntityMappings) {
            const matched = currentMappings.filter((r) => boundTo(cond, r.id) && boundTo(cond, r.partnerId));
            for (const row of matched) Object.assign(row, patch);
            return Promise.resolve(matched.map((r) => ({ ...r })));
          }
          return Promise.resolve([]);
        },
      }),
    }),
  }));

  deleteMock.mockImplementation((table: unknown) => ({
    where: (cond: unknown) => ({
      returning: () => {
        stmts.push({ kind: 'delete', table: tableName(table), where: cond });
        if (table === invoicePayments) {
          const matched = currentPayments.filter((r) => boundTo(cond, r.id));
          currentPayments = currentPayments.filter((r) => !matched.includes(r));
          return Promise.resolve(matched.map((r) => ({ id: r.id })));
        }
        if (table === accountingEntityMappings) {
          const matched = currentMappings.filter((r) => boundTo(cond, r.id) || boundTo(cond, r.breezeEntityId));
          currentMappings = currentMappings.filter((r) => !matched.includes(r));
          return Promise.resolve(matched.map((r) => ({ id: r.id })));
        }
        return Promise.resolve([]);
      },
    }),
  }));

  recomputeMock.mockImplementation((invoiceId: string) => {
    stmts.push({ kind: 'recompute', table: 'invoices', values: { invoiceId } });
    return Promise.resolve();
  });
}

// ---------------------------------------------------------------------------
// Context runner with rollback emulation
// ---------------------------------------------------------------------------

interface Snapshot { invoices: InvoiceRow[]; payments: PaymentRow[]; mappings: MappingRow[] }
const snapshots: Snapshot[] = [];

/** Simulates a row another transaction committed while ours is still open. */
function commitOutsideCurrentTransaction(row: MappingRow): void {
  const snap = snapshots[snapshots.length - 1];
  if (snap) snap.mappings.push({ ...row });
}

const runCtx = async <T>(fn: () => Promise<T>): Promise<T> => {
  ctx.depth++;
  ctx.events.push('ctx:enter');
  snapshots.push({
    invoices: currentInvoices.map((r) => ({ ...r })),
    payments: currentPayments.map((r) => ({ ...r })),
    mappings: currentMappings.map((r) => ({ ...r })),
  });
  try {
    const result = await fn();
    snapshots.pop();
    return result;
  } catch (err) {
    const snap = snapshots.pop()!;
    currentInvoices = snap.invoices;
    currentPayments = snap.payments;
    currentMappings = snap.mappings;
    throw err;
  } finally {
    ctx.events.push('ctx:exit');
    ctx.depth--;
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  ctx.depth = 0;
  ctx.events.length = 0;
  snapshots.length = 0;
  stmts = [];
  generatedIds = 0;
  mappingInsertViolation = null;
  racerMappingRow = null;
  paymentInsertReturnsZeroRows = false;
  currentInvoices = [invoiceRow()];
  currentPayments = [];
  currentMappings = [invoiceMappingRow()];
  installDbMocks();
});

const indexOfStmt = (pred: (s: Stmt) => boolean): number => stmts.findIndex(pred);

// ---------------------------------------------------------------------------

describe('mapQboPaymentMethod', () => {
  it.each([
    ['Cash', 'cash'],
    ['Check', 'check'],
    ['Cheque', 'check'],
    ['Credit Card', 'card'],
    ['Visa', 'card'],
    ['MasterCard', 'card'],
    ['American Express', 'card'],
    ['Discover', 'card'],
    ['Diners Club', 'card'],
    ['Direct Debit', 'other'],
    ['Something Nobody Configured', 'other'],
  ])('maps %s to %s', (name, expected) => {
    expect(mapQboPaymentMethod(name)).toBe(expected);
  });

  it('returns other for an absent payment method name', () => {
    expect(mapQboPaymentMethod(null)).toBe('other');
  });

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    expect(mapQboPaymentMethod('  cHeQuE ')).toBe('check');
    expect(mapQboPaymentMethod('\tCREDIT CARD\n')).toBe('card');
  });

  it('never infers bank_transfer — an unrecognised name is other, not a guessed rail', () => {
    // A QBO realm can name a method anything; mis-tagging a money row's rail is
    // worse than an honest 'other'.
    expect(mapQboPaymentMethod('ACH')).toBe('other');
    expect(mapQboPaymentMethod('Wire')).toBe('other');
  });
});

describe('paymentMappingRemoteId', () => {
  it('joins the QBO payment id and the remote invoice id with a slash (decision 1)', () => {
    expect(paymentMappingRemoteId('180', '145')).toBe('180/145');
  });
});

describe('applyAccountingPayment', () => {
  it('refuses to run inside an ambient DB access context', async () => {
    await expect(runCtx(() => applyAccountingPayment(conn(), LINE, runCtx)))
      .rejects.toThrow(/must run with NO ambient DB access context/);
  });

  it('returns skipped_unmapped and writes nothing when the invoice was never pushed', async () => {
    currentMappings = [];

    const result = await applyAccountingPayment(conn(), LINE, runCtx);

    expect(result).toMatchObject({
      outcome: 'skipped_unmapped',
      remotePaymentId: QBO_PAYMENT_ID,
      remoteInvoiceId: QBO_INVOICE_ID,
      invoiceId: null,
      invoicePaymentId: null,
    });
    expect(insertMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(recomputeMock).not.toHaveBeenCalled();
  });

  it('returns skipped_unmapped when the mapped invoice row is gone (erased org)', async () => {
    currentInvoices = [];

    const result = await applyAccountingPayment(conn(), LINE, runCtx);

    expect(result.outcome).toBe('skipped_unmapped');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('locks the invoice row FOR UPDATE before reading the payment mapping, writing, or recomputing', async () => {
    await applyAccountingPayment(conn(), LINE, runCtx);

    const lockIdx = indexOfStmt((s) => s.kind === 'select' && s.table === 'invoices' && s.forUpdate === true);
    expect(lockIdx).toBeGreaterThanOrEqual(0);

    // The only statement allowed before the lock is the unlocked discovery read
    // that resolves WHICH invoice to lock (mirrors recordStripePayment).
    expect(stmts.slice(0, lockIdx)).toEqual([
      expect.objectContaining({ kind: 'select', table: 'accounting_entity_mappings' }),
    ]);

    const paymentMappingIdx = stmts.findIndex((s, i) =>
      i > lockIdx && s.kind === 'select' && s.table === 'accounting_entity_mappings');
    const paymentInsertIdx = indexOfStmt((s) => s.kind === 'insert' && s.table === 'invoice_payments');
    const recomputeIdx = indexOfStmt((s) => s.kind === 'recompute');

    expect(paymentMappingIdx).toBeGreaterThan(lockIdx);
    expect(paymentInsertIdx).toBeGreaterThan(paymentMappingIdx);
    // recomputeInvoiceStatus is what re-reads the invoice_payments sum; it must
    // happen under the lock we already hold (accountingCurrency.ts item 4b).
    expect(recomputeIdx).toBeGreaterThan(paymentInsertIdx);
  });

  it('locks the invoice by id AND partner id', async () => {
    await applyAccountingPayment(conn(), LINE, runCtx);

    const lock = stmts.find((s) => s.kind === 'select' && s.table === 'invoices' && s.forUpdate === true)!;
    expect(compiledSql(lock.where)).toMatch(/"invoices"\."id" = \$\d+ and "invoices"\."partner_id" = \$\d+/i);
    expect(paramsOf(lock.where)).toEqual([INVOICE_ID, PARTNER]);
  });

  it('applies a new payment: inserts the payment row, claims the mapping, recomputes and audits', async () => {
    const result = await applyAccountingPayment(conn(), LINE, runCtx);

    expect(result).toMatchObject({
      outcome: 'applied',
      remotePaymentId: QBO_PAYMENT_ID,
      remoteInvoiceId: QBO_INVOICE_ID,
      invoiceId: INVOICE_ID,
    });
    expect(result.invoicePaymentId).toBeTruthy();

    const paymentInsert = stmts.find((s) => s.kind === 'insert' && s.table === 'invoice_payments')!;
    expect(paymentInsert.values).toEqual({
      invoiceId: INVOICE_ID,
      orgId: ORG,
      amount: '150.00',
      method: 'check',
      reference: '10441',
      receivedAt: '2026-09-02',
      recordedBy: null,
      note: 'Pulled from QuickBooks',
    });

    const mappingInsert = stmts.find((s) => s.kind === 'insert' && s.table === 'accounting_entity_mappings')!;
    expect(mappingInsert.values).toEqual({
      integrationId: CONN_ID,
      partnerId: PARTNER,
      breezeEntityType: 'payment',
      breezeEntityId: result.invoicePaymentId,
      remoteEntityType: 'Payment',
      remoteEntityId: '180/145',
      remoteSyncToken: '0',
      linkStatus: 'confirmed',
      syncStatus: 'synced',
      lastSyncedAt: expect.any(Date),
    });

    expect(recomputeMock).toHaveBeenCalledWith(INVOICE_ID, db);
    expect(writeAuditEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG,
      action: 'accounting.payment.pulled',
      resourceType: 'invoice',
      resourceId: INVOICE_ID,
      actorType: 'system',
    }));
  });

  it('falls back to the QBO payment id as the reference when PaymentRefNum is absent', async () => {
    const result = await applyAccountingPayment(conn(), { ...LINE, paymentRefNum: null }, runCtx);

    expect(result.outcome).toBe('applied');
    const paymentInsert = stmts.find((s) => s.kind === 'insert' && s.table === 'invoice_payments')!;
    expect(paymentInsert.values).toMatchObject({ reference: QBO_PAYMENT_ID });
  });

  it('is a replay no-op when the mapping already carries the same sync token', async () => {
    currentPayments = [paymentRow()];
    currentMappings = [invoiceMappingRow(), paymentMappingRow({ remoteSyncToken: '0' })];

    const result = await applyAccountingPayment(conn(), LINE, runCtx);

    expect(result).toMatchObject({
      outcome: 'replayed',
      invoiceId: INVOICE_ID,
      invoicePaymentId: 'pay-qbo-1',
    });
    expect(stmts.some((s) => s.kind === 'insert')).toBe(false);
    expect(stmts.some((s) => s.kind === 'update')).toBe(false);
    expect(recomputeMock).not.toHaveBeenCalled();
    expect(writeAuditEventMock).not.toHaveBeenCalled();
  });

  it('updates the payment row and the mapping when QuickBooks edited the payment (newer SyncToken)', async () => {
    currentPayments = [paymentRow({ amount: '10.00', receivedAt: '2026-08-01' })];
    currentMappings = [invoiceMappingRow(), paymentMappingRow({ remoteSyncToken: '0' })];

    const result = await applyAccountingPayment(conn(), { ...LINE, remotePaymentSyncToken: '1' }, runCtx);

    expect(result).toMatchObject({ outcome: 'updated', invoiceId: INVOICE_ID, invoicePaymentId: 'pay-qbo-1' });

    const paymentUpdate = stmts.find((s) => s.kind === 'update' && s.table === 'invoice_payments')!;
    expect(paymentUpdate.set).toMatchObject({ amount: '150.00', receivedAt: '2026-09-02' });
    expect(paramsOf(paymentUpdate.where)).toContain('pay-qbo-1');

    const mappingUpdate = stmts.find((s) => s.kind === 'update' && s.table === 'accounting_entity_mappings')!;
    expect(mappingUpdate.set).toMatchObject({ remoteSyncToken: '1', syncStatus: 'synced', lastError: null });

    expect(recomputeMock).toHaveBeenCalledWith(INVOICE_ID, db);
    expect(writeAuditEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'accounting.payment.pulled',
      details: expect.objectContaining({ replacedSyncToken: '0' }),
    }));
    expect(stmts.some((s) => s.kind === 'insert')).toBe(false);
  });

  it('records a currency mismatch on the invoice mapping and writes no payment row', async () => {
    const result = await applyAccountingPayment(conn(), { ...LINE, currency: 'EUR' }, runCtx);

    expect(result).toMatchObject({ outcome: 'currency_mismatch', invoiceId: INVOICE_ID, invoicePaymentId: null });

    const mappingUpdate = stmts.find((s) => s.kind === 'update' && s.table === 'accounting_entity_mappings')!;
    expect(mappingUpdate.set).toMatchObject({
      syncStatus: 'error',
      lastError: 'Payment currency EUR does not match invoice currency USD. Cross-currency payments are not supported.',
    });
    // The marker must never clear the remote link or re-open the mapping.
    expect(mappingUpdate.set).not.toHaveProperty('remoteEntityId');
    expect(mappingUpdate.set).not.toHaveProperty('linkStatus');
    expect(stmts.some((s) => s.kind === 'insert')).toBe(false);
    expect(recomputeMock).not.toHaveBeenCalled();
  });

  it('refuses a payment against a voided invoice and marks the invoice mapping instead', async () => {
    currentInvoices = [invoiceRow({ status: 'void' })];

    const result = await applyAccountingPayment(conn(), LINE, runCtx);

    expect(result).toMatchObject({
      outcome: 'invoice_void',
      remotePaymentId: QBO_PAYMENT_ID,
      remoteInvoiceId: QBO_INVOICE_ID,
      invoiceId: INVOICE_ID,
      invoicePaymentId: null,
    });
    // No money row, and the void header's amount_paid/balance are never rewritten.
    expect(stmts.some((s) => s.kind === 'insert')).toBe(false);
    expect(recomputeMock).not.toHaveBeenCalled();
    expect(writeAuditEventMock).not.toHaveBeenCalled();

    const mappingUpdate = stmts.find((s) => s.kind === 'update' && s.table === 'accounting_entity_mappings')!;
    expect(mappingUpdate.set).toMatchObject({
      syncStatus: 'error',
      lastError: 'Payment received in QuickBooks against a voided invoice',
    });
    expect(mappingUpdate.set).not.toHaveProperty('remoteEntityId');
  });

  it('refuses a voided invoice BEFORE consulting the payment mapping, so a replay cannot slip through', async () => {
    currentInvoices = [invoiceRow({ status: 'void' })];
    currentPayments = [paymentRow()];
    currentMappings = [invoiceMappingRow(), paymentMappingRow({ remoteSyncToken: '0' })];

    const result = await applyAccountingPayment(conn(), LINE, runCtx);

    expect(result.outcome).toBe('invoice_void');
    expect(stmts.some((s) => s.kind === 'update' && s.table === 'invoice_payments')).toBe(false);
  });

  it('throws rather than reporting applied when the payment insert returns no row', async () => {
    paymentInsertReturnsZeroRows = true;

    await expect(applyAccountingPayment(conn(), LINE, runCtx))
      .rejects.toThrow(/refusing to record a QuickBooks payment/);
    expect(recomputeMock).not.toHaveBeenCalled();
    expect(writeAuditEventMock).not.toHaveBeenCalled();
  });

  it('reports replayed when a concurrent writer already claimed the remote mapping id', async () => {
    // The racing sweep/webhook committed the mapping row; our INSERT trips the
    // remote-uniq index, our whole transaction rolls back (so no orphan payment
    // row survives), and a FRESH context re-reads the winner's row.
    mappingInsertViolation = 'accounting_entity_mappings_remote_uniq';
    racerMappingRow = paymentMappingRow({ id: 'map-payment-racer', breezeEntityId: 'pay-racer', remoteSyncToken: '0' });
    // The racer's payment row is already committed; only its MAPPING lands
    // between our under-lock read and our insert, which is what trips the index.
    currentPayments = [paymentRow({ id: 'pay-racer' })];

    const result = await applyAccountingPayment(conn(), LINE, runCtx);

    expect(result).toMatchObject({ outcome: 'replayed', invoiceId: INVOICE_ID, invoicePaymentId: 'pay-racer' });
    // Our own invoice_payments insert must not have survived the rollback.
    expect(currentPayments.map((p) => p.id)).toEqual(['pay-racer']);
    expect(writeAuditEventMock).not.toHaveBeenCalled();
  });

  it('throws when the racing claim vanished before the re-read, so the item ends failed', async () => {
    // The racer won the index, then its mapping was reversed in the gap before
    // our fresh-context re-read. Reporting `replayed` here would let the worker
    // advance the CDC cursor past a payment that now exists nowhere.
    mappingInsertViolation = 'accounting_entity_mappings_remote_uniq';
    racerMappingRow = null;

    await expect(applyAccountingPayment(conn(), LINE, runCtx))
      .rejects.toThrow(/claimed .*180\/145.* but no mapping row remains/i);
    expect(writeAuditEventMock).not.toHaveBeenCalled();
  });

  it('uses exactly one short DB context per apply and leaves no context open', async () => {
    await applyAccountingPayment(conn(), LINE, runCtx);

    expect(ctx.events).toEqual(['ctx:enter', 'ctx:exit']);
    expect(ctx.depth).toBe(0);
  });
});

describe('reverseAccountingPayment', () => {
  it('refuses to run inside an ambient DB access context', async () => {
    await expect(runCtx(() => reverseAccountingPayment(conn(), QBO_PAYMENT_ID, runCtx)))
      .rejects.toThrow(/must run with NO ambient DB access context/);
  });

  it('reverses every invoice a split payment touched and leaves manual payments alone', async () => {
    const SECOND_INVOICE = 'invoice-2';
    currentInvoices = [invoiceRow(), invoiceRow({ id: SECOND_INVOICE })];
    currentPayments = [
      paymentRow({ id: 'pay-qbo-a', invoiceId: INVOICE_ID }),
      paymentRow({ id: 'pay-qbo-b', invoiceId: SECOND_INVOICE }),
      paymentRow({ id: 'pay-manual', invoiceId: INVOICE_ID, method: 'cash', recordedBy: 'user-1', note: null }),
    ];
    currentMappings = [
      invoiceMappingRow(),
      paymentMappingRow({ id: 'map-a', breezeEntityId: 'pay-qbo-a', remoteEntityId: `${QBO_PAYMENT_ID}/145` }),
      paymentMappingRow({ id: 'map-b', breezeEntityId: 'pay-qbo-b', remoteEntityId: `${QBO_PAYMENT_ID}/146` }),
    ];

    const results = await reverseAccountingPayment(conn(), QBO_PAYMENT_ID, runCtx);

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.outcome)).toEqual(['reversed', 'reversed']);
    expect(results.map((r) => r.invoicePaymentId).sort()).toEqual(['pay-qbo-a', 'pay-qbo-b']);

    const paymentDeletes = stmts.filter((s) => s.kind === 'delete' && s.table === 'invoice_payments');
    expect(paymentDeletes).toHaveLength(2);
    for (const del of paymentDeletes) {
      expect(compiledSql(del.where)).toMatch(/"invoice_payments"\."id" = \$\d+/i);
      // The manual payment on the SAME invoice must never be bound into a delete.
      expect(paramsOf(del.where)).not.toContain('pay-manual');
    }
    expect(currentPayments.map((p) => p.id)).toEqual(['pay-manual']);
    expect(currentMappings.map((m) => m.id)).toEqual(['map-invoice-1']);

    expect(recomputeMock).toHaveBeenCalledWith(INVOICE_ID, db);
    expect(recomputeMock).toHaveBeenCalledWith(SECOND_INVOICE, db);

    const reversedAudits = writeAuditEventMock.mock.calls
      .map(([, event]) => event as Record<string, unknown>)
      .filter((event) => event.action === 'accounting.payment.reversed');
    expect(reversedAudits).toHaveLength(2);
    // The destroyed row's financial snapshot must be captured pre-delete.
    expect(reversedAudits[0]).toMatchObject({
      resourceType: 'invoice',
      actorType: 'system',
      details: expect.objectContaining({ amount: '150.00', method: 'check' }),
    });
  });

  it('returns an empty list and deletes nothing when the payment was never pulled', async () => {
    const results = await reverseAccountingPayment(conn(), QBO_PAYMENT_ID, runCtx);

    expect(results).toEqual([]);
    expect(deleteMock).not.toHaveBeenCalled();
    expect(recomputeMock).not.toHaveBeenCalled();
  });

  it('matches only mapping rows for THIS payment id, never a prefix neighbour', async () => {
    currentPayments = [paymentRow({ id: 'pay-1800' })];
    currentMappings = [
      invoiceMappingRow(),
      paymentMappingRow({ id: 'map-neighbour', breezeEntityId: 'pay-1800', remoteEntityId: '1800/145' }),
    ];

    const results = await reverseAccountingPayment(conn(), QBO_PAYMENT_ID, runCtx);

    expect(results).toEqual([]);
    expect(currentPayments.map((p) => p.id)).toEqual(['pay-1800']);
  });
});

describe('reverseStaleAllocations', () => {
  const SECOND_INVOICE = 'invoice-2';

  function splitPaymentFixture(): void {
    currentInvoices = [invoiceRow(), invoiceRow({ id: SECOND_INVOICE })];
    currentPayments = [
      paymentRow({ id: 'pay-qbo-a', invoiceId: INVOICE_ID }),
      paymentRow({ id: 'pay-qbo-b', invoiceId: SECOND_INVOICE }),
    ];
    currentMappings = [
      invoiceMappingRow(),
      paymentMappingRow({ id: 'map-a', breezeEntityId: 'pay-qbo-a', remoteEntityId: `${QBO_PAYMENT_ID}/145` }),
      paymentMappingRow({ id: 'map-b', breezeEntityId: 'pay-qbo-b', remoteEntityId: `${QBO_PAYMENT_ID}/146` }),
    ];
  }

  it('refuses to run inside an ambient DB access context', async () => {
    await expect(runCtx(() => reverseStaleAllocations(conn(), QBO_PAYMENT_ID, ['145'], runCtx)))
      .rejects.toThrow(/must run with NO ambient DB access context/);
  });

  it('reverses only the allocation QuickBooks removed, keeping the one still on the payment', async () => {
    // Finding B: the QBO Payment used to settle invoices 145 AND 146; the
    // operator edited it down to 145 only. Applying the current lines alone
    // leaves the Breeze payment row for 146 behind forever.
    splitPaymentFixture();

    const results = await reverseStaleAllocations(conn(), QBO_PAYMENT_ID, ['145'], runCtx);

    expect(results.map((r) => r.outcome)).toEqual(['reversed']);
    expect(results[0]?.invoicePaymentId).toBe('pay-qbo-b');
    expect(currentPayments.map((p) => p.id)).toEqual(['pay-qbo-a']);
    expect(currentMappings.map((m) => m.id).sort()).toEqual(['map-a', 'map-invoice-1']);
    expect(recomputeMock).toHaveBeenCalledWith(SECOND_INVOICE, db);
    expect(recomputeMock).not.toHaveBeenCalledWith(INVOICE_ID, db);
  });

  it('reverses nothing when every existing allocation is still in the current line set', async () => {
    splitPaymentFixture();

    const results = await reverseStaleAllocations(conn(), QBO_PAYMENT_ID, ['145', '146'], runCtx);

    expect(results).toEqual([]);
    expect(deleteMock).not.toHaveBeenCalled();
    expect(currentPayments.map((p) => p.id).sort()).toEqual(['pay-qbo-a', 'pay-qbo-b']);
  });

  it('never touches a mapping row for a DIFFERENT QuickBooks payment id', async () => {
    splitPaymentFixture();
    currentPayments.push(paymentRow({ id: 'pay-other', invoiceId: SECOND_INVOICE }));
    currentMappings.push(paymentMappingRow({
      id: 'map-other', breezeEntityId: 'pay-other', remoteEntityId: '999/146',
    }));

    await reverseStaleAllocations(conn(), QBO_PAYMENT_ID, ['145'], runCtx);

    expect(currentPayments.map((p) => p.id).sort()).toEqual(['pay-other', 'pay-qbo-a']);
    expect(currentMappings.some((m) => m.id === 'map-other')).toBe(true);
  });
});

describe('markInvoiceDeletedRemotely', () => {
  it('flips the invoice mapping to error without touching the remote link', async () => {
    const outcome = await markInvoiceDeletedRemotely(conn(), QBO_INVOICE_ID, runCtx);

    expect(outcome).toBe('marked');
    const update = stmts.find((s) => s.kind === 'update' && s.table === 'accounting_entity_mappings')!;
    expect(update.set).toMatchObject({ syncStatus: 'error', lastError: 'Deleted in QuickBooks' });
    expect(update.set).not.toHaveProperty('remoteEntityId');
    expect(update.set).not.toHaveProperty('linkStatus');
  });

  it('returns skipped_unmapped when the invoice has no mapping row', async () => {
    currentMappings = [];

    const outcome = await markInvoiceDeletedRemotely(conn(), QBO_INVOICE_ID, runCtx);

    expect(outcome).toBe('skipped_unmapped');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('refuses to run inside an ambient DB access context', async () => {
    await expect(runCtx(() => markInvoiceDeletedRemotely(conn(), QBO_INVOICE_ID, runCtx)))
      .rejects.toThrow(/must run with NO ambient DB access context/);
  });
});

describe('clearPaymentMappingForInvoicePayment', () => {
  it('deletes the payment mapping row for one invoice_payments id inside the caller transaction', async () => {
    currentMappings = [invoiceMappingRow(), paymentMappingRow({ breezeEntityId: 'pay-qbo-1' })];

    const removed = await clearPaymentMappingForInvoicePayment(db, 'pay-qbo-1');

    expect(removed).toBe(1);
    const del = stmts.find((s) => s.kind === 'delete' && s.table === 'accounting_entity_mappings')!;
    expect(compiledSql(del.where)).toMatch(
      /"accounting_entity_mappings"\."breeze_entity_type" = \$\d+ and "accounting_entity_mappings"\."breeze_entity_id" = \$\d+/i,
    );
    expect(paramsOf(del.where)).toEqual(['payment', 'pay-qbo-1']);
    expect(currentMappings.map((m) => m.id)).toEqual(['map-invoice-1']);
  });

  it('returns 0 for a manual or Stripe payment that has no mapping row', async () => {
    currentMappings = [invoiceMappingRow()];

    await expect(clearPaymentMappingForInvoicePayment(db, 'pay-manual')).resolves.toBe(0);
  });
});
