import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { devices, softwareComplianceStatus, type SoftwarePolicyRulesDefinition } from '../db/schema';
import { resolveDeviceIdsForSoftwarePolicy } from './featureConfigResolver';

/**
 * W03's resolver is loaded lazily, on the first preview request only.
 * `softwarePolicyInstallRemediation` statically reaches the deployment-dispatch
 * graph (softwareDeployment -> routes/agentWs -> the discovery/command workers),
 * and this module is imported by an HTTP route file. Importing it statically
 * would drag that whole write-side graph into every consumer of
 * routes/softwarePolicies.ts for a read-only preview that most requests never
 * reach. The module cache makes the cost a one-time load, and the mocked-module
 * registry still intercepts it in tests.
 */
async function loadResolvePolicyInstallTarget() {
  const mod = await import('./softwarePolicyInstallRemediation');
  return mod.resolvePolicyInstallTarget;
}

/**
 * #5505 W06 — the dry-run device count behind the "this will install missing
 * software on ~N device(s)" warning (spec Risks §2, "Fleet-wide first run").
 *
 * COST BOUND (the reason this file exists rather than a per-device loop):
 * resolvePolicyInstallTarget (W03) does up to 3 DB round trips per call.
 * Reachability of a catalogId depends only on the DEVICE'S ORG (the
 * fail-closed cross-tenant guard); install-target existence depends only on
 * the DEVICE'S OS TYPE. Neither depends on any other device attribute. So
 * resolved devices are grouped by (orgId, osType) and resolvePolicyInstallTarget
 * is called at most once per (group x candidate catalogId) — bounded by
 * tenant/OS variety, never by device count — instead of once per device.
 * The actual per-group device tally is a real SQL COUNT(DISTINCT device_id),
 * never a capped SELECT ... LIMIT whose .length is reported as the total
 * (the bug at GET /violations, routes/softwarePolicies.ts, which silently
 * undercounts past its default limit of 100).
 */

const PREVIEW_QUERY_CHUNK_SIZE = 500;

function chunkArray<T>(items: T[], size = PREVIEW_QUERY_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

type DeviceGroup = { orgId: string; osType: string; deviceIds: string[] };

export async function computeInstallPreviewEligibleDeviceCount(input: {
  policyId: string;
  rules: SoftwarePolicyRulesDefinition;
  siteAllowedDeviceIds?: string[] | null;
}): Promise<number> {
  // A rule with no catalogId can be DETECTED as missing but never installed
  // (spec §4) — skip before resolving a single device.
  const candidateCatalogIds = Array.from(
    new Set(
      (input.rules.software ?? [])
        .map((rule) => rule.catalogId)
        .filter(
          (catalogId): catalogId is string =>
            typeof catalogId === 'string' && catalogId.length > 0,
        ),
    ),
  );
  if (candidateCatalogIds.length === 0) return 0;

  // Same resolver the compliance worker uses (softwareComplianceWorker.ts) —
  // this is what makes the preview's device set match what the worker would
  // actually act on.
  let deviceIds = await resolveDeviceIdsForSoftwarePolicy(input.policyId);
  if (input.siteAllowedDeviceIds) {
    const allowed = new Set(input.siteAllowedDeviceIds);
    deviceIds = deviceIds.filter((deviceId) => allowed.has(deviceId));
  }
  deviceIds = Array.from(new Set(deviceIds));
  if (deviceIds.length === 0) return 0;

  const groups = new Map<string, DeviceGroup>();
  for (const chunk of chunkArray(deviceIds)) {
    const rows = await db
      .select({ id: devices.id, orgId: devices.orgId, osType: devices.osType })
      .from(devices)
      .where(inArray(devices.id, chunk));
    for (const row of rows) {
      const osType = row.osType ?? '';
      const key = `${row.orgId}:${osType}`;
      let group = groups.get(key);
      if (!group) {
        group = { orgId: row.orgId, osType, deviceIds: [] };
        groups.set(key, group);
      }
      group.deviceIds.push(row.id);
    }
  }

  const resolvePolicyInstallTarget = await loadResolvePolicyInstallTarget();

  let total = 0;
  for (const group of groups.values()) {
    const eligibleCatalogIds: string[] = [];
    for (const catalogId of candidateCatalogIds) {
      const resolution = await resolvePolicyInstallTarget({
        catalogId,
        deviceOrgId: group.orgId,
        deviceOsType: group.osType,
      });
      if (resolution.ok) eligibleCatalogIds.push(catalogId);
    }
    if (eligibleCatalogIds.length === 0) continue;

    // Safe ARRAY[...]::text[] construction — embedding a bare JS array
    // directly into `= ANY(${arr})` makes drizzle expand it to a comma tuple
    // instead of a real Postgres array (extensions/tenancyTripwire.ts).
    const catalogIdsArray = sql`ARRAY[${sql.join(
      eligibleCatalogIds.map((catalogId) => sql`${catalogId}`),
      sql`, `,
    )}]::text[]`;

    for (const idsChunk of chunkArray(group.deviceIds)) {
      const [row] = await db
        .select({
          count: sql<number>`count(distinct ${softwareComplianceStatus.deviceId})::int`,
        })
        .from(softwareComplianceStatus)
        .where(
          and(
            eq(softwareComplianceStatus.policyId, input.policyId),
            inArray(softwareComplianceStatus.deviceId, idsChunk),
            sql`EXISTS (
              SELECT 1
              FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(${softwareComplianceStatus.violations}) = 'array'
                     THEN ${softwareComplianceStatus.violations}
                     ELSE '[]'::jsonb END
              ) AS elem
              WHERE elem->>'type' = 'missing'
                AND elem->'rule'->>'catalogId' = ANY(${catalogIdsArray})
            )`,
          ),
        );
      total += Number(row?.count ?? 0);
    }
  }

  return total;
}
