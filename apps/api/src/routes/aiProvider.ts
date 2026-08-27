import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { zValidator } from '../lib/validation';
import { authMiddleware, requireMfa, requirePermission } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { OFFERABLE_AI_MODELS } from '../services/aiCostTracker';
import { isLlmProviderCatalogEnabled } from '../services/llm/llmConfigResolver';
import { getListedProviders } from '../services/llmProviderCatalog';
import {
  deletePartnerLlmConfig,
  getPartnerLlmStatus,
  PartnerLlmError,
  savePartnerLlmKey,
  updatePartnerLlmConfig,
  updatePartnerLlmEndpoint,
} from '../services/partnerLlmConfig';
import { PERMISSIONS } from '../services/permissions';
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
} from '../services/partnerWideAccess';
import { captureException } from '../services/sentry';

export const aiProviderRoutes = new Hono();

const saveKeySchema = z.object({
  apiKey: z.string().trim().min(20, 'Enter a valid Anthropic API key.'),
});

const updateConfigSchema = z.object({
  defaultModel: z.string().trim().min(1).nullable(),
});

const updateEndpointSchema = z.object({
  catalogEntryId: z.string().trim().min(1).nullable(),
  acknowledgeDataNote: z.boolean().optional().default(false),
});

/** GET / payload shape for one listed catalog entry — never the raw base URL, auth mode, or pricing. */
async function buildCatalogSummary(): Promise<Array<{
  entryId: string;
  slug: string;
  name: string;
  dataNote: string | null;
  models: string[];
}>> {
  const providers = await getListedProviders();
  return providers.map((provider) => ({
    entryId: provider.entryId,
    slug: provider.slug,
    name: provider.name,
    dataNote: provider.dataNote,
    // Verified ∩ mapped: a verification recorded against a model no longer in
    // this revision's modelMap must never appear selectable.
    models: provider.verifiedModels.filter((modelId) => modelId in provider.modelMap),
  }));
}

aiProviderRoutes.use('*', authMiddleware);

aiProviderRoutes.get(
  '/',
  requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action),
  async (c) => {
    const auth = c.get('auth');
    if (!auth?.partnerId) throw new HTTPException(403, { message: 'Partner context required' });
    if (!canManagePartnerWidePolicies(auth)) {
      throw new HTTPException(403, {
        message: 'Viewing the partner AI provider configuration requires full partner org access (orgAccess must be "all")',
      });
    }
    const status = await getPartnerLlmStatus(auth.partnerId);
    // Empty, not an error, when the flag is off — a partner with no catalog
    // access simply sees no endpoint options, exactly like phase 1 today.
    const catalog = isLlmProviderCatalogEnabled() ? await buildCatalogSummary() : [];
    return c.json({
      configured: status.configured,
      provider: status.provider,
      keyLast4: status.keyLast4,
      defaultModel: status.defaultModel,
      status: status.status,
      verifiedAt: status.verifiedAt?.toISOString() ?? null,
      lastError: status.lastError,
      // Options for the web UI's default-model select. Sourced from the cost
      // tracker's pricing registry so the UI can never offer a model we can't
      // meter.
      supportedModels: [...OFFERABLE_AI_MODELS],
      catalogEntryId: status.catalogEntryId,
      catalog,
    });
  },
);

aiProviderRoutes.post(
  '/key',
  requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action),
  requireMfa(),
  zValidator('json', saveKeySchema),
  async (c) => {
    const auth = c.get('auth');
    if (!auth?.partnerId) throw new HTTPException(403, { message: 'Partner context required' });
    if (!canManagePartnerWidePolicies(auth)) throw new HTTPException(403, { message: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    const { apiKey } = c.req.valid('json');
    try {
      const result = await savePartnerLlmKey({
        partnerId: auth.partnerId,
        apiKey,
        userId: auth.user.id,
      });
      writeRouteAudit(c, {
        orgId: null,
        action: 'ai_provider.connected',
        resourceType: 'partner',
        resourceId: auth.partnerId,
        details: { last4: result.last4, configVersion: result.configVersion },
      });
      return c.json({
        configured: true,
        provider: 'anthropic',
        keyLast4: result.last4,
        defaultModel: result.model,
        status: 'active',
        verifiedAt: result.verifiedAt.toISOString(),
        lastError: null,
      });
    } catch (error) {
      if (error instanceof PartnerLlmError) {
        if (error.status >= 500) captureException(error, undefined, { service: 'aiProvider' });
        return c.json({ error: error.message }, error.status);
      }
      throw error;
    }
  },
);

aiProviderRoutes.patch(
  '/',
  requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action),
  zValidator('json', updateConfigSchema),
  async (c) => {
    const auth = c.get('auth');
    if (!auth?.partnerId) throw new HTTPException(403, { message: 'Partner context required' });
    if (!canManagePartnerWidePolicies(auth)) throw new HTTPException(403, { message: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    const { defaultModel } = c.req.valid('json');
    try {
      const result = await updatePartnerLlmConfig({ partnerId: auth.partnerId, defaultModel });
      writeRouteAudit(c, {
        orgId: null,
        action: 'ai_provider.updated',
        resourceType: 'partner',
        resourceId: auth.partnerId,
        details: { defaultModel, configVersion: result.configVersion },
      });
      return c.json(result);
    } catch (error) {
      if (error instanceof PartnerLlmError) {
        if (error.status >= 500) captureException(error, undefined, { service: 'aiProvider' });
        return c.json({ error: error.message }, error.status);
      }
      throw error;
    }
  },
);

aiProviderRoutes.post(
  '/endpoint',
  requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action),
  requireMfa(),
  zValidator('json', updateEndpointSchema),
  async (c) => {
    const auth = c.get('auth');
    if (!auth?.partnerId) throw new HTTPException(403, { message: 'Partner context required' });
    if (!canManagePartnerWidePolicies(auth)) throw new HTTPException(403, { message: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    if (!isLlmProviderCatalogEnabled()) {
      throw new HTTPException(404, { message: 'Catalog endpoint selection is not available on this deployment.' });
    }
    const { catalogEntryId, acknowledgeDataNote } = c.req.valid('json');
    try {
      const result = await updatePartnerLlmEndpoint({
        partnerId: auth.partnerId,
        catalogEntryId,
        acknowledgeDataNote,
        userId: auth.user.id,
      });
      writeRouteAudit(c, {
        orgId: null,
        action: 'ai_provider.endpoint_changed',
        resourceType: 'partner',
        resourceId: auth.partnerId,
        details: {
          catalogEntryId: result.catalogEntryId,
          slug: result.slug,
          revision: result.revision,
          configVersion: result.configVersion,
        },
      });
      return c.json({
        catalogEntryId: result.catalogEntryId,
        configVersion: result.configVersion,
      });
    } catch (error) {
      if (error instanceof PartnerLlmError) {
        if (error.status >= 500) captureException(error, undefined, { service: 'aiProvider' });
        return c.json({ error: error.message }, error.status);
      }
      throw error;
    }
  },
);

aiProviderRoutes.delete(
  '/',
  requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    if (!auth?.partnerId) throw new HTTPException(403, { message: 'Partner context required' });
    if (!canManagePartnerWidePolicies(auth)) throw new HTTPException(403, { message: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    const deleted = await deletePartnerLlmConfig(auth.partnerId);
    if (deleted) {
      writeRouteAudit(c, {
        orgId: null,
        action: 'ai_provider.disconnected',
        resourceType: 'partner',
        resourceId: auth.partnerId,
      });
    }
    return c.json({ configured: false, status: 'platform' });
  },
);
