import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The Phase-D2 QuickBooks payment PUSH coordinator (Task 3 —
 * .superpowers/sdd/2026-09-02-quickbooks-phase-d2-payment-push/task-3-brief.md;
 * spec docs/superpowers/specs/billing/2026-09-02-quickbooks-phase-d2-payment-push-design.md).
 *
 * Mocking follows the two neighbouring suites (`accountingInvoicePush.test.ts`,
 * `accountingPaymentPull.test.ts`): mock `db`, the mapping service, the provider
 * registry, the audit writer and Sentry, then drive the REAL coordinator against
 * a small stateful fake DB. Four properties this file exists to prove
 * mechanically rather than by prose:
 *
 *  1. NO DB CONTEXT IS OPEN ACROSS A QUICKBOOKS CALL. `ctx.depth` is the real
 *     AsyncLocalStorage stand-in that the unmocked `assertNoAmbientDbContext`
 *     reads, and each provider mock records the depth it was called at.
 *  2. LEASE SEMANTICS ARE REAL, not a fixture switch. The fake DB evaluates the
 *     compiled `claimed_at IS NULL OR claimed_at < $n` predicate against the
 *     row, reading the cutoff out of the compiled parameter list — so a row
 *     leased one minute ago is genuinely excluded and a row leased twenty
 *     minutes ago is genuinely re-claimable (PAYMENT_CLAIM_LEASE_MS).
 *  3. WHERE-CLAUSE SHAPE. Conditions are compiled with the real PgDialect
 *     (`compiledSql`/`paramsOf`), so a filter that silently disappeared — the
 *     partner scope, the `pending_op = 'push'` half of the CAS — changes what
 *     the fake resolves instead of passing vacuously against a mock that
 *     ignores its `where` argument (memory/vacuous_drizzle_where_clause_assertions).
 *  4. ROLLBACK IS EMULATED. `runCtx` snapshots the fixture arrays on entry and
 *     restores them when the callback throws, which is the whole reason the
 *     coordinator commits its error markers in their OWN short context.
 */
const {
  selectMock,
  insertMock,
  updateMock,
  deleteMock,
  resolveConnectionMock,
  resolveLiveConnectionMock,
  createPaymentMock,
  deletePaymentMock,
  writeAuditEventMock,
  captureExceptionMock,
  AccountingMappingError,
} = vi.hoisted(() => {
  class AccountingMappingError extends Error {
    constructor(
      public readonly code: string,
      public readonly status: 404 | 409 | 502,
      message: string,
    ) {
      super(message);
      this.name = 'AccountingMappingError';
    }
  }
  return {
    selectMock: vi.fn(),
    insertMock: vi.fn(),
    updateMock: vi.fn(),
    deleteMock: vi.fn(),
    resolveConnectionMock: vi.fn(),
    resolveLiveConnectionMock: vi.fn(),
    createPaymentMock: vi.fn(),
    deletePaymentMock: vi.fn(),
    writeAuditEventMock: vi.fn(),
    captureExceptionMock: vi.fn(),
    AccountingMappingError,
  };
});

/**
 * Stands in for the real AsyncLocalStorage context stack (same shape as
 * accountingInvoicePush.test.ts). The db mock's `hasDbAccessContext` reads the
 * same depth, so the real (unmocked) `assertNoAmbientDbContext` runs its real
 * logic.
 */
const ctx = vi.hoisted(() => ({ depth: 0 }));

vi.mock('../../db', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: deleteMock },
  hasDbAccessContext: () => ctx.depth > 0,
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('./accountingMappingService', () => ({
  resolveConnection: resolveConnectionMock,
  resolveLiveConnection: resolveLiveConnectionMock,
  AccountingMappingError,
}));
vi.mock('./providerRegistry', () => ({
  getAccountingProvider: () => ({ createPayment: createPaymentMock, deletePayment: deletePaymentMock }),
}));
vi.mock('../auditEvents', () => ({
  writeAuditEvent: writeAuditEventMock,
  requestLikeFromSnapshot: () => ({ req: { header: () => undefined } }),
}));
vi.mock('../sentry', () => ({ captureException: captureExceptionMock }));

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { accountingConnections, accountingEntityMappings, invoicePayments, invoices } from '../../db/schema';
import { db } from '../../db';
import {
  requestPaymentPush,
  requestPaymentDelete,
  pushPaymentToAccounting,
  deletePaymentInAccounting,
  fanOutOwedPayments,
  listOwedPaymentMappings,
  AccountingPaymentPushError,
  PAYMENT_CLAIM_LEASE_MS,
  PAYMENT_SWEEP_MIN_AGE_MS,
  PAYMENT_REF_MAX_LENGTH,
  PAYMENT_DELETE_UNRESOLVED_GRACE_MS,
  PAYMENT_PUSH_DISABLED_MESSAGE,
  PAYMENT_PUSH_MAX_ATTEMPTS,
  PAYMENT_NOT_CONNECTED_MESSAGE,
  notePaymentJobSkipped,
  paymentPushGaveUpMessage,
  partialRefundDivergenceMessage,
} from './accountingPaymentPush';

const PARTNER = 'p1';
const ORG = 'org-a';
const CONN_ID = 'c1';
const INVOICE = 'inv-1';
const PAYMENT = '0f8d1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const MAPPING = 'map-pay-1';

const MINUTE = 60_000;
const ago = (ms: number): Date => new Date(Date.now() - ms);

// ---------------------------------------------------------------------------
// Compiled-SQL helpers (real PgDialect — no mock is consulted)
// ---------------------------------------------------------------------------

const dialect = new PgDialect();
const compiledSql = (whereArg: unknown): string => dialect.sqlToQuery(whereArg as SQL).sql;
const paramsOf = (whereArg: unknown): unknown[] => dialect.sqlToQuery(whereArg as SQL).params;
const boundTo = (whereArg: unknown, value: unknown): boolean => paramsOf(whereArg).includes(value);

// ---------------------------------------------------------------------------
// Stateful fake DB
// ---------------------------------------------------------------------------

interface ConnRow {
  id: string; partnerId: string; provider: string; status: string;
  pushMode: string; pushPayments: boolean; homeCurrency: string | null; multiCurrencyEnabled: boolean | null;
}
interface InvRow { id: string; partnerId: string; orgId: string; status: string; currencyCode: string }
interface PayRow { id: string; invoiceId: string; orgId: string; amount: string; reference: string | null; receivedAt: string }
interface MapRow {
  id: string; integrationId: string; partnerId: string; breezeEntityType: string; breezeEntityId: string;
  remoteEntityType: string; remoteEntityId: string | null; remoteSyncToken: string | null;
  breezeOrigin: boolean; pendingOp: string | null; claimedAt: Date | null; lastSyncedAt: Date | null;
  linkStatus: string; syncStatus: string; lastError: string | null; syncAttempts: number;
  createdAt: Date; updatedAt: Date;
}

type StmtKind = 'select' | 'insert' | 'update' | 'delete';
interface Stmt {
  kind: StmtKind;
  table: string;
  where?: unknown;
  forUpdate?: boolean;
  values?: Record<string, unknown>;
  set?: Record<string, unknown>;
  depth: number;
}

let currentConns: ConnRow[] = [];
let currentInvoices: InvRow[] = [];
let currentPayments: PayRow[] = [];
let currentMappings: MapRow[] = [];
let stmts: Stmt[] = [];
let generatedIds = 0;
let snapshots: Array<{ conns: ConnRow[]; invoices: InvRow[]; payments: PayRow[]; mappings: MapRow[] }> = [];

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

/**
 * Emulates one short self-committing transaction: state written inside a
 * callback that THROWS is rolled back, which is the whole reason the
 * coordinator commits its error markers in their own context.
 */
const runCtx = async <T>(fn: () => Promise<T>): Promise<T> => {
  ctx.depth++;
  snapshots.push({
    conns: currentConns.map((r) => ({ ...r })),
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
    currentConns = snap.conns;
    currentInvoices = snap.invoices;
    currentPayments = snap.payments;
    currentMappings = snap.mappings;
    throw err;
  } finally {
    ctx.depth--;
  }
};

function connRow(o: Partial<ConnRow> = {}): ConnRow {
  return {
    id: CONN_ID, partnerId: PARTNER, provider: 'quickbooks', status: 'connected',
    pushMode: 'auto', pushPayments: true, homeCurrency: 'USD', multiCurrencyEnabled: false, ...o,
  };
}
function invRow(o: Partial<InvRow> = {}): InvRow {
  return { id: INVOICE, partnerId: PARTNER, orgId: ORG, status: 'partially_paid', currencyCode: 'USD', ...o };
}
function payRow(o: Partial<PayRow> = {}): PayRow {
  return { id: PAYMENT, invoiceId: INVOICE, orgId: ORG, amount: '107.00', reference: 'ch_123', receivedAt: '2026-09-02', ...o };
}
function mapRowBase(o: Partial<MapRow>): MapRow {
  return {
    id: 'map-x', integrationId: CONN_ID, partnerId: PARTNER, breezeEntityType: 'invoice', breezeEntityId: INVOICE,
    remoteEntityType: 'Invoice', remoteEntityId: null, remoteSyncToken: null,
    breezeOrigin: false, pendingOp: null, claimedAt: null, lastSyncedAt: null,
    linkStatus: 'confirmed', syncStatus: 'synced', lastError: null, syncAttempts: 0,
    createdAt: ago(30 * MINUTE), updatedAt: ago(5 * MINUTE), ...o,
  };
}
function invoiceMapRow(o: Partial<MapRow> = {}): MapRow {
  return mapRowBase({ id: 'map-inv-1', remoteEntityId: '145', remoteSyncToken: '2', breezeOrigin: true, ...o });
}
function orgMapRow(o: Partial<MapRow> = {}): MapRow {
  return mapRowBase({
    id: 'map-org-1', breezeEntityType: 'org', breezeEntityId: ORG,
    remoteEntityType: 'Customer', remoteEntityId: '55', remoteSyncToken: '0', ...o,
  });
}
function paymentMapRow(o: Partial<MapRow> = {}): MapRow {
  return mapRowBase({
    id: MAPPING, breezeEntityType: 'payment', breezeEntityId: PAYMENT,
    remoteEntityType: 'Payment', remoteEntityId: null, remoteSyncToken: null,
    breezeOrigin: true, pendingOp: 'push', linkStatus: 'create_new', syncStatus: 'pending', ...o,
  });
}

/** The bound Date on `"<table>"."<col>" < $n`, read out of the compiled params. */
function cutoffFor(text: string, params: unknown[], col: string): Date | null {
  const match = new RegExp(`"accounting_entity_mappings"\\."${col}" < \\$(\\d+)`).exec(text);
  if (!match) return null;
  const raw = params[Number(match[1]) - 1];
  if (raw instanceof Date) return raw;
  return typeof raw === 'string' ? new Date(raw) : null;
}

/**
 * Whether one mapping row satisfies a compiled condition. Every column the
 * condition actually REFERENCES must be satisfied by the row's value, so a
 * dropped filter changes the result set here instead of passing vacuously.
 */
function mappingMatches(row: MapRow, cond: unknown): boolean {
  const text = compiledSql(cond);
  const params = paramsOf(cond);
  const refs = (col: string): boolean => text.includes(`"accounting_entity_mappings"."${col}"`);
  // `IS NULL` is an UNBOUND predicate — it has no parameter to match on — so it
  // has to be read off the compiled SQL. Without this arm the re-own CAS's
  // `remote_entity_id IS NULL` would EXCLUDE exactly the rows it selects for
  // (`eqOn` rejects a null value), and the test would pass for the wrong reason.
  // `is not null` cannot be confused with it: the substring differs.
  const isNullOn = (col: string): boolean =>
    text.includes(`"accounting_entity_mappings"."${col}" is null`);
  const eqOn = (col: string, value: unknown): boolean => {
    if (isNullOn(col)) return value === null;
    return !refs(col) || (value !== null && params.includes(value));
  };

  if (!eqOn('id', row.id)) return false;
  if (!eqOn('partner_id', row.partnerId)) return false;
  if (!eqOn('integration_id', row.integrationId)) return false;
  if (!eqOn('breeze_entity_type', row.breezeEntityType)) return false;
  if (!eqOn('breeze_entity_id', row.breezeEntityId)) return false;
  if (!eqOn('remote_entity_id', row.remoteEntityId)) return false;
  if (!eqOn('pending_op', row.pendingOp)) return false;
  if (!eqOn('breeze_origin', row.breezeOrigin)) return false;
  if (refs('claimed_at')) {
    const cutoff = cutoffFor(text, params, 'claimed_at');
    if (!(row.claimedAt === null || (cutoff !== null && row.claimedAt < cutoff))) return false;
  }
  if (refs('updated_at')) {
    const cutoff = cutoffFor(text, params, 'updated_at');
    if (!(cutoff !== null && row.updatedAt < cutoff)) return false;
  }
  return true;
}

/** Live row references (so an UPDATE's `Object.assign` sticks). */
function matchedRows(table: unknown, cond: unknown): unknown[] {
  if (table === accountingConnections) {
    return currentConns.filter((r) => boundTo(cond, r.partnerId) && boundTo(cond, r.provider) && boundTo(cond, r.status));
  }
  if (table === invoices) {
    return currentInvoices.filter((r) => boundTo(cond, r.id) && boundTo(cond, r.partnerId));
  }
  if (table === invoicePayments) {
    return compiledSql(cond).includes('"invoice_payments"."invoice_id"')
      ? currentPayments.filter((r) => boundTo(cond, r.invoiceId))
      : currentPayments.filter((r) => boundTo(cond, r.id));
  }
  if (table === accountingEntityMappings) {
    return currentMappings.filter((r) => mappingMatches(r, cond));
  }
  return [];
}

/**
 * Applies an UPDATE's `set` to a row, evaluating a `sql` expression rather than
 * storing the SQL object. Only the one shape the coordinator uses is understood
 * — `<column> + 1` — and anything else `sql`-shaped is a hard failure, so a new
 * expression cannot silently write a `SQL` object into a fixture and read as a
 * pass. The expression is COMPILED with the real dialect, so a counter aimed at
 * the wrong column would not match here either.
 */
function applyPatch(row: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (!isSqlExpression(value)) {
      row[key] = value;
      continue;
    }
    const text = compiledSql(value);
    const match = /^"accounting_entity_mappings"\."([a-z_]+)" \+ 1$/.exec(text);
    if (!match) throw new Error(`fake DB: unsupported sql expression in an UPDATE set: ${text}`);
    const column = match[1]!;
    const field = column.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
    if (typeof row[field] !== 'number') {
      throw new Error(`fake DB: sql increment targets "${column}", which the fixture row does not carry as a number`);
    }
    row[key] = (row[field] as number) + 1;
  }
}

function isSqlExpression(value: unknown): boolean {
  return !!value && typeof value === 'object' && 'queryChunks' in (value as object);
}

/** Applies a drizzle projection object ({ outKey: column }) by field name. */
function project(rows: unknown[], projection?: Record<string, unknown>): unknown[] {
  if (!projection) return rows.map((r) => ({ ...(r as object) }));
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(projection)) {
      if (!(key in (row as object))) {
        throw new Error(`fake DB: projected select asked for "${key}", which the fixture row does not carry`);
      }
      out[key] = (row as Record<string, unknown>)[key];
    }
    return out;
  });
}

function installDbMocks(): void {
  selectMock.mockImplementation((projection?: Record<string, unknown>) => ({
    from: (table: unknown) => ({
      where: (cond: unknown) => {
        const stmt: Stmt = { kind: 'select', table: tableName(table), where: cond, forUpdate: false, depth: ctx.depth };
        const settle = (): Promise<unknown[]> => {
          stmts.push(stmt);
          return Promise.resolve(project(matchedRows(table, cond), projection));
        };
        const limited = {
          for: (mode: string) => {
            stmt.forUpdate = mode === 'update';
            return settle().then((rows) => rows.slice(0, 1));
          },
          then: (res: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) =>
            settle().then((rows) => rows.slice(0, 1)).then(res, rej),
        };
        return {
          limit: () => limited,
          then: (res: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) => settle().then(res, rej),
        };
      },
    }),
  }));

  insertMock.mockImplementation((table: unknown) => ({
    values: (values: Record<string, unknown>) => {
      const finish = (conflictAware: boolean) => (projection?: Record<string, unknown>) => {
        stmts.push({ kind: 'insert', table: tableName(table), values, depth: ctx.depth });
        // The (integration_id, breeze_entity_type, breeze_entity_id) unique index.
        const clash = currentMappings.some((m) => m.integrationId === values.integrationId
          && m.breezeEntityType === values.breezeEntityType
          && m.breezeEntityId === values.breezeEntityId);
        if (clash) {
          return conflictAware
            ? Promise.resolve([])
            : Promise.reject(pgUniqueViolation('accounting_entity_mappings_breeze_uniq'));
        }
        const row = mapRowBase({ id: `map-new-${++generatedIds}`, updatedAt: new Date(), ...values } as Partial<MapRow>);
        currentMappings.push(row);
        return Promise.resolve(project([row], projection));
      };
      return { onConflictDoNothing: () => ({ returning: finish(true) }), returning: finish(false) };
    },
  }));

  updateMock.mockImplementation((table: unknown) => ({
    set: (patch: Record<string, unknown>) => ({
      where: (cond: unknown) => ({
        returning: (projection?: Record<string, unknown>) => {
          stmts.push({ kind: 'update', table: tableName(table), where: cond, set: patch, depth: ctx.depth });
          const matched = matchedRows(table, cond);
          for (const row of matched) applyPatch(row as Record<string, unknown>, patch);
          return Promise.resolve(project(matched, projection));
        },
      }),
    }),
  }));

  deleteMock.mockImplementation((table: unknown) => ({
    where: (cond: unknown) => ({
      returning: (projection?: Record<string, unknown>) => {
        stmts.push({ kind: 'delete', table: tableName(table), where: cond, depth: ctx.depth });
        const matched = matchedRows(table, cond);
        const removed = project(matched, projection);
        if (table === accountingEntityMappings) currentMappings = currentMappings.filter((r) => !matched.includes(r));
        if (table === invoicePayments) currentPayments = currentPayments.filter((r) => !matched.includes(r));
        return Promise.resolve(removed);
      },
    }),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  ctx.depth = 0;
  stmts = [];
  snapshots = [];
  generatedIds = 0;
  currentConns = [connRow()];
  currentInvoices = [invRow()];
  currentPayments = [payRow()];
  currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow()];

  resolveConnectionMock.mockImplementation(async () => ({ ...currentConns[0], provider: 'quickbooks' }));
  resolveLiveConnectionMock.mockImplementation(async (c: unknown) => ({ ...(c as object), accessToken: 'fresh' }));
  createPaymentMock.mockResolvedValue({ id: '181', syncToken: '0' });
  deletePaymentMock.mockResolvedValue('deleted');
  installDbMocks();
});

const mapping = (): MapRow | null => currentMappings.find((m) => m.breezeEntityType === 'payment') ?? null;
const stmtsOf = (kind: StmtKind, table: string): Stmt[] => stmts.filter((s) => s.kind === kind && s.table === table);
const lastUpdate = (): Stmt => stmtsOf('update', 'accounting_entity_mappings').at(-1)!;

// ---------------------------------------------------------------------------

describe('constants (spec decisions 2, 3)', () => {
  it('pins the lease window, sweep grace window and QuickBooks PaymentRefNum cap', () => {
    expect(PAYMENT_CLAIM_LEASE_MS).toBe(10 * 60 * 1000);
    expect(PAYMENT_SWEEP_MIN_AGE_MS).toBe(2 * 60 * 1000);
    expect(PAYMENT_REF_MAX_LENGTH).toBe(21);
    expect(PAYMENT_DELETE_UNRESOLVED_GRACE_MS).toBe(24 * 60 * 60 * 1000);
    // The argument is the CUMULATIVE total refunded so far, and the wording says
    // so: an earlier text quoted a bare amount ("Partially refunded in Stripe
    // (67.00)") that a bookkeeper who had already entered the first refund read
    // as a SECOND, fresh amount to enter.
    expect(partialRefundDivergenceMessage('67.00'))
      .toBe('Refunded in Stripe, total 67.00; record the refund in QuickBooks (this QuickBooks payment still shows the full amount)');
  });
});

describe('requestPaymentPush gating (spec decision 10)', () => {
  const request = () => requestPaymentPush(db, { invoicePaymentId: PAYMENT, invoiceId: INVOICE, partnerId: PARTNER });

  it('inserts a pending Breeze-origin push mapping and returns its id', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow()];

    const id = await runCtx(request);

    expect(id).toBeTruthy();
    const insert = stmtsOf('insert', 'accounting_entity_mappings')[0]!;
    expect(insert.values).toMatchObject({
      integrationId: CONN_ID,
      partnerId: PARTNER,
      breezeEntityType: 'payment',
      breezeEntityId: PAYMENT,
      remoteEntityType: 'Payment',
      breezeOrigin: true,
      linkStatus: 'create_new',
      syncStatus: 'pending',
      pendingOp: 'push',
    });
    expect(insert.values!.remoteEntityId ?? null).toBeNull();
    expect(mapping()).toMatchObject({ id, pendingOp: 'push', breezeOrigin: true });
  });

  it('reads the connection partner-scoped, connected and provider-filtered', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow()];
    await runCtx(request);

    const connSelect = stmtsOf('select', 'accounting_connections')[0]!;
    expect(compiledSql(connSelect.where)).toMatch(
      /"accounting_connections"\."partner_id" = \$\d+ and "accounting_connections"\."provider" = \$\d+ and "accounting_connections"\."status" = \$\d+/i,
    );
    expect(paramsOf(connSelect.where)).toEqual([PARTNER, 'quickbooks', 'connected']);
  });

  it('returns null when push_payments is off — no row, nothing to enqueue', async () => {
    currentConns = [connRow({ pushPayments: false })];
    currentMappings = [invoiceMapRow(), orgMapRow()];

    await expect(runCtx(request)).resolves.toBeNull();
    expect(stmtsOf('insert', 'accounting_entity_mappings')).toHaveLength(0);
  });

  it('returns null in manual push mode — the invoice push fan-out covers it', async () => {
    currentConns = [connRow({ pushMode: 'manual' })];
    currentMappings = [invoiceMapRow(), orgMapRow()];

    await expect(runCtx(request)).resolves.toBeNull();
    expect(stmtsOf('insert', 'accounting_entity_mappings')).toHaveLength(0);
  });

  it('returns null when there is no connected QuickBooks connection at all', async () => {
    currentConns = [];
    currentMappings = [invoiceMapRow(), orgMapRow()];

    await expect(runCtx(request)).resolves.toBeNull();
  });

  it('returns null when the invoice has no synced remote id yet', async () => {
    currentMappings = [invoiceMapRow({ remoteEntityId: null, syncStatus: 'pending' }), orgMapRow()];

    await expect(runCtx(request)).resolves.toBeNull();
  });

  it('returns null when the invoice mapping is in error', async () => {
    currentMappings = [invoiceMapRow({ syncStatus: 'error' }), orgMapRow()];

    await expect(runCtx(request)).resolves.toBeNull();
  });

  it('accepts an invoice mapping that synced with a tax variance', async () => {
    currentMappings = [invoiceMapRow({ syncStatus: 'synced_with_tax_variance' }), orgMapRow()];

    await expect(runCtx(request)).resolves.toBeTruthy();
  });

  it('returns null (never throws) when a racer already claimed the payment mapping', async () => {
    // currentMappings still holds the payment row from beforeEach, so the insert
    // conflicts. A THROW here would abort the caller's payment transaction and
    // undo a payment the operator already recorded.
    await expect(runCtx(request)).resolves.toBeNull();
    expect(currentMappings.filter((m) => m.breezeEntityType === 'payment')).toHaveLength(1);
  });
});

describe('requestPaymentDelete (the destroyer-side helper)', () => {
  it('flips a synced Breeze-origin mapping to pending_op=delete and KEEPS the row', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({
      remoteEntityId: '181/145', remoteSyncToken: '0', pendingOp: null,
      syncStatus: 'synced', linkStatus: 'confirmed', claimedAt: null,
    })];

    await expect(runCtx(() => requestPaymentDelete(db, PAYMENT))).resolves.toBe(MAPPING);

    expect(mapping()).toMatchObject({
      pendingOp: 'delete', syncStatus: 'pending', claimedAt: null, remoteEntityId: '181/145',
    });
    expect(stmtsOf('delete', 'accounting_entity_mappings')).toHaveLength(0);
    const update = lastUpdate();
    expect(compiledSql(update.where)).toMatch(
      /"accounting_entity_mappings"\."id" = \$\d+ and "accounting_entity_mappings"\."partner_id" = \$\d+/i,
    );
    expect(paramsOf(update.where)).toEqual([MAPPING, PARTNER]);
  });

  it('looks the mapping up by (breeze_entity_type, breeze_entity_id)', async () => {
    await runCtx(() => requestPaymentDelete(db, PAYMENT));

    const lookup = stmtsOf('select', 'accounting_entity_mappings')[0]!;
    expect(compiledSql(lookup.where)).toMatch(
      /"accounting_entity_mappings"\."breeze_entity_type" = \$\d+ and "accounting_entity_mappings"\."breeze_entity_id" = \$\d+/i,
    );
    expect(paramsOf(lookup.where)).toEqual(['payment', PAYMENT]);
  });

  it('KEEPS a still-pending push mapping with no remote id and flips it to delete', async () => {
    // Deleting it would orphan a QuickBooks Payment whose create is in flight
    // right now: phase 2 would find no row to stamp, and the partner-guard
    // trigger forbids re-inserting one once invoice_payments is gone.
    await expect(runCtx(() => requestPaymentDelete(db, PAYMENT))).resolves.toBe(MAPPING);
    expect(mapping()).toMatchObject({ pendingOp: 'delete', syncStatus: 'pending', remoteEntityId: null });
    expect(stmtsOf('delete', 'accounting_entity_mappings')).toHaveLength(0);
  });

  it('leaves a LIVE lease alone when flipping mid-flight', async () => {
    // A live claim means a worker sits between phase 1 and its QuickBooks call.
    // Clearing it would let a second worker start a SECOND create.
    const lease = ago(MINUTE);
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({ claimedAt: lease })];

    await expect(runCtx(() => requestPaymentDelete(db, PAYMENT))).resolves.toBe(MAPPING);

    expect(mapping()).toMatchObject({ pendingOp: 'delete', claimedAt: lease });
    expect(lastUpdate().set).not.toHaveProperty('claimedAt');
  });

  it('never touches a column the entity_partner_guard trigger watches', async () => {
    // The trigger fires on UPDATE OF (partner_id, breeze_entity_type,
    // breeze_entity_id) and requires a live invoice_payments row — which the
    // caller is about to delete in this very transaction.
    await runCtx(() => requestPaymentDelete(db, PAYMENT));

    const patch = lastUpdate().set!;
    expect(Object.keys(patch).sort()).toEqual(['lastError', 'pendingOp', 'syncStatus', 'updatedAt']);
  });

  it('DELETES a STRANDED Breeze-origin mapping — no remote id and nothing owed (finding C2)', async () => {
    // The shape `breeze_origin_removed_remotely`, `push_disabled` and every
    // pre-call terminal refusal leave behind. There is nothing for QuickBooks to
    // delete and no create in flight (an in-flight create still owes a `push`),
    // so flipping it to `delete` would park the delete worker on
    // `awaiting_remote_ref` for 24 h and then raise a false orphan alarm.
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({
      remoteEntityId: null, remoteSyncToken: null, pendingOp: null, syncStatus: 'error',
      lastError: 'Deleted in QuickBooks',
    })];

    await expect(runCtx(() => requestPaymentDelete(db, PAYMENT))).resolves.toBeNull();

    expect(mapping()).toBeNull();
    expect(stmtsOf('update', 'accounting_entity_mappings')).toHaveLength(0);
    // Partner-scoped, like every other write in this module.
    const removal = stmtsOf('delete', 'accounting_entity_mappings')[0]!;
    expect(boundTo(removal.where, PARTNER)).toBe(true);
    expect(compiledSql(removal.where)).toContain('"accounting_entity_mappings"."partner_id"');
  });

  it('still KEEPS a stranded-looking row that carries a remote id — QuickBooks has that Payment', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({
      remoteEntityId: '181/145', pendingOp: null, syncStatus: 'error',
      lastError: 'Edited in QuickBooks; Breeze remains the source of truth for this payment',
    })];

    await expect(runCtx(() => requestPaymentDelete(db, PAYMENT))).resolves.toBe(MAPPING);
    expect(mapping()).toMatchObject({ pendingOp: 'delete', remoteEntityId: '181/145' });
    expect(stmtsOf('delete', 'accounting_entity_mappings')).toHaveLength(0);
  });

  it('DELETES a QuickBooks-origin mapping without asking QuickBooks to delete anything', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({
      breezeOrigin: false, remoteEntityId: '181/145', pendingOp: null, syncStatus: 'synced',
    })];

    await expect(runCtx(() => requestPaymentDelete(db, PAYMENT))).resolves.toBeNull();
    expect(mapping()).toBeNull();
  });

  it('is a no-op for a payment with no mapping at all (the common manual/Stripe case)', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow()];

    await expect(runCtx(() => requestPaymentDelete(db, PAYMENT))).resolves.toBeNull();
    expect(stmtsOf('delete', 'accounting_entity_mappings')).toHaveLength(0);
    expect(stmtsOf('update', 'accounting_entity_mappings')).toHaveLength(0);
  });
});

describe('pushPaymentToAccounting', () => {
  it('refuses an ambient DB context', async () => {
    await expect(runCtx(() => pushPaymentToAccounting(MAPPING, PARTNER, runCtx)))
      .rejects.toThrow(/must run with NO ambient DB access context/);
  });

  it('leases, calls QuickBooks with NOTHING held, then stamps the composite remote id', async () => {
    let depthAtProviderCall = -1;
    let claimedDuringFlight: Date | null = null;
    createPaymentMock.mockImplementationOnce(async () => {
      depthAtProviderCall = ctx.depth;
      claimedDuringFlight = mapping()!.claimedAt;
      return { id: '181', syncToken: '0' };
    });

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('pushed');

    expect(depthAtProviderCall).toBe(0);
    expect(ctx.depth).toBe(0);
    expect(claimedDuringFlight).toBeInstanceOf(Date);
    expect(createPaymentMock).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'fresh' }),
      {
        invoicePaymentId: PAYMENT,
        remoteCustomerId: '55',
        remoteInvoiceId: '145',
        amount: '107.00',
        currencyCode: 'USD',
        txnDate: '2026-09-02',
        reference: 'ch_123',
        privateNote: `Breeze payment ${PAYMENT}`,
      },
    );
    expect(mapping()).toMatchObject({
      remoteEntityId: '181/145',
      remoteSyncToken: '0',
      syncStatus: 'synced',
      linkStatus: 'confirmed',
      pendingOp: null,
      claimedAt: null,
      lastError: null,
    });
    expect(mapping()!.lastSyncedAt).toBeInstanceOf(Date);
    expect(writeAuditEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'accounting.payment.pushed',
      orgId: ORG,
      resourceType: 'invoice',
      resourceId: INVOICE,
      actorType: 'system',
      details: expect.objectContaining({
        provider: 'quickbooks', invoicePaymentId: PAYMENT, remotePaymentId: '181',
        remoteInvoiceId: '145', amount: '107.00', currency: 'USD',
      }),
    }));
  });

  it('locks the invoice FOR UPDATE before re-reading anything in phase 2', async () => {
    await pushPaymentToAccounting(MAPPING, PARTNER, runCtx);

    const lockIndex = stmts.findIndex((s) => s.kind === 'select' && s.table === 'invoices' && s.forUpdate === true);
    expect(lockIndex).toBeGreaterThan(-1);
    expect(stmts.slice(lockIndex).map((s) => `${s.kind}:${s.table}`)).toEqual([
      'select:invoices',
      'select:accounting_entity_mappings',
      'select:invoice_payments',
      'update:accounting_entity_mappings',
    ]);
  });

  it('claims the lease with a compare-and-set on (id, partner, pending_op, stale claim)', async () => {
    await pushPaymentToAccounting(MAPPING, PARTNER, runCtx);

    const claim = stmtsOf('update', 'accounting_entity_mappings')[0]!;
    expect(claim.set).toMatchObject({ claimedAt: expect.any(Date) });
    const sql = compiledSql(claim.where);
    expect(sql).toContain('"accounting_entity_mappings"."id" = $1');
    expect(sql).toContain('"accounting_entity_mappings"."partner_id" = $2');
    expect(sql).toContain('"accounting_entity_mappings"."breeze_entity_type" = $3');
    expect(sql).toContain('"accounting_entity_mappings"."pending_op" = $4');
    expect(sql).toMatch(/"accounting_entity_mappings"\."claimed_at" is null or "accounting_entity_mappings"\."claimed_at" < \$\d+/i);
    expect(paramsOf(claim.where).slice(0, 4)).toEqual([MAPPING, PARTNER, 'payment', 'push']);
  });

  it('refuses to lease a mapping row that is not a payment', async () => {
    // Without the breeze_entity_type guard the CAS would claim this invoice row
    // and feed its Invoice remote id to the payment provider.
    currentMappings = [invoiceMapRow({ id: MAPPING, pendingOp: 'push' }), orgMapRow()];

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'sync_in_progress' });
    expect(createPaymentMock).not.toHaveBeenCalled();
  });

  it('truncates PaymentRefNum to QuickBooks 21-character cap', async () => {
    currentPayments = [payRow({ reference: 'pi_3PabcdefghijklmnopqrstuvwxyZ' })];

    await pushPaymentToAccounting(MAPPING, PARTNER, runCtx);

    const payload = createPaymentMock.mock.calls[0]![1] as { reference: string };
    // 31-char Stripe-shaped id -> exactly the first 21 characters.
    expect(payload.reference).toBe('pi_3Pabcdefghijklmnop');
    expect(payload.reference).toHaveLength(PAYMENT_REF_MAX_LENGTH);
  });

  it('sends a null reference when the payment carries none', async () => {
    currentPayments = [payRow({ reference: null })];

    await pushPaymentToAccounting(MAPPING, PARTNER, runCtx);

    expect((createPaymentMock.mock.calls[0]![1] as { reference: string | null }).reference).toBeNull();
  });

  it('is RETRYABLE when another worker holds a fresh lease', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({ claimedAt: ago(MINUTE) })];

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'sync_in_progress', status: 409 });
    expect(createPaymentMock).not.toHaveBeenCalled();
  });

  it('re-claims a lease that expired (PAYMENT_CLAIM_LEASE_MS) and pushes', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({
      claimedAt: new Date(Date.now() - PAYMENT_CLAIM_LEASE_MS - MINUTE),
    })];

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('pushed');
  });

  it('reports nothing_owed when the row no longer owes a push', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({
      pendingOp: null, remoteEntityId: '181/145', syncStatus: 'synced',
    })];

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('nothing_owed');
    expect(createPaymentMock).not.toHaveBeenCalled();
  });

  it('is RETRYABLE (sync_in_progress) when the mapping row is not visible yet', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow()];

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'sync_in_progress', status: 409 });
  });

  it('never reads another partner\'s mapping row when deciding nothing_owed', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({ partnerId: 'other-partner', pendingOp: null })];

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'sync_in_progress' });
  });

  it('reports nothing_owed (not sync_in_progress) when a void flipped the row to pending_op=delete while this push job was queued', async () => {
    // Mirrors the delete side's own CAS-miss shortcut: the CAS wants
    // pending_op='push' and misses because a destroyer already flipped the row
    // to 'delete' — retrying the push can never succeed, so a stale push job
    // must not burn five retries on it.
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({ pendingOp: 'delete' })];

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('nothing_owed');
    expect(createPaymentMock).not.toHaveBeenCalled();
  });

  it('never reads another partner\'s org mapping', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow({ partnerId: 'other-partner' }), paymentMapRow()];

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'customer_not_mapped' });
    expect(createPaymentMock).not.toHaveBeenCalled();
  });

  it('never reads another partner\'s invoice mapping', async () => {
    currentMappings = [invoiceMapRow({ partnerId: 'other-partner' }), orgMapRow(), paymentMapRow()];

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'invoice_not_synced' });
  });

  it('is RETRYABLE, and releases the lease, when the invoice has not synced yet', async () => {
    currentMappings = [invoiceMapRow({ remoteEntityId: null, syncStatus: 'pending' }), orgMapRow(), paymentMapRow()];

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'invoice_not_synced' });
    // Lease released and the work still owed, so the sweep re-enqueues it.
    expect(mapping()).toMatchObject({ pendingOp: 'push', claimedAt: null });
    expect(createPaymentMock).not.toHaveBeenCalled();
  });

  it('is TERMINAL and stamps the row when push_payments is off', async () => {
    currentConns = [connRow({ pushPayments: false })];

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'push_disabled', status: 409 });
    expect(mapping()).toMatchObject({
      pendingOp: null, claimedAt: null, syncStatus: 'error', lastError: PAYMENT_PUSH_DISABLED_MESSAGE,
    });
  });

  it('is TERMINAL on a currency mismatch, BEFORE any QuickBooks call or token refresh', async () => {
    currentInvoices = [invRow({ currencyCode: 'EUR' })];

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'currency_mismatch', status: 409 });
    expect(createPaymentMock).not.toHaveBeenCalled();
    expect(resolveLiveConnectionMock).not.toHaveBeenCalled();
    expect(mapping()).toMatchObject({ syncStatus: 'error', pendingOp: null, claimedAt: null });
    expect(mapping()!.lastError).toContain('does not match the connected QuickBooks home currency USD');
  });

  it('is TERMINAL when the realm home currency was never captured', async () => {
    currentConns = [connRow({ homeCurrency: null })];

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'home_currency_unknown', status: 409 });
    expect(createPaymentMock).not.toHaveBeenCalled();
  });

  it('is TERMINAL when the organization is not mapped to a QuickBooks customer', async () => {
    currentMappings = [invoiceMapRow(), paymentMapRow()];

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'customer_not_mapped', status: 409 });
    expect(mapping()).toMatchObject({ syncStatus: 'error', pendingOp: null, claimedAt: null });
  });

  it('is TERMINAL when the organization mapping is only suggested', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow({ linkStatus: 'suggested' }), paymentMapRow()];

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'customer_not_mapped' });
  });

  it('is TERMINAL against an invoice Breeze already voided (spec decision 11)', async () => {
    currentInvoices = [invRow({ status: 'void' })];

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'invoice_void', status: 409 });
    expect(createPaymentMock).not.toHaveBeenCalled();
    expect(mapping()).toMatchObject({ syncStatus: 'error', pendingOp: null, claimedAt: null });
  });

  it('rolls the lease claim back when the connection resolve throws', async () => {
    resolveConnectionMock.mockRejectedValueOnce(new AccountingMappingError('reauth_required', 409, 'reconnect'));

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'reauth_required', status: 409 });
    expect(mapping()).toMatchObject({ pendingOp: 'push', claimedAt: null });
  });

  it('converts to a delete when the payment vanished BEFORE the QuickBooks call', async () => {
    currentPayments = [];
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({ remoteEntityId: '181/145', remoteSyncToken: '0' })];

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('converted_to_delete');
    expect(createPaymentMock).not.toHaveBeenCalled();
    expect(mapping()).toMatchObject({ pendingOp: 'delete', syncStatus: 'pending', claimedAt: null });
  });

  it('reports payment_gone and drops the mapping when nothing exists remotely either', async () => {
    currentPayments = [];

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('payment_gone');
    expect(mapping()).toBeNull();
    expect(createPaymentMock).not.toHaveBeenCalled();
  });

  it('reports payment_gone when the invoice itself is gone and nothing was pushed', async () => {
    currentInvoices = [];

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('payment_gone');
    expect(mapping()).toBeNull();
  });

  it('converts to a delete when the invoice is gone but a QuickBooks Payment exists', async () => {
    currentInvoices = [];
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({ remoteEntityId: '181/145', remoteSyncToken: '0' })];

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('converted_to_delete');
    expect(mapping()).toMatchObject({ pendingOp: 'delete', claimedAt: null });
  });

  it('converts to a delete when the payment vanished DURING the QuickBooks call (spec decision 7)', async () => {
    createPaymentMock.mockImplementationOnce(async () => {
      currentPayments = [];
      return { id: '181', syncToken: '0' };
    });

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('converted_to_delete');
    // The remote ref is stamped ANYWAY: the delete needs an Id and a SyncToken.
    expect(mapping()).toMatchObject({
      remoteEntityId: '181/145', remoteSyncToken: '0', pendingOp: 'delete', claimedAt: null, linkStatus: 'confirmed',
    });
  });

  it('converts to a delete when a void flipped the row WHILE the create was in flight', async () => {
    // The payment row is still present here on purpose: it is the flipped
    // `pending_op`, not a missing payment, that must drive the conversion —
    // requestPaymentDelete runs before the invoice_payments delete.
    createPaymentMock.mockImplementationOnce(async () => {
      mapping()!.pendingOp = 'delete';
      return { id: '181', syncToken: '0' };
    });

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('converted_to_delete');
    expect(mapping()).toMatchObject({
      remoteEntityId: '181/145', remoteSyncToken: '0', pendingOp: 'delete',
      syncStatus: 'pending', linkStatus: 'confirmed', claimedAt: null,
    });
  });

  it('survives the full void-during-push race end to end', async () => {
    // The exact orphan scenario: a worker is between phase 1 and its QuickBooks
    // call when voidPayment runs requestPaymentDelete and deletes the payment.
    createPaymentMock.mockImplementationOnce(async () => {
      await runCtx(() => requestPaymentDelete(db, PAYMENT));
      currentPayments = [];
      return { id: '181', syncToken: '0' };
    });

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('converted_to_delete');
    // The mapping SURVIVES with everything a delete job needs.
    expect(mapping()).toMatchObject({
      remoteEntityId: '181/145', remoteSyncToken: '0', pendingOp: 'delete', claimedAt: null,
    });
  });

  it('is record_failed when the invoice cannot be locked in phase 2', async () => {
    createPaymentMock.mockImplementationOnce(async () => {
      currentInvoices = [];
      return { id: '181', syncToken: '0' };
    });

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'record_failed', status: 502 });
  });

  it('stamps normally when the invoice went void DURING the call (decision 11 beats decision 7)', async () => {
    createPaymentMock.mockImplementationOnce(async () => {
      currentInvoices = [invRow({ status: 'void' })];
      return { id: '181', syncToken: '0' };
    });

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('pushed');
    expect(mapping()).toMatchObject({ remoteEntityId: '181/145', syncStatus: 'synced', pendingOp: null });
  });

  it('keeps the ECHO-stored token when the CDC pull adopted the row first, and closes its own claim', async () => {
    createPaymentMock.mockImplementationOnce(async () => {
      const m = mapping()!;
      m.remoteEntityId = '181/145';
      m.remoteSyncToken = '4';
      m.syncStatus = 'synced';
      // `pending_op` is deliberately LEFT SET: the coordinator owns closing out
      // its own at-most-once claim, and a row still owing a push would be
      // re-enqueued by the sweep and double-book once QBO's requestid window
      // lapsed.
      return { id: '181', syncToken: '0' };
    });

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('already_adopted');
    expect(mapping()).toMatchObject({ remoteSyncToken: '4', pendingOp: null, claimedAt: null });
    expect(writeAuditEventMock).not.toHaveBeenCalled();
  });

  it('keeps the delete owed when the row was adopted AND flipped to delete', async () => {
    createPaymentMock.mockImplementationOnce(async () => {
      const m = mapping()!;
      m.remoteEntityId = '181/145';
      m.remoteSyncToken = '4';
      m.pendingOp = 'delete';
      return { id: '181', syncToken: '0' };
    });

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('converted_to_delete');
    expect(mapping()).toMatchObject({ remoteSyncToken: '4', pendingOp: 'delete', claimedAt: null });
  });

  it('does NOT treat a different QuickBooks payment on the same invoice as an adoption', async () => {
    createPaymentMock.mockImplementationOnce(async () => {
      const m = mapping()!;
      m.remoteEntityId = '999/145';
      m.remoteSyncToken = '4';
      return { id: '181', syncToken: '0' };
    });

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('pushed');
    expect(mapping()).toMatchObject({ remoteEntityId: '181/145', remoteSyncToken: '0' });
  });

  it('records a divergence when a partial refund changed the amount mid-flight (spec decision 9)', async () => {
    // 107.00 was pushed to QuickBooks; the Breeze row is now 40.00, so 67.00 has
    // been refunded so far. The message must quote the REFUNDED TOTAL (67.00),
    // not the amount left on the payment (40.00) — a bookkeeper acting on 40.00
    // would enter a refund for money that was never returned.
    createPaymentMock.mockImplementationOnce(async () => {
      currentPayments = [payRow({ amount: '40.00' })];
      return { id: '181', syncToken: '0' };
    });

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('diverged');
    expect(mapping()).toMatchObject({
      remoteEntityId: '181/145',
      remoteSyncToken: '0',
      syncStatus: 'error',
      pendingOp: null,
      claimedAt: null,
      lastError: partialRefundDivergenceMessage('67.00'),
    });
    // Both divergence paths (this one and stripeReconcile's) go through the same
    // helper with the same quantity, so the two can never quote different numbers.
    expect(mapping()!.lastError)
      .toBe('Refunded in Stripe, total 67.00; record the refund in QuickBooks (this QuickBooks payment still shows the full amount)');
    expect(mapping()!.lastError).not.toContain('40.00');
    expect(deletePaymentMock).not.toHaveBeenCalled();
  });

  it('derives the refunded total through the CURRENCY-AWARE minor unit (finding M7)', async () => {
    // The refunded total must be derived the way the Stripe path derives it —
    // `toMinorUnits`/`fromMinorUnits` against the INVOICE currency — not through
    // `invoiceMath`'s `toCents`/`fromCents`, whose exponent is hard-coded to 2.
    //
    // For a whole-unit amount the two agree (the factor cancels in a
    // subtraction), so this fixture is deliberately the input where they do NOT:
    // JPY is zero-decimal, `invoice_payments.amount` is numeric(_,2), and a
    // sub-yen fraction can reach that column (a converted charge, a hand-typed
    // value). Currency-aware: 5001 - 3000 = 2001 yen. Fixed-cents: 200025
    // "cents" = 2000.25 — a quarter of a yen, a quantity that does not exist.
    currentConns = [connRow({ homeCurrency: 'JPY' })];
    currentInvoices = [invRow({ currencyCode: 'JPY' })];
    currentPayments = [payRow({ amount: '5000.50' })];
    createPaymentMock.mockImplementationOnce(async () => {
      currentPayments = [payRow({ amount: '3000.25' })];
      return { id: '181', syncToken: '0' };
    });

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('diverged');
    expect(mapping()!.lastError).toBe(partialRefundDivergenceMessage('2001.00'));
    expect(mapping()!.lastError).not.toContain('2000.25');
  });

  it('sanitizes a QuickBooks failure, COMMITS the marker, keeps pending_op and rethrows 502', async () => {
    createPaymentMock.mockRejectedValueOnce(Object.assign(new Error('boom'), {
      status: 400,
      body: '{"Fault":{"Error":[{"Detail":"secret"}]}}',
    }));

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'quickbooks_error', status: 502 });
    expect(mapping()).toMatchObject({
      syncStatus: 'error',
      lastError: 'QuickBooks rejected the payment sync (HTTP 400)',
      pendingOp: 'push', // still owed -> the sweep retries it
      claimedAt: null, // lease released
    });
    expect(JSON.stringify(mapping())).not.toContain('secret');
    expect(captureExceptionMock).toHaveBeenCalled();
  });

  it('is record_failed (terminal, pending_op cleared) when phase 2 cannot record the result', async () => {
    createPaymentMock.mockImplementationOnce(async () => {
      // The mapping row disappears between the create and phase 2. Since
      // `requestPaymentDelete` no longer deletes a Breeze-origin push row, the
      // only remaining ways here are tenant erasure or hand surgery — but the
      // coordinator must still refuse to silently lose the QuickBooks result.
      currentMappings = currentMappings.filter((m) => m.breezeEntityType !== 'payment');
      return { id: '181', syncToken: '0' };
    });

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'record_failed', status: 502 });
    const [[error]] = captureExceptionMock.mock.calls as [[Error]];
    expect(error.message).toContain('181');
  });
});

describe('deletePaymentInAccounting', () => {
  beforeEach(() => {
    currentPayments = [];
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({
      remoteEntityId: '181/145', remoteSyncToken: '3', pendingOp: 'delete', syncStatus: 'pending',
    })];
  });

  it('refuses an ambient DB context', async () => {
    await expect(runCtx(() => deletePaymentInAccounting(MAPPING, PARTNER, runCtx)))
      .rejects.toThrow(/must run with NO ambient DB access context/);
  });

  it('deletes in QuickBooks with nothing held, then removes the mapping row', async () => {
    let depthAtProviderCall = -1;
    deletePaymentMock.mockImplementationOnce(async () => {
      depthAtProviderCall = ctx.depth;
      return 'deleted';
    });

    await expect(deletePaymentInAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('deleted');

    expect(depthAtProviderCall).toBe(0);
    expect(deletePaymentMock).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'fresh' }),
      { remotePaymentId: '181', syncToken: '3' },
    );
    expect(mapping()).toBeNull();
    expect(writeAuditEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'accounting.payment.deleted',
      orgId: ORG,
      resourceType: 'invoice',
      resourceId: INVOICE,
      details: expect.objectContaining({ remotePaymentId: '181', remoteInvoiceId: '145', result: 'deleted' }),
    }));
  });

  it('propagates a delete even with BOTH switches off — Breeze owns what it created (decision 10)', async () => {
    currentConns = [connRow({ pushPayments: false, pushMode: 'manual' })];

    await expect(deletePaymentInAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('deleted');
    expect(mapping()).toBeNull();
  });

  it('treats an already-absent QuickBooks Payment as success and still clears the row', async () => {
    deletePaymentMock.mockResolvedValueOnce('already_absent');

    await expect(deletePaymentInAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('already_absent');
    expect(mapping()).toBeNull();
  });

  it('PARKS a delete that has no remote id yet, inside the grace window', async () => {
    // The create may still be in flight, or its response was lost and the CDC
    // pull has yet to adopt the Payment. Dropping the row here would orphan it.
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({
      pendingOp: 'delete', remoteEntityId: null, createdAt: ago(60 * MINUTE),
    })];

    await expect(deletePaymentInAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('awaiting_remote_ref');
    expect(deletePaymentMock).not.toHaveBeenCalled();
    // Row kept, lease released, so the sweep re-enqueues it after adoption.
    expect(mapping()).toMatchObject({ pendingOp: 'delete', claimedAt: null });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('drops an unresolved delete LOUDLY once the grace window has passed', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({
      pendingOp: 'delete',
      remoteEntityId: null,
      createdAt: new Date(Date.now() - PAYMENT_DELETE_UNRESOLVED_GRACE_MS - MINUTE),
    })];

    await expect(deletePaymentInAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('unresolved_dropped');
    expect(deletePaymentMock).not.toHaveBeenCalled();
    expect(mapping()).toBeNull();
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect((captureExceptionMock.mock.calls[0] as [Error])[0].message).toContain('may be');
    expect(writeAuditEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'accounting.payment.delete_unresolved',
      orgId: null,
      resourceType: 'accounting_entity_mapping',
      resourceId: MAPPING,
      result: 'failure',
      details: expect.objectContaining({ invoicePaymentId: PAYMENT, mappingId: MAPPING }),
    }));
  });

  it('measures the unresolved window on created_at, which the lease CAS cannot bump', async () => {
    // updated_at is bumped by every claim, so an age measured on it would never
    // expire under a 15-minute sweep.
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({
      pendingOp: 'delete',
      remoteEntityId: null,
      createdAt: new Date(Date.now() - PAYMENT_DELETE_UNRESOLVED_GRACE_MS - MINUTE),
      updatedAt: ago(3 * MINUTE),
    })];

    await expect(deletePaymentInAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('unresolved_dropped');
  });

  it('KEEPS the row and stamps when QuickBooks deleted but Breeze could not clear the mapping', async () => {
    deletePaymentMock.mockImplementationOnce(async () => {
      // The row vanishes between the QuickBooks delete and the local clear.
      currentMappings = currentMappings.filter((m) => m.breezeEntityType !== 'payment');
      return 'deleted';
    });

    await expect(deletePaymentInAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'record_failed', status: 502 });
    expect(captureExceptionMock).toHaveBeenCalled();
  });

  it('KEEPS the row, releases the lease and rethrows when QuickBooks fails', async () => {
    deletePaymentMock.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));

    await expect(deletePaymentInAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'quickbooks_error', status: 502 });
    expect(mapping()).toMatchObject({
      pendingOp: 'delete',
      claimedAt: null,
      lastError: 'QuickBooks rejected the payment sync (HTTP 500)',
    });
  });

  it('is a no-op when the row no longer owes a delete', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow()];

    await expect(deletePaymentInAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('nothing_owed');
    expect(deletePaymentMock).not.toHaveBeenCalled();
  });

  it('is a no-op when the row owes a push, not a delete', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow()];

    await expect(deletePaymentInAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('nothing_owed');
    expect(deletePaymentMock).not.toHaveBeenCalled();
  });

  it('is RETRYABLE when another worker holds a fresh lease on the delete', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({
      remoteEntityId: '181/145', remoteSyncToken: '3', pendingOp: 'delete', claimedAt: ago(MINUTE),
    })];

    await expect(deletePaymentInAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'sync_in_progress', status: 409 });
    expect(deletePaymentMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The attempt ceiling (findings I1/I2)
// ---------------------------------------------------------------------------

describe('sync_attempts: the outbox\'s only bound', () => {
  const failCreate = () => createPaymentMock.mockRejectedValueOnce(
    Object.assign(new Error('boom'), { status: 400 }),
  );

  it('counts every failed push attempt and keeps the row owed below the ceiling', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({ syncAttempts: 3 })];
    failCreate();

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'quickbooks_error' });

    expect(mapping()).toMatchObject({
      syncAttempts: 4,
      pendingOp: 'push',
      claimedAt: null,
      lastError: 'QuickBooks rejected the payment sync (HTTP 400)',
    });
  });

  it('increments IN THE UPDATE, never read-modify-write', async () => {
    // The sweep and an immediate enqueue can both be mid-flight on one row, so
    // the counter has to be `sync_attempts + 1` evaluated by Postgres. A JS
    // `attempts + 1` computed from a stale read loses increments silently.
    failCreate();

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).rejects.toThrow();

    const stamp = stmtsOf('update', 'accounting_entity_mappings')
      .find((st) => (st.set as Record<string, unknown>).lastError !== undefined)!;
    expect(compiledSql((stamp.set as Record<string, unknown>).syncAttempts))
      .toBe('"accounting_entity_mappings"."sync_attempts" + 1');
  });

  it('GIVES UP on a push row at PAYMENT_PUSH_MAX_ATTEMPTS: pending_op and the lease cleared, reason quoted', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({
      syncAttempts: PAYMENT_PUSH_MAX_ATTEMPTS - 1,
    })];
    failCreate();

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'quickbooks_error' });

    expect(mapping()).toMatchObject({
      syncAttempts: PAYMENT_PUSH_MAX_ATTEMPTS,
      // Cleared, so the 15-minute sweep stops re-enqueueing a doomed create.
      pendingOp: null,
      claimedAt: null,
      syncStatus: 'error',
      lastError: paymentPushGaveUpMessage('QuickBooks rejected the payment sync (HTTP 400)'),
    });
    expect(mapping()!.lastError).toContain('push the invoice again');
    // The row is no longer owed, so the sweep query drops it.
    expect(await listOwedPaymentMappings(db, new Date())).toEqual([]);
  });

  it('NEVER caps a delete row — Breeze owns the removal of a Payment it created', async () => {
    currentPayments = [];
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({
      remoteEntityId: '181/145', remoteSyncToken: '3', pendingOp: 'delete', syncStatus: 'pending',
      syncAttempts: PAYMENT_PUSH_MAX_ATTEMPTS * 5,
    })];
    deletePaymentMock.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));

    await expect(deletePaymentInAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'quickbooks_error' });

    expect(mapping()).toMatchObject({
      pendingOp: 'delete',
      syncAttempts: PAYMENT_PUSH_MAX_ATTEMPTS * 5 + 1,
      claimedAt: null,
    });
    expect(mapping()!.lastError).not.toContain('gave up');
  });

  it('reports a stuck delete to Sentry on the FIRST failure and then once a day, not every sweep', async () => {
    currentPayments = [];
    const seed = (syncAttempts: number) => {
      currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({
        remoteEntityId: '181/145', remoteSyncToken: '3', pendingOp: 'delete', syncStatus: 'pending',
        syncAttempts,
      })];
    };
    const attempt = async () => {
      captureExceptionMock.mockClear();
      deletePaymentMock.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
      await expect(deletePaymentInAccounting(MAPPING, PARTNER, runCtx)).rejects.toThrow();
      return captureExceptionMock.mock.calls.length;
    };

    seed(0);
    expect(await attempt()).toBe(1); // the first failure is always reported
    seed(1);
    expect(await attempt()).toBe(0); // ...the second is not
    seed(50);
    expect(await attempt()).toBe(0);
    seed(95);
    expect(await attempt()).toBe(1); // 96 attempts = one sweep-day
    expect(captureExceptionMock.mock.calls[0]![2]).toMatchObject({ syncAttempts: '96' });
  });

  it('records a payment job the sync worker skipped because QuickBooks is not connected', async () => {
    // Finding I2: this used to `return` silently, leaving the row pending with
    // an empty last_error while the sweep re-enqueued it forever.
    await notePaymentJobSkipped(MAPPING, PARTNER, PAYMENT_NOT_CONNECTED_MESSAGE);

    expect(mapping()).toMatchObject({
      syncAttempts: 1,
      pendingOp: 'push', // still owed — a reconnect must be able to finish it
      syncStatus: 'error',
      lastError: PAYMENT_NOT_CONNECTED_MESSAGE,
    });
  });

  it('retires a push row that has spent its whole budget on not-connected skips', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({
      syncAttempts: PAYMENT_PUSH_MAX_ATTEMPTS - 1,
    })];

    await notePaymentJobSkipped(MAPPING, PARTNER, PAYMENT_NOT_CONNECTED_MESSAGE);

    expect(mapping()).toMatchObject({
      pendingOp: null,
      lastError: paymentPushGaveUpMessage(PAYMENT_NOT_CONNECTED_MESSAGE),
    });
  });

  it('leaves a skipped DELETE row owed no matter how many times it is skipped', async () => {
    currentPayments = [];
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({
      remoteEntityId: '181/145', pendingOp: 'delete', syncStatus: 'pending',
      syncAttempts: PAYMENT_PUSH_MAX_ATTEMPTS - 1,
    })];

    await notePaymentJobSkipped(MAPPING, PARTNER, PAYMENT_NOT_CONNECTED_MESSAGE);

    expect(mapping()).toMatchObject({ pendingOp: 'delete', syncAttempts: PAYMENT_PUSH_MAX_ATTEMPTS });
  });

  it('never lets its own failure escape into the worker', async () => {
    updateMock.mockImplementationOnce(() => { throw new Error('pool exhausted'); });

    await expect(notePaymentJobSkipped(MAPPING, PARTNER, PAYMENT_NOT_CONNECTED_MESSAGE)).resolves.toBeUndefined();
    expect(captureExceptionMock).toHaveBeenCalled();
  });
});

describe('fanOutOwedPayments', () => {
  it('creates a pending push mapping for every unmapped payment and returns their ids', async () => {
    currentPayments = [payRow({ id: PAYMENT }), payRow({ id: 'pay-2', amount: '10.00' })];
    currentMappings = [invoiceMapRow(), orgMapRow()];

    const ids = await fanOutOwedPayments(INVOICE, PARTNER, runCtx);

    expect(ids).toHaveLength(2);
    const inserts = stmtsOf('insert', 'accounting_entity_mappings');
    expect(inserts.every((s) => s.values!.pendingOp === 'push' && s.values!.breezeOrigin === true)).toBe(true);
    expect(inserts.map((s) => s.values!.breezeEntityId)).toEqual([PAYMENT, 'pay-2']);
  });

  it('skips payments that already carry a mapping', async () => {
    currentPayments = [payRow({ id: PAYMENT }), payRow({ id: 'pay-2', amount: '10.00' })];

    await expect(fanOutOwedPayments(INVOICE, PARTNER, runCtx)).resolves.toHaveLength(1);
    expect(stmtsOf('insert', 'accounting_entity_mappings')[0]!.values!.breezeEntityId).toBe('pay-2');
  });

  it('RE-OWNS a Breeze-origin mapping QuickBooks deleted, instead of trying to insert a second one', async () => {
    // `breeze_origin_removed_remotely` leaves the row with no remote id and
    // nothing owed. `accounting_entity_mappings_breeze_uniq` makes a second
    // insert impossible, so without this the payment is un-re-pushable forever.
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({
      breezeOrigin: true, remoteEntityId: null, remoteSyncToken: null,
      pendingOp: null, syncStatus: 'error', lastError: 'Deleted in QuickBooks',
    })];

    await expect(fanOutOwedPayments(INVOICE, PARTNER, runCtx)).resolves.toEqual([MAPPING]);

    expect(stmtsOf('insert', 'accounting_entity_mappings')).toHaveLength(0);
    expect(mapping()).toMatchObject({
      pendingOp: 'push', syncStatus: 'pending', lastError: null, claimedAt: null,
    });
  });

  it('RESETS the attempt budget on a re-own — a fresh push must not inherit an exhausted counter', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({
      remoteEntityId: null, pendingOp: null, syncStatus: 'error',
      lastError: 'Deleted in QuickBooks', syncAttempts: PAYMENT_PUSH_MAX_ATTEMPTS,
    })];

    await expect(fanOutOwedPayments(INVOICE, PARTNER, runCtx)).resolves.toEqual([MAPPING]);

    expect(mapping()).toMatchObject({ pendingOp: 'push', syncAttempts: 0, lastError: null });
  });

  it('guards the re-own on the whole removed-remotely state, so a racing stamp wins', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({
      breezeOrigin: true, remoteEntityId: null, pendingOp: null, syncStatus: 'error',
    })];

    await fanOutOwedPayments(INVOICE, PARTNER, runCtx);

    expect(mapping()).toMatchObject({ linkStatus: 'create_new' });
    const reown = stmtsOf('update', 'accounting_entity_mappings')[0]!;
    const sql = compiledSql(reown.where);
    expect(sql).toMatch(/"remote_entity_id" is null/);
    expect(sql).toMatch(/"pending_op" is null/);
    expect(sql).toMatch(/"breeze_origin" = \$\d+/);
    expect(paramsOf(reown.where)).toEqual(expect.arrayContaining([MAPPING, PARTNER, true]));
  });

  it('does NOT re-own a synced mapping — re-owing one would create a DUPLICATE Payment', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({
      breezeOrigin: true, remoteEntityId: '181/145', remoteSyncToken: '0',
      pendingOp: null, syncStatus: 'synced',
    })];

    await expect(fanOutOwedPayments(INVOICE, PARTNER, runCtx)).resolves.toEqual([]);
    expect(stmtsOf('update', 'accounting_entity_mappings')).toHaveLength(0);
    expect(stmtsOf('insert', 'accounting_entity_mappings')).toHaveLength(0);
  });

  it('does NOT re-own a mapping that already owes a delete', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({
      breezeOrigin: true, remoteEntityId: null, pendingOp: 'delete', syncStatus: 'pending',
    })];

    await expect(fanOutOwedPayments(INVOICE, PARTNER, runCtx)).resolves.toEqual([]);
    expect(stmtsOf('update', 'accounting_entity_mappings')).toHaveLength(0);
  });

  it('does NOT re-own a QuickBooks-ORIGIN mapping — it is not ours to push', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({
      breezeOrigin: false, remoteEntityId: null, pendingOp: null, syncStatus: 'error',
    })];

    await expect(fanOutOwedPayments(INVOICE, PARTNER, runCtx)).resolves.toEqual([]);
    expect(stmtsOf('update', 'accounting_entity_mappings')).toHaveLength(0);
  });

  it('skips a payment whose re-own CAS lost, WITHOUT rolling back its siblings', async () => {
    // The whole fan-out is one transaction. Throwing on a lost race would
    // punish every other payment on the invoice for one row another writer
    // claimed a microsecond earlier.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      currentPayments = [payRow({ id: PAYMENT }), payRow({ id: 'pay-2', amount: '10.00' })];
      currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({
        breezeOrigin: true, remoteEntityId: null, pendingOp: null, syncStatus: 'error',
      })];
      const realUpdate = updateMock.getMockImplementation()!;
      updateMock.mockImplementation((table: unknown) => {
        // The racing writer stamps the row between the read and the CAS.
        const row = mapping();
        if (table === accountingEntityMappings && row) row.remoteEntityId = '181/145';
        return realUpdate(table);
      });

      // `pay-2` has no mapping at all, so its insert must still be returned.
      await expect(fanOutOwedPayments(INVOICE, PARTNER, runCtx)).resolves.toEqual(['map-new-1']);

      expect(stmtsOf('insert', 'accounting_entity_mappings')[0]!.values!.breezeEntityId).toBe('pay-2');
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('skipped re-owning'), expect.anything(), expect.anything(), expect.anything(),
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it('re-owns nothing when push_payments is off', async () => {
    currentConns = [connRow({ pushPayments: false })];
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({
      breezeOrigin: true, remoteEntityId: null, pendingOp: null, syncStatus: 'error',
    })];

    await expect(fanOutOwedPayments(INVOICE, PARTNER, runCtx)).resolves.toEqual([]);
    expect(stmtsOf('update', 'accounting_entity_mappings')).toHaveLength(0);
    expect(mapping()).toMatchObject({ pendingOp: null, syncStatus: 'error' });
  });

  it('returns nothing when push_payments is off', async () => {
    currentConns = [connRow({ pushPayments: false })];
    currentMappings = [invoiceMapRow(), orgMapRow()];

    await expect(fanOutOwedPayments(INVOICE, PARTNER, runCtx)).resolves.toEqual([]);
    expect(stmtsOf('insert', 'accounting_entity_mappings')).toHaveLength(0);
  });

  it('runs in MANUAL push mode — it is the only way payments reach QuickBooks there', async () => {
    currentConns = [connRow({ pushMode: 'manual' })];
    currentMappings = [invoiceMapRow(), orgMapRow()];

    await expect(fanOutOwedPayments(INVOICE, PARTNER, runCtx)).resolves.toHaveLength(1);
  });

  it('returns nothing when the invoice itself is not synced', async () => {
    currentMappings = [invoiceMapRow({ remoteEntityId: null, syncStatus: 'pending' }), orgMapRow()];

    await expect(fanOutOwedPayments(INVOICE, PARTNER, runCtx)).resolves.toEqual([]);
  });

  it('returns nothing when the invoice has no payments', async () => {
    currentPayments = [];
    currentMappings = [invoiceMapRow(), orgMapRow()];

    await expect(fanOutOwedPayments(INVOICE, PARTNER, runCtx)).resolves.toEqual([]);
  });
});

describe('listOwedPaymentMappings (the sweep query)', () => {
  const now = () => new Date();

  it('returns rows whose lease is free and whose update is older than the grace window', async () => {
    currentMappings = [paymentMapRow({ pendingOp: 'push', claimedAt: null, updatedAt: ago(5 * MINUTE) })];

    await expect(runCtx(() => listOwedPaymentMappings(db, now())))
      .resolves.toEqual([{ id: MAPPING, partnerId: PARTNER, pendingOp: 'push' }]);
  });

  it('includes a delete whose lease has expired', async () => {
    currentMappings = [paymentMapRow({
      pendingOp: 'delete',
      claimedAt: new Date(Date.now() - PAYMENT_CLAIM_LEASE_MS - MINUTE),
      updatedAt: ago(5 * MINUTE),
    })];

    await expect(runCtx(() => listOwedPaymentMappings(db, now())))
      .resolves.toEqual([{ id: MAPPING, partnerId: PARTNER, pendingOp: 'delete' }]);
  });

  it('excludes a row a worker is currently holding', async () => {
    currentMappings = [paymentMapRow({ claimedAt: ago(MINUTE), updatedAt: ago(5 * MINUTE) })];

    await expect(runCtx(() => listOwedPaymentMappings(db, now()))).resolves.toEqual([]);
  });

  it('excludes a row younger than the sweep grace window, so it never races the caller enqueue', async () => {
    currentMappings = [paymentMapRow({ updatedAt: new Date(Date.now() - PAYMENT_SWEEP_MIN_AGE_MS / 2) })];

    await expect(runCtx(() => listOwedPaymentMappings(db, now()))).resolves.toEqual([]);
  });

  it('excludes rows that owe nothing', async () => {
    currentMappings = [paymentMapRow({ pendingOp: null, updatedAt: ago(5 * MINUTE) }), invoiceMapRow()];

    await expect(runCtx(() => listOwedPaymentMappings(db, now()))).resolves.toEqual([]);
  });

  it('never returns a non-payment mapping row', async () => {
    // An invoice row that somehow carried pending_op would otherwise be handed
    // to the payment worker, whose delete path would post its Invoice id to the
    // Payment endpoint.
    currentMappings = [invoiceMapRow({ pendingOp: 'push', updatedAt: ago(5 * MINUTE) })];

    await expect(runCtx(() => listOwedPaymentMappings(db, now()))).resolves.toEqual([]);
  });

  it('is connection-agnostic: no join to accounting_connections (decision 10)', async () => {
    currentMappings = [paymentMapRow({ updatedAt: ago(5 * MINUTE) })];

    await runCtx(() => listOwedPaymentMappings(db, now()));

    expect(stmtsOf('select', 'accounting_connections')).toHaveLength(0);
    const sweep = stmtsOf('select', 'accounting_entity_mappings')[0]!;
    const sql = compiledSql(sweep.where);
    expect(sql).toContain('"accounting_entity_mappings"."breeze_entity_type" = $1');
    expect(sql).toMatch(/"accounting_entity_mappings"\."pending_op" in \(\$\d+, \$\d+\)/i);
    expect(paramsOf(sweep.where).slice(0, 3)).toEqual(['payment', 'push', 'delete']);
  });
});

describe('AccountingPaymentPushError', () => {
  it('carries a typed code and status', () => {
    const err = new AccountingPaymentPushError('quickbooks_error', 502, 'nope');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AccountingPaymentPushError');
    expect({ code: err.code, status: err.status }).toEqual({ code: 'quickbooks_error', status: 502 });
  });
});
