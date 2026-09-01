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
 * already claimed by another Breeze entity's mapping row. Soft-deleted orgs
 * never enter the candidate/target set at all (query-level filter).
 *
 * Ordinary suggestions (tiers 3-5) are NOT persisted — they are cheap to
 * recompute and must not become stale rows merely because a user opened the
 * screen. Only the imported-customer backfill (tier 2) is durable, because it
 * is provenance, not a guess.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  accountingEntityMappings,
  catalogItems,
  catalogItemPrices,
  organizationExternalLinks,
  organizations,
  partners,
} from '../../db/schema';
import type { AccountingEntityMapping as AccountingEntityMappingRow } from '../../db/schema';
import { getConnection } from './accountingConnectionService';
import type { AccountingConnection } from './accountingConnectionService';
import { normalizeCurrencyCode } from './accountingCurrency';
import { getValidAccessToken, ReauthRequiredError } from './accountingTokens';
import { getAccountingProvider } from './providerRegistry';
import { captureException } from '../sentry';
import { isPgUniqueViolation } from '../../utils/pgErrors';
import type {
  AccountingCustomerPayload,
  AccountingEntityMapping as AccountingEntityMappingSeam,
  AccountingItemPayload,
  RemoteAddress,
  RemoteCustomer,
  RemoteIncomeAccount,
  RemoteItem,
  RemoteRef,
} from './types';

export type MappingEntityType = 'org' | 'catalog_item';
export type MappingDecision = 'confirmed' | 'create_new' | 'unlinked';

export interface ListMappingProposalsInput {
  partnerId: string;
  provider: 'quickbooks';
  entityType: MappingEntityType;
}

export type AccountingMappingErrorCode =
  | 'not_connected'
  | 'reauth_required'
  | 'quickbooks_error'
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
  | 'item_price_required';

// Typed failure the route translates straight to an HTTP status (mirrors
// QbImportError in quickbooksCustomerImport.ts). Narrowing `code`/`status` to
// literals lets a route drop its `as`-cast.
export class AccountingMappingError extends Error {
  constructor(
    public readonly code: AccountingMappingErrorCode,
    public readonly status: 404 | 409 | 502,
    message: string,
  ) {
    super(message);
    this.name = 'AccountingMappingError';
  }
}

export interface MappingProposal {
  breezeEntityType: MappingEntityType;
  breezeEntityId: string;
  breezeDisplayName: string;
  remoteEntityType: 'Customer' | 'Item';
  proposedRemoteId: string | null;
  proposedRemoteName: string | null;
  confidence: 'existing_link' | 'exact_email' | 'exact_sku' | 'exact_name' | 'none' | 'ambiguous';
  linkStatus: 'suggested' | 'confirmed' | 'create_new' | 'unlinked';
  syncStatus: 'pending' | 'synced' | 'error';
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
 * Resolve the partner's connection and a valid access token, rejecting
 * disconnected/reauth states as typed errors. Token rotation (and its
 * persisted write) runs under a system DB context per the plan's Global
 * Constraints — it is a partner-axis write, not tied to the caller's
 * request-scoped RLS context. Everything else in this module reads through
 * the ambient `db` (the caller's partner-scoped context), matching "Request
 * route reads/writes otherwise stay in the caller's partner RLS context."
 */
async function resolveConnectionAndToken(
  partnerId: string,
  provider: 'quickbooks',
): Promise<{ conn: AccountingConnection; liveConn: AccountingConnection }> {
  const conn = await getConnection(db, partnerId, provider);
  if (!conn) {
    throw new AccountingMappingError('not_connected', 404, 'QuickBooks is not connected for this partner');
  }
  // A previously-connected partner whose token was revoked/expired needs
  // "reconnect", not "connect" — distinct remediation from never-connected.
  if (conn.status === 'reauth_required') {
    throw new AccountingMappingError('reauth_required', 409, 'QuickBooks needs to be reconnected');
  }
  if (conn.status !== 'connected') {
    throw new AccountingMappingError('not_connected', 404, 'QuickBooks is not connected for this partner');
  }

  let accessToken: string;
  try {
    accessToken = await runOutsideDbContext(() => withSystemDbAccessContext(() => getValidAccessToken(db, conn)));
  } catch (err) {
    if (err instanceof ReauthRequiredError) {
      throw new AccountingMappingError('reauth_required', 409, 'QuickBooks needs to be reconnected');
    }
    throw err;
  }

  return { conn, liveConn: { ...conn, accessToken } };
}

/**
 * Runs a provider call and converts any failure into a typed 502 — QBO API
 * failures (401/403/429/5xx, unparseable body) are upstream, not a Breeze bug.
 * The original error (which may carry a raw response body) is reported to
 * Sentry for forensics but never surfaced in the thrown message, so a caller
 * can't leak an upstream response body to the client.
 */
async function callProviderOrThrow<T>(action: () => Promise<T>, errorMessage: string): Promise<T> {
  try {
    return await action();
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)));
    throw new AccountingMappingError('quickbooks_error', 502, errorMessage);
  }
}

type MappingRow = AccountingEntityMappingRow;

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

async function proposeOrgMappings(
  partnerId: string,
  conn: AccountingConnection,
  liveConn: AccountingConnection,
): Promise<MappingProposal[]> {
  // runOutsideDbContext here is self-documentation/parity with the
  // quickbooksCustomerImport.ts precedent, NOT a standalone fix: per the
  // comment on SELF_MANAGED_DB_CONTEXT_ROUTES
  // (middleware/selfManagedDbContextRoutes.ts), it only swaps which `db` the
  // AsyncLocalStorage proxy resolves to — it does NOT close an outer
  // transaction the auth middleware already opened for the request. Unlike
  // quickbooksCustomerImport's routes, this service's DB reads deliberately
  // stay in the CALLER'S ambient partner context (ruling in the task brief),
  // so the ONLY thing that actually keeps this multi-second QBO page fetch
  // from pinning a pooled connection idle-in-transaction (#1105) is the
  // caller opting out of the auto request-transaction. Task 5's mapping
  // routes MUST be added to SELF_MANAGED_DB_CONTEXT_ROUTES — the same
  // treatment already given `/accounting/:provider/customers` — or every
  // proposal/income-account request holds a connection across the QBO round
  // trip.
  const remoteCustomers = await runOutsideDbContext(() =>
    callProviderOrThrow(
      () => getAccountingProvider(conn.provider).listRemoteCustomers(liveConn),
      'QuickBooks returned an error while listing customers',
    ),
  );
  const remoteNameById = new Map(remoteCustomers.map((c) => [c.id, c.displayName]));

  const orgs = await db
    .select()
    .from(organizations)
    .where(and(eq(organizations.partnerId, partnerId), isNull(organizations.deletedAt)));

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
      eq(organizationExternalLinks.system, 'quickbooks'),
    ));

  const mappingByOrgId = new Map(mappingRows.map((m) => [m.breezeEntityId, m as MappingRow]));

  // Backfill imported-customer provenance into a durable confirmed mapping the
  // first time reconciliation sees it — every later call hits this as a
  // current-mapping (tier 1) row instead of re-deriving it. ON CONFLICT DO
  // NOTHING: a concurrent caller may have already inserted the same row.
  for (const link of links) {
    if (mappingByOrgId.has(link.orgId)) continue;
    const [inserted] = await db
      .insert(accountingEntityMappings)
      .values({
        integrationId: conn.id,
        partnerId,
        breezeEntityType: 'org',
        breezeEntityId: link.orgId,
        remoteEntityType: 'Customer',
        remoteEntityId: link.externalId,
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
): Promise<MappingProposal[]> {
  // See the comment in proposeOrgMappings above — same SELF_MANAGED_DB_CONTEXT_ROUTES obligation.
  const remoteItems = await runOutsideDbContext(() =>
    callProviderOrThrow(
      () => getAccountingProvider(conn.provider).listRemoteItems(liveConn),
      'QuickBooks returned an error while listing items',
    ),
  );
  const remoteNameById = new Map(remoteItems.map((i) => [i.id, i.displayName]));

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

export async function listMappingProposals(input: ListMappingProposalsInput): Promise<MappingProposal[]> {
  const { partnerId, provider, entityType } = input;
  const { conn, liveConn } = await resolveConnectionAndToken(partnerId, provider);

  return entityType === 'org'
    ? proposeOrgMappings(partnerId, conn, liveConn)
    : proposeItemMappings(partnerId, conn, liveConn);
}

/**
 * Used by the income-account selector (Task 5's `GET
 * /:provider/income-accounts` route): owns connection lookup, token refresh,
 * and the provider call so the route stays a thin pass-through.
 */
export async function listRemoteIncomeAccountsForPartner(input: {
  partnerId: string;
  provider: 'quickbooks';
}): Promise<RemoteIncomeAccount[]> {
  const { conn, liveConn } = await resolveConnectionAndToken(input.partnerId, input.provider);
  // Same SELF_MANAGED_DB_CONTEXT_ROUTES obligation as proposeOrgMappings above —
  // Task 5's `GET /:provider/income-accounts` route must be registered there too.
  return runOutsideDbContext(() =>
    callProviderOrThrow(
      () => getAccountingProvider(conn.provider).listRemoteIncomeAccounts(liveConn),
      'QuickBooks returned an error while listing income accounts',
    ),
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
  provider: 'quickbooks';
  breezeEntityType: MappingEntityType;
  breezeEntityId: string;
  decision: MappingDecision;
  remoteEntityId?: string;
}

export interface SyncMappedEntityInput {
  partnerId: string;
  provider: 'quickbooks';
  breezeEntityType: MappingEntityType;
  breezeEntityId: string;
}

type OrgRow = typeof organizations.$inferSelect;
type CatalogItemRow = typeof catalogItems.$inferSelect;

async function loadOwnedOrg(orgId: string, partnerId: string): Promise<OrgRow> {
  const rows = await db
    .select()
    .from(organizations)
    .where(and(
      eq(organizations.id, orgId),
      eq(organizations.partnerId, partnerId),
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
        'This QuickBooks record is already mapped to a different Breeze entity',
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
 */
export async function saveMappingDecision(input: SaveMappingDecisionInput): Promise<MappingRow> {
  const { partnerId, provider, breezeEntityType, breezeEntityId, decision, remoteEntityId } = input;
  const { conn, liveConn } = await resolveConnectionAndToken(partnerId, provider);
  const remoteEntityType: 'Customer' | 'Item' = breezeEntityType === 'org' ? 'Customer' : 'Item';

  if (breezeEntityType === 'org') {
    await loadOwnedOrg(breezeEntityId, partnerId);
  } else {
    await loadOwnedCatalogItem(breezeEntityId, partnerId);
  }

  const mappingRows = await loadMappingRows(partnerId, conn.id, breezeEntityType);
  const existing = mappingRows.find((m) => m.breezeEntityId === breezeEntityId) ?? null;

  let fields: MappingDecisionFields;

  if (decision === 'confirmed') {
    if (!remoteEntityId) {
      throw new AccountingMappingError('entity_not_found', 404, 'A remote entity id is required to confirm a mapping');
    }

    const conflict = mappingRows.find((m) => m.remoteEntityId === remoteEntityId && m.breezeEntityId !== breezeEntityId);
    if (conflict) {
      throw new AccountingMappingError(
        'mapping_conflict',
        409,
        'This QuickBooks record is already mapped to a different Breeze entity',
      );
    }

    const remoteProvider = getAccountingProvider(conn.provider);
    const remoteList = await runOutsideDbContext(() =>
      callProviderOrThrow(
        () => (remoteEntityType === 'Customer' ? remoteProvider.listRemoteCustomers(liveConn) : remoteProvider.listRemoteItems(liveConn)),
        `QuickBooks returned an error while listing ${remoteEntityType === 'Customer' ? 'customers' : 'items'}`,
      ),
    );
    const found = remoteList.find((r) => r.id === remoteEntityId);
    if (!found) {
      throw new AccountingMappingError('entity_not_found', 404, `QuickBooks ${remoteEntityType} ${remoteEntityId} was not found`);
    }

    fields = { remoteEntityId, remoteSyncToken: found.syncToken ?? null, linkStatus: 'confirmed', syncStatus: 'pending', lastError: null };
  } else if (decision === 'create_new') {
    fields = { remoteEntityId: null, remoteSyncToken: null, linkStatus: 'create_new', syncStatus: 'pending', lastError: null };
  } else {
    fields = { remoteEntityId: null, remoteSyncToken: null, linkStatus: 'unlinked', syncStatus: 'pending', lastError: null };
  }

  return upsertMappingRow({ existing, integrationId: conn.id, partnerId, breezeEntityType, breezeEntityId, remoteEntityType, fields });
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
  return Object.values(addr).some((v) => v !== undefined) ? addr : undefined;
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
 * Deliberately queries `catalog_item_prices` directly rather than reading
 * `catalogItems.unitPrice` — that column is a deprecated read-mirror the
 * schema comment marks "read by nothing" (schema/catalog.ts), and it is not
 * guaranteed to exist in the partner currency (an item created from cost +
 * markup in a different currency can have zero rows in the partner currency).
 * A missing row is therefore a real, user-actionable gap, not a bug — this
 * throws `item_price_required` (409) before any provider call, same shape as
 * `income_account_required`.
 */
async function resolveItemSellPrice(
  item: CatalogItemRow,
  partnerId: string,
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
      `This catalog item has no price in the partner's currency (${targetCurrency}); add one before syncing to QuickBooks`,
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
  const home = normalizeCurrencyCode(conn.homeCurrency);
  if (!home) {
    throw new AccountingMappingError(
      'currency_mismatch',
      409,
      'The connected QuickBooks company\'s home currency is unknown, so Breeze cannot safely create records in it. Reconnect QuickBooks to capture it, then retry.',
    );
  }
  const entityCurrency = normalizeCurrencyCode(entityCurrencyCode);
  if (entityCurrency !== home) {
    throw new AccountingMappingError(
      'currency_mismatch',
      409,
      `This ${label} is priced in ${entityCurrency ?? 'an unknown currency'}, but the connected QuickBooks company's home currency is ${home}. QuickBooks fixes a record's currency when it is created and never lets it change, so Breeze will not create it.`,
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
 * Never persists or rethrows a raw provider error's message/body (mirrors
 * `callProviderOrThrow`'s sanitization) — only the HTTP status, when the
 * provider attached one, is safe to keep.
 */
function sanitizeSyncErrorMessage(err: unknown, breezeEntityType: MappingEntityType): string {
  const label = breezeEntityType === 'org' ? 'customer' : 'item';
  const status = err && typeof err === 'object' && typeof (err as { status?: unknown }).status === 'number'
    ? (err as { status: number }).status
    : undefined;
  return status ? `QuickBooks rejected the ${label} sync (HTTP ${status})` : `QuickBooks rejected the ${label} sync`;
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
        { service: 'accountingMappingService', mappingId, partnerId },
      );
    }
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
      service: 'accountingMappingService', mappingId, partnerId,
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
}): Promise<MappingRow> {
  const rows = await db
    .update(accountingEntityMappings)
    .set({
      remoteEntityId: params.remoteEntityId,
      remoteSyncToken: params.remoteSyncToken,
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
    throw new Error(`persistRemoteRef matched no accounting_entity_mappings row (id=${params.mappingId}); refusing to lose the QuickBooks sync result`);
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
 */
export async function syncMappedEntity(input: SyncMappedEntityInput): Promise<MappingRow> {
  const { partnerId, provider, breezeEntityType, breezeEntityId } = input;
  const { conn, liveConn } = await resolveConnectionAndToken(partnerId, provider);
  const providerImpl = getAccountingProvider(conn.provider);

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

  let remote: RemoteRef;
  try {
    if (breezeEntityType === 'org') {
      const org = await loadOwnedOrg(breezeEntityId, partnerId);
      if (isCreate) assertCreateCurrencyMatchesRealm(conn, org.currencyCode, 'organization');
      remote = await runOutsideDbContext(() => providerImpl.upsertCustomer(liveConn, buildCustomerPayload(org), existingRef));
    } else {
      if (isCreate && !conn.defaultIncomeAccountRef) {
        throw new AccountingMappingError(
          'income_account_required',
          409,
          'Select a default QuickBooks income account before creating catalog items in QuickBooks',
        );
      }
      const item = await loadOwnedCatalogItem(breezeEntityId, partnerId);
      const { currencyCode, unitPrice } = await resolveItemSellPrice(item, partnerId);
      // The Item payload's currency is the PARTNER's default currency (see
      // resolveItemSellPrice), so that is what QBO would stamp the new Item at.
      if (isCreate) assertCreateCurrencyMatchesRealm(conn, currencyCode, 'catalog item');
      remote = await runOutsideDbContext(() =>
        providerImpl.upsertItem(liveConn, buildItemPayload(item, conn, currencyCode, unitPrice), existingRef),
      );
    }
  } catch (err) {
    // Pre-flight typed errors (income_account_required, item_price_required,
    // entity_not_found) never reached the provider — nothing to record, and
    // marking sync_status='error' for a request that never attempted a sync
    // would misreport the mapping's health.
    if (err instanceof AccountingMappingError) throw err;

    const message = sanitizeSyncErrorMessage(err, breezeEntityType);
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
      service: 'accountingMappingService', mappingId: mapping.id, breezeEntityType,
    });
    await markMappingError(mapping.id, partnerId, message);
    throw new AccountingMappingError('quickbooks_error', 502, message);
  }

  try {
    return await persistRemoteRef({
      mappingId: mapping.id,
      partnerId,
      remoteEntityId: remote.id,
      remoteSyncToken: remote.syncToken ?? null,
    });
  } catch (dbErr) {
    captureException(dbErr instanceof Error ? dbErr : new Error(String(dbErr)), undefined, {
      service: 'accountingMappingService',
      mappingId: mapping.id,
      remoteEntityId: remote.id,
      remoteSyncToken: remote.syncToken ?? 'none',
    });
    const label = breezeEntityType === 'org' ? 'customer' : 'item';
    throw new AccountingMappingError(
      'quickbooks_error',
      502,
      `QuickBooks accepted the ${label} sync (remote id ${remote.id}) but Breeze failed to record it — do not retry; contact support to reconcile`,
    );
  }
}
