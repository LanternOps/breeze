import { sql } from 'drizzle-orm';
import type { TopologyScope } from '@breeze/shared';
import type { db } from '../../db';
import { parsePrefix } from './ipAddress';

/**
 * Site network declarations (site-location spec S§6.2,
 * docs/superpowers/specs/monitoring/2026-10-03-topology-site-location-design.md).
 * An administrator declares a site's networks through the subnets of its ENABLED discovery
 * profiles and its network baselines. Matching against observed prefixes is exact normalized
 * IPv4 prefix equality, never containment: a declared /16 claims no observed /24 (a scan range
 * is not a broadcast domain, collection spec C §6). v1 is IPv4 only (S§3 D10).
 */

/**
 * Spec S§6.2: accepts an IPv4 CIDR of length 8–30 and zeroes its host bits (`10.1.5.1/24` → `10.1.5.0/24`);
 * returns null for anything else (ranges, bare addresses, /31, /32, IPv6, unparsable text).
 */
export function normalizeDeclaredPrefix(text: string): string | null {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(trimmed)) return null;
  const parsed = parsePrefix(trimmed);
  if (!parsed || parsed.family !== 4 || parsed.length < 8 || parsed.length > 30) return null;
  const hostBits = BigInt(32 - parsed.length);
  const network = (parsed.value >> hostBits) << hostBits;
  const octets = [24n, 16n, 8n, 0n].map((shift) => Number((network >> shift) & 255n));
  return `${octets.join('.')}/${parsed.length}`;
}

export type DeclarationKind = 'discovery_profile' | 'network_baseline';
export type DeclarationSource = { kind: DeclarationKind; id: string };
/** `ignored` counts declaration entries that are not a usable prefix (ranges, hosts, IPv6, garbage), plus entries past SITE_DECLARATION_ENTRY_CAP. */
export type SiteNetworkDeclarations = { prefixes: Map<string, DeclarationSource[]>; ignored: number };

type DeclarationRow = { kind: DeclarationKind; id: string; site_id: string; raw: string };

/** Fold raw declaration rows into per-site normalized prefixes, each listing its distinct sources. */
export function foldDeclarations(rows: readonly DeclarationRow[]): { bySite: Map<string, Map<string, DeclarationSource[]>>; ignored: number } {
  const bySite = new Map<string, Map<string, DeclarationSource[]>>();
  let ignored = 0;
  for (const row of rows) {
    const prefix = normalizeDeclaredPrefix(row.raw);
    if (!prefix) { ignored++; continue; }
    const site = bySite.get(row.site_id) ?? new Map<string, DeclarationSource[]>();
    const sources = site.get(prefix) ?? [];
    if (!sources.some((source) => source.kind === row.kind && source.id === row.id)) sources.push({ kind: row.kind, id: row.id });
    site.set(prefix, sources);
    bySite.set(row.site_id, site);
  }
  return { bySite, ignored };
}

/** Declaration entries read per site; entries past it are counted as ignored. */
export const SITE_DECLARATION_ENTRY_CAP = 4_096;

/** Enabled discovery profiles' subnets plus network baselines, for ONE site (W1 graph read). */
export async function readSiteNetworkDeclarations(tx: Pick<typeof db, 'execute'>, scope: TopologyScope): Promise<SiteNetworkDeclarations> {
  const rows = await tx.execute<DeclarationRow>(sql`
    SELECT 'discovery_profile' AS kind, p.id::text AS id, p.site_id::text AS site_id, s.subnet AS raw
      FROM discovery_profiles p CROSS JOIN LATERAL unnest(p.subnets) AS s(subnet)
      WHERE p.org_id = ${scope.orgId}::uuid AND p.site_id = ${scope.siteId}::uuid AND p.enabled
    UNION ALL
    SELECT 'network_baseline', b.id::text, b.site_id::text, b.subnet
      FROM network_baselines b WHERE b.org_id = ${scope.orgId}::uuid AND b.site_id = ${scope.siteId}::uuid
    ORDER BY 1, 2, 4 LIMIT ${SITE_DECLARATION_ENTRY_CAP + 1}`);
  const list = [...rows];
  const folded = foldDeclarations(list.slice(0, SITE_DECLARATION_ENTRY_CAP));
  return { prefixes: folded.bySite.get(scope.siteId.toLowerCase()) ?? new Map(), ignored: folded.ignored + Math.max(0, list.length - SITE_DECLARATION_ENTRY_CAP) };
}

/** Declaration entries read per org (site location W2 evaluator); past it the org's presence coverage is limited. */
export const ORG_DECLARATION_ENTRY_CAP = 16_384;

/**
 * Every site's declarations in one org (W2 presence evaluator, S§7.2 step 1): enabled discovery profiles' subnets
 * plus network baselines, normalized by the same rule as the per-site read.
 */
export async function readOrgNetworkDeclarations(tx: Pick<typeof db, 'execute'>, orgId: string): Promise<{
  bySite: Map<string, Map<string, DeclarationSource[]>>; ignored: number; truncated: boolean;
}> {
  const rows = await tx.execute<DeclarationRow>(sql`
    SELECT 'discovery_profile' AS kind, p.id::text AS id, p.site_id::text AS site_id, s.subnet AS raw
      FROM discovery_profiles p CROSS JOIN LATERAL unnest(p.subnets) AS s(subnet)
      WHERE p.org_id = ${orgId}::uuid AND p.enabled
    UNION ALL
    SELECT 'network_baseline', b.id::text, b.site_id::text, b.subnet
      FROM network_baselines b WHERE b.org_id = ${orgId}::uuid
    ORDER BY 3, 1, 2, 4 LIMIT ${ORG_DECLARATION_ENTRY_CAP + 1}`);
  const list = [...rows];
  const truncated = list.length > ORG_DECLARATION_ENTRY_CAP;
  const folded = foldDeclarations(list.slice(0, ORG_DECLARATION_ENTRY_CAP));
  return { bySite: folded.bySite, ignored: folded.ignored, truncated };
}
