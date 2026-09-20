import { Hono } from 'hono';
import {
  topologyTemplateApplyRequestSchema,
  topologyTemplatePreviewRequestSchema,
} from '@breeze/shared';
import {
  previewTopologyTemplateApplication,
  applyTopologyTemplatePreview,
  getTopologyTemplateApplication,
} from '../../services/topology/templateApply';
import { topologyLibraryPermissions, topologyOperation } from './operations';
export const topologyTemplateApplicationRoutes = new Hono();
topologyTemplateApplicationRoutes.post(
  '/template-applications/preview',
  topologyLibraryPermissions,
  topologyOperation(
    (c, body) =>
      previewTopologyTemplateApplication(
        c.get('auth'),
        c.get('permissions'),
        topologyTemplatePreviewRequestSchema.parse(body),
      ),
    { mutation: true },
  ),
);
topologyTemplateApplicationRoutes.post(
  '/template-applications',
  topologyLibraryPermissions,
  topologyOperation(
    (c, body) =>
      applyTopologyTemplatePreview(
        c.get('auth'),
        c.get('permissions'),
        topologyTemplateApplyRequestSchema.parse(body).token,
        c.req.header('Idempotency-Key') ?? '',
      ),
    { mutation: true, status: 202 },
  ),
);
topologyTemplateApplicationRoutes.get(
  '/template-applications/:operationId',
  topologyLibraryPermissions,
  topologyOperation((c) =>
    getTopologyTemplateApplication(
      c.get('auth'),
      c.get('permissions'),
      c.req.param('operationId')!,
    ),
  ),
);
