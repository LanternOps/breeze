/**
 * QuickBooks entity-mapping reconciliation (Phase B, Task 3 —
 * docs/superpowers/plans/2026-08-29-quickbooks-customer-item-mapping.md).
 *
 * `listMappingProposals` is READ/PROPOSE ONLY: it never calls
 * `upsertCustomer`/`upsertItem` and never writes to QuickBooks. It compares
 * Breeze organizations/catalog items against QuickBooks Customers/Items and
 * returns a deterministic suggestion per Breeze entity. Confirming a
 * suggestion (`saveMappingDecision`) and pushing it to QuickBooks
 * (`syncMappedEntity`) are Task 4's job and land in this same file.
 *
 * Match priority (strict, first hit wins):
 *   1. current mapping row (`accounting_entity_mappings`) — already decided.
 *   2. `organization_external_links` import provenance (orgs only) — backfilled
 *      into a `confirmed`/`pending` mapping row on first sight so it becomes a
 *      case (1) hit on every later call.
 *   3. exactly one exact email match (orgs) / exact SKU match (items).
 *   4. exactly one exact normalized-name match.
 *   5. `ambiguous` (more than one candidate at the tier that was checked) or
 *      `none` (no candidate at any tier).
 * Candidates for tiers 3-4 exclude inactive remote entities and remote IDs
 * already claimed by another Breeze entity's mapping row. Soft-deleted orgs and
 * the hidden per-partner `quick_support` org never enter the candidate/target
 * set at all (query-level filters — `deletedAt IS NULL` and
 * `notQuickSupportOrg()`). Those two are NOT symmetric afterwards: a soft-deleted
 * org's mapping row keeps its claim on a remote id (it still occupies the
 * `accounting_entity_mappings_remote_uniq` slot), whereas the hidden org's rows
 * are ignored by id — as claims, as backfill targets, and in
 * `saveMappingDecision`'s conflict scan — so a remote Customer it once claimed
 * can be proposed to, and confirmed by, a real org. See
 * `loadQuickSupportOrgIds`.
 *
 * Ordinary suggestions (tiers 3-5) are NOT persisted — they are cheap to
 * recompute and must not become stale rows merely because a user opened the
 * screen. Only the imported-customer backfill (tier 2) is durable, because it
 * is provenance, not a guess.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../../db';
import { assertNoAmbientDbContext, type DbContextRunner } from './dbContextGuard';
import {
  accountingEntityMappings,
  catalogItems,
  catalogItemPrices,
  organizationExternalLinks,
  organizations,
  partners,
  sites,
} from '../../db/schema';
import type { AccountingEntityMapping as AccountingEntityMappingRow } from '../../db/schema';
import { resolveActiveConnection } from './accountingConnectionService';
import type { AccountingConnection } from './accountingConnectionService';
import { normalizeCurrencyCode } from './accountingCurrency';
import { getValidAccessToken, ReauthRequiredError } from './accountingTokens';
import { accountingProviderDisplayName, getAccountingProvider } from './providerRegistry';
import { captureException } from '../sentry';
import { getRedis } from '../redis';
import {
  isAccountingProviderError,
  providerFaultSuffix,
  providerPermissionMessage,
  providerRateLimitedRetryLaterMessage,
  providerRateLimitedTryAgainMessage,
  rateLimitRetryAfterMs,
  rateLimitSourceOf,
  refusalCodeOf,
  type AccountingThrottleSource,
} from './accountingProviderError';
// Narrow import: `../orgImport`'s barrel pulls in `services/tenantLifecycle.ts`,
// which dynamically imports `routes/agentWs.ts` — several callers of this
// module (quoteSendWorker, stripeReconcileSweep, invoiceWorker, contractWorker,
// accountingSyncWorker, accountingReconcileWorker) are `global`-placement
// workers whose closure must never reach socket-local dispatch (see
// workerEntrypointClosure.contract.test.ts).
import { billingAddressColumns } from '../orgImport/addressColumns';
// Narrow import: `./accountingCustomerImport` transitively pulls in
// `../orgImport` (for commitOrgImport/previewOrgImport), same reachability
// concern as billingAddressColumns above.
import { siteAddressFrom } from './addressMapping';
import { requestLikeFromSnapshot, writeAuditEvent } from '../auditEvents';
import { isPgUniqueViolation } from '../../utils/pgErrors';
import type {
  AccountingCustomerPayload,
  AccountingEntityMapping as AccountingEntityMappingSeam,
  AccountingItemPayload,
  AccountingProviderId,
  RemoteAddress,
  RemoteCustomer,
  RemoteIncomeAccount,
  RemoteItem,
  RemoteRef,
} from './types';

import { HIDDEN_ORG_TYPES, notHiddenOrgType } from '../unassignedPool/visibility';
import { UNASSIGNED_POOL_ORG_TYPE } from '../unassignedPool/orgType';
export type MappingEntityType = 'org' | 'catalog_item';
export type MappingDecision = 'confirmed' | 'create_new' | 'unlinked';

export interface ListMappingProposalsInput {
  partnerId: string;
  provider: AccountingProviderId;
  entityType: MappingEntityType;
}

export type AccountingMappingErrorCode =
  | 'not_connected'
  | 'reauth_required'
  | 'provider_error'
  // 'quickbooks_error': pre-W01 alias; never produced any more, kept for compile compatibility
  | 'quickbooks_error'
  | 'record_failed'
  | 'sync_in_progress'
  | 'mapping_conflict'
  | 'entity_not_found'
  | 'income_account_required'
  | 'mapping_not_ready'
  // QuickBooks stamps CurrencyRef from the realm default at CREATE time and
  // never lets it change afterwards, so creating a Customer/Item for a Breeze
  // entity stamped in a different currency mints a permanently unusable remote
  // record — Phase C's invoice-push guard then rejects that org forever.
  // Surfaced as a pre-flight 409 before any provider call, same shape as
  // income_account_required.
  | 'currency_mismatch'
  // Not in the original Task 4 brief: the rebased seam requires a single
  // currencyCode+unitPrice pair per Item (there is no per-org context here —
  // a catalog item syncs once per partner), so the price book can genuinely
  // lack a row in the resolved target currency. Surfaced the same way
  // income_account_required is: a pre-flight 409 before any provider call.
  | 'item_price_required'
  // Throttled by the provider or Breeze's own limiter (429, `retryAfterMs`).
  // Routes answer 429 + Retry-After; the sync worker delays the job without
  // consuming an attempt. Deliberately NOT in MAPPING_TERMINAL_CODES.
  | 'rate_limited'
  // The provider lacks the hook a route needs (Xero W02: settings pickers). 409.
  | 'capability_unavailable'
  // Xero W03 — provider verdicts only the user can resolve (409, terminal, never Sentry):
  // a same-named remote record exists (`details.remoteName`), the record Breeze would
  // adopt (or is mapped to) is archived, the mapped record no longer exists, or the
  // grant lacks the scope for this call.
  | 'duplicate_name'
  | 'remote_archived'
  | 'remote_missing'
  | 'provider_permission'
  // #7292 — the provider answered HTTP 400 `validation` with no neutral refusal
  // code (e.g. a name Xero or QuickBooks will not accept). Only editing the record
  // fixes it, so it is terminal (409, never retried). Unlike the codes above it is
  // still reported to Sentry ONCE by the coordinator: a code-less 400 can also be a
  // Breeze payload bug, and that must stay visible.
  | 'provider_rejected';

// Typed failure the route translates straight to an HTTP status (mirrors
// AccountingImportError in accountingCustomerImport.ts). Narrowing `code`/`status` to
// literals lets a route drop its `as`-cast.
export class AccountingMappingError extends Error {
  /** Set on `rate_limited` only: how long to wait before retrying. */
  readonly retryAfterMs?: number;
  /** Set on `rate_limited` only: who throttled (provider 429, Breeze's limiter, or its store). */
  readonly throttleSource?: AccountingThrottleSource;
  /** Safe, structured context for the client (e.g. `remoteName` on `duplicate_name`). */
  readonly details?: Readonly<Record<string, string>>;
  constructor(
    public readonly code: AccountingMappingErrorCode,
    public readonly status: 404 | 409 | 429 | 502,
    message: string,
    opts: {
      retryAfterMs?: number; throttleSource?: AccountingThrottleSource; cause?: unknown;
      details?: Readonly<Record<string, string>>;
    } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'AccountingMappingError';
    this.retryAfterMs = opts.retryAfterMs;
    this.throttleSource = opts.throttleSource;
    this.details = opts.details;
  }
}

// Every value `accounting_entity_mappings.sync_status` can hold (schema/accounting.ts's
// syncStatusCheck). Exported so callers outside this module (e.g. invoiceService.ts's
// `accountingSync` on GET /invoices/:id) can type a mapping-row read without
// re-deriving the literal union.
export type MappingSyncStatus = 'pending' | 'synced' | 'error' | 'synced_with_tax_variance';

export interface MappingProposal {
  breezeEntityType: MappingEntityType;
  breezeEntityId: string;
  breezeDisplayName: string;
  remoteEntityType: 'Customer' | 'Item';
  proposedRemoteId: string | null;
  proposedRemoteName: string | null;
  confidence: 'existing_link' | 'exact_email' | 'exact_sku' | 'exact_name' | 'none' | 'ambiguous';
  linkStatus: 'suggested' | 'confirmed' | 'create_new' | 'unlinked';
  // 'synced_with_tax_variance' is a Phase C (invoice push) outcome — org/item
  // mapping rows never carry it themselves, but this type is the shared shape
  // `accountingEntityMappings.syncStatus` casts through (toProposalFromMapping),
  // so it must stay a superset of every value the DB column actually allows.
  syncStatus: MappingSyncStatus;
  lastError: string | null;
}

export function normalizeMatchValue(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

/**
 * Pulls an email out of `organizations.billing_contact` JSONB. Deliberately a
 * local duplicate of `services/invoicePdf.ts`'s `resolveBillingEmail` rather
 * than an import from it: that module pulls in pdfkit + the email service, a
 * heavy dependency graph this read-only matching service has no reason to
 * carry.
 */
function orgBillingEmail(billingContact: unknown): string | null {
  if (billingContact && typeof billingContact === 'object') {
    const email = (billingContact as { email?: unknown }).email;
    if (typeof email === 'string' && email.includes('@')) return email;
  }
  return null;
}

/**
 * Which connection a call must act on (Xero W01):
 * - `{ connectionId }` — jobs: the exact connection the work was enqueued for;
 * - `{ provider }` — routes: the `:provider` in the URL;
 * - `undefined` — producer-less callers: the partner's active connection.
 */
export type ConnectionTarget =
  | { connectionId: string }
  | { provider: AccountingProviderId }
  | undefined;

function notConnectedMessage(provider: AccountingProviderId | null): string {
  return provider
    ? `${accountingProviderDisplayName(provider)} is not connected for this partner`
    : 'No accounting system is connected for this partner';
}

/**
 * Resolve the partner's connection row, rejecting disconnected/reauth DB
 * states as typed errors. This is a plain read through the ambient `db` (the
 * caller's partner-scoped context) — it never refreshes a live access token,
 * so it is safe to call for a purely-local decision (e.g. `saveMappingDecision`'s
 * `create_new`/`unlinked` paths) without risking a `ReauthRequiredError` from
 * an expired grant that the caller doesn't actually need a token for.
 *
 * Split out of `resolveConnectionAndToken` below (Phase C, Task 5 — the
 * unlink-without-live-token fix): callers that DO need a live token call
 * `resolveConnectionAndToken`, which composes this with `resolveLiveConnection`.
 *
 * Always the partner's ONE active row (accounting_connections_partner_idx),
 * then checked against the caller's target: a route's :provider, or a job's
 * connectionId. A mismatch is `not_connected` — never "use whatever is
 * connected now".
 */
export async function resolveConnection(
  partnerId: string,
  target?: ConnectionTarget,
): Promise<AccountingConnection> {
  const wanted = target && 'provider' in target ? target.provider : null;
  const conn = await resolveActiveConnection(db, partnerId);
  if (!conn) throw new AccountingMappingError('not_connected', 404, notConnectedMessage(wanted));
  if (wanted && conn.provider !== wanted) {
    throw new AccountingMappingError('not_connected', 404, notConnectedMessage(wanted));
  }
  if (target && 'connectionId' in target && conn.id !== target.connectionId) {
    throw new AccountingMappingError('not_connected', 404, notConnectedMessage(conn.provider));
  }
  const label = accountingProviderDisplayName(conn.provider);
  // A previously-connected partner whose token was revoked/expired needs
  // "reconnect", not "connect" — distinct remediation from never-connected.
  if (conn.status === 'reauth_required') {
    throw new AccountingMappingError('reauth_required', 409, `${label} needs to be reconnected`);
  }
  if (conn.status !== 'connected') {
    throw new AccountingMappingError('not_connected', 404, notConnectedMessage(conn.provider));
  }
  return conn;
}

/**
 * Refresh (if needed) and attach a LIVE access token to an already-resolved
 * connection row.
 *
 * MUST be called with NO ambient DB access context, and deliberately does NOT
 * open one: `getValidAccessToken` opens its own short system transactions
 * around the QuickBooks refresh fetch and asserts that nothing is already open
 * (accountingTokens.ts). Wrapping this in `withSystemDbAccessContext` — as it
 * once was — made those "two short transactions" savepoints inside the
 * caller's transaction, which held the connection's `FOR UPDATE` row lock
 * across the refresh round trip: the exact hold the module claims to avoid.
 * `runOutsideDbContext` would not help either; it re-routes the ALS lookup but
 * cannot commit the caller's transaction.
 */
export async function resolveLiveConnection(conn: AccountingConnection): Promise<AccountingConnection> {
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(db, conn);
  } catch (err) {
    if (err instanceof ReauthRequiredError) {
      throw new AccountingMappingError('reauth_required', 409, `${accountingProviderDisplayName(conn.provider)} needs to be reconnected`);
    }
    // A throttled token endpoint (Xero W01): typed, so routes answer 429 and
    // workers delay the job instead of treating it as an unexpected failure.
    const retryAfterMs = rateLimitRetryAfterMs(err);
    if (retryAfterMs !== null) {
      const throttleSource = rateLimitSourceOf(err) ?? 'provider';
      throw new AccountingMappingError(
        'rate_limited', 429, providerRateLimitedTryAgainMessage(accountingProviderDisplayName(conn.provider), throttleSource),
        { retryAfterMs, throttleSource, cause: err },
      );
    }
    throw err;
  }
  return { ...conn, accessToken };
}

/**
 * Resolve the partner's connection AND a valid access token, rejecting
 * disconnected/reauth states as typed errors.
 *
 * Entered with NO ambient DB access context (asserted): the connection row is
 * read inside ONE short `runInDbContext` transaction that commits, and the
 * token refresh then runs with nothing held (see `resolveLiveConnection`).
 * Callers supply the runner — routes pass
 * `(fn) => withAuthDbAccessContext(auth, fn)`, off-request callers pass
 * `(fn) => withSystemDbAccessContext(fn, '<label>')`.
 *
 * Exported for `accountingInvoicePush.ts` (Phase C, Task 3): the invoice-push
 * coordinator needs the exact same connection/token/reauth resolution this
 * module already owns, and re-deriving it would risk the two falling out of
 * agreement on what "not connected"/"reauth required" mean.
 */
export async function resolveConnectionAndToken(
  partnerId: string,
  target: ConnectionTarget,
  runInDbContext: DbContextRunner,
): Promise<{ conn: AccountingConnection; liveConn: AccountingConnection }> {
  assertNoAmbientDbContext('resolveConnectionAndToken');
  const conn = await runInDbContext(() => resolveConnection(partnerId, target));
  const liveConn = await resolveLiveConnection(conn);
  return { conn, liveConn };
}

/**
 * Runs a provider call and converts any failure into a typed 502 — QBO API
 * failures (401/403/429/5xx, unparseable body) are upstream, not a Breeze bug.
 * The original error (which may carry a raw response body) is reported to
 * Sentry for forensics but never surfaced in the thrown message, so a caller
 * can't leak an upstream response body to the client.
 */
export async function callProviderOrThrow<T>(action: () => Promise<T>, errorMessage: string): Promise<T> {
  try {
    return await action();
  } catch (err) {
    // An already-typed throttle (e.g. a wrapper that resolved its own token)
    // passes through unchanged; every other AccountingMappingError keeps the
    // existing provider_error wrapping below.
    if (err instanceof AccountingMappingError && err.code === 'rate_limited') throw err;
    // A throttle is not an upstream failure (Xero W01): 429 + retryAfterMs, no
    // Sentry event. The message is built from the provider label only, never
    // from the error, for the same no-leak reason as the 502 below.
    const retryAfterMs = rateLimitRetryAfterMs(err);
    if (retryAfterMs !== null && isAccountingProviderError(err)) {
      const throttleSource = rateLimitSourceOf(err) ?? 'provider';
      throw new AccountingMappingError(
        'rate_limited', 429, providerRateLimitedTryAgainMessage(accountingProviderDisplayName(err.provider), throttleSource),
        { retryAfterMs, throttleSource, cause: err },
      );
    }
    // A scope refusal is the user's to fix (reconnect and approve), not an
    // upstream fault (Xero W03): 409, no Sentry event.
    if (refusalCodeOf(err) === 'insufficient_scope' && isAccountingProviderError(err)) {
      throw new AccountingMappingError('provider_permission', 409, providerPermissionMessage(accountingProviderDisplayName(err.provider)), { cause: err });
    }
    captureException(err instanceof Error ? err : new Error(String(err)));
    throw new AccountingMappingError('provider_error', 502, errorMessage);
  }
}

type MappingRow = AccountingEntityMappingRow;
export type MappingResult = MappingRow & Pick<MappingProposal, 'confidence' | 'proposedRemoteName'>;

function mappingResult(row: MappingRow, proposedRemoteName: string | null): MappingResult {
  return { ...row, confidence: confidenceForMapping(row), proposedRemoteName };
}

/**
 * `confidence` describes how the PROPOSED remote id was arrived at, so a
 * persisted row only earns `existing_link` when it actually links to
 * something. A `create_new` or `unlinked` decision links to nothing — hard
 * -coding `existing_link` for those made the workbench render the operator's
 * own recorded decision as a "Suggested match" (it labels anything that isn't
 * `ambiguous`/`none` that way), i.e. Breeze telling the user it had guessed
 * the choice they themselves made. `none` is the accurate reading — no remote
 * counterpart is proposed — and the row's separate `linkStatus` is what
 * carries the decision itself.
 */
function confidenceForMapping(mapping: MappingRow): MappingProposal['confidence'] {
  return mapping.remoteEntityId ? 'existing_link' : 'none';
}

function toProposalFromMapping(
  breezeEntityType: MappingEntityType,
  breezeEntityId: string,
  breezeDisplayName: string,
  remoteEntityType: 'Customer' | 'Item',
  mapping: MappingRow,
  remoteDisplayNameById: Map<string, string>,
): MappingProposal {
  return {
    breezeEntityType,
    breezeEntityId,
    breezeDisplayName,
    remoteEntityType,
    proposedRemoteId: mapping.remoteEntityId,
    proposedRemoteName: mapping.remoteEntityId ? remoteDisplayNameById.get(mapping.remoteEntityId) ?? null : null,
    confidence: confidenceForMapping(mapping),
    linkStatus: mapping.linkStatus as MappingProposal['linkStatus'],
    syncStatus: mapping.syncStatus as MappingProposal['syncStatus'],
    lastError: mapping.lastError ?? null,
  };
}

/** Result of the tiered exact-match search: at most one candidate, or an ambiguous/none verdict. */
function findExactMatch<T extends { id: string }>(
  candidates: T[],
  keyFn: (candidate: T) => string,
  localKey: string,
): { candidate: T | null; ambiguous: boolean } {
  if (!localKey) return { candidate: null, ambiguous: false };
  const matches = candidates.filter((c) => keyFn(c) === localKey);
  if (matches.length === 1) return { candidate: matches[0]!, ambiguous: false };
  if (matches.length > 1) return { candidate: null, ambiguous: true };
  return { candidate: null, ambiguous: false };
}

/**
 * `organizations.type <> 'quick_support'`.
 *
 * Mirrors the exclusion `GET /orgs/organizations` already applies
 * (routes/orgs.ts) — the hidden org sits inside `accessibleOrgIds` by design so
 * RLS lets a tech reach their own support session, which means every query that
 * enumerates or resolves a customer org has to exclude it explicitly.
 *
 * A function, not a module-level constant — NOT because drizzle conditions are
 * mutable (they are immutable ASTs; `and()` wraps its operands), but because
 * `ne(organizations.type, …)` evaluated at import time touches the schema
 * table, and test files that `vi.mock('../db/schema')` without exporting
 * `organizations` (e.g. routes/portal.compat.test.ts, which imports this
 * module transitively via accountingInvoicePush) would throw on load.
 */
const notQuickSupportOrg = () => notHiddenOrgType();

/**
 * Ids of the partner's hidden `quick_support` orgs (in practice exactly one).
 *
 * `accounting_entity_mappings` and `organization_external_links` are keyed by
 * org id and carry no org `type` of their own, so excluding the hidden org from
 * the org QUERY alone is not enough: a mapping row confirmed against it before
 * the exclusion existed still claims a remote Customer, and the tier-2 backfill
 * loop would still write new rows for it. Those rows have to be recognised by
 * id, which is what this set is for.
 *
 * Deliberately "which orgs are HIDDEN" rather than the complement, "which orgs
 * are in the proposal list": a SOFT-DELETED org's mapping row still occupies
 * the `accounting_entity_mappings_remote_uniq` slot, so its claim must keep
 * suppressing that remote id (existing contract — see the
 * 'excludes a remote customer already claimed by another Breeze entity mapping'
 * test). Only the hidden org's claims are dropped, and only because
 * `saveMappingDecision` drops them from the conflict scan in the same breath,
 * so a remote id freed here can actually be confirmed.
 */
async function loadQuickSupportOrgIds(partnerId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(
      eq(organizations.partnerId, partnerId),
      inArray(organizations.type, [...HIDDEN_ORG_TYPES]),
      isNull(organizations.deletedAt),
    ));
  return new Set(rows.map((r) => r.id));
}

async function proposeOrgMappings(
  partnerId: string,
  conn: AccountingConnection,
  liveConn: AccountingConnection,
  runInDbContext: DbContextRunner,
): Promise<MappingProposal[]> {
  // The multi-second QuickBooks page fetch runs FIRST, with no DB context (and
  // therefore no pooled connection) held — `resolveConnectionAndToken` asserted
  // the caller left none open, and every DB read/write below is then done
  // inside ONE short `runInDbContext` transaction. An earlier version relied on
  // `runOutsideDbContext` here, which only swaps which `db` the
  // AsyncLocalStorage proxy resolves to and does NOT close a transaction the
  // caller already opened (#1105).
  const providerLabel = accountingProviderDisplayName(conn.provider);
  const remoteCustomers = await callProviderOrThrow(
    () => getAccountingProvider(conn.provider).listRemoteCustomers(liveConn),
    `${providerLabel} returned an error while listing customers`,
  );
  const remoteNameById = new Map(remoteCustomers.map((c) => [c.id, c.displayName]));

  return runInDbContext(() => buildOrgProposals(partnerId, conn, remoteCustomers, remoteNameById));
}

/**
 * The DB half of `proposeOrgMappings`, split out so it can be handed WHOLE to
 * one short `runInDbContext` transaction opened after the QuickBooks fetch —
 * rather than the reads straddling a context that was open across it.
 */
async function buildOrgProposals(
  partnerId: string,
  conn: AccountingConnection,
  remoteCustomers: RemoteCustomer[],
  remoteNameById: Map<string, string>,
): Promise<MappingProposal[]> {
  const orgs = await db
    .select()
    .from(organizations)
    .where(and(
      eq(organizations.partnerId, partnerId),
      // The per-partner 'quick_support' org is a real `organizations` row that
      // only holds ephemeral Quick Support sessions — it is never a customer
      // and must never be offered as a QuickBooks Customer to map. Same
      // exclusion GET /orgs/organizations already applies (routes/orgs.ts), and
      // this query bypasses that route entirely.
      notQuickSupportOrg(),
      isNull(organizations.deletedAt),
    ));

  const mappingRows = await db
    .select()
    .from(accountingEntityMappings)
    .where(and(
      eq(accountingEntityMappings.partnerId, partnerId),
      eq(accountingEntityMappings.integrationId, conn.id),
      eq(accountingEntityMappings.breezeEntityType, 'org'),
    ));

  const links = await db
    .select()
    .from(organizationExternalLinks)
    .where(and(
      eq(organizationExternalLinks.partnerId, partnerId),
      eq(organizationExternalLinks.system, conn.provider),
    ));

  // Neither read above carries the org query's `type` filter, so both can still
  // surface the hidden org by id — see `loadQuickSupportOrgIds`.
  const hiddenOrgIds = await loadQuickSupportOrgIds(partnerId);

  const mappingByOrgId = new Map(
    mappingRows
      .filter((m) => !hiddenOrgIds.has(m.breezeEntityId))
      .map((m) => [m.breezeEntityId, m as MappingRow]),
  );

  // Backfill imported-customer provenance into a durable confirmed mapping the
  // first time reconciliation sees it — every later call hits this as a
  // current-mapping (tier 1) row instead of re-deriving it. ON CONFLICT DO
  // NOTHING: a concurrent caller may have already inserted the same row.
  // Carry the live SyncToken + currency from the listing just fetched, exactly
  // as a manual confirm does — a row without a token could never be updated in
  // QuickBooks (#7134). The provider also self-heals a missing token, so rows
  // backfilled before this fix recover on their next sync.
  const remoteById = new Map(remoteCustomers.map((c) => [c.id, c]));
  for (const link of links) {
    if (hiddenOrgIds.has(link.orgId)) continue;
    if (mappingByOrgId.has(link.orgId)) continue;
    const remote = remoteById.get(link.externalId);
    const [inserted] = await db
      .insert(accountingEntityMappings)
      .values({
        integrationId: conn.id,
        partnerId,
        breezeEntityType: 'org',
        breezeEntityId: link.orgId,
        remoteEntityType: 'Customer',
        remoteEntityId: link.externalId,
        remoteSyncToken: remote?.remoteVersion ?? null,
        remoteCurrencyCode: remote?.currencyCode ?? null,
        linkStatus: 'confirmed',
        syncStatus: 'pending',
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) mappingByOrgId.set(link.orgId, inserted as MappingRow);
  }

  const claimedRemoteIds = new Set(
    Array.from(mappingByOrgId.values())
      .map((m) => m.remoteEntityId)
      .filter((id): id is string => !!id),
  );
  const candidatePool = remoteCustomers.filter((c) => c.active !== false && !claimedRemoteIds.has(c.id));

  return orgs.map((org) => {
    const mapping = mappingByOrgId.get(org.id);
    if (mapping) {
      return toProposalFromMapping('org', org.id, org.name, 'Customer', mapping, remoteNameById);
    }

    const localEmail = normalizeMatchValue(orgBillingEmail(org.billingContact));
    const localName = normalizeMatchValue(org.name);

    let matched: RemoteCustomer | null = null;
    let confidence: MappingProposal['confidence'] = 'none';

    const emailResult = findExactMatch(candidatePool, (c) => normalizeMatchValue(c.email), localEmail);
    if (emailResult.candidate) {
      matched = emailResult.candidate;
      confidence = 'exact_email';
    } else if (emailResult.ambiguous) {
      confidence = 'ambiguous';
    }

    if (!matched && confidence !== 'ambiguous') {
      const nameResult = findExactMatch(candidatePool, (c) => normalizeMatchValue(c.displayName), localName);
      if (nameResult.candidate) {
        matched = nameResult.candidate;
        confidence = 'exact_name';
      } else if (nameResult.ambiguous) {
        confidence = 'ambiguous';
      }
    }

    return {
      breezeEntityType: 'org',
      breezeEntityId: org.id,
      breezeDisplayName: org.name,
      remoteEntityType: 'Customer',
      proposedRemoteId: matched?.id ?? null,
      proposedRemoteName: matched?.displayName ?? null,
      confidence,
      linkStatus: 'suggested',
      syncStatus: 'pending',
      lastError: null,
    };
  });
}

async function proposeItemMappings(
  partnerId: string,
  conn: AccountingConnection,
  liveConn: AccountingConnection,
  runInDbContext: DbContextRunner,
): Promise<MappingProposal[]> {
  // See the comment in proposeOrgMappings above — fetch first with nothing
  // held, then one short DB context for the reads.
  const providerLabel = accountingProviderDisplayName(conn.provider);
  const remoteItems = await callProviderOrThrow(
    () => getAccountingProvider(conn.provider).listRemoteItems(liveConn),
    `${providerLabel} returned an error while listing items`,
  );
  const remoteNameById = new Map(remoteItems.map((i) => [i.id, i.displayName]));

  return runInDbContext(() => buildItemProposals(partnerId, conn, remoteItems, remoteNameById));
}

/** The DB half of `proposeItemMappings` — see `buildOrgProposals`. */
async function buildItemProposals(
  partnerId: string,
  conn: AccountingConnection,
  remoteItems: RemoteItem[],
  remoteNameById: Map<string, string>,
): Promise<MappingProposal[]> {
  const items = await db
    .select()
    .from(catalogItems)
    .where(and(eq(catalogItems.partnerId, partnerId), eq(catalogItems.isActive, true)));

  const mappingRows = await db
    .select()
    .from(accountingEntityMappings)
    .where(and(
      eq(accountingEntityMappings.partnerId, partnerId),
      eq(accountingEntityMappings.integrationId, conn.id),
      eq(accountingEntityMappings.breezeEntityType, 'catalog_item'),
    ));

  const mappingByItemId = new Map(mappingRows.map((m) => [m.breezeEntityId, m as MappingRow]));
  const claimedRemoteIds = new Set(
    mappingRows.map((m) => m.remoteEntityId).filter((id): id is string => !!id),
  );
  const candidatePool = remoteItems.filter((i) => i.active !== false && !claimedRemoteIds.has(i.id));

  return items.map((item) => {
    const mapping = mappingByItemId.get(item.id);
    if (mapping) {
      return toProposalFromMapping('catalog_item', item.id, item.name, 'Item', mapping, remoteNameById);
    }

    const localSku = normalizeMatchValue(item.sku);
    const localName = normalizeMatchValue(item.name);

    let matched: RemoteItem | null = null;
    let confidence: MappingProposal['confidence'] = 'none';

    const skuResult = findExactMatch(candidatePool, (i) => normalizeMatchValue(i.sku), localSku);
    if (skuResult.candidate) {
      matched = skuResult.candidate;
      confidence = 'exact_sku';
    } else if (skuResult.ambiguous) {
      confidence = 'ambiguous';
    }

    if (!matched && confidence !== 'ambiguous') {
      const nameResult = findExactMatch(candidatePool, (i) => normalizeMatchValue(i.displayName), localName);
      if (nameResult.candidate) {
        matched = nameResult.candidate;
        confidence = 'exact_name';
      } else if (nameResult.ambiguous) {
        confidence = 'ambiguous';
      }
    }

    return {
      breezeEntityType: 'catalog_item',
      breezeEntityId: item.id,
      breezeDisplayName: item.name,
      remoteEntityType: 'Item',
      proposedRemoteId: matched?.id ?? null,
      proposedRemoteName: matched?.displayName ?? null,
      confidence,
      linkStatus: 'suggested',
      syncStatus: 'pending',
      lastError: null,
    };
  });
}

export async function listMappingProposals(
  input: ListMappingProposalsInput,
  runInDbContext: DbContextRunner,
): Promise<MappingProposal[]> {
  const { partnerId, provider, entityType } = input;
  const { conn, liveConn } = await resolveConnectionAndToken(partnerId, { provider }, runInDbContext);

  return entityType === 'org'
    ? proposeOrgMappings(partnerId, conn, liveConn, runInDbContext)
    : proposeItemMappings(partnerId, conn, liveConn, runInDbContext);
}

/**
 * Used by the income-account selector (Task 5's `GET
 * /:provider/income-accounts` route): owns connection lookup, token refresh,
 * and the provider call so the route stays a thin pass-through.
 */
export async function listRemoteIncomeAccountsForPartner(
  input: { partnerId: string; provider: AccountingProviderId },
  runInDbContext: DbContextRunner,
): Promise<RemoteIncomeAccount[]> {
  const { conn, liveConn } = await resolveConnectionAndToken(input.partnerId, { provider: input.provider }, runInDbContext);
  // Nothing to persist, so there is no second DB phase: the connection read
  // committed inside `resolveConnectionAndToken`'s short context and this
  // provider call runs with no connection held.
  const providerLabel = accountingProviderDisplayName(conn.provider);
  return callProviderOrThrow(
    () => getAccountingProvider(conn.provider).listRemoteIncomeAccounts(liveConn),
    `${providerLabel} returned an error while listing income accounts`,
  );
}

// ---------------------------------------------------------------------------
// Task 4 — confirm mappings and explicitly sync Customers and Items.
//
// Only an explicit `confirmed` or `create_new` decision may ever reach
// `provider.upsertCustomer`/`upsertItem` (Global Constraint). Ordinary
// suggestions from Task 3 are never written here.
// ---------------------------------------------------------------------------

export interface SaveMappingDecisionInput {
  partnerId: string;
  provider: AccountingProviderId;
  breezeEntityType: MappingEntityType;
  breezeEntityId: string;
  decision: MappingDecision;
  remoteEntityId?: string;
}

export interface SyncMappedEntityInput {
  partnerId: string;
  provider: AccountingProviderId;
  breezeEntityType: MappingEntityType;
  breezeEntityId: string;
}

type OrgRow = typeof organizations.$inferSelect;
type CatalogItemRow = typeof catalogItems.$inferSelect;

/**
 * `allowQuickSupport` opts OUT of the hidden-org exclusion, and only the
 * `unlinked` decision may pass it.
 *
 * The exclusion is defense in depth for the proposal-list filter in
 * `buildOrgProposals`: the decision/sync routes take the Breeze entity id from
 * the request body, so hiding the org from the list does not on its own keep it
 * out of QuickBooks. But `unlinked` is purely local — it writes
 * `remoteEntityId: null` and never calls the provider — and it is the ONLY API
 * path that can clear a mapping row confirmed against the hidden org before the
 * exclusion existed. 404-ing it too would leave such a row invisible in the
 * workbench and unremovable through the API.
 */
async function loadOwnedOrg(
  orgId: string,
  partnerId: string,
  opts: { allowQuickSupport?: boolean } = {},
): Promise<OrgRow> {
  const rows = await db
    .select()
    .from(organizations)
    .where(and(
      eq(organizations.id, orgId),
      eq(organizations.partnerId, partnerId),
      // Even the `unlinked` escape hatch never reaches the holding org: it can
      // never have been offered, so it can hold no mapping row to clear.
      opts.allowQuickSupport ? ne(organizations.type, UNASSIGNED_POOL_ORG_TYPE) : notQuickSupportOrg(),
      isNull(organizations.deletedAt),
    ));
  const org = rows[0] as OrgRow | undefined;
  if (!org) throw new AccountingMappingError('entity_not_found', 404, 'Organization not found for this partner');
  return org;
}

async function loadOwnedCatalogItem(itemId: string, partnerId: string): Promise<CatalogItemRow> {
  const rows = await db
    .select()
    .from(catalogItems)
    .where(and(eq(catalogItems.id, itemId), eq(catalogItems.partnerId, partnerId)));
  const item = rows[0] as CatalogItemRow | undefined;
  if (!item) throw new AccountingMappingError('entity_not_found', 404, 'Catalog item not found for this partner');
  return item;
}

/**
 * All mapping rows for one connection + Breeze entity type, partner-scoped at
 * the SQL level. Callers narrow to a single entity in JS (matches the
 * Task 3 `mappingByOrgId`/`mappingByItemId` pattern) — this single query
 * doubles as both "does a mapping already exist for this entity" (identity)
 * and "does another entity already claim this remote id" (conflict), so
 * `saveMappingDecision` never issues two separate reads for those two checks.
 */
async function loadMappingRows(
  partnerId: string,
  integrationId: string,
  breezeEntityType: MappingEntityType,
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

interface MappingDecisionFields {
  remoteEntityId: string | null;
  remoteSyncToken: string | null;
  /**
   * QBO CurrencyRef.value (Phase C, multi-currency §11). Org rows only — a
   * catalog item syncs once per partner with no per-currency identity of its
   * own, so this always stays null for a `catalog_item` mapping row.
   */
  remoteCurrencyCode: string | null;
  linkStatus: MappingDecision;
  syncStatus: 'pending';
  lastError: null;
}

/**
 * Creates or updates the one mapping row identified by
 * (integrationId, breezeEntityType, breezeEntityId). An UPDATE always keys on
 * both the row's own `id` AND `partnerId` (Global Constraint); a fresh INSERT
 * has no prior id to key on, so it relies on the schema's own uniqueness.
 *
 * The DB's `accounting_entity_mappings_remote_uniq` partial unique index is
 * the LAST line of defense against two Breeze entities claiming the same
 * remote id — `saveMappingDecision`'s app-layer check (loadMappingRows +
 * a JS scan) is the first line and covers the ordinary case; this catch
 * converts the rare concurrent-confirm race into the same typed 409 instead
 * of leaking a raw 500.
 */
async function upsertMappingRow(params: {
  existing: MappingRow | null;
  integrationId: string;
  partnerId: string;
  breezeEntityType: MappingEntityType;
  breezeEntityId: string;
  remoteEntityType: 'Customer' | 'Item';
  fields: MappingDecisionFields;
  /** Display name of the connected provider, for the operator-facing conflict message. */
  providerLabel: string;
}): Promise<MappingRow> {
  try {
    if (params.existing) {
      const rows = await db
        .update(accountingEntityMappings)
        .set({ ...params.fields, updatedAt: new Date() })
        .where(and(
          eq(accountingEntityMappings.id, params.existing.id),
          eq(accountingEntityMappings.partnerId, params.partnerId),
        ))
        .returning();
      const row = (rows as MappingRow[])[0];
      if (!row) {
        throw new Error(`mapping decision update matched no accounting_entity_mappings row (id=${params.existing.id})`);
      }
      return row;
    }

    const rows = await db
      .insert(accountingEntityMappings)
      .values({
        integrationId: params.integrationId,
        partnerId: params.partnerId,
        breezeEntityType: params.breezeEntityType,
        breezeEntityId: params.breezeEntityId,
        remoteEntityType: params.remoteEntityType,
        ...params.fields,
      })
      .returning();
    const row = (rows as MappingRow[])[0];
    if (!row) throw new Error('mapping decision insert returned no row');
    return row;
  } catch (err) {
    if (isPgUniqueViolation(err, 'accounting_entity_mappings_remote_uniq')) {
      throw new AccountingMappingError(
        'mapping_conflict',
        409,
        `This ${params.providerLabel} record is already mapped to a different Breeze entity`,
      );
    }
    throw err;
  }
}

/**
 * Verifies ownership, resolves the remote entity type, and — for `confirmed`
 * — checks both that no OTHER Breeze entity already claims the chosen remote
 * id (app-layer first line) and that the remote entity actually exists before
 * ever writing a mapping row. `create_new` and `unlinked` never call
 * QuickBooks: they only ever write `remoteEntityId: null`.
 *
 * Only `confirmed` resolves a LIVE access token (Phase C, Task 5 follow-up
 * gate #2): `create_new`/`unlinked` are purely-local decisions, so refreshing
 * a token they never use would needlessly block an expired-grant partner from
 * unlinking a mapping — `getValidAccessToken` throwing `ReauthRequiredError`
 * must not stand between that partner and a decision that never touches
 * QuickBooks.
 */
export async function saveMappingDecision(
  input: SaveMappingDecisionInput,
  runInDbContext: DbContextRunner,
): Promise<MappingResult> {
  const { partnerId, provider, breezeEntityType, breezeEntityId, decision, remoteEntityId } = input;
  assertNoAmbientDbContext('saveMappingDecision');
  const remoteEntityType: 'Customer' | 'Item' = breezeEntityType === 'org' ? 'Customer' : 'Item';

  // Phase 1 — connection, ownership and the current mapping rows, in ONE short
  // context that commits before the `confirmed` path's QuickBooks list call.
  const { conn, mappingRows, hiddenOrgIds, existing } = await runInDbContext(async () => {
    const conn = await resolveConnection(partnerId, { provider });

    if (breezeEntityType === 'org') {
      // `unlinked` never reaches QuickBooks, so it stays available for the
      // hidden org — see loadOwnedOrg's doc comment.
      await loadOwnedOrg(breezeEntityId, partnerId, { allowQuickSupport: decision === 'unlinked' });
    } else {
      await loadOwnedCatalogItem(breezeEntityId, partnerId);
    }

    const mappingRows = await loadMappingRows(partnerId, conn.id, breezeEntityType);
    // A mapping row owned by the hidden org must not block a REAL org from
    // claiming that remote id — `buildOrgProposals` already stopped treating
    // those rows as claims, and a suggestion it offers has to be confirmable.
    // The row itself stays put; only its veto is dropped. (Catalog items have
    // no org axis, so the set is only needed for the org branch.)
    const hiddenOrgIds = breezeEntityType === 'org'
      ? await loadQuickSupportOrgIds(partnerId)
      : new Set<string>();
    return {
      conn,
      mappingRows,
      hiddenOrgIds,
      existing: mappingRows.find((m) => m.breezeEntityId === breezeEntityId) ?? null,
    };
  });

  const providerLabel = accountingProviderDisplayName(conn.provider);
  let fields: MappingDecisionFields;
  let proposedRemoteName: string | null = null;

  if (decision === 'confirmed') {
    if (!remoteEntityId) {
      throw new AccountingMappingError('entity_not_found', 404, 'A remote entity id is required to confirm a mapping');
    }

    const conflict = mappingRows.find((m) => (
      m.remoteEntityId === remoteEntityId
      && m.breezeEntityId !== breezeEntityId
      && !hiddenOrgIds.has(m.breezeEntityId)
    ));
    if (conflict) {
      throw new AccountingMappingError(
        'mapping_conflict',
        409,
        `This ${providerLabel} record is already mapped to a different Breeze entity`,
      );
    }

    // Only the confirmed path ever talks to QuickBooks, so only it resolves a
    // live token — resolved here, not upfront (see the function doc above).
    const liveConn = await resolveLiveConnection(conn);
    const remoteProvider = getAccountingProvider(conn.provider);
    const found: RemoteCustomer | RemoteItem | null = await callProviderOrThrow(
      async () => {
        // One record when the provider can (Xero W03 refinement 15); the whole list otherwise (QuickBooks).
        if (remoteEntityType === 'Customer' && remoteProvider.getRemoteCustomer) return remoteProvider.getRemoteCustomer(liveConn, remoteEntityId);
        if (remoteEntityType === 'Item' && remoteProvider.getRemoteItem) return remoteProvider.getRemoteItem(liveConn, remoteEntityId);
        const list: Array<RemoteCustomer | RemoteItem> = remoteEntityType === 'Customer'
          ? await remoteProvider.listRemoteCustomers(liveConn)
          : await remoteProvider.listRemoteItems(liveConn);
        return list.find((r) => r.id === remoteEntityId) ?? null;
      },
      `${providerLabel} returned an error while listing ${remoteEntityType === 'Customer' ? 'customers' : 'items'}`,
    );
    if (!found) {
      throw new AccountingMappingError('entity_not_found', 404, `${providerLabel} ${remoteEntityType} ${remoteEntityId} was not found`);
    }

    // RemoteItem carries no currencyCode (only RemoteCustomer does), so this is
    // naturally null for a catalog_item confirm even without the explicit gate
    // — the gate documents the intent rather than relying on that incidentally.
    proposedRemoteName = found.displayName;
    const remoteCurrencyCode = breezeEntityType === 'org' ? (found as RemoteCustomer).currencyCode ?? null : null;
    fields = { remoteEntityId, remoteSyncToken: found.remoteVersion ?? null, remoteCurrencyCode, linkStatus: 'confirmed', syncStatus: 'pending', lastError: null };
  } else if (decision === 'create_new') {
    fields = { remoteEntityId: null, remoteSyncToken: null, remoteCurrencyCode: null, linkStatus: 'create_new', syncStatus: 'pending', lastError: null };
  } else {
    fields = { remoteEntityId: null, remoteSyncToken: null, remoteCurrencyCode: null, linkStatus: 'unlinked', syncStatus: 'pending', lastError: null };
  }

  // Phase 2 — its own short context, so the decision COMMITS on its own.
  const row = await runInDbContext(() =>
    upsertMappingRow({ existing, integrationId: conn.id, partnerId, breezeEntityType, breezeEntityId, remoteEntityType, fields, providerLabel }));
  return mappingResult(row, proposedRemoteName);
}

/** Fill only an empty address, rechecking at write time so a concurrent edit wins. */
async function importMappedAddress(partnerId: string, orgId: string, remote: RemoteRef): Promise<boolean> {
  const billing = billingAddressColumns(remote.billAddr);
  const hasBilling = Object.values(billing).some((value) => value?.trim());
  const address = siteAddressFrom(remote.shipAddr ?? remote.billAddr);
  if (!hasBilling && !address) return false;
  const [updated] = await db.update(organizations).set({ ...billing, updatedAt: new Date() }).where(and(
    eq(organizations.id, orgId), eq(organizations.partnerId, partnerId),
    isNull(organizations.deletedAt), notQuickSupportOrg(),
    ...[
      organizations.billingAddressLine1, organizations.billingAddressLine2, organizations.billingAddressCity,
      organizations.billingAddressRegion, organizations.billingAddressPostalCode, organizations.billingAddressCountry,
    ].map((column) => sql`coalesce(trim(${column}), '') = ''`),
  )).returning({ id: organizations.id });
  if (!updated) return false;

  let siteImported = false;
  if (address) {
    // Sites have no isDefault flag. Use the oldest site (stable id tie-break),
    // never another site's empty address when the default already has one.
    const updatedSites = await db.update(sites).set({ address, updatedAt: new Date() }).where(and(
      eq(sites.orgId, orgId),
      sql`${sites.orgId} in (select id from ${organizations} where ${organizations.partnerId} = ${partnerId})`,
      sql`${sites.id} = (select id from ${sites} where org_id = ${orgId} order by created_at, id limit 1)`,
      sql`not exists (select 1 from jsonb_each_text(case when jsonb_typeof(${sites.address}) = 'object'
        then ${sites.address} else '{}'::jsonb end) as entry where coalesce(trim(entry.value), '') <> '')`,
      sql`(${sites.address} is null or jsonb_typeof(${sites.address}) = 'object')`,
    )).returning({ id: sites.id });
    siteImported = updatedSites.length > 0;
  }
  return hasBilling || siteImported;
}

/** Only the fields QBO omission (§11) needs: never send a raw org/item row across the seam. */
function orgBillingAddress(org: OrgRow): RemoteAddress | undefined {
  const addr: RemoteAddress = {
    line1: org.billingAddressLine1 ?? undefined,
    line2: org.billingAddressLine2 ?? undefined,
    city: org.billingAddressCity ?? undefined,
    region: org.billingAddressRegion ?? undefined,
    postalCode: org.billingAddressPostalCode ?? undefined,
    country: org.billingAddressCountry ?? undefined,
  };
  return Object.values(addr).some((v) => v?.trim()) ? addr : undefined;
}

/**
 * `org.currencyCode` is `NOT NULL` with no `.default()` (schema/orgs.ts) —
 * every org-creation path stamps it explicitly, so there is no "org has no
 * stamped currency" fallback to write: the column itself is the resolution.
 * Breeze has no separate org phone/company-name field, so those optional
 * payload fields are simply omitted rather than guessed.
 */
function buildCustomerPayload(org: OrgRow): AccountingCustomerPayload {
  return {
    organizationId: org.id,
    displayName: org.name,
    billingEmail: orgBillingEmail(org.billingContact),
    taxId: org.taxId ?? null,
    billAddr: orgBillingAddress(org),
    currencyCode: org.currencyCode,
  };
}

/**
 * A catalog item's sell price for QuickBooks sync, resolved in the PARTNER'S
 * default currency (`partners.currency_code`) — the same target
 * `catalogService.ts`'s (unexported) `resolvePartnerCurrency` uses whenever no
 * org context picks one. There IS no org context here: unlike an invoice
 * line, a catalog item syncs once per partner, not once per org, so
 * `AccountingItemPayload` carries exactly one currency+price pair.
 *
 * Queries `catalog_item_prices` — since #3812 that table is the only place a
 * sell price exists (the deprecated `catalog_items.unit_price` mirror is
 * dropped). A partner-currency row is not guaranteed: an item created from
 * cost + markup in a different currency can have zero rows in the partner
 * currency. A missing row is therefore a real, user-actionable gap, not a bug — this
 * throws `item_price_required` (409) before any provider call, same shape as
 * `income_account_required`.
 */
async function resolveItemSellPrice(
  item: CatalogItemRow,
  partnerId: string,
  providerLabel: string,
): Promise<{ currencyCode: string; unitPrice: string }> {
  const partnerRows = await db
    .select({ currencyCode: partners.currencyCode })
    .from(partners)
    .where(eq(partners.id, partnerId));
  const targetCurrency = (partnerRows[0] as { currencyCode: string } | undefined)?.currencyCode;
  if (!targetCurrency) {
    throw new AccountingMappingError('entity_not_found', 404, 'Partner not found');
  }

  const priceRows = await db
    .select()
    .from(catalogItemPrices)
    .where(and(eq(catalogItemPrices.itemId, item.id), eq(catalogItemPrices.partnerId, partnerId)));
  const priceRow = (priceRows as Array<{ currencyCode: string; unitPrice: string }>)
    .find((p) => p.currencyCode === targetCurrency);
  if (!priceRow) {
    throw new AccountingMappingError(
      'item_price_required',
      409,
      `This catalog item has no price in the partner's currency (${targetCurrency}); add one before syncing to ${providerLabel}`,
    );
  }
  return { currencyCode: targetCurrency, unitPrice: priceRow.unitPrice };
}

/**
 * CREATE-ONLY currency contract for QuickBooks entities (multi-currency §11).
 *
 * QuickBooks derives a Customer's/Item's `CurrencyRef` from the realm's home
 * currency at CREATE time and treats it as immutable afterwards. Breeze never
 * sends `CurrencyRef` (see the comment on `QuickbooksProvider.upsertCustomer`),
 * so creating an entity whose Breeze-stamped currency differs from the realm's
 * silently books it at the realm default: the sync goes green, the remote
 * record is wrong forever, and Phase C's `assertAccountingInvoicePushCurrency`
 * then 409s every invoice for that org with no remediation short of deleting
 * the QBO record by hand.
 *
 * A NULL home currency blocks too, for the same reason
 * `assertAccountingInvoicePushCurrency` blocks on it: "we don't know" is not
 * "it matches". Reconnecting the integration re-captures it.
 *
 * Deliberately NOT applied to an UPDATE (a mapping that already carries a
 * `remoteEntityId`): the remote entity's currency was fixed when it was
 * created, a sparse update cannot change it, and gating updates would strand
 * every already-linked entity in a realm whose home currency was later
 * corrected — with no way to push the fix.
 */
function assertCreateCurrencyMatchesRealm(
  conn: AccountingConnection,
  entityCurrencyCode: string | null,
  label: 'organization' | 'catalog item',
): void {
  const providerLabel = accountingProviderDisplayName(conn.provider);
  const home = normalizeCurrencyCode(conn.homeCurrency);
  if (!home) {
    throw new AccountingMappingError(
      'currency_mismatch',
      409,
      `The connected ${providerLabel} company's home currency is unknown, so Breeze cannot safely create records in it. Reconnect ${providerLabel} to capture it, then retry.`,
    );
  }
  const entityCurrency = normalizeCurrencyCode(entityCurrencyCode);
  if (entityCurrency !== home) {
    throw new AccountingMappingError(
      'currency_mismatch',
      409,
      `This ${label} is priced in ${entityCurrency ?? 'an unknown currency'}, but the connected ${providerLabel} company's home currency is ${home}. ${providerLabel} fixes a record's currency when it is created and never lets it change, so Breeze will not create it.`,
    );
  }
}

/** Breeze `service` -> QBO `Service`; `hardware`/`software` -> `NonInventory` (plan Global Constraints). */
function buildItemPayload(
  item: CatalogItemRow,
  conn: AccountingConnection,
  currencyCode: string,
  unitPrice: string,
): AccountingItemPayload {
  return {
    catalogItemId: item.id,
    name: item.name,
    sku: item.sku ?? undefined,
    description: item.description ?? null,
    type: item.itemType === 'service' ? 'Service' : 'NonInventory',
    unitPrice,
    currencyCode,
    taxable: item.taxable,
    active: item.isActive,
    incomeAccountRef: conn.defaultIncomeAccountRef ?? undefined,
  };
}

/**
 * A provider verdict that is the USER's to resolve, not an upstream fault (Xero W03):
 * persisted on the row, answered 409, terminal in the worker, never sent to Sentry.
 * Null for everything else — including every QuickBooks fault, which carries its own
 * fault number in providerCode, never one of these neutral codes.
 *
 * `isUpdate` — the mapping already carried a remote ref when this sync started.
 * A `duplicate_name` then means the rename collided with a DIFFERENT, unlinked
 * provider record: nothing is being created, and re-pointing the mapping at that
 * record would orphan the one Breeze owns. So the link-instead advice and
 * `details.remoteName` appear ONLY when Breeze was creating; an update gets
 * rename advice with no `details`. W03b must offer "Link it" only when
 * `details.remoteName` is present.
 */
function providerRefusal(
  err: unknown, entityType: MappingEntityType, providerLabel: string, breezeName: string, isUpdate: boolean,
): AccountingMappingError | null {
  const noun = entityType === 'org' ? 'customer' : 'item';
  const local = entityType === 'org' ? 'organization' : 'catalog item';
  switch (refusalCodeOf(err)) {
    case 'duplicate_name':
      if (isUpdate) {
        return new AccountingMappingError('duplicate_name', 409,
          `${providerLabel} already has a different ${noun} named "${breezeName}" — rename this ${local} or that ${providerLabel} ${noun}, then sync again`,
          { cause: err });
      }
      return new AccountingMappingError('duplicate_name', 409,
        `${providerLabel} already has a ${noun} named "${breezeName}" — link this ${local} to it instead of creating a new one`,
        { details: { remoteName: breezeName }, cause: err });
    case 'remote_archived':
      return new AccountingMappingError('remote_archived', 409,
        `The ${providerLabel} ${noun} for "${breezeName}" is archived — restore it in ${providerLabel}, then sync again`, { cause: err });
    case 'remote_missing':
      return new AccountingMappingError('remote_missing', 409,
        `The ${providerLabel} ${noun} linked to "${breezeName}" no longer exists — unlink it and map it again`, { cause: err });
    case 'duplicate_key':
      // Reuses the existing terminal conflict code: more than one remote record claims this entity.
      return new AccountingMappingError('mapping_conflict', 409,
        `${providerLabel} has more than one ${noun} that could be this ${local} — link the right one explicitly`, { cause: err });
    case 'insufficient_scope':
      return new AccountingMappingError('provider_permission', 409, providerPermissionMessage(providerLabel), { cause: err });
    default:
      return null;
  }
}

/**
 * A provider 400 `validation` verdict that carries NO neutral refusal code
 * (#7292) — e.g. a contact name Xero rejects, or a QuickBooks Business
 * Validation fault. Retrying re-sends the same payload, so it can never
 * succeed: terminal 409 with a fix-the-record message. Gated on HTTP 400 so a
 * provider's own pre-flight `validation` guards (no status: a missing tenant
 * id, an unparseable payload) and every transient (5xx, timeout, 429) keep the
 * retryable 502. The message carries the fault CLASS only (`providerFaultSuffix`),
 * the same text invoice-push already persists — never a raw provider body.
 * The payment/invoice-only refusal codes `providerRefusal` does not handle
 * (remote_locked, amount_exceeds_due, remote_deleted, remote_batched) are not
 * produced by customer/item upserts; if one ever were, it lands here — still
 * terminal, with this generic advice.
 */
function providerRejection(
  err: unknown, entityType: MappingEntityType, providerLabel: string,
): AccountingMappingError | null {
  if (!isAccountingProviderError(err) || err.kind !== 'validation' || err.httpStatus !== 400) return null;
  const noun = entityType === 'org' ? 'customer' : 'item';
  const local = entityType === 'org' ? 'organization' : 'catalog item';
  return new AccountingMappingError('provider_rejected', 409,
    `${providerLabel} rejected the ${noun} sync${providerFaultSuffix(err)} — check this ${local}'s details in Breeze, then sync again`,
    { cause: err });
}

/**
 * Never persists or rethrows a raw provider error's message/body (mirrors
 * `callProviderOrThrow`'s sanitization) — only the HTTP status, when the
 * provider attached one, is safe to keep.
 */
function sanitizeSyncErrorMessage(err: unknown, breezeEntityType: MappingEntityType, providerLabel: string): string {
  const label = breezeEntityType === 'org' ? 'customer' : 'item';
  const status = err && typeof err === 'object' && typeof (err as { status?: unknown }).status === 'number'
    ? (err as { status: number }).status
    : undefined;
  return status
    ? `${providerLabel} rejected the ${label} sync (HTTP ${status})`
    : `${providerLabel} rejected the ${label} sync`;
}

/**
 * Records a provider-side sync failure (Global Constraint: persist
 * `sync_status='error'` + a sanitized message, then rethrow). Best-effort: if
 * this housekeeping write itself fails, that is reported to Sentry but never
 * allowed to replace the caller's real (already-typed) error.
 */
async function markMappingError(mappingId: string, partnerId: string, message: string): Promise<void> {
  try {
    const rows = await db
      .update(accountingEntityMappings)
      .set({ syncStatus: 'error', lastError: message, updatedAt: new Date() })
      .where(and(eq(accountingEntityMappings.id, mappingId), eq(accountingEntityMappings.partnerId, partnerId)))
      .returning();
    if (!(rows as unknown[])[0]) {
      captureException(
        new Error(`markMappingError matched no accounting_entity_mappings row (id=${mappingId})`),
        undefined,
        { service: 'accountingMappingService', accounting_mapping_id: mappingId, partner_id: partnerId },
      );
    }
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
      service: 'accountingMappingService', accounting_mapping_id: mappingId, partner_id: partnerId,
    });
  }
}

/**
 * Persists a successful QuickBooks create/update. UPDATE keys on both mapping
 * id and partnerId and checks `returning()` for zero rows (Global Constraint)
 * — a zero-row result here means the remote write SUCCEEDED but Breeze could
 * not record it, which the caller must treat as non-retry-safe (a blind retry
 * risks creating a second QuickBooks entity).
 */
async function persistRemoteRef(params: {
  mappingId: string;
  partnerId: string;
  remoteEntityId: string;
  remoteSyncToken: string | null;
  remoteCurrencyCode: string | null;
  /** Display name of the connected provider, for the refusal message. */
  providerLabel: string;
}): Promise<MappingRow> {
  const rows = await db
    .update(accountingEntityMappings)
    .set({
      remoteEntityId: params.remoteEntityId,
      remoteSyncToken: params.remoteSyncToken,
      remoteCurrencyCode: params.remoteCurrencyCode,
      linkStatus: 'confirmed',
      syncStatus: 'synced',
      lastSyncedAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(and(eq(accountingEntityMappings.id, params.mappingId), eq(accountingEntityMappings.partnerId, params.partnerId)))
    .returning();
  const row = (rows as MappingRow[])[0];
  if (!row) {
    throw new Error(`persistRemoteRef matched no accounting_entity_mappings row (id=${params.mappingId}); refusing to lose the ${params.providerLabel} sync result`);
  }
  return row;
}

/**
 * Pushes a confirmed/create_new mapping to QuickBooks. `unlinked` (and any
 * mapping that isn't `confirmed`/`create_new`, e.g. a never-persisted
 * `suggested` state) refuses to sync. A present `remoteEntityId` makes this a
 * QBO sparse update carrying the persisted Id+SyncToken (mirrors
 * `AccountingEntityMapping` in types.ts); its absence makes it a create —
 * Item creation additionally requires `accounting_connections.default_income_account_ref`.
 *
 * `target` (Xero W01): the sync worker passes the exact connection its job was
 * enqueued for (`{ connectionId }`); omitted, the connection is resolved by
 * `input.provider` as before (the explicit-sync route and the invoice push).
 */
export async function syncMappedEntity(
  input: SyncMappedEntityInput,
  runInDbContext: DbContextRunner,
  target?: ConnectionTarget,
): Promise<MappingResult> {
  assertNoAmbientDbContext('syncMappedEntity');
  const providerLabel = accountingProviderDisplayName(input.provider);
  const redis = getRedis();
  if (!redis) throw new Error(`${providerLabel} mapping sync coordination is unavailable`);
  const key = `accounting-mapping-sync:${input.partnerId}:${input.provider}:${input.breezeEntityType}:${input.breezeEntityId}`;
  const token = randomUUID();
  const ttl = 5 * 60 * 1000;
  if (await redis.set(key, token, 'PX', ttl, 'NX') !== 'OK') {
    throw new AccountingMappingError('sync_in_progress', 409, `${providerLabel} mapping sync is already in progress`);
  }
  // The web's explicit sync and the worker must not both CREATE from the same
  // pending row. Renew across slow provider calls without holding a DB connection.
  const renewal = setInterval(() => {
    void redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
      1, key, token, ttl,
    ).catch((err: unknown) => captureException(err instanceof Error ? err : new Error(String(err))));
  }, 30_000);
  renewal.unref();
  try {
    return await syncMappedEntityUnderLease(input, runInDbContext, target);
  } finally {
    clearInterval(renewal);
    try {
      await redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1, key, token,
      );
    } catch (err) {
      // A release outage must not replace a successfully persisted remote ref.
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

async function syncMappedEntityUnderLease(
  input: SyncMappedEntityInput,
  runInDbContext: DbContextRunner,
  target: ConnectionTarget,
): Promise<MappingResult> {
  const { partnerId, provider, breezeEntityType, breezeEntityId } = input;
  assertNoAmbientDbContext('syncMappedEntity');

  // Phase 1 — connection, mapping row, ownership and the whole provider
  // payload, in ONE short context. Every pre-flight refusal
  // (mapping_not_ready, income_account_required, item_price_required,
  // entity_not_found, a create-time currency_mismatch) is raised here, before
  // a token is resolved or QuickBooks is touched.
  const prep = await runInDbContext(async () => {
    const conn = await resolveConnection(partnerId, target ?? { provider });
    const providerLabel = accountingProviderDisplayName(conn.provider);

    const mappingRows = await loadMappingRows(partnerId, conn.id, breezeEntityType);
    const mapping = mappingRows.find((m) => m.breezeEntityId === breezeEntityId);
    if (!mapping) {
      throw new AccountingMappingError('mapping_not_ready', 409, 'Confirm or create a mapping before syncing this entity');
    }
    if (mapping.linkStatus !== 'confirmed' && mapping.linkStatus !== 'create_new') {
      throw new AccountingMappingError('mapping_not_ready', 409, 'Confirm or create a mapping before syncing this entity');
    }

    const existingRef: AccountingEntityMappingSeam | null = mapping.remoteEntityId
      ? { remoteEntityId: mapping.remoteEntityId, remoteSyncToken: mapping.remoteSyncToken ?? null }
      : null;
    const isCreate = existingRef === null;

    try {
      if (breezeEntityType === 'org') {
        const org = await loadOwnedOrg(breezeEntityId, partnerId);
        if (isCreate) assertCreateCurrencyMatchesRealm(conn, org.currencyCode, 'organization');
        return { conn, mapping, existingRef, kind: 'org' as const, providerLabel, payload: buildCustomerPayload(org) };
      }

      if (isCreate && !conn.defaultIncomeAccountRef) {
        throw new AccountingMappingError(
          'income_account_required',
          409,
          `Select a default ${providerLabel} income account before creating catalog items in ${providerLabel}`,
        );
      }
      const item = await loadOwnedCatalogItem(breezeEntityId, partnerId);
      const { currencyCode, unitPrice } = await resolveItemSellPrice(item, partnerId, providerLabel);
      // The Item payload's currency is the PARTNER's default currency (see
      // resolveItemSellPrice), so that is what QBO would stamp the new Item at.
      if (isCreate) assertCreateCurrencyMatchesRealm(conn, currencyCode, 'catalog item');
      return {
        conn, mapping, existingRef, kind: 'catalog_item' as const, providerLabel,
        payload: buildItemPayload(item, conn, currencyCode, unitPrice),
      };
    } catch (err) {
      if (!(err instanceof AccountingMappingError) || ![
        'currency_mismatch', 'income_account_required', 'item_price_required',
      ].includes(err.code)) throw err;
      // Return the refusal from this transaction so lastError commits before
      // the typed error reaches the route or worker. A throw here rolls it back.
      await db.update(accountingEntityMappings)
        .set({ lastError: err.message, updatedAt: new Date() })
        .where(and(eq(accountingEntityMappings.id, mapping.id), eq(accountingEntityMappings.partnerId, partnerId)))
        .returning();
      return { refusal: err };
    }
  });

  if ('refusal' in prep) throw prep.refusal;
  const { conn, mapping, existingRef, providerLabel } = prep;
  // Token refresh and the upsert both run with NO context held (see
  // `resolveLiveConnection`).
  const liveConn = await resolveLiveConnection(conn);
  const providerImpl = getAccountingProvider(conn.provider);

  let remote: RemoteRef;
  try {
    remote = prep.kind === 'org'
      ? await providerImpl.upsertCustomer(liveConn, prep.payload, existingRef)
      : await providerImpl.upsertItem(liveConn, prep.payload, existingRef);
  } catch (err) {
    // A typed error can still surface here from `callProviderOrThrow`-shaped
    // provider wrappers; it never reached QuickBooks, so there is nothing to
    // record and marking sync_status='error' would misreport the mapping.
    if (err instanceof AccountingMappingError) throw err;

    // A refusal the USER resolves (Xero W03: duplicate name, archived/missing
    // record, missing scope) takes precedence: persisted like any failure, but a
    // typed 409 and no Sentry event. Throttled (Xero W01): the same persistence
    // as a transient failure — the row is marked `error` so it never reads as
    // silently stuck — but no Sentry event, and a typed 429 the worker delays on
    // and the route answers with Retry-After. A code-less provider validation
    // verdict (#7292) is terminal like a refusal, but still reported to Sentry
    // (once — the worker no longer retries it).
    const refusal = providerRefusal(
      err, breezeEntityType, providerLabel, prep.kind === 'org' ? prep.payload.displayName : prep.payload.name, existingRef !== null,
    );
    const rejection = refusal ? null : providerRejection(err, breezeEntityType, providerLabel);
    const retryAfterMs = refusal || rejection ? null : rateLimitRetryAfterMs(err);
    const throttleSource = rateLimitSourceOf(err) ?? undefined;
    const message = refusal?.message ?? rejection?.message ?? (retryAfterMs !== null
      ? providerRateLimitedRetryLaterMessage(providerLabel, 'sync', throttleSource)
      : sanitizeSyncErrorMessage(err, breezeEntityType, providerLabel));
    if (!refusal && retryAfterMs === null) {
      captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
        service: 'accountingMappingService', accounting_mapping_id: mapping.id, breeze_entity_type: breezeEntityType,
      });
    }
    // Phase 2 (failure) — its OWN short context, so the error marker COMMITS
    // before the throw below. Written inside the caller's transaction it was a
    // savepoint that rolled straight back with the throw: the operator saw a
    // mapping still reading 'pending' and no lastError at all.
    try {
      await runInDbContext(() => markMappingError(mapping.id, partnerId, message));
    } catch (markErr) {
      // Still best-effort: markMappingError swallows a failed UPDATE, but
      // OPENING the context can fail too, and that must not replace the typed
      // 409/502/429 below with a raw error. On the failure path Sentry already
      // has the original (so does a #7292 rejection); on the refusal and throttle
      // paths it does not (neither is ever reported), so this marker failure is
      // the only event for it.
      captureException(markErr instanceof Error ? markErr : new Error(String(markErr)), undefined, {
        service: 'accountingMappingService', accounting_mapping_id: mapping.id, partner_id: partnerId,
      });
    }
    if (refusal) throw refusal;
    if (rejection) throw rejection;
    if (retryAfterMs !== null) {
      throw new AccountingMappingError('rate_limited', 429, message, { retryAfterMs, throttleSource, cause: err });
    }
    throw new AccountingMappingError('provider_error', 502, message);
  }

  let addressImported = false;
  let synced: MappingRow;
  try {
    // Phase 2 (success) — likewise its own short, self-committing context.
    synced = await runInDbContext(async () => {
      if (prep.kind === 'org' && existingRef && !prep.payload.billAddr) {
        addressImported = await importMappedAddress(partnerId, breezeEntityId, remote);
      }
      return persistRemoteRef({
        mappingId: mapping.id,
        partnerId,
        remoteEntityId: remote.id,
        remoteSyncToken: remote.remoteVersion ?? null,
        // RemoteRef.currencyCode is only ever populated by upsertCustomer (types.ts)
        // — a catalog_item sync's `remote` always carries none — but the explicit
        // entity-type gate documents that this is a deliberate org-only field, not
        // an accident of which provider methods happen to fill it in today.
        remoteCurrencyCode: breezeEntityType === 'org' ? (remote.currencyCode ?? null) : null,
        providerLabel,
      });
    });
  } catch (dbErr) {
    captureException(dbErr instanceof Error ? dbErr : new Error(String(dbErr)), undefined, {
      service: 'accountingMappingService',
      accounting_mapping_id: mapping.id,
      remote_entity_id: remote.id,
      remote_sync_token: remote.remoteVersion ?? 'none',
    });
    const label = breezeEntityType === 'org' ? 'customer' : 'item';
    const message = `${providerLabel} accepted the ${label} sync (remote id ${remote.id}) but Breeze failed to record it — do not retry; contact support to reconcile`;
    // Exclude this unsafe-to-retry create from the pending-row sweep too.
    try {
      await runInDbContext(() => markMappingError(mapping.id, partnerId, message));
    } catch (markErr) {
      captureException(markErr instanceof Error ? markErr : new Error(String(markErr)));
    }
    throw new AccountingMappingError('record_failed', 502, message);
  }
  if (addressImported) {
    // Emit after the transaction commits, so the org Activity tab records only
    // completed imports. Audit failure must not turn an accepted sync into a retry.
    try {
      writeAuditEvent(requestLikeFromSnapshot({}), {
        orgId: breezeEntityId, actorType: 'system', initiatedBy: 'integration',
        action: 'organization.update', resourceType: 'organization', resourceId: breezeEntityId,
        details: { source: conn.provider, message: `Address imported from ${providerLabel}` },
      });
    } catch (err) {
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }
  return mappingResult(synced, prep.kind === 'org' ? prep.payload.displayName : prep.payload.name);
}
