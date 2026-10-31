/**
 * `get_partner_settings_inheritance` (#9763): the AI twin of
 * GET /orgs/partners/me/settings-inheritance (per-field org counts for one
 * partner settings tab) and GET /orgs/partners/me/settings-inheritance/orgs
 * (the orgs behind one count). Answers "which orgs override this partner
 * setting, and to what?" (spec 2026-10-18 §5.6).
 *
 * Same gate as the routes (routes/partnerSettingsInheritance.ts): partner
 * scope (system scope excluded), a partner context, `organizations:read`
 * (TOOL_PERMISSIONS in aiGuardrails.ts) and full partner org access
 * (`canManagePartnerWidePolicies`). Stricter than REST in one way: a
 * device-restricted run is refused, since the answer spans every org.
 *
 * Same projection as the routes: both services are called unchanged and own
 * the secret handling (a sealed field leaves as `{ set }` only, its override
 * count as null). Reads run in the caller's DB context, so RLS bounds the rows.
 */
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { canManagePartnerWidePolicies, PARTNER_WIDE_READ_DENIED_MESSAGE } from './partnerWideAccess';
import { isRestrictedCaller } from './aiToolsNetworkMonitoringShared';
import {
  PARTNER_SETTINGS_INHERITANCE_BUCKETS,
  PARTNER_SETTINGS_INHERITANCE_MAX_LIMIT,
  partnerSettingsInheritanceInputSchema,
} from './aiToolSchemasPartnerSettingsInheritance';
import {
  aggregateTab,
  InheritanceBadRequest,
  InheritanceNotFound,
  type InheritanceContext,
} from './partnerSettingsInheritance/aggregate';
import { listFieldOrgs } from './partnerSettingsInheritance/drilldown';
import { CATALOG_TAB_KEYS } from '@breeze/shared';
import { captureException } from './sentry';

const TOOL = 'get_partner_settings_inheritance';

const jsonError = (error: string, code?: string) => JSON.stringify(code ? { error, code } : { error });

/** The routes' chain (requireScope('partner') → requirePartner → requirePartnerWideRead), as one answer. */
function gate(auth: AuthContext): InheritanceContext | string {
  if (auth.scope !== 'partner' || !auth.partnerId) return jsonError('Partner context required', 'ACCESS_DENIED');
  if (!canManagePartnerWidePolicies(auth)) return jsonError(PARTNER_WIDE_READ_DENIED_MESSAGE, 'PARTNER_WIDE_REQUIRED');
  if (isRestrictedCaller(auth)) {
    return jsonError('The organization breakdown spans every organization; a device-restricted session cannot read it', 'ACCESS_DENIED');
  }
  return { partnerId: auth.partnerId, accessibleOrgIds: auth.accessibleOrgIds };
}

export function registerPartnerSettingsInheritanceTools(aiTools: Map<string, AiTool>): void {
  aiTools.set(TOOL, {
    tier: 1,
    domain: 'accounts',
    searchHint: 'which organizations override or inherit a partner-wide setting, and their own values',
    deviceArgs: [],
    definition: {
      name: TOOL,
      description:
        'Which organizations override a partner setting. tab: per-setting counts of orgs with their own value, overriding, or shadowed. field (an id from a tab result): the orgs behind one count and their values; secrets show set/not set only. Full partner org access only.',
      input_schema: {
        type: 'object' as const,
        properties: {
          tab: { type: 'string', enum: [...CATALOG_TAB_KEYS], description: 'Partner settings tab to summarize (omit when field is set)' },
          field: { type: 'string', description: 'Setting id from a tab result, e.g. defaults.defaultEnrollmentTtlMinutes (omit when tab is set)' },
          bucket: { type: 'string', enum: [...PARTNER_SETTINGS_INHERITANCE_BUCKETS], description: 'field: which count to list (default ownValue)' },
          cursor: { type: 'string', description: 'field: nextCursor from the previous page' },
          limit: { type: 'number', description: `Max organizations per page, with field (default ${PARTNER_SETTINGS_INHERITANCE_MAX_LIMIT}, max ${PARTNER_SETTINGS_INHERITANCE_MAX_LIMIT})` },
        },
        additionalProperties: false,
      },
    },
    handler: async (input: Record<string, unknown>, auth: AuthContext) => {
      const ctx = gate(auth);
      if (typeof ctx === 'string') return ctx;
      // Dispatch already validated against this schema (validateToolInput); re-parse so a direct caller cannot skip it.
      const parsed = partnerSettingsInheritanceInputSchema.safeParse(input);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const path = issue?.path.length ? `${issue.path.join('.')}: ` : '';
        return jsonError(`Invalid input: ${path}${issue?.message ?? 'invalid'}`);
      }
      const { tab, field, bucket, cursor, limit } = parsed.data;
      try {
        if (tab !== undefined) return JSON.stringify({ data: await aggregateTab(tab, ctx) });
        const page = { bucket: bucket ?? 'ownValue', cursor: cursor ?? null, limit: limit ?? PARTNER_SETTINGS_INHERITANCE_MAX_LIMIT };
        return JSON.stringify({ data: await listFieldOrgs(field!, ctx, page) });
      } catch (err) {
        // The routes map these to 404 / 400 with the same message.
        if (err instanceof InheritanceNotFound || err instanceof InheritanceBadRequest) return jsonError(err.message);
        console.error(`[${TOOL}]`, err);
        captureException(err, undefined, { tool: TOOL });
        return jsonError('Operation failed. Check server logs for details.');
      }
    },
  });
}
