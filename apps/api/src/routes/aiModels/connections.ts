import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  connectionCreateSchema,
  connectionEndpointSchema,
  connectionGatewayPatchSchema,
  connectionRotateKeySchema,
  connectionSettingsPatchSchema,
  isGatewayConnectionKind,
  manualOfferingCreateSchema,
} from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { writeRouteAudit } from '../../services/auditEvents';
import { getCompatConnection } from '../../services/aiModels/connections';
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
import { deletePartnerLlmConfig, savePartnerLlmKey, updatePartnerLlmEndpoint } from '../../services/partnerLlmConfig';
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

/**
 * compat_uq (W02–W08): the partner has at most one anthropic_byok/catalog connection; :id must be it.
 * Call it INSIDE the registryWrite callback so a not-yet-cut-over partner gets the recoverable 503, not a 404.
 * The compat-only routes (/:id/key, /:id/endpoint) use it directly, so a gateway id 404s there.
 */
async function ownConnectionId(partnerId: string, id: string): Promise<string> {
  const conn = await getCompatConnection(partnerId);
  if (!conn || conn.id !== id) throw new HTTPException(404, { message: NOT_FOUND });
  return conn.id;
}

/**
 * Any-kind ownership for the routes every kind shares (settings, delete,
 * refresh). An Anthropic-dialect id must additionally be the partner's live
 * compat connection, exactly as W04 bound it, because the compat services it
 * reaches (deletePartnerLlmConfig) act on "the" compat connection, not an id.
 */
async function ownAnyConnection(partnerId: string, id: string): Promise<OwnedConnection> {
  const conn = await ownConnection(partnerId, id);
  if (!isGatewayConnectionKind(conn.kind)) await ownConnectionId(partnerId, conn.id);
  return conn;
}

/** A live gateway-kind connection of this partner; anything else is 404 (the compat flows own Anthropic kinds). */
async function ownGatewayConnection(partnerId: string, id: string): Promise<OwnedConnection> {
  const conn = await ownConnection(partnerId, id);
  if (!isGatewayConnectionKind(conn.kind)) throw new RegistryWriteError(NOT_FOUND, 'not_found', 404);
  return conn;
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
        // compat_uq: one Anthropic-dialect connection per partner. Gateway kinds are not bound by it.
        if (await getCompatConnection(partnerId)) {
          return c.json({ error: 'This partner already has an Anthropic connection. Rotate its key instead.', code: 'conflict' }, 409);
        }
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
        await queueConnectionSync(c, conn.id);
        return c.json({ id: conn.id }, 201);
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
    try {
      await clearConnectionCooldowns(partnerId, conn.id);
    } catch (error) {
      console.warn('[aiModels] cooldown clear after gateway update failed', { connectionId: conn.id, error: error instanceof Error ? error.message : String(error) });
    }
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
    const id = await ownConnectionId(partnerId, c.req.valid('param').id);
    const result = await savePartnerLlmKey({ partnerId, apiKey: c.req.valid('json').apiKey, userId });
    // W09 (#7607): a new key may fix auth_failed / quota_exhausted at once, so
    // forget this connection's failover cooldowns. Cooldowns fail open: a
    // failed clear only means the old cooldown runs out (15 min) on its own.
    try {
      await clearConnectionCooldowns(partnerId, id);
    } catch (error) {
      console.warn('[aiModels] cooldown clear after key rotation failed', { connectionId: id, error: error instanceof Error ? error.message : String(error) });
    }
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
    const owned = await ownAnyConnection(partnerId, c.req.valid('param').id);
    if (isGatewayConnectionKind(owned.kind)) {
      // D7: a BYO endpoint's geography is unverifiable, so it can never claim one.
      // `kind` is immutable, so this check cannot race a write.
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
    const conn = await ownAnyConnection(partnerId, c.req.valid('param').id);
    if (isGatewayConnectionKind(conn.kind)) {
      // Soft-disconnect (W03 shape); refused while a model on it is a default (409 connection_in_use).
      await deleteGatewayConnection({ partnerId, connectionId: conn.id });
      audit(c, partnerId, 'deleted', { connectionId: conn.id, kind: conn.kind });
      return c.json({ deleted: true });
    }
    const deleted = await deletePartnerLlmConfig(partnerId);
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
    const conn = await ownAnyConnection(partnerId, c.req.valid('param').id);
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
