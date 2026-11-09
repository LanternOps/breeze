import {
  matchExternalRecordsToOrgs,
  type AutoMapOrgRow,
  type OrgMatchTier,
} from './externalTenantMapping';

/**
 * Pure helpers behind Pax8 company -> org suggestions. Matching never writes:
 * a person confirms each suggestion through POST /pax8/companies/map.
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
