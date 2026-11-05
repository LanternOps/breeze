/**
 * `get_snmp_metrics` (full-control W09, #6779): the AI twin of
 * GET /monitoring/assets/:id/metrics (bucketed history) and GET /snmp/dashboard.
 *
 * Tier 1, read-only. The history query is the route's own (services/
 * snmpMetricHistory.ts, every cap in metricBucketing.ts intact); the asset is
 * resolved in the caller's org and site ceiling and an out-of-ceiling asset is
 * the same "not found" as a missing one (#5777). The dashboard aggregates an
 * org, so an exact-device caller is refused and a site-restricted caller sees
 * only their sites (the route's own narrowing).
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { discoveredAssets } from '../db/schema';
import type { AiTool } from './aiTools';
import { resolveOrgIdForAsset, type AssetAuthContext } from './assetAccessScope';
import { deviceSiteDenied, siteAllowlistOf } from './aiToolsSiteScope';
import { loadAssetMetricHistory } from './snmpMetricHistory';
import { loadSnmpDashboard } from './snmpDashboard';
import { resolveOrgId, templateVisibilityCondition } from './snmpTemplates';
import { SNMP_BUCKETS, SNMP_METRICS_ACTIONS } from './aiToolSchemasNetworkMonitoring';
import { bounded, jsonError, requireFields, thrown } from './aiToolsNetworkMonitoringShared';

type Action = (typeof SNMP_METRICS_ACTIONS)[number];

const ASSET_NOT_FOUND = 'Asset not found or access denied';

export function registerSnmpMetricsTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('get_snmp_metrics', {
    tier: 1,
    domain: 'network',
    searchHint: 'SNMP interface traffic, bandwidth, uptime or OID history for a switch, router, printer or UPS; SNMP dashboard',
    deviceArgs: [],
    definition: {
      name: 'get_snmp_metrics',
      description:
        'SNMP metric history and the SNMP dashboard. Actions: history (assetId,oid,from,to,bucket,delta),dashboard. history returns bucketed series for a discovered asset; dashboard returns counts, top interfaces and recent polls.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...SNMP_METRICS_ACTIONS], description: 'The action to perform' },
          orgId: { type: 'string', description: 'Organization UUID (partner callers with several orgs)' },
          assetId: { type: 'string', description: 'history: discovered asset UUID' },
          oid: { type: 'string', description: 'history: OID or comma-separated OIDs (max 10)' },
          from: { type: 'string', description: 'history: ISO start (default 24h before to)' },
          to: { type: 'string', description: 'history: ISO end (default now)' },
          bucket: { type: 'string', enum: [...SNMP_BUCKETS], description: 'history: bucket width (default auto)' },
          delta: { type: 'boolean', description: 'history: return per-bucket counter deltas instead of raw values' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },

    handler: async (input, auth) => {
      const action = input.action as Action;
      if (!SNMP_METRICS_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);

      try {
        if (action === 'history') {
          const missing = requireFields(input, ['assetId', 'oid'], action);
          if (missing) return missing;
          // An empty allowlist, or a restricted caller that cannot prove access, sees nothing.
          const sites = siteAllowlistOf(auth);
          if (sites?.length === 0 || auth.allowedDeviceIds?.length === 0) return jsonError(ASSET_NOT_FOUND, 'NOT_FOUND');

          const assetId = String(input.assetId);
          const requestedOrg = typeof input.orgId === 'string' ? input.orgId : undefined;
          const orgResult = await resolveOrgIdForAsset(auth as AssetAuthContext, assetId, requestedOrg);
          if ('error' in orgResult || !orgResult.orgId) return jsonError(ASSET_NOT_FOUND, 'NOT_FOUND');

          const [asset] = await db
            .select({
              id: discoveredAssets.id, orgId: discoveredAssets.orgId,
              siteId: discoveredAssets.siteId, linkedDeviceId: discoveredAssets.linkedDeviceId,
            })
            .from(discoveredAssets)
            .where(and(eq(discoveredAssets.id, assetId), eq(discoveredAssets.orgId, orgResult.orgId)))
            .limit(1);
          // Opaque: an out-of-ceiling asset is indistinguishable from a missing one (#5777).
          if (!asset || deviceSiteDenied(auth, asset.siteId, asset.linkedDeviceId)) return jsonError(ASSET_NOT_FOUND, 'NOT_FOUND');

          const history = await loadAssetMetricHistory({ id: asset.id, orgId: asset.orgId }, {
            oid: String(input.oid),
            from: typeof input.from === 'string' ? input.from : undefined,
            to: typeof input.to === 'string' ? input.to : undefined,
            bucket: SNMP_BUCKETS.includes(input.bucket as (typeof SNMP_BUCKETS)[number])
              ? (input.bucket as (typeof SNMP_BUCKETS)[number]) : undefined,
            delta: input.delta === true ? '1' : '0',
          });
          if (!history.ok) return jsonError(history.error, history.status === 404 ? 'NOT_FOUND' : 'VALIDATION_ERROR');
          return bounded(history.body);
        }

        // dashboard: org-wide aggregate. An exact-device caller has no org-wide view (fail closed).
        if (auth.allowedDeviceIds !== undefined) {
          return jsonError('The SNMP dashboard aggregates the whole organization; a device-restricted session cannot read it', 'ACCESS_DENIED');
        }
        if (siteAllowlistOf(auth)?.length === 0) {
          return jsonError('No sites are within your access, so there is nothing to summarize', 'ACCESS_DENIED');
        }
        const orgResult = resolveOrgId(auth, typeof input.orgId === 'string' ? input.orgId : undefined);
        if ('error' in orgResult) return jsonError(orgResult.error ?? 'Access denied', 'ACCESS_DENIED');
        const visibility = templateVisibilityCondition(auth, orgResult.orgId ?? undefined);
        if (visibility.error) return jsonError(visibility.error, 'ACCESS_DENIED');
        const sites = siteAllowlistOf(auth);
        return bounded(await loadSnmpDashboard({
          orgId: orgResult.orgId,
          templateCondition: visibility.condition,
          allowedSiteIds: sites === undefined ? undefined : [...sites],
        }));
      } catch (error) {
        return thrown('get_snmp_metrics', error);
      }
    },
  });
}
