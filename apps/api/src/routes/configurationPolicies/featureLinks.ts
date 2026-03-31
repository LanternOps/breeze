import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AuthContext } from '../../middleware/auth';
import { hasSatisfiedMfa, requirePermission, requireScope } from '../../middleware/auth';
import { backupInlineSettingsSchema, patchInlineSettingsSchema } from '@breeze/shared/validators';
import { writeRouteAudit } from '../../services/auditEvents';
import { PERMISSIONS } from '../../services/permissions';
import {
  getConfigPolicy,
  addFeatureLink,
  updateFeatureLink,
  removeFeatureLink,
  listFeatureLinks,
  validateFeaturePolicyExists,
} from '../../services/configurationPolicy';
import {
  addFeatureLinkSchema,
  updateFeatureLinkSchema,
  idParamSchema,
  linkIdParamSchema,
} from './schemas';

export const featureLinkRoutes = new Hono();
const requireConfigPolicyRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);
const requireConfigPolicyWrite = requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action);

// GET /:id/features — list feature links for a policy
featureLinkRoutes.get(
  '/:id/features',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyRead,
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const policy = await getConfigPolicy(id, auth);
    if (!policy) return c.json({ error: 'Configuration policy not found' }, 404);

    const links = await listFeatureLinks(id);
    return c.json({ data: links });
  }
);

// POST /:id/features — add a feature link
featureLinkRoutes.post(
  '/:id/features',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyWrite,
  zValidator('param', idParamSchema),
  zValidator('json', addFeatureLinkSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');

    const policy = await getConfigPolicy(id, auth);
    if (!policy) return c.json({ error: 'Configuration policy not found' }, 404);

    if (data.featureType === 'patch' && !hasSatisfiedMfa(auth)) {
      return c.json({ error: 'MFA required' }, 403);
    }

    // Validate the referenced feature policy exists (only when a policy ID is provided)
    if (data.featurePolicyId) {
      const validation = await validateFeaturePolicyExists(
        data.featureType,
        data.featurePolicyId,
        policy.orgId
      );
      if (!validation.valid) {
        return c.json({ error: validation.error }, 400);
      }
    }

    if (data.featureType === 'patch') {
      const parsed = patchInlineSettingsSchema.safeParse(data.inlineSettings ?? {});
      if (!parsed.success) {
        return c.json({ error: 'Invalid patch settings', details: parsed.error.flatten() }, 400);
      }
      data.inlineSettings = parsed.data;
    }

    if (data.featureType === 'backup' && data.inlineSettings) {
      const parsed = backupInlineSettingsSchema.safeParse(data.inlineSettings);
      if (!parsed.success) {
        return c.json({ error: 'Invalid backup settings', details: parsed.error.flatten() }, 400);
      }
      data.inlineSettings = parsed.data;
    }

    try {
      const link = await addFeatureLink(
        id,
        data.featureType,
        data.featurePolicyId,
        data.inlineSettings
      );

      writeRouteAudit(c, {
        orgId: policy.orgId,
        action: 'config_policy.feature_link.add',
        resourceType: 'configuration_policy',
        resourceId: id,
        resourceName: policy.name,
        details: { featureType: data.featureType, featurePolicyId: data.featurePolicyId },
      });

      return c.json(link, 201);
    } catch (err: any) {
      if (err?.code === '23505') {
        return c.json({ error: `Feature type "${data.featureType}" already linked to this policy` }, 409);
      }
      throw err;
    }
  }
);

// PATCH /:id/features/:linkId — update a feature link
featureLinkRoutes.patch(
  '/:id/features/:linkId',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyWrite,
  zValidator('param', linkIdParamSchema),
  zValidator('json', updateFeatureLinkSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id, linkId } = c.req.valid('param');
    const data = c.req.valid('json');

    const policy = await getConfigPolicy(id, auth);
    if (!policy) return c.json({ error: 'Configuration policy not found' }, 404);
    const existingLink = policy.featureLinks.find((l: any) => l.id === linkId);

    if (!existingLink) {
      return c.json({ error: 'Feature link not found' }, 404);
    }

    if (existingLink.featureType === 'patch' && !hasSatisfiedMfa(auth)) {
      return c.json({ error: 'MFA required' }, 403);
    }

    if (data.featurePolicyId !== undefined && data.featurePolicyId !== null) {
      const validation = await validateFeaturePolicyExists(
        existingLink.featureType as any,
        data.featurePolicyId,
        policy.orgId
      );
      if (!validation.valid) {
        return c.json({ error: validation.error }, 400);
      }
    }

    if (data.inlineSettings) {
      if (existingLink.featureType === 'patch') {
        const parsed = patchInlineSettingsSchema.safeParse(data.inlineSettings ?? {});
        if (!parsed.success) {
          return c.json({ error: 'Invalid patch settings', details: parsed.error.flatten() }, 400);
        }
        data.inlineSettings = parsed.data;
      }
      if (existingLink.featureType === 'backup') {
        const parsed = backupInlineSettingsSchema.safeParse(data.inlineSettings);
        if (!parsed.success) {
          return c.json({ error: 'Invalid backup settings', details: parsed.error.flatten() }, 400);
        }
        data.inlineSettings = parsed.data;
      }
    }

    const updated = await updateFeatureLink(linkId, data, id);
    if (!updated) return c.json({ error: 'Feature link not found' }, 404);

    writeRouteAudit(c, {
      orgId: policy.orgId,
      action: 'config_policy.feature_link.update',
      resourceType: 'configuration_policy',
      resourceId: id,
      resourceName: policy.name,
      details: { linkId, changedFields: Object.keys(data) },
    });

    return c.json(updated);
  }
);

// DELETE /:id/features/:linkId — remove a feature link
featureLinkRoutes.delete(
  '/:id/features/:linkId',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyWrite,
  zValidator('param', linkIdParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id, linkId } = c.req.valid('param');

    const policy = await getConfigPolicy(id, auth);
    if (!policy) return c.json({ error: 'Configuration policy not found' }, 404);
    const existingLink = policy.featureLinks.find((l: any) => l.id === linkId);
    if (!existingLink) return c.json({ error: 'Feature link not found' }, 404);
    if (existingLink.featureType === 'patch' && !hasSatisfiedMfa(auth)) {
      return c.json({ error: 'MFA required' }, 403);
    }

    const deleted = await removeFeatureLink(linkId, id);
    if (!deleted) return c.json({ error: 'Feature link not found' }, 404);

    writeRouteAudit(c, {
      orgId: policy.orgId,
      action: 'config_policy.feature_link.remove',
      resourceType: 'configuration_policy',
      resourceId: id,
      resourceName: policy.name,
      details: { linkId, featureType: deleted.featureType },
    });

    return c.json({ success: true });
  }
);
