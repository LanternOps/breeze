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
import { accountingConnections, accountingEntityMappings, invoicePayments, invoices } from '../../db/schema';
import { db } from '../../db';
import type { AccountingConnection } from './accountingConnectionService';
import type { ChangeSetPaymentLine } from './types';
import {
  applyAccountingPayment,
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
const REALM_FP = 'fp1:k1:realm-a';

const LINE: ChangeSetPaymentLine = {
  remoteInvoiceId: QBO_INVOICE_ID,
  remotePaymentId: QBO_PAYMENT_ID,
  amountMinor: 15000,
  currency: 'USD',
  txnDate: '2026-09-02',
  remotePaymentSyncToken: '0',
  paymentMethodName: 'Check',
  paymentRefNum: '10441',
  breezePaymentId: null,
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
    realmIdFingerprint: REALM_FP,
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
  // Phase D2 outbox columns. Modelled here because the pull now BRANCHES on
  // them: `breezeOrigin` decides whether QuickBooks or Breeze is the source of
  // truth for the row, and `pendingOp`/`claimedAt` are what an adoption must
  // close out so the push sweep stops re-enqueuing the same create.
  breezeOrigin: boolean; pendingOp: 'push' | 'delete' | null; claimedAt: Date | null;
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
/** What the connection row's realm fingerprint reads as INSIDE the transaction. */
let storedRealmFingerprint: string | null = REALM_FP;

function tableName(table: unknown): string {
  if (table === accountingConnections) return 'accounting_connections';
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
    linkStatus: 'confirmed', syncStatus: 'synced', lastError: null,
    // Invoice mappings are Breeze-origin by the Task-1 backfill.
    breezeOrigin: true, pendingOp: null, claimedAt: null, ...overrides,
  };
}

function paymentMappingRow(overrides: Partial<MappingRow> = {}): MappingRow {
  return {
    id: 'map-payment-1', integrationId: CONN_ID, partnerId: PARTNER,
    breezeEntityType: 'payment', breezeEntityId: 'pay-qbo-1',
    remoteEntityType: 'Payment', remoteEntityId: `${QBO_PAYMENT_ID}/${QBO_INVOICE_ID}`, remoteSyncToken: '0',
    linkStatus: 'confirmed', syncStatus: 'synced', lastError: null,
    // A pulled QuickBooks payment by default — the Breeze-origin suites below
    // flip this explicitly so the two directions can never be confused.
    breezeOrigin: false, pendingOp: null, claimedAt: null, ...overrides,
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
  if (table === accountingConnections) {
    return boundTo(cond, CONN_ID) && boundTo(cond, PARTNER)
      ? [{ realmIdFingerprint: storedRealmFingerprint }]
      : [];
  }
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
      // `loadPaymentMappingByBreezeId` (Phase D2 adoption) keys on
      // breeze_entity_id, which no other lookup binds — a row is still
      // identified by exactly one of the three real keys.
      const identified = boundTo(cond, r.id)
        || boundTo(cond, r.breezeEntityId)
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
            // The finding-G clear narrows its WHERE with `sync_status = 'error'`
            // AND `last_error LIKE 'Payment pull: %'`. Honour both here, or the
            // fake would "clear" a push-originated error the real SQL leaves
            // alone — a vacuously passing test.
            const whereParams = paramsOf(cond);
            const likePattern = whereParams.find(
              (v): v is string => typeof v === 'string' && v.endsWith('%'),
            );
            const requiresError = whereParams.includes('error');
            // The Phase-D2 adoption CAS narrows its WHERE with
            // `remote_entity_id IS NULL` (an unbound predicate, so it has to be
            // read off the compiled SQL). Honouring it is what makes "a landing
            // phase 2 wins the race" a real assertion instead of a vacuous one.
            const requiresNullRemoteId = /"remote_entity_id" is null/.test(compiledSql(cond));
            const matched = currentMappings.filter((r) => boundTo(cond, r.id) && boundTo(cond, r.partnerId)
              && (!requiresError || r.syncStatus === 'error')
              && (!requiresNullRemoteId || r.remoteEntityId === null)
              && (!likePattern || (r.lastError ?? '').startsWith(likePattern.slice(0, -1))));
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
  storedRealmFingerprint = REALM_FP;
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
    await expect(runCtx(() => applyAccountingPayment(conn(), LINE, runCtx, REALM_FP)))
      .rejects.toThrow(/must run with NO ambient DB access context/);
  });

  it('returns skipped_unmapped and writes nothing when the invoice was never pushed', async () => {
    currentMappings = [];

    const result = await applyAccountingPayment(conn(), LINE, runCtx, REALM_FP);

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

    const result = await applyAccountingPayment(conn(), LINE, runCtx, REALM_FP);

    expect(result.outcome).toBe('skipped_unmapped');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('locks the invoice row FOR UPDATE before reading the payment mapping, writing, or recomputing', async () => {
    await applyAccountingPayment(conn(), LINE, runCtx, REALM_FP);

    const lockIdx = indexOfStmt((s) => s.kind === 'select' && s.table === 'invoices' && s.forUpdate === true);
    expect(lockIdx).toBeGreaterThanOrEqual(0);

    // Only two statements are allowed before the lock, both read-only: the
    // realm-fingerprint guard (finding C — it must precede every write, and it
    // takes no lock) and the unlocked discovery read that resolves WHICH
    // invoice to lock (mirrors recordStripePayment).
    expect(stmts.slice(0, lockIdx)).toEqual([
      expect.objectContaining({ kind: 'select', table: 'accounting_connections' }),
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
    await applyAccountingPayment(conn(), LINE, runCtx, REALM_FP);

    const lock = stmts.find((s) => s.kind === 'select' && s.table === 'invoices' && s.forUpdate === true)!;
    expect(compiledSql(lock.where)).toMatch(/"invoices"\."id" = \$\d+ and "invoices"\."partner_id" = \$\d+/i);
    expect(paramsOf(lock.where)).toEqual([INVOICE_ID, PARTNER]);
  });

  it('applies a new payment: inserts the payment row, claims the mapping, recomputes and audits', async () => {
    const result = await applyAccountingPayment(conn(), LINE, runCtx, REALM_FP);

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
    const result = await applyAccountingPayment(conn(), { ...LINE, paymentRefNum: null }, runCtx, REALM_FP);

    expect(result.outcome).toBe('applied');
    const paymentInsert = stmts.find((s) => s.kind === 'insert' && s.table === 'invoice_payments')!;
    expect(paymentInsert.values).toMatchObject({ reference: QBO_PAYMENT_ID });
  });

  it('is a replay no-op when the mapping already carries the same sync token', async () => {
    currentPayments = [paymentRow()];
    currentMappings = [invoiceMappingRow(), paymentMappingRow({ remoteSyncToken: '0' })];

    const result = await applyAccountingPayment(conn(), LINE, runCtx, REALM_FP);

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

    const result = await applyAccountingPayment(conn(), { ...LINE, remotePaymentSyncToken: '1' }, runCtx, REALM_FP);

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
    const result = await applyAccountingPayment(conn(), { ...LINE, currency: 'EUR' }, runCtx, REALM_FP);

    expect(result).toMatchObject({ outcome: 'currency_mismatch', invoiceId: INVOICE_ID, invoicePaymentId: null });

    const mappingUpdate = stmts.find((s) => s.kind === 'update' && s.table === 'accounting_entity_mappings')!;
    expect(mappingUpdate.set).toMatchObject({
      syncStatus: 'error',
      lastError: 'Payment pull: Payment currency EUR does not match invoice currency USD. Cross-currency payments are not supported.',
    });
    // The marker must never clear the remote link or re-open the mapping.
    expect(mappingUpdate.set).not.toHaveProperty('remoteEntityId');
    expect(mappingUpdate.set).not.toHaveProperty('linkStatus');
    expect(stmts.some((s) => s.kind === 'insert')).toBe(false);
    expect(recomputeMock).not.toHaveBeenCalled();
  });

  it('refuses a payment against a voided invoice and marks the invoice mapping instead', async () => {
    currentInvoices = [invoiceRow({ status: 'void' })];

    const result = await applyAccountingPayment(conn(), LINE, runCtx, REALM_FP);

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
      lastError: 'Payment pull: Payment received in QuickBooks against a voided invoice',
    });
    expect(mappingUpdate.set).not.toHaveProperty('remoteEntityId');
  });

  it('refuses a voided invoice BEFORE consulting the payment mapping, so a replay cannot slip through', async () => {
    currentInvoices = [invoiceRow({ status: 'void' })];
    currentPayments = [paymentRow()];
    currentMappings = [invoiceMappingRow(), paymentMappingRow({ remoteSyncToken: '0' })];

    const result = await applyAccountingPayment(conn(), LINE, runCtx, REALM_FP);

    expect(result.outcome).toBe('invoice_void');
    expect(stmts.some((s) => s.kind === 'update' && s.table === 'invoice_payments')).toBe(false);
  });

  it('throws rather than reporting applied when the payment insert returns no row', async () => {
    paymentInsertReturnsZeroRows = true;

    await expect(applyAccountingPayment(conn(), LINE, runCtx, REALM_FP))
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

    const result = await applyAccountingPayment(conn(), LINE, runCtx, REALM_FP);

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

    await expect(applyAccountingPayment(conn(), LINE, runCtx, REALM_FP))
      .rejects.toThrow(/claimed .*180\/145.* but no mapping row remains/i);
    expect(writeAuditEventMock).not.toHaveBeenCalled();
  });

  it('uses exactly one short DB context per apply and leaves no context open', async () => {
    await applyAccountingPayment(conn(), LINE, runCtx, REALM_FP);

    expect(ctx.events).toEqual(['ctx:enter', 'ctx:exit']);
    expect(ctx.depth).toBe(0);
  });
});

describe('reverseAccountingPayment', () => {
  it('refuses to run inside an ambient DB access context', async () => {
    await expect(runCtx(() => reverseAccountingPayment(conn(), QBO_PAYMENT_ID, runCtx, REALM_FP)))
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

    const results = await reverseAccountingPayment(conn(), QBO_PAYMENT_ID, runCtx, REALM_FP);

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
    const results = await reverseAccountingPayment(conn(), QBO_PAYMENT_ID, runCtx, REALM_FP);

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

    const results = await reverseAccountingPayment(conn(), QBO_PAYMENT_ID, runCtx, REALM_FP);

    expect(results).toEqual([]);
    expect(currentPayments.map((p) => p.id)).toEqual(['pay-1800']);
  });
});

describe('missing TxnDate (finding H)', () => {
  it.each([[''], ['   ']])('fails with a clear message rather than a DB error on received_at (%j)', async (txnDate) => {
    // `mapQboCdcPayment` emits `TxnDate ?? ''`. Passed through, that reached
    // Postgres as an empty `received_at` and surfaced as an opaque driver
    // error; the operator saw a stack trace, not a reason.
    await expect(applyAccountingPayment(conn(), { ...LINE, txnDate }, runCtx, REALM_FP))
      .rejects.toThrow(/no transaction date/i);

    expect(insertMock).not.toHaveBeenCalled();
    expect(currentPayments).toEqual([]);
  });

  it('still SKIPS an undated payment for an invoice Breeze never pushed', async () => {
    currentMappings = [];

    const outcome = await applyAccountingPayment(conn(), { ...LINE, txnDate: '' }, runCtx, REALM_FP);

    expect(outcome.outcome).toBe('skipped_unmapped');
  });
});

describe('payment-originated error markers (finding G)', () => {
  it('clears a PAYMENT-prefixed invoice-mapping error back to synced once a payment applies', async () => {
    currentMappings = [invoiceMappingRow({
      syncStatus: 'error',
      lastError: 'Payment pull: Payment currency EUR does not match invoice currency USD. Cross-currency payments are not supported.',
    })];

    const outcome = await applyAccountingPayment(conn(), LINE, runCtx, REALM_FP);

    expect(outcome.outcome).toBe('applied');
    expect(currentMappings.find((m) => m.breezeEntityType === 'invoice')).toMatchObject({
      syncStatus: 'synced', lastError: null,
    });
  });

  it('NEVER clears a push-originated error such as "Deleted in QuickBooks"', async () => {
    // The invoice mapping's error column is shared with the PUSH path. A pulled
    // payment says nothing about whether the invoice still exists in QuickBooks,
    // so clearing that marker would hide a real divergence from the operator.
    currentMappings = [invoiceMappingRow({ syncStatus: 'error', lastError: 'Deleted in QuickBooks' })];

    const outcome = await applyAccountingPayment(conn(), LINE, runCtx, REALM_FP);

    expect(outcome.outcome).toBe('applied');
    expect(currentMappings.find((m) => m.breezeEntityType === 'invoice')).toMatchObject({
      syncStatus: 'error', lastError: 'Deleted in QuickBooks',
    });
  });

  it('scopes the clear by the prefix in SQL, not by the row it read before the lock', async () => {
    currentMappings = [invoiceMappingRow({ syncStatus: 'error', lastError: 'Payment pull: something' })];

    await applyAccountingPayment(conn(), LINE, runCtx, REALM_FP);

    const clear = stmts.find((st) => st.kind === 'update'
      && st.table === 'accounting_entity_mappings'
      && (st.set as Record<string, unknown> | undefined)?.syncStatus === 'synced'
      && (st.set as Record<string, unknown> | undefined)?.lastError === null);
    expect(clear).toBeDefined();
    expect(paramsOf(clear!.where)).toContain('Payment pull: %');
  });

  it('an UPDATE (QuickBooks edited the payment) clears a payment-prefixed marker too', async () => {
    currentPayments = [paymentRow()];
    currentMappings = [
      invoiceMappingRow({ syncStatus: 'error', lastError: 'Payment pull: transient' }),
      paymentMappingRow({ remoteSyncToken: '0' }),
    ];

    const outcome = await applyAccountingPayment(
      conn(), { ...LINE, remotePaymentSyncToken: '1' }, runCtx, REALM_FP,
    );

    expect(outcome.outcome).toBe('updated');
    expect(currentMappings.find((m) => m.breezeEntityType === 'invoice')).toMatchObject({
      syncStatus: 'synced', lastError: null,
    });
  });

  it('markInvoiceDeletedRemotely writes its message UNPREFIXED so a payment can never clear it', async () => {
    await markInvoiceDeletedRemotely(conn(), QBO_INVOICE_ID, runCtx, REALM_FP);

    expect(currentMappings[0]).toMatchObject({ lastError: 'Deleted in QuickBooks' });
  });
});

describe('realm-change guard (finding C)', () => {
  it('applyAccountingPayment writes nothing and reports realm_changed when the realm moved', async () => {
    // A reconnect to a DIFFERENT QuickBooks company landed while this job was
    // in flight. Stamping the old realm's payment onto this connection would
    // record a stranger's money against a Breeze invoice.
    storedRealmFingerprint = 'fp1:k1:realm-b';

    const outcome = await applyAccountingPayment(conn(), LINE, runCtx, REALM_FP);

    expect(outcome.outcome).toBe('realm_changed');
    expect(insertMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(currentPayments).toEqual([]);
    expect(recomputeMock).not.toHaveBeenCalled();
    expect(writeAuditEventMock).not.toHaveBeenCalled();
  });

  it('applyAccountingPayment reports realm_changed when the connection row is gone', async () => {
    currentInvoices = [];
    const outcome = await applyAccountingPayment(
      { ...conn(), id: 'conn-vanished' } as AccountingConnection, LINE, runCtx, REALM_FP,
    );

    expect(outcome.outcome).toBe('realm_changed');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('reverseAccountingPayment destroys nothing when the realm moved', async () => {
    currentPayments = [paymentRow()];
    currentMappings = [invoiceMappingRow(), paymentMappingRow()];
    storedRealmFingerprint = 'fp1:k1:realm-b';

    const results = await reverseAccountingPayment(conn(), QBO_PAYMENT_ID, runCtx, REALM_FP);

    expect(results.map((r) => r.outcome)).toEqual(['realm_changed']);
    expect(currentPayments.map((p) => p.id)).toEqual(['pay-qbo-1']);
    expect(currentMappings).toHaveLength(2);
  });

  it('markInvoiceDeletedRemotely marks nothing when the realm moved', async () => {
    storedRealmFingerprint = 'fp1:k1:realm-b';

    await expect(markInvoiceDeletedRemotely(conn(), QBO_INVOICE_ID, runCtx, REALM_FP))
      .resolves.toBe('realm_changed');

    expect(currentMappings[0]).toMatchObject({ syncStatus: 'synced', lastError: null });
  });

  it('proceeds normally when the stored fingerprint still matches', async () => {
    const outcome = await applyAccountingPayment(conn(), LINE, runCtx, REALM_FP);
    expect(outcome.outcome).toBe('applied');
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
    await expect(runCtx(() => reverseStaleAllocations(conn(), QBO_PAYMENT_ID, ['145'], runCtx, REALM_FP)))
      .rejects.toThrow(/must run with NO ambient DB access context/);
  });

  it('reverses only the allocation QuickBooks removed, keeping the one still on the payment', async () => {
    // Finding B: the QBO Payment used to settle invoices 145 AND 146; the
    // operator edited it down to 145 only. Applying the current lines alone
    // leaves the Breeze payment row for 146 behind forever.
    splitPaymentFixture();

    const results = await reverseStaleAllocations(conn(), QBO_PAYMENT_ID, ['145'], runCtx, REALM_FP);

    expect(results.map((r) => r.outcome)).toEqual(['reversed']);
    expect(results[0]?.invoicePaymentId).toBe('pay-qbo-b');
    expect(currentPayments.map((p) => p.id)).toEqual(['pay-qbo-a']);
    expect(currentMappings.map((m) => m.id).sort()).toEqual(['map-a', 'map-invoice-1']);
    expect(recomputeMock).toHaveBeenCalledWith(SECOND_INVOICE, db);
    expect(recomputeMock).not.toHaveBeenCalledWith(INVOICE_ID, db);
  });

  it('reverses nothing when every existing allocation is still in the current line set', async () => {
    splitPaymentFixture();

    const results = await reverseStaleAllocations(conn(), QBO_PAYMENT_ID, ['145', '146'], runCtx, REALM_FP);

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

    await reverseStaleAllocations(conn(), QBO_PAYMENT_ID, ['145'], runCtx, REALM_FP);

    expect(currentPayments.map((p) => p.id).sort()).toEqual(['pay-other', 'pay-qbo-a']);
    expect(currentMappings.some((m) => m.id === 'map-other')).toBe(true);
  });
});

describe('markInvoiceDeletedRemotely', () => {
  it('flips the invoice mapping to error without touching the remote link', async () => {
    const outcome = await markInvoiceDeletedRemotely(conn(), QBO_INVOICE_ID, runCtx, REALM_FP);

    expect(outcome).toBe('marked');
    const update = stmts.find((s) => s.kind === 'update' && s.table === 'accounting_entity_mappings')!;
    expect(update.set).toMatchObject({ syncStatus: 'error', lastError: 'Deleted in QuickBooks' });
    expect(update.set).not.toHaveProperty('remoteEntityId');
    expect(update.set).not.toHaveProperty('linkStatus');
  });

  it('returns skipped_unmapped when the invoice has no mapping row', async () => {
    currentMappings = [];

    const outcome = await markInvoiceDeletedRemotely(conn(), QBO_INVOICE_ID, runCtx, REALM_FP);

    expect(outcome).toBe('skipped_unmapped');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('refuses to run inside an ambient DB access context', async () => {
    await expect(runCtx(() => markInvoiceDeletedRemotely(conn(), QBO_INVOICE_ID, runCtx, REALM_FP)))
      .rejects.toThrow(/must run with NO ambient DB access context/);
  });
});

// ---------------------------------------------------------------------------
// Phase D2 — the pull side of the payment PUSH
//
// Every suite below exists to prove ONE property mechanically: QuickBooks is
// never the source of truth for a payment Breeze created. Concretely, no
// Breeze-origin branch may write `invoice_payments` — asserted through
// `moneyWrites()` rather than by reading the fake's state, so a write that
// happened to be a no-op still fails.
// ---------------------------------------------------------------------------

const BREEZE_PAY = '0f8d1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const REMOTE_MAPPING_ID = `${QBO_PAYMENT_ID}/${QBO_INVOICE_ID}`;

/** Every statement this run issued AGAINST the money table that was not a read. */
const moneyWrites = (): Stmt[] => stmts.filter((s) => s.table === 'invoice_payments' && s.kind !== 'select');

/** The Breeze payment row a push created, sitting on the locked invoice. */
function breezePaymentRow(overrides: Partial<PaymentRow> = {}): PaymentRow {
  return paymentRow({ id: BREEZE_PAY, amount: '150.00', note: null, recordedBy: 'user-1', ...overrides });
}

/** Breeze-origin, no remote id yet, a push still owed: the create response was lost. */
function pendingPushMapping(overrides: Partial<MappingRow> = {}): MappingRow {
  return paymentMappingRow({
    breezeEntityId: BREEZE_PAY, remoteEntityId: null, remoteSyncToken: null,
    breezeOrigin: true, pendingOp: 'push', syncStatus: 'pending', claimedAt: null, ...overrides,
  });
}

/** Breeze-origin and already stamped by phase 2. */
function breezeOriginMapping(overrides: Partial<MappingRow> = {}): MappingRow {
  return paymentMappingRow({
    breezeEntityId: BREEZE_PAY, remoteEntityId: REMOTE_MAPPING_ID, remoteSyncToken: '0',
    breezeOrigin: true, pendingOp: null, syncStatus: 'synced', ...overrides,
  });
}

/** A CDC line carrying Breeze's own PrivateNote marker. */
const markedLine = (overrides: Partial<ChangeSetPaymentLine> = {}): ChangeSetPaymentLine =>
  ({ ...LINE, breezePaymentId: BREEZE_PAY, ...overrides });

describe('adoption of a Breeze-created Payment (spec decision 3)', () => {
  it('fills in the remote id and token on a pending push mapping whose create response was lost', async () => {
    currentPayments = [breezePaymentRow()];
    currentMappings = [invoiceMappingRow(), pendingPushMapping()];

    const r = await applyAccountingPayment(conn(), markedLine(), runCtx, REALM_FP);

    expect(r.outcome).toBe('adopted');
    expect(r.invoicePaymentId).toBe(BREEZE_PAY);
    expect(currentMappings[1]).toMatchObject({
      remoteEntityId: REMOTE_MAPPING_ID,
      remoteSyncToken: '0',
      linkStatus: 'confirmed',
      syncStatus: 'synced',
      // Both cleared, or the sweep re-enqueues the create forever and, past
      // QuickBooks' 24h requestid window, duplicates the Payment.
      pendingOp: null,
      claimedAt: null,
      lastError: null,
    });
    // Adoption CLAIMS the row the push already wrote: no second payment row,
    // and no rewrite of the first.
    expect(currentPayments).toHaveLength(1);
    expect(moneyWrites()).toEqual([]);
    expect(recomputeMock).not.toHaveBeenCalled();
    expect(writeAuditEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'accounting.payment.adopted',
      resourceId: INVOICE_ID,
      details: expect.objectContaining({ invoicePaymentId: BREEZE_PAY, amount: '150.00', currency: 'USD' }),
    }));
  });

  it('adopts UNDER the invoice lock, and guards the UPDATE on remote_entity_id IS NULL', async () => {
    currentPayments = [breezePaymentRow()];
    currentMappings = [invoiceMappingRow(), pendingPushMapping()];

    await applyAccountingPayment(conn(), markedLine(), runCtx, REALM_FP);

    const lockAt = indexOfStmt((s) => s.kind === 'select' && s.table === 'invoices' && s.forUpdate === true);
    const adoptAt = indexOfStmt((s) => s.kind === 'update' && s.table === 'accounting_entity_mappings');
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(adoptAt).toBeGreaterThan(lockAt);

    // A push phase 2 that landed a microsecond ago must WIN, not be overwritten.
    const adopt = stmts[adoptAt]!;
    expect(compiledSql(adopt.where)).toMatch(/"remote_entity_id" is null/);
    expect(boundTo(adopt.where, PARTNER)).toBe(true);
    expect(boundTo(adopt.where, 'map-payment-1')).toBe(true);
  });

  it('reports skipped_breeze_origin when the adoption CAS matches no row (phase 2 won the race)', async () => {
    currentPayments = [breezePaymentRow()];
    // `remoteEntityId` is re-read as non-null by the guarded UPDATE's own
    // WHERE, which is what the fake models: the row no longer qualifies.
    currentMappings = [invoiceMappingRow(), pendingPushMapping()];
    const original = updateMock.getMockImplementation()!;
    updateMock.mockImplementation((table: unknown) => {
      // Simulate the concurrent phase 2 committing between the read and the CAS.
      if (table === accountingEntityMappings) currentMappings[1]!.remoteEntityId = REMOTE_MAPPING_ID;
      return original(table);
    });

    const r = await applyAccountingPayment(conn(), markedLine(), runCtx, REALM_FP);

    expect(r.outcome).toBe('skipped_breeze_origin');
  });

  it('refuses to adopt when the amounts disagree — the push job owns that outcome', async () => {
    currentPayments = [breezePaymentRow({ amount: '40.00' })];
    currentMappings = [invoiceMappingRow(), pendingPushMapping()];

    const r = await applyAccountingPayment(conn(), markedLine(), runCtx, REALM_FP);

    expect(r.outcome).toBe('skipped_breeze_origin');
    expect(currentMappings[1]!.remoteEntityId).toBeNull();
    expect(moneyWrites()).toEqual([]);
  });

  it('refuses to adopt when the marker names a payment on a DIFFERENT invoice', async () => {
    // A split QuickBooks Payment carries the SAME PrivateNote on every line, so
    // the marker alone never authorises a claim.
    currentInvoices = [invoiceRow(), invoiceRow({ id: 'invoice-other' })];
    currentPayments = [breezePaymentRow({ invoiceId: 'invoice-other' })];
    currentMappings = [invoiceMappingRow(), pendingPushMapping()];

    await expect(applyAccountingPayment(conn(), markedLine(), runCtx, REALM_FP))
      .resolves.toMatchObject({ outcome: 'skipped_breeze_origin' });
    expect(currentMappings[1]!.remoteEntityId).toBeNull();
  });

  it('refuses to adopt a marker naming a payment Breeze does not own — no row is inserted', async () => {
    currentMappings = [invoiceMappingRow()];

    const r = await applyAccountingPayment(conn(), markedLine(), runCtx, REALM_FP);

    expect(r.outcome).toBe('skipped_breeze_origin');
    expect(currentPayments).toHaveLength(0);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('refuses to adopt a QuickBooks-ORIGIN mapping even when the note carries a marker', async () => {
    currentPayments = [breezePaymentRow()];
    currentMappings = [invoiceMappingRow(), pendingPushMapping({ breezeOrigin: false })];

    await expect(applyAccountingPayment(conn(), markedLine(), runCtx, REALM_FP))
      .resolves.toMatchObject({ outcome: 'skipped_breeze_origin' });
  });

  it('refuses to adopt a mapping that owes nothing — nothing authorises the claim', async () => {
    currentPayments = [breezePaymentRow()];
    currentMappings = [invoiceMappingRow(), pendingPushMapping({ pendingOp: null, syncStatus: 'error' })];

    await expect(applyAccountingPayment(conn(), markedLine(), runCtx, REALM_FP))
      .resolves.toMatchObject({ outcome: 'skipped_breeze_origin' });
  });

  it('adopts a mapping that already owes a DELETE without cancelling the delete', async () => {
    // A void landed while the create was in flight: `requestPaymentDelete`
    // destroyed the invoice_payments row and flipped `pending_op` to 'delete'.
    // The delete worker parks on `awaiting_remote_ref` until the remote id
    // lands, so the adoption must stamp it and KEEP the delete owed.
    currentPayments = [];
    currentMappings = [invoiceMappingRow(), pendingPushMapping({
      pendingOp: 'delete', claimedAt: new Date('2026-09-02T19:00:00.000Z'),
    })];

    const r = await applyAccountingPayment(conn(), markedLine(), runCtx, REALM_FP);

    expect(r.outcome).toBe('adopted');
    expect(currentMappings[1]).toMatchObject({
      remoteEntityId: REMOTE_MAPPING_ID,
      remoteSyncToken: '0',
      linkStatus: 'confirmed',
      // Still owed, and the lease released so the delete worker can claim it.
      pendingOp: 'delete',
      syncStatus: 'pending',
      claimedAt: null,
    });
    expect(moneyWrites()).toEqual([]);
  });

  it('refuses to adopt a push-pending mapping whose payment row has vanished', async () => {
    currentPayments = [];
    currentMappings = [invoiceMappingRow(), pendingPushMapping()];

    await expect(applyAccountingPayment(conn(), markedLine(), runCtx, REALM_FP))
      .resolves.toMatchObject({ outcome: 'skipped_breeze_origin' });
  });

  it('reports a divergence when QuickBooks MOVED a Breeze payment to another invoice', async () => {
    currentPayments = [breezePaymentRow()];
    currentMappings = [invoiceMappingRow(), breezeOriginMapping({ remoteEntityId: `${QBO_PAYMENT_ID}/999` })];

    const r = await applyAccountingPayment(conn(), markedLine(), runCtx, REALM_FP);

    expect(r.outcome).toBe('breeze_origin_diverged');
    expect(currentMappings[1]).toMatchObject({
      syncStatus: 'error',
      lastError: 'Edited in QuickBooks; Breeze remains the source of truth for this payment',
      // The link SURVIVES the divergence so a human can compare the two records.
      remoteEntityId: `${QBO_PAYMENT_ID}/999`,
    });
    expect(moneyWrites()).toEqual([]);
    expect(writeAuditEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'accounting.payment.diverged',
      details: expect.objectContaining({ reason: 'allocation_moved' }),
    }));
  });
});

describe('the echo of a Breeze-origin payment (spec decision 5)', () => {
  it('replays an identical token without touching the money row', async () => {
    currentPayments = [breezePaymentRow()];
    currentMappings = [invoiceMappingRow(), breezeOriginMapping()];

    const r = await applyAccountingPayment(conn(), { ...LINE, remotePaymentSyncToken: '0' }, runCtx, REALM_FP);

    expect(r.outcome).toBe('replayed');
    expect(recomputeMock).not.toHaveBeenCalled();
    expect(moneyWrites()).toEqual([]);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('stores a NEWER token and stays clean when the amount is unchanged', async () => {
    currentPayments = [breezePaymentRow()];
    currentMappings = [invoiceMappingRow(), breezeOriginMapping()];

    const r = await applyAccountingPayment(conn(), { ...LINE, remotePaymentSyncToken: '3' }, runCtx, REALM_FP);

    expect(r.outcome).toBe('replayed');
    // Stored anyway so a later corrective delete has the right SyncToken.
    expect(currentMappings[1]).toMatchObject({ remoteSyncToken: '3', syncStatus: 'synced', lastError: null });
    expect(currentPayments[0]!.amount).toBe('150.00');
    expect(moneyWrites()).toEqual([]);
    expect(recomputeMock).not.toHaveBeenCalled();
  });

  it('records a divergence — and STILL stores the token — when QuickBooks changed the amount', async () => {
    currentPayments = [breezePaymentRow()];
    currentMappings = [invoiceMappingRow(), breezeOriginMapping()];

    const r = await applyAccountingPayment(
      conn(), { ...LINE, remotePaymentSyncToken: '3', amountMinor: 4000 }, runCtx, REALM_FP,
    );

    expect(r.outcome).toBe('breeze_origin_diverged');
    expect(currentMappings[1]).toMatchObject({
      remoteSyncToken: '3',
      syncStatus: 'error',
      lastError: 'Edited in QuickBooks; Breeze remains the source of truth for this payment',
    });
    // Breeze is the system of record: the money row is NOT rewritten.
    expect(currentPayments[0]!.amount).toBe('150.00');
    expect(moneyWrites()).toEqual([]);
    expect(recomputeMock).not.toHaveBeenCalled();
    expect(writeAuditEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'accounting.payment.diverged',
      details: expect.objectContaining({ reason: 'amount_changed', remoteAmountMinor: 4000 }),
    }));
  });

  it('leaves a pending DELETE owed while recording the divergence', async () => {
    // The divergence marker is an annotation for a human. Clearing `pending_op`
    // here would abandon a delete the row still owes QuickBooks and strand the
    // Payment in the books forever.
    currentPayments = [];
    currentMappings = [invoiceMappingRow(), breezeOriginMapping({
      pendingOp: 'delete', syncStatus: 'pending', claimedAt: new Date('2026-09-02T19:00:00.000Z'),
    })];

    const r = await applyAccountingPayment(conn(), { ...LINE, remotePaymentSyncToken: '3' }, runCtx, REALM_FP);

    expect(r.outcome).toBe('breeze_origin_diverged');
    expect(currentMappings[1]).toMatchObject({
      pendingOp: 'delete',
      claimedAt: new Date('2026-09-02T19:00:00.000Z'),
      remoteSyncToken: '3',
      syncStatus: 'error',
    });
  });

  it('never routes a Breeze-origin echo through the QuickBooks-origin update path', async () => {
    currentPayments = [breezePaymentRow()];
    currentMappings = [invoiceMappingRow(), breezeOriginMapping()];

    await applyAccountingPayment(conn(), { ...LINE, remotePaymentSyncToken: '3', paymentRefNum: 'CHANGED' }, runCtx, REALM_FP);

    expect(currentPayments[0]).toMatchObject({ reference: '10441', method: 'check', receivedAt: '2026-09-02' });
  });
});

describe('pull disabled (spec decision 6, #4543)', () => {
  it('suppresses a NEW QuickBooks-origin import and says so, without logging per item', async () => {
    currentMappings = [invoiceMappingRow()];
    // A window against a pull-off connection is ALL skips, every 15 minutes.
    // The reason reaches the operator as the run line's `skippedPullDisabled=<n>`
    // (#4543), never as one console line per payment.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const r = await applyAccountingPayment(conn({ pullPayments: false }), LINE, runCtx, REALM_FP);

      expect(r.outcome).toBe('skipped_pull_disabled');
      expect(r.invoiceId).toBe(INVOICE_ID);
      expect(currentPayments).toHaveLength(0);
      expect(insertMock).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('still ADOPTS a Breeze-created Payment with pull off — push and pull are separate switches', async () => {
    currentPayments = [breezePaymentRow()];
    currentMappings = [invoiceMappingRow(), pendingPushMapping()];

    await expect(applyAccountingPayment(conn({ pullPayments: false }), markedLine(), runCtx, REALM_FP))
      .resolves.toMatchObject({ outcome: 'adopted' });
  });

  it('still REPLAYS a Breeze-origin echo with pull off', async () => {
    currentPayments = [breezePaymentRow()];
    currentMappings = [invoiceMappingRow(), breezeOriginMapping()];

    await expect(applyAccountingPayment(conn({ pullPayments: false }), LINE, runCtx, REALM_FP))
      .resolves.toMatchObject({ outcome: 'replayed' });
  });

  it('still UPDATES an already-imported QuickBooks-origin payment with pull off', async () => {
    // Only NEW imports are suppressed: a mapping that exists is this
    // connection's own history, and freezing it would let Breeze drift.
    currentPayments = [paymentRow()];
    currentMappings = [invoiceMappingRow(), paymentMappingRow({ remoteSyncToken: '0' })];

    await expect(applyAccountingPayment(
      conn({ pullPayments: false }), { ...LINE, remotePaymentSyncToken: '9' }, runCtx, REALM_FP,
    )).resolves.toMatchObject({ outcome: 'updated' });
  });
});

describe('a Breeze-origin Payment deleted in QuickBooks (spec decision 5)', () => {
  it('KEEPS the Breeze payment row, clears the remote id and marks the mapping', async () => {
    // The money moved (a Stripe charge, a cheque). Deleting the Breeze row
    // because somebody removed the QuickBooks mirror would destroy the record
    // of a real payment.
    currentPayments = [breezePaymentRow()];
    currentMappings = [invoiceMappingRow(), breezeOriginMapping()];

    const results = await reverseAccountingPayment(conn(), QBO_PAYMENT_ID, runCtx, REALM_FP);

    expect(results.map((r) => r.outcome)).toEqual(['breeze_origin_removed_remotely']);
    expect(results[0]!.invoicePaymentId).toBe(BREEZE_PAY);
    expect(currentPayments).toHaveLength(1);
    expect(currentMappings[1]).toMatchObject({
      syncStatus: 'error',
      lastError: 'Deleted in QuickBooks',
      // Cleared so a later push can recreate the Payment.
      remoteEntityId: null,
      remoteSyncToken: null,
    });
    expect(moneyWrites()).toEqual([]);
    expect(recomputeMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('leaves pending_op alone so work the row still owes QuickBooks survives', async () => {
    currentPayments = [breezePaymentRow()];
    currentMappings = [invoiceMappingRow(), breezeOriginMapping({ pendingOp: 'delete', claimedAt: null })];

    await reverseAccountingPayment(conn(), QBO_PAYMENT_ID, runCtx, REALM_FP);

    expect(currentMappings[1]!.pendingOp).toBe('delete');
  });

  it('treats a dropped allocation on a Breeze-origin payment as divergence, not reversal', async () => {
    currentPayments = [breezePaymentRow()];
    currentMappings = [invoiceMappingRow(), breezeOriginMapping()];

    const results = await reverseStaleAllocations(conn(), QBO_PAYMENT_ID, ['999'], runCtx, REALM_FP);

    expect(results.map((r) => r.outcome)).toEqual(['breeze_origin_removed_remotely']);
    expect(currentPayments).toHaveLength(1);
    expect(currentMappings).toHaveLength(2);
  });

  it('still DESTROYS a QuickBooks-origin payment row (Phase D behaviour, unchanged)', async () => {
    currentPayments = [paymentRow()];
    currentMappings = [invoiceMappingRow(), paymentMappingRow()];

    const results = await reverseAccountingPayment(conn(), QBO_PAYMENT_ID, runCtx, REALM_FP);

    expect(results.map((r) => r.outcome)).toEqual(['reversed']);
    expect(currentPayments).toHaveLength(0);
    expect(currentMappings).toHaveLength(1);
  });
});

describe('markInvoiceDeletedRemotely self-void guard (spec decision 11)', () => {
  it('reports invoice_void — NOT an error — when Breeze itself voided the invoice', async () => {
    // The QuickBooks void is Breeze's OWN echo: voidInvoiceInAccounting sent it.
    // Stamping "Deleted in QuickBooks" would put a scary error on the mapping
    // card for a void the operator performed in Breeze thirty seconds earlier.
    currentInvoices = [invoiceRow({ status: 'void' })];
    currentMappings = [invoiceMappingRow()];

    await expect(markInvoiceDeletedRemotely(conn(), QBO_INVOICE_ID, runCtx, REALM_FP)).resolves.toBe('invoice_void');

    expect(currentMappings[0]).toMatchObject({ syncStatus: 'synced', lastError: null });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('still marks an invoice QuickBooks deleted behind Breeze back', async () => {
    currentInvoices = [invoiceRow({ status: 'sent' })];
    currentMappings = [invoiceMappingRow()];

    await expect(markInvoiceDeletedRemotely(conn(), QBO_INVOICE_ID, runCtx, REALM_FP)).resolves.toBe('marked');

    expect(currentMappings[0]).toMatchObject({
      syncStatus: 'error', lastError: 'Deleted in QuickBooks', remoteEntityId: QBO_INVOICE_ID,
    });
  });

  it('marks the mapping when the invoice row itself is gone', async () => {
    // An erased org: there is no status to read, and the mapping is all that is
    // left. Reporting `invoice_void` here would hide a real remote deletion.
    currentInvoices = [];
    currentMappings = [invoiceMappingRow()];

    await expect(markInvoiceDeletedRemotely(conn(), QBO_INVOICE_ID, runCtx, REALM_FP)).resolves.toBe('marked');
  });
});
