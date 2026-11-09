import { and, eq, inArray } from 'drizzle-orm';
import { db, withDbTransaction } from '../db';
import { organizations, pax8CompanyMappings } from '../db/schema';
import {
  matchExternalRecordsToOrgs,
  type AutoMapOrgRow,
  type OrgMatchTier,
} from './externalTenantMapping';
import { loadMappableOrgs } from './mappableOrgs';
import { mapPax8Company } from './pax8SyncService';
import { isUnassignedPoolOrgType } from './unassignedPool/orgType';

/**
 * Pax8 company -> org suggestions. Matching never writes: a person confirms each
 * suggestion through POST /pax8/companies/map or /pax8/companies/map-bulk.
 */

export interface Pax8CompanyRowForMatch {
  pax8CompanyId: string;
  pax8CompanyName: string | null;
  mappedOrgId: string | null;
  ignored: boolean;
  createdAt: Date;
}

export type Pax8CompanySuggestion =
  | { status: 'match'; orgId: string; orgName: string; tier: OrgMatchTier; matchKey: string }
  | { status: 'ambiguous'; candidates: Array<{ orgId: string; orgName: string }>; tier: OrgMatchTier; matchKey: string }
  | {
      status: 'contested';
      orgId: string;
      orgName: string;
      tier: OrgMatchTier;
      matchKey: string;
      contestedWith: Array<{ pax8CompanyId: string; pax8CompanyName: string | null }>;
    };

const NEW_UNMAPPED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function isUnmappedActive(row: Pax8CompanyRowForMatch): boolean {
  return !row.ignored && row.mappedOrgId === null;
}

export function buildPax8CompanySuggestions(
  rows: Pax8CompanyRowForMatch[],
  orgs: AutoMapOrgRow[],
): Map<string, Pax8CompanySuggestion> {
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  const nameOf = (id: string) => orgName.get(id) ?? '';
  const companyById = new Map(rows.map((r) => [r.pax8CompanyId, r]));

  const excludedOrgIds = new Set<string>();
  for (const row of rows) {
    if (!row.ignored && row.mappedOrgId !== null) excludedOrgIds.add(row.mappedOrgId);
  }

  const matches = matchExternalRecordsToOrgs(
    rows.filter(isUnmappedActive).map((r) => ({ id: r.pax8CompanyId, name: r.pax8CompanyName })),
    orgs,
    { cardinality: 'one_to_one', excludedOrgIds },
  );

  const out = new Map<string, Pax8CompanySuggestion>();
  for (const [companyId, m] of matches) {
    if (m.status === 'match') {
      out.set(companyId, { status: 'match', orgId: m.orgId, orgName: nameOf(m.orgId), tier: m.tier, matchKey: m.matchKey });
    } else if (m.status === 'ambiguous') {
      out.set(companyId, {
        status: 'ambiguous',
        candidates: m.candidateOrgIds.map((orgId) => ({ orgId, orgName: nameOf(orgId) })),
        tier: m.tier,
        matchKey: m.matchKey,
      });
    } else if (m.status === 'contested') {
      out.set(companyId, {
        status: 'contested',
        orgId: m.orgId,
        orgName: nameOf(m.orgId),
        tier: m.tier,
        matchKey: m.matchKey,
        contestedWith: m.contestedWith.map((id) => ({
          pax8CompanyId: id,
          pax8CompanyName: companyById.get(id)?.pax8CompanyName ?? null,
        })),
      });
    }
  }
  return out;
}

export function summarizePax8Companies(
  rows: Pax8CompanyRowForMatch[],
  suggestions: Map<string, Pax8CompanySuggestion>,
  now: Date,
): { unmapped: number; suggested: number; newUnmapped: number } {
  const cutoff = now.getTime() - NEW_UNMAPPED_WINDOW_MS;
  let unmapped = 0;
  let newUnmapped = 0;
  for (const row of rows) {
    if (!isUnmappedActive(row)) continue;
    unmapped += 1;
    if (row.createdAt.getTime() >= cutoff) newUnmapped += 1;
  }
  let suggested = 0;
  for (const s of suggestions.values()) if (s.status === 'match') suggested += 1;
  return { unmapped, suggested, newUnmapped };
}

export interface VerifiedPax8MapSource {
  source: 'manual' | 'suggestion';
  matchTier: OrgMatchTier | null;
  matchKey: string | null;
}

/**
 * A client may CLAIM a mapping came from a suggestion; the server only records
 * `suggestion` when a fresh recompute still yields exactly that match.
 */
export function verifyPax8SuggestionSource(
  claimedSource: 'manual' | 'suggestion' | undefined,
  pax8CompanyId: string,
  orgId: string | null,
  suggestions: Map<string, Pax8CompanySuggestion>,
): VerifiedPax8MapSource {
  if (claimedSource === 'suggestion' && orgId) {
    const s = suggestions.get(pax8CompanyId);
    if (s && s.status === 'match' && s.orgId === orgId) {
      return { source: 'suggestion', matchTier: s.tier, matchKey: s.matchKey };
    }
  }
  return { source: 'manual', matchTier: null, matchKey: null };
}

/** Every Pax8 company of one integration, in the shape the matcher reads. */
export async function loadPax8CompanyRowsForMatch(
  integrationId: string,
  partnerId: string,
): Promise<Pax8CompanyRowForMatch[]> {
  return db
    .select({
      pax8CompanyId: pax8CompanyMappings.pax8CompanyId,
      pax8CompanyName: pax8CompanyMappings.pax8CompanyName,
      mappedOrgId: pax8CompanyMappings.orgId,
      ignored: pax8CompanyMappings.ignored,
      createdAt: pax8CompanyMappings.createdAt,
    })
    .from(pax8CompanyMappings)
    .where(and(
      eq(pax8CompanyMappings.integrationId, integrationId),
      eq(pax8CompanyMappings.partnerId, partnerId),
    ));
}

export type Pax8BulkMapErrorCode = 'STALE_REVIEW' | 'NOT_FOUND' | 'INVALID_TARGET';

/** A refusal of the whole batch. Nothing was written when one is thrown. */
export class Pax8BulkMapError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: Pax8BulkMapErrorCode,
    message: string,
    readonly pax8CompanyIds: string[],
  ) {
    super(message);
    this.name = 'Pax8BulkMapError';
  }
}

export interface Pax8BulkMapItem {
  pax8CompanyId: string;
  orgId: string;
  /** The row's org when the reviewer saw it; `null` for an unmapped row. */
  expectedOrgId: string | null;
}

export interface Pax8BulkMapResult {
  pax8CompanyId: string;
  orgId: string;
  previousOrgId: string | null;
  source: 'bulk_suggestion' | 'manual';
  matchTier: OrgMatchTier | null;
  matchKey: string | null;
}

/**
 * Map a reviewed batch of Pax8 companies in one transaction, or nothing.
 *
 * - The reviewed rows are locked first (in id order), so a concurrent single map
 *   or a second submit of the same batch waits, then sees the new state.
 * - A row whose org differs from `expectedOrgId`, or that was ignored since the
 *   review, refuses the whole batch with STALE_REVIEW. Replaying a batch that
 *   already succeeded is therefore refused, never applied twice.
 * - Every target is checked before the first write.
 * - `source` is `bulk_suggestion` only when the matcher, run on the state the
 *   rows were locked in, still suggests exactly that org. Otherwise `manual`.
 *
 * The caller authorizes each target org (`canAccessOrg`) before calling, and
 * catches `Pax8BulkMapError` outside this call.
 */
export async function mapPax8CompaniesBulk(input: {
  integrationId: string;
  partnerId: string;
  items: Pax8BulkMapItem[];
}): Promise<Pax8BulkMapResult[]> {
  const { integrationId, partnerId, items } = input;
  return withDbTransaction(async () => {
    const companyIds = items.map((item) => item.pax8CompanyId);
    const locked = await db
      .select({
        pax8CompanyId: pax8CompanyMappings.pax8CompanyId,
        orgId: pax8CompanyMappings.orgId,
        ignored: pax8CompanyMappings.ignored,
      })
      .from(pax8CompanyMappings)
      .where(and(
        eq(pax8CompanyMappings.integrationId, integrationId),
        eq(pax8CompanyMappings.partnerId, partnerId),
        inArray(pax8CompanyMappings.pax8CompanyId, companyIds),
      ))
      .orderBy(pax8CompanyMappings.pax8CompanyId)
      .for('update');
    const lockedById = new Map(locked.map((row) => [row.pax8CompanyId, row]));

    const missing = companyIds.filter((id) => !lockedById.has(id));
    if (missing.length > 0) {
      throw new Pax8BulkMapError(
        404,
        'NOT_FOUND',
        'Pax8 company mapping not found. Run sync first to discover companies.',
        missing,
      );
    }

    const stale = items
      .filter((item) => {
        const row = lockedById.get(item.pax8CompanyId)!;
        return row.ignored || (row.orgId ?? null) !== item.expectedOrgId;
      })
      .map((item) => item.pax8CompanyId);
    if (stale.length > 0) {
      throw new Pax8BulkMapError(409, 'STALE_REVIEW', 'Some companies changed since this review was opened', stale);
    }

    // The rule mapPax8Company enforces per item, checked for the whole batch
    // before any write so a bad target never leaves a partial write behind.
    const targetIds = [...new Set(items.map((item) => item.orgId))];
    const targets = await db
      .select({ id: organizations.id, partnerId: organizations.partnerId, type: organizations.type })
      .from(organizations)
      .where(inArray(organizations.id, targetIds));
    const targetById = new Map(targets.map((org) => [org.id, org]));
    const invalid = items
      .filter((item) => {
        const org = targetById.get(item.orgId);
        return !org || org.partnerId !== partnerId || isUnassignedPoolOrgType(org.type);
      })
      .map((item) => item.pax8CompanyId);
    if (invalid.length > 0) {
      throw new Pax8BulkMapError(
        400,
        'INVALID_TARGET',
        'A target organization does not belong to this partner or is the unassigned-device holding area',
        invalid,
      );
    }

    const companyRows = await loadPax8CompanyRowsForMatch(integrationId, partnerId);
    const suggestions = buildPax8CompanySuggestions(companyRows, await loadMappableOrgs(db, partnerId));

    const results: Pax8BulkMapResult[] = [];
    for (const item of items) {
      const verified = verifyPax8SuggestionSource('suggestion', item.pax8CompanyId, item.orgId, suggestions);
      await mapPax8Company({
        integrationId,
        partnerId,
        pax8CompanyId: item.pax8CompanyId,
        orgId: item.orgId,
        ignored: false,
      });
      results.push({
        pax8CompanyId: item.pax8CompanyId,
        orgId: item.orgId,
        previousOrgId: lockedById.get(item.pax8CompanyId)!.orgId ?? null,
        source: verified.source === 'suggestion' ? 'bulk_suggestion' : 'manual',
        matchTier: verified.matchTier,
        matchKey: verified.matchKey,
      });
    }
    return results;
  });
}
