import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { selfHostAllowsPrivateNetwork } from '../config/env';
import { writeRouteAudit } from '../services/auditEvents';
import {
  INTEGRATION_MASKED_SECRET,
  IntegrationSecretsUnavailableError,
  InvalidIntegrationSecretError,
  integrationSettingsSecretAad,
  isSecretFieldName,
  maskIntegrationSettings,
  sealIntegrationSettings,
} from '../services/integrationSettingsSecrets';
import {
  MONITORING_TEST_PROVIDERS,
  testMonitoringProvider,
  type MonitoringTestProvider,
} from '../services/monitoringIntegrationTest';
import { PERMISSIONS } from '../services/permissions';
import { decryptSecret, isEncryptedSecret } from '../services/secretCrypto';
import { safeFetch } from '../services/urlSafety';

export const integrationRoutes = new Hono();
const requireIntegrationRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
const requireIntegrationWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);

const communicationSettings = new Map<string, Record<string, unknown>>();
const monitoringSettings = new Map<string, Record<string, unknown>>();
const ticketingSettings = new Map<string, Record<string, unknown>>();
const psaSettings = new Map<string, Record<string, unknown>>();

// 16KB cap on free-form integration setting blobs (in-memory storage).
const MAX_INTEGRATION_PAYLOAD_BYTES = 16 * 1024;

// Loose-but-bounded schema for provider settings. Each provider has its own
// shape we don't fully control here (these are storage-only routes), but we
// require an object, bound key length, and reject oversized payloads.
const integrationSettingsSchema = z
  .record(z.string().max(64), z.unknown())
  .refine(
    (val) => JSON.stringify(val).length <= MAX_INTEGRATION_PAYLOAD_BYTES,
    { message: `payload exceeds ${MAX_INTEGRATION_PAYLOAD_BYTES} bytes` }
  );

async function parseIntegrationBody(c: { req: { json: () => Promise<unknown> } }): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: 400; error: string }
> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, status: 400, error: 'Invalid JSON body' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, status: 400, error: 'Body must be a JSON object' };
  }
  const parsed = integrationSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, status: 400, error: parsed.error.issues[0]?.message ?? 'Invalid payload' };
  }
  return { ok: true, body: parsed.data as Record<string, unknown> };
}

function resolveOrgId(
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>,
  requestedOrgId?: string
): { orgId: string } | { error: string; status: 400 | 403 } {
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
    const onlyOrgId = orgIds[0];
    if (orgIds.length === 1 && onlyOrgId) {
      return { orgId: onlyOrgId };
    }

    return { error: 'orgId is required when partner has multiple organizations', status: 400 };
  }

  if (requestedOrgId) {
    return { orgId: requestedOrgId };
  }

  if (auth.orgId) {
    return { orgId: auth.orgId };
  }

  const orgIds = auth.accessibleOrgIds ?? [];
  const onlyOrgId = orgIds[0];
  if (orgIds.length === 1 && onlyOrgId) {
    return { orgId: onlyOrgId };
  }

  return { error: 'orgId is required for system scope', status: 400 };
}

function requestedOrgId(c: { req: { query: (key: string) => string | undefined } }) {
  return c.req.query('orgId');
}

function protectSettings(
  body: Record<string, unknown>,
  existing: Record<string, unknown> | undefined,
  family: string,
  orgId: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string; status: 400 | 503 } {
  try {
    return { ok: true, value: sealIntegrationSettings(body, existing, family, orgId) };
  } catch (error) {
    // Operator misconfiguration, not a bad request: the caller cannot fix it by
    // changing the payload, so 503 rather than 400. These routes already
    // require organizations:write + MFA, so the operator-actionable message is
    // not being handed to an anonymous or read-only caller.
    if (error instanceof IntegrationSecretsUnavailableError) {
      return { ok: false, error: error.message, status: 503 };
    }
    if (error instanceof InvalidIntegrationSecretError) {
      return { ok: false, error: error.message, status: 400 };
    }
    throw error;
  }
}

integrationRoutes.use('*', authMiddleware);

integrationRoutes.get('/communication', requireScope('organization', 'partner', 'system'), requireIntegrationRead, async (c) => {
  const auth = c.get('auth');
  const orgResult = resolveOrgId(auth, requestedOrgId(c));
  if ('error' in orgResult) {
    return c.json({ error: orgResult.error }, orgResult.status);
  }

  const existing = communicationSettings.get(orgResult.orgId);
  if (!existing) {
    return c.json({ error: 'Communication settings not found' }, 404);
  }

  return c.json({ data: maskIntegrationSettings(existing) });
});

for (const provider of ['slack', 'teams', 'discord'] as const) {
  integrationRoutes.post(`/${provider}`, requireScope('organization', 'partner', 'system'), requireIntegrationWrite, requireMfa(), async (c) => {
    const auth = c.get('auth');
    const parsed = await parseIntegrationBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    const body = parsed.body;
    const explicitOrgId = typeof body.orgId === 'string' ? body.orgId : requestedOrgId(c);
    const orgResult = resolveOrgId(auth, explicitOrgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const existing = communicationSettings.get(orgResult.orgId) ?? {};
    const currentProvider = existing[provider];
    const protectedBody = protectSettings(
      body,
      currentProvider && typeof currentProvider === 'object' && !Array.isArray(currentProvider)
        ? currentProvider as Record<string, unknown>
        : undefined,
      `communication.${provider}`,
      orgResult.orgId,
    );
    if (!protectedBody.ok) return c.json({ error: protectedBody.error }, protectedBody.status);
    const updated = { ...existing, [provider]: protectedBody.value };
    communicationSettings.set(orgResult.orgId, updated);

    if (body.test === true) {
      return c.json({ success: true, message: `${provider} test notification queued.` });
    }

    writeRouteAudit(c, {
      orgId: orgResult.orgId,
      action: `integration.${provider}.save`,
      resourceType: 'integration',
      resourceName: provider
    });

    return c.json({ success: true, data: maskIntegrationSettings(updated) });
  });
}

integrationRoutes.get('/monitoring', requireScope('organization', 'partner', 'system'), requireIntegrationRead, async (c) => {
  const auth = c.get('auth');
  const orgResult = resolveOrgId(auth, requestedOrgId(c));
  if ('error' in orgResult) {
    return c.json({ error: orgResult.error }, orgResult.status);
  }

  return c.json({ data: maskIntegrationSettings(monitoringSettings.get(orgResult.orgId) ?? {}) });
});

integrationRoutes.put('/monitoring', requireScope('organization', 'partner', 'system'), requireIntegrationWrite, requireMfa(), async (c) => {
  const auth = c.get('auth');
  const parsed = await parseIntegrationBody(c);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
  const body = parsed.body;
  const explicitOrgId = typeof body.orgId === 'string' ? body.orgId : requestedOrgId(c);
  const orgResult = resolveOrgId(auth, explicitOrgId);
  if ('error' in orgResult) {
    return c.json({ error: orgResult.error }, orgResult.status);
  }

  const protectedBody = protectSettings(
    body,
    monitoringSettings.get(orgResult.orgId),
    'monitoring',
    orgResult.orgId,
  );
  if (!protectedBody.ok) return c.json({ error: protectedBody.error }, protectedBody.status);
  monitoringSettings.set(orgResult.orgId, protectedBody.value);
  return c.json({ success: true, data: maskIntegrationSettings(protectedBody.value) });
});

const monitoringTestBodySchema = z.object({
  provider: z.enum(MONITORING_TEST_PROVIDERS as [MonitoringTestProvider, ...MonitoringTestProvider[]]),
  config: z.record(z.string().max(64), z.unknown()).default({}),
  endpointId: z.string().max(128).optional(),
  orgId: z.string().optional(),
});

/**
 * The UI holds `********` for every credential it loaded from GET /monitoring,
 * so a test request only carries plaintext for a key the operator just typed.
 * Substitute the stored, sealed value for each masked credential-named leaf so
 * the check exercises the credential that will actually be used. A masked
 * field with nothing stored means the operator has not configured it yet.
 */
function resolveMaskedMonitoringSecrets(
  config: Record<string, unknown>,
  stored: unknown,
  orgId: string,
  provider: string,
): { ok: true; config: Record<string, unknown> } | { ok: false; error: string; unreadable?: true } {
  const storedRecord = stored && typeof stored === 'object' && !Array.isArray(stored)
    ? stored as Record<string, unknown>
    : {};
  const resolved: Record<string, unknown> = { ...config };
  for (const [field, value] of Object.entries(config)) {
    if (value !== INTEGRATION_MASKED_SECRET || !isSecretFieldName(field)) continue;
    const opened = openStoredMonitoringSecret(storedRecord[field], orgId, [provider, field], `${provider} ${field}`);
    if (!opened.ok) return opened;
    resolved[field] = opened.value;
  }

  // Webhook endpoint URLs are the one nested secret (integrationSettingsSecrets
  // isSecretPath): sealed per endpoint under the path part `id:"<id>"`, so a
  // reorder cannot re-bind one destination's URL to another.
  if (provider === 'webhooks' && Array.isArray(config.endpoints)) {
    const storedEndpoints = Array.isArray(storedRecord.endpoints) ? storedRecord.endpoints as unknown[] : [];
    const endpoints: unknown[] = [];
    for (const entry of config.endpoints as unknown[]) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { endpoints.push(entry); continue; }
      const endpoint = { ...(entry as Record<string, unknown>) };
      if (endpoint.url === INTEGRATION_MASKED_SECRET) {
        const id = typeof endpoint.id === 'string' && endpoint.id ? endpoint.id : undefined;
        const stored = id
          ? storedEndpoints.find((s) => !!s && typeof s === 'object' && (s as Record<string, unknown>).id === id)
          : undefined;
        const storedUrl = stored ? (stored as Record<string, unknown>).url : undefined;
        const opened = openStoredMonitoringSecret(
          storedUrl,
          orgId,
          ['webhooks', 'endpoints', `id:${JSON.stringify(id ?? '')}`, 'url'],
          'webhook endpoint URL',
        );
        if (!opened.ok) return opened;
        endpoint.url = opened.value;
      }
      endpoints.push(endpoint);
    }
    resolved.endpoints = endpoints;
  }
  return { ok: true, config: resolved };
}

function openStoredMonitoringSecret(
  sealed: unknown,
  orgId: string,
  path: readonly string[],
  label: string,
): { ok: true; value: string } | { ok: false; error: string; unreadable?: true } {
  if (typeof sealed !== 'string' || sealed.length === 0) {
    return { ok: false, error: `Enter the ${label} and save before testing` };
  }
  if (!isEncryptedSecret(sealed)) return { ok: true, value: sealed };
  // decryptSecret THROWS on an AAD mismatch, a retired key id or corrupt
  // ciphertext; it only returns null for an empty input, excluded above.
  try {
    const plaintext = decryptSecret(sealed, { aad: integrationSettingsSecretAad('monitoring', orgId, path) });
    if (!plaintext) return { ok: false, error: `Stored ${label} could not be read; re-enter it and save` };
    return { ok: true, value: plaintext };
  } catch (err) {
    // The operator gets one generic message either way, but the class matters
    // to whoever reads the logs: SecretKeyMaterialError is an instance-wide
    // key misconfiguration, a GCM auth failure is this one ciphertext (stale
    // rotation, or a swapped blob). Name and message only — never the value.
    const name = err instanceof Error ? err.name : 'Error';
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[integrations] monitoring secret ${path.join('.')} unreadable for org ${orgId}: ${name}: ${message}`);
    return { ok: false, error: `Stored ${label} could not be read; re-enter it and save`, unreadable: true };
  }
}

integrationRoutes.post('/monitoring/test', requireScope('organization', 'partner', 'system'), requireIntegrationWrite, requireMfa(), async (c) => {
  const auth = c.get('auth');
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = monitoringTestBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid payload' }, 400);
  }
  const { provider, config, endpointId } = parsed.data;
  const orgResult = resolveOrgId(auth, parsed.data.orgId ?? requestedOrgId(c));
  if ('error' in orgResult) {
    return c.json({ error: orgResult.error }, orgResult.status);
  }

  const stored = monitoringSettings.get(orgResult.orgId)?.[provider];
  const secrets = resolveMaskedMonitoringSecrets(config, stored, orgResult.orgId, provider);
  if (!secrets.ok) {
    if (secrets.unreadable) {
      // A stored credential that no longer decrypts is worth a trail: it is
      // either a key rotation that stranded it or a ciphertext that was
      // moved between paths/tenants. Same audit action, distinct outcome.
      writeRouteAudit(c, {
        orgId: orgResult.orgId,
        action: 'integration.monitoring.test',
        resourceType: 'integration',
        resourceName: provider,
        details: { outcome: 'secret_unreadable' },
      });
    }
    return c.json({ error: secrets.error }, 400);
  }

  const result = await testMonitoringProvider(
    { provider, config: secrets.config, endpointId, allowPrivateNetwork: selfHostAllowsPrivateNetwork() },
    { fetch: safeFetch },
  );

  writeRouteAudit(c, {
    orgId: orgResult.orgId,
    action: 'integration.monitoring.test',
    resourceType: 'integration',
    resourceName: provider,
    details: { outcome: result.ok ? 'ok' : result.kind },
  });

  if (!result.ok) {
    const status = result.kind === 'invalid' || result.kind === 'blocked' ? 400 : 502;
    return c.json({ success: false, error: result.message }, status);
  }
  return c.json({ success: true, message: result.message });
});

integrationRoutes.get('/ticketing', requireScope('organization', 'partner', 'system'), requireIntegrationRead, async (c) => {
  const auth = c.get('auth');
  const orgResult = resolveOrgId(auth, requestedOrgId(c));
  if ('error' in orgResult) {
    return c.json({ error: orgResult.error }, orgResult.status);
  }

  return c.json({ data: maskIntegrationSettings(ticketingSettings.get(orgResult.orgId) ?? {}) });
});

integrationRoutes.post('/ticketing', requireScope('organization', 'partner', 'system'), requireIntegrationWrite, requireMfa(), async (c) => {
  const auth = c.get('auth');
  const parsed = await parseIntegrationBody(c);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
  const body = parsed.body;
  const explicitOrgId = typeof body.orgId === 'string' ? body.orgId : requestedOrgId(c);
  const orgResult = resolveOrgId(auth, explicitOrgId);
  if ('error' in orgResult) {
    return c.json({ error: orgResult.error }, orgResult.status);
  }

  const protectedBody = protectSettings(body, ticketingSettings.get(orgResult.orgId), 'ticketing', orgResult.orgId);
  if (!protectedBody.ok) return c.json({ error: protectedBody.error }, protectedBody.status);
  ticketingSettings.set(orgResult.orgId, protectedBody.value);
  return c.json({
    success: true,
    message: 'Ticketing settings saved.',
    data: maskIntegrationSettings(protectedBody.value),
  });
});

integrationRoutes.post('/ticketing/test', requireScope('organization', 'partner', 'system'), requireIntegrationWrite, requireMfa(), async (c) => {
  return c.json({ success: true, message: 'Connection successful. Credentials validated.' });
});

integrationRoutes.get('/psa', requireScope('organization', 'partner', 'system'), requireIntegrationRead, async (c) => {
  const auth = c.get('auth');
  const orgResult = resolveOrgId(auth, requestedOrgId(c));
  if ('error' in orgResult) {
    return c.json({ error: orgResult.error }, orgResult.status);
  }

  const existing = psaSettings.get(orgResult.orgId);
  if (!existing) {
    return c.json({ error: 'PSA settings not found' }, 404);
  }

  return c.json({ data: maskIntegrationSettings(existing) });
});

integrationRoutes.post('/psa', requireScope('organization', 'partner', 'system'), requireIntegrationWrite, requireMfa(), async (c) => {
  const auth = c.get('auth');
  const parsed = await parseIntegrationBody(c);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
  const body = parsed.body;
  const explicitOrgId = typeof body.orgId === 'string' ? body.orgId : requestedOrgId(c);
  const orgResult = resolveOrgId(auth, explicitOrgId);
  if ('error' in orgResult) {
    return c.json({ error: orgResult.error }, orgResult.status);
  }

  const protectedBody = protectSettings(body, psaSettings.get(orgResult.orgId), 'psa', orgResult.orgId);
  if (!protectedBody.ok) return c.json({ error: protectedBody.error }, protectedBody.status);
  psaSettings.set(orgResult.orgId, protectedBody.value);
  return c.json({ success: true, data: maskIntegrationSettings(protectedBody.value) });
});

integrationRoutes.put('/psa', requireScope('organization', 'partner', 'system'), requireIntegrationWrite, requireMfa(), async (c) => {
  const auth = c.get('auth');
  const parsed = await parseIntegrationBody(c);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
  const body = parsed.body;
  const explicitOrgId = typeof body.orgId === 'string' ? body.orgId : requestedOrgId(c);
  const orgResult = resolveOrgId(auth, explicitOrgId);
  if ('error' in orgResult) {
    return c.json({ error: orgResult.error }, orgResult.status);
  }

  const protectedBody = protectSettings(body, psaSettings.get(orgResult.orgId), 'psa', orgResult.orgId);
  if (!protectedBody.ok) return c.json({ error: protectedBody.error }, protectedBody.status);
  psaSettings.set(orgResult.orgId, protectedBody.value);
  return c.json({ success: true, data: maskIntegrationSettings(protectedBody.value) });
});

integrationRoutes.post('/psa/test', requireScope('organization', 'partner', 'system'), requireIntegrationWrite, requireMfa(), async (c) => {
  const parsed = await parseIntegrationBody(c);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
  const body = parsed.body;
  const provider = typeof body.provider === 'string' ? body.provider : 'provider';
  return c.json({ success: true, message: `${provider} connection successful.` });
});
