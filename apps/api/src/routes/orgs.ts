import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { partners, organizations, sites } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope, requirePartner, type AuthContext } from '../middleware/auth';
import { writeAuditEvent, writeRouteAudit } from '../services/auditEvents';
import { getEffectiveOrgSettings, assertNotLocked } from '../services/effectiveSettings';
import { clearPartnerScopePolicyCache } from '../oauth/partnerScopePolicy';
import { PERMISSIONS } from '../services/permissions';
import { revokeOrganizationTenantAccess, revokePartnerTenantAccess } from '../services/tenantLifecycle';
import { applyOrganizationOrder, sanitizeOrganizationOrder } from '../services/orgOrdering';
import { captureException } from '../services/sentry';
import { encryptColumnValueForWrite } from '../services/encryptedColumnRegistry';
import { isAllowedLauncherScheme } from '@breeze/shared';

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

const updatePartnerSchema = createPartnerSchema.partial().extend({
  status: z.enum(['pending', 'active', 'suspended', 'churned']).optional()
});

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

// Intl.supportedValuesOf('timeZone') omits UTC, GMT, and the Etc/* zones, so
// a Set-membership check against that list rejects 'UTC' (the default).
// Constructing Intl.DateTimeFormat throws RangeError on unknown zones and
// accepts everything Intl recognizes, including those omissions.
function isValidIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Stored as-is into a JSONB column; `.passthrough()` keeps unknown keys for
// forward compatibility. Email format is policed when present so downstream
// `mailto:` consumers don't render garbage; empty string is accepted because
// the form sends `''` for an absent value.
const siteContactSchema = z
  .object({
    name: z.string().optional(),
    email: z.union([z.string().email(), z.literal('')]).optional(),
    phone: z.string().optional(),
  })
  .passthrough();

const siteBaseSchema = z.object({
  orgId: z.string().uuid(),
  name: z.string().min(1),
  address: z.any().optional(),
  timezone: z.string().refine(isValidIanaTimezone, 'Invalid IANA timezone').optional(),
  contact: siteContactSchema.optional(),
  settings: z.any().optional()
});

const createSiteSchema = siteBaseSchema.extend({
  timezone: z.string().refine(isValidIanaTimezone, 'Invalid IANA timezone').default('UTC')
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

// --- Partner Self-Service (partner-scoped users) ---
// NOTE: all /partners/me handlers (GET, PATCH) must stay above /partners/:id in this file
// so Hono's router matches the static segment "me" before the dynamic :id handler.

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
  address: z.object({
    street1: z.string().max(255).optional(),
    street2: z.string().max(255).optional(),
    city: z.string().max(255).optional(),
    region: z.string().max(255).optional(),
    postalCode: z.string().max(32).optional(),
    country: z.string().length(2).optional().or(z.literal('')),
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
    pushoverAppToken: z.string().max(30).optional(),
    pushoverDefaultUser: z.string().max(30).optional(),
    pushoverDefaultSound: z.string().max(40).optional(),
    pushoverDefaultPriority: z.number().int().min(-2).max(2).optional(),
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
  organizationOrder: z.array(z.string().uuid()).max(10_000).optional(),
  remoteAccessProviders: z.object({
    defaultProviderId: z.string().max(100).optional(),
    providers: z.array(z.object({
      id: z.string().min(1).max(100),
      name: z.string().min(1).max(100),
      // urlTemplate may be either a custom-scheme template
      // (e.g. 'rustdesk://{id}?password={password}') or an https launcher
      // (e.g. 'https://acme.screenconnect.com/Host#Access///{id}/Join').
      // The browser auto-detects launch mode by prefix.
      // {id} must appear or the launcher would always resolve to the same
      // URL and ignore the per-device identifier.
      // Dangerous schemes (javascript:, data:, vbscript:, file:, about:,
      // chrome:, jar:, blob:, view-source:, filesystem:) are rejected by
      // isAllowedLauncherScheme so a malicious partner admin cannot plant
      // stored XSS that fires when an org-scope user clicks Connect Desktop.
      // The web client repeats the same check before firing the URL.
      urlTemplate: z.string()
        .min(1)
        .max(2000)
        .refine(
          (t) => t.includes('{id}'),
          'Template must include the {id} placeholder for the per-device value',
        )
        .refine(
          (t) => isAllowedLauncherScheme(t),
          'Template must start with an allowed URL scheme (https, http, rustdesk, teamviewer, anydesk, splashtop, etc.); javascript:, data:, vbscript:, file:, about:, chrome:, jar:, blob:, view-source:, filesystem: are rejected',
        ),
      customFieldKey: z.string().min(1).max(100),
      password: z.string().max(2000).optional(),
      enabled: z.boolean(),
    })).max(50).optional(),
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

  // Encrypt secret-bearing fields (e.g. remoteAccessProviders[*].password)
  // BEFORE writing. Without this, every PATCH from the UI would regress the
  // column to plaintext between deploy-day batch re-encrypt runs.
  const updateData: Record<string, unknown> = {
    settings: encryptColumnValueForWrite('partners', 'settings', newSettings),
    updatedAt: new Date()
  };

  if (body.name) updateData.name = body.name;
  if (body.billingEmail) updateData.billingEmail = body.billingEmail;

  const [partner] = await db
    .update(partners)
    .set(updateData)
    .where(and(eq(partners.id, auth.partnerId as string), isNull(partners.deletedAt)))
    .returning();

  if (!partner) {
    return c.json({ error: 'Partner not found' }, 404);
  }

  // Invalidate the OAuth scope-policy cache so a change to
  // `settings.oauth_scope_policy.mcp_allowed_scopes` takes effect on the
  // next token mint without waiting for the 60s TTL.
  clearPartnerScopePolicyCache(partner.id);

  const auditOrgId = await resolveAuditOrgIdForPartner(auth.partnerId);
  writeRouteAudit(c, {
    orgId: auditOrgId,
    action: 'partner.settings.update',
    resourceType: 'partner',
    resourceId: partner.id,
    resourceName: partner.name,
    details: { changedFields: Object.keys(body) }
  });

  return c.json(partner);
});

// --- Individual partner management (system-scoped) ---

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

orgRoutes.patch('/partners/:id', requireScope('system'), requireOrgWrite, requireMfa(), zValidator('json', updatePartnerSchema), async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id')!;

  const data = c.req.valid('json');
  const updates: Record<string, unknown> = { ...data, updatedAt: new Date() };

  if (Object.keys(data).length === 0) {
    return c.json({ error: 'No updates provided' }, 400);
  }

  // Encrypt secret-bearing fields in partners.settings before writing.
  if (updates.settings !== undefined) {
    updates.settings = encryptColumnValueForWrite('partners', 'settings', updates.settings);
  }

  const [partner] = await db
    .update(partners)
    .set(updates)
    .where(and(eq(partners.id, id), isNull(partners.deletedAt)))
    .returning();

  if (!partner) {
    return c.json({ error: 'Partner not found' }, 404);
  }

  // Invalidate the OAuth scope-policy cache (settings may have changed).
  clearPartnerScopePolicyCache(partner.id);
  if ('status' in data && data.status && data.status !== 'active') {
    await revokePartnerTenantAccess(partner.id);
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
    .set({ status: 'churned', deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(partners.id, id), isNull(partners.deletedAt)))
    .returning();

  if (!partner) {
    return c.json({ error: 'Partner not found' }, 404);
  }

  await revokePartnerTenantAccess(partner.id);

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

  // Apply the partner's preferred organization order, when one is set.
  // - partner scope: load own partner settings.
  // - system scope: only when a partnerId filter is in the query.
  // - organization scope: list is at most one row, nothing to reorder.
  let ordered = data;
  let orderPartnerId: string | null = null;
  if (auth.scope === 'partner' && auth.partnerId) orderPartnerId = auth.partnerId;
  else if (auth.scope === 'system' && queryPartnerId) orderPartnerId = queryPartnerId;
  if (orderPartnerId) {
    try {
      const settingsRow = await withSystemDbAccessContext(async () => {
        const [row] = await db
          .select({ settings: partners.settings })
          .from(partners)
          .where(and(eq(partners.id, orderPartnerId as string), isNull(partners.deletedAt)))
          .limit(1);
        return row;
      });
      const preferredOrder = (settingsRow?.settings as { organizationOrder?: string[] } | undefined)
        ?.organizationOrder;
      ordered = applyOrganizationOrder(data, preferredOrder);
    } catch (err) {
      // Soft-fail: if we can't load partner settings, fall back to createdAt
      // order so the list still renders. Surface the failure to stderr and
      // Sentry so a chronically broken partner_settings read is observable
      // on-call rather than silently degrading every list response.
      console.error('[orgs.list.partnerSettings] Failed to load partner settings for org ordering', {
        partnerId: orderPartnerId,
        error: err instanceof Error ? err.message : String(err),
      });
      captureException(err, c);
    }
  }

  return c.json({
    data: ordered,
    pagination: { page, limit, total: Number(count) }
  });
});

// PATCH /organizations/order — partner-level preferred order of org IDs.
// Persists to partners.settings.organizationOrder. Idempotent; the request
// body fully replaces the current order. Unknown IDs and IDs outside the
// partner are silently dropped after server-side validation against the
// partner's full org list.
//
// Path is a literal sub-segment (not /organizations/:id/...) so it must be
// registered above the dynamic :id routes in this file; Hono matches in
// registration order. Using `/order` rather than `/reorder` avoids any
// literal-vs-param ambiguity with a future hypothetical `/:action`.
const reorderOrganizationsSchema = z.object({
  orderedIds: z.array(z.string().uuid()).max(10_000),
});

orgRoutes.patch(
  '/organizations/order',
  requireScope('partner'),
  requirePartner,
  requireOrgWrite,
  zValidator('json', reorderOrganizationsSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { orderedIds } = c.req.valid('json');
    const partnerId = auth.partnerId as string;

    // Sanitize against the full set of non-deleted orgs that belong to this
    // partner — NOT against auth.accessibleOrgIds. A partner-admin token with
    // an RBAC-restricted org subset must still be able to persist an order
    // that covers every partner org; otherwise legitimate orgs would be
    // silently dropped from the saved order whenever the actor's scope is
    // narrower than the partner's full org list.
    //
    // Use withSystemDbAccessContext to bypass RLS for this admin-level read;
    // partner-scope authority has already been enforced by requireScope and
    // requirePartner above.
    const partnerOrgs = await withSystemDbAccessContext(async () =>
      db
        .select({ id: organizations.id })
        .from(organizations)
        .where(and(eq(organizations.partnerId, partnerId), isNull(organizations.deletedAt)))
    );
    const validOrgIds = partnerOrgs.map((o) => o.id);
    const sanitized = sanitizeOrganizationOrder(orderedIds, validOrgIds);

    const [current] = await db
      .select({ settings: partners.settings })
      .from(partners)
      .where(and(eq(partners.id, partnerId), isNull(partners.deletedAt)))
      .limit(1);
    if (!current) {
      return c.json({ error: 'Partner not found' }, 404);
    }
    const currentSettings = (current.settings as Record<string, unknown>) || {};
    const newSettings = { ...currentSettings, organizationOrder: sanitized };

    const [partner] = await db
      .update(partners)
      .set({
        settings: encryptColumnValueForWrite('partners', 'settings', newSettings),
        updatedAt: new Date(),
      })
      .where(and(eq(partners.id, partnerId), isNull(partners.deletedAt)))
      .returning();
    if (!partner) {
      return c.json({ error: 'Partner not found' }, 404);
    }

    const auditOrgId = await resolveAuditOrgIdForPartner(partnerId);
    writeRouteAudit(c, {
      orgId: auditOrgId,
      action: 'partner.organizationOrder.update',
      resourceType: 'partner',
      resourceId: partner.id,
      resourceName: partner.name,
      details: { count: sanitized.length },
    });

    return c.json({ organizationOrder: sanitized });
  },
);

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
  // Creating a new organization is a tenant-creation op: the new row's id
  // can't be in the caller's accessible_org_ids yet, so the standard
  // breeze_has_org_access(id) INSERT/SELECT policies on organizations would
  // reject both the insert and its RETURNING read. The caller's
  // partner/system authority has already been checked above; escape the
  // request's auth-scoped tx via runOutsideDbContext and open a fresh
  // system-scoped tx for just this insert. Atomicity with the rest of the
  // handler isn't a concern — the only follow-up here is an audit write.
  const [organization] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () =>
      db.insert(organizations).values(insertValues).returning()
    )
  );

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
  if (data.settings !== undefined) {
    // Encrypt secret-bearing fields (e.g. logForwarding.elasticsearchApiKey)
    // before writing organizations.settings. See encryptedColumnRegistry.
    updates.settings = encryptColumnValueForWrite('organizations', 'settings', data.settings);
  }
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

  if (data.status !== undefined && data.status !== 'active' && data.status !== 'trial') {
    await revokeOrganizationTenantAccess(organization.id);
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
    .set({ status: 'churned', deletedAt: new Date(), updatedAt: new Date() })
    .where(conditions)
    .returning();

  if (!organization) {
    return c.json({ error: 'Organization not found' }, 404);
  }

  await revokeOrganizationTenantAccess(organization.id);

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

  // Precedence: the explicit `organizationId` (the resource the page is
  // managing) MUST win over `orgId`. `orgId` may be an *ambient* value the web
  // client's fetchWithAuth auto-injects rather than a user-chosen scope;
  // letting it shadow an explicit `organizationId` surfaced the wrong org's
  // sites (issue #723). Access is still gated by ensureOrgAccess below — this
  // is a precedence fix, not a tenant-isolation relaxation. See the orgId
  // auto-injection in fetchWithAuth (apps/web/src/stores/auth.ts) for the
  // mechanism that makes the ambient orgId show up here.
  const effectiveOrgId = organizationId || orgId;

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

  // Encrypt secret-bearing fields inside sites.settings before writing —
  // matches the registry walker so UI edits don't regress to plaintext.
  const writeData: Record<string, unknown> = { ...data, updatedAt: new Date() };
  if (writeData.settings !== undefined) {
    writeData.settings = encryptColumnValueForWrite('sites', 'settings', writeData.settings);
  }

  const [updated] = await db
    .update(sites)
    .set(writeData)
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
