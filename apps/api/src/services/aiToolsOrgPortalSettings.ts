/**
 * `manage_org_portal_settings` (full-control W18 PR B, #6789): an organization's
 * customer-portal settings, the AI twin of `GET/PATCH
 * /organizations/:id/portal-settings` over the same service
 * (orgPortalSettingsService.ts). Another door to the same row the org Branding
 * tab edits: no new setting.
 *
 * Classes (aiGuardrails.ts, W18 plan class review):
 *  - `get` is a tier-1 read.
 *  - `update` is supervised: customers see the change at once. It never takes
 *    customCss (served verbatim to customer browsers, Decision 3) or a sensitive
 *    or permission flag, and it is refused when enabling a parent gate would
 *    activate a sensitive child that is already on (checked under the row lock).
 *  - `set_sensitive_access` is four-eyes with a mandatory effect digest over the
 *    requested flags and the row's current sensitive, permission and parent
 *    values: per-host CVE, patch and rack data a customer has seen cannot be
 *    recalled (Decision 2). A parent it enables may not activate a child the
 *    same call does not name, so the approval card lists everything that opens.
 *
 * Partner or system scope, as REST. Agent-human-only (`AGENT_HUMAN_ONLY_TOOLS`);
 * the org-wide row is refused to a device-bound session.
 */
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { mfaGatedToolError } from './aiToolMfaGate';
import { ORG_PORTAL_SETTINGS_ACTIONS, orgAdminWriteToolSchemas, portalSensitiveFlagsSchema, portalSettingsToolUpdateSchema } from './aiToolSchemasOrgAdminWrites';
import { applyOrgPortalSettings, findPortalSettingsOrg, getOrgPortalSettings, type PortalSettingsPatch } from './orgPortalSettingsService';
import { auditToolWrite, bounded, deviceBoundDenied, json, jsonError, notFound, thrown } from './aiToolsSecurityPolicyShared';
import { agentRefusal, isAgentPrincipal } from './aiToolsTicketOpsShared';
import { orgAdminInputSchema, partnerScopeDenied } from './aiToolsOrgAdminShared';

type Action = (typeof ORG_PORTAL_SETTINGS_ACTIONS)[number];

const TOOL = 'manage_org_portal_settings';
const WHAT = "An organization's portal settings";

function firstIssue(prefix: string, error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  const issue = error.issues[0];
  const where = issue?.path.length ? `${prefix}.${issue.path.join('.')}` : prefix;
  return `${where}: ${issue?.message ?? 'Invalid input'}`;
}

/** The action's own body, validated, or the refusal. Each write takes exactly one of settings / flags. */
function writeBody(action: 'update' | 'set_sensitive_access', input: Record<string, unknown>): { body: PortalSettingsPatch } | { error: string } {
  const own = action === 'update' ? 'settings' : 'flags';
  const other = action === 'update' ? 'flags' : 'settings';
  if (input[other] !== undefined) {
    return { error: jsonError(`${action} takes ${own}, not ${other}${action === 'update' ? ' (sensitive flags: set_sensitive_access)' : ''}`, 'VALIDATION_ERROR') };
  }
  const parsed = (action === 'update' ? portalSettingsToolUpdateSchema : portalSensitiveFlagsSchema).safeParse(input[own]);
  if (!parsed.success) {
    const hint = action === 'update' ? ' (customCss is edited on the Branding tab; sensitive flags need set_sensitive_access)' : '';
    return { error: jsonError(`${firstIssue(own, parsed.error)}${hint}`, 'VALIDATION_ERROR') };
  }
  if (Object.keys(parsed.data).length === 0) return { error: jsonError(`${own} must name at least one field`, 'VALIDATION_ERROR') };
  return { body: parsed.data as PortalSettingsPatch };
}

async function write(auth: AuthContext, action: 'update' | 'set_sensitive_access', orgId: string, input: Record<string, unknown>): Promise<string> {
  const parsed = writeBody(action, input);
  if ('error' in parsed) return parsed.error;
  const org = await findPortalSettingsOrg(auth, orgId);
  if (!org) return notFound('Organization');

  const changedFields = Object.keys(parsed.body);
  const result = await applyOrgPortalSettings(org.id, parsed.body, auth.user.id, {
    refuseSensitiveActivation: true,
    // Audited once the row is written, before the report-provisioning hook (the route's order).
    onPersisted: () => auditToolWrite(auth, {
      orgId: org.id,
      action: 'organization.portal_settings.update',
      resourceType: 'organization',
      resourceId: org.id,
      details: { changedFields, ...(action === 'set_sensitive_access' ? { sensitive: true } : {}) },
    }),
  });
  if (!result.ok) {
    if (result.code === 'SENSITIVE_ACTIVATION') {
      const fix = action === 'update'
        ? 'Use set_sensitive_access and name each of those flags'
        : 'Add each of those flags to flags';
      return jsonError(
        `Turning this on would also show portal users data whose own flag is already on: ${result.children.join(', ')}. `
        + `${fix} (true to show it, false to keep it hidden).`,
        'SENSITIVE_ACTIVATION',
      );
    }
    return jsonError('Failed to persist portal settings', 'PERSIST_FAILED');
  }
  return json({ updated: true, changedFields, settings: result.settings });
}

export function registerOrgPortalSettingsTool(aiTools: Map<string, AiTool>): void {
  aiTools.set(TOOL, {
    tier: 1,
    domain: 'accounts',
    searchHint: 'customer portal settings: which portal sections customers see, support contact, welcome text, logo and colours',
    deviceArgs: [],
    definition: {
      name: TOOL,
      description:
        "An organization's customer portal settings. get; update (settings: sections, contact, text, colours; customers see it at once); set_sensitive_access (flags: patch, CVE, rack, hours, network alerts, trust page editing; two approvers). Partner scope.",
      input_schema: orgAdminInputSchema(orgAdminWriteToolSchemas.manage_org_portal_settings),
    },
    handler: async (input, auth) => {
      const action = input.action as Action;
      if (!ORG_PORTAL_SETTINGS_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`, 'VALIDATION_ERROR');
      if (isAgentPrincipal(auth)) return agentRefusal(action);
      const denied = partnerScopeDenied(auth, WHAT) ?? deviceBoundDenied(auth, WHAT) ?? mfaGatedToolError(TOOL, action, auth);
      if (denied) return denied;
      const orgId = typeof input.orgId === 'string' ? input.orgId : '';
      if (!orgAdminWriteToolSchemas.manage_org_portal_settings.shape.orgId.safeParse(orgId).success) {
        return jsonError('orgId is required and must be an organization UUID', 'VALIDATION_ERROR');
      }
      try {
        if (action === 'get') {
          const org = await findPortalSettingsOrg(auth, orgId);
          if (!org) return notFound('Organization');
          return bounded({ settings: await getOrgPortalSettings(org) });
        }
        return await write(auth, action, orgId, input);
      } catch (error) {
        return thrown(TOOL, error);
      }
    },
  });
}
