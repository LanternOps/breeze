import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  connectionCreateSchema,
  connectionEndpointSchema,
  connectionGatewayPatchSchema,
  connectionRotateKeySchema,
  connectionSettingsPatchSchema,
  isAnthropicApiConnectionKind,
  isGatewayConnectionKind,
  manualOfferingCreateSchema,
} from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  changeAnthropicEndpoint,
  createAnthropicKeyConnection,
  deleteAnthropicConnection,
  hasAnthropicConnection,
  rotateAnthropicKey,
} from '../../services/aiModels/anthropicConnectionWrites';
import { updateConnectionSettings } from '../../services/aiModels/connectionSettings';
import { clearConnectionCooldowns } from '../../services/aiModels/offeringHealth';
import {
  createGatewayConnection,
  createManualOffering,
  deleteGatewayConnection,
  isEnvManaged,
  updateGatewayConnection,
} from '../../services/aiModels/gatewayConnections';
import { RegistryWriteError } from '../../services/aiModels/registryWriteErrors';
import { isLlmProviderCatalogEnabled } from '../../services/llm/llmConfigResolver';
import { captureException } from '../../services/sentry';
import {
  auditHost,
  idParamSchema,
  ownConnection,
  partnerWrite,
  queueConnectionSync,
  registryWrite,
  requirePartnerWide,
  type OwnedConnection,
} from './shared';

export const aiModelConnectionRoutes = new Hono();

const NOT_FOUND = 'Connection not found.';
const MANAGED_BY_ENV = 'This connection is managed by the MCP_LLM_* environment variables. Change them and restart Breeze.';

/** A live gateway-kind connection of this partner; anything else is 404 (anthropicConnectionWrites owns the Anthropic kinds). */
async function ownGatewayConnection(partnerId: string, id: string): Promise<OwnedConnection> {
  const conn = await ownConnection(partnerId, id);
  if (!isGatewayConnectionKind(conn.kind)) throw new RegistryWriteError(NOT_FOUND, 'not_found', 404);
  return conn;
}

/**
 * W09 (#7607): a key or endpoint change may fix auth_failed / quota_exhausted
 * at once, so forget this connection's failover cooldowns — after the write.
 * Cooldowns fail open: a failed clear only means the old cooldown runs out
 * (15 min) on its own, so it never fails the request; it is reported, not swallowed.
 */
async function clearCooldownsFailOpen(partnerId: string, connectionId: string): Promise<void> {
  try {
    await clearConnectionCooldowns(partnerId, connectionId);
  } catch (error) {
    captureException(error, undefined, { service: 'aiModels', stage: 'cooldown_clear' });
  }
}

function audit(c: Context, partnerId: string, action: string, details: Record<string, unknown> = {}) {
  writeRouteAudit(c, { orgId: null, action: `ai_models.connection.${action}`, resourceType: 'partner', resourceId: partnerId, details });
}

aiModelConnectionRoutes.post('/', ...partnerWrite, zValidator('json', connectionCreateSchema), async (c) => {
  const { partnerId, userId } = requirePartnerWide(c);
  const body = c.req.valid('json');
  return registryWrite(c, partnerId, async () => {
    switch (body.kind) {
      case 'anthropic_byok': {
        // R1 cap (partner_ai_connections_compat_uq): one live Anthropic API
        // connection per partner; re-checked under the registry lock. Gateway
        // kinds are not bound by it.
        if (await hasAnthropicConnection(partnerId)) {
          return c.json({ error: 'This partner already has an Anthropic connection. Rotate its key instead.', code: 'conflict' }, 409);
        }
        const result = await createAnthropicKeyConnection({ partnerId, apiKey: body.apiKey, userId });
        // Two writes, not one: the key save probes the provider outside any
        // transaction (W03). If the settings write fails, the connection still
        // works with its default name/geo and the admin can edit them.
        if (body.name !== undefined || body.inferenceGeo !== undefined) {
          await updateConnectionSettings({ partnerId, connectionId: result.connectionId, patch: { name: body.name, inferenceGeo: body.inferenceGeo } });
        }
        audit(c, partnerId, 'created', {
          kind: body.kind, connectionId: result.connectionId, last4: result.last4, configVersion: result.configVersion,
        });
        return c.json({ id: result.connectionId }, 201);
      }
      case 'openai_compatible': {
        // W06 (#7604). The service validates the URL against the egress policy
        // (ByoEndpointRejected → 400, mapped by registryWrite) and commits in its
        // own registry transaction before it returns, so discovery queued below
        // always sees the row.
        const conn = await createGatewayConnection({
          partnerId, name: body.name, baseUrl: body.baseUrl, apiKey: body.apiKey, connectedBy: userId,
        });
        audit(c, partnerId, 'created', {
          kind: body.kind, connectionId: conn.id, host: auditHost(conn.baseUrl), hasKey: body.apiKey !== undefined,
        });
        // The connection exists either way; a queue outage (captured inside)
        // must not turn a committed create into an error. The daily
        // sync-all-connections sweep discovers it, and Refresh retries now.
        // `discoveryQueued` tells the UI which of the two it is (#7781).
        const discoveryQueued = (await queueConnectionSync(c, conn.id)) === null;
        return c.json({ id: conn.id, discoveryQueued }, 201);
      }
      default: {
        const never: never = body;
        throw new HTTPException(400, { message: `Unsupported connection kind ${String((never as { kind?: unknown }).kind)}` });
      }
    }
  });
});

// W06: endpoint / key of a gateway-kind connection. Optimistic on config_version.
aiModelConnectionRoutes.patch('/:id/gateway', ...partnerWrite, zValidator('param', idParamSchema), zValidator('json', connectionGatewayPatchSchema), async (c) => {
  const { partnerId } = requirePartnerWide(c);
  const body = c.req.valid('json');
  return registryWrite(c, partnerId, async () => {
    const conn = await ownGatewayConnection(partnerId, c.req.valid('param').id);
    const updated = await updateGatewayConnection({
      partnerId, connectionId: conn.id, baseUrl: body.baseUrl, apiKey: body.apiKey, expectedConfigVersion: body.expectedConfigVersion,
    });
    audit(c, partnerId, 'endpoint_changed', {
      kind: conn.kind,
      connectionId: conn.id,
      host: auditHost(updated.baseUrl),
      urlChanged: body.baseUrl !== undefined && updated.baseUrl !== conn.baseUrl,
      key: body.apiKey === undefined ? 'unchanged' : body.apiKey === null ? 'cleared' : 'rotated',
      configVersion: updated.configVersion,
    });
    // W09 (#7607): every successful PATCH changes the key or the URL, either of
    // which may fix auth_failed / quota_exhausted at once — forget this
    // connection's failover cooldowns, as POST /:id/key does. Fails open.
    await clearCooldownsFailOpen(partnerId, conn.id);
    // Spec §6: discovery runs on create AND on every endpoint/key change (a new
    // key can see different models). Best-effort, as on create.
    await queueConnectionSync(c, conn.id);
    return c.json({ id: updated.id, configVersion: updated.configVersion });
  });
});

// W06: hand-entered model on a gateway connection. Lands disabled and unverified;
// the body can never carry capabilities (strict schema) — only the verifier writes them.
aiModelConnectionRoutes.post('/:id/offerings', ...partnerWrite, zValidator('param', idParamSchema), zValidator('json', manualOfferingCreateSchema), async (c) => {
  const { partnerId } = requirePartnerWide(c);
  const body = c.req.valid('json');
  return registryWrite(c, partnerId, async () => {
    const conn = await ownConnection(partnerId, c.req.valid('param').id);
    if (!isGatewayConnectionKind(conn.kind)) {
      throw new RegistryWriteError('Models on this connection are discovered from the provider.', 'not_gateway', 409);
    }
    const offering = await createManualOffering({
      partnerId, connectionId: conn.id, modelId: body.modelId, displayName: body.displayName, prices: body.prices,
    });
    writeRouteAudit(c, {
      orgId: null, action: 'ai_models.offering.added', resourceType: 'partner', resourceId: partnerId,
      details: { offeringId: offering.id, connectionId: conn.id, source: 'manual', modelId: offering.modelId },
    });
    return c.json({ id: offering.id }, 201);
  });
});

aiModelConnectionRoutes.post('/:id/key', ...partnerWrite, zValidator('param', idParamSchema), zValidator('json', connectionRotateKeySchema), async (c) => {
  const { partnerId, userId } = requirePartnerWide(c);
  return registryWrite(c, partnerId, async () => {
    const conn = await ownConnection(partnerId, c.req.valid('param').id);
    if (!isAnthropicApiConnectionKind(conn.kind)) throw new HTTPException(404, { message: NOT_FOUND });
    const id = conn.id;
    const result = await rotateAnthropicKey({ partnerId, connectionId: id, apiKey: c.req.valid('json').apiKey, userId });
    // W09 (#7607): a new key may fix auth_failed / quota_exhausted at once.
    await clearCooldownsFailOpen(partnerId, id);
    audit(c, partnerId, 'key_rotated', { connectionId: id, last4: result.last4, configVersion: result.configVersion });
    return c.json({ id, keyLast4: result.last4, configVersion: result.configVersion });
  });
});

aiModelConnectionRoutes.post('/:id/endpoint', ...partnerWrite, zValidator('param', idParamSchema), zValidator('json', connectionEndpointSchema), async (c) => {
  const { partnerId, userId } = requirePartnerWide(c);
  const { catalogEntryId, acknowledgeDataNote } = c.req.valid('json');
  // Same rule the retired /ai/provider API used: the flag gates SELECTING an endpoint, never clearing one.
  if (catalogEntryId !== null && !isLlmProviderCatalogEnabled()) {
    throw new HTTPException(404, { message: 'Catalog endpoint selection is not available on this deployment.' });
  }
  return registryWrite(c, partnerId, async () => {
    const conn = await ownConnection(partnerId, c.req.valid('param').id);
    if (!isAnthropicApiConnectionKind(conn.kind)) throw new HTTPException(404, { message: NOT_FOUND });
    // A BYOK <-> catalog switch is in place (W08): the connection keeps its id.
    const result = await changeAnthropicEndpoint({ partnerId, connectionId: conn.id, catalogEntryId, acknowledgeDataNote, userId });
    // W08a: the switch is in place now (same id), so the failover cooldowns keyed
    // by this connection would otherwise outlive the endpoint they were earned on.
    await clearCooldownsFailOpen(partnerId, result.connectionId);
    audit(c, partnerId, 'endpoint_changed', {
      connectionId: conn.id,
      newConnectionId: result.connectionId,
      catalogEntryId: result.catalogEntryId,
      slug: result.slug,
      revision: result.revision,
      configVersion: result.configVersion,
    });
    return c.json({ id: result.connectionId, catalogEntryId: result.catalogEntryId, configVersion: result.configVersion });
  });
});

aiModelConnectionRoutes.patch('/:id', ...partnerWrite, zValidator('param', idParamSchema), zValidator('json', connectionSettingsPatchSchema), async (c) => {
  const { partnerId } = requirePartnerWide(c);
  const patch = c.req.valid('json');
  return registryWrite(c, partnerId, async () => {
    const owned = await ownConnection(partnerId, c.req.valid('param').id);
    if (isGatewayConnectionKind(owned.kind)) {
      // D7: a BYO endpoint's geography is unverifiable, so it can never claim one.
      // A kind never crosses between gateway and Anthropic (W08's in-place
      // switch stays within anthropic_byok | catalog), so this cannot race a write.
      if (patch.inferenceGeo !== undefined && patch.inferenceGeo !== null) {
        return c.json({ error: 'This connection cannot claim an inference geography.', code: 'geo_not_supported' }, 422);
      }
      if (isEnvManaged(owned)) return c.json({ error: MANAGED_BY_ENV, code: 'managed_by_env' }, 409);
    }
    const conn = await updateConnectionSettings({ partnerId, connectionId: owned.id, patch });
    audit(c, partnerId, 'updated', { connectionId: owned.id, ...patch, configVersion: conn.configVersion });
    return c.json({ id: owned.id, configVersion: conn.configVersion });
  });
});

aiModelConnectionRoutes.delete('/:id', ...partnerWrite, zValidator('param', idParamSchema), async (c) => {
  const { partnerId } = requirePartnerWide(c);
  return registryWrite(c, partnerId, async () => {
    const conn = await ownConnection(partnerId, c.req.valid('param').id);
    if (isGatewayConnectionKind(conn.kind)) {
      // Soft-disconnect (W03 shape); refused while a model on it is a default (409 connection_in_use).
      await deleteGatewayConnection({ partnerId, connectionId: conn.id });
      audit(c, partnerId, 'deleted', { connectionId: conn.id, kind: conn.kind });
      return c.json({ deleted: true });
    }
    // Soft-disconnect (W03 shape): its references go back to the platform first.
    const deleted = await deleteAnthropicConnection({ partnerId, connectionId: conn.id });
    if (deleted) audit(c, partnerId, 'deleted', { connectionId: conn.id });
    return c.json({ deleted });
  });
});

// Re-run model discovery for the partner's connection. The implicit platform
// connection has no row (id null in the snapshot), so it is never refreshable
// here: platform discovery is the operator's /admin/ai-models refresh.
aiModelConnectionRoutes.post('/:id/refresh', ...partnerWrite, zValidator('param', idParamSchema), async (c) => {
  const { partnerId } = requirePartnerWide(c);
  return registryWrite(c, partnerId, async () => {
    const conn = await ownConnection(partnerId, c.req.valid('param').id);
    const failed = await queueConnectionSync(c, conn.id);
    if (failed) return failed;
    // A gateway connection's discovery is partner-level egress (no org, so no
    // llm_egress_events row): this route audit is its record, so it names the host.
    audit(c, partnerId, 'refresh_requested', isGatewayConnectionKind(conn.kind)
      ? { connectionId: conn.id, kind: conn.kind, host: auditHost(conn.baseUrl) }
      : { connectionId: conn.id });
    return c.json({ queued: true, connectionId: conn.id }, 202);
  });
});
