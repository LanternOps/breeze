import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  devices,
  edrConnections,
  edrEndpoints,
  edrTenants,
  huntressAgents,
  huntressIntegrations,
  organizations,
  s1Agents,
  s1Integrations,
} from '../../db/schema';
import { HUNTRESS_OFFLINE_STATUSES } from '../huntressConstants';
import type { VendorEndpointSource, VendorEndpointView } from './coverageReconciler';
import { listVendors, type VendorKey } from './securityAgentVendors';

/**
 * Vendor endpoint sources for coverage reconciliation (#6960 W03).
 *
 * Huntress (`huntress_agents`, W03), SentinelOne (`s1_agents`, W04) and EDR
 * framework vendors (`edr_endpoints`, #8170). A vendor without a source is never
 * reconciled (the DNS vendors cannot be enabled yet, so they only ever hold
 * `not_applicable` rows).
 *
 * Every query here runs in the CALLER's system context: vendor rows are read
 * across the partner's orgs to find cross-org (mismatched) agents, which an
 * org-scoped session could not see. Read-only.
 */

function isOffline(status: string | null): boolean | null {
  if (!status) return null;
  const lowered = status.toLowerCase();
  return (HUNTRESS_OFFLINE_STATUSES as readonly string[]).some((s) => lowered.includes(s));
}

/**
 * A vendor view older than this is not trusted: the rows may describe agents
 * that have since moved or gone. Vendor syncs run far more often than this.
 */
export const VENDOR_VIEW_STALE_MS = 24 * 60 * 60 * 1000;
export const HUNTRESS_VIEW_STALE_MS = VENDOR_VIEW_STALE_MS;

/**
 * No active integration, or one whose data has never been / is no longer
 * fresh: the view is unavailable (null), not empty.
 */
function viewIsUnavailable(integrations: ReadonlyArray<{ lastSyncAt: Date | null }>): boolean {
  const cutoff = Date.now() - VENDOR_VIEW_STALE_MS;
  return integrations.length === 0 || integrations.some((i) => !i.lastSyncAt || i.lastSyncAt.getTime() < cutoff);
}

/** Device ids and normalised names of one org, for the cross-org candidate filters. */
function orgDeviceFilters(orgId: string) {
  return {
    ids: sql`(SELECT d.id FROM devices d WHERE d.org_id = ${orgId}::uuid)`,
    names: sql`(
      SELECT lower(trim(d.hostname)) FROM devices d WHERE d.org_id = ${orgId}::uuid
      UNION
      SELECT lower(trim(d.display_name)) FROM devices d WHERE d.org_id = ${orgId}::uuid AND d.display_name IS NOT NULL
    )`,
  };
}

export const huntressEndpointSource: VendorEndpointSource = {
  vendor: 'huntress',
  // huntress_agents.org_id is the Breeze org its Huntress organization is
  // mapped to (huntress_org_mappings), so another org there is a real mismatch.
  reportsVendorOrg: true,
  async listForOrg(orgId: string): Promise<VendorEndpointView[] | null> {
    const [org] = await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org?.partnerId) return null;

    const integrations = await db
      .select({ id: huntressIntegrations.id, lastSyncAt: huntressIntegrations.lastSyncAt })
      .from(huntressIntegrations)
      .where(and(eq(huntressIntegrations.partnerId, org.partnerId), eq(huntressIntegrations.isActive, true)));
    if (viewIsUnavailable(integrations)) return null;

    const { ids: orgDeviceIds, names: orgDeviceNames } = orgDeviceFilters(orgId);
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

/**
 * SentinelOne (`s1_agents`, filled by `s1Sync`).
 *
 * `reportsVendorOrg: true`: a row's `org_id` is the Breeze org its S1 SITE is
 * mapped to (`s1_org_mappings.org_id`), a vendor-side org exactly like a
 * Huntress organization, so an agent reported under another Breeze org is a
 * real mismatch. The limit, same as Huntress: sync links `device_id` only
 * among the mapped org's devices and drops agents of unmapped sites, so a
 * cross-org mismatch is detectable for a foreign-org row linked to a device
 * that has since moved, or an UNLINKED foreign-org row carrying the device's
 * hostname; an agent under an unmapped site has no row at all and its device
 * stays `pending` (installed, awaiting the vendor report).
 *
 * `s1_agents` has no hostname column: the name is `metadata->>'computerName'`
 * (as synced), normalised the same way as Huntress hostnames. `status` is
 * `online` / `offline` as set by sync; anything else is "no usable status".
 * Freshness is `s1_integrations.last_sync_at`, same staleness rule as Huntress.
 */
export const sentinelOneEndpointSource: VendorEndpointSource = {
  vendor: 'sentinelone',
  reportsVendorOrg: true,
  async listForOrg(orgId: string): Promise<VendorEndpointView[] | null> {
    const [org] = await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org?.partnerId) return null;

    const integrations = await db
      .select({ id: s1Integrations.id, lastSyncAt: s1Integrations.lastSyncAt })
      .from(s1Integrations)
      .where(and(eq(s1Integrations.partnerId, org.partnerId), eq(s1Integrations.isActive, true)));
    if (viewIsUnavailable(integrations)) return null;

    const { ids: orgDeviceIds, names: orgDeviceNames } = orgDeviceFilters(orgId);
    const computerName = sql<string | null>`(${s1Agents.metadata} ->> 'computerName')`;
    const rows = await db
      .select({
        id: s1Agents.id,
        orgId: s1Agents.orgId,
        deviceId: s1Agents.deviceId,
        hostname: computerName,
        status: s1Agents.status,
      })
      .from(s1Agents)
      .where(and(
        inArray(s1Agents.integrationId, integrations.map((i) => i.id)),
        or(
          eq(s1Agents.orgId, orgId),
          sql`${s1Agents.deviceId} IN ${orgDeviceIds}`,
          and(isNull(s1Agents.deviceId), sql`lower(trim(${computerName})) IN ${orgDeviceNames}`),
        ),
      ));

    // Sync marks agents the console stopped returning 'absent' (#9248): decommissioned,
    // so they must not read as covered.
    return rows.filter((row) => row.status !== 'absent').map((row) => ({
      endpointId: row.id,
      orgId: row.orgId,
      deviceId: row.deviceId,
      hostname: row.hostname,
      online: s1Online(row.status),
    }));
  },
};

function s1Online(status: string | null): boolean | null {
  const lowered = status?.trim().toLowerCase();
  if (lowered === 'online') return true;
  if (lowered === 'offline') return false;
  return null;
}

/**
 * An EDR framework vendor (`edr_endpoints`, filled by the framework's inventory
 * sync).
 *
 * `reportsVendorOrg: false`: a row's `org_id` is its tenant's mapping and the
 * sync links `breeze_device_id` only inside that org, so `mismatched_org` is
 * never claimed (security-agents spec 2.9).
 *
 * Tombstoned tenants are ignored, as the installer selection ignores them: they
 * no longer sync, so counting one would hold the view unavailable forever, and
 * its old endpoints must not read as covered. Any other mapped tenant that is
 * stale, or whose connection is inactive or needs reauth, makes the whole view
 * unavailable, because a gap could not be told from a sync that stopped.
 */
function edrFrameworkEndpointSource(vendor: VendorKey): VendorEndpointSource {
  return {
    vendor,
    reportsVendorOrg: false,
    async listForOrg(orgId: string): Promise<VendorEndpointView[] | null> {
      const [org] = await db
        .select({ partnerId: organizations.partnerId })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      if (!org?.partnerId) return null;

      const tenants = await db
        .select({
          id: edrTenants.id,
          lastInventorySyncAt: edrTenants.lastInventorySyncAt,
          connectionActive: edrConnections.isActive,
          connectionStatus: edrConnections.status,
        })
        .from(edrTenants)
        .innerJoin(edrConnections, eq(edrTenants.connectionId, edrConnections.id))
        .where(and(
          eq(edrTenants.orgId, orgId),
          eq(edrTenants.partnerId, org.partnerId),
          eq(edrConnections.provider, vendor),
          isNull(edrTenants.vendorMissingSince),
        ));
      if (viewIsUnavailable(tenants.map((tenant) => ({ lastSyncAt: tenant.lastInventorySyncAt })))) return null;
      if (tenants.some((tenant) => !tenant.connectionActive || tenant.connectionStatus === 'reauth_required')) return null;

      const rows = await db
        .select({
          id: edrEndpoints.id,
          orgId: edrEndpoints.orgId,
          deviceId: edrEndpoints.breezeDeviceId,
          hostname: edrEndpoints.hostname,
          online: edrEndpoints.online,
        })
        .from(edrEndpoints)
        .where(and(
          inArray(edrEndpoints.tenantId, tenants.map((tenant) => tenant.id)),
          eq(edrEndpoints.orgId, orgId),
          eq(edrEndpoints.partnerId, org.partnerId),
        ));

      return rows.map((row) => ({
        endpointId: row.id,
        orgId: row.orgId,
        deviceId: row.deviceId,
        hostname: row.hostname,
        online: row.online,
      }));
    },
  };
}

const SOURCES: Partial<Record<VendorKey, VendorEndpointSource>> = {
  huntress: huntressEndpointSource,
  sentinelone: sentinelOneEndpointSource,
};
for (const vendor of listVendors()) {
  if (vendor.orgSource === 'edr_framework') SOURCES[vendor.key] = edrFrameworkEndpointSource(vendor.key);
}

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
