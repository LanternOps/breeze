import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { zValidator } from '../lib/validation';
import { authMiddleware, requireMfa, requirePermission } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import {
  deletePartnerLlmConfig,
  getPartnerLlmStatus,
  PartnerLlmError,
  savePartnerLlmKey,
  updatePartnerLlmConfig,
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

aiProviderRoutes.use('*', authMiddleware);

aiProviderRoutes.get(
  '/',
  requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action),
  async (c) => {
    const auth = c.get('auth');
    if (!auth?.partnerId) throw new HTTPException(403, { message: 'Partner context required' });
    if (!canManagePartnerWidePolicies(auth)) throw new HTTPException(403, { message: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    const status = await getPartnerLlmStatus(auth.partnerId);
    return c.json({
      configured: status.configured,
      provider: status.provider,
      keyLast4: status.keyLast4,
      defaultModel: status.defaultModel,
      status: status.status,
      verifiedAt: status.verifiedAt?.toISOString() ?? null,
      lastError: status.lastError,
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
