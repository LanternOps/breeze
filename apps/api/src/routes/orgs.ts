import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Context, Next } from 'hono';
import { zValidator } from '../lib/validation';
import { z } from 'zod';
import { and, eq, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { partners, organizations, sites, devices, agentVersions } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope, requirePartner, type AuthContext } from '../middleware/auth';
import { writeAuditEvent, writeRouteAudit } from '../services/auditEvents';
import { getEffectiveOrgSettings, assertNotLocked } from '../services/effectiveSettings';
import { clearPartnerScopePolicyCache } from '../oauth/partnerScopePolicy';
import { PERMISSIONS, canAccessSite, type UserPermissions } from '../services/permissions';
import {
  restoreOrganizationTenantAccess,
  restorePartnerTenantAccess,
  revokeOrganizationTenantAccess,
  revokePartnerTenantAccess,
} from '../services/tenantLifecycle';
import { applyOrganizationOrder, sanitizeOrganizationOrder } from '../services/orgOrdering';
import { captureException } from '../services/sentry';
import { encryptColumnValueForWrite } from '../services/encryptedColumnRegistry';
import { escapeLike } from '../utils/sql';
import { isAllowedLauncherScheme, isValidIanaTimezone, canonicalizeTimezone, isValidMaintenanceWindow, MAINTENANCE_WINDOW_ERROR_MESSAGE, normalizeVersionPin, PINNABLE_COMPONENTS, agentVersionPinsSchema } from '@breeze/shared';
import type { IpAllowlistStatus, SupportedLocale } from '@breeze/shared';
import { isValidIpOrCidr } from '../services/ipMatch';
import { seedSystemTicketStatuses } from '../services/ticketConfigService';
import { getTrustedClientIpOrUndefined } from '../services/clientIp';
import { canManagePartnerWidePolicies } from '../services/partnerWideAccess';
import { clearPartnerAllowlistCache, ipAllowlistMode, readPartnerAllowlist } from '../services/ipAllowlist';
import { registerOrgPortalSettingsRoutes } from './orgPortalSettings';
import { registerOrgPortalUsersRoutes } from './orgPortalUsers';
import { registerOrgTicketSettingsRoutes } from './orgTicketSettings';

/**
 * Fold the legacy `security.allowedMfaMethods` input alias into the canonical
 * `security.allowedMethods` and drop the alias key so it is never persisted.
 * Canonical wins on conflict. Mutates and returns the same settings object.
 */
function foldAllowedMfaMethodsAlias(settings: unknown): unknown {
  if (!settings || typeof settings !== 'object') return settings;
  const s = settings as Record<string, unknown>;
  const security = s.security;
  if (!security || typeof security !== 'object') return settings;
  const sec = security as Record<string, unknown>;
  if (sec.allowedMfaMethods && typeof sec.allowedMfaMethods === 'object') {
    sec.allowedMethods = {
      ...(sec.allowedMfaMethods as Record<string, unknown>),
      ...((sec.allowedMethods as Record<string, unknown> | undefined) ?? {}),
    };
    delete sec.allowedMfaMethods;
  }
  return settings;
}

export const orgRoutes = new Hono();
const requireOrgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
const requireOrgWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);
const requireSiteRead = requirePermission(PERMISSIONS.SITES_READ.resource, PERMISSIONS.SITES_READ.action);
const requireSiteWrite = requirePermission(PERMISSIONS.SITES_WRITE.resource, PERMISSIONS.SITES_WRITE.action);

const RESERVED_INBOUND_LOCAL_PARTS = new Set([
  'postmaster',
  'abuse',
  'noreply',
  'no-reply',
  'mailer-daemon',
  'webmaster',
]);

const paginationSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional()
});

/**
 * Save-time validation for agent/watchdog version pins on a `settings.defaults`
 * object (issue #2124). A pin of 'latest' / unset is always valid. A concrete
 * version must reference a registered `agent_versions` row for that component;
 * an unknown version is rejected so operators get immediate feedback rather than
 * a silent heartbeat freeze. Per-platform/arch existence is enforced later at
 * heartbeat resolution (fail-closed) — a version is legitimately registered for
 * only some platforms, so we don't reject on a per-arch basis here. Returns an
 * error message to reject with (HTTP 400), or null when the pins are clean.
 */
async function validateAgentVersionPins(defaults: unknown): Promise<string | null> {
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) return null;
  const pinsRaw = (defaults as Record<string, unknown>).agentVersionPins;
  if (pinsRaw === undefined || pinsRaw === null) return null;
  if (typeof pinsRaw !== 'object' || Array.isArray(pinsRaw)) {
    return 'agentVersionPins must be an object with optional agent/watchdog version strings.';
  }
  const pins = pinsRaw as Record<string, unknown>;
  for (const component of PINNABLE_COMPONENTS) {
    const version = normalizeVersionPin(pins[component]);
    if (version === null) continue; // unset / 'latest' → tracks global latest
    const [row] = await db
      .select({ id: agentVersions.id })
      .from(agentVersions)
      .where(and(eq(agentVersions.component, component), eq(agentVersions.version, version)))
      .limit(1);
    if (!row) {
      return `Unknown ${component} version "${version}" — pin a registered version or choose Latest.`;
    }
  }
  return null;
}

const createPartnerSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).max(100),
  type: z.enum(['msp', 'enterprise', 'internal']).optional(),
  // plan and maxDevices are managed by the billing service (via direct DB writes).
  // They are intentionally excluded from the API schema to prevent self-service changes.
  maxOrganizations: z.number().int().nullable().optional(),
  settings: z.any().optional(),
  billingEmail: z.string().email().optional()
});

// The system-scoped partner routes accept free-form settings (z.any()), but
// security.ipAllowlist entries must still be valid IPs/CIDRs — otherwise a
// platform-admin write would bypass the validation /partners/me enforces and
// store entries the matcher can never satisfy (silent fail-open).
function settingsAllowlistEntriesValid(settings: unknown): boolean {
  if (settings === null || typeof settings !== 'object') return true;
  const security = (settings as Record<string, unknown>).security;
  if (security === null || typeof security !== 'object') return true;
  const list = (security as Record<string, unknown>).ipAllowlist;
  if (list === undefined) return true;
  return Array.isArray(list) && list.every((entry) => typeof entry === 'string' && isValidIpOrCidr(entry));
}

const updatePartnerSchema = createPartnerSchema.partial().extend({
  status: z.enum(['pending', 'active', 'suspended', 'churned']).optional(),
  // Operator-only per-partner AI for Office entitlement. Settable here (system
  // scope) but NOT on /partners/me (partner scope) — partners can't self-enable.
  aiForOfficeEnabled: z.boolean().optional(),
  settings: z.any().optional().refine(settingsAllowlistEntriesValid, {
    message: 'Each IP allowlist entry must be a valid IP address or CIDR range',
  }),
});

// PATCH /partners/:id writes the settings column wholesale. A write whose
// settings (or security object) simply omits `ipAllowlist` must not silently
// delete an active allowlist (fail-open); an explicit `ipAllowlist: []` still
// clears it deliberately. (/partners/me instead deep-merges `security`, which
// gives the same guarantee there.)
function preserveIpAllowlistOnOmit(
  currentSettings: unknown,
  incomingSettings: Record<string, unknown>,
): Record<string, unknown> {
  const currentSecurity = (currentSettings as Record<string, unknown> | null | undefined)?.security;
  const currentList = (currentSecurity as Record<string, unknown> | null | undefined)?.ipAllowlist;
  if (!Array.isArray(currentList) || currentList.length === 0) return incomingSettings;

  const incomingSecurity = incomingSettings.security;
  if (
    incomingSecurity !== undefined
    && (incomingSecurity === null || typeof incomingSecurity !== 'object' || Array.isArray(incomingSecurity))
  ) {
    return incomingSettings; // malformed security value — leave the write as-is
  }
  const security = (incomingSecurity ?? {}) as Record<string, unknown>;
  if ('ipAllowlist' in security) return incomingSettings; // explicit value (incl. []) wins
  return { ...incomingSettings, security: { ...security, ipAllowlist: currentList } };
}

const createOrganizationSchema = z.object({
  partnerId: z.string().guid().optional(),
  name: z.string().min(1),
  slug: z.string().min(1).max(100),
  type: z.enum(['customer', 'internal']).optional(),
  status: z.enum(['active', 'suspended', 'trial', 'churned']).optional(),
  // maxDevices is managed by the billing service — excluded from API schema
  settings: z.any().optional(),
  contractStart: z.string().nullable().optional(),
  contractEnd: z.string().nullable().optional(),
  billingContact: z.any().optional()
});

const updateOrganizationSchema = createOrganizationSchema.partial().omit({ partnerId: true });

const listSitesSchema = z.object({
  orgId: z.string().guid().optional(),
  organizationId: z.string().guid().optional(), // Alias for orgId (frontend compatibility)
  page: z.string().optional(),
  limit: z.string().optional()
});

// IANA timezone validation lives in @breeze/shared (`isValidIanaTimezone`) so
// the API route, workers, and web all share one implementation (issue #1318).

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
  orgId: z.string().guid(),
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
  // M8: fold the legacy `security.allowedMfaMethods` alias into the canonical
  // `security.allowedMethods` on CREATE too — the update paths already do, and
  // without this a create carrying the alias persists a key the resolver ignores
  // (silent no-op the alias-fold set out to kill).
  data.settings = foldAllowedMfaMethodsAlias(data.settings);

  const clash = await db
    .select({ id: partners.id })
    .from(partners)
    .where(and(
      or(eq(partners.inboundLocalPart, data.slug), eq(partners.slug, data.slug)),
      isNull(partners.deletedAt)
    ))
    .limit(1);
  if (clash[0]) {
    return c.json({ error: 'That partner identifier is already in use' }, 409);
  }

  const [partner] = await db.transaction(async (tx) => {
    const [newPartner] = await tx
      .insert(partners)
      .values({
        name: data.name,
        slug: data.slug,
        type: data.type,
        maxOrganizations: data.maxOrganizations,
        settings: data.settings,
        billingEmail: data.billingEmail
      })
      .returning();
    if (newPartner) {
      await seedSystemTicketStatuses(tx, newPartner.id);
    }
    return [newPartner];
  });

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

const supportedLocales = ['en', 'pt-BR', 'es-419', 'fr-FR', 'de-DE'] as const satisfies readonly SupportedLocale[];

const partnerSettingsSchema = z.object({
  // Partner tz is the canonical default for every downstream tz field (#1318),
  // so police it as a real IANA zone on write (was previously unvalidated).
  timezone: z.string().refine(isValidIanaTimezone, 'Invalid IANA timezone').optional(),
  dateFormat: z.enum(['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD']).optional(),
  timeFormat: z.enum(['12h', '24h']).optional(),
  language: z.enum(supportedLocales).optional(),
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
    // Legacy input alias. Accepted so older clients don't 400, folded into
    // `allowedMethods` at write time (foldAllowedMfaMethodsAlias) and never
    // persisted as a second source of truth.
    allowedMfaMethods: z.object({ totp: z.boolean().optional(), sms: z.boolean().optional() }).optional(),
    sessionTimeout: z.number().int().min(1).optional(),
    maxSessions: z.number().int().min(1).optional(),
    ipAllowlist: z
      .array(z.string())
      .optional()
      .refine(
        (list) => !list || list.every((entry) => isValidIpOrCidr(entry)),
        { message: 'Each IP allowlist entry must be a valid IP address or CIDR range' },
      ),
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
    // Reject malformed windows on the partner (/partners/me) write path at save
    // time (issue #1963), for consistency with the org route. As of issue #2123
    // the agent heartbeat gate reads the EFFECTIVE settings (partner defaults
    // merged over org-local; see getOrgAgentUpdatePolicy), so a partner-locked
    // window now reaches the gate directly — this save-time check protects it
    // just as the org-route check does. Accepts the "24/7"/empty always-state or
    // a "[Day ]HH:MM-HH:MM" window.
    maintenanceWindow: z.string().max(64).optional().refine(
      (v) => v === undefined || isValidMaintenanceWindow(v),
      { message: MAINTENANCE_WINDOW_ERROR_MESSAGE },
    ),
    // Per-component update version pins (issue #2124). Structural check only;
    // the "version must be registered" check needs a DB lookup and is done in
    // the handler via validateAgentVersionPins (same as the org PATCH path).
    agentVersionPins: agentVersionPinsSchema.optional(),
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
  organizationOrder: z.array(z.string().guid()).max(10_000).optional(),
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
  // PATCH /partners/me deep-merges `ticketing` one level (see the handler), so a
  // future sibling like `ticketing.outbound` survives — but the `inbound` sub-object
  // is replaced wholesale, so the card must send the COMPLETE ticketing.inbound
  // object each time (incl. the `address` self-hosted override read back via
  // getTicketConfig).
  ticketing: z.object({
    inbound: z.object({
      enabled: z.boolean().optional(),
      address: z.string().email().optional().or(z.literal('')),
      defaultTriageOrgId: z.string().guid().nullable().optional(),
      autoresponderEnabled: z.boolean().optional(),
      // Unknown-sender routing. `unknownSenderMode` is the current 3-way control;
      // `triageUnknownSenders` is the legacy boolean still accepted for back-compat
      // (loadPartnerInboundPolicy maps it true→'triage'). The card now sends
      // `unknownSenderMode`, which retires the legacy key on the next save (the
      // inbound sub-object is replaced wholesale).
      unknownSenderMode: z.enum(['quarantine', 'triage', 'drop']).optional(),
      triageUnknownSenders: z.boolean().optional(),
      // When true, senders failing the SPF/DKIM/DMARC gate are dropped silently
      // instead of quarantined. Default-off; applies to all unverified senders.
      dropUnverifiedSenders: z.boolean().optional(),
      autoresponseSubject: z.string().max(200).nullable().optional(),
      autoresponseBody: z.string().max(5000).nullable().optional(),
    }).optional(),
  }).optional(),
});

const updatePartnerSettingsSchema = z.object({
  settings: partnerSettingsSchema.optional(),
  name: z.string().min(1).optional(),
  billingEmail: z.string().email().optional(),
  // Plain-text signature appended to outbound customer emails (quote sends).
  emailSignature: z.string().max(2000).nullable().optional(),
  inboundLocalPart: z
    .string()
    .max(63)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Use lowercase letters, numbers, and hyphens only')
    .nullable()
    .optional()
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

orgRoutes.get('/partners/me/ip-allowlist/status', requireScope('partner'), requirePartner, requireOrgRead, async (c) => {
  const auth = c.get('auth');
  const partnerId = auth.partnerId as string;

  const currentIp = getTrustedClientIpOrUndefined(c) ?? null;
  const allowlist = await readPartnerAllowlist(partnerId);
  const enforced = ipAllowlistMode() === 'enforce' && allowlist.length > 0;
  const proxyTrustOk = currentIp !== null;

  // Typed against the shared contract so a field rename breaks this build too.
  const status: IpAllowlistStatus = {
    currentIp,
    proxyTrustOk,
    enforced,
    active: enforced && proxyTrustOk,
  };
  return c.json(status);
});

// Update own partner settings (for partner-scoped users)
orgRoutes.patch(
  '/partners/me',
  requireScope('partner'),
  requirePartner,
  requireOrgWrite,
  requireMfa(),
  zValidator('json', updatePartnerSettingsSchema, (result, c) => {
    if (!result.success && result.error.issues.some((issue) => issue.path[0] === 'inboundLocalPart')) {
      return c.json({ error: 'Use lowercase letters, numbers, and hyphens only' }, 422);
    }
  }),
  async (c) => {
  const auth = c.get('auth');
  const body = c.req.valid('json');

  // Agent/watchdog version pins (issue #2124) — reject unknown versions at save
  // time so a partner-locked pin can't silently freeze every child org's fleet.
  // Mirrors the org PATCH path; the zod schema already checked the shape.
  const pinError = await validateAgentVersionPins(body.settings?.defaults);
  if (pinError) {
    return c.json({ error: pinError }, 400);
  }

  // Get current partner to merge settings
  const [current] = await db
    .select()
    .from(partners)
    .where(and(eq(partners.id, auth.partnerId as string), isNull(partners.deletedAt)))
    .limit(1);

  if (!current) {
    return c.json({ error: 'Partner not found' }, 404);
  }

  // Merge settings (top-level shallow merge, except `security` and `ticketing` below)
  const currentSettings = (current.settings as Record<string, unknown>) || {};
  const newSettings: Record<string, unknown> = body.settings
    ? { ...currentSettings, ...body.settings }
    : { ...currentSettings };

  // Deep-merge the `security` sub-object: it carries many sibling fields (MFA
  // policy, session limits, ipAllowlist, ...), so a wholesale replace would let
  // a PATCH that merely omits `ipAllowlist` silently delete an active allowlist
  // (fail-open). Incoming security fields still override individually, and an
  // explicit `ipAllowlist: []` still clears the list deliberately.
  if (body.settings?.security) {
    foldAllowedMfaMethodsAlias(body.settings); // canonicalize before deep-merge
    newSettings.security = {
      ...((currentSettings.security as Record<string, unknown> | undefined) ?? {}),
      ...body.settings.security,
    };
  }

  // Deep-merge the `ticketing` sub-object one level for the same reason: today it
  // holds only `inbound` (the email-to-ticket settings card sends the COMPLETE
  // `inbound` object, so replacing that key wholesale is intended), but a future
  // sibling (e.g. `ticketing.outbound`) must NOT be silently wiped by a PATCH that
  // only carries `ticketing.inbound`. Sub-keys present in the body still override.
  if (body.settings?.ticketing) {
    newSettings.ticketing = {
      ...((currentSettings.ticketing as Record<string, unknown> | undefined) ?? {}),
      ...body.settings.ticketing,
    };
  }

  // Tenant-isolation guard: defaultTriageOrgId is stored verbatim, but the
  // future auto-triage path will route mail INTO that org. A cross-partner id
  // here would route a partner's inbound mail to an org outside their tenant.
  // Validate it references an org in THIS partner (the read runs under the
  // request RLS context, so the partner_id equality is the security boundary).
  const triageOrgId = body.settings?.ticketing?.inbound?.defaultTriageOrgId;
  if (typeof triageOrgId === 'string') {
    const [orgOk] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.id, triageOrgId), eq(organizations.partnerId, auth.partnerId as string)))
      .limit(1);
    if (!orgOk) {
      return c.json({ error: 'defaultTriageOrgId must reference an organization in your partner' }, 400);
    }
  }

  // Enable-gate: turning the allowlist on (empty -> non-empty) requires that
  // the API can actually see real client IPs, otherwise enforcement would
  // silently fail open (false security).
  const prevAllowlist = ((((current.settings as Record<string, unknown>)?.security) as Record<string, unknown>)?.ipAllowlist) as string[] | undefined;
  const nextAllowlist = ((newSettings.security as Record<string, unknown>)?.ipAllowlist) as string[] | undefined;
  const turningOn = (!prevAllowlist || prevAllowlist.length === 0) && Array.isArray(nextAllowlist) && nextAllowlist.length > 0;
  if (turningOn && getTrustedClientIpOrUndefined(c) === undefined) {
    return c.json(
      {
        code: 'proxy_trust_required',
        error:
          'Configure proxy trust (TRUST_PROXY_HEADERS + TRUSTED_PROXY_CIDRS) before enabling the IP allowlist, so the API can see real client IPs.',
      },
      400,
    );
  }

  // Encrypt secret-bearing fields (e.g. remoteAccessProviders[*].password)
  // BEFORE writing. Without this, every PATCH from the UI would regress the
  // column to plaintext between deploy-day batch re-encrypt runs.
  const updateData: Record<string, unknown> = {
    settings: encryptColumnValueForWrite('partners', 'settings', newSettings),
    updatedAt: new Date()
  };

  if (body.name) updateData.name = body.name;
  if (body.billingEmail) updateData.billingEmail = body.billingEmail;
  // Explicit null (or an all-whitespace value) clears the signature.
  if (body.emailSignature !== undefined) updateData.emailSignature = body.emailSignature?.trim() || null;
  if (body.inboundLocalPart !== undefined) {
    if (body.inboundLocalPart === null) {
      updateData.inboundLocalPart = null;
    } else {
      const candidate = body.inboundLocalPart.toLowerCase();
      if (RESERVED_INBOUND_LOCAL_PARTS.has(candidate)) {
        return c.json({ error: 'That inbound address is reserved' }, 422);
      }
      const clash = await db
        .select({ id: partners.id })
        .from(partners)
        .where(and(
          or(eq(partners.inboundLocalPart, candidate), eq(partners.slug, candidate)),
          ne(partners.id, auth.partnerId as string),
          isNull(partners.deletedAt)
        ))
        .limit(1);
      if (clash[0]) {
        return c.json({ error: 'That inbound address is already taken' }, 409);
      }
      updateData.inboundLocalPart = candidate;
    }
  }

  // Keep the first-class `partners.timezone` column in sync with the legacy
  // `settings.timezone` JSONB key the UI writes (issue #1318). The column is the
  // source of truth for `resolveEffectiveTimezone`; the validator above already
  // guarantees a valid IANA zone here, and canonicalizeTimezone folds any UTC
  // casing ('utc' -> 'UTC') so the sentinel comparison in the resolver holds.
  if (typeof body.settings?.timezone === 'string' && body.settings.timezone.length > 0) {
    const canonicalTz = canonicalizeTimezone(body.settings.timezone);
    if (canonicalTz !== null) {
      updateData.timezone = canonicalTz;
    }
  }

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
  clearPartnerAllowlistCache(partner.id);

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

  if (data.slug !== undefined) {
    const clash = await db
      .select({ id: partners.id })
      .from(partners)
      .where(and(
        or(eq(partners.inboundLocalPart, data.slug), eq(partners.slug, data.slug)),
        ne(partners.id, id),
        isNull(partners.deletedAt)
      ))
      .limit(1);
    if (clash[0]) {
      return c.json({ error: 'That partner identifier is already in use' }, 409);
    }
  }

  if (updates.settings !== undefined) {
    // Fold the legacy `security.allowedMfaMethods` alias into the canonical
    // `security.allowedMethods` before anything else touches settings. This
    // is a wholesale-replace path (updatePartnerSchema uses `settings: z.any()`),
    // so without this fold a caller sending the alias key here would persist
    // it verbatim as a second, un-canonicalized key — the resolver only reads
    // `security.allowedMethods`, so that would silently no-op the MFA-method
    // change (see foldAllowedMfaMethodsAlias above).
    updates.settings = foldAllowedMfaMethodsAlias(updates.settings);

    // Wholesale settings write: keep an active security.ipAllowlist unless the
    // caller explicitly clears it (see preserveIpAllowlistOnOmit).
    if (updates.settings && typeof updates.settings === 'object' && !Array.isArray(updates.settings)) {
      const [currentPartner] = await db
        .select()
        .from(partners)
        .where(and(eq(partners.id, id), isNull(partners.deletedAt)))
        .limit(1);
      if (currentPartner) {
        updates.settings = preserveIpAllowlistOnOmit(
          currentPartner.settings,
          updates.settings as Record<string, unknown>,
        );
      }

      // Keep the first-class `partners.timezone` column in sync with the
      // settings.timezone JSONB key on this system-scoped wholesale write — the
      // same mirroring PATCH /partners/me does (issue #1318). Without this, a
      // platform-admin settings write would update the JSONB key but leave the
      // column stale, and resolveEffectiveTimezone reads the column first, so
      // the partner-tz default would silently desync.
      //
      // updatePartnerSchema uses `settings: z.any()`, so unlike /partners/me
      // there is no zod IANA refine here. Validate the tz on the system path
      // too: an invalid value (e.g. 'Mars/Olympus_Mons') must be REJECTED, not
      // silently dropped — otherwise canonicalizeTimezone(null) skips the column
      // write while the garbage persists in the JSONB, the exact column<->
      // settings desync #1318 exists to prevent. canonicalizeTimezone folds any
      // UTC casing ('utc' -> 'UTC') and returns null for a non-IANA value.
      // Read the value BEFORE encryption (settings is plaintext here).
      const settingsObj = updates.settings as Record<string, unknown>;
      const rawTz = settingsObj.timezone;
      if (rawTz !== undefined && rawTz !== null) {
        const canonicalTz = canonicalizeTimezone(rawTz);
        if (canonicalTz === null) {
          return c.json({ error: 'Invalid IANA timezone in settings.timezone' }, 400);
        }
        // Write the canonical form back into settings so the JSONB and the
        // column hold the identical value (e.g. 'utc' is normalized to 'UTC' in
        // both places, never one casing in JSONB and another in the column).
        settingsObj.timezone = canonicalTz;
        updates.timezone = canonicalTz;
      }
    }
    // Encrypt secret-bearing fields in partners.settings before writing.
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
  // Settings writes can change security.ipAllowlist — drop the 30s cache so
  // enforcement picks up the new list immediately (mirrors /partners/me).
  if (data.settings !== undefined) {
    clearPartnerAllowlistCache(partner.id);
  }
  // Only the terminal-ish states sever the fleet. `pending` is reversible
  // (signup/billing limbo) and is already blocked for agents by the live
  // tenant cascade (getActivePartner is strict) — severing here would expire
  // enrollment keys irreversibly on a transient state.
  if ('status' in data && (data.status === 'suspended' || data.status === 'churned')) {
    await revokePartnerTenantAccess(partner.id);
  } else if ('status' in data && data.status === 'active') {
    // Reactivation: restore agent tokens this partner's revoke suspended.
    await restorePartnerTenantAccess(partner.id);
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
  partnerId: z.string().guid().optional(),
  page: z.string().optional(),
  limit: z.string().optional(),
  search: z.string().optional()
});

// Org-scope callers may read their OWN org's name-level row without the
// organizations:read permission (UI shell / tickets cold load, #1245 residual)
// — every org user implicitly needs their org's name to render the app shell.
// Partner/system scope still requires the permission: they list many orgs and
// receive full rows. The handler's organization branch is hard-scoped to
// auth.orgId and projects to safe fields only.
const requireOrgReadUnlessOwnOrg = async (c: Context, next: Next) => {
  const auth = c.get('auth') as AuthContext | undefined;
  if (!auth) throw new HTTPException(401, { message: 'Not authenticated' });
  if (auth.scope === 'organization') return next();
  return requireOrgRead(c, next);
};

orgRoutes.get('/organizations', requireScope('organization', 'partner', 'system'), requireOrgReadUnlessOwnOrg, zValidator('query', listOrganizationsSchema), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const { partnerId: queryPartnerId, search, ...pagination } = c.req.valid('query');
  const { page, limit, offset } = getPagination(pagination);
  const trimmedSearch = search?.trim();
  const searchCondition = trimmedSearch
    ? ilike(organizations.name, `%${escapeLike(trimmedSearch)}%`)
    : undefined;

  if (auth.scope === 'organization') {
    // Organization-scoped users can only see their own organization, and —
    // because they reach this route without organizations:read (see
    // requireOrgReadUnlessOwnOrg above) — only a name-level projection of it.
    // An unprojected select() here would leak ssoConfig, billingContact,
    // settings, maxDevices, etc. to roles that never held the permission.
    if (!auth.orgId) {
      return c.json({ data: [], pagination: { page, limit, total: 0 } });
    }
    const ownOrgCondition = and(eq(organizations.id, auth.orgId), isNull(organizations.deletedAt));
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(organizations)
      .where(ownOrgCondition);
    const data = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        status: organizations.status
      })
      .from(organizations)
      .where(ownOrgCondition)
      .limit(limit)
      .offset(offset)
      .orderBy(organizations.createdAt);
    return c.json({
      data,
      pagination: { page, limit, total: Number(countResult[0]?.count ?? 0) }
    });
  }

  let conditions;
  if (auth.scope === 'partner') {
    const orgIds = auth.accessibleOrgIds ?? [];
    if (orgIds.length === 0) {
      return c.json({
        data: [],
        pagination: { page, limit, total: 0 }
      });
    }
    conditions = and(inArray(organizations.id, orgIds), isNull(organizations.deletedAt), searchCondition);
  } else {
    conditions = queryPartnerId
      ? and(eq(organizations.partnerId, queryPartnerId), isNull(organizations.deletedAt), searchCondition)
      : and(isNull(organizations.deletedAt), searchCondition);
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
  // (organization scope already returned above — at most one row anyway.)
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
  orderedIds: z.array(z.string().guid()).max(10_000),
});

orgRoutes.patch(
  '/organizations/order',
  requireScope('partner'),
  requirePartner,
  requireOrgWrite,
  zValidator('json', reorderOrganizationsSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    if (!canManagePartnerWidePolicies(auth)) {
      return c.json({ error: 'Full partner access required' }, 403);
    }
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
  // M8: canonicalize the MFA allowed-methods alias on CREATE (see /partners).
  data.settings = foldAllowedMfaMethodsAlias(data.settings);

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

  if (data.settings) {
    const settingsObj = data.settings as Record<string, unknown>;
    foldAllowedMfaMethodsAlias(data.settings);

    // Reject a malformed agent-update maintenance window before any DB work
    // (issue #1963). This is the path getOrgAgentUpdatePolicy reads, so without
    // this check a typo'd window would silently fail the heartbeat gate open.
    // The org `settings` blob is `z.any()`, so the window is the one field
    // validated explicitly here rather than in updateOrganizationSchema.
    const defaults = settingsObj.defaults;
    if (defaults && typeof defaults === 'object') {
      const mw = (defaults as Record<string, unknown>).maintenanceWindow;
      // null/undefined clears the window (treated as the always state); any
      // present value must be a valid window string.
      if (mw !== undefined && mw !== null && (typeof mw !== 'string' || !isValidMaintenanceWindow(mw))) {
        return c.json({ error: MAINTENANCE_WINDOW_ERROR_MESSAGE }, 400);
      }

      // Agent/watchdog version pins (issue #2124) — reject unknown versions at
      // save time. Same rationale as the window check: the org `settings` blob
      // is `z.any()`, so pins are validated explicitly here rather than in the
      // schema, and this is the path getOrgAgentUpdateConfig reads at heartbeat.
      const pinError = await validateAgentVersionPins(defaults);
      if (pinError) {
        return c.json({ error: pinError }, 400);
      }
    }

    // Enforce partner locks on settings categories (after auth check).
    for (const category of ['security', 'notifications', 'eventLogs', 'defaults', 'branding']) {
      if (settingsObj[category] && typeof settingsObj[category] === 'object') {
        let fields = Object.keys(settingsObj[category] as Record<string, unknown>);
        // Issue #2124: `agentVersionPins` is INHERIT-WITH-OVERRIDE, not partner-
        // locked — an org may override the partner's pinned version (that's what
        // lets a partner pilot a new version on one org). So it is deliberately
        // exempt from the lock model here; a partner pin is only a default, and
        // getOrgAgentUpdateConfig resolves org-over-partner. Do NOT "fix" this
        // back to a lock without a per-field enforcement flag.
        if (category === 'defaults') {
          fields = fields.filter((f) => f !== 'agentVersionPins');
        }
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
  } else if (data.status === 'active' || data.status === 'trial') {
    // Reactivation: restore agent tokens this org's revoke suspended.
    await restoreOrganizationTenantAccess(organization.id);
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

// Customer-portal settings (portal_branding) — see routes/orgPortalSettings.ts
registerOrgPortalSettingsRoutes(orgRoutes);
// Customer-portal users (portal_users invite/manage) — see routes/orgPortalUsers.ts
registerOrgPortalUsersRoutes(orgRoutes);
// Org ticketing overrides (org_ticket_settings) — see routes/orgTicketSettings.ts
registerOrgTicketSettingsRoutes(orgRoutes);

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

  // Per-user site confinement. ensureOrgAccess (above) is org-axis only and
  // RLS on `sites` is also org-axis only, so a site-confined user would
  // otherwise enumerate every sibling site in the org. Intersect the org
  // filter with allowedSiteIds. Mirrors the allowedSiteIds intersection in the
  // GET /scripts/:id/executions list handler.
  const permissions = c.get('permissions') as UserPermissions | undefined;
  const allowedSiteIds = permissions?.allowedSiteIds;
  if (allowedSiteIds?.length === 0) {
    return c.json({ data: [], pagination: { page, limit, total: 0 } });
  }

  const baseCondition = conditions ?? sql`true`;
  const whereCondition = allowedSiteIds
    ? and(baseCondition, inArray(sites.id, allowedSiteIds))
    : baseCondition;

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

  // Enrich each site with its device count. The `sites` row carries no count
  // column, so without this the API omits `deviceCount` entirely and the web
  // SiteList (which renders `site.deviceCount` with no fallback) shows a blank
  // count for every site even when the org has devices (issue #1790). Compute
  // it with a single grouped query over the returned page's site ids —
  // `devices` is org-scoped under RLS so this stays tenant-isolated. Guard on a
  // non-empty page so an empty list never issues a `site_id IN ()` query.
  const deviceCountBySite = new Map<string, number>();
  const siteIds = data.map((s) => s.id);
  if (siteIds.length > 0) {
    const counts = await db
      .select({ siteId: devices.siteId, count: sql<number>`count(*)` })
      .from(devices)
      .where(inArray(devices.siteId, siteIds))
      .groupBy(devices.siteId);
    for (const row of counts) {
      deviceCountBySite.set(row.siteId, Number(row.count));
    }
  }

  const dataWithCounts = data.map((site) => ({
    ...site,
    deviceCount: deviceCountBySite.get(site.id) ?? 0
  }));

  return c.json({
    data: dataWithCounts,
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

  const permissions = c.get('permissions') as UserPermissions | undefined;
  if (permissions?.allowedSiteIds && !canAccessSite(permissions, site.id)) {
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

  const permissions = c.get('permissions') as UserPermissions | undefined;
  if (permissions?.allowedSiteIds && !canAccessSite(permissions, site.id)) {
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

  // A 0-row write here means the RLS UPDATE policy rejected it even though the
  // prior SELECT + ensureOrgAccess passed (RLS/app mismatch or a race). Surface
  // it instead of returning 200 + null, which reads to the client as a success.
  if (!updated) {
    return c.json({ error: 'Failed to update site' }, 500);
  }

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

  const permissions = c.get('permissions') as UserPermissions | undefined;
  if (permissions?.allowedSiteIds && !canAccessSite(permissions, site.id)) {
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
