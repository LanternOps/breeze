import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db';
import { partners, organizations, sites } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope, requirePartner, type AuthContext } from '../middleware/auth';
import { writeAuditEvent, writeRouteAudit } from '../services/auditEvents';
import { getEffectiveOrgSettings, assertNotLocked } from '../services/effectiveSettings';
import { PERMISSIONS } from '../services/permissions';

export const orgRoutes = new Hono();
const requireOrgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
const requireOrgWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);
const requireSiteRead = requirePermission(PERMISSIONS.SITES_READ.resource, PERMISSIONS.SITES_READ.action);
const requireSiteWrite = requirePermission(PERMISSIONS.SITES_WRITE.resource, PERMISSIONS.SITES_WRITE.action);

const paginationSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional()
});

const createPartnerSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).max(100),
  type: z.enum(['msp', 'enterprise', 'internal']).optional(),
  // plan and maxDevices are managed by the billing service (via direct DB writes).
  // They are intentionally excluded from the API schema to prevent self-service changes.
  maxOrganizations: z.number().int().nullable().optional(),
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
  // maxDevices is managed by the billing service — excluded from API schema
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
orgRoutes.get('/', requireScope('organization', 'partner', 'system'), requireOrgRead, async (c) => {
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

orgRoutes.get('/partners', requireScope('system'), requireOrgRead, zValidator('query', paginationSchema), async (c) => {
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

orgRoutes.post('/partners', requireScope('system'), requireOrgWrite, requireMfa(), zValidator('json', createPartnerSchema), async (c) => {
  const auth = c.get('auth');
  const data = c.req.valid('json');

  const [partner] = await db
    .insert(partners)
    .values({
      name: data.name,
      slug: data.slug,
      type: data.type,
      maxOrganizations: data.maxOrganizations,
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

orgRoutes.get('/partners/:id', requireScope('system'), requireOrgRead, async (c) => {
  const id = c.req.param('id')!;

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

orgRoutes.patch('/partners/:id', requireScope('system', 'partner'), requireOrgWrite, requireMfa(), zValidator('json', updatePartnerSchema), async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id')!;

  // Partner-scoped users may only update their own partner
  if (auth.scope === 'partner' && auth.partnerId !== id) {
    return c.json({ error: 'Forbidden' }, 403);
  }

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

orgRoutes.delete('/partners/:id', requireScope('system'), requireOrgWrite, requireMfa(), async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id')!;

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
  }).optional(),
  security: z.object({
    minLength: z.number().int().min(6).max(128).optional(),
    complexity: z.enum(['standard', 'strict', 'passphrase']).optional(),
    expirationDays: z.number().int().min(0).optional(),
    requireMfa: z.boolean().optional(),
    allowedMethods: z.object({ totp: z.boolean().optional(), sms: z.boolean().optional() }).optional(),
    sessionTimeout: z.number().int().min(1).optional(),
    maxSessions: z.number().int().min(1).optional(),
    ipAllowlist: z.array(z.string()).optional(),
  }).optional(),
  notifications: z.object({
    fromAddress: z.string().optional(),
    replyTo: z.string().optional(),
    useCustomSmtp: z.boolean().optional(),
    smtpHost: z.string().optional(),
    smtpPort: z.number().int().optional(),
    smtpUsername: z.string().optional(),
    smtpEncryption: z.enum(['tls', 'ssl', 'none']).optional(),
    slackWebhookUrl: z.string().optional(),
    slackChannel: z.string().optional(),
    webhooks: z.array(z.string()).optional(),
    preferences: z.record(z.string(), z.record(z.string(), z.boolean())).optional(),
  }).optional(),
  eventLogs: z.object({
    enabled: z.boolean().optional(),
    elasticsearchUrl: z.string().optional(),
    elasticsearchApiKey: z.string().optional(),
    elasticsearchUsername: z.string().optional(),
    elasticsearchPassword: z.string().optional(),
    indexPrefix: z.string().optional(),
  }).optional(),
  defaults: z.object({
    policyDefaults: z.record(z.string(), z.string()).optional(),
    deviceGroup: z.string().optional(),
    alertThreshold: z.string().optional(),
    autoEnrollment: z.object({
      enabled: z.boolean(),
      requireApproval: z.boolean(),
      sendWelcome: z.boolean(),
    }).optional(),
    agentUpdatePolicy: z.string().optional(),
    maintenanceWindow: z.string().optional(),
  }).optional(),
  branding: z.object({
    logoUrl: z.string().max(400_000, 'Logo data exceeds maximum size (400 KB)').optional(),
    primaryColor: z.string().optional(),
    secondaryColor: z.string().optional(),
    theme: z.enum(['light', 'dark', 'system']).optional(),
    customCss: z.string().optional(),
  }).optional(),
  aiBudgets: z.object({
    enabled: z.boolean().optional(),
    monthlyBudgetCents: z.number().int().min(0).nullable().optional(),
    dailyBudgetCents: z.number().int().min(0).nullable().optional(),
    maxTurnsPerSession: z.number().int().min(1).max(200).optional(),
    messagesPerMinutePerUser: z.number().int().min(1).max(100).optional(),
    messagesPerHourPerOrg: z.number().int().min(1).max(10000).optional(),
    approvalMode: z.enum(['per_step', 'action_plan', 'auto_approve', 'hybrid_plan']).optional(),
  }).optional(),
});

const updatePartnerSettingsSchema = z.object({
  settings: partnerSettingsSchema.optional(),
  name: z.string().min(1).optional(),
  billingEmail: z.string().email().optional()
});

// Get own partner details (for partner-scoped users)
orgRoutes.get('/partners/me', requireScope('partner'), requirePartner, requireOrgRead, async (c) => {
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
orgRoutes.patch('/partners/me', requireScope('partner'), requirePartner, requireOrgWrite, requireMfa(), zValidator('json', updatePartnerSettingsSchema), async (c) => {
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

orgRoutes.get('/organizations', requireScope('organization', 'partner', 'system'), requireOrgRead, zValidator('query', listOrganizationsSchema), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const { partnerId: queryPartnerId, ...pagination } = c.req.valid('query');
  const { page, limit, offset } = getPagination(pagination);

  let conditions;
  if (auth.scope === 'organization') {
    // Organization-scoped users can only see their own organization
    if (!auth.orgId) {
      return c.json({ data: [], pagination: { page, limit, total: 0 } });
    }
    conditions = and(eq(organizations.id, auth.orgId), isNull(organizations.deletedAt));
  } else if (auth.scope === 'partner') {
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

orgRoutes.post('/organizations', requireScope('partner', 'system'), requireOrgWrite, requireMfa(), zValidator('json', createOrganizationSchema), async (c) => {
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

orgRoutes.get('/organizations/:id', requireScope('partner', 'system'), requireOrgRead, async (c) => {
  const auth = c.get('auth') as AuthContext;
  const id = c.req.param('id')!;

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

orgRoutes.get('/organizations/:id/effective-settings',
  requireScope('organization', 'partner', 'system'),
  requireOrgRead,
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const id = c.req.param('id')!;

    if (auth.scope === 'organization' && id !== auth.orgId) {
      return c.json({ error: 'Access denied' }, 403);
    }
    if (auth.scope === 'partner' && !auth.canAccessOrg(id)) {
      return c.json({ error: 'Organization not found' }, 404);
    }

    const result = await getEffectiveOrgSettings(id);
    return c.json(result);
  }
);

const updateOrgHandler = [requireScope('partner', 'system'), requireOrgWrite, requireMfa(), zValidator('json', updateOrganizationSchema), async (c: any) => {
  const auth = c.get('auth') as AuthContext;
  const id = c.req.param('id')!;
  const data = c.req.valid('json');

  if (auth.scope === 'partner' && !auth.canAccessOrg(id)) {
    return c.json({ error: 'Organization not found' }, 404);
  }

  // Enforce partner locks on settings categories (after auth check)
  if (data.settings) {
    const settingsObj = data.settings as Record<string, unknown>;
    for (const category of ['security', 'notifications', 'eventLogs', 'defaults', 'branding']) {
      if (settingsObj[category] && typeof settingsObj[category] === 'object') {
        const fields = Object.keys(settingsObj[category] as Record<string, unknown>);
        await assertNotLocked(id, category, fields);
      }
    }
  }

  if (Object.keys(data).length === 0) {
    return c.json({ error: 'No updates provided' }, 400);
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (data.name !== undefined) updates.name = data.name;
  if (data.slug !== undefined) updates.slug = data.slug;
  if (data.type !== undefined) updates.type = data.type;
  if (data.status !== undefined) updates.status = data.status;
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
}] as const;

orgRoutes.patch('/organizations/:id', ...updateOrgHandler);
orgRoutes.put('/organizations/:id', ...updateOrgHandler);

orgRoutes.delete('/organizations/:id', requireScope('partner', 'system'), requireOrgWrite, requireMfa(), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const id = c.req.param('id')!;

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

orgRoutes.get('/sites', requireScope('organization', 'partner', 'system'), requireSiteRead, zValidator('query', listSitesSchema), async (c) => {
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

orgRoutes.post('/sites', requireScope('organization', 'partner', 'system'), requireSiteWrite, requireMfa(), zValidator('json', createSiteSchema), async (c) => {
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

orgRoutes.get('/sites/:id', requireScope('organization', 'partner', 'system'), requireSiteRead, async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id')!;

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

orgRoutes.patch('/sites/:id', requireScope('organization', 'partner', 'system'), requireSiteWrite, requireMfa(), zValidator('json', updateSiteSchema), async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id')!;
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

orgRoutes.delete('/sites/:id', requireScope('organization', 'partner', 'system'), requireSiteWrite, requireMfa(), async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id')!;

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
