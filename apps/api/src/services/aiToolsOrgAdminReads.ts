/**
 * Org admin read tools (full-control W18, #6789): `get_org_summary`,
 * `get_account_readiness`, `get_audit_retention`, `list_portal_users`.
 *
 * Tier 1 and read-only. Each is a thin adapter over the shared operation its
 * REST route calls, with that route's own gates:
 *  - summary, readiness and portal users are partner (or system) reads, so
 *    organization scope is refused; the per-section grants come from the
 *    caller's live permission set, exactly as `c.get('permissions')` on REST;
 *  - a missing, deleted and inaccessible org are one NOT_FOUND answer (summary,
 *    portal users, audit retention); readiness lists such requested ids under
 *    `notFound` instead, without saying which reason applied;
 *  - summary, readiness and portal users describe whole organizations, so a
 *    session bound to specific devices is refused (stricter than REST).
 * Only `get_audit_retention` is agent-reachable (W18 plan, agent exposure).
 */
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { aiCallerGrantCheck } from './aiToolCallerPermissions';
import { getOrgAuditRetentionPolicy } from './auditRetentionPolicyService';
import { buildAccountReadinessResponse, listDefaultReadinessOrgIds } from './orgAccountReadinessResponse';
import { canAccessOrgAuditRetention } from './orgAuditRetentionAccess';
import { resolveOrgSummary } from './orgSummary';
import { listPortalUsersForCaller } from './portalUserDirectory';
import { ACCOUNT_READINESS_TOOL_MAX_ORGS, orgAdminToolSchemas } from './aiToolSchemasOrgAdmin';
import {
  bounded,
  capped,
  deviceBoundDenied,
  jsonError,
  notFound,
  orgAdminInputSchema,
  parseInput,
  partnerScopeDenied,
  thrown,
} from './aiToolsOrgAdminShared';

/** The readiness partner: the caller's own, or the one a system caller names. */
function readinessPartner(auth: AuthContext, requested: string | undefined): { partnerId: string } | { refusal: string } {
  if (auth.scope === 'system') {
    return requested ? { partnerId: requested } : { refusal: jsonError('partnerId is required for system scope', 'VALIDATION_ERROR') };
  }
  if (!auth.partnerId) return { refusal: jsonError('Partner context required', 'PARTNER_SCOPE_REQUIRED') };
  // REST ignores a partner token's `partnerId` query; the tool refuses a
  // foreign one rather than silently answering for the caller's own partner.
  if (requested && requested !== auth.partnerId) return { refusal: jsonError('Access to this partner denied', 'FORBIDDEN') };
  return { partnerId: auth.partnerId };
}

export function registerOrgAdminReadTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('get_org_summary', {
    tier: 1,
    domain: 'accounts',
    searchHint: 'customer overview: device, alert, ticket, contract and invoice counts, primary contact, last activity',
    deviceArgs: [],
    definition: {
      name: 'get_org_summary',
      description:
        "One organization at a glance: devices online, open alerts and tickets, active contracts, outstanding invoices, sites, primary contact, portal users and last activity. Sections you lack permission for are omitted. Partner scope.",
      input_schema: orgAdminInputSchema(orgAdminToolSchemas.get_org_summary),
    },
    handler: async (input, auth) => {
      const denied = partnerScopeDenied(auth, 'An organization summary') ?? deviceBoundDenied(auth, 'An organization summary');
      if (denied) return denied;
      const parsed = parseInput(orgAdminToolSchemas.get_org_summary, input);
      if (!parsed.ok) return parsed.error;
      try {
        const can = await aiCallerGrantCheck(auth);
        const summary = await resolveOrgSummary(auth, parsed.value.orgId, can);
        return summary ? bounded(summary) : notFound('Organization');
      } catch (error) {
        return thrown('get_org_summary', error);
      }
    },
  });

  aiTools.set('get_account_readiness', {
    tier: 1,
    domain: 'accounts',
    searchHint: 'which customers are not fully set up: missing contacts, billing address, policies, pending portal invites',
    deviceArgs: [],
    definition: {
      name: 'get_account_readiness',
      description:
        'Setup readiness for up to 50 organizations: sites, devices, policy, primary and billing contacts, billing address, pending portal invites, overdue invoices, integrations, backup. Omit orgIds for your first 50 by name (truncated says more exist); unreachable ids are listed in notFound. Partner scope.',
      input_schema: orgAdminInputSchema(orgAdminToolSchemas.get_account_readiness),
    },
    handler: async (input, auth) => {
      const denied = partnerScopeDenied(auth, 'Account readiness') ?? deviceBoundDenied(auth, 'Account readiness');
      if (denied) return denied;
      const parsed = parseInput(orgAdminToolSchemas.get_account_readiness, input);
      if (!parsed.ok) return parsed.error;
      const partner = readinessPartner(auth, parsed.value.partnerId);
      if ('refusal' in partner) return partner.refusal;
      // A partner token whose list never resolved gets nothing, not everything (same rule as REST).
      const accessibleOrgIds = auth.scope === 'system' ? null : (auth.accessibleOrgIds ?? []);
      try {
        let orgIds: string[];
        let truncated = false;
        if (parsed.value.orgIds) {
          orgIds = Array.from(new Set(parsed.value.orgIds.map((id) => id.toLowerCase())));
        } else {
          const defaults = await listDefaultReadinessOrgIds({
            partnerId: partner.partnerId,
            accessibleOrgIds,
            limit: ACCOUNT_READINESS_TOOL_MAX_ORGS,
          });
          orgIds = defaults.orgIds;
          truncated = defaults.truncated;
        }
        const can = await aiCallerGrantCheck(auth);
        const response = await buildAccountReadinessResponse({ partnerId: partner.partnerId, orgIds, accessibleOrgIds, can });
        // A requested org that is missing, deleted, hidden or outside the caller's reach is dropped by
        // resolveAcceptedOrgs; say so, one undifferentiated list, rather than answer as if it were not asked about.
        const returned = new Set(response.orgs.map((org) => org.orgId));
        const notFound = parsed.value.orgIds ? orgIds.filter((id) => !returned.has(id)) : [];
        return bounded({ ...response, truncated, ...(notFound.length > 0 ? { notFound } : {}) });
      } catch (error) {
        return thrown('get_account_readiness', error);
      }
    },
  });

  aiTools.set('get_audit_retention', {
    tier: 1,
    domain: 'security',
    searchHint: 'how long audit logs are kept for an organization; audit log retention days and last cleanup',
    deviceArgs: [],
    definition: {
      name: 'get_audit_retention',
      description:
        "An organization's audit-log retention policy: whether one is configured, the retention in days, and when old entries were last pruned. Read-only.",
      input_schema: orgAdminInputSchema(orgAdminToolSchemas.get_audit_retention),
    },
    handler: async (input, auth) => {
      const parsed = parseInput(orgAdminToolSchemas.get_audit_retention, input);
      if (!parsed.ok) return parsed.error;
      const orgId = parsed.value.orgId ?? (auth.scope === 'organization' ? auth.orgId : null);
      if (!orgId) return jsonError('orgId is required', 'VALIDATION_ERROR');
      try {
        if (!(await canAccessOrgAuditRetention(auth, orgId))) return notFound('Organization');
        return bounded(await getOrgAuditRetentionPolicy(orgId));
      } catch (error) {
        return thrown('get_audit_retention', error);
      }
    },
  });

  aiTools.set('list_portal_users', {
    tier: 1,
    domain: 'accounts',
    searchHint: 'customer portal logins for an organization: who has portal access, invited, pending setup, disabled',
    deviceArgs: [],
    definition: {
      name: 'list_portal_users',
      description:
        "An organization's customer-portal logins (newest first; 50 by default, up to 100): name, email, status (active, pending setup, disabled), notifications, last login, invited date. Not Breeze staff logins (list_users). Partner scope.",
      input_schema: orgAdminInputSchema(orgAdminToolSchemas.list_portal_users),
    },
    handler: async (input, auth) => {
      const denied = partnerScopeDenied(auth, 'Portal users') ?? deviceBoundDenied(auth, 'Portal users');
      if (denied) return denied;
      const parsed = parseInput(orgAdminToolSchemas.list_portal_users, input);
      if (!parsed.ok) return parsed.error;
      try {
        const rows = await listPortalUsersForCaller(auth, parsed.value.orgId);
        if (!rows) return notFound('Organization');
        const page = capped(rows, parsed.value.limit ?? 50);
        return bounded({ data: page.rows, showing: page.showing, total: page.total, truncated: page.truncated });
      } catch (error) {
        return thrown('list_portal_users', error);
      }
    },
  });
}
