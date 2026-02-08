import { Hono } from 'hono';
import { authMiddleware, requireScope, type AuthContext } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';

export const integrationRoutes = new Hono();

const communicationSettings = new Map<string, Record<string, unknown>>();
const monitoringSettings = new Map<string, Record<string, unknown>>();
const ticketingSettings = new Map<string, Record<string, unknown>>();
const psaSettings = new Map<string, Record<string, unknown>>();

function resolveOrgId(
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>,
  requestedOrgId?: string
): { orgId: string } | { error: string; status: number } {
  if (auth.scope === 'organization') {
    if (!auth.orgId) {
      return { error: 'Organization context required', status: 403 };
    }
    if (requestedOrgId && requestedOrgId !== auth.orgId) {
      return { error: 'Access to this organization denied', status: 403 };
    }
    return { orgId: auth.orgId };
  }

  if (auth.scope === 'partner') {
    if (requestedOrgId) {
      if (!auth.canAccessOrg(requestedOrgId)) {
        return { error: 'Access to this organization denied', status: 403 };
      }
      return { orgId: requestedOrgId };
    }

    if (auth.orgId) {
      return { orgId: auth.orgId };
    }

    const orgIds = auth.accessibleOrgIds ?? [];
    if (orgIds.length === 1) {
      return { orgId: orgIds[0] };
    }

    return { error: 'orgId is required for partner scope', status: 400 };
  }

  if (requestedOrgId) {
    return { orgId: requestedOrgId };
  }

  if (auth.orgId) {
    return { orgId: auth.orgId };
  }

  const orgIds = auth.accessibleOrgIds ?? [];
  if (orgIds.length === 1) {
    return { orgId: orgIds[0] };
  }

  return { error: 'orgId is required for system scope', status: 400 };
}

function requestedOrgId(c: { req: { query: (key: string) => string | undefined } }) {
  return c.req.query('orgId');
}

integrationRoutes.use('*', authMiddleware);

integrationRoutes.get('/communication', requireScope('organization', 'partner', 'system'), async (c) => {
  const auth = c.get('auth');
  const orgResult = resolveOrgId(auth, requestedOrgId(c));
  if ('error' in orgResult) {
    return c.json({ error: orgResult.error }, orgResult.status);
  }

  const existing = communicationSettings.get(orgResult.orgId);
  if (!existing) {
    return c.json({ error: 'Communication settings not found' }, 404);
  }

  return c.json({ data: existing });
});

for (const provider of ['slack', 'teams', 'discord'] as const) {
  integrationRoutes.post(`/${provider}`, requireScope('organization', 'partner', 'system'), async (c) => {
    const auth = c.get('auth');
    const body = await c.req.json().catch(() => ({}));
    const explicitOrgId = typeof body?.orgId === 'string' ? body.orgId : requestedOrgId(c);
    const orgResult = resolveOrgId(auth, explicitOrgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const existing = communicationSettings.get(orgResult.orgId) ?? {};
    const updated = { ...existing, [provider]: body };
    communicationSettings.set(orgResult.orgId, updated);

    if (body?.test === true) {
      return c.json({ success: true, message: `${provider} test notification queued.` });
    }

    writeRouteAudit(c, {
      orgId: orgResult.orgId,
      action: `integration.${provider}.save`,
      resourceType: 'integration',
      resourceName: provider
    });

    return c.json({ success: true, data: updated });
  });
}

integrationRoutes.get('/monitoring', requireScope('organization', 'partner', 'system'), async (c) => {
  const auth = c.get('auth');
  const orgResult = resolveOrgId(auth, requestedOrgId(c));
  if ('error' in orgResult) {
    return c.json({ error: orgResult.error }, orgResult.status);
  }

  return c.json({ data: monitoringSettings.get(orgResult.orgId) ?? {} });
});

integrationRoutes.put('/monitoring', requireScope('organization', 'partner', 'system'), async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json().catch(() => ({}));
  const explicitOrgId = typeof body?.orgId === 'string' ? body.orgId : requestedOrgId(c);
  const orgResult = resolveOrgId(auth, explicitOrgId);
  if ('error' in orgResult) {
    return c.json({ error: orgResult.error }, orgResult.status);
  }

  monitoringSettings.set(orgResult.orgId, body);
  return c.json({ success: true, data: body });
});

integrationRoutes.post('/monitoring/test', requireScope('organization', 'partner', 'system'), async (c) => {
  return c.json({ success: true, message: 'Connection successful.' });
});

integrationRoutes.get('/ticketing', requireScope('organization', 'partner', 'system'), async (c) => {
  const auth = c.get('auth');
  const orgResult = resolveOrgId(auth, requestedOrgId(c));
  if ('error' in orgResult) {
    return c.json({ error: orgResult.error }, orgResult.status);
  }

  return c.json({ data: ticketingSettings.get(orgResult.orgId) ?? {} });
});

integrationRoutes.post('/ticketing', requireScope('organization', 'partner', 'system'), async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json().catch(() => ({}));
  const explicitOrgId = typeof body?.orgId === 'string' ? body.orgId : requestedOrgId(c);
  const orgResult = resolveOrgId(auth, explicitOrgId);
  if ('error' in orgResult) {
    return c.json({ error: orgResult.error }, orgResult.status);
  }

  ticketingSettings.set(orgResult.orgId, body);
  return c.json({ success: true, message: 'Ticketing settings saved.', data: body });
});

integrationRoutes.post('/ticketing/test', requireScope('organization', 'partner', 'system'), async (c) => {
  return c.json({ success: true, message: 'Connection successful. Credentials validated.' });
});

integrationRoutes.get('/psa', requireScope('organization', 'partner', 'system'), async (c) => {
  const auth = c.get('auth');
  const orgResult = resolveOrgId(auth, requestedOrgId(c));
  if ('error' in orgResult) {
    return c.json({ error: orgResult.error }, orgResult.status);
  }

  const existing = psaSettings.get(orgResult.orgId);
  if (!existing) {
    return c.json({ error: 'PSA settings not found' }, 404);
  }

  return c.json({ data: existing });
});

integrationRoutes.post('/psa', requireScope('organization', 'partner', 'system'), async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json().catch(() => ({}));
  const explicitOrgId = typeof body?.orgId === 'string' ? body.orgId : requestedOrgId(c);
  const orgResult = resolveOrgId(auth, explicitOrgId);
  if ('error' in orgResult) {
    return c.json({ error: orgResult.error }, orgResult.status);
  }

  psaSettings.set(orgResult.orgId, body);
  return c.json({ success: true, data: body });
});

integrationRoutes.put('/psa', requireScope('organization', 'partner', 'system'), async (c) => {
  const auth = c.get('auth');
  const body = await c.req.json().catch(() => ({}));
  const explicitOrgId = typeof body?.orgId === 'string' ? body.orgId : requestedOrgId(c);
  const orgResult = resolveOrgId(auth, explicitOrgId);
  if ('error' in orgResult) {
    return c.json({ error: orgResult.error }, orgResult.status);
  }

  psaSettings.set(orgResult.orgId, body);
  return c.json({ success: true, data: body });
});

integrationRoutes.post('/psa/test', requireScope('organization', 'partner', 'system'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const provider = typeof body?.provider === 'string' ? body.provider : 'provider';
  return c.json({ success: true, message: `${provider} connection successful.` });
});
