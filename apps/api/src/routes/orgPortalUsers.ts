import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, desc, ne } from 'drizzle-orm';
import { db } from '../db';
import { organizations, portalUsers, tickets, ticketComments, assetCheckouts } from '../db/schema';
import { requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { getEmailService } from '../services/email';
import { storePortalInviteToken, buildPortalUrl } from './portal/helpers';
import { invitePortalUserSchema, bulkInvitePortalUsersSchema, updatePortalUserSchema } from '@breeze/shared';

// MSP-facing customer-portal user management (portal_users): list, invite,
// patch (disable/reactivate), resend-invite, bulk-invite, and delete.
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

async function getOrgScopedPortalUser(orgId: string, userId: string) {
  const [row] = await db.select({ id: portalUsers.id, orgId: portalUsers.orgId, email: portalUsers.email, name: portalUsers.name, passwordHash: portalUsers.passwordHash, status: portalUsers.status })
    .from(portalUsers).where(and(eq(portalUsers.id, userId), eq(portalUsers.orgId, orgId))).limit(1);
  return row ?? null;
}

async function hasPortalUserReferences(userId: string): Promise<boolean> {
  const [t] = await db.select({ id: tickets.id }).from(tickets).where(eq(tickets.submittedBy, userId)).limit(1);
  if (t) return true;
  const [cm] = await db.select({ id: ticketComments.id }).from(ticketComments).where(eq(ticketComments.portalUserId, userId)).limit(1);
  if (cm) return true;
  const [ck] = await db.select({ id: assetCheckouts.id }).from(assetCheckouts).where(eq(assetCheckouts.checkedOutTo, userId)).limit(1);
  return Boolean(ck);
}

async function issueAndSendInvite(c: any, orgId: string, user: { id: string; email: string }, orgName: string | null, inviterName: string | null | undefined, message?: string): Promise<boolean> {
  const rawToken = await storePortalInviteToken(user.id);
  if (!rawToken) return false; // redis unavailable — do not email a dead invite link
  const inviteUrl = buildPortalUrl(`/accept-invite?token=${encodeURIComponent(rawToken)}`);
  const emailService = getEmailService();
  if (!emailService) return false;
  try {
    await emailService.sendPortalInvite({ to: user.email, inviteUrl, orgName: orgName ?? undefined, inviterName: inviterName ?? undefined, message });
    return true;
  } catch (err) {
    console.error('[orgPortalUsers] invite email failed:', err);
    return false;
  }
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
    const emailSent = await issueAndSendInvite(c, org.id, { id: userId, email: normalizedEmail }, orgRow?.name ?? null, auth.user.name, message);

    writeRouteAudit(c, { orgId: org.id, action: 'organization.portal_user.invite', resourceType: 'portal_user', resourceId: userId, details: { email: normalizedEmail, emailSent } });
    return c.json({ data: { id: userId, email: normalizedEmail, status: 'invited' }, emailSent });
  });

  orgRoutes.patch('/organizations/:id/portal-users/:userId', requireScope('partner', 'system'), requireOrgWrite, requireMfa(), zValidator('json', updatePortalUserSchema), async (c) => {
    const org = await resolveAccessibleOrg(c);
    if (org instanceof Response) return org;
    const body = c.req.valid('json');
    if (Object.keys(body).length === 0) return c.json({ error: 'No updates provided' }, 400);
    const target = await getOrgScopedPortalUser(org.id, c.req.param('userId')!);
    if (!target) return c.json({ error: 'Portal user not found' }, 404);
    const [updated] = await db.update(portalUsers).set({ ...body, updatedAt: new Date() }).where(eq(portalUsers.id, target.id)).returning({ id: portalUsers.id, status: portalUsers.status });
    writeRouteAudit(c, { orgId: org.id, action: 'organization.portal_user.update', resourceType: 'portal_user', resourceId: target.id, details: { changedFields: Object.keys(body) } });
    return c.json({ data: { id: updated!.id, status: updated!.status } });
  });

  orgRoutes.post('/organizations/:id/portal-users/:userId/resend-invite', requireScope('partner', 'system'), requireOrgWrite, requireMfa(), async (c) => {
    const org = await resolveAccessibleOrg(c);
    if (org instanceof Response) return org;
    const auth = c.get('auth') as AuthContext;
    const target = await getOrgScopedPortalUser(org.id, c.req.param('userId')!);
    if (!target) return c.json({ error: 'Portal user not found' }, 404);
    if (target.passwordHash && target.status === 'active') return c.json({ error: 'This account is already set up.' }, 409);
    const [orgRow] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, org.id)).limit(1);
    const emailSent = await issueAndSendInvite(c, org.id, { id: target.id, email: target.email }, orgRow?.name ?? null, auth.user.name);
    writeRouteAudit(c, { orgId: org.id, action: 'organization.portal_user.resend_invite', resourceType: 'portal_user', resourceId: target.id, details: { emailSent } });
    return c.json({ data: { id: target.id }, emailSent });
  });

  orgRoutes.post('/organizations/:id/portal-users/bulk-invite', requireScope('partner', 'system'), requireOrgWrite, requireMfa(), zValidator('json', bulkInvitePortalUsersSchema), async (c) => {
    const org = await resolveAccessibleOrg(c);
    if (org instanceof Response) return org;
    const auth = c.get('auth') as AuthContext;
    const { userIds } = c.req.valid('json');
    // "Pending setup" = no password. Invite selected, or all pending in the org.
    const baseWhere = and(eq(portalUsers.orgId, org.id), isNull(portalUsers.passwordHash), ne(portalUsers.status, 'disabled'));
    const candidates = await db.select({ id: portalUsers.id, email: portalUsers.email }).from(portalUsers).where(baseWhere);
    const targets = userIds && userIds.length > 0 ? candidates.filter((u) => userIds.includes(u.id)) : candidates;
    const [orgRow] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, org.id)).limit(1);
    const now = new Date();
    const results: Array<{ id: string; emailSent: boolean }> = [];
    for (const t of targets) {
      await db.update(portalUsers).set({ status: 'invited', invitedBy: auth.user.id, invitedAt: now, updatedAt: now }).where(eq(portalUsers.id, t.id));
      const emailSent = await issueAndSendInvite(c, org.id, t, orgRow?.name ?? null, auth.user.name);
      results.push({ id: t.id, emailSent });
    }
    writeRouteAudit(c, { orgId: org.id, action: 'organization.portal_user.bulk_invite', resourceType: 'organization', resourceId: org.id, details: { invited: results.length } });
    return c.json({ data: results });
  });

  orgRoutes.delete('/organizations/:id/portal-users/:userId', requireScope('partner', 'system'), requireOrgWrite, requireMfa(), async (c) => {
    const org = await resolveAccessibleOrg(c);
    if (org instanceof Response) return org;
    const target = await getOrgScopedPortalUser(org.id, c.req.param('userId')!);
    if (!target) return c.json({ error: 'Portal user not found' }, 404);
    if (await hasPortalUserReferences(target.id)) {
      return c.json({ error: 'This user has ticket or asset history. Disable them instead of deleting.' }, 409);
    }
    await db.delete(portalUsers).where(eq(portalUsers.id, target.id));
    writeRouteAudit(c, { orgId: org.id, action: 'organization.portal_user.delete', resourceType: 'portal_user', resourceId: target.id, details: { email: target.email } });
    return c.json({ data: { id: target.id, deleted: true } });
  });
}
