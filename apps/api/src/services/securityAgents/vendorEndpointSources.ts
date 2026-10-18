import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import { devices, huntressAgents, huntressIntegrations, organizations } from '../../db/schema';
import { HUNTRESS_OFFLINE_STATUSES } from '../huntressConstants';
import type { VendorEndpointSource, VendorEndpointView } from './coverageReconciler';
import type { VendorKey } from './securityAgentVendors';

/**
 * Vendor endpoint sources for coverage reconciliation (#6960 W03).
 *
 * Huntress only in W03. SentinelOne (`s1_agents`) arrives with W04 and EDR
 * framework providers (`edr_endpoints`) later; until then those vendors have
 * no source and their devices are never reconciled (they cannot be enabled
 * yet, so they only ever hold `not_applicable` rows).
 *
 * Every query here runs in the CALLER's system context: `huntress_*` rows are
 * read across the partner's orgs to find cross-org (mismatched) agents, which
 * an org-scoped session could not see.
 */

function isOffline(status: string | null): boolean | null {
  if (!status) return null;
  const lowered = status.toLowerCase();
  return (HUNTRESS_OFFLINE_STATUSES as readonly string[]).some((s) => lowered.includes(s));
}

export const huntressEndpointSource: VendorEndpointSource = {
  vendor: 'huntress',
  // huntress_agents.org_id is the Breeze org its Huntress organization is
  // mapped to (huntress_org_mappings), so another org there is a real mismatch.
  reportsVendorOrg: true,
  async listForOrg(orgId: string): Promise<VendorEndpointView[]> {
    const [org] = await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org?.partnerId) return [];

    const integrations = await db
      .select({ id: huntressIntegrations.id })
      .from(huntressIntegrations)
      .where(and(eq(huntressIntegrations.partnerId, org.partnerId), eq(huntressIntegrations.isActive, true)));
    if (integrations.length === 0) return [];

    const orgDeviceIds = sql`(SELECT d.id FROM devices d WHERE d.org_id = ${orgId}::uuid)`;
    const orgDeviceNames = sql`(
      SELECT lower(trim(d.hostname)) FROM devices d WHERE d.org_id = ${orgId}::uuid
      UNION
      SELECT lower(trim(d.display_name)) FROM devices d WHERE d.org_id = ${orgId}::uuid AND d.display_name IS NOT NULL
    )`;
    const rows = await db
      .select({
        id: huntressAgents.id,
        orgId: huntressAgents.orgId,
        deviceId: huntressAgents.deviceId,
        hostname: huntressAgents.hostname,
        status: huntressAgents.status,
      })
      .from(huntressAgents)
      .where(and(
        inArray(huntressAgents.integrationId, integrations.map((i) => i.id)),
        or(
          eq(huntressAgents.orgId, orgId),
          sql`${huntressAgents.deviceId} IN ${orgDeviceIds}`,
          and(isNull(huntressAgents.deviceId), sql`lower(trim(${huntressAgents.hostname})) IN ${orgDeviceNames}`),
        ),
      ));

    return rows.map((row) => {
      const offline = isOffline(row.status);
      return {
        endpointId: row.id,
        orgId: row.orgId,
        deviceId: row.deviceId,
        hostname: row.hostname,
        online: offline === null ? null : !offline,
      };
    });
  },
};

const SOURCES: Partial<Record<VendorKey, VendorEndpointSource>> = {
  huntress: huntressEndpointSource,
};

/** The vendor's endpoint source, or null when the vendor has none yet. */
export function getVendorEndpointSource(vendor: VendorKey): VendorEndpointSource | null {
  return SOURCES[vendor] ?? null;
}

/**
 * Normalised hostnames, among `candidates`, that name ANY device of the
 * partner (in any org, in scope or not). Keeps an unlinked agent that belongs
 * to some Breeze device from being reported as `vendor_only`.
 */
export async function loadPartnerDeviceHostnames(orgId: string, candidates: readonly string[]): Promise<Set<string>> {
  const unique = Array.from(new Set(candidates));
  if (unique.length === 0) return new Set();
  const rows = await db
    .select({
      hostname: sql<string | null>`lower(trim(${devices.hostname}))`,
      displayName: sql<string | null>`lower(trim(${devices.displayName}))`,
    })
    .from(devices)
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .where(and(
      sql`${organizations.partnerId} = (SELECT o.partner_id FROM organizations o WHERE o.id = ${orgId}::uuid)`,
      or(
        inArray(sql`lower(trim(${devices.hostname}))`, unique),
        inArray(sql`lower(trim(${devices.displayName}))`, unique),
      ),
    ));
  const wanted = new Set(unique);
  const found = new Set<string>();
  for (const row of rows) {
    if (row.hostname && wanted.has(row.hostname)) found.add(row.hostname);
    if (row.displayName && wanted.has(row.displayName)) found.add(row.displayName);
  }
  return found;
}
