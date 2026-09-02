import { createHmac, timingSafeEqual } from 'crypto';
import { toMinorUnits } from '@breeze/shared';
import { runOutsideDbContext } from '../../db';
import { captureException } from '../sentry';
import { QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REDIRECT_URI } from '../../config/env';
import type {
  AccountingCustomerPayload,
  AccountingDeletePaymentPayload,
  AccountingEntityMapping,
  AccountingInvoiceLineMapping,
  AccountingInvoicePayload,
  AccountingItemPayload,
  AccountingPaymentPayload,
  AccountingProvider,
  AccountingVoidInvoicePayload,
  ChangeSet,
  ChangeSetPaymentLine,
  ConnectionTokens,
  InvoicePushResult,
  PaymentDeleteResult,
  RealmSettings,
  RemoteAddress,
  RemoteCustomer,
  RemoteIncomeAccount,
  RemoteItem,
  RemoteRef,
} from './types';
import type { AccountingConnection } from './accountingConnectionService';
import { parseBreezePaymentMarker } from './accountingPaymentMarker';

const QBO_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QBO_SCOPE = 'com.intuit.quickbooks.accounting';
const QBO_API_MINOR_VERSION = '70';
const QBO_QUERY_PAGE_SIZE = 1000; // QBO hard cap per query page

/**
 * Abort budget for the OPTIONAL home-currency capture. It is awaited inline in
 * the OAuth callback, before the state cookie is cleared and the browser is
 * redirected, so undici's ~300s headers timeout would park the connecting user
 * on a blank /callback for five minutes over a capture that is non-fatal by
 * design. It stays inline rather than fire-and-forget so the compare-and-set
 * still runs against the generation the callback just wrote (a queued job would
 * have to re-derive it), which means the budget has to be short enough that a
 * hung Intuit is invisible: a few seconds beyond a normal Preferences round-trip
 * (sub-second) and well inside a user's patience for a redirect.
 */
export const QBO_PREFERENCES_TIMEOUT_MS = 8_000;

/** QBO's CDC lookback limit — a `changedSince` older than this is rejected/meaningless. */
export const QBO_CDC_LOOKBACK_DAYS = 30;
/** Re-read this far behind the stored cursor so a payment written mid-window is never missed. */
export const QBO_CDC_CURSOR_SLACK_MS = 5 * 60 * 1000;
/**
 * Cap on `/query` backfill pages per overflowing entity (final-review finding
 * A). Plan decision 3 originally halved the CDC window on an overflow, which
 * CANNOT work: QBO's `/cdc` operation accepts only `changedSince` and has no
 * upper bound, so the "left half" re-issued a BYTE-IDENTICAL request, the
 * recursion bottomed out at its depth cap, and the truncated result was
 * returned as if complete — with the cursor advancing past everything QBO had
 * withheld. The overflowing entity is now re-read through the `/query`
 * endpoint, which DOES page (`startposition`/`maxresults`).
 *
 * At 1000 rows a page this is 50k changed entities in one 15-minute window for
 * one realm; past it the run reports `overflowed` and the worker holds the
 * cursor rather than pretending the window was drained.
 */
export const QBO_CDC_QUERY_MAX_PAGES = 50;

function qboApiBase(environment: 'sandbox' | 'production'): string {
  return environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

interface QboRawAddress {
  Line1?: string; Line2?: string; City?: string;
  CountrySubDivisionCode?: string; PostalCode?: string; Country?: string;
}

interface QboRawCustomer {
  Id: string;
  SyncToken?: string;
  DisplayName?: string;
  CompanyName?: string;
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
  GivenName?: string;
  FamilyName?: string;
  Active?: boolean;
  BillAddr?: QboRawAddress;
  ShipAddr?: QboRawAddress;
  /** Present on both query rows and create responses (multi-currency §11). */
  CurrencyRef?: { value?: string };
}

/**
 * Builds the DELIBERATELY sanitized preferences error (multi-currency §11).
 * This error is handed to captureException by the OAuth callback and a QBO
 * fault body — or a proxy's HTML error page — can carry realm/company/customer
 * detail, so only the status and the operation ever travel.
 */
function preferencesError(status: number | null, reason: string): Error & { status?: number; operation: string } {
  const err = new Error(
    status === null
      ? `QuickBooks preferences request ${reason}`
      : `QuickBooks preferences request ${reason} (status ${status})`,
  ) as Error & { status?: number; operation: string };
  if (status !== null) err.status = status;
  err.operation = 'fetchRealmSettings';
  return err;
}

/**
 * QBO Preferences response. `HomeCurrency` is a REFERENCE object, so the code
 * lives at `.value` — and it comes from Preferences, never CompanyInfo
 * (multi-currency §11).
 */
export interface QboRawPreferences {
  Preferences?: {
    CurrencyPrefs?: {
      HomeCurrency?: { value?: string | null } | null;
      MultiCurrencyEnabled?: unknown;
    } | null;
  };
}

/**
 * Normalizes the realm's home currency to an uppercase three-letter code.
 * Deliberately NOT validated against Breeze's curated supported-currency list:
 * a realm may legitimately run a currency Breeze cannot bill in, and that must
 * stay connectable — the invoice-push guard blocks it later instead.
 */
export function mapQboHomeCurrency(raw: QboRawPreferences): string | null {
  const value = raw.Preferences?.CurrencyPrefs?.HomeCurrency?.value;
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

/**
 * Reads whether the realm has multi-currency enabled. A non-boolean value
 * (missing field, or an unexpected shape from a proxy/WAF response) coerces
 * to null ("unknown") rather than persisting junk.
 */
export function mapQboMultiCurrencyEnabled(raw: QboRawPreferences): boolean | null {
  const value = raw.Preferences?.CurrencyPrefs?.MultiCurrencyEnabled;
  return typeof value === 'boolean' ? value : null;
}

interface QboRawInvoice {
  Id: string;
  SyncToken?: string;
  DocNumber?: string;
  TotalAmt?: number;
  TxnTaxDetail?: { TotalTax?: number };
}

interface QboRawItem {
  Id: string;
  Name?: string;
  Sku?: string;
  Description?: string;
  Type?: string;
  UnitPrice?: number;
  Active?: boolean;
  SyncToken?: string;
}

interface QboRawAccount {
  Id: string;
  Name?: string;
  AccountType?: string;
  AccountSubType?: string;
  Active?: boolean;
}

interface QboRawPaymentLine {
  Amount?: number;
  LinkedTxn?: { TxnId?: string; TxnType?: string }[];
}

interface QboRawCdcPayment {
  Id: string;
  status?: string;
  SyncToken?: string;
  TxnDate?: string;
  TotalAmt?: number;
  CurrencyRef?: { value?: string };
  PaymentMethodRef?: { name?: string };
  PaymentRefNum?: string;
  PrivateNote?: string;
  Line?: QboRawPaymentLine[];
}

interface QboRawCdcInvoice {
  Id: string;
  status?: string;
  TotalAmt?: number;
  Balance?: number;
  PrivateNote?: string;
}

/** One `CDCResponse[].QueryResponse[]` entity block — entity arrays keyed by
 *  entity name, alongside optional QBO paging metadata for that block. */
interface QboCdcEntityBlock {
  Payment?: QboRawCdcPayment[];
  Invoice?: QboRawCdcInvoice[];
  startPosition?: number;
  maxResults?: number;
  totalCount?: number;
}

interface QboCdcResponse {
  CDCResponse?: { QueryResponse?: QboCdcEntityBlock[] }[];
  time?: string;
}

/**
 * The Invoice-linked lines a CDC-reported Payment carries RIGHT NOW.
 *
 * An EMPTY result does NOT mean the Payment was deleted (final-review finding
 * C1). QBO zeroes a voided Payment (`TotalAmt` 0) and leaves an unapplied one
 * with no Invoice `LinkedTxn` — in both cases the Payment still EXISTS, and the
 * only entity QBO ever reports as gone is one carrying `status: "Deleted"`,
 * which the callers classify before they get here. So an empty line set is
 * delivered as a LIVE payment with no allocations (`unappliedPayments`), which
 * the applier reconciles through `reverseStaleAllocations` with an empty
 * keep-set: identical to a deletion for a QuickBooks-origin mirror row, but a
 * Breeze-origin row keeps the remote id and SyncToken its own pending delete
 * still needs.
 */
export function mapQboCdcPayment(raw: QboRawCdcPayment, conn: AccountingConnection): ChangeSetPaymentLine[] {
  const currency = raw.CurrencyRef?.value ?? conn.homeCurrency ?? '';
  const invoiceLines = (raw.Line ?? []).flatMap((line) => {
    const invoiceTxnId = (line.LinkedTxn ?? []).find((txn) => txn.TxnType === 'Invoice')?.TxnId;
    return invoiceTxnId ? [{ line, invoiceTxnId }] : [];
  });
  if (raw.TotalAmt === 0 || invoiceLines.length === 0) return [];

  return invoiceLines.map(({ line, invoiceTxnId }) => ({
    remoteInvoiceId: invoiceTxnId,
    remotePaymentId: raw.Id,
    amountMinor: toMinorUnits(line.Amount ?? 0, currency),
    currency,
    txnDate: raw.TxnDate ?? '',
    remotePaymentSyncToken: raw.SyncToken ?? null,
    paymentMethodName: raw.PaymentMethodRef?.name ?? null,
    paymentRefNum: raw.PaymentRefNum ?? null,
    // Anchored whole-note match only — an operator-authored note that merely
    // mentions a Breeze id must never claim a Breeze payment row.
    breezePaymentId: parseBreezePaymentMarker(raw.PrivateNote),
  }));
}

function isDeletedOrVoidedInvoice(raw: QboRawCdcInvoice): boolean {
  if (raw.status === 'Deleted') return true;
  return raw.TotalAmt === 0 && raw.Balance === 0 && typeof raw.PrivateNote === 'string' && raw.PrivateNote.includes('Voided');
}

/**
 * `qboRequest` attaches `{ status, body }` (body truncated to 500 chars) to a
 * non-2xx error. Intuit's fault CODES are the stable signal — the Message text
 * is localized and has changed between minor versions — so match the code first
 * and keep the text as a belt-and-braces fallback.
 */
function qboFaultBody(err: unknown): string {
  return err && typeof err === 'object' && typeof (err as { body?: unknown }).body === 'string'
    ? (err as { body: string }).body
    : '';
}

/** QBO fault 610 — the object does not exist (already deleted, or never was). */
function isQboObjectNotFound(err: unknown): boolean {
  const body = qboFaultBody(err);
  return /"code"\s*:\s*"610"/.test(body) || /Object Not Found/i.test(body);
}

/** QBO fault 5010 — the object exists but our SyncToken is behind. */
function isQboStaleObject(err: unknown): boolean {
  const body = qboFaultBody(err);
  return /"code"\s*:\s*"5010"/.test(body) || /Stale Object/i.test(body);
}

/** The two entities Phase D reconciles. */
type CdcEntity = 'Payment' | 'Invoice';

/** Result of one CDC request over one [changedSince, now] window — private to the provider. */
interface CdcWindowResult {
  payments: ChangeSetPaymentLine[];
  deletedPayments: string[];
  /** Alive, but settling no invoice — voided or unapplied (see `ChangeSet`). */
  unappliedPayments: string[];
  deletedInvoices: string[];
  /**
   * Entities whose CDC block reported `totalCount` greater than the array it
   * actually returned — i.e. QBO truncated the change list for that entity and
   * the window was NOT fully enumerated. Each one is re-read through `/query`
   * (see `backfillOverflowedEntity`).
   */
  overflowedEntities: CdcEntity[];
  /**
   * Parsed `CDCResponse[].time` — QBO's own server clock for this read, which is
   * what gets stored as the next cursor (spec: "the response's server time, not
   * ours"). Null when the response omitted it or it failed to parse; the caller
   * falls back to its own local clock in that case.
   */
  responseTime: Date | null;
}

/** Parses `parsed.time` into a Date, or null when absent/unparseable. */
function parseCdcResponseTime(time: string | undefined): Date | null {
  if (!time) return null;
  const parsed = new Date(time);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Folds a completed `/query` re-enumeration of ONE entity back into the CDC
 * window result, IN PLACE.
 *
 * The `/query` rows are AUTHORITATIVE for every entity id they cover — they are
 * the entity's current state, read after the truncated CDC list. So a payment
 * the backfill returns has its CDC-derived lines DISCARDED and rebuilt, rather
 * than merged line-by-line: merging would let an allocation QuickBooks has since
 * removed survive as a stale CDC line that the applier would then re-apply.
 *
 * Entity ids the backfill does NOT cover keep whatever CDC reported — most
 * importantly the deletion lists, since `/query` never returns deleted rows.
 */
function mergeQueryBackfill(
  window: CdcWindowResult,
  entity: CdcEntity,
  rows: QboRawCdcPayment[] | QboRawCdcInvoice[],
  conn: AccountingConnection,
): void {
  if (entity === 'Invoice') {
    const deleted = new Set(window.deletedInvoices);
    for (const raw of rows as QboRawCdcInvoice[]) {
      if (isDeletedOrVoidedInvoice(raw)) deleted.add(raw.Id);
    }
    window.deletedInvoices = [...deleted];
    return;
  }

  const raws = rows as QboRawCdcPayment[];
  const covered = new Set(raws.map((raw) => raw.Id));
  window.payments = window.payments.filter((p) => !covered.has(p.remotePaymentId));
  const deleted = new Set(window.deletedPayments);
  const unapplied = new Set(window.unappliedPayments);
  for (const raw of raws) {
    // `/query` never returns a DELETED entity, so every id it covers is alive —
    // whatever the truncated CDC list said about it.
    deleted.delete(raw.Id);
    const lines = mapQboCdcPayment(raw, conn);
    if (lines.length === 0) { unapplied.add(raw.Id); continue; }
    unapplied.delete(raw.Id);
    window.payments.push(...lines);
  }
  window.deletedPayments = [...deleted];
  window.unappliedPayments = [...unapplied];
}

export function mapQboAddress(raw: QboRawAddress | undefined): RemoteAddress | undefined {
  if (!raw) return undefined;
  const addr: RemoteAddress = {
    line1: raw.Line1 || undefined,
    line2: raw.Line2 || undefined,
    city: raw.City || undefined,
    region: raw.CountrySubDivisionCode || undefined,
    postalCode: raw.PostalCode || undefined,
    country: raw.Country || undefined,
  };
  return Object.values(addr).some((v) => v !== undefined) ? addr : undefined;
}

export function mapQboCustomer(raw: QboRawCustomer): RemoteCustomer {
  const contactName = [raw.GivenName, raw.FamilyName].filter(Boolean).join(' ').trim();
  return {
    id: raw.Id,
    displayName: raw.DisplayName || raw.CompanyName || raw.Id,
    companyName: raw.CompanyName || undefined,
    email: raw.PrimaryEmailAddr?.Address || undefined,
    phone: raw.PrimaryPhone?.FreeFormNumber || undefined,
    contactName: contactName || undefined,
    active: raw.Active,
    billAddr: mapQboAddress(raw.BillAddr),
    shipAddr: mapQboAddress(raw.ShipAddr),
    syncToken: raw.SyncToken,
    currencyCode: raw.CurrencyRef?.value || undefined,
  };
}

function mapRemoteItem(raw: QboRawItem): RemoteItem {
  return {
    id: raw.Id,
    displayName: raw.Name || raw.Id,
    sku: raw.Sku || undefined,
    description: raw.Description || undefined,
    type: raw.Type,
    unitPrice: raw.UnitPrice,
    active: raw.Active,
    syncToken: raw.SyncToken,
  };
}

function mapRemoteIncomeAccount(raw: QboRawAccount): RemoteIncomeAccount {
  return {
    id: raw.Id,
    displayName: raw.Name || raw.Id,
    accountType: raw.AccountType || 'Income',
    accountSubType: raw.AccountSubType || undefined,
  };
}

function mapAddressToQbo(address: RemoteAddress | undefined): Record<string, string | undefined> | undefined {
  if (!address) return undefined;
  const result = {
    Line1: address.line1,
    Line2: address.line2,
    City: address.city,
    CountrySubDivisionCode: address.region,
    PostalCode: address.postalCode,
    Country: address.country,
  };
  return Object.values(result).some((value) => value !== undefined) ? result : undefined;
}

interface QboTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  x_refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

export class QuickbooksProvider implements AccountingProvider {
  readonly provider = 'quickbooks' as const;

  buildAuthUrl(state: string): string {
    const url = new URL(QBO_AUTH_URL);
    url.searchParams.set('client_id', QBO_CLIENT_ID);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', QBO_SCOPE);
    url.searchParams.set('redirect_uri', QBO_REDIRECT_URI);
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeCode(code: string, realmId: string): Promise<ConnectionTokens> {
    return this.requestTokens('authorization_code', { code, realmId });
  }

  async refresh(refreshToken: string): Promise<ConnectionTokens> {
    return this.requestTokens('refresh_token', { refreshToken, realmId: '' });
  }

  // NOTE: assumes `conn.accessToken` is already a VALID token. Callers must
  // resolve it via getValidAccessToken(db, conn) first (which refreshes +
  // persists rotation) — this method stays pure HTTP and issues no DB queries.
  async listRemoteCustomers(conn: AccountingConnection): Promise<RemoteCustomer[]> {
    const customers: RemoteCustomer[] = [];
    let startPosition = 1;

    // Page until a short page (< page size) signals the end.
    for (;;) {
      const query = `SELECT * FROM Customer STARTPOSITION ${startPosition} MAXRESULTS ${QBO_QUERY_PAGE_SIZE}`;
      const parsed = await this.qboRequest<{ QueryResponse?: { Customer?: QboRawCustomer[] } }>(
        conn,
        `query?query=${encodeURIComponent(query)}&minorversion=${QBO_API_MINOR_VERSION}`,
        'QuickBooks customer query',
      );
      const page = parsed.QueryResponse?.Customer ?? [];
      for (const raw of page) customers.push(mapQboCustomer(raw));
      if (page.length < QBO_QUERY_PAGE_SIZE) break;
      startPosition += QBO_QUERY_PAGE_SIZE;
    }

    return customers;
  }

  async listRemoteItems(conn: AccountingConnection, _query?: string): Promise<RemoteItem[]> {
    const items: RemoteItem[] = [];
    let startPosition = 1;
    for (;;) {
      const query = `SELECT * FROM Item STARTPOSITION ${startPosition} MAXRESULTS ${QBO_QUERY_PAGE_SIZE}`;
      const parsed = await this.qboRequest<{ QueryResponse?: { Item?: QboRawItem[] } }>(
        conn,
        `query?query=${encodeURIComponent(query)}&minorversion=${QBO_API_MINOR_VERSION}`,
        'QuickBooks item query',
      );
      const page = parsed.QueryResponse?.Item ?? [];
      items.push(...page.map(mapRemoteItem));
      if (page.length < QBO_QUERY_PAGE_SIZE) break;
      startPosition += QBO_QUERY_PAGE_SIZE;
    }
    return items;
  }

  // NOTE: like listRemoteCustomers, this assumes `conn.accessToken` is already
  // valid and issues no DB queries. The fetch runs OUTSIDE any DB context so a
  // QBO round-trip never holds a pooled connection (#1105 class).
  async fetchRealmSettings(conn: AccountingConnection): Promise<RealmSettings> {
    if (!conn.realmId) throw new Error('QuickBooks connection is missing a realmId');
    if (!conn.accessToken) throw new Error('QuickBooks connection is missing an access token');

    const url = `${qboApiBase(conn.environment)}/v3/company/${conn.realmId}/preferences?minorversion=${QBO_API_MINOR_VERSION}`;
    // An explicit controller rather than AbortSignal.timeout so the timer is
    // cleared on the normal path and the abort reason is a sanitized error.
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(preferencesError(null, 'timed out')),
      QBO_PREFERENCES_TIMEOUT_MS,
    );
    let response: Response;
    try {
      response = await runOutsideDbContext(() =>
        fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${conn.accessToken}`,
            Accept: 'application/json',
          },
          signal: controller.signal,
        })
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // Sanitized, unlike listRemoteCustomers. The body is never read — but it
      // must still be discarded, or undici holds the connection open until GC.
      await response.body?.cancel().catch(() => {});
      throw preferencesError(response.status, 'failed');
    }

    // Guarded: a proxy/WAF can answer 200 with an HTML page, and the SyntaxError
    // from an unguarded .json() embeds a snippet of that body in its message —
    // which the OAuth callback would hand straight to captureException, defeating
    // the sanitization above.
    let parsed: QboRawPreferences;
    try {
      parsed = await response.json() as QboRawPreferences;
    } catch {
      throw preferencesError(response.status, 'returned a non-JSON body');
    }
    return {
      homeCurrency: mapQboHomeCurrency(parsed),
      multiCurrencyEnabled: mapQboMultiCurrencyEnabled(parsed),
    };
  }

  async listRemoteIncomeAccounts(conn: AccountingConnection): Promise<RemoteIncomeAccount[]> {
    const accounts: RemoteIncomeAccount[] = [];
    let startPosition = 1;
    for (;;) {
      const query = `SELECT * FROM Account WHERE AccountType = 'Income' AND Active = true STARTPOSITION ${startPosition} MAXRESULTS ${QBO_QUERY_PAGE_SIZE}`;
      const parsed = await this.qboRequest<{ QueryResponse?: { Account?: QboRawAccount[] } }>(
        conn,
        `query?query=${encodeURIComponent(query)}&minorversion=${QBO_API_MINOR_VERSION}`,
        'QuickBooks income account query',
      );
      const page = parsed.QueryResponse?.Account ?? [];
      accounts.push(...page.map(mapRemoteIncomeAccount));
      if (page.length < QBO_QUERY_PAGE_SIZE) break;
      startPosition += QBO_QUERY_PAGE_SIZE;
    }
    return accounts;
  }

  async upsertCustomer(
    conn: AccountingConnection,
    customer: AccountingCustomerPayload,
    mapping: AccountingEntityMapping | null,
  ): Promise<RemoteRef> {
    if (mapping && !mapping.remoteSyncToken) {
      throw new Error('QuickBooks Customer update requires the current SyncToken');
    }
    // CurrencyRef is deliberately NOT sent — sending it to a single-currency
    // realm is a QBO error, so the realm default is what a create gets. What
    // makes that safe is the CREATE-path guard in accountingMappingService.ts
    // (`assertCreateCurrencyMatchesRealm`, called from `syncMappedEntity`
    // before this method is reached): it refuses to create a Customer/Item
    // whose Breeze-stamped currency is not the connection's captured
    // `homeCurrency`, and refuses outright when that home currency is unknown.
    // Phase C's `assertAccountingInvoicePushCurrency` is the matching guard on
    // the invoice-push path; neither one gates an UPDATE, because QBO fixes
    // CurrencyRef at creation and a sparse update cannot change it.
    const payload = {
      ...(mapping ? {
        sparse: true,
        Id: mapping.remoteEntityId,
        SyncToken: mapping.remoteSyncToken,
      } : {}),
      DisplayName: customer.displayName,
      CompanyName: customer.companyName,
      PrimaryEmailAddr: customer.billingEmail ? { Address: customer.billingEmail } : undefined,
      PrimaryPhone: customer.phone ? { FreeFormNumber: customer.phone } : undefined,
      PrimaryTaxIdentifier: customer.taxId ?? undefined,
      BillAddr: mapAddressToQbo(customer.billAddr),
      ShipAddr: mapAddressToQbo(customer.shipAddr),
    };
    const parsed = await this.qboRequest<{ Customer?: QboRawCustomer }>(
      conn,
      `customer?minorversion=${QBO_API_MINOR_VERSION}`,
      'QuickBooks customer upsert',
      { method: 'POST', body: JSON.stringify(payload) },
    );
    if (!parsed.Customer?.Id) throw new Error('QuickBooks customer response was missing an Id');
    return {
      id: parsed.Customer.Id,
      syncToken: parsed.Customer.SyncToken,
      currencyCode: parsed.Customer.CurrencyRef?.value || undefined,
    };
  }

  async upsertItem(
    conn: AccountingConnection,
    item: AccountingItemPayload,
    mapping: AccountingEntityMapping | null,
  ): Promise<RemoteRef> {
    if (mapping && !mapping.remoteSyncToken) {
      throw new Error('QuickBooks Item update requires the current SyncToken');
    }
    if (!mapping && !item.incomeAccountRef) {
      throw new Error('QuickBooks Item creation requires an income account');
    }
    const payload = {
      ...(mapping ? {
        sparse: true,
        Id: mapping.remoteEntityId,
        SyncToken: mapping.remoteSyncToken,
      } : {}),
      Name: item.name,
      Sku: item.sku,
      Description: item.description ?? undefined,
      Type: item.type,
      // The seam carries a major-unit decimal string (spec §12); QBO wants a
      // JSON number.
      UnitPrice: Number(item.unitPrice),
      Taxable: item.taxable,
      Active: item.active,
      IncomeAccountRef: item.incomeAccountRef ? { value: item.incomeAccountRef } : undefined,
    };
    const parsed = await this.qboRequest<{ Item?: QboRawItem }>(
      conn,
      `item?minorversion=${QBO_API_MINOR_VERSION}`,
      'QuickBooks item upsert',
      { method: 'POST', body: JSON.stringify(payload) },
    );
    if (!parsed.Item?.Id) throw new Error('QuickBooks item response was missing an Id');
    return { id: parsed.Item.Id, syncToken: parsed.Item.SyncToken };
  }

  async pushInvoice(
    conn: AccountingConnection,
    invoice: AccountingInvoicePayload,
    lineMappings: readonly AccountingInvoiceLineMapping[],
  ): Promise<InvoicePushResult> {
    const mapping = invoice.mapping;
    if (mapping && !mapping.remoteSyncToken) {
      throw new Error('QuickBooks Invoice update requires the current SyncToken');
    }

    const lineMappingByLineId = new Map(lineMappings.map((m) => [m.invoiceLineId, m]));
    const lines = invoice.lines.map((line) => {
      const itemRef = lineMappingByLineId.get(line.invoiceLineId)?.remoteItemRef;
      return {
        DetailType: 'SalesItemLineDetail',
        // The wire-time Number() conversion — storage stays a major-unit
        // decimal string (spec §12); QBO wants a JSON number.
        Amount: Number(line.lineTotal),
        Description: line.description,
        SalesItemLineDetail: {
          ItemRef: itemRef ? { value: itemRef.id } : undefined,
          Qty: Number(line.quantity),
          UnitPrice: Number(line.unitPrice),
          TaxCodeRef: { value: line.taxable ? 'TAX' : 'NON' },
        },
      };
    });

    const buildBody = (includeDocNumber: boolean) => ({
      ...(mapping ? {
        sparse: true,
        Id: mapping.remoteEntityId,
        SyncToken: mapping.remoteSyncToken,
      } : {}),
      ...(includeDocNumber && invoice.docNumber ? { DocNumber: invoice.docNumber } : {}),
      TxnDate: invoice.txnDate,
      DueDate: invoice.dueDate ?? undefined,
      CustomerRef: { value: invoice.customerRef.id },
      Line: lines,
      // CurrencyRef is deliberately NEVER sent — mirrors upsertCustomer's
      // create-path guard: sending it to a single-currency realm is a QBO
      // error, and the currency contract is enforced by the coordinator's
      // assertAccountingInvoicePushCurrency BEFORE this method is reached
      // (Phase C, multi-currency §11), not by this transport.
      ...(conn.defaultTaxCodeRef ? {
        TxnTaxDetail: {
          TxnTaxCodeRef: { value: conn.defaultTaxCodeRef },
          TotalTax: Number(invoice.taxTotal),
        },
      } : {}),
    });

    // Idempotency key for CREATE only (review finding, Phase C Task 3 fix
    // round). A network-level retry of a create request that actually landed
    // — the response was lost, not the write — must not mint a second
    // QuickBooks invoice: QBO recognizes the same `requestid` for a rolling
    // 24h window and returns the ORIGINAL response instead of creating again.
    // A sparse UPDATE doesn't need this: it targets an existing Id +
    // SyncToken, and a stale SyncToken (the only way a retried update could
    // double-apply) is rejected outright by QBO. Deterministic per Breeze
    // invoice — every retry of the SAME invoice's create (including the
    // DocNumber-stripped retry below, still logically the same create) reuses
    // the identical key — and well under QBO's 50-char cap (a uuid is 36).
    const createRequestId = invoice.invoiceId;
    const invoicePath = (includeRequestId: boolean) => {
      const base = `invoice?minorversion=${QBO_API_MINOR_VERSION}`;
      return includeRequestId ? `${base}&requestid=${encodeURIComponent(createRequestId)}` : base;
    };

    let parsed: { Invoice?: QboRawInvoice };
    try {
      parsed = await this.qboRequest<{ Invoice?: QboRawInvoice }>(
        conn,
        invoicePath(!mapping),
        'QuickBooks invoice push',
        { method: 'POST', body: JSON.stringify(buildBody(true)) },
      );
    } catch (err) {
      const e = err as Error & { status?: number; body?: string };
      // A single retry WITHOUT DocNumber on a 400 Duplicate Document Number
      // fault: QBO already holds a document under that number (e.g. a prior
      // attempt that actually succeeded but whose response was lost), so
      // retrying with the same number would loop forever — let QBO assign one.
      if (e.status === 400 && invoice.docNumber && typeof e.body === 'string' && /Duplicate Document Number/i.test(e.body)) {
        parsed = await this.qboRequest<{ Invoice?: QboRawInvoice }>(
          conn,
          invoicePath(!mapping),
          'QuickBooks invoice push',
          { method: 'POST', body: JSON.stringify(buildBody(false)) },
        );
      } else {
        throw err;
      }
    }

    if (!parsed.Invoice?.Id) throw new Error('QuickBooks invoice response was missing an Id');
    return {
      id: parsed.Invoice.Id,
      syncToken: parsed.Invoice.SyncToken,
      docNumber: parsed.Invoice.DocNumber,
      remoteTaxTotal: parsed.Invoice.TxnTaxDetail?.TotalTax != null ? String(parsed.Invoice.TxnTaxDetail.TotalTax) : null,
      remoteTotal: parsed.Invoice.TotalAmt != null ? String(parsed.Invoice.TotalAmt) : null,
    };
  }

  async voidInvoice(
    conn: AccountingConnection,
    _invoice: AccountingVoidInvoicePayload,
    mapping: AccountingEntityMapping,
  ): Promise<void> {
    if (!mapping.remoteSyncToken) {
      throw new Error('QuickBooks Invoice void requires the current SyncToken');
    }
    await this.qboRequest(
      conn,
      'invoice?operation=void&minorversion=70',
      'QuickBooks invoice void',
      { method: 'POST', body: JSON.stringify({ Id: mapping.remoteEntityId, SyncToken: mapping.remoteSyncToken }) },
    );
  }

  async createPayment(conn: AccountingConnection, payment: AccountingPaymentPayload): Promise<RemoteRef> {
    // Idempotency key, exactly as pushInvoice's create path uses (`:663-678`):
    // QBO recognizes the same `requestid` for a rolling 24h window and returns
    // the ORIGINAL response rather than creating again, so a retry after a lost
    // response cannot double-book the customer's money. Deterministic per Breeze
    // payment and well under QBO's 50-char cap (a uuid is 36).
    const path = `payment?minorversion=${QBO_API_MINOR_VERSION}`
      + `&requestid=${encodeURIComponent(payment.invoicePaymentId)}`;
    const parsed = await this.qboRequest<{ Payment?: { Id?: string; SyncToken?: string } }>(
      conn,
      path,
      'QuickBooks payment create',
      {
        method: 'POST',
        body: JSON.stringify({
          CustomerRef: { value: payment.remoteCustomerId },
          // Wire-time Number() only — storage stays a major-unit decimal string.
          TotalAmt: Number(payment.amount),
          TxnDate: payment.txnDate,
          ...(payment.reference ? { PaymentRefNum: payment.reference } : {}),
          PrivateNote: payment.privateNote,
          Line: [{
            Amount: Number(payment.amount),
            LinkedTxn: [{ TxnId: payment.remoteInvoiceId, TxnType: 'Invoice' }],
          }],
          // CurrencyRef is deliberately NEVER sent — same rule as pushInvoice
          // (`:650-654`): the coordinator asserted home-currency equality before
          // this method was reached, and sending it to a single-currency realm is
          // a QBO error. DepositToAccountRef is omitted so QuickBooks books the
          // receipt to Undeposited Funds and the bookkeeper records the processor
          // fee at deposit time (spec decision 8). PaymentMethodRef needs a
          // per-realm PaymentMethod list Breeze does not fetch.
        }),
      },
    );
    if (!parsed.Payment?.Id) throw new Error('QuickBooks payment response was missing an Id');
    return { id: parsed.Payment.Id, syncToken: parsed.Payment.SyncToken };
  }

  async deletePayment(
    conn: AccountingConnection,
    payment: AccountingDeletePaymentPayload,
  ): Promise<PaymentDeleteResult> {
    let syncToken = payment.syncToken;
    // No token held (an adoption that never read one) — fetch one before trying.
    if (syncToken === null) {
      const fresh = await this.readPaymentSyncToken(conn, payment.remotePaymentId);
      if (!fresh.found) return 'already_absent';
      syncToken = fresh.syncToken;
    }

    try {
      await this.postPaymentDelete(conn, payment.remotePaymentId, syncToken);
      return 'deleted';
    } catch (err) {
      if (isQboObjectNotFound(err)) return 'already_absent';
      if (!isQboStaleObject(err)) throw err;
      // Stale token means the Payment STILL EXISTS with a newer revision (spec
      // decision 12). Read it once, retry once, then let the error out as
      // retryable — a Payment somebody is editing in a loop must not spin here.
      const fresh = await this.readPaymentSyncToken(conn, payment.remotePaymentId);
      if (!fresh.found) return 'already_absent';
      try {
        await this.postPaymentDelete(conn, payment.remotePaymentId, fresh.syncToken);
        return 'deleted';
      } catch (retryErr) {
        if (isQboObjectNotFound(retryErr)) return 'already_absent';
        throw retryErr;
      }
    }
  }

  /**
   * The current SyncToken for a Payment, or `{ found: false }` ONLY when
   * QuickBooks reports fault 610 (the object genuinely does not exist). A 2xx
   * response whose body lacks `Payment.SyncToken` is a malformed response, not
   * absence — throwing here (rather than folding it into `found: false`)
   * matters because a 5010 stale-object fault just PROVED the Payment exists;
   * silently reporting `already_absent` right after that would be
   * self-contradictory and would let a real delete request go unissued on a
   * money path.
   */
  private async readPaymentSyncToken(
    conn: AccountingConnection,
    remotePaymentId: string,
  ): Promise<{ found: false } | { found: true; syncToken: string }> {
    try {
      const parsed = await this.qboRequest<{ Payment?: { SyncToken?: string } }>(
        conn,
        `payment/${encodeURIComponent(remotePaymentId)}?minorversion=${QBO_API_MINOR_VERSION}`,
        'QuickBooks payment read',
      );
      if (!parsed.Payment?.SyncToken) throw new Error('QuickBooks payment read returned no SyncToken');
      return { found: true, syncToken: parsed.Payment.SyncToken };
    } catch (err) {
      if (isQboObjectNotFound(err)) return { found: false };
      throw err;
    }
  }

  private async postPaymentDelete(conn: AccountingConnection, remotePaymentId: string, syncToken: string): Promise<void> {
    const parsed = await this.qboRequest<{ Payment?: { Id?: string; status?: string } }>(
      conn,
      `payment?operation=delete&minorversion=${QBO_API_MINOR_VERSION}`,
      'QuickBooks payment delete',
      { method: 'POST', body: JSON.stringify({ Id: remotePaymentId, SyncToken: syncToken }) },
    );
    // Same discipline as createPayment: a 2xx with a body that does not
    // actually confirm the delete must not be reported as success.
    if (!parsed.Payment?.Id && parsed.Payment?.status !== 'Deleted') {
      throw new Error('QuickBooks payment delete response did not confirm deletion');
    }
  }

  async reconcileChanges(conn: AccountingConnection, sinceCursor: Date | null): Promise<ChangeSet> {
    const now = new Date();
    const epoch = new Date(0);
    const lookbackFloor = new Date(now.getTime() - QBO_CDC_LOOKBACK_DAYS * 24 * 3600_000);
    const windowStart = new Date(Math.max(
      (sinceCursor ?? epoch).getTime(),
      (conn.createdAt ?? epoch).getTime(),
      lookbackFloor.getTime(),
    ));
    const from = new Date(windowStart.getTime() - QBO_CDC_CURSOR_SLACK_MS);

    // The floor SILENTLY moved the window forward (finding H). QBO's CDC cannot
    // answer for anything older than 30 days, so the span between the stored
    // cursor and the floor is unreadable AND will never be swept again once the
    // cursor advances past it — a connection that was paused, disconnected or
    // wedged for a month resumes with a hole nobody is told about. Once per run,
    // and never on a first run: a null cursor is a new connection, not a gap.
    if (sinceCursor !== null && sinceCursor.getTime() < lookbackFloor.getTime()) {
      const skippedDays = Math.floor((lookbackFloor.getTime() - sinceCursor.getTime()) / (24 * 3600_000));
      console.warn(
        '[QuickbooksProvider] CDC cursor is older than the 30-day lookback floor; the skipped range can never be read',
        `connectionId=${conn.id}`,
        `cursor=${sinceCursor.toISOString()}`,
        `floor=${lookbackFloor.toISOString()}`,
        `skippedDays=${skippedDays}`,
      );
      captureException(
        new Error(
          `QuickBooks CDC cursor predates the 30-day lookback floor by ~${skippedDays} day(s); `
          + 'changes in that range cannot be reconciled',
        ),
        undefined,
        { service: 'quickbooksProvider', op: 'reconcileChanges', connectionId: conn.id, skippedDays: String(skippedDays) },
      );
    }

    const window = await this.fetchCdcWindow(conn, from);

    // Entities QBO truncated are re-enumerated through /query (finding A). A
    // backfill that itself fails or hits the page cap leaves `overflowed` set,
    // which the worker treats as DIRTY: the cursor is held and the window
    // replays, rather than silently losing everything QBO withheld.
    let overflowed = false;
    for (const entity of window.overflowedEntities) {
      const filled = await this.backfillOverflowedEntity(conn, entity, from);
      if (!filled) { overflowed = true; continue; }
      mergeQueryBackfill(window, entity, filled, conn);
    }

    return {
      // Prefer QBO's own server clock (spec: "the response's server time, not
      // ours") so the next cursor never advances past what QBO actually
      // observed; fall back to our local `now` when the response omitted or
      // failed to report `time` (already covered by the 5-min re-read slack).
      // Deliberately the CDC read's time, not a later /query page's: the CDC
      // read is the earliest observation in the run.
      cursor: window.responseTime ?? now,
      payments: window.payments,
      deletedPayments: window.deletedPayments,
      unappliedPayments: window.unappliedPayments,
      deletedInvoices: window.deletedInvoices,
      overflowed,
    };
  }

  // One CDC request. QBO's /cdc endpoint has NO upper-bound parameter and no
  // paging cursor of its own — it always returns everything since
  // `changedSince`, truncated at the realm's own limit — so this issues exactly
  // one request and reports which entities came back truncated.
  private async fetchCdcWindow(conn: AccountingConnection, from: Date): Promise<CdcWindowResult> {
    const params = new URLSearchParams({
      entities: 'Payment,Invoice',
      changedSince: from.toISOString(),
      minorversion: QBO_API_MINOR_VERSION,
    });
    const parsed = await this.qboRequest<QboCdcResponse>(
      conn,
      `cdc?${params.toString()}`,
      'QuickBooks change data capture',
    );

    const payments: ChangeSetPaymentLine[] = [];
    const deletedPayments: string[] = [];
    const unappliedPayments: string[] = [];
    const deletedInvoices: string[] = [];
    const overflowedEntities = new Set<CdcEntity>();

    for (const block of parsed.CDCResponse?.[0]?.QueryResponse ?? []) {
      const totalCount = block.totalCount;

      for (const raw of block.Payment ?? []) {
        // `status: "Deleted"` is the ONE deletion signal. A Payment QBO voided
        // or unapplied is still there, and treating it as deleted re-pushed a
        // duplicate through the fan-out (finding C1).
        if (raw.status === 'Deleted') { deletedPayments.push(raw.Id); continue; }
        const lines = mapQboCdcPayment(raw, conn);
        if (lines.length === 0) { unappliedPayments.push(raw.Id); continue; }
        payments.push(...lines);
      }
      if (totalCount !== undefined && totalCount > (block.Payment?.length ?? 0) && block.Payment) {
        overflowedEntities.add('Payment');
      }

      for (const raw of block.Invoice ?? []) {
        if (isDeletedOrVoidedInvoice(raw)) deletedInvoices.push(raw.Id);
      }
      if (totalCount !== undefined && totalCount > (block.Invoice?.length ?? 0) && block.Invoice) {
        overflowedEntities.add('Invoice');
      }
    }

    return {
      payments, deletedPayments, unappliedPayments, deletedInvoices,
      overflowedEntities: [...overflowedEntities],
      responseTime: parseCdcResponseTime(parsed.time),
    };
  }

  /**
   * Re-enumerate ONE truncated entity through the `/query` endpoint, which —
   * unlike `/cdc` — really does page.
   *
   * Returns null when the enumeration could not be completed (a QBO error, or
   * the page cap): the caller then reports `overflowed` and the worker holds
   * the cursor. Returns the full row set otherwise.
   *
   * `/query` never returns DELETED entities, so the CDC deletion lists are kept
   * verbatim and only additions/edits are merged (a void still shows up here,
   * because QBO keeps voided rows queryable with zeroed amounts).
   */
  private async backfillOverflowedEntity(
    conn: AccountingConnection,
    entity: CdcEntity,
    from: Date,
  ): Promise<QboRawCdcPayment[] | QboRawCdcInvoice[] | null> {
    const rows: Array<QboRawCdcPayment | QboRawCdcInvoice> = [];
    let startPosition = 1;

    for (let page = 0; page < QBO_CDC_QUERY_MAX_PAGES; page++) {
      const query = `select * from ${entity} where MetaData.LastUpdatedTime >= '${from.toISOString()}'`
        + ` orderby MetaData.LastUpdatedTime startposition ${startPosition} maxresults ${QBO_QUERY_PAGE_SIZE}`;
      let parsed: { QueryResponse?: { Payment?: QboRawCdcPayment[]; Invoice?: QboRawCdcInvoice[] } };
      try {
        parsed = await this.qboRequest(
          conn,
          `query?query=${encodeURIComponent(query)}&minorversion=${QBO_API_MINOR_VERSION}`,
          `QuickBooks ${entity} change backfill query`,
        );
      } catch (err) {
        // Sanitized by qboRequest (status only, never a fault body). Reported,
        // not rethrown: the CDC rows we already have are still worth applying,
        // and `overflowed` is what stops the cursor from advancing past them.
        console.error(
          '[QuickbooksProvider] CDC overflow backfill failed',
          `entity=${entity}`,
          err instanceof Error ? err.message : err,
        );
        captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
          service: 'quickbooksProvider', op: 'backfillOverflowedEntity', entity,
        });
        return null;
      }
      const page$ = (entity === 'Payment' ? parsed.QueryResponse?.Payment : parsed.QueryResponse?.Invoice) ?? [];
      rows.push(...page$);
      if (page$.length < QBO_QUERY_PAGE_SIZE) return rows as QboRawCdcPayment[] | QboRawCdcInvoice[];
      startPosition += QBO_QUERY_PAGE_SIZE;
    }

    console.error(
      '[QuickbooksProvider] CDC overflow backfill hit the page cap',
      `entity=${entity}`, `pages=${QBO_CDC_QUERY_MAX_PAGES}`,
    );
    captureException(
      new Error(`QuickBooks ${entity} change backfill exceeded ${QBO_CDC_QUERY_MAX_PAGES} pages`),
      undefined,
      { service: 'quickbooksProvider', op: 'backfillOverflowedEntity', entity },
    );
    return null;
  }

  verifyWebhook(signatureHeader: string, rawBody: string, verifierToken: string): boolean {
    if (!signatureHeader || !verifierToken) return false;
    const expected = createHmac('sha256', verifierToken).update(rawBody).digest('base64');
    const left = Buffer.from(signatureHeader, 'utf8');
    const right = Buffer.from(expected, 'utf8');
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  }

  private async qboRequest<T>(
    conn: AccountingConnection,
    path: string,
    operation: string,
    init: RequestInit = {},
  ): Promise<T> {
    if (!conn.realmId) throw new Error('QuickBooks connection is missing a realmId');
    if (!conn.accessToken) throw new Error('QuickBooks connection is missing an access token');

    const response = await runOutsideDbContext(() => fetch(
      `${qboApiBase(conn.environment)}/v3/company/${conn.realmId}/${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${conn.accessToken}`,
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
      },
    ));
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`${operation} failed with ${response.status}`);
      Object.assign(error, { status: response.status, body: text.slice(0, 500) });
      throw error;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`${operation} returned invalid JSON`);
    }
  }

  private async requestTokens(
    grantType: 'authorization_code' | 'refresh_token',
    input: { code?: string; refreshToken?: string; realmId: string }
  ): Promise<ConnectionTokens> {
    const body = new URLSearchParams();
    body.set('grant_type', grantType);
    if (grantType === 'authorization_code') {
      body.set('code', input.code ?? '');
      body.set('redirect_uri', QBO_REDIRECT_URI);
    } else {
      body.set('refresh_token', input.refreshToken ?? '');
    }

    const response = await runOutsideDbContext(() =>
      fetch(QBO_TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
      })
    );

    const text = await response.text();
    const parsed = text ? JSON.parse(text) as QboTokenResponse : {};
    if (!response.ok) {
      const err = new Error(parsed.error_description || parsed.error || `QuickBooks token request failed with ${response.status}`);
      (err as Error & { status?: number; qboError?: string }).status = response.status;
      (err as Error & { status?: number; qboError?: string }).qboError = parsed.error;
      throw err;
    }

    if (!parsed.access_token || !parsed.refresh_token || !parsed.expires_in || !parsed.x_refresh_token_expires_in) {
      throw new Error('QuickBooks token response was missing required fields');
    }

    const now = Date.now();
    return {
      realmId: input.realmId,
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      accessTokenExpiresAt: new Date(now + parsed.expires_in * 1000),
      refreshTokenExpiresAt: new Date(now + parsed.x_refresh_token_expires_in * 1000),
    };
  }
}

export const quickbooksProvider = new QuickbooksProvider();
