import { eq, and } from 'drizzle-orm';
import {
  type TopologySiteSettings,
  topologySiteSettingsSchema,
} from '@breeze/shared';
import { db } from '../../db';
import { topologySiteState } from '../../db/schema';
import { hasPermission } from '../permissions';
import { hasSatisfiedMfa } from '../../middleware/auth';
import { type TopologyRequestContext, topologyPermissionPairs } from './access';
import { loadTopologyConfiguration } from './siteConfiguration';
import { getTopologyCapabilities, loadTopologyFlags } from './flags';
import { readLegacyImportCheckpoint } from './legacyImportState';
export async function readTopologySiteSettings(
  ctx: TopologyRequestContext,
): Promise<TopologySiteSettings> {
  const snapshot = await loadTopologyConfiguration(ctx);
  const flags = await loadTopologyFlags(ctx);
  const [state] = await db
    .select({ effectiveSettings: topologySiteState.effectiveSettings })
    .from(topologySiteState)
    .where(
      and(
        eq(topologySiteState.orgId, ctx.scope.orgId),
        eq(topologySiteState.siteId, ctx.scope.siteId),
      ),
    )
    .limit(1);
  const ready =
    readLegacyImportCheckpoint(state?.effectiveSettings ?? {})?.status ===
    'complete';
  const can = (capability: 'write' | 'execute' | 'configure') =>
    topologyPermissionPairs(capability).every(([resource, action]) =>
      hasPermission(ctx.permissions, resource, action),
    );
  return topologySiteSettingsSchema.parse({
    siteId: ctx.scope.siteId,
    settingsRevision: snapshot.settingsRevision,
    flags,
    capabilities: {
      ...getTopologyCapabilities(flags, ready, {
        collection: false,
        physical: false,
        interfaceHealth: false,
        diagnostics: false,
        ai: false,
      }),
      recurringMonitoring: {
        available: false,
        reason: 'recurring_monitoring_unavailable',
      },
    },
    permissions: {
      canEdit: can('write'),
      canDiagnose: can('execute') && hasSatisfiedMfa(ctx.auth),
      canConfigureMonitoring:
        can('configure') && can('execute') && hasSatisfiedMfa(ctx.auth),
    },
    resolved: snapshot.resolved,
    binding: {
      partnerVersionId: snapshot.binding?.partnerVersionId ?? null,
      orgVersionId: snapshot.binding?.orgVersionId ?? null,
      bindingRevision: (snapshot.binding?.revision ?? 0n).toString(),
      defaultsVersion: snapshot.layers.defaultsVersion,
      schemaVersion: 1,
      resolverVersion: snapshot.layers.resolverVersion,
      overrides: snapshot.layers.site ?? { targets: {}, policies: {} },
    },
  });
}
