import { Hono } from 'hono';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db';
import { readWithPartnerAxisVisibility } from '../db/partnerAxisRead';
import { organizations, devices, partners, partnerUsers } from '../db/schema';
import { authMiddleware, requirePermission, requireScope } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';

export const partnerRoutes = new Hono();
const requirePartnerDashboardRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
const requirePartnerDeviceRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);

partnerRoutes.use('*', authMiddleware);

// GET /partner/me — return the current user's partner
partnerRoutes.get('/me', async (c) => {
  const auth = c.get('auth');

  // If the token already carries a partnerId, look it up directly
  let partnerId = auth.partnerId;

  // For system-scoped users, resolve via partner_users table
  if (!partnerId) {
    const [assoc] = await db
      .select({ partnerId: partnerUsers.partnerId })
      .from(partnerUsers)
      .where(eq(partnerUsers.userId, auth.user.id))
      .limit(1);
    partnerId = assoc?.partnerId ?? null;
  }

  if (!partnerId) {
    return c.json({ error: 'No partner association' }, 404);
  }
  // Narrowed copy so the closure below keeps the non-null type.
  const resolvedPartnerId = partnerId;

  // Read under a SYSTEM context (#2822). This route is gated by authMiddleware
  // ONLY — no requireScope — and is explicitly exempt from partnerGuard
  // (index.ts) so the client can still ask "what is my partner's status?" while
  // that partner is inactive. An ORGANIZATION-scoped JWT carries a non-null
  // partnerId (routes/auth/helpers.ts fills it from organizations.partnerId),
  // so it reaches this read with accessiblePartnerIds = [] and the `partners`
  // SELECT policy filters the row out — turning every org-scoped call into a
  // spurious 404, which the web AccountInactiveGuard swallows (`if (!res.ok)
  // return null`), so those users are never told their tenant is suspended.
  // `partnerId` here is either the verified JWT claim or the caller's own
  // partner_users row — never client input — so escalating this one
  // pinned-by-id lookup does not widen which partner is legible.
  const [partner] = await readWithPartnerAxisVisibility(() =>
    db
      .select({ id: partners.id, name: partners.name, slug: partners.slug, status: partners.status, settings: partners.settings })
      .from(partners)
      .where(eq(partners.id, resolvedPartnerId))
      .limit(1)
  );

  if (!partner) {
    return c.json({ error: 'Partner not found' }, 404);
  }

  const settings = (partner.settings ?? {}) as Record<string, unknown>;
  return c.json({
    ...partner,
    settings: undefined,
    statusMessage: (settings.statusMessage as string) ?? null,
    statusActionUrl: (settings.statusActionUrl as string) ?? null,
    statusActionLabel: (settings.statusActionLabel as string) ?? null,
  });
});

partnerRoutes.get(
  '/dashboard',
  requireScope('partner', 'system'),
  requirePartnerDashboardRead,
  requirePartnerDeviceRead,
  async (c) => {
  const auth = c.get('auth');

  let orgIds: string[] | null = null;

  if (auth.scope === 'partner') {
    orgIds = auth.accessibleOrgIds ?? [];
    if (orgIds.length === 0) {
      return c.json({ data: [] });
    }
  } else if (auth.scope === 'system') {
    const queryOrgId = c.req.query('orgId');
    if (queryOrgId) {
      orgIds = [queryOrgId];
    }
  }

  const orgConditions = [isNull(organizations.deletedAt)];
  if (orgIds) {
    orgConditions.push(inArray(organizations.id, orgIds));
  }

  const orgRows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      status: organizations.status
    })
    .from(organizations)
    .where(and(...orgConditions))
    .orderBy(organizations.name);

  if (orgRows.length === 0) {
    return c.json({ data: [] });
  }

  const orgIdList = orgRows.map((org) => org.id);
  const deviceRows = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      hostname: devices.hostname,
      status: devices.status,
      lastSeenAt: devices.lastSeenAt
    })
    .from(devices)
    .where(inArray(devices.orgId, orgIdList));

  const devicesByOrg = new Map<string, Array<{
    id: string;
    name: string;
    status: string;
    alertCount: number;
    compliance: number;
    lastSeen: string;
  }>>();

  for (const row of deviceRows) {
    const list = devicesByOrg.get(row.orgId) ?? [];
    list.push({
      id: row.id,
      name: row.hostname,
      status: row.status,
      alertCount: 0,
      compliance: 100,
      lastSeen: row.lastSeenAt ? row.lastSeenAt.toISOString() : new Date(0).toISOString(),
    });
    devicesByOrg.set(row.orgId, list);
  }

  const data = orgRows.map((org) => {
    const orgDevices = devicesByOrg.get(org.id) ?? [];
    return {
      id: org.id,
      name: org.name,
      status: org.status,
      deviceCount: orgDevices.length,
      alertCount: 0,
      compliance: 100,
      mrr: 0,
      devices: orgDevices
    };
  });

  return c.json({ data });
});
