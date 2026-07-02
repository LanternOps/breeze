import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AuthContext } from '../../middleware/auth';
import { hasSatisfiedMfa, requirePermission, requireScope } from '../../middleware/auth';
import { backupInlineSettingsSchema, patchInlineSettingsSchema } from '@breeze/shared/validators';
import { writeRouteAudit } from '../../services/auditEvents';
import { PERMISSIONS } from '../../services/permissions';
import { isPgUniqueViolation } from '../../utils/pgErrors';
import { findOfflineDurationViolation } from '../../services/alertConditions/offlineDuration';
import {
  getConfigPolicy,
  addFeatureLink,
  updateFeatureLink,
  removeFeatureLink,
  listFeatureLinks,
  validateFeaturePolicyExists,
  pamInlineSettingsSchema,
  remoteAccessInlineSettingsSchema,
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
  PARTNER_LINKABLE_FEATURE_TYPES,
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
// carry a concrete org_id FK, so a partner-wide policy has no owning org to
// anchor them to. Rejecting these at the feature-link write layer keeps the
// read side (effective-config resolution) and the write side consistent — a
// partner-wide policy never advertises coverage that can't be delivered.
//
// patch is deliberately NOT here: update rings are partner-axis (partner_id, no
// org_id) and the patch scheduler groups by each device's own org, so a
// partner-wide patch policy resolves and schedules end-to-end across every org
// under the partner. See configPolicyPatching.ts.
const ORG_SCOPED_ONLY_FEATURES = new Set(['backup', 'onedrive_helper']);

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

    // Feature links carry the policy's actual settings (patch schedules, PAM,
    // remote access...), so editing them on a partner-wide policy has the same
    // all-orgs blast radius as creating one — gate on the same capability.
    if (policy.orgId === null && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

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
      // Most referenced feature policies are org-scoped and can't be linked to
      // a partner-owned policy (org_id NULL, #1724) — EXCEPT the feature types
      // whose standalone table supports partner ownership (update rings,
      // software policies, ... — see PARTNER_LINKABLE_FEATURE_TYPES).
      if (policy.orgId === null && !PARTNER_LINKABLE_FEATURE_TYPES.has(data.featureType)) {
        return c.json({ error: 'Cannot link an org-scoped feature policy to a partner-owned policy' }, 400);
      }
      const validation = await validateFeaturePolicyExists(
        data.featureType,
        data.featurePolicyId,
        { orgId: policy.orgId, partnerId: policy.partnerId }
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

    // Reject offline alert rules whose duration exceeds the re-eval horizon —
    // such a rule could never fire (issue #1982).
    if (data.featureType === 'alert_rule' && data.inlineSettings) {
      const violation = findOfflineDurationViolation(data.inlineSettings);
      if (violation) return c.json({ error: violation }, 400);
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

    // Same all-orgs blast radius as the POST gate above.
    if (policy.orgId === null && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    const existingLink = policy.featureLinks.find((l: any) => l.id === linkId);

    if (!existingLink) {
      return c.json({ error: 'Feature link not found' }, 404);
    }

    if (existingLink.featureType === 'patch' && !hasSatisfiedMfa(auth)) {
      return c.json({ error: 'MFA required' }, 403);
    }

    if (data.featurePolicyId !== undefined && data.featurePolicyId !== null) {
      // Same partner-linkable exception as the POST route above.
      if (policy.orgId === null && !PARTNER_LINKABLE_FEATURE_TYPES.has(existingLink.featureType as any)) {
        return c.json({ error: 'Cannot link an org-scoped feature policy to a partner-owned policy' }, 400);
      }
      const validation = await validateFeaturePolicyExists(
        existingLink.featureType as any,
        data.featurePolicyId,
        { orgId: policy.orgId, partnerId: policy.partnerId }
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
      // Reject offline alert rules whose duration exceeds the re-eval horizon —
      // such a rule could never fire (issue #1982).
      if (existingLink.featureType === 'alert_rule') {
        const violation = findOfflineDurationViolation(data.inlineSettings);
        if (violation) return c.json({ error: violation }, 400);
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

    // Same all-orgs blast radius as the POST/PATCH gates above.
    if (policy.orgId === null && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

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
