import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, desc } from 'drizzle-orm';
import { db } from '../db';
import { organizations, portalUsers } from '../db/schema';
import { requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { getEmailService } from '../services/email';
import { storePortalInviteToken, buildPortalUrl } from './portal/helpers';
import { invitePortalUserSchema } from '@breeze/shared';

// MSP-facing customer-portal user management (portal_users). List + invite
// only — bulk-invite/update/disable ship in Task 7 on this same file.
// Mirrors routes/orgPortalSettings.ts for gating: partner|system scope,
// ORGS_READ/ORGS_WRITE permission, requireMfa() on the write, and a
// module-local resolveAccessibleOrg (duplicated rather than shared, per
// the pattern established there).

type PortalUserListRow = {
  id: string;
  email: string;
  name: string | null;
  passwordHash: string | null;
  status: string;
  receiveNotifications: boolean;
  lastLoginAt: Date | null;
  invitedAt: Date | null;
};

// A portal user is 'active' only once they've actually set a password
// (accepted their invite) AND aren't administratively disabled. Rows
// created by an invite sit in DB status 'invited' with passwordHash
// null — those must read back as 'pending_setup', not 'active'.
export function effectivePortalStatus(row: { status: string; passwordHash: string | null }): 'active' | 'disabled' | 'pending_setup' {
  if (row.status === 'disabled') return 'disabled';
  if (!row.passwordHash) return 'pending_setup';
  return 'active';
}

function toListItem(row: PortalUserListRow) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    effectiveStatus: effectivePortalStatus(row),
    receiveNotifications: row.receiveNotifications,
    lastLoginAt: row.lastLoginAt,
    invitedAt: row.invitedAt
  };
}

async function resolveAccessibleOrg(c: any): Promise<{ id: string } | Response> {
  const auth = c.get('auth') as AuthContext;
  const id = c.req.param('id')!;
  if (auth.scope === 'partner' && !auth.canAccessOrg(id)) {
    return c.json({ error: 'Organization not found' }, 404);
  }
  const rows = await db.select({ id: organizations.id }).from(organizations)
    .where(and(eq(organizations.id, id), isNull(organizations.deletedAt))).limit(1);
  if (!rows[0]) return c.json({ error: 'Organization not found' }, 404);
  return { id };
}

export function registerOrgPortalUsersRoutes(orgRoutes: Hono) {
  const requireOrgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
  const requireOrgWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);

  orgRoutes.get('/organizations/:id/portal-users', requireScope('partner', 'system'), requireOrgRead, async (c) => {
    const org = await resolveAccessibleOrg(c);
    if (org instanceof Response) return org;
    const rows = await db.select({
      id: portalUsers.id,
      email: portalUsers.email,
      name: portalUsers.name,
      passwordHash: portalUsers.passwordHash,
      status: portalUsers.status,
      receiveNotifications: portalUsers.receiveNotifications,
      lastLoginAt: portalUsers.lastLoginAt,
      invitedAt: portalUsers.invitedAt
    }).from(portalUsers).where(eq(portalUsers.orgId, org.id)).orderBy(desc(portalUsers.createdAt));
    return c.json({ data: rows.map(toListItem) });
  });

  orgRoutes.post('/organizations/:id/portal-users/invite', requireScope('partner', 'system'), requireOrgWrite, requireMfa(), zValidator('json', invitePortalUserSchema), async (c) => {
    const org = await resolveAccessibleOrg(c);
    if (org instanceof Response) return org;
    const auth = c.get('auth') as AuthContext;
    const { email, name, message } = c.req.valid('json');
    const normalizedEmail = email.trim().toLowerCase();

    const [existing] = await db.select({ id: portalUsers.id, email: portalUsers.email, passwordHash: portalUsers.passwordHash, status: portalUsers.status })
      .from(portalUsers).where(and(eq(portalUsers.orgId, org.id), eq(portalUsers.email, normalizedEmail))).limit(1);

    if (existing && existing.passwordHash && existing.status === 'active') {
      return c.json({ error: 'This email already has an active portal account.' }, 409);
    }

    const now = new Date();
    let userId: string;
    if (existing) {
      await db.update(portalUsers).set({ name: name ?? undefined, status: 'invited', invitedBy: auth.user.id, invitedAt: now, updatedAt: now }).where(eq(portalUsers.id, existing.id)).returning({ id: portalUsers.id });
      userId = existing.id;
    } else {
      const [created] = await db.insert(portalUsers).values({ orgId: org.id, email: normalizedEmail, name: name ?? null, passwordHash: null, authMethod: 'password', status: 'invited', invitedBy: auth.user.id, invitedAt: now }).returning({ id: portalUsers.id });
      userId = created!.id;
    }

    const [orgRow] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, org.id)).limit(1);
    const rawToken = await storePortalInviteToken(userId);
    if (!rawToken) return c.json({ error: 'Service temporarily unavailable' }, 503);
    const inviteUrl = buildPortalUrl(`/accept-invite?token=${encodeURIComponent(rawToken)}`);

    let emailSent = false;
    const emailService = getEmailService();
    if (emailService) {
      try {
        await emailService.sendPortalInvite({ to: normalizedEmail, inviteUrl, orgName: orgRow?.name ?? undefined, inviterName: auth.user.name ?? undefined, message });
        emailSent = true;
      } catch (err) {
        console.error('[orgPortalUsers] invite email failed:', err);
      }
    }

    writeRouteAudit(c, { orgId: org.id, action: 'organization.portal_user.invite', resourceType: 'portal_user', resourceId: userId, details: { email: normalizedEmail, emailSent } });
    return c.json({ data: { id: userId, email: normalizedEmail, status: 'invited' }, emailSent });
  });
}
