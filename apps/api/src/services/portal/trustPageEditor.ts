// Trust Center W3d (#8771): who may edit the org's trust page draft from the
// customer portal (plan Open Decision 1). Two conditions, both read fresh on
// every call and never cached in the session (precedent: decideApprovalRequest
// re-reads portal_users):
//   1. portal_branding.enable_trust_page_editing is true for the org (MSP
//      controlled, fail closed: a missing row is off), and
//   2. the portal user is active and its contact holds an ORGANIZATION-scoped
//      `admin` responsibility in contact_roles (site_id and device_group_id
//      both NULL, same org) — the same org-scoped reading the ticket approval
//      code applies to `billing` (ticketApproval/requests.ts resolveRecipients).
// A login without a contact (Entra JIT, Outlook add-in) is never an admin.
// Runs under the request's org-scoped db context (portalAuthMiddleware), so
// RLS also confines both reads to the portal user's org.
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { contactRoles, portalBranding, portalUsers } from '../../db/schema';

export const PORTAL_TRUST_EDITING_DISABLED = 'PORTAL_TRUST_EDITING_DISABLED' as const;
export const PORTAL_TRUST_EDITOR_REQUIRED = 'PORTAL_TRUST_EDITOR_REQUIRED' as const;

export type PortalTrustEditorUser = { id: string; orgId: string };
export type PortalTrustEditorDecision =
  | { allowed: true; contactId: string }
  | { allowed: false; code: typeof PORTAL_TRUST_EDITING_DISABLED | typeof PORTAL_TRUST_EDITOR_REQUIRED };

export async function decidePortalTrustPageEditor(user: PortalTrustEditorUser): Promise<PortalTrustEditorDecision> {
  const [row] = await db
    .select({ flag: portalBranding.enableTrustPageEditing, status: portalUsers.status, contactId: portalUsers.contactId })
    .from(portalUsers)
    .leftJoin(portalBranding, eq(portalBranding.orgId, portalUsers.orgId))
    .where(and(eq(portalUsers.id, user.id), eq(portalUsers.orgId, user.orgId)))
    .limit(1);
  if (row?.flag !== true) return { allowed: false, code: PORTAL_TRUST_EDITING_DISABLED };
  if (row.status !== 'active' || !row.contactId) return { allowed: false, code: PORTAL_TRUST_EDITOR_REQUIRED };

  const roles = await db
    .select({ orgId: contactRoles.orgId, siteId: contactRoles.siteId, deviceGroupId: contactRoles.deviceGroupId })
    .from(contactRoles)
    .where(and(eq(contactRoles.contactId, row.contactId), eq(contactRoles.orgId, user.orgId), eq(contactRoles.role, 'admin')));
  // The scope and org are re-checked here, not only in SQL: a site- or group-scoped
  // admin does not speak for the organization.
  const orgAdmin = roles.some((r) => r.orgId === user.orgId && r.siteId == null && r.deviceGroupId == null);
  return orgAdmin ? { allowed: true, contactId: row.contactId } : { allowed: false, code: PORTAL_TRUST_EDITOR_REQUIRED };
}

export async function isPortalTrustPageEditor(user: PortalTrustEditorUser): Promise<boolean> {
  return (await decidePortalTrustPageEditor(user)).allowed;
}
