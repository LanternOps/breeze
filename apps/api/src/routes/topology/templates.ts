import { Hono } from 'hono';
import { z } from 'zod';
import {
  createTopologyTemplate,
  createTopologyTemplateSchema,
  updateTopologyTemplate,
  updateTopologyTemplateSchema,
  listTopologyTemplates,
  listTopologyTemplateVersions,
  createTopologyTemplateVersion,
  createTopologyTemplateVersionSchema,
  publishTopologyTemplateVersion,
  publishTopologyTemplateVersionSchema,
  listEligibleTopologyVersions,
} from '../../services/topology/templateLibrary';
import { requireTopologySiteCapability } from './middleware';
import { siteScopedQuery, withoutAmbientOrgId } from './query';
import { topologyLibraryPermissions, topologyOperation } from './operations';
const page = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export const topologyTemplateRoutes = new Hono();
topologyTemplateRoutes.get(
  '/templates',
  topologyLibraryPermissions,
  topologyOperation((c) =>
    listTopologyTemplates(
      c.get('auth'),
      c.get('permissions'),
      page
        .extend({
          ownerScope: z.enum(['partner', 'organization']),
          orgId: z.uuid().optional(),
        })
        .strict()
        .parse(c.req.query()),
    ),
  ),
);
topologyTemplateRoutes.post(
  '/templates',
  topologyLibraryPermissions,
  topologyOperation(
    (c, body) =>
      createTopologyTemplate(
        c.get('auth'),
        c.get('permissions'),
        createTopologyTemplateSchema.parse(body),
      ),
    { mutation: true, status: 201 },
  ),
);
topologyTemplateRoutes.patch(
  '/templates/:templateId',
  topologyLibraryPermissions,
  topologyOperation(
    (c, body) =>
      updateTopologyTemplate(
        c.get('auth'),
        c.get('permissions'),
        c.req.param('templateId')!,
        updateTopologyTemplateSchema.parse(body),
      ),
    { mutation: true },
  ),
);
topologyTemplateRoutes.get(
  '/templates/:templateId/versions',
  topologyLibraryPermissions,
  topologyOperation((c) =>
    listTopologyTemplateVersions(
      c.get('auth'),
      c.get('permissions'),
      c.req.param('templateId')!,
      page.strict().parse(withoutAmbientOrgId(c.req.query())),
    ),
  ),
);
topologyTemplateRoutes.post(
  '/templates/:templateId/versions',
  topologyLibraryPermissions,
  topologyOperation(
    (c, body) =>
      createTopologyTemplateVersion(
        c.get('auth'),
        c.get('permissions'),
        c.req.param('templateId')!,
        createTopologyTemplateVersionSchema.parse(body),
      ),
    { mutation: true, status: 201 },
  ),
);
topologyTemplateRoutes.post(
  '/templates/:templateId/versions/:versionId/publish',
  topologyLibraryPermissions,
  topologyOperation(
    (c, body) =>
      publishTopologyTemplateVersion(
        c.get('auth'),
        c.get('permissions'),
        c.req.param('templateId')!,
        c.req.param('versionId')!,
        publishTopologyTemplateVersionSchema.parse(body),
      ),
    { mutation: true },
  ),
);
topologyTemplateRoutes.get(
  '/sites/:siteId/template-options',
  requireTopologySiteCapability('read'),
  topologyOperation((c) =>
    listEligibleTopologyVersions(
      c.get('topologyContext'),
      page.strict().parse(siteScopedQuery(c)),
    ),
  ),
);
