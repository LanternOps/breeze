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
  organizationExternalLinks,
  organizations,
} from '../../db/schema';
import type { AccountingEntityMapping as AccountingEntityMappingRow } from '../../db/schema';
import { getConnection } from './accountingConnectionService';
import type { AccountingConnection } from './accountingConnectionService';
import { getValidAccessToken, ReauthRequiredError } from './accountingTokens';
import { getAccountingProvider } from './providerRegistry';
import { captureException } from '../sentry';
import type { RemoteCustomer, RemoteIncomeAccount, RemoteItem } from './types';

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
  | 'mapping_not_ready';

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
    confidence: 'existing_link',
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
  const remoteCustomers = await callProviderOrThrow(
    () => getAccountingProvider(conn.provider).listRemoteCustomers(liveConn),
    'QuickBooks returned an error while listing customers',
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
  const remoteItems = await callProviderOrThrow(
    () => getAccountingProvider(conn.provider).listRemoteItems(liveConn),
    'QuickBooks returned an error while listing items',
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
  return callProviderOrThrow(
    () => getAccountingProvider(conn.provider).listRemoteIncomeAccounts(liveConn),
    'QuickBooks returned an error while listing income accounts',
  );
}
