import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { db } from '../../db';
import { topologySiteState } from '../../db/schema';
import {
  getTopologyCapabilities,
  loadTopologyFlags,
  type TopologyAgentCapabilities,
} from '../../services/topology/flags';
import { requireTopologySiteCapability } from './middleware';
import { readLegacyImportCheckpoint } from '../../services/topology/legacyImportState';

export const topologySettingsRoutes = new Hono();

const M0_AGENT_CAPABILITIES: TopologyAgentCapabilities = {
  collection: false,
  physical: false,
  interfaceHealth: false,
  diagnostics: false,
  ai: false,
};

topologySettingsRoutes.get(
  '/sites/:siteId/settings',
  requireTopologySiteCapability('read'),
  async (c) => {
    const ctx = c.get('topologyContext');

    const [flags, stateRows] = await Promise.all([
      loadTopologyFlags(ctx),
      db
        .select({
          effectiveSettings: topologySiteState.effectiveSettings,
          settingsRevision: topologySiteState.settingsRevision,
        })
        .from(topologySiteState)
        .where(and(
          eq(topologySiteState.orgId, ctx.scope.orgId),
          eq(topologySiteState.siteId, ctx.scope.siteId),
        ))
        .limit(1),
    ]);

    const state = stateRows[0];
    // Structural revisions also advance on lifecycle changes, while an empty
    // completed import need not advance one. Match the mutation readiness gate.
    const siteGraphReady = readLegacyImportCheckpoint(state?.effectiveSettings ?? {})?.status === 'complete';

    return c.json({
      siteId: ctx.scope.siteId,
      flags,
      capabilities: getTopologyCapabilities(
        flags,
        siteGraphReady,
        M0_AGENT_CAPABILITIES,
      ),
      settingsRevision: (state?.settingsRevision ?? 0n).toString(),
    });
  },
);
