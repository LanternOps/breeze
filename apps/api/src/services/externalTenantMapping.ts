/**
 * PURE vendor-tenant -> Breeze-org auto-mapping rules, shared by every external
 * provider framework (backup, EDR, Pax8; UniFi sites next). Both inputs are already scoped
 * to ONE connection and ONE partner by the caller; nothing here widens that.
 */
import { exactOrgMatchKey, normalizeOrgMatchName } from '@breeze/shared';

/**
 * Version/variant-agnostic UUID shape — deliberately NOT the RFC-4122-strict
 * pattern, matching `PG_UUID_REGEX`'s rationale in apps/api/src/db/index.ts.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AutoMapTenantRow {
  id: string;
  vendorName: string;
  vendorExternalCode: string | null;
}

export interface AutoMapOrgRow {
  id: string;
  name: string;
}

export type AutoMapDecision = {
  tenantId: string;
  orgId: string;
  mappingSource: 'auto_external_code';
};

export type AutoMapNameSuggestion = {
  tenantId: string;
  orgId: string;
};

/**
 * Only an external code commits automatically -- it is an identifier the MSP
 * typed on purpose. A normalized-name match is NEVER written here (renaming an
 * org to match an unmapped vendor tenant would silently capture that tenant's
 * inventory on the next sync); see `resolveAutoMapNameSuggestions`.
 *
 * An org is claimed by at most one tenant per pass -- two vendor tenants
 * pointing at one Breeze org is a data problem a human must settle.
 */
export function resolveAutoMappings(
  rows: AutoMapTenantRow[],
  orgs: AutoMapOrgRow[],
): AutoMapDecision[] {
  const orgById = new Map(orgs.map((o) => [o.id.toLowerCase(), o.id]));

  const claimed = new Set<string>();
  const out: AutoMapDecision[] = [];
  for (const row of rows) {
    const code = row.vendorExternalCode?.trim();
    if (!code || !UUID_RE.test(code)) continue;
    const orgId = orgById.get(code.toLowerCase());
    if (!orgId || claimed.has(orgId)) continue;
    claimed.add(orgId);
    out.push({ tenantId: row.id, orgId, mappingSource: 'auto_external_code' });
  }
  return out;
}

export type OrgMatchTier = 'exact' | 'normalized';

/**
 * Suggestion policy for several external records reaching one org. It decides
 * what Breeze SUGGESTS, never what a person may save.
 * - `one_to_one` (Pax8, backup, EDR): every record that reaches the same org is
 *   `contested`, so none of them is offered for one-click accept.
 * - `many_to_one` (for UniFi sites, a later wave): several sites legitimately
 *   belong to one customer.
 */
export type MatchCardinality = 'one_to_one' | 'many_to_one';

export interface ExternalNameRecord {
  id: string;
  name: string | null;
}

export type OrgNameMatch =
  | { status: 'match'; orgId: string; tier: OrgMatchTier; matchKey: string }
  /** Two or more orgs share the record's key. Ids sorted ascending. */
  | { status: 'ambiguous'; candidateOrgIds: string[]; tier: OrgMatchTier; matchKey: string }
  /** `one_to_one` only: other records reach the same org. Record ids sorted ascending. */
  | { status: 'contested'; orgId: string; tier: OrgMatchTier; matchKey: string; contestedWith: string[] }
  | { status: 'none' };

function indexOrgsByKey(
  orgs: readonly AutoMapOrgRow[],
  keyOf: (name: string) => string | null,
): Map<string, string[]> {
  const byKey = new Map<string, Set<string>>();
  for (const org of orgs) {
    const key = keyOf(org.name);
    if (!key) continue;
    const bucket = byKey.get(key);
    if (bucket) bucket.add(org.id);
    else byKey.set(key, new Set([org.id]));
  }
  // Sorted so an ambiguous result never depends on the order orgs were loaded in.
  return new Map([...byKey].map(([key, ids]) => [key, [...ids].sort()]));
}

function matchOneRecord(
  name: string | null,
  exactIndex: Map<string, string[]>,
  normalizedIndex: Map<string, string[]>,
): OrgNameMatch {
  const tiers: Array<[OrgMatchTier, string | null, Map<string, string[]>]> = [
    ['exact', exactOrgMatchKey(name), exactIndex],
    ['normalized', normalizeOrgMatchName(name), normalizedIndex],
  ];
  for (const [tier, matchKey, index] of tiers) {
    if (!matchKey) continue;
    // The normalized tier runs only when the exact tier found zero orgs, so an
    // exact hit on `Acme Inc` beats a normalized tie with `Acme LLC`.
    const candidates = index.get(matchKey);
    if (!candidates) continue;
    if (candidates.length === 1) return { status: 'match', orgId: candidates[0]!, tier, matchKey };
    return { status: 'ambiguous', candidateOrgIds: candidates, tier, matchKey };
  }
  return { status: 'none' };
}

/**
 * Deterministic name matcher: `exact` (trim + lowercase), then `normalized`
 * (corporate suffixes, punctuation and accents ignored). No fuzzy tier.
 *
 * Returns one entry per record id, and the result does not depend on the order
 * of `records` or `orgs`. Matching never writes: a person confirms each
 * suggestion through the integration's normal mapping route.
 */
export function matchExternalRecordsToOrgs(
  records: readonly ExternalNameRecord[],
  orgs: readonly AutoMapOrgRow[],
  opts: { cardinality: MatchCardinality; excludedOrgIds?: ReadonlySet<string> },
): Map<string, OrgNameMatch> {
  const excluded = opts.excludedOrgIds;
  const pool = excluded && excluded.size > 0 ? orgs.filter((o) => !excluded.has(o.id)) : orgs;
  const exactIndex = indexOrgsByKey(pool, exactOrgMatchKey);
  const normalizedIndex = indexOrgsByKey(pool, normalizeOrgMatchName);

  const out = new Map<string, OrgNameMatch>();
  for (const record of records) {
    // Results are keyed by record id; a duplicate would silently drop a record
    // and could hide a contest. Callers pass primary keys, so this never fires.
    if (out.has(record.id)) throw new Error(`matchExternalRecordsToOrgs: duplicate record id ${record.id}`);
    out.set(record.id, matchOneRecord(record.name, exactIndex, normalizedIndex));
  }
  if (opts.cardinality === 'many_to_one') return out;

  const recordIdsByOrg = new Map<string, string[]>();
  for (const [recordId, match] of out) {
    if (match.status !== 'match') continue;
    const bucket = recordIdsByOrg.get(match.orgId);
    if (bucket) bucket.push(recordId);
    else recordIdsByOrg.set(match.orgId, [recordId]);
  }
  for (const recordIds of recordIdsByOrg.values()) {
    if (recordIds.length < 2) continue;
    const sorted = [...recordIds].sort();
    for (const recordId of sorted) {
      const match = out.get(recordId);
      if (match?.status !== 'match') continue;
      out.set(recordId, {
        status: 'contested',
        orgId: match.orgId,
        tier: match.tier,
        matchKey: match.matchKey,
        contestedWith: sorted.filter((id) => id !== recordId),
      });
    }
  }
  return out;
}

/**
 * Name-based candidates -- SUGGESTIONS ONLY. A human with full partner access
 * confirms one through the manual remap path.
 *
 * Runs `matchExternalRecordsToOrgs` with `one_to_one` cardinality and returns
 * only its `match` entries, in input order. Two customers reaching one org are
 * contested, so neither is suggested. `alreadyClaimedOrgIds` lets a caller
 * exclude orgs a same-pass external-code commit already took.
 */
export function resolveAutoMapNameSuggestions(
  rows: AutoMapTenantRow[],
  orgs: AutoMapOrgRow[],
  alreadyClaimedOrgIds: ReadonlySet<string> = new Set(),
): AutoMapNameSuggestion[] {
  const matches = matchExternalRecordsToOrgs(
    rows.map((row) => ({ id: row.id, name: row.vendorName })),
    orgs,
    { cardinality: 'one_to_one', excludedOrgIds: alreadyClaimedOrgIds },
  );
  const out: AutoMapNameSuggestion[] = [];
  for (const row of rows) {
    const match = matches.get(row.id);
    if (match?.status === 'match') out.push({ tenantId: row.id, orgId: match.orgId });
  }
  return out;
}
