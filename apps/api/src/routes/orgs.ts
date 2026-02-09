import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db';
import { partners, organizations, sites } from '../db/schema';
import { authMiddleware, requireScope, requirePartner, type AuthContext } from '../middleware/auth';
import { writeAuditEvent, writeRouteAudit } from '../services/auditEvents';

export const orgRoutes = new Hono();

const paginationSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional()
});

const createPartnerSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).max(100),
  type: z.enum(['msp', 'enterprise', 'internal']).optional(),
  plan: z.enum(['free', 'pro', 'enterprise', 'unlimited']).optional(),
  maxOrganizations: z.number().int().nullable().optional(),
  maxDevices: z.number().int().nullable().optional(),
  settings: z.any().optional(),
  ssoConfig: z.any().optional(),
  billingEmail: z.string().email().optional()
});

const updatePartnerSchema = createPartnerSchema.partial();

const createOrganizationSchema = z.object({
  partnerId: z.string().uuid().optional(),
  name: z.string().min(1),
  slug: z.string().min(1).max(100),
  type: z.enum(['customer', 'internal']).optional(),
  status: z.enum(['active', 'suspended', 'trial', 'churned']).optional(),
  maxDevices: z.number().int().nullable().optional(),
  settings: z.any().optional(),
  ssoConfig: z.any().optional(),
  contractStart: z.string().nullable().optional(),
  contractEnd: z.string().nullable().optional(),
  billingContact: z.any().optional()
});

const updateOrganizationSchema = createOrganizationSchema.partial().omit({ partnerId: true });

const listSitesSchema = z.object({
  orgId: z.string().uuid().optional(),
  organizationId: z.string().uuid().optional(), // Alias for orgId (frontend compatibility)
  page: z.string().optional(),
  limit: z.string().optional()
});

const siteBaseSchema = z.object({
  orgId: z.string().uuid(),
  name: z.string().min(1),
  address: z.any().optional(),
  timezone: z.string().optional(),
  contact: z.any().optional(),
  settings: z.any().optional()
});

const createSiteSchema = siteBaseSchema.extend({
  timezone: z.string().default('UTC')
});

const updateSiteSchema = siteBaseSchema.partial().omit({ orgId: true });

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

async function ensureOrgAccess(
  orgId: string,
  auth: Pick<AuthContext, 'scope' | 'partnerId' | 'orgId' | 'canAccessOrg'>
) {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }

  if (auth.scope === 'partner') {
    return auth.canAccessOrg(orgId);
  }

  return true;
}

async function resolveAuditOrgIdForPartner(partnerId: string | null): Promise<string | null> {
  if (!partnerId) {
    return null;
  }

  try {
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.partnerId, partnerId), isNull(organizations.deletedAt)))
      .orderBy(organizations.createdAt)
      .limit(1);

    return org?.id ?? null;
  } catch (err) {
    console.error('[audit] Failed to resolve orgId for partner:', partnerId, err);
    return null;
  }
}

orgRoutes.use('*', authMiddleware);

// GET / - List organizations accessible to the current user
orgRoutes.get('/', requireScope('organization', 'partner', 'system'), async (c) => {
  const auth = c.get('auth') as AuthContext;

  const conditions = [isNull(organizations.deletedAt)];

  if (auth.scope === 'organization' && auth.orgId) {
    conditions.push(eq(organizations.id, auth.orgId));
  } else if (auth.scope === 'partner') {
    const orgIds = auth.accessibleOrgIds ?? [];
    if (orgIds.length === 0) {
      return c.json({ data: [] });
    }
    conditions.push(inArray(organizations.id, orgIds));
  }
  // system scope: no extra filter

  const data = await db
    .select()
    .from(organizations)
    .where(and(...conditions))
    .orderBy(organizations.name);

  return c.json({ data });
});

// --- Partners (system admins) ---

orgRoutes.get('/partners', requireScope('system'), zValidator('query', paginationSchema), async (c) => {
  const { page, limit, offset } = getPagination(c.req.valid('query'));

  const conditions = isNull(partners.deletedAt);
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(partners)
    .where(conditions);
  const count = countResult[0]?.count ?? 0;

  const data = await db
    .select()
    .from(partners)
    .where(conditions)
    .limit(limit)
    .offset(offset)
    .orderBy(partners.createdAt);

  return c.json({
    data,
    pagination: { page, limit, total: Number(count) }
  });
});

orgRoutes.post('/partners', requireScope('system'), zValidator('json', createPartnerSchema), async (c) => {
  const auth = c.get('auth');
  const data = c.req.valid('json');

  const [partner] = await db
    .insert(partners)
    .values({
      name: data.name,
      slug: data.slug,
      type: data.type,
      plan: data.plan,
      maxOrganizations: data.maxOrganizations,
      maxDevices: data.maxDevices,
      settings: data.settings,
      ssoConfig: data.ssoConfig,
      billingEmail: data.billingEmail
    })
    .returning();

  writeAuditEvent(c, {
    orgId: auth.orgId,
    actorId: auth.user?.id,
    actorEmail: auth.user?.email,
    action: 'partner.create',
    resourceType: 'partner',
    resourceId: partner?.id,
    resourceName: partner?.name,
    details: {
      slug: partner?.slug,
      type: partner?.type,
      plan: partner?.plan
    }
  });

  return c.json(partner, 201);
});

orgRoutes.get('/partners/:id', requireScope('system'), async (c) => {
  const id = c.req.param('id');

  const [partner] = await db
    .select()
    .from(partners)
    .where(and(eq(partners.id, id), isNull(partners.deletedAt)))
    .limit(1);

  if (!partner) {
    return c.json({ error: 'Partner not found' }, 404);
  }

  return c.json(partner);
});

orgRoutes.patch('/partners/:id', requireScope('system'), zValidator('json', updatePartnerSchema), async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  const updates = { ...data, updatedAt: new Date() };

  if (Object.keys(data).length === 0) {
    return c.json({ error: 'No updates provided' }, 400);
  }

  const [partner] = await db
    .update(partners)
    .set(updates)
    .where(and(eq(partners.id, id), isNull(partners.deletedAt)))
    .returning();

  if (!partner) {
    return c.json({ error: 'Partner not found' }, 404);
  }

  const auditOrgId = auth.orgId ?? await resolveAuditOrgIdForPartner(id);
  writeAuditEvent(c, {
    orgId: auditOrgId,
    actorId: auth.user?.id,
    actorEmail: auth.user?.email,
    action: 'partner.update',
    resourceType: 'partner',
    resourceId: partner.id,
    resourceName: partner.name,
    details: {
      changedFields: Object.keys(data)
    }
  });

  return c.json(partner);
});

orgRoutes.delete('/partners/:id', requireScope('system'), async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');

  const [partner] = await db
    .update(partners)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(partners.id, id), isNull(partners.deletedAt)))
    .returning();

  if (!partner) {
    return c.json({ error: 'Partner not found' }, 404);
  }

  const auditOrgId = auth.orgId ?? await resolveAuditOrgIdForPartner(id);
  writeAuditEvent(c, {
    orgId: auditOrgId,
    actorId: auth.user?.id,
    actorEmail: auth.user?.email,
    action: 'partner.delete',
    resourceType: 'partner',
    resourceId: partner.id,
    resourceName: partner.name
  });

  return c.json({ success: true });
});

// --- Partner Self-Service (partner-scoped users) ---

const dayScheduleSchema = z.object({
  start: z.string(),
  end: z.string(),
  closed: z.boolean().optional()
});

const partnerSettingsSchema = z.object({
  timezone: z.string().optional(),
  dateFormat: z.enum(['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD']).optional(),
  timeFormat: z.enum(['12h', '24h']).optional(),
  language: z.literal('en').optional(),
  businessHours: z.object({
    preset: z.enum(['24/7', 'business', 'extended', 'custom']),
    custom: z.record(z.string(), dayScheduleSchema).optional()
  }).optional(),
  contact: z.object({
    name: z.string().optional(),
    email: z.string().email().optional().or(z.literal('')),
    phone: z.string().optional(),
    website: z.string().optional()
  }).optional()
});

const updatePartnerSettingsSchema = z.object({
  settings: partnerSettingsSchema.optional(),
  name: z.string().min(1).optional(),
  billingEmail: z.string().email().optional()
});

// Get own partner details (for partner-scoped users)
orgRoutes.get('/partners/me', requireScope('partner'), requirePartner, async (c) => {
  const auth = c.get('auth');

  const [partner] = await db
    .select()
    .from(partners)
    .where(and(eq(partners.id, auth.partnerId as string), isNull(partners.deletedAt)))
    .limit(1);

  if (!partner) {
    return c.json({ error: 'Partner not found' }, 404);
  }

  return c.json(partner);
});

// Update own partner settings (for partner-scoped users)
orgRoutes.patch('/partners/me', requireScope('partner'), requirePartner, zValidator('json', updatePartnerSettingsSchema), async (c) => {
  const auth = c.get('auth');
  const body = c.req.valid('json');

  // Get current partner to merge settings
  const [current] = await db
    .select()
    .from(partners)
    .where(and(eq(partners.id, auth.partnerId as string), isNull(partners.deletedAt)))
    .limit(1);

  if (!current) {
    return c.json({ error: 'Partner not found' }, 404);
  }

  // Merge settings
  const currentSettings = (current.settings as Record<string, unknown>) || {};
  const newSettings = body.settings
    ? { ...currentSettings, ...body.settings }
    : currentSettings;

  const updateData: Record<string, unknown> = {
    settings: newSettings,
    updatedAt: new Date()
  };

  if (body.name) updateData.name = body.name;
  if (body.billingEmail) updateData.billingEmail = body.billingEmail;

  const [partner] = await db
    .update(partners)
    .set(updateData)
    .where(and(eq(partners.id, auth.partnerId as string), isNull(partners.deletedAt)))
    .returning();

  const auditOrgId = await resolveAuditOrgIdForPartner(auth.partnerId);
  writeRouteAudit(c, {
    orgId: auditOrgId,
    action: 'partner.settings.update',
    resourceType: 'partner',
    resourceId: partner?.id,
    resourceName: partner?.name,
    details: { changedFields: Object.keys(body) }
  });

  return c.json(partner);
});

// --- Organizations (partner-scoped) ---

const listOrganizationsSchema = z.object({
  partnerId: z.string().uuid().optional(),
  page: z.string().optional(),
  limit: z.string().optional()
});

orgRoutes.get('/organizations', requireScope('partner', 'system'), zValidator('query', listOrganizationsSchema), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const { partnerId: queryPartnerId, ...pagination } = c.req.valid('query');
  const { page, limit, offset } = getPagination(pagination);

  let conditions;
  if (auth.scope === 'partner') {
    const orgIds = auth.accessibleOrgIds ?? [];
    if (orgIds.length === 0) {
      return c.json({
        data: [],
        pagination: { page, limit, total: 0 }
      });
    }
    conditions = and(inArray(organizations.id, orgIds), isNull(organizations.deletedAt));
  } else {
    conditions = queryPartnerId
      ? and(eq(organizations.partnerId, queryPartnerId), isNull(organizations.deletedAt))
      : isNull(organizations.deletedAt);
  }

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(organizations)
    .where(conditions);
  const count = countResult[0]?.count ?? 0;

  const data = await db
    .select()
    .from(organizations)
    .where(conditions)
    .limit(limit)
    .offset(offset)
    .orderBy(organizations.createdAt);

  return c.json({
    data,
    pagination: { page, limit, total: Number(count) }
  });
});

orgRoutes.post('/organizations', requireScope('partner', 'system'), zValidator('json', createOrganizationSchema), async (c) => {
  const auth = c.get('auth');
  const data = c.req.valid('json');

  let targetPartnerId: string | null = null;

  if (auth.scope === 'partner') {
    if (!auth.partnerId) {
      return c.json({ error: 'Partner context required to create organizations' }, 400);
    }
    if (data.partnerId && data.partnerId !== auth.partnerId) {
      return c.json({ error: 'Access denied to this partner' }, 403);
    }
    targetPartnerId = auth.partnerId;
  } else {
    targetPartnerId = data.partnerId ?? auth.partnerId;
    if (!targetPartnerId) {
      return c.json({ error: 'partnerId is required for system scope' }, 400);
    }
  }

  const insertValues = {
    partnerId: targetPartnerId,
    name: data.name,
    slug: data.slug,
    type: data.type,
    status: data.status,
    maxDevices: data.maxDevices,
    settings: data.settings,
    ssoConfig: data.ssoConfig,
    contractStart: data.contractStart ? new Date(data.contractStart) : null,
    contractEnd: data.contractEnd ? new Date(data.contractEnd) : null,
    billingContact: data.billingContact
  };
  const [organization] = await db
    .insert(organizations)
    .values(insertValues)
    .returning();

  writeRouteAudit(c, {
    orgId: organization?.id,
    action: 'organization.create',
    resourceType: 'organization',
    resourceId: organization?.id,
    resourceName: organization?.name,
    details: { partnerId: organization?.partnerId, status: organization?.status, type: organization?.type }
  });

  return c.json(organization, 201);
});

orgRoutes.get('/organizations/:id', requireScope('partner', 'system'), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const id = c.req.param('id');

  if (auth.scope === 'partner' && !auth.canAccessOrg(id)) {
    return c.json({ error: 'Organization not found' }, 404);
  }

  const conditions = and(eq(organizations.id, id), isNull(organizations.deletedAt));

  const [organization] = await db
    .select()
    .from(organizations)
    .where(conditions)
    .limit(1);

  if (!organization) {
    return c.json({ error: 'Organization not found' }, 404);
  }

  return c.json(organization);
});

orgRoutes.patch('/organizations/:id', requireScope('partner', 'system'), zValidator('json', updateOrganizationSchema), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const id = c.req.param('id');
  const data = c.req.valid('json');

  if (auth.scope === 'partner' && !auth.canAccessOrg(id)) {
    return c.json({ error: 'Organization not found' }, 404);
  }

  if (Object.keys(data).length === 0) {
    return c.json({ error: 'No updates provided' }, 400);
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (data.name !== undefined) updates.name = data.name;
  if (data.slug !== undefined) updates.slug = data.slug;
  if (data.type !== undefined) updates.type = data.type;
  if (data.status !== undefined) updates.status = data.status;
  if (data.maxDevices !== undefined) updates.maxDevices = data.maxDevices;
  if (data.settings !== undefined) updates.settings = data.settings;
  if (data.ssoConfig !== undefined) updates.ssoConfig = data.ssoConfig;
  if (data.billingContact !== undefined) updates.billingContact = data.billingContact;
  if (data.contractStart !== undefined) {
    updates.contractStart = data.contractStart ? new Date(data.contractStart) : null;
  }
  if (data.contractEnd !== undefined) {
    updates.contractEnd = data.contractEnd ? new Date(data.contractEnd) : null;
  }

  const conditions = and(eq(organizations.id, id), isNull(organizations.deletedAt));

  const [organization] = await db
    .update(organizations)
    .set(updates)
    .where(conditions)
    .returning();

  if (!organization) {
    return c.json({ error: 'Organization not found' }, 404);
  }

  writeRouteAudit(c, {
    orgId: organization.id,
    action: 'organization.update',
    resourceType: 'organization',
    resourceId: organization.id,
    resourceName: organization.name,
    details: { changedFields: Object.keys(data) }
  });

  return c.json(organization);
});

orgRoutes.delete('/organizations/:id', requireScope('partner', 'system'), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const id = c.req.param('id');

  if (auth.scope === 'partner' && !auth.canAccessOrg(id)) {
    return c.json({ error: 'Organization not found' }, 404);
  }

  const conditions = and(eq(organizations.id, id), isNull(organizations.deletedAt));

  const [organization] = await db
    .update(organizations)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(conditions)
    .returning();

  if (!organization) {
    return c.json({ error: 'Organization not found' }, 404);
  }

  writeRouteAudit(c, {
    orgId: organization.id,
    action: 'organization.delete',
    resourceType: 'organization',
    resourceId: organization.id,
    resourceName: organization.name
  });

  return c.json({ success: true });
});

// --- Sites (organization-scoped) ---

orgRoutes.get('/sites', requireScope('organization', 'partner', 'system'), zValidator('query', listSitesSchema), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const { orgId, organizationId, ...pagination } = c.req.valid('query');

  // Support both orgId and organizationId parameter names
  const effectiveOrgId = orgId || organizationId;

  const { page, limit, offset } = getPagination(pagination);
  let conditions;

  if (effectiveOrgId) {
    // Specific org requested - check access
    const allowed = await ensureOrgAccess(effectiveOrgId, auth);
    if (!allowed) {
      return c.json({ error: 'Access to this organization denied' }, 403);
    }
    conditions = eq(sites.orgId, effectiveOrgId);
  } else {
    // No org specified - return sites from all accessible orgs
    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ data: [], pagination: { page, limit, total: 0 } });
      }
      conditions = eq(sites.orgId, auth.orgId);
    } else if (auth.scope === 'partner') {
      const orgIds = auth.accessibleOrgIds ?? [];
      if (orgIds.length === 0) {
        return c.json({ data: [], pagination: { page, limit, total: 0 } });
      }
      conditions = inArray(sites.orgId, orgIds);
    } else {
      // System scope - no filter (dangerous but allowed for admins)
      conditions = undefined;
    }
  }

  const whereCondition = conditions ?? sql`true`;

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(sites)
    .where(whereCondition);
  const count = countResult[0]?.count ?? 0;

  const data = await db
    .select()
    .from(sites)
    .where(whereCondition)
    .limit(limit)
    .offset(offset)
    .orderBy(sites.createdAt);

  return c.json({
    data,
    pagination: { page, limit, total: Number(count) }
  });
});

orgRoutes.post('/sites', requireScope('organization', 'partner', 'system'), zValidator('json', createSiteSchema), async (c) => {
  const auth = c.get('auth');
  const data = c.req.valid('json');

  const allowed = await ensureOrgAccess(data.orgId, auth);
  if (!allowed) {
    return c.json({ error: 'Access to this organization denied' }, 403);
  }

  const [site] = await db
    .insert(sites)
    .values({
      orgId: data.orgId,
      name: data.name,
      address: data.address,
      timezone: data.timezone,
      contact: data.contact,
      settings: data.settings
    })
    .returning();

  writeRouteAudit(c, {
    orgId: site?.orgId,
    action: 'site.create',
    resourceType: 'site',
    resourceId: site?.id,
    resourceName: site?.name
  });

  return c.json(site, 201);
});

orgRoutes.get('/sites/:id', requireScope('organization', 'partner', 'system'), async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');

  const [site] = await db
    .select()
    .from(sites)
    .where(eq(sites.id, id))
    .limit(1);

  if (!site) {
    return c.json({ error: 'Site not found' }, 404);
  }

  const allowed = await ensureOrgAccess(site.orgId, auth);
  if (!allowed) {
    return c.json({ error: 'Access to this site denied' }, 403);
  }

  return c.json(site);
});

orgRoutes.patch('/sites/:id', requireScope('organization', 'partner', 'system'), zValidator('json', updateSiteSchema), async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');
  const data = c.req.valid('json');

  if (Object.keys(data).length === 0) {
    return c.json({ error: 'No updates provided' }, 400);
  }

  const [site] = await db
    .select()
    .from(sites)
    .where(eq(sites.id, id))
    .limit(1);

  if (!site) {
    return c.json({ error: 'Site not found' }, 404);
  }

  const allowed = await ensureOrgAccess(site.orgId, auth);
  if (!allowed) {
    return c.json({ error: 'Access to this site denied' }, 403);
  }

  const [updated] = await db
    .update(sites)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(sites.id, id))
    .returning();

  writeRouteAudit(c, {
    orgId: site.orgId,
    action: 'site.update',
    resourceType: 'site',
    resourceId: updated?.id,
    resourceName: updated?.name,
    details: { changedFields: Object.keys(data) }
  });

  return c.json(updated);
});

orgRoutes.delete('/sites/:id', requireScope('organization', 'partner', 'system'), async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');

  const [site] = await db
    .select()
    .from(sites)
    .where(eq(sites.id, id))
    .limit(1);

  if (!site) {
    return c.json({ error: 'Site not found' }, 404);
  }

  const allowed = await ensureOrgAccess(site.orgId, auth);
  if (!allowed) {
    return c.json({ error: 'Access to this site denied' }, 403);
  }

  await db.delete(sites).where(eq(sites.id, id));

  writeRouteAudit(c, {
    orgId: site.orgId,
    action: 'site.delete',
    resourceType: 'site',
    resourceId: site.id,
    resourceName: site.name
  });

  return c.json({ success: true });
});
