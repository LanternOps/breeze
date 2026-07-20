import { Hono, type Context, type Next } from 'hono';
import { zValidator } from '../lib/validation';
import { z } from 'zod';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  contractLines,
  organizations,
  pax8CompanyMappings,
  pax8ContractLineLinks,
  pax8Integrations,
  pax8SubscriptionSnapshots,
} from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { encryptSecret } from '../services/secretCrypto';
import { DEFAULT_PAX8_API_BASE_URL, DEFAULT_PAX8_TOKEN_URL } from '../services/pax8Client';
import { createPax8ClientForIntegration, linkPax8SubscriptionToContractLine, mapPax8Company, unlinkPax8Subscription } from '../services/pax8SyncService';
import { enqueuePax8Sync } from '../jobs/pax8SyncWorker';
import { captureException } from '../services/sentry';
import { pax8CompanyOrderReadiness } from '../services/pax8CompanyReadiness';
import { snapshotActiveCommitmentEvidence } from '../services/pax8OrderService';
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
} from '../services/partnerWideAccess';

export const pax8Routes = new Hono();

type RouteAuth = Pick<AuthContext, 'scope' | 'partnerId' | 'orgId' | 'canAccessOrg' | 'accessibleOrgIds' | 'orgCondition'>;

function requestedPartnerId(c: { req: { query: (key: string) => string | undefined } }): string | undefined {
  return c.req.query('partnerId');
}

function resolvePartnerId(auth: RouteAuth, requested?: string): { partnerId: string } | { error: string; status: 400 | 403 } {
  if (auth.scope === 'partner') {
    if (!auth.partnerId) return { error: 'Partner context required', status: 403 };
    if (requested && requested !== auth.partnerId) return { error: 'Access to this partner denied', status: 403 };
    return { partnerId: auth.partnerId };
  }
  if (auth.scope === 'organization') {
    return { error: 'Pax8 billing integrations are managed at partner scope', status: 403 };
  }
  if (!requested) return { error: 'partnerId is required for system scope', status: 400 };
  return { partnerId: requested };
}

// Read endpoints require billing:manage intentionally: there is no separate
// billing-read permission, and Pax8 config/subscription data (vendor cost,
// credentials presence) is partner-sensitive, so we gate reads at the same
// level as writes rather than exposing it to broader billing-view roles.
const readPerm = requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action);
const writePerm = requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action);
const partnerScopes = requireScope('partner', 'system');

const integrationQuerySchema = z.object({
  partnerId: z.string().guid().optional(),
});

const upsertIntegrationSchema = z.object({
  partnerId: z.string().guid().optional(),
  name: z.string().min(1).max(200),
  clientId: z.string().min(1).max(5000).optional(),
  clientSecret: z.string().min(1).max(5000).optional(),
  apiBaseUrl: z.string().url().max(300).optional().default(DEFAULT_PAX8_API_BASE_URL),
  tokenUrl: z.string().url().max(300).optional().default(DEFAULT_PAX8_TOKEN_URL),
  webhookSecret: z.string().min(1).max(5000).optional(),
  isActive: z.boolean().optional(),
});

const syncSchema = z.object({
  partnerId: z.string().guid().optional(),
  integrationId: z.string().guid().optional(),
});

const companyQuerySchema = z.object({
  partnerId: z.string().guid().optional(),
  integrationId: z.string().guid().optional(),
});

const companyMapSchema = z.object({
  integrationId: z.string().guid(),
  pax8CompanyId: z.string().min(1).max(64),
  orgId: z.string().guid().nullable(),
  ignored: z.boolean().optional(),
});

const subscriptionQuerySchema = z.object({
  partnerId: z.string().guid().optional(),
  integrationId: z.string().guid().optional(),
  orgId: z.string().guid().optional(),
  unmappedOnly: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const linkSchema = z.object({
  integrationId: z.string().guid(),
  subscriptionSnapshotId: z.string().guid(),
  contractLineId: z.string().guid(),
  syncEnabled: z.boolean().default(false),
});

const unlinkSchema = z.object({
  integrationId: z.string().guid(),
  subscriptionSnapshotId: z.string().guid(),
});

// Defense-in-depth partner scoping for the integration-id lookups in
// /companies/map and /subscriptions/link. Forced RLS already filters a foreign
// partner's row to 0 rows for partner-scope callers, but we also pin the
// partner_id in the query so a future contextless refactor (cf. the silent
// 0-row read class, #1375/#1591) can't turn these into cross-partner reads.
// System scope intentionally omits the filter (cross-partner is allowed there).
function integrationScopeConditions(auth: RouteAuth, integrationId: string): SQL[] {
  const conditions: SQL[] = [
    eq(pax8Integrations.id, integrationId),
    eq(pax8Integrations.isActive, true),
  ];
  if (auth.scope === 'partner' && auth.partnerId) {
    conditions.push(eq(pax8Integrations.partnerId, auth.partnerId));
  }
  return conditions;
}

async function findActiveIntegration(partnerId: string, integrationId?: string) {
  const conditions: SQL[] = [
    eq(pax8Integrations.partnerId, partnerId),
    eq(pax8Integrations.isActive, true),
  ];
  if (integrationId) conditions.push(eq(pax8Integrations.id, integrationId));
  const [integration] = await db
    .select({
      id: pax8Integrations.id,
      partnerId: pax8Integrations.partnerId,
      name: pax8Integrations.name,
      apiBaseUrl: pax8Integrations.apiBaseUrl,
      tokenUrl: pax8Integrations.tokenUrl,
      isActive: pax8Integrations.isActive,
      lastSyncAt: pax8Integrations.lastSyncAt,
      lastSyncStatus: pax8Integrations.lastSyncStatus,
      lastSyncError: pax8Integrations.lastSyncError,
      createdAt: pax8Integrations.createdAt,
      updatedAt: pax8Integrations.updatedAt,
      hasClientId: sql<boolean>`(${pax8Integrations.clientIdEncrypted} is not null and ${pax8Integrations.clientIdEncrypted} != '')`,
      hasClientSecret: sql<boolean>`(${pax8Integrations.clientSecretEncrypted} is not null and ${pax8Integrations.clientSecretEncrypted} != '')`,
      hasWebhookSecret: sql<boolean>`(${pax8Integrations.webhookSecretEncrypted} is not null and ${pax8Integrations.webhookSecretEncrypted} != '')`,
    })
    .from(pax8Integrations)
    .where(and(...conditions))
    .limit(1);
  return integration ?? null;
}

pax8Routes.use('*', authMiddleware);
pax8Routes.use('*', async (c: Context, next: Next) => {
  const auth = c.get('auth') as AuthContext;
  if (!canManagePartnerWidePolicies(auth)) {
    const error = auth.scope === 'organization'
      ? 'Pax8 billing integrations are managed at partner scope'
      : PARTNER_WIDE_WRITE_DENIED_MESSAGE;
    return c.json({ error }, 403);
  }
  return next();
});

pax8Routes.get('/integration', partnerScopes, readPerm, zValidator('query', integrationQuerySchema), async (c) => {
  const auth = c.get('auth');
  const query = c.req.valid('query');
  const partner = resolvePartnerId(auth, query.partnerId ?? requestedPartnerId(c));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  return c.json({ data: await findActiveIntegration(partner.partnerId) });
});

pax8Routes.post('/integration', partnerScopes, writePerm, requireMfa(), zValidator('json', upsertIntegrationSchema), async (c) => {
  const auth = c.get('auth');
  const body = c.req.valid('json');
  const partner = resolvePartnerId(auth, body.partnerId ?? requestedPartnerId(c));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);

  const [existing] = await db
    .select()
    .from(pax8Integrations)
    .where(and(eq(pax8Integrations.partnerId, partner.partnerId), eq(pax8Integrations.isActive, true)))
    .limit(1);

  if (!existing && (!body.clientId || !body.clientSecret)) {
    return c.json({ error: 'clientId and clientSecret are required when creating a Pax8 integration' }, 400);
  }

  const clientIdEncrypted = body.clientId ? encryptSecret(body.clientId) : existing?.clientIdEncrypted ?? null;
  const clientSecretEncrypted = body.clientSecret ? encryptSecret(body.clientSecret) : existing?.clientSecretEncrypted ?? null;
  if (!clientIdEncrypted || !clientSecretEncrypted) {
    return c.json({ error: 'Pax8 credentials are missing or could not be encrypted' }, 400);
  }

  const webhookSecretEncrypted = body.webhookSecret !== undefined
    ? encryptSecret(body.webhookSecret)
    : existing?.webhookSecretEncrypted ?? null;
  const payload = {
    partnerId: partner.partnerId,
    name: body.name,
    clientIdEncrypted,
    clientSecretEncrypted,
    apiBaseUrl: body.apiBaseUrl,
    tokenUrl: body.tokenUrl,
    webhookSecretEncrypted,
    isActive: body.isActive ?? existing?.isActive ?? true,
    updatedAt: new Date(),
  };

  const [integration] = existing
    ? await db.update(pax8Integrations).set(payload).where(eq(pax8Integrations.id, existing.id)).returning()
    : await db.insert(pax8Integrations).values({
      ...payload,
      createdBy: auth.user.id,
      createdAt: new Date(),
    }).returning();

  if (!integration) return c.json({ error: 'Failed to persist Pax8 integration' }, 500);

  let syncJobId: string | null = null;
  let syncWarning: string | null = null;
  if (integration.isActive) {
    try {
      syncJobId = await enqueuePax8Sync(integration.id);
    } catch (err) {
      console.error('[pax8] failed to schedule initial sync:', err);
      captureException(err instanceof Error ? err : new Error(String(err)));
      syncWarning = 'Initial sync could not be scheduled. Data will sync on the next scheduled cycle.';
    }
  }

  writeRouteAudit(c, {
    orgId: null,
    action: existing ? 'pax8.integration.update' : 'pax8.integration.create',
    resourceType: 'pax8_integration',
    resourceId: integration.id,
    resourceName: integration.name,
    details: { partnerId: integration.partnerId, syncQueued: Boolean(syncJobId) },
  });

  return c.json({
    id: integration.id,
    partnerId: integration.partnerId,
    name: integration.name,
    apiBaseUrl: integration.apiBaseUrl,
    tokenUrl: integration.tokenUrl,
    isActive: integration.isActive,
    lastSyncAt: integration.lastSyncAt,
    lastSyncStatus: integration.lastSyncStatus,
    lastSyncError: integration.lastSyncError,
    hasClientId: true,
    hasClientSecret: true,
    hasWebhookSecret: Boolean(webhookSecretEncrypted),
    syncJobId,
    ...(syncWarning ? { syncWarning } : {}),
  }, existing ? 200 : 201);
});

pax8Routes.post('/integration/test', partnerScopes, writePerm, requireMfa(), zValidator('json', syncSchema), async (c) => {
  const auth = c.get('auth');
  const body = c.req.valid('json');
  const partner = resolvePartnerId(auth, body.partnerId ?? requestedPartnerId(c));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const integration = await findActiveIntegration(partner.partnerId, body.integrationId);
  if (!integration) return c.json({ error: 'Pax8 integration not found' }, 404);
  try {
    const { client } = await createPax8ClientForIntegration(integration.id);
    const result = await client.testConnection();
    return c.json({ success: true, data: result });
  } catch (err) {
    return c.json({ success: false, error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

pax8Routes.post('/sync', partnerScopes, writePerm, requireMfa(), zValidator('json', syncSchema), async (c) => {
  const auth = c.get('auth');
  const body = c.req.valid('json');
  const partner = resolvePartnerId(auth, body.partnerId ?? requestedPartnerId(c));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const integration = await findActiveIntegration(partner.partnerId, body.integrationId);
  if (!integration) return c.json({ error: 'Pax8 integration not found' }, 404);
  try {
    const jobId = await enqueuePax8Sync(integration.id);
    writeRouteAudit(c, {
      orgId: null,
      action: 'pax8.integration.sync',
      resourceType: 'pax8_integration',
      resourceId: integration.id,
      resourceName: integration.name,
      details: { partnerId: integration.partnerId, jobId },
    });
    return c.json({ queued: true, jobId, integrationId: integration.id });
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)));
    return c.json({ error: 'Failed to schedule Pax8 sync' }, 500);
  }
});

pax8Routes.get('/companies', partnerScopes, readPerm, zValidator('query', companyQuerySchema), async (c) => {
  const auth = c.get('auth');
  const query = c.req.valid('query');
  const partner = resolvePartnerId(auth, query.partnerId ?? requestedPartnerId(c));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const integration = await findActiveIntegration(partner.partnerId, query.integrationId);
  if (!integration) return c.json({ data: [], integrationId: null });

  const rows = await db
    .select({
      pax8CompanyId: pax8CompanyMappings.pax8CompanyId,
      pax8CompanyName: pax8CompanyMappings.pax8CompanyName,
      status: pax8CompanyMappings.status,
      mappedOrgId: pax8CompanyMappings.orgId,
      mappedOrgName: organizations.name,
      ignored: pax8CompanyMappings.ignored,
      lastSeenAt: pax8CompanyMappings.lastSeenAt,
      updatedAt: pax8CompanyMappings.updatedAt,
      metadata: pax8CompanyMappings.metadata,
    })
    .from(pax8CompanyMappings)
    .leftJoin(organizations, eq(pax8CompanyMappings.orgId, organizations.id))
    .where(eq(pax8CompanyMappings.integrationId, integration.id))
    .orderBy(pax8CompanyMappings.pax8CompanyName, pax8CompanyMappings.pax8CompanyId);
  return c.json({
    data: rows.map(({ metadata, ...row }) => ({
      ...row,
      ...pax8CompanyOrderReadiness(row.status, metadata),
    })),
    integrationId: integration.id,
  });
});

pax8Routes.post('/companies/map', partnerScopes, writePerm, requireMfa(), zValidator('json', companyMapSchema), async (c) => {
  const auth = c.get('auth');
  const body = c.req.valid('json');
  const [integration] = await db
    .select({ id: pax8Integrations.id, partnerId: pax8Integrations.partnerId, name: pax8Integrations.name })
    .from(pax8Integrations)
    .where(and(...integrationScopeConditions(auth, body.integrationId)))
    .limit(1);
  if (!integration) return c.json({ error: 'Pax8 integration not found' }, 404);
  const partner = resolvePartnerId(auth, integration.partnerId);
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  if (body.orgId && !auth.canAccessOrg(body.orgId)) return c.json({ error: 'Access to target organization denied' }, 403);

  try {
    const mapped = await mapPax8Company({
      integrationId: integration.id,
      partnerId: integration.partnerId,
      pax8CompanyId: body.pax8CompanyId,
      orgId: body.orgId,
      ignored: body.ignored,
    });
    writeRouteAudit(c, {
      orgId: body.orgId,
      action: body.orgId ? 'pax8.company.map' : 'pax8.company.unmap',
      resourceType: 'pax8_company_mapping',
      resourceName: body.pax8CompanyId,
      details: { integrationId: integration.id, partnerId: integration.partnerId, ignored: body.ignored ?? false },
    });
    return c.json({ data: mapped });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

pax8Routes.get('/subscriptions', partnerScopes, readPerm, zValidator('query', subscriptionQuerySchema), async (c) => {
  const auth = c.get('auth');
  const query = c.req.valid('query');
  const partner = resolvePartnerId(auth, query.partnerId ?? requestedPartnerId(c));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const integration = await findActiveIntegration(partner.partnerId, query.integrationId);
  if (!integration) return c.json({ data: [], integrationId: null });

  const conditions: SQL[] = [eq(pax8SubscriptionSnapshots.integrationId, integration.id)];
  if (query.orgId) {
    if (!auth.canAccessOrg(query.orgId)) return c.json({ error: 'Access to organization denied' }, 403);
    conditions.push(eq(pax8SubscriptionSnapshots.orgId, query.orgId));
  } else if (!query.unmappedOnly) {
    // No specific orgId requested and not filtering to unmapped (NULL-org) rows:
    // apply the caller's org allowlist so a partner member cannot enumerate
    // subscription snapshots (including unitPrice/unitCost/margin) for orgs
    // outside their accessibleOrgIds. System-scope callers get undefined (no
    // filter), which is the intended "see all" behaviour for operators.
    const orgFilter = auth.orgCondition(pax8SubscriptionSnapshots.orgId);
    if (orgFilter !== undefined) conditions.push(orgFilter);
  }
  if (query.unmappedOnly) conditions.push(sql`${pax8SubscriptionSnapshots.orgId} is null`);

  const rows = await db
    .select({
      id: pax8SubscriptionSnapshots.id,
      pax8SubscriptionId: pax8SubscriptionSnapshots.pax8SubscriptionId,
      pax8CompanyId: pax8SubscriptionSnapshots.pax8CompanyId,
      pax8CompanyName: pax8CompanyMappings.pax8CompanyName,
      orgId: pax8SubscriptionSnapshots.orgId,
      productId: pax8SubscriptionSnapshots.productId,
      productName: pax8SubscriptionSnapshots.productName,
      vendorName: pax8SubscriptionSnapshots.vendorName,
      vendorSkuId: pax8SubscriptionSnapshots.vendorSkuId,
      status: pax8SubscriptionSnapshots.status,
      billingTerm: pax8SubscriptionSnapshots.billingTerm,
      quantity: pax8SubscriptionSnapshots.quantity,
      quantityKnown: pax8SubscriptionSnapshots.quantityKnown,
      unitPrice: pax8SubscriptionSnapshots.unitPrice,
      unitCost: pax8SubscriptionSnapshots.unitCost,
      currencyCode: pax8SubscriptionSnapshots.currencyCode,
      lastSeenAt: pax8SubscriptionSnapshots.lastSeenAt,
      contractLineId: pax8ContractLineLinks.contractLineId,
      breezeQuantity: contractLines.manualQuantity,
      syncEnabled: pax8ContractLineLinks.syncEnabled,
      lastObservedQuantity: pax8ContractLineLinks.lastObservedQuantity,
      lastObservedAt: pax8ContractLineLinks.lastObservedAt,
      raw: pax8SubscriptionSnapshots.raw,
    })
    .from(pax8SubscriptionSnapshots)
    .leftJoin(pax8CompanyMappings, and(
      eq(pax8SubscriptionSnapshots.integrationId, pax8CompanyMappings.integrationId),
      eq(pax8SubscriptionSnapshots.pax8CompanyId, pax8CompanyMappings.pax8CompanyId),
    ))
    .leftJoin(pax8ContractLineLinks, eq(pax8SubscriptionSnapshots.id, pax8ContractLineLinks.subscriptionSnapshotId))
    .leftJoin(contractLines, and(
      eq(pax8ContractLineLinks.contractLineId, contractLines.id),
      eq(pax8ContractLineLinks.orgId, contractLines.orgId),
      eq(pax8SubscriptionSnapshots.orgId, contractLines.orgId),
    ))
    .where(and(...conditions))
    .orderBy(desc(pax8SubscriptionSnapshots.lastSeenAt))
    .limit(query.limit);

  return c.json({
    data: rows.map(({ raw, ...row }) => ({
      ...row,
      ...snapshotActiveCommitmentEvidence(raw),
    })),
    integrationId: integration.id,
  });
});

pax8Routes.post('/subscriptions/link', partnerScopes, writePerm, requireMfa(), zValidator('json', linkSchema), async (c) => {
  const auth = c.get('auth');
  const body = c.req.valid('json');
  const [integration] = await db
    .select({ id: pax8Integrations.id, partnerId: pax8Integrations.partnerId, name: pax8Integrations.name })
    .from(pax8Integrations)
    .where(and(...integrationScopeConditions(auth, body.integrationId)))
    .limit(1);
  if (!integration) return c.json({ error: 'Pax8 integration not found' }, 404);
  const partner = resolvePartnerId(auth, integration.partnerId);
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);

  const [line] = await db
    .select({ orgId: contractLines.orgId })
    .from(contractLines)
    .where(eq(contractLines.id, body.contractLineId))
    .limit(1);
  if (!line || !auth.canAccessOrg(line.orgId)) return c.json({ error: 'Access to contract line denied' }, 403);

  try {
    const link = await linkPax8SubscriptionToContractLine({
      integrationId: integration.id,
      partnerId: integration.partnerId,
      subscriptionSnapshotId: body.subscriptionSnapshotId,
      contractLineId: body.contractLineId,
      syncEnabled: body.syncEnabled,
    });
    writeRouteAudit(c, {
      orgId: line.orgId,
      action: 'pax8.subscription.link_contract_line',
      resourceType: 'pax8_subscription_snapshot',
      resourceId: body.subscriptionSnapshotId,
      details: {
        integrationId: integration.id,
        partnerId: integration.partnerId,
        contractLineId: body.contractLineId,
        syncEnabled: body.syncEnabled,
      },
    });
    return c.json({ data: link });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

pax8Routes.delete('/subscriptions/link', partnerScopes, writePerm, requireMfa(), zValidator('json', unlinkSchema), async (c) => {
  const auth = c.get('auth');
  const body = c.req.valid('json');
  const [integration] = await db
    .select({ id: pax8Integrations.id, partnerId: pax8Integrations.partnerId })
    .from(pax8Integrations)
    .where(and(...integrationScopeConditions(auth, body.integrationId)))
    .limit(1);
  if (!integration) return c.json({ error: 'Pax8 integration not found' }, 404);

  // Authorize on the subscription snapshot's org (unlink keys on the
  // subscription, and the link row may already be gone, so there is no contract
  // line to gate on). Also confirm the snapshot belongs to this integration.
  const [snapshot] = await db
    .select({ orgId: pax8SubscriptionSnapshots.orgId, integrationId: pax8SubscriptionSnapshots.integrationId })
    .from(pax8SubscriptionSnapshots)
    .where(eq(pax8SubscriptionSnapshots.id, body.subscriptionSnapshotId))
    .limit(1);
  if (!snapshot || snapshot.integrationId !== integration.id) return c.json({ error: 'Pax8 subscription not found' }, 404);
  if (snapshot.orgId && !auth.canAccessOrg(snapshot.orgId)) return c.json({ error: 'Access to subscription denied' }, 403);

  const result = await unlinkPax8Subscription({
    integrationId: integration.id,
    subscriptionSnapshotId: body.subscriptionSnapshotId,
  });
  writeRouteAudit(c, {
    orgId: snapshot.orgId ?? undefined,
    action: 'pax8.subscription.unlink_contract_line',
    resourceType: 'pax8_subscription_snapshot',
    resourceId: body.subscriptionSnapshotId,
    details: { integrationId: integration.id },
  });
  return c.json({ data: result });
});
