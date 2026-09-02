/**
 * The ONE sanctioned entry to `AccountingProvider.pushInvoice`/`voidInvoice`
 * (Phase C, Task 3 — .superpowers/sdd/2026-09-01-quickbooks-phase-c-invoice-push/
 * task-3-brief.md; contract comment: accountingCurrency.ts:143-186).
 *
 * `pushInvoiceToAccounting` / `voidInvoiceInAccounting` own connection/token
 * resolution, the currency guard (assertAccountingInvoicePushCurrency, run
 * BEFORE any network call), org/catalog-item dependency sync, and every write
 * to the invoice's `accounting_entity_mappings` row. Nothing else in the repo
 * may call `provider.pushInvoice`/`voidInvoice` directly —
 * `accountingInvoicePushCallSites.test.ts` enforces that with an AST scan of
 * `apps/api/src` + `ee`.
 *
 * Mirrors `accountingMappingService.ts`'s failure taxonomy
 * (sanitizeSyncErrorMessage / markMappingError / persistRemoteRef's
 * zero-row-throw / upsertMappingRow's unique-violation handling) but
 * reimplements each locally against the invoice row: that module's helpers are
 * shaped for the org/catalog-item entity workbench (Task 4) and don't carry
 * the invoice-specific fields (docNumber, tax variance) this coordinator needs.
 *
 * DB ACCESS CONTRACT (review round 3 — #1105 / lost-sync-state class). This
 * coordinator MUST be entered with NO ambient DB access context (asserted) and
 * takes a `runInDbContext` runner instead: routes pass
 * `(fn) => withAuthDbAccessContext(auth, fn)`, the worker passes
 * `(fn) => withSystemDbAccessContext(fn, 'accountingSync.<type>')`. Every DB
 * phase is one SHORT invocation of that runner, i.e. a real transaction that
 * commits on its own, and no context is ever open across a QuickBooks call:
 *
 *   Phase 1  connection (no token), invoice, currency guard, org/item mappings
 *   ─ dependency syncs (each self-contained, own phases) ─
 *   Phase 1b pending invoice-mapping upsert                        [COMMITS]
 *   ─ token resolution, then the QBO push/void — nothing held ─
 *   Phase 2  persistInvoiceRemoteRef, or markInvoiceMappingError   [COMMITS]
 *
 * The split is load-bearing, not hygiene. Held inside ONE caller-opened
 * transaction (the previous shape), `markInvoiceMappingError` and the pending
 * mapping row were savepoints that rolled back the instant this coordinator
 * threw: the operator saw no error at all, and the retry took the CREATE path
 * again and double-booked the invoice in QuickBooks.
 */

import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext } from '../../db';
import { accountingEntityMappings, invoiceLines, invoices } from '../../db/schema';
import type { AccountingEntityMapping as AccountingEntityMappingRow } from '../../db/schema';
import { assertNoAmbientDbContext, type DbContextRunner } from './dbContextGuard';
import {
  AccountingMappingError,
  resolveConnection,
  resolveLiveConnection,
  syncMappedEntity,
} from './accountingMappingService';
import type { AccountingConnection } from './accountingConnectionService';
import { AccountingCurrencyContractError, assertAccountingInvoicePushCurrency, normalizeCurrencyCode } from './accountingCurrency';
import { getAccountingProvider } from './providerRegistry';
import { fanOutOwedPayments } from './accountingPaymentPush';
import { captureException } from '../sentry';
import { isPgUniqueViolation } from '../../utils/pgErrors';
import type {
  AccountingEntityMapping as AccountingEntityMappingSeam,
  AccountingInvoiceLineMapping,
  AccountingInvoiceLinePayload,
  AccountingInvoicePayload,
  AccountingVoidInvoicePayload,
  InvoicePushResult,
} from './types';

export type AccountingInvoicePushErrorCode =
  | 'not_connected' | 'reauth_required' | 'invoice_not_pushable' // draft or unknown invoice
  | 'customer_not_mapped' // org mapping absent / not confirmed|create_new
  | 'home_currency_unknown' | 'currency_mismatch' // realm-level (from assert)
  | 'customer_currency_mismatch' // mapping.remoteCurrencyCode ≠ invoice.currencyCode
  // A nested org/catalog-item sync (syncMappedEntity) hit a permanent
  // pre-flight 409 on the DEPENDENCY entity — no income account selected, no
  // item price in the partner currency, a create-time currency mismatch on
  // the org/item itself, or a mapping-conflict race. None of these are a
  // QuickBooks/network failure (nothing was even sent to QuickBooks), so they
  // must NOT be reported as `quickbooks_error`: that code is paired with 502
  // and read by callers as "safe to retry the QuickBooks call" — retrying a
  // call that never ran, against a mapping that is still broken, would just
  // loop. Fix the dependency's mapping, then retry the invoice push.
  | 'dependency_not_ready'
  // A void found the invoice's mapping row `pending` with no remoteEntityId —
  // a push is mid-flight. Deliberately NOT in the worker's TERMINAL_CODES:
  // BullMQ must retry with backoff until the push records its remote id.
  | 'sync_in_progress'
  | 'quickbooks_error' | 'record_failed'; // 502s; record_failed = remote ok, local persist failed (never retry)

export class AccountingInvoicePushError extends Error {
  constructor(
    public readonly code: AccountingInvoicePushErrorCode,
    public readonly status: 404 | 409 | 502,
    message: string,
  ) {
    super(message);
    this.name = 'AccountingInvoicePushError';
  }
}

export interface InvoicePushOutcome {
  mappingId: string;
  remoteEntityId: string;
  docNumber: string | null;
  syncStatus: 'synced' | 'synced_with_tax_variance';
  taxVarianceCents: number | null;
}

type InvoiceRow = typeof invoices.$inferSelect;
type InvoiceLineRow = typeof invoiceLines.$inferSelect;
type MappingRow = AccountingEntityMappingRow;
type PushMappingEntityType = 'org' | 'catalog_item' | 'invoice';

const PUSHABLE_STATUSES = new Set(['sent', 'partially_paid', 'overdue', 'paid']);

// ---------------------------------------------------------------------------
// Connection/token resolution + error translation
// ---------------------------------------------------------------------------

/**
 * `resolveConnectionAndToken` throws `AccountingMappingError` (a different
 * error hierarchy — Task 4's entity-mapping workbench). Only the two codes it
 * can actually raise are re-typed here; anything else is a bug and propagates
 * unchanged rather than being silently swallowed into a generic bucket.
 */
function translateMappingError(err: unknown): never {
  if (err instanceof AccountingMappingError) {
    if (err.code === 'not_connected') throw new AccountingInvoicePushError('not_connected', 404, err.message);
    if (err.code === 'reauth_required') throw new AccountingInvoicePushError('reauth_required', 409, err.message);
    // Any other AccountingMappingError code reaching here is unexpected at this
    // call site (resolveConnectionAndToken only ever raises the two above) —
    // surface it as a generic upstream failure rather than mis-typing it.
    throw new AccountingInvoicePushError('quickbooks_error', err.status, err.message);
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Loads (partner-guarded, direct — never reuses invoiceService.getInvoice,
// which does a Stripe lookup this coordinator has no reason to pay for).
// ---------------------------------------------------------------------------

async function loadOwnedInvoice(invoiceId: string, partnerId: string): Promise<InvoiceRow> {
  const rows = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.partnerId, partnerId)));
  const inv = (rows as InvoiceRow[])[0];
  if (!inv) throw new AccountingInvoicePushError('invoice_not_pushable', 404, 'Invoice not found for this partner');
  return inv;
}

/** ALL lines, including hidden/zero-priced bundle children — QuickBooks needs the whole document. */
async function loadInvoiceLinesOrdered(invoiceId: string): Promise<InvoiceLineRow[]> {
  const rows = await db
    .select()
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, invoiceId))
    .orderBy(invoiceLines.sortOrder);
  return rows as InvoiceLineRow[];
}

/**
 * Every mapping row of one type for this connection, partner-scoped at the SQL
 * level (mirrors accountingMappingService's `loadMappingRows`). Callers filter
 * to a single entity in JS — this stays a single query per entity TYPE
 * (org / catalog_item / invoice) rather than one query per invoice line.
 */
async function loadMappingRowsForType(
  partnerId: string,
  integrationId: string,
  breezeEntityType: PushMappingEntityType,
): Promise<MappingRow[]> {
  const rows = await db
    .select()
    .from(accountingEntityMappings)
    .where(and(
      eq(accountingEntityMappings.partnerId, partnerId),
      eq(accountingEntityMappings.integrationId, integrationId),
      eq(accountingEntityMappings.breezeEntityType, breezeEntityType),
    ));
  return rows as MappingRow[];
}

// ---------------------------------------------------------------------------
// Currency guard translation (realm-aware message; multi-currency §11)
// ---------------------------------------------------------------------------

function translateCurrencyError(err: unknown, conn: AccountingConnection): never {
  if (!(err instanceof AccountingCurrencyContractError)) throw err;

  if (err.code === 'ACCOUNTING_HOME_CURRENCY_UNKNOWN') {
    throw new AccountingInvoicePushError('home_currency_unknown', 409, err.message);
  }

  const label = conn.provider === 'xero' ? 'Xero' : 'QuickBooks';
  const home = normalizeCurrencyCode(conn.homeCurrency);
  // multiCurrencyEnabled is a tri-state cache of an external fact (nullable =
  // never captured) — only a confirmed `true` gets the "not yet supported"
  // framing; unknown and explicitly-false realms both get the "enable it or
  // invoice in the home currency" remediation, since Breeze cannot tell an
  // unknown realm apart from a single-currency one.
  const guidance = conn.multiCurrencyEnabled === true
    ? `${label} foreign-currency invoice push is not yet supported.`
    : `Enable multi-currency in ${label} or invoice in ${home ?? 'the connected home currency'}.`;

  throw new AccountingInvoicePushError('currency_mismatch', 409, `${err.message} ${guidance}`);
}

// ---------------------------------------------------------------------------
// Nested-sync failure translation (org/catalog-item dependency sync)
// ---------------------------------------------------------------------------

/**
 * `syncMappedEntity` can raise `AccountingMappingError` for reasons this
 * coordinator did not itself pre-check: `not_connected`/`reauth_required`
 * (the token expired between the outer resolve and this nested call),
 * `quickbooks_error` (a genuine QuickBooks/network failure, retryable), or one
 * of several PERMANENT pre-flight 409s (`income_account_required`,
 * `item_price_required`, a create-time `currency_mismatch` on the org/item
 * itself, `mapping_conflict`, `mapping_not_ready`, `entity_not_found`) —
 * config problems on the dependency mapping that no amount of retrying the
 * QuickBooks call will fix. The first two are re-typed to their exact
 * counterparts (mirrors `translateMappingError`); `quickbooks_error` passes
 * through unchanged; everything else collapses to `dependency_not_ready` so
 * it is never mistaken for a retryable `quickbooks_error`/502. Every message
 * here is already sanitized/user-safe — never a raw provider body.
 */
function translateNestedSyncError(err: unknown): never {
  if (err instanceof AccountingMappingError) {
    if (err.code === 'not_connected') throw new AccountingInvoicePushError('not_connected', 404, err.message);
    if (err.code === 'reauth_required') throw new AccountingInvoicePushError('reauth_required', 409, err.message);
    if (err.code === 'quickbooks_error') throw new AccountingInvoicePushError('quickbooks_error', 502, err.message);
    throw new AccountingInvoicePushError('dependency_not_ready', err.status === 404 ? 404 : 409, err.message);
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Failure taxonomy (local invoice-mapping equivalents of
// accountingMappingService's sanitizeSyncErrorMessage / markMappingError /
// persistRemoteRef / upsertMappingRow unique-violation handling).
// ---------------------------------------------------------------------------

function sanitizeInvoiceSyncErrorMessage(err: unknown): string {
  const status = err && typeof err === 'object' && typeof (err as { status?: unknown }).status === 'number'
    ? (err as { status: number }).status
    : undefined;
  return status ? `QuickBooks rejected the invoice sync (HTTP ${status})` : 'QuickBooks rejected the invoice sync';
}

async function markInvoiceMappingError(mappingId: string, partnerId: string, message: string): Promise<void> {
  try {
    const rows = await db
      .update(accountingEntityMappings)
      .set({ syncStatus: 'error', lastError: message, updatedAt: new Date() })
      .where(and(eq(accountingEntityMappings.id, mappingId), eq(accountingEntityMappings.partnerId, partnerId)))
      .returning();
    if (!(rows as unknown[])[0]) {
      captureException(
        new Error(`markInvoiceMappingError matched no accounting_entity_mappings row (id=${mappingId})`),
        undefined,
        { service: 'accountingInvoicePush', mappingId, partnerId },
      );
    }
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
      service: 'accountingInvoicePush', mappingId, partnerId,
    });
  }
}

/**
 * `markInvoiceMappingError` in its OWN short, self-committing transaction, and
 * still best-effort: `markInvoiceMappingError` already swallows a failed
 * UPDATE, but opening the context can fail too (pool exhaustion, a dead
 * connection), and that must not replace the caller's real typed error with a
 * raw one. Sentry has the original either way.
 */
async function markInvoiceMappingErrorInOwnContext(
  runInDbContext: DbContextRunner,
  mappingId: string,
  partnerId: string,
  message: string,
): Promise<void> {
  try {
    await runInDbContext(() => markInvoiceMappingError(mappingId, partnerId, message));
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
      service: 'accountingInvoicePush', mappingId, partnerId,
    });
  }
}

/**
 * Upserts the invoice's own mapping row to `syncStatus: 'pending'` BEFORE the
 * provider call — a create (no prior row) inserts `link_status: 'create_new'`;
 * a re-push (prior row, any status) updates in place so the provider is called
 * with the existing remoteEntityId/remoteSyncToken (sparse-update path) rather
 * than inserting a second row and colliding with the unique
 * (integrationId, breezeEntityType, breezeEntityId) index. A race that still
 * hits that index (two concurrent first-pushes) is caught and reported as a
 * typed conflict rather than a raw 500 — mirrors upsertMappingRow's
 * unique-violation handling in accountingMappingService.ts.
 */
async function upsertInvoiceMappingPending(params: {
  existing: MappingRow | null;
  integrationId: string;
  partnerId: string;
  invoiceId: string;
}): Promise<MappingRow> {
  try {
    if (params.existing) {
      const rows = await db
        .update(accountingEntityMappings)
        .set({ syncStatus: 'pending', lastError: null, updatedAt: new Date() })
        .where(and(
          eq(accountingEntityMappings.id, params.existing.id),
          eq(accountingEntityMappings.partnerId, params.partnerId),
        ))
        .returning();
      const row = (rows as MappingRow[])[0];
      if (!row) throw new Error(`invoice mapping pending-update matched no row (id=${params.existing.id})`);
      return row;
    }

    const rows = await db
      .insert(accountingEntityMappings)
      .values({
        integrationId: params.integrationId,
        partnerId: params.partnerId,
        breezeEntityType: 'invoice',
        breezeEntityId: params.invoiceId,
        remoteEntityType: 'Invoice',
        linkStatus: 'create_new',
        syncStatus: 'pending',
      })
      .returning();
    const row = (rows as MappingRow[])[0];
    if (!row) throw new Error('invoice mapping insert returned no row');
    return row;
  } catch (err) {
    if (isPgUniqueViolation(err, 'accounting_entity_mappings_breeze_uniq')) {
      throw new AccountingInvoicePushError(
        'quickbooks_error',
        502,
        'A concurrent QuickBooks sync for this invoice is already in progress; retry shortly',
      );
    }
    throw err;
  }
}

/**
 * Persists a successful QBO push. Zero-row UPDATE result means the remote
 * write SUCCEEDED but Breeze failed to record it — the caller must treat that
 * as non-retry-safe (mirrors accountingMappingService's persistRemoteRef).
 */
async function persistInvoiceRemoteRef(params: {
  mappingId: string;
  partnerId: string;
  remoteEntityId: string;
  remoteSyncToken: string | null;
  remoteDocNumber: string | null;
  syncStatus: 'synced' | 'synced_with_tax_variance';
}): Promise<MappingRow> {
  const rows = await db
    .update(accountingEntityMappings)
    .set({
      remoteEntityId: params.remoteEntityId,
      remoteSyncToken: params.remoteSyncToken,
      remoteDocNumber: params.remoteDocNumber,
      linkStatus: 'confirmed',
      syncStatus: params.syncStatus,
      lastSyncedAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(and(eq(accountingEntityMappings.id, params.mappingId), eq(accountingEntityMappings.partnerId, params.partnerId)))
    .returning();
  const row = (rows as MappingRow[])[0];
  if (!row) {
    throw new Error(`persistInvoiceRemoteRef matched no accounting_entity_mappings row (id=${params.mappingId}); refusing to lose the QuickBooks sync result`);
  }
  return row;
}

/** DB `numeric(12,2)` decimal strings — exact, no binary float rounding. */
function centsFromDecimalString(value: string): number {
  return Math.round(Number(value) * 100);
}

/** >1¢ absolute difference flags a tax variance; 1¢ or less is within tolerance. */
function computeTaxVariance(
  remoteTaxTotal: string | null,
  invoiceTaxTotal: string,
): { syncStatus: 'synced' | 'synced_with_tax_variance'; taxVarianceCents: number | null } {
  if (remoteTaxTotal === null) return { syncStatus: 'synced', taxVarianceCents: null };
  const diffCents = Math.abs(centsFromDecimalString(remoteTaxTotal) - centsFromDecimalString(invoiceTaxTotal));
  if (diffCents > 1) return { syncStatus: 'synced_with_tax_variance', taxVarianceCents: diffCents };
  return { syncStatus: 'synced', taxVarianceCents: null };
}

// ---------------------------------------------------------------------------
// Payload construction
// ---------------------------------------------------------------------------

function buildLinePayload(line: InvoiceLineRow): AccountingInvoiceLinePayload {
  return {
    invoiceLineId: line.id,
    // Legacy-line fallback mirrors invoiceService/invoicePdf's own
    // name-then-description title resolution.
    description: line.name ?? line.description ?? '',
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    lineTotal: line.lineTotal,
    taxable: line.taxable,
  };
}

function buildInvoicePayload(
  inv: InvoiceRow,
  lines: InvoiceLineRow[],
  customerRemoteId: string,
  customerSyncToken: string | null,
  invoiceMapping: MappingRow,
): AccountingInvoicePayload {
  return {
    invoiceId: inv.id,
    docNumber: inv.invoiceNumber,
    // Non-draft invoices are stamped with an issueDate at issue time; the
    // fallback only guards the type (string | null), it is not expected to
    // fire on a real pushable invoice.
    txnDate: inv.issueDate ?? new Date().toISOString().slice(0, 10),
    dueDate: inv.dueDate ?? null,
    customerRef: {
      id: customerRemoteId,
      syncToken: customerSyncToken ?? undefined,
    },
    currencyCode: inv.currencyCode,
    subtotal: inv.subtotal,
    taxTotal: inv.taxTotal,
    total: inv.total,
    lines: lines.map(buildLinePayload),
    mapping: invoiceMapping.remoteEntityId
      ? { remoteEntityId: invoiceMapping.remoteEntityId, remoteSyncToken: invoiceMapping.remoteSyncToken ?? null }
      : null,
  };
}

// ---------------------------------------------------------------------------
// pushInvoiceToAccounting
// ---------------------------------------------------------------------------

export async function pushInvoiceToAccounting(
  invoiceId: string,
  partnerId: string,
  runInDbContext: DbContextRunner,
): Promise<InvoicePushOutcome> {
  assertNoAmbientDbContext('pushInvoiceToAccounting');

  // ---- Phase 1: local loads + guards, one short self-committing context ----
  // No token is resolved here: the currency guard (and every other permanent
  // refusal) must be able to fire WITHOUT triggering a QuickBooks token
  // refresh for an invoice that can never be pushed.
  const prep = await runInDbContext(async () => {
    const conn = await resolveConnection(partnerId, 'quickbooks').catch(translateMappingError);

    const inv = await loadOwnedInvoice(invoiceId, partnerId);
    if (inv.invoiceNumber === null || !PUSHABLE_STATUSES.has(inv.status)) {
      // Covers both a draft (never issued) and a void invoice — void pushes go
      // through voidInvoiceInAccounting, never this entrypoint.
      throw new AccountingInvoicePushError(
        'invoice_not_pushable',
        409,
        'Invoice must be issued and not void before it can be pushed to QuickBooks',
      );
    }

    // Currency guard runs BEFORE any org/item lookup, token refresh or provider
    // call (multi-currency §11 contract, accountingCurrency.ts:143-186).
    try {
      assertAccountingInvoicePushCurrency(conn, { currencyCode: inv.currencyCode });
    } catch (err) {
      translateCurrencyError(err, conn);
    }

    const lines = await loadInvoiceLinesOrdered(inv.id);

    const orgMappingRows = await loadMappingRowsForType(partnerId, conn.id, 'org');
    const orgMapping = orgMappingRows.find((m) => m.breezeEntityId === inv.orgId) ?? null;
    if (!orgMapping || orgMapping.linkStatus === 'unlinked' || orgMapping.linkStatus === 'suggested') {
      throw new AccountingInvoicePushError(
        'customer_not_mapped',
        409,
        'This organization is not mapped to a QuickBooks customer yet — confirm or create a mapping first',
      );
    }
    if (
      orgMapping.remoteCurrencyCode
      && normalizeCurrencyCode(orgMapping.remoteCurrencyCode) !== normalizeCurrencyCode(inv.currencyCode)
    ) {
      throw new AccountingInvoicePushError(
        'customer_currency_mismatch',
        409,
        `The QuickBooks customer for this organization is stamped in ${orgMapping.remoteCurrencyCode}, which does not match this invoice's ${inv.currencyCode} currency`,
      );
    }

    const itemMappingRows = await loadMappingRowsForType(partnerId, conn.id, 'catalog_item');
    return { conn, inv, lines, orgMapping, itemMappingRows };
  });

  const { conn, inv, lines } = prep;

  // ---- Dependency syncs: each opens its own short phases internally ----
  let orgMapping = prep.orgMapping;
  if (orgMapping.syncStatus !== 'synced') {
    orgMapping = await syncMappedEntity({
      partnerId, provider: 'quickbooks', breezeEntityType: 'org', breezeEntityId: inv.orgId,
    }, runInDbContext).catch(translateNestedSyncError);
  }
  const customerRemoteId = orgMapping.remoteEntityId;
  if (!customerRemoteId) {
    throw new AccountingInvoicePushError('customer_not_mapped', 409, 'QuickBooks customer sync did not return a remote id');
  }
  const customerSyncToken = orgMapping.remoteSyncToken ?? null;

  const itemMappingByItemId = new Map(prep.itemMappingRows.map((m) => [m.breezeEntityId, m]));

  const lineMappings: AccountingInvoiceLineMapping[] = [];
  for (const line of lines) {
    const rawItemMapping = line.catalogItemId ? itemMappingByItemId.get(line.catalogItemId) ?? null : null;
    const isMapped = !!rawItemMapping && rawItemMapping.linkStatus !== 'unlinked' && rawItemMapping.linkStatus !== 'suggested';
    let itemMapping: MappingRow | null = isMapped ? rawItemMapping : null;

    if (itemMapping && itemMapping.syncStatus !== 'synced' && line.catalogItemId) {
      itemMapping = await syncMappedEntity({
        partnerId, provider: 'quickbooks', breezeEntityType: 'catalog_item', breezeEntityId: line.catalogItemId,
      }, runInDbContext).catch(translateNestedSyncError);
      // Two lines can reference the same catalog item (e.g. a bundle sold
      // twice on one invoice) — write the synced result back so a LATER line
      // for the same item reuses it instead of re-syncing (and re-hitting
      // QuickBooks) against the same still-stale map entry.
      itemMappingByItemId.set(line.catalogItemId, itemMapping);
    }

    lineMappings.push({
      invoiceLineId: line.id,
      remoteItemRef: itemMapping && itemMapping.remoteEntityId
        ? { id: itemMapping.remoteEntityId, syncToken: itemMapping.remoteSyncToken ?? undefined }
        : null,
    });
  }

  // ---- Phase 1b: claim the invoice mapping row as `pending`. COMMITS. ----
  // Its own context on purpose: this row is the durable "a push is in flight"
  // marker `voidInvoiceInAccounting` reads, and the row Phase 2 stamps with
  // either the remote ref or the error. Rolled back with the caller it marks
  // nothing at all.
  const mappingRow = await runInDbContext(async () => {
    const invoiceMappingRows = await loadMappingRowsForType(partnerId, conn.id, 'invoice');
    const existingInvoiceMapping = invoiceMappingRows.find((m) => m.breezeEntityId === inv.id) ?? null;
    return upsertInvoiceMappingPending({
      existing: existingInvoiceMapping,
      integrationId: conn.id,
      partnerId,
      invoiceId: inv.id,
    });
  });

  // Token refresh runs with NO context held — `resolveLiveConnection` asserts
  // that and opens its own short system transactions (accountingTokens.ts).
  const liveConn = await resolveLiveConnection(conn).catch(translateMappingError);

  const payload = buildInvoicePayload(inv, lines, customerRemoteId, customerSyncToken, mappingRow);
  const providerImpl = getAccountingProvider(conn.provider);

  let result: InvoicePushResult;
  try {
    result = await runOutsideDbContext(() => providerImpl.pushInvoice(liveConn, payload, lineMappings));
  } catch (err) {
    const message = sanitizeInvoiceSyncErrorMessage(err);
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
      service: 'accountingInvoicePush', mappingId: mappingRow.id, invoiceId: inv.id,
    });
    // Phase 2 (failure) — own short context so the marker COMMITS before the throw.
    await markInvoiceMappingErrorInOwnContext(runInDbContext, mappingRow.id, partnerId, message);
    throw new AccountingInvoicePushError('quickbooks_error', 502, message);
  }

  const variance = computeTaxVariance(result.remoteTaxTotal, inv.taxTotal);
  const remoteDocNumber = result.docNumber && result.docNumber !== inv.invoiceNumber ? result.docNumber : null;

  // ---- Phase 2 (success): record the remote ref, then reconcile a void race ----
  let persisted: MappingRow;
  try {
    persisted = await runInDbContext(() => persistInvoiceRemoteRef({
      mappingId: mappingRow.id,
      partnerId,
      remoteEntityId: result.id,
      remoteSyncToken: result.syncToken ?? null,
      remoteDocNumber,
      syncStatus: variance.syncStatus,
    }));
  } catch (dbErr) {
    captureException(dbErr instanceof Error ? dbErr : new Error(String(dbErr)), undefined, {
      service: 'accountingInvoicePush', mappingId: mappingRow.id, remoteEntityId: result.id,
    });
    const message = `QuickBooks accepted the invoice sync (remote id ${result.id}) but Breeze failed to record it — do not retry; contact support to reconcile`;
    // Best-effort: the row is currently stuck at sync_status='pending' with no
    // remote id, which a stale-pending reaper would re-push and duplicate the
    // QuickBooks invoice. markInvoiceMappingError is a separate UPDATE in its
    // own context (the one above already failed/returned zero rows) — if THIS
    // one also fails, it no-ops silently and the Sentry capture above is the
    // only backstop, same as every other best-effort mark-error call here.
    await markInvoiceMappingErrorInOwnContext(runInDbContext, mappingRow.id, partnerId, message);
    throw new AccountingInvoicePushError('record_failed', 502, message);
  }

  // The invoice can be voided while this push is mid-flight: the void job saw
  // a `pending` row with no remote id, threw `sync_in_progress` and is backing
  // off. Now that the remote id IS recorded, re-read the status and re-enqueue
  // the void ourselves so QuickBooks does not keep a voided invoice open.
  // Imported lazily: `accountingSyncWorker` imports THIS module, so a static
  // import would be a cycle (and would drag BullMQ/Redis into every unit test
  // of the coordinator).
  const becameVoid = await runInDbContext(async () => {
    const rows = await db
      .select({ status: invoices.status })
      .from(invoices)
      .where(and(eq(invoices.id, inv.id), eq(invoices.partnerId, partnerId)));
    return (rows as Array<{ status: string }>)[0]?.status === 'void';
  });
  if (becameVoid) {
    const { enqueueAccountingInvoiceVoid } = await import('../../jobs/accountingSyncWorker');
    await enqueueAccountingInvoiceVoid(inv.id, partnerId);
  }

  // Fan out this invoice's payments (spec decision 10). Runs in BOTH modes: in
  // `manual` it is the ONLY way payments reach QuickBooks, and in `auto` it
  // catches payments recorded while this push was still in flight — their own
  // `requestPaymentPush` returned null because the invoice had no remote id yet.
  // The COORDINATOR is a plain static import (accountingPaymentPush does not
  // import this module); only the ENQUEUE is lazy, for the same reason the void
  // enqueue above is — accountingSyncWorker imports THIS module, so a static
  // import of it would be a cycle (and would drag BullMQ/Redis into every unit
  // test of the coordinator).
  // Best-effort: the invoice push has already landed and been recorded, so
  // failing here would report an error for work that succeeded and send the
  // caller's retry back down the create path. The reconcile sweep re-enqueues
  // any mapping row this leaves pending.
  try {
    const owed = await fanOutOwedPayments(inv.id, partnerId, runInDbContext);
    if (owed.length > 0) {
      const { enqueueAccountingPaymentPush } = await import('../../jobs/accountingSyncWorker');
      for (const mappingId of owed) await enqueueAccountingPaymentPush(mappingId, partnerId);
    }
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
      service: 'accountingInvoicePush', invoiceId: inv.id, phase: 'payment-fan-out',
    });
  }

  return {
    mappingId: persisted.id,
    // Straight from the just-succeeded provider result, not re-read off
    // `persisted` — the mapping row's remoteEntityId column is nullable by
    // schema (it's null before any sync), so `result.id` (typed non-null on
    // InvoicePushResult) is the source of truth here, not a cast.
    remoteEntityId: result.id,
    docNumber: persisted.remoteDocNumber ?? inv.invoiceNumber,
    syncStatus: variance.syncStatus,
    taxVarianceCents: variance.taxVarianceCents,
  };
}

// ---------------------------------------------------------------------------
// voidInvoiceInAccounting
// ---------------------------------------------------------------------------

/**
 * No-op if the invoice was never pushed (no mapping row, or one with no
 * remoteEntityId and not mid-push). Same phase split and same no-ambient-context
 * contract as `pushInvoiceToAccounting` above.
 */
export async function voidInvoiceInAccounting(
  invoiceId: string,
  partnerId: string,
  runInDbContext: DbContextRunner,
): Promise<void> {
  assertNoAmbientDbContext('voidInvoiceInAccounting');

  const prep = await runInDbContext(async () => {
    const conn = await resolveConnection(partnerId, 'quickbooks').catch(translateMappingError);

    const invoiceMappingRows = await loadMappingRowsForType(partnerId, conn.id, 'invoice');
    const mappingRow = invoiceMappingRows.find((m) => m.breezeEntityId === invoiceId) ?? null;
    if (!mappingRow) return null;
    if (!mappingRow.remoteEntityId) {
      // A `pending` row with no remote id means a push is IN FLIGHT right now:
      // its Phase 1b claimed the row and its Phase 2 has not landed the remote
      // id yet. Voiding "nothing" here would leave the invoice open in
      // QuickBooks forever once that push completes. Deliberately NON-terminal
      // (absent from the worker's TERMINAL_CODES) so BullMQ retries with
      // backoff and picks up the remote id on a later attempt. Any other
      // status with no remote id (notably `error`) really never reached
      // QuickBooks, so it stays a no-op.
      if (mappingRow.syncStatus === 'pending') {
        throw new AccountingInvoicePushError(
          'sync_in_progress',
          409,
          'A QuickBooks push for this invoice is still in flight; the void will be retried once it completes',
        );
      }
      return null;
    }

    const inv = await loadOwnedInvoice(invoiceId, partnerId);
    return { conn, mappingRow, inv };
  });
  if (!prep) return;

  const { conn, mappingRow, inv } = prep;
  const liveConn = await resolveLiveConnection(conn).catch(translateMappingError);
  const providerImpl = getAccountingProvider(conn.provider);

  const voidPayload: AccountingVoidInvoicePayload = {
    invoiceId: inv.id,
    docNumber: mappingRow.remoteDocNumber ?? inv.invoiceNumber,
    currencyCode: inv.currencyCode,
  };
  const mappingSeam: AccountingEntityMappingSeam = {
    remoteEntityId: mappingRow.remoteEntityId as string,
    remoteSyncToken: mappingRow.remoteSyncToken ?? null,
  };

  try {
    await runOutsideDbContext(() => providerImpl.voidInvoice(liveConn, voidPayload, mappingSeam));
  } catch (err) {
    const message = sanitizeInvoiceSyncErrorMessage(err);
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
      service: 'accountingInvoicePush', mappingId: mappingRow.id, invoiceId,
    });
    // Own short context so the marker COMMITS before the throw below.
    await markInvoiceMappingErrorInOwnContext(runInDbContext, mappingRow.id, partnerId, message);
    throw new AccountingInvoicePushError('quickbooks_error', 502, message);
  }
  // Success: sync_status/last_error are left exactly as they were (still
  // 'synced'/null from the original push) — a void does not change whether
  // the invoice's LAST sync succeeded, and there is no new remote state to
  // record beyond what QuickBooks already reflects.
}
