import { Hono } from 'hono';
import { requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { listEdrProviders } from '../../services/edrProviders/registry';
import { isGateFailure, resolveEdrPartnerId } from './access';

export const edrProviderCatalogRoutes = new Hono();

// GET /edr/providers — the adapter catalog the "connect a provider" form renders from.
// Nothing here is secret: field names, labels and capability flags only.
edrProviderCatalogRoutes.get(
  '/providers',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  (c) => {
    const gate = resolveEdrPartnerId(c.get('auth'));
    if (isGateFailure(gate)) return c.json({ error: gate.error }, gate.status);
    return c.json({
      data: listEdrProviders().map((a) => ({
        key: a.key,
        label: a.label,
        credentialFields: a.credentialFields,
        baseUrlPolicy: a.baseUrlPolicy,
        capabilities: a.capabilities,
      })),
    });
  },
);
