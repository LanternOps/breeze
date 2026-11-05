import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { edrConnections, edrTenants, organizations } from '../../db/schema';
import { installerSealedSelect, installerStateSelect } from './installerMaterial';
import type { EdrInstallerProviderKey } from './providerKeys';

/**
 * "Which vendor tenant does this org install into" has exactly one answer, here,
 * shared by dispatch and the security-agents readiness preflight. An ambiguous
 * org gets no answer: never `limit(1)` a tenant, or a device lands in the wrong
 * customer's console.
 */
type NotReady =
  | { kind: 'not_mapped' }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'inactive' }
  | { kind: 'material_missing' }
  | { kind: 'material_expired' };

/** For readiness: never carries the ciphertext. */
export type InstallerTenantReadiness =
  | { kind: 'ok'; tenantId: string; connectionId: string; expiresAt: Date | null }
  | NotReady;

/** For dispatch only (`selectInstallerTenant`): the one shape that carries the sealed material. */
export type InstallerTenantSelection =
  | { kind: 'ok'; tenantId: string; connectionId: string; sealedMaterial: string; expiresAt: Date | null }
  | NotReady;

/** A link this close to expiry could lapse while the command waits for the agent. */
const MATERIAL_EXPIRY_MARGIN_MS = 60 * 60 * 1000;
/**
 * A link no refresh has confirmed for a week is not dispatched, even when the
 * vendor never said it expires: the refreshes have been failing (a vendor
 * outage, say), so nothing vouches for it any more.
 */
const MATERIAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface CandidateRow {
  orgId: string | null;
  tenantId: string;
  connectionId: string;
  tenantPartnerId: string;
  orgPartnerId: string | null;
  connectionActive: boolean;
  connectionStatus: string;
  hasMaterial: boolean;
  /** Loaded only for dispatch. */
  sealedMaterial: string | null;
  installerFetchedAt: Date | null;
  installerExpiresAt: Date | null;
}

type Verdict = NotReady | { kind: 'ok'; tenant: CandidateRow };

function judge(candidates: readonly CandidateRow[], now: Date): Verdict {
  if (candidates.length === 0) return { kind: 'not_mapped' };
  if (candidates.length > 1) return { kind: 'ambiguous', count: candidates.length };
  const tenant = candidates[0]!;
  if (!tenant.connectionActive || tenant.connectionStatus === 'reauth_required') return { kind: 'inactive' };
  if (!tenant.hasMaterial) return { kind: 'material_missing' };
  if (!tenant.installerFetchedAt || now.getTime() - tenant.installerFetchedAt.getTime() > MATERIAL_MAX_AGE_MS) {
    return { kind: 'material_expired' };
  }
  if (tenant.installerExpiresAt && tenant.installerExpiresAt.getTime() - now.getTime() <= MATERIAL_EXPIRY_MARGIN_MS) {
    return { kind: 'material_expired' };
  }
  return { kind: 'ok', tenant };
}

/**
 * One query for any number of orgs. Its own system context: `edr_tenants` and
 * `edr_connections` are partner-axis, unreadable under an org-scoped request.
 * Keyed off the orgId the trusted caller passed. The ciphertext is selected only
 * when `withMaterial` is set.
 */
async function loadVerdicts(
  provider: EdrInstallerProviderKey,
  orgIds: readonly string[],
  withMaterial: boolean,
  now: Date,
): Promise<Map<string, Verdict>> {
  const { installerHasMaterial, installerFetchedAt, installerExpiresAt } = installerStateSelect();
  const rows = (await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({
          orgId: edrTenants.orgId,
          tenantId: edrTenants.id,
          connectionId: edrTenants.connectionId,
          tenantPartnerId: edrTenants.partnerId,
          orgPartnerId: organizations.partnerId,
          connectionActive: edrConnections.isActive,
          connectionStatus: edrConnections.status,
          installerHasMaterial,
          installerFetchedAt,
          installerExpiresAt,
          ...(withMaterial ? installerSealedSelect() : {}),
        })
        .from(edrTenants)
        .innerJoin(edrConnections, eq(edrTenants.connectionId, edrConnections.id))
        .innerJoin(organizations, eq(edrTenants.orgId, organizations.id))
        .where(and(
          inArray(edrTenants.orgId, [...new Set(orgIds)]),
          eq(edrConnections.provider, provider),
          isNull(edrTenants.vendorMissingSince),
        )),
    ),
  )) as Array<Omit<CandidateRow, 'hasMaterial' | 'sealedMaterial'> & { installerHasMaterial: boolean; sealedMaterial?: string | null }>;

  const candidates: CandidateRow[] = rows.map(({ installerHasMaterial: flag, sealedMaterial, ...row }) => ({
    ...row,
    hasMaterial: withMaterial ? !!sealedMaterial : !!flag,
    sealedMaterial: withMaterial ? (sealedMaterial ?? null) : null,
  }));

  const verdicts = new Map<string, Verdict>();
  for (const orgId of orgIds) {
    // The composite FK already refuses a cross-partner row; this holds even if it did not.
    const own = candidates.filter((row) => row.orgId === orgId && row.orgPartnerId === row.tenantPartnerId);
    verdicts.set(orgId, judge(own, now));
  }
  return verdicts;
}

/** Readiness for any number of orgs, in one query. Never reads the ciphertext. */
export async function loadInstallerTenantSelections(
  provider: EdrInstallerProviderKey,
  orgIds: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, InstallerTenantReadiness>> {
  const out = new Map<string, InstallerTenantReadiness>();
  if (orgIds.length === 0) return out;
  for (const [orgId, verdict] of await loadVerdicts(provider, orgIds, false, now)) {
    out.set(orgId, verdict.kind === 'ok'
      ? { kind: 'ok', tenantId: verdict.tenant.tenantId, connectionId: verdict.tenant.connectionId, expiresAt: verdict.tenant.installerExpiresAt }
      : verdict);
  }
  return out;
}

/** Dispatch: the same rules for one org, with the sealed material of the one tenant it may use. */
export async function selectInstallerTenant(
  provider: EdrInstallerProviderKey,
  orgId: string,
  now: Date = new Date(),
): Promise<InstallerTenantSelection> {
  const verdict = (await loadVerdicts(provider, [orgId], true, now)).get(orgId) ?? { kind: 'not_mapped' as const };
  if (verdict.kind !== 'ok') return verdict;
  const { tenant } = verdict;
  return {
    kind: 'ok',
    tenantId: tenant.tenantId,
    connectionId: tenant.connectionId,
    sealedMaterial: tenant.sealedMaterial!,
    expiresAt: tenant.installerExpiresAt,
  };
}
