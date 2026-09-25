import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { zodValidationErrorBody } from '../../lib/zodIssues';
import type { AuthContext } from '../../middleware/auth';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import {
  alertRuleInlineSettingsSchema,
  backupInlineSettingsSchema,
  backupProfileLinkedInlineSettingsSchema,
  clientSuppliedWarrantyHpCmslConsent,
  hardwareMonitoringInlineSettingsSchema,
  maintenanceInlineSettingsSchema,
  monitoringInlineSettingsSchema,
  monitorsInlineSettingsSchema,
  onedriveHelperInlineSettingsSchema,
  patchInlineSettingsSchema,
  warrantyHpCmslRequested,
  warrantyInlineSettingsSchema,
} from '@breeze/shared/validators';
import { ORG_SCOPED_ONLY_FEATURE_TYPES } from '@breeze/shared/constants';
import { writeRouteAudit } from '../../services/auditEvents';
import { canMutateOrgWideGovernance, SITE_CEILING_WRITE_DENIED_MESSAGE } from '../../services/siteCeilingAccess';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { findOfflineDurationViolation } from '../../services/alertConditions/offlineDuration';
import {
  getConfigPolicy,
  addFeatureLink,
  updateFeatureLink,
  removeFeatureLink,
  listFeatureLinks,
  validateFeaturePolicyExists,
  deviceLifecycleInlineSettingsSchema,
  pamInlineSettingsSchema,
  remoteAccessInlineSettingsSchema,
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
  PARTNER_LINKABLE_FEATURE_TYPES,
  isBackupProfileReference,
  WarrantyConsentError,
} from '../../services/configurationPolicy';
import { isMonitorAttachableToPolicy } from '../../services/monitors/monitorAttachability';
import { getMonitorDefinition } from '../../services/monitors/monitorService';
import { pgErrorCode, pgErrorConstraint } from '../../utils/pgErrors';
import {
  MAX_MAX_SESSION_DURATION_HOURS,
  MIN_MAX_SESSION_DURATION_HOURS,
} from '../../services/remoteAccessPolicy';
import {
  addFeatureLinkSchema,
  updateFeatureLinkSchema,
  idParamSchema,
  linkIdParamSchema,
} from './schemas';
import { AutomationReferenceAuthorizationError } from '../../services/automationReferenceAuthorization';
import { checkHpCmslWriteAllowed, warrantyLinkEnablesCollection } from './hpCmslGate';

// The `config_policy_monitors_compat` deferred constraint trigger
// (2026-10-16-160300-monitor-definitions.sql) is the owner-compatibility
// authority for monitor attachments — it fires at COMMIT, after the insert
// this route issues has already returned, so the 23514 surfaces from the
// `await addFeatureLink(...)` / `await updateFeatureLink(...)` call itself.
// Mapped to a 400 here rather than left to bubble as a raw 500.
const MONITOR_NOT_ATTACHABLE_CONSTRAINT = 'config_policy_monitors_compat';

function isMonitorNotAttachableDbError(err: unknown): boolean {
  return pgErrorCode(err) === '23514' && pgErrorConstraint(err) === MONITOR_NOT_ATTACHABLE_CONSTRAINT;
}

export const featureLinkRoutes = new Hono();
const requireConfigPolicyRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);
const requireConfigPolicyWrite = requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action);

// Feature types whose per-feature config is fundamentally org-scoped and cannot
// be authored on a partner-wide policy (#1724). Sourced from
// `@breeze/shared/constants` (ORG_SCOPED_ONLY_FEATURE_TYPES) so the web-side
// tab gating (ConfigPolicyDetailPage.tsx, #2101) can't drift from this rule.
// Rejecting these at the feature-link write layer keeps the read side
// (effective-config resolution) and the write side consistent — a
// partner-wide policy never advertises coverage that can't be delivered.
//
// patch is deliberately NOT here: update rings are partner-axis (partner_id, no
// org_id) and the patch scheduler groups by each device's own org, so a
// partner-wide patch policy resolves and schedules end-to-end across every org
// under the partner. See configPolicyPatching.ts.
const ORG_SCOPED_ONLY_FEATURES: ReadonlySet<string> = ORG_SCOPED_ONLY_FEATURE_TYPES;

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
// #5511 W02 (contract D3): HP CMSL consent is stamped by the server from the
// authenticated session, never accepted from a client. One literal, shared by
// the POST/PATCH pre-checks and the service-error mapping, so the code a UI
// branches on cannot drift between them.
const WARRANTY_CONSENT_REFUSAL = {
  error: 'HP CMSL consent is recorded by the server from your authenticated session. Remove hpCmsl.consent from the request and send it again.',
  code: 'WARRANTY_CONSENT_NOT_CLIENT_SETTABLE',
} as const;

featureLinkRoutes.post(
  '/:id/features',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyWrite,
  requireMfa(),
  zValidator('param', idParamSchema),
  zValidator('json', addFeatureLinkSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    if (!canMutateOrgWideGovernance(auth)) {
      return c.json({ error: SITE_CEILING_WRITE_DENIED_MESSAGE }, 403);
    }
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

    // #5511 W02 (contract D4): enabling device-side HP warranty collection
    // installs HP software on every HP endpoint this policy reaches, so it
    // carries the deployment gate — devices.execute (and MFA, already enforced
    // route-level) — rather than the plain devices.write every other
    // feature-link write needs. Keyed on the RESULT of the write, not the
    // feature type: an alert-threshold edit installs nothing and stays ungated.
    if (data.featureType === 'warranty' && warrantyHpCmslRequested(data.inlineSettings)) {
      const gate = checkHpCmslWriteAllowed(auth, c.get('permissions') as UserPermissions | undefined);
      if (!gate.allowed) return c.json(gate.body, 403);
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
          zodValidationErrorBody('Invalid patch settings', parsed.error),
          400
        );
      }
      data.inlineSettings = parsed.data;
    }

    if (data.featureType === 'backup' && data.inlineSettings) {
      const profileLinked = await isBackupProfileReference(data.featurePolicyId);
      const schema = profileLinked
        ? backupProfileLinkedInlineSettingsSchema
        : backupInlineSettingsSchema;
      const parsed = schema.safeParse(data.inlineSettings);
      if (!parsed.success) {
        return c.json(
          zodValidationErrorBody('Invalid backup settings', parsed.error),
          400
        );
      }
      data.inlineSettings = parsed.data;
    }

    if (data.featureType === 'pam' && data.inlineSettings) {
      const parsed = pamInlineSettingsSchema.safeParse(data.inlineSettings);
      if (!parsed.success) {
        return c.json(
          zodValidationErrorBody('Invalid pam settings', parsed.error),
          400
        );
      }
      data.inlineSettings = parsed.data;
    }

    if (data.featureType === 'device_lifecycle' && data.inlineSettings) {
      const parsed = deviceLifecycleInlineSettingsSchema.safeParse(data.inlineSettings);
      if (!parsed.success) {
        return c.json(
          zodValidationErrorBody('Invalid device lifecycle settings', parsed.error),
          400
        );
      }
      data.inlineSettings = parsed.data;
    }

    // #5511 W02 (contract D3): the consent refusal runs FIRST and on its own so
    // a client that supplied one gets a coded, actionable 400. Letting the
    // strict schema report it would produce a bare "Unrecognized key" with no
    // `code`, and silently stripping it would let a UI believe an acceptance
    // had been recorded when none was.
    if (data.featureType === 'warranty' && data.inlineSettings) {
      if (clientSuppliedWarrantyHpCmslConsent(data.inlineSettings)) {
        return c.json(WARRANTY_CONSENT_REFUSAL, 400);
      }
      const parsed = warrantyInlineSettingsSchema.safeParse(data.inlineSettings);
      if (!parsed.success) {
        return c.json(
          zodValidationErrorBody('Invalid warranty settings', parsed.error),
          400
        );
      }
      data.inlineSettings = parsed.data;
    }

    // #6312: `maintenance` was the only inline shape with no write-time schema.
    // The evaluator degrades silently on every bad field (unknown recurrence ->
    // window never opens, bad timezone -> UTC, unparseable windowStart ->
    // midnight, non-positive duration -> never active), so a garbage payload
    // used to return 201 and leave a policy that suppresses nothing.
    if (data.featureType === 'maintenance' && data.inlineSettings) {
      const parsed = maintenanceInlineSettingsSchema.safeParse(data.inlineSettings);
      if (!parsed.success) {
        return c.json(
          zodValidationErrorBody('Invalid maintenance settings', parsed.error),
          400
        );
      }
      data.inlineSettings = parsed.data;
    }

    if (data.featureType === 'remote_access' && data.inlineSettings) {
      const parsed = remoteAccessInlineSettingsSchema.safeParse(data.inlineSettings);
      if (!parsed.success) {
        return c.json(
          zodValidationErrorBody('Invalid remote access settings', parsed.error),
          400
        );
      }
      const rangeError = remoteAccessWriteRangeError(parsed.data);
      if (rangeError) return c.json({ error: rangeError }, 400);
      data.inlineSettings = parsed.data;
    }

    if (data.featureType === 'onedrive_helper' && data.inlineSettings) {
      const parsed = onedriveHelperInlineSettingsSchema.safeParse(data.inlineSettings);
      if (!parsed.success) {
        return c.json(
          zodValidationErrorBody('Invalid onedrive_helper settings', parsed.error),
          400
        );
      }
      data.inlineSettings = parsed.data;
    }

    // Reject offline alert rules whose duration exceeds the re-eval horizon —
    // such a rule could never fire (issue #1982). Runs BEFORE the schema parse
    // below so an oversized-but-well-formed duration gets this specific message
    // rather than the enum/range message.
    if (data.featureType === 'alert_rule' && data.inlineSettings) {
      const violation = findOfflineDurationViolation(data.inlineSettings);
      if (violation) return c.json({ error: violation }, 400);
    }

    if (data.featureType === 'alert_rule' && data.inlineSettings) {
      const parsed = alertRuleInlineSettingsSchema.safeParse(data.inlineSettings);
      if (!parsed.success) {
        return c.json(
          zodValidationErrorBody('Invalid alert_rule settings', parsed.error),
          400
        );
      }
      data.inlineSettings = parsed.data;
    }

    if (data.featureType === 'monitoring' && data.inlineSettings) {
      const parsed = monitoringInlineSettingsSchema.safeParse(data.inlineSettings);
      if (!parsed.success) {
        return c.json(
          zodValidationErrorBody('Invalid monitoring settings', parsed.error),
          400
        );
      }
      // Validate only — deliberately NOT `data.inlineSettings = parsed.data`.
      // The schema defaults the deprecated `alertRules`/`eventLogAlerts` write
      // barrier keys to `[]`, and normalizing would write those dead keys back
      // into the stored JSONB mirror on every save.
    }

    if (data.featureType === 'monitors' && data.inlineSettings) {
      const parsed = monitorsInlineSettingsSchema.safeParse(data.inlineSettings);
      if (!parsed.success) {
        return c.json(
          zodValidationErrorBody('Invalid monitors settings', parsed.error),
          400
        );
      }
      // Two checks, both BEFORE the write. Visibility gets its own specific
      // 400; ownership compatibility is checked here rather than by catching
      // the database's guard, because that guard is a DEFERRABLE INITIALLY
      // DEFERRED constraint trigger and this route already runs inside the
      // middleware's ambient transaction — `addFeatureLink`'s own
      // db.transaction() is a SAVEPOINT whose release never forces the deferred
      // check, so the 23514 would land at the request's commit, after this
      // handler returned (same class as #5580).
      for (const item of parsed.data.items) {
        const monitor = await getMonitorDefinition(item.monitorId, auth);
        if (!monitor) {
          return c.json({ error: 'Unknown monitorId' }, 400);
        }
        if (!(await isMonitorAttachableToPolicy(item.monitorId, id))) {
          return c.json({ error: 'MONITOR_NOT_ATTACHABLE' }, 400);
        }
      }
      data.inlineSettings = parsed.data;
    }

    if (data.featureType === 'hardware_monitoring' && data.inlineSettings) {
      const parsed = hardwareMonitoringInlineSettingsSchema.safeParse(data.inlineSettings);
      if (!parsed.success) {
        return c.json(
          zodValidationErrorBody('Invalid hardware monitoring settings', parsed.error),
          400
        );
      }
      data.inlineSettings = parsed.data;
    }

    // addFeatureLink returns null (instead of throwing) on a duplicate — see the
    // comment on its onConflictDoNothing insert in configurationPolicy.ts for
    // why the raised-violation catch pattern doesn't work inside this route's
    // withDbAccessContext transaction.
    let link;
    try {
      link = await addFeatureLink(
        id,
        data.featureType,
        data.featurePolicyId,
        data.inlineSettings,
        { userId: auth.user.id }
      );
    } catch (error) {
      if (error instanceof AutomationReferenceAuthorizationError) {
        return c.json({ error: 'Unknown or unauthorized automation reference' }, 400);
      }
      if (error instanceof WarrantyConsentError) {
        return c.json({ error: error.message, code: WARRANTY_CONSENT_REFUSAL.code }, 400);
      }
      if (isMonitorNotAttachableDbError(error)) {
        return c.json({ error: 'MONITOR_NOT_ATTACHABLE' }, 400);
      }
      throw error;
    }

    if (!link) {
      return c.json({ error: `Feature type "${data.featureType}" already linked to this policy` }, 409);
    }

    writeRouteAudit(c, {
      orgId: policy.orgId,
      action: 'config_policy.feature_link.add',
      resourceType: 'configuration_policy',
      resourceId: id,
      resourceName: policy.name,
      details: { featureType: data.featureType, featurePolicyId: data.featurePolicyId },
    });

    return c.json(link, 201);
  }
);

// PATCH /:id/features/:linkId — update a feature link
featureLinkRoutes.patch(
  '/:id/features/:linkId',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyWrite,
  requireMfa(),
  zValidator('param', linkIdParamSchema),
  zValidator('json', updateFeatureLinkSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    if (!canMutateOrgWideGovernance(auth)) {
      return c.json({ error: SITE_CEILING_WRITE_DENIED_MESSAGE }, 403);
    }
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

    // Same gate as the POST route (#5511 W02, D4). `data.inlineSettings` is the
    // whole replacement blob (warranty updates are replace, not merge — D5), so
    // the request predicate reads the post-write state directly.
    if (existingLink.featureType === 'warranty' && warrantyHpCmslRequested(data.inlineSettings)) {
      const gate = checkHpCmslWriteAllowed(auth, c.get('permissions') as UserPermissions | undefined);
      if (!gate.allowed) return c.json(gate.body, 403);
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
            zodValidationErrorBody('Invalid patch settings', parsed.error),
            400
          );
        }
        data.inlineSettings = parsed.data;
      }
      if (existingLink.featureType === 'backup') {
        // PATCH may keep the existing profile reference (featurePolicyId
        // omitted) or change/clear it — resolve against the effective value.
        const effectiveFeaturePolicyId =
          data.featurePolicyId !== undefined
            ? data.featurePolicyId
            : existingLink.featurePolicyId;
        const profileLinked = await isBackupProfileReference(effectiveFeaturePolicyId);
        const schema = profileLinked
          ? backupProfileLinkedInlineSettingsSchema
          : backupInlineSettingsSchema;
        const parsed = schema.safeParse(data.inlineSettings);
        if (!parsed.success) {
          return c.json(
            zodValidationErrorBody('Invalid backup settings', parsed.error),
            400
          );
        }
        data.inlineSettings = parsed.data;
      }
      if (existingLink.featureType === 'pam') {
        const parsed = pamInlineSettingsSchema.safeParse(data.inlineSettings);
        if (!parsed.success) {
          return c.json(
            zodValidationErrorBody('Invalid pam settings', parsed.error),
            400
          );
        }
        data.inlineSettings = parsed.data;
      }
      // #6312 — same gate on the update site; see the POST branch above.
      if (existingLink.featureType === 'maintenance') {
        const parsed = maintenanceInlineSettingsSchema.safeParse(data.inlineSettings);
        if (!parsed.success) {
          return c.json(
            zodValidationErrorBody('Invalid maintenance settings', parsed.error),
            400
          );
        }
        data.inlineSettings = parsed.data;
      }
      if (existingLink.featureType === 'device_lifecycle') {
        const parsed = deviceLifecycleInlineSettingsSchema.safeParse(data.inlineSettings);
        if (!parsed.success) {
          return c.json(
            zodValidationErrorBody('Invalid device lifecycle settings', parsed.error),
            400
          );
        }
        data.inlineSettings = parsed.data;
      }
      if (existingLink.featureType === 'warranty') {
        // Same ordering and reasoning as the POST route above (#5511 W02, D3).
        if (clientSuppliedWarrantyHpCmslConsent(data.inlineSettings)) {
          return c.json(WARRANTY_CONSENT_REFUSAL, 400);
        }
        const parsed = warrantyInlineSettingsSchema.safeParse(data.inlineSettings);
        if (!parsed.success) {
          return c.json(
            zodValidationErrorBody('Invalid warranty settings', parsed.error),
            400
          );
        }
        data.inlineSettings = parsed.data;
      }
      if (existingLink.featureType === 'remote_access') {
        const parsed = remoteAccessInlineSettingsSchema.safeParse(data.inlineSettings);
        if (!parsed.success) {
          return c.json(
            zodValidationErrorBody('Invalid remote access settings', parsed.error),
            400
          );
        }
        const rangeError = remoteAccessWriteRangeError(parsed.data);
        if (rangeError) return c.json({ error: rangeError }, 400);
        data.inlineSettings = parsed.data;
      }
      if (existingLink.featureType === 'onedrive_helper') {
        const parsed = onedriveHelperInlineSettingsSchema.safeParse(data.inlineSettings);
        if (!parsed.success) {
          return c.json(
            zodValidationErrorBody('Invalid onedrive_helper settings', parsed.error),
            400
          );
        }
        data.inlineSettings = parsed.data;
      }
      // Reject offline alert rules whose duration exceeds the re-eval horizon —
      // such a rule could never fire (issue #1982). Runs before the schema parse
      // so the specific message wins (same ordering as the POST route).
      if (existingLink.featureType === 'alert_rule') {
        const violation = findOfflineDurationViolation(data.inlineSettings);
        if (violation) return c.json({ error: violation }, 400);

        const parsed = alertRuleInlineSettingsSchema.safeParse(data.inlineSettings);
        if (!parsed.success) {
          return c.json(
            zodValidationErrorBody('Invalid alert_rule settings', parsed.error),
            400
          );
        }
        data.inlineSettings = parsed.data;
      }
      if (existingLink.featureType === 'monitoring') {
        const parsed = monitoringInlineSettingsSchema.safeParse(data.inlineSettings);
        if (!parsed.success) {
          return c.json(
            zodValidationErrorBody('Invalid monitoring settings', parsed.error),
            400
          );
        }
        // Validate only — see the POST route for why parsed.data isn't written back.
      }
      if (existingLink.featureType === 'monitors') {
        const parsed = monitorsInlineSettingsSchema.safeParse(data.inlineSettings);
        if (!parsed.success) {
          return c.json(
            zodValidationErrorBody('Invalid monitors settings', parsed.error),
            400
          );
        }
        // See the POST handler for why attachability is pre-checked rather
        // than caught from the deferred trigger.
        for (const item of parsed.data.items) {
          const monitor = await getMonitorDefinition(item.monitorId, auth);
          if (!monitor) {
            return c.json({ error: 'Unknown monitorId' }, 400);
          }
          if (!(await isMonitorAttachableToPolicy(item.monitorId, id))) {
            return c.json({ error: 'MONITOR_NOT_ATTACHABLE' }, 400);
          }
        }
        data.inlineSettings = parsed.data;
      }
      if (existingLink.featureType === 'hardware_monitoring') {
        const parsed = hardwareMonitoringInlineSettingsSchema.safeParse(data.inlineSettings);
        if (!parsed.success) {
          return c.json(
            zodValidationErrorBody('Invalid hardware monitoring settings', parsed.error),
            400
          );
        }
        data.inlineSettings = parsed.data;
      }
    }

    let updated;
    try {
      updated = await updateFeatureLink(linkId, data, id, { userId: auth.user.id });
    } catch (error) {
      if (error instanceof AutomationReferenceAuthorizationError) {
        return c.json({ error: 'Unknown or unauthorized automation reference' }, 400);
      }
      if (error instanceof WarrantyConsentError) {
        return c.json({ error: error.message, code: WARRANTY_CONSENT_REFUSAL.code }, 400);
      }
      if (isMonitorNotAttachableDbError(error)) {
        return c.json({ error: 'MONITOR_NOT_ATTACHABLE' }, 400);
      }
      throw error;
    }
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
  requireMfa(),
  zValidator('param', linkIdParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    if (!canMutateOrgWideGovernance(auth)) {
      return c.json({ error: SITE_CEILING_WRITE_DENIED_MESSAGE }, 403);
    }
    const { id, linkId } = c.req.valid('param');

    const policy = await getConfigPolicy(id, auth);
    if (!policy) return c.json({ error: 'Configuration policy not found' }, 404);

    // Same all-orgs blast radius as the POST/PATCH gates above.
    if (policy.orgId === null && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    const existingLink = policy.featureLinks.find((l: any) => l.id === linkId);
    if (!existingLink) return c.json({ error: 'Feature link not found' }, 404);

    // #5511 W02 (contract D4/D5): deleting a warranty link is normally a pure
    // revocation and stays ungated — but with a parent that COLLECTS, this
    // delete does not end collection, it reverts to the parent's link and
    // starts it. Fails CLOSED when the parent is set but could not be resolved
    // (`parentPolicy` null): "can't tell" must not read as "no parent".
    const parentUnresolved = !!policy.parentPolicyId && !policy.parentPolicy;
    const revertStartsHpCmslCollection = existingLink.featureType === 'warranty'
      && (parentUnresolved || warrantyLinkEnablesCollection(policy.parentPolicy?.featureLinks));
    if (revertStartsHpCmslCollection) {
      const gate = checkHpCmslWriteAllowed(auth, c.get('permissions') as UserPermissions | undefined);
      if (!gate.allowed) return c.json(gate.body, 403);
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

    return c.json(deleted.kept ? { success: true, kept: true, reason: deleted.reason } : { success: true });
  }
);

/**
 * Write-time range check for `maxSessionDurationHours`.
 *
 * Deliberately NOT expressed in the shared Zod schema
 * (`remoteAccessInlineSettingsSchema` stays `min(0).max(168)`): a parse failure
 * there discards the WHOLE settings blob — the resolver falls back to DEFAULTS,
 * `configurationPolicy.ts` throws, and these routes 400 — so tightening it
 * would turn every legacy policy that stored `0` into a silent re-enable of
 * every other remote-access gate the policy meant to close. Reads clamp
 * (`clampSettings`); only WRITES are refused, so an author cannot store a new
 * out-of-range value.
 */
function remoteAccessWriteRangeError(
  settings: { maxSessionDurationHours?: number } | undefined,
): string | null {
  const value = settings?.maxSessionDurationHours;
  if (value === undefined) return null;
  if (
    !Number.isInteger(value)
    || value < MIN_MAX_SESSION_DURATION_HOURS
    || value > MAX_MAX_SESSION_DURATION_HOURS
  ) {
    return (
      `maxSessionDurationHours must be a whole number of hours between `
      + `${MIN_MAX_SESSION_DURATION_HOURS} and ${MAX_MAX_SESSION_DURATION_HOURS}. `
      + 'Remote desktop sessions are capped at 12 hours and "unlimited" (0) is no longer supported.'
    );
  }
  return null;
}
