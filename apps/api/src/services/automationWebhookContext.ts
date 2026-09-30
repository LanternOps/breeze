import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { db, type DbAccessContext } from '../db';
import { organizations } from '../db/schema';
import { getActiveOrgTenant, getActivePartner } from './tenantStatus';
import { UNASSIGNED_POOL_ORG_TYPE } from './unassignedPool/orgType';

/**
 * #7363 — the RLS context an anonymous automation webhook runs its writes
 * under, once the webhook secret has been verified.
 *
 * The webhook route has no auth user, so nothing else supplies a tenant
 * context. It must NOT stay in system scope past the automation lookup: the
 * run is created as the automation's OWNER, in the same shape `authMiddleware`
 * builds for a user of that owner triggering the automation by hand, so the
 * run admission (target devices, referenced scripts and channels) sees exactly
 * what a manual trigger would and nothing more.
 *
 * - Org-owned: organization scope over that one org. Like an API key (a
 *   machine credential issued by the tenant, `apiKeyAuth` → `getActiveOrgTenant`),
 *   the org must be active/trial and its partner strictly active.
 * - Partner-wide (org_id NULL): partner scope over the partner's active/trial,
 *   non-deleted customer orgs (never the holding or quick-support org), with
 *   partner-axis access to the partner.
 *   The partner must be strictly active.
 *
 * Returns null when the owner is not active; the caller refuses the webhook.
 *
 * Reads organizations/partners under system scope (the tenant-status helpers
 * escalate on their own; the partner org list needs the caller's system
 * context). The webhook route calls it inside its read-only system lookup.
 */
export async function resolveAutomationWebhookOwnerContext(
  automation: { orgId: string | null; partnerId: string | null },
): Promise<DbAccessContext | null> {
  if (automation.orgId) {
    const tenant = await getActiveOrgTenant(automation.orgId);
    if (!tenant) return null;
    return {
      scope: 'organization',
      orgId: tenant.orgId,
      accessibleOrgIds: [tenant.orgId],
      accessiblePartnerIds: [],
      currentPartnerId: tenant.partnerId,
      userId: null,
      label: 'automations.webhook',
    };
  }

  if (automation.partnerId) {
    const partner = await getActivePartner(automation.partnerId);
    if (!partner) return null;
    const orgRows = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(
        eq(organizations.partnerId, partner.id),
        inArray(organizations.status, ['active', 'trial']),
        isNull(organizations.deletedAt),
        // Neither the quick-support org nor the holding org is a customer
        // tenant a partner-wide automation targets (automationOwnerOrgIds
        // leaves both out too).
        ne(organizations.type, 'quick_support'),
        ne(organizations.type, UNASSIGNED_POOL_ORG_TYPE),
      ));
    return {
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: orgRows.map((row) => row.id),
      accessiblePartnerIds: [partner.id],
      currentPartnerId: partner.id,
      userId: null,
      label: 'automations.webhook',
    };
  }

  // The one-owner CHECK makes this unreachable.
  return null;
}
