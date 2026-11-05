import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { edrConnections, edrTenants, organizations } from '../../db/schema';
import { INSTALLER_SEALED_SELECT } from './installerMaterial';
import type { EdrInstallerProviderKey } from './providerKeys';

/**
 * "Which vendor tenant does this org install into" has exactly one answer, here,
 * shared by dispatch and the security-agents readiness preflight. An ambiguous
 * org gets no answer: never `limit(1)` a tenant, or a device lands in the wrong
 * customer's console.
 */
export type InstallerTenantSelection =
  | { kind: 'ok'; tenantId: string; connectionId: string; sealedMaterial: string; expiresAt: Date | null }
  | { kind: 'not_mapped' }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'inactive' }
  | { kind: 'material_missing' }
  | { kind: 'material_expired' };

/** A link this close to expiry could lapse while the command waits for the agent. */
const MATERIAL_EXPIRY_MARGIN_MS = 60 * 60 * 1000;

interface CandidateRow {
  orgId: string | null;
  tenantId: string;
  connectionId: string;
  tenantPartnerId: string;
  orgPartnerId: string | null;
  connectionActive: boolean;
  connectionStatus: string;
  sealedMaterial: string | null;
  installerExpiresAt: Date | null;
}

function selectFromCandidates(candidates: readonly CandidateRow[], now: Date): InstallerTenantSelection {
  if (candidates.length === 0) return { kind: 'not_mapped' };
  if (candidates.length > 1) return { kind: 'ambiguous', count: candidates.length };
  const tenant = candidates[0]!;
  if (!tenant.connectionActive || tenant.connectionStatus === 'reauth_required') return { kind: 'inactive' };
  if (!tenant.sealedMaterial) return { kind: 'material_missing' };
  if (tenant.installerExpiresAt && tenant.installerExpiresAt.getTime() - now.getTime() <= MATERIAL_EXPIRY_MARGIN_MS) {
    return { kind: 'material_expired' };
  }
  return {
    kind: 'ok',
    tenantId: tenant.tenantId,
    connectionId: tenant.connectionId,
    sealedMaterial: tenant.sealedMaterial,
    expiresAt: tenant.installerExpiresAt,
  };
}

/**
 * One query for any number of orgs; every requested org gets an answer. Its own
 * system context: `edr_tenants` and `edr_connections` are partner-axis, unreadable
 * under an org-scoped request. Keyed off the orgId the trusted caller passed.
 */
export async function loadInstallerTenantSelections(
  provider: EdrInstallerProviderKey,
  orgIds: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, InstallerTenantSelection>> {
  const selections = new Map<string, InstallerTenantSelection>();
  if (orgIds.length === 0) return selections;

  const rows = await runOutsideDbContext(() =>
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
          ...INSTALLER_SEALED_SELECT,
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
  ) as CandidateRow[];

  for (const orgId of orgIds) {
    // The composite FK already refuses a cross-partner row; this holds even if it did not.
    const candidates = rows.filter((row) => row.orgId === orgId && row.orgPartnerId === row.tenantPartnerId);
    selections.set(orgId, selectFromCandidates(candidates, now));
  }
  return selections;
}

export async function selectInstallerTenant(
  provider: EdrInstallerProviderKey,
  orgId: string,
  now: Date = new Date(),
): Promise<InstallerTenantSelection> {
  const selections = await loadInstallerTenantSelections(provider, [orgId], now);
  return selections.get(orgId) ?? { kind: 'not_mapped' };
}
