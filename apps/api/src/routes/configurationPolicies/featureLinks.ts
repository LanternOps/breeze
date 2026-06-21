import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AuthContext } from '../../middleware/auth';
import { hasSatisfiedMfa, requirePermission, requireScope } from '../../middleware/auth';
import { backupInlineSettingsSchema, patchInlineSettingsSchema } from '@breeze/shared/validators';
import { writeRouteAudit } from '../../services/auditEvents';
import { PERMISSIONS } from '../../services/permissions';
import { isPgUniqueViolation } from '../../utils/pgErrors';
import {
  getConfigPolicy,
  addFeatureLink,
  updateFeatureLink,
  removeFeatureLink,
  listFeatureLinks,
  validateFeaturePolicyExists,
  pamInlineSettingsSchema,
  remoteAccessInlineSettingsSchema,
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

// Feature types whose per-feature config is fundamentally org-scoped and cannot
// be authored on a partner-wide policy (#1724): backup/onedrive_helper settings
// carry a concrete org_id FK, and patch scheduling is org-batch only (the
// scheduler iterates orgs, not partners). Rejecting these at the feature-link
// write layer keeps the read side (effective-config resolution) and the write
// side consistent — a partner-wide policy never advertises coverage the
// scheduler won't deliver. See the PR scope note.
const ORG_SCOPED_ONLY_FEATURES = new Set(['backup', 'onedrive_helper', 'patch']);

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

    // Partner-wide policies (org_id NULL, #1724) can't carry org-scoped feature
    // settings. Reject at write time so the scheduler/read-side stay consistent.
    if (policy.orgId === null && ORG_SCOPED_ONLY_FEATURES.has(data.featureType)) {
      return c.json(
        { error: `The "${data.featureType}" feature is not supported on partner-wide policies; it must be configured on an organization-scoped policy.` },
        400
      );
    }

    if (data.featureType === 'patch' && !hasSatisfiedMfa(auth)) {
      return c.json({ error: 'MFA required' }, 403);
    }

    // Validate the referenced feature policy exists (only when a policy ID is provided)
    if (data.featurePolicyId) {
      // Referenced feature policies are org-scoped; a partner-owned config
      // policy (org_id NULL, #1724) cannot link one.
      if (policy.orgId === null) {
        return c.json({ error: 'Cannot link an org-scoped feature policy to a partner-owned policy' }, 400);
      }
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
        // `issues` included so the web client (extractApiError) can render the messages.
        return c.json(
          { error: 'Invalid patch settings', details: parsed.error.flatten(), issues: parsed.error.issues },
          400
        );
      }
      data.inlineSettings = parsed.data;
    }

    if (data.featureType === 'backup' && data.inlineSettings) {
      const parsed = backupInlineSettingsSchema.safeParse(data.inlineSettings);
      if (!parsed.success) {
        return c.json(
          { error: 'Invalid backup settings', details: parsed.error.flatten(), issues: parsed.error.issues },
          400
        );
      }
      data.inlineSettings = parsed.data;
    }

    if (data.featureType === 'pam' && data.inlineSettings) {
      const parsed = pamInlineSettingsSchema.safeParse(data.inlineSettings);
      if (!parsed.success) {
        return c.json(
          { error: 'Invalid pam settings', details: parsed.error.flatten(), issues: parsed.error.issues },
          400
        );
      }
      data.inlineSettings = parsed.data;
    }

    if (data.featureType === 'remote_access' && data.inlineSettings) {
      const parsed = remoteAccessInlineSettingsSchema.safeParse(data.inlineSettings);
      if (!parsed.success) {
        return c.json(
          { error: 'Invalid remote access settings', details: parsed.error.flatten(), issues: parsed.error.issues },
          400
        );
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
    } catch (err: unknown) {
      if (isPgUniqueViolation(err)) {
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
      // Referenced feature policies are org-scoped; a partner-owned config
      // policy (org_id NULL, #1724) cannot link one.
      if (policy.orgId === null) {
        return c.json({ error: 'Cannot link an org-scoped feature policy to a partner-owned policy' }, 400);
      }
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
          return c.json(
            { error: 'Invalid patch settings', details: parsed.error.flatten(), issues: parsed.error.issues },
            400
          );
        }
        data.inlineSettings = parsed.data;
      }
      if (existingLink.featureType === 'backup') {
        const parsed = backupInlineSettingsSchema.safeParse(data.inlineSettings);
        if (!parsed.success) {
          return c.json(
            { error: 'Invalid backup settings', details: parsed.error.flatten(), issues: parsed.error.issues },
            400
          );
        }
        data.inlineSettings = parsed.data;
      }
      if (existingLink.featureType === 'pam') {
        const parsed = pamInlineSettingsSchema.safeParse(data.inlineSettings);
        if (!parsed.success) {
          return c.json(
            { error: 'Invalid pam settings', details: parsed.error.flatten(), issues: parsed.error.issues },
            400
          );
        }
        data.inlineSettings = parsed.data;
      }
      if (existingLink.featureType === 'remote_access') {
        const parsed = remoteAccessInlineSettingsSchema.safeParse(data.inlineSettings);
        if (!parsed.success) {
          return c.json(
            { error: 'Invalid remote access settings', details: parsed.error.flatten(), issues: parsed.error.issues },
            400
          );
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
