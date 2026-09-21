import { Hono } from 'hono';
import { topologySiteSettingsPatchSchema } from '@breeze/shared';
import { requireTopologySiteCapability } from './middleware';
import { topologyOperation } from './operations';
import { readTopologySiteSettings } from '../../services/topology/siteSettings';
import { updateTopologySiteConfiguration } from '../../services/topology/siteConfiguration';
export const topologySettingsRoutes = new Hono();
topologySettingsRoutes.get(
  '/sites/:siteId/settings',
  requireTopologySiteCapability('read'),
  topologyOperation((c) => readTopologySiteSettings(c.get('topologyContext'))),
);
topologySettingsRoutes.patch(
  '/sites/:siteId/settings',
  requireTopologySiteCapability('write'),
  topologyOperation(
    async (c, body) => {
      const input = topologySiteSettingsPatchSchema.parse(body);
      const ctx = c.get('topologyContext');
      await updateTopologySiteConfiguration(
        ctx,
        input.overrides,
        input.expectedRevision,
      );
      return readTopologySiteSettings(ctx);
    },
    { mutation: true },
  ),
);
