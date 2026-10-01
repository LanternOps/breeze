import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  connectionCreateSchema,
  connectionEndpointSchema,
  connectionRotateKeySchema,
  connectionSettingsPatchSchema,
} from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { writeRouteAudit } from '../../services/auditEvents';
import { getCompatConnection } from '../../services/aiModels/connections';
import { updateConnectionSettings } from '../../services/aiModels/connectionSettings';
import { RegistryWriteError } from '../../services/aiModels/registryWriteErrors';
import { isLlmProviderCatalogEnabled } from '../../services/llm/llmConfigResolver';
import { deletePartnerLlmConfig, savePartnerLlmKey, updatePartnerLlmEndpoint } from '../../services/partnerLlmConfig';
import { idParamSchema, partnerWrite, queueConnectionSync, registryWrite, requirePartnerWide } from './shared';

export const aiModelConnectionRoutes = new Hono();

/**
 * compat_uq (W02–W08): the partner has at most one anthropic_byok/catalog connection; :id must be it.
 * Call it INSIDE the registryWrite callback so a not-yet-cut-over partner gets the recoverable 503, not a 404.
 */
async function ownConnectionId(partnerId: string, id: string): Promise<string> {
  const conn = await getCompatConnection(partnerId);
  if (!conn || conn.id !== id) throw new HTTPException(404, { message: 'Connection not found.' });
  return conn.id;
}

function audit(c: Context, partnerId: string, action: string, details: Record<string, unknown> = {}) {
  writeRouteAudit(c, { orgId: null, action: `ai_models.connection.${action}`, resourceType: 'partner', resourceId: partnerId, details });
}

aiModelConnectionRoutes.post('/', ...partnerWrite, zValidator('json', connectionCreateSchema), async (c) => {
  const { partnerId, userId } = requirePartnerWide(c);
  const body = c.req.valid('json');
  return registryWrite(c, partnerId, async () => {
    if (await getCompatConnection(partnerId)) {
      return c.json({ error: 'This partner already has an Anthropic connection. Rotate its key instead.', code: 'conflict' }, 409);
    }
    switch (body.kind) {
      case 'anthropic_byok': {
        const result = await savePartnerLlmKey({ partnerId, apiKey: body.apiKey, userId });
        const conn = await getCompatConnection(partnerId);
        // The key saved but its connection row is not readable: an inconsistent
        // create, never a 201 with a null id (registryWrite captures the 500).
        if (!conn) throw new RegistryWriteError('The connection could not be created. Try again in a moment.', 'write_failed', 500);
        // Two writes, not one: the key save probes the provider outside any
        // transaction (W03). If the settings write fails, the connection still
        // works with its default name/geo and the admin can edit them.
        if (body.name !== undefined || body.inferenceGeo !== undefined) {
          await updateConnectionSettings({ partnerId, connectionId: conn.id, patch: { name: body.name, inferenceGeo: body.inferenceGeo } });
        }
        audit(c, partnerId, 'created', {
          kind: body.kind, connectionId: conn.id, last4: result.last4, configVersion: result.configVersion,
        });
        return c.json({ id: conn.id }, 201);
      }
      default: {
        const never: never = body.kind;
        throw new HTTPException(400, { message: `Unsupported connection kind ${String(never)}` });
      }
    }
  });
});

aiModelConnectionRoutes.post('/:id/key', ...partnerWrite, zValidator('param', idParamSchema), zValidator('json', connectionRotateKeySchema), async (c) => {
  const { partnerId, userId } = requirePartnerWide(c);
  return registryWrite(c, partnerId, async () => {
    const id = await ownConnectionId(partnerId, c.req.valid('param').id);
    const result = await savePartnerLlmKey({ partnerId, apiKey: c.req.valid('json').apiKey, userId });
    audit(c, partnerId, 'key_rotated', { connectionId: id, last4: result.last4, configVersion: result.configVersion });
    return c.json({ id, keyLast4: result.last4, configVersion: result.configVersion });
  });
});

aiModelConnectionRoutes.post('/:id/endpoint', ...partnerWrite, zValidator('param', idParamSchema), zValidator('json', connectionEndpointSchema), async (c) => {
  const { partnerId, userId } = requirePartnerWide(c);
  const { catalogEntryId, acknowledgeDataNote } = c.req.valid('json');
  // Same rule as routes/aiProvider.ts: the flag gates SELECTING an endpoint, never clearing one.
  if (catalogEntryId !== null && !isLlmProviderCatalogEnabled()) {
    throw new HTTPException(404, { message: 'Catalog endpoint selection is not available on this deployment.' });
  }
  return registryWrite(c, partnerId, async () => {
    const id = await ownConnectionId(partnerId, c.req.valid('param').id);
    const result = await updatePartnerLlmEndpoint({ partnerId, catalogEntryId, acknowledgeDataNote, userId });
    audit(c, partnerId, 'endpoint_changed', {
      connectionId: id,
      catalogEntryId: result.catalogEntryId,
      slug: result.slug,
      revision: result.revision,
      configVersion: result.configVersion,
    });
    return c.json({ id, catalogEntryId: result.catalogEntryId, configVersion: result.configVersion });
  });
});

aiModelConnectionRoutes.patch('/:id', ...partnerWrite, zValidator('param', idParamSchema), zValidator('json', connectionSettingsPatchSchema), async (c) => {
  const { partnerId } = requirePartnerWide(c);
  const patch = c.req.valid('json');
  return registryWrite(c, partnerId, async () => {
    const id = await ownConnectionId(partnerId, c.req.valid('param').id);
    const conn = await updateConnectionSettings({ partnerId, connectionId: id, patch });
    audit(c, partnerId, 'updated', { connectionId: id, ...patch, configVersion: conn.configVersion });
    return c.json({ id, configVersion: conn.configVersion });
  });
});

aiModelConnectionRoutes.delete('/:id', ...partnerWrite, zValidator('param', idParamSchema), async (c) => {
  const { partnerId } = requirePartnerWide(c);
  return registryWrite(c, partnerId, async () => {
    const id = await ownConnectionId(partnerId, c.req.valid('param').id);
    const deleted = await deletePartnerLlmConfig(partnerId);
    if (deleted) audit(c, partnerId, 'deleted', { connectionId: id });
    return c.json({ deleted });
  });
});

// Re-run model discovery for the partner's connection. The implicit platform
// connection has no row (id null in the snapshot), so it is never refreshable
// here: platform discovery is the operator's /admin/ai-models refresh.
aiModelConnectionRoutes.post('/:id/refresh', ...partnerWrite, zValidator('param', idParamSchema), async (c) => {
  const { partnerId } = requirePartnerWide(c);
  return registryWrite(c, partnerId, async () => {
    const id = await ownConnectionId(partnerId, c.req.valid('param').id);
    const failed = await queueConnectionSync(c, id);
    if (failed) return failed;
    audit(c, partnerId, 'refresh_requested', { connectionId: id });
    return c.json({ queued: true, connectionId: id }, 202);
  });
});
