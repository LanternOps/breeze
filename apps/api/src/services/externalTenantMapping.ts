/**
 * PURE vendor-tenant -> Breeze-org auto-mapping rules, shared by every external
 * provider framework (backup, EDR). Both inputs are already scoped to ONE
 * connection and ONE partner by the caller; nothing here widens that.
 */

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

function normalizeName(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

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

/**
 * Name-based candidates -- SUGGESTIONS ONLY. A human with full partner access
 * confirms one through the manual remap path.
 *
 * `alreadyClaimedOrgIds` lets a caller exclude orgs a same-pass external-code
 * commit already took.
 */
export function resolveAutoMapNameSuggestions(
  rows: AutoMapTenantRow[],
  orgs: AutoMapOrgRow[],
  alreadyClaimedOrgIds: ReadonlySet<string> = new Set(),
): AutoMapNameSuggestion[] {
  const orgsByName = new Map<string, string[]>();
  for (const org of orgs) {
    const key = normalizeName(org.name);
    if (!key) continue;
    const bucket = orgsByName.get(key);
    if (bucket) bucket.push(org.id);
    else orgsByName.set(key, [org.id]);
  }

  const claimed = new Set(alreadyClaimedOrgIds);
  const out: AutoMapNameSuggestion[] = [];
  for (const row of rows) {
    const key = normalizeName(row.vendorName);
    if (!key) continue;
    const candidates = orgsByName.get(key);
    if (!candidates || candidates.length !== 1) continue;
    const orgId = candidates[0]!;
    if (claimed.has(orgId)) continue;
    claimed.add(orgId);
    out.push({ tenantId: row.id, orgId });
  }
  return out;
}
