import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, ilike, isNotNull, sql, type SQL } from 'drizzle-orm';
import * as dbModule from '../db';
import { db } from '../db';
import {
  devices,
  huntressAgents,
  huntressIncidents,
  huntressIntegrations,
} from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import {
  findHuntressIntegrationByAccount,
  ingestHuntressWebhookPayload,
  scheduleHuntressSync,
} from '../jobs/huntressSync';
import {
  parseHuntressWebhookPayload,
  verifyHuntressWebhookSignature,
} from '../services/huntressClient';
import { decryptSecret, encryptSecret } from '../services/secretCrypto';
import { writeRouteAudit } from '../services/auditEvents';
import { PERMISSIONS } from '../services/permissions';
import { captureException } from '../services/sentry';
import { escapeLike } from '../utils/sql';
import { offlineStatusSqlList, resolvedStatusSqlList } from '../services/huntressConstants';

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    console.error('[huntress] withSystemDbAccessContext is not available — webhook DB queries may fail');
    throw new Error('System DB access context is not available');
  }
  return dbModule.withSystemDbAccessContext(fn);
};

export const huntressRoutes = new Hono();

type RouteAuth = Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>;

function resolveOrgId(
  auth: RouteAuth,
  requestedOrgId?: string
): { orgId: string } | { error: string; status: 400 | 403 } {
  if (auth.scope === 'organization') {
    if (!auth.orgId) return { error: 'Organization context required', status: 403 };
    if (requestedOrgId && requestedOrgId !== auth.orgId) {
      return { error: 'Access to this organization denied', status: 403 };
    }
    return { orgId: auth.orgId };
  }

  if (requestedOrgId) {
    if (!auth.canAccessOrg(requestedOrgId)) {
      return { error: 'Access to this organization denied', status: 403 };
    }
    return { orgId: requestedOrgId };
  }

  if (auth.orgId) return { orgId: auth.orgId };
  const orgIds = auth.accessibleOrgIds ?? [];
  if (orgIds.length === 1 && orgIds[0]) {
    return { orgId: orgIds[0] };
  }
  return { error: 'orgId is required for this scope', status: 400 };
}

function requestedOrgId(c: { req: { query: (key: string) => string | undefined } }): string | undefined {
  return c.req.query('orgId');
}

const upsertIntegrationSchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1).max(200),
  apiKey: z.string().min(1).max(5000).optional(),
  accountId: z.string().min(1).max(120).optional(),
  apiBaseUrl: z.string().url().max(300).optional().refine(
    (url) => {
      if (!url) return true;
      try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && parsed.hostname.endsWith('.huntress.io');
      } catch { return false; }
    },
    { message: 'apiBaseUrl must be a valid HTTPS Huntress API URL (*.huntress.io)' }
  ),
  webhookSecret: z.string().min(1).max(5000).optional(),
  isActive: z.boolean().optional(),
});

const syncSchema = z.object({
  orgId: z.string().uuid().optional(),
  integrationId: z.string().uuid().optional(),
});

const statusQuerySchema = z.object({
  orgId: z.string().uuid().optional(),
});

const listIncidentsQuerySchema = z.object({
  orgId: z.string().uuid().optional(),
  integrationId: z.string().uuid().optional(),
  status: z.string().max(30).optional(),
  severity: z.string().max(20).optional(),
  deviceId: z.string().uuid().optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

async function resolveWebhookIntegration(params: {
  integrationId: string | null;
  accountId: string | null;
}): Promise<
  | {
    id: string;
    orgId: string;
    webhookSecretEncrypted: string | null;
    isActive: boolean;
  }
  | { error: string; status: 404 | 409 }
> {
  if (params.integrationId) {
    const row = await runWithSystemDbAccess(async () => {
      const [row] = await db
        .select({
          id: huntressIntegrations.id,
          orgId: huntressIntegrations.orgId,
          webhookSecretEncrypted: huntressIntegrations.webhookSecretEncrypted,
          isActive: huntressIntegrations.isActive,
        })
        .from(huntressIntegrations)
        .where(eq(huntressIntegrations.id, params.integrationId!))
        .limit(1);
      return row ?? null;
    });
    if (!row || !row.isActive) {
      return { error: 'No active Huntress integration found for webhook payload', status: 404 };
    }
    return row;
  }

  if (!params.accountId) {
    return { error: 'No active Huntress integration found for webhook payload', status: 404 };
  }
  const lookup = await findHuntressIntegrationByAccount(params.accountId);
  if (lookup.status === 'none') {
    return { error: 'No active Huntress integration found for webhook payload', status: 404 };
  }
  if (lookup.status === 'ambiguous') {
    return {
      error: 'Multiple active Huntress integrations match this account. Provide integrationId in the query string or x-huntress-integration-id header.',
      status: 409
    };
  }
  return { ...lookup.integration, isActive: true };
}

// Public webhook receiver (no user auth). Signature verification applied when webhook secret is configured.
huntressRoutes.post('/webhook', async (c) => {
  const rawBody = await c.req.text();
  let payload: unknown = {};
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch (err) {
    console.warn('[huntress] Webhook received invalid JSON payload');
    return c.json({ error: 'Invalid JSON payload' }, 400);
  }

  const parsedPayload = parseHuntressWebhookPayload(payload);
  const integrationId = c.req.query('integrationId')
    ?? c.req.header('x-huntress-integration-id')
    ?? ((payload && typeof payload === 'object' && 'integrationId' in (payload as Record<string, unknown>))
      ? String((payload as Record<string, unknown>).integrationId)
      : null);
  const accountId = c.req.header('x-huntress-account-id') ?? parsedPayload.accountId;

  const integration = await resolveWebhookIntegration({
    integrationId: integrationId && integrationId !== 'undefined' ? integrationId : null,
    accountId,
  });
  if ('error' in integration) {
    return c.json({ error: integration.error }, integration.status);
  }

  // Webhook signature verification is mandatory. Reject if no secret is configured.
  if (!integration.webhookSecretEncrypted) {
    return c.json({ error: 'Webhook secret not configured for this integration. Configure a webhook secret to enable webhook ingestion.' }, 403);
  }

  const webhookSecret = decryptSecret(integration.webhookSecretEncrypted);
  if (!webhookSecret) {
    return c.json({ error: 'Webhook secret is not configured correctly' }, 401);
  }

  const signatureCheck = verifyHuntressWebhookSignature({
    secret: webhookSecret,
    payload: rawBody,
    signatureHeader: c.req.header('x-huntress-signature') ?? c.req.header('x-signature'),
    timestampHeader: c.req.header('x-huntress-timestamp') ?? c.req.header('x-timestamp'),
  });
  if (!signatureCheck.ok) {
    return c.json({ error: signatureCheck.error }, 401);
  }

  try {
    const result = await ingestHuntressWebhookPayload({
      integrationId: integration.id,
      payload,
    });

    return c.json({
      accepted: true,
      integrationId: integration.id,
      fetchedAgents: result.fetchedAgents,
      fetchedIncidents: result.fetchedIncidents,
      upsertedAgents: result.upsertedAgents,
      createdIncidents: result.createdIncidents,
      updatedIncidents: result.updatedIncidents,
    });
  } catch (error) {
    console.error('[huntress] Webhook ingestion failed:', error);
    captureException(error instanceof Error ? error : new Error(String(error)));
    return c.json({ error: 'Webhook ingestion failed' }, 500);
  }
});

// All routes below require authentication. The webhook route above is intentionally excluded.
huntressRoutes.use('*', authMiddleware);

huntressRoutes.get(
  '/integration',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveOrgId(auth, requestedOrgId(c));
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const conditions: SQL[] = [eq(huntressIntegrations.orgId, orgResult.orgId)];
    const orgCondition = auth.orgCondition(huntressIntegrations.orgId);
    if (orgCondition) conditions.push(orgCondition);

    const [integration] = await db
      .select({
        id: huntressIntegrations.id,
        orgId: huntressIntegrations.orgId,
        name: huntressIntegrations.name,
        accountId: huntressIntegrations.accountId,
        apiBaseUrl: huntressIntegrations.apiBaseUrl,
        isActive: huntressIntegrations.isActive,
        lastSyncAt: huntressIntegrations.lastSyncAt,
        lastSyncStatus: huntressIntegrations.lastSyncStatus,
        lastSyncError: huntressIntegrations.lastSyncError,
        createdAt: huntressIntegrations.createdAt,
        updatedAt: huntressIntegrations.updatedAt,
        hasApiKey: sql<boolean>`(${huntressIntegrations.apiKeyEncrypted} is not null and ${huntressIntegrations.apiKeyEncrypted} != '')`,
        hasWebhookSecret: sql<boolean>`(${huntressIntegrations.webhookSecretEncrypted} is not null)`
      })
      .from(huntressIntegrations)
      .where(and(...conditions))
      .limit(1);

    if (!integration) {
      return c.json({ data: null });
    }

    return c.json({ data: integration });
  }
);

huntressRoutes.post(
  '/integration',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('json', upsertIntegrationSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    const orgResult = resolveOrgId(auth, body.orgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const [existing] = await db
      .select()
      .from(huntressIntegrations)
      .where(eq(huntressIntegrations.orgId, orgResult.orgId))
      .limit(1);

    if (!existing && !body.apiKey) {
      return c.json({ error: 'apiKey is required when creating a Huntress integration' }, 400);
    }

    const apiKeyEncrypted = body.apiKey
      ? encryptSecret(body.apiKey)
      : existing?.apiKeyEncrypted ?? null;
    if (!apiKeyEncrypted) {
      return c.json({
        error: body.apiKey
          ? 'Failed to encrypt Huntress API key. Please contact support.'
          : 'API key is missing from the existing integration. Please provide a new API key.'
      }, body.apiKey ? 500 : 400);
    }

    const webhookSecretEncrypted = body.webhookSecret !== undefined
      ? encryptSecret(body.webhookSecret)
      : (existing?.webhookSecretEncrypted ?? null);

    const payload = {
      orgId: orgResult.orgId,
      name: body.name,
      apiKeyEncrypted,
      accountId: body.accountId ?? existing?.accountId ?? null,
      apiBaseUrl: body.apiBaseUrl ?? existing?.apiBaseUrl ?? 'https://api.huntress.io/v1',
      webhookSecretEncrypted,
      isActive: body.isActive ?? existing?.isActive ?? true,
      updatedAt: new Date(),
    };

    const [integration] = existing
      ? await db
        .update(huntressIntegrations)
        .set(payload)
        .where(eq(huntressIntegrations.id, existing.id))
        .returning({
          id: huntressIntegrations.id,
          orgId: huntressIntegrations.orgId,
          name: huntressIntegrations.name,
          accountId: huntressIntegrations.accountId,
          apiBaseUrl: huntressIntegrations.apiBaseUrl,
          isActive: huntressIntegrations.isActive,
          lastSyncAt: huntressIntegrations.lastSyncAt,
          lastSyncStatus: huntressIntegrations.lastSyncStatus,
          lastSyncError: huntressIntegrations.lastSyncError,
          createdAt: huntressIntegrations.createdAt,
          updatedAt: huntressIntegrations.updatedAt,
        })
      : await db
        .insert(huntressIntegrations)
        .values({
          ...payload,
          createdBy: auth.user.id,
          createdAt: new Date(),
        })
        .returning({
          id: huntressIntegrations.id,
          orgId: huntressIntegrations.orgId,
          name: huntressIntegrations.name,
          accountId: huntressIntegrations.accountId,
          apiBaseUrl: huntressIntegrations.apiBaseUrl,
          isActive: huntressIntegrations.isActive,
          lastSyncAt: huntressIntegrations.lastSyncAt,
          lastSyncStatus: huntressIntegrations.lastSyncStatus,
          lastSyncError: huntressIntegrations.lastSyncError,
          createdAt: huntressIntegrations.createdAt,
          updatedAt: huntressIntegrations.updatedAt,
        });

    if (!integration) {
      return c.json({ error: 'Failed to persist Huntress integration' }, 500);
    }

    let syncJobId: string | null = null;
    let syncWarning: string | null = null;
    if (integration.isActive) {
      try {
        syncJobId = await scheduleHuntressSync(integration.id);
      } catch (error) {
        console.error('[huntress] failed to schedule initial sync:', error);
        captureException(error instanceof Error ? error : new Error(String(error)));
        syncWarning = 'Initial sync could not be scheduled. Data will sync on the next scheduled cycle.';
      }
    }

    writeRouteAudit(c, {
      orgId: integration.orgId,
      action: existing ? 'huntress.integration.update' : 'huntress.integration.create',
      resourceType: 'huntress_integration',
      resourceId: integration.id,
      resourceName: integration.name,
      details: {
        active: integration.isActive,
        syncQueued: Boolean(syncJobId),
      }
    });

    return c.json({
      ...integration,
      hasApiKey: true,
      hasWebhookSecret: webhookSecretEncrypted !== null,
      syncJobId,
      ...(syncWarning ? { syncWarning } : {}),
    }, existing ? 200 : 201);
  }
);

huntressRoutes.post(
  '/sync',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('json', syncSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    const orgResult = resolveOrgId(auth, body.orgId ?? requestedOrgId(c));
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const conditions: SQL[] = [eq(huntressIntegrations.orgId, orgResult.orgId)];
    if (body.integrationId) {
      conditions.push(eq(huntressIntegrations.id, body.integrationId));
    }
    const orgCondition = auth.orgCondition(huntressIntegrations.orgId);
    if (orgCondition) conditions.push(orgCondition);

    const [integration] = await db
      .select({
        id: huntressIntegrations.id,
        orgId: huntressIntegrations.orgId,
        name: huntressIntegrations.name,
        isActive: huntressIntegrations.isActive,
      })
      .from(huntressIntegrations)
      .where(and(...conditions))
      .limit(1);

    if (!integration) {
      return c.json({ error: 'Huntress integration not found' }, 404);
    }

    if (!integration.isActive) {
      return c.json({ error: 'Integration is inactive. Activate it before syncing.' }, 400);
    }

    let jobId: string;
    try {
      jobId = await scheduleHuntressSync(integration.id);
    } catch (error) {
      console.error('[huntress] Failed to schedule sync:', error);
      captureException(error instanceof Error ? error : new Error(String(error)));
      return c.json({ error: 'Failed to schedule sync. Please try again later.' }, 500);
    }

    writeRouteAudit(c, {
      orgId: integration.orgId,
      action: 'huntress.integration.sync',
      resourceType: 'huntress_integration',
      resourceId: integration.id,
      resourceName: integration.name,
      details: { jobId }
    });

    return c.json({
      queued: true,
      jobId,
      integrationId: integration.id,
    });
  }
);

huntressRoutes.get(
  '/status',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', statusQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth, query.orgId ?? requestedOrgId(c));
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const statusConditions: SQL[] = [eq(huntressIntegrations.orgId, orgResult.orgId)];
    const statusOrgCondition = auth.orgCondition(huntressIntegrations.orgId);
    if (statusOrgCondition) statusConditions.push(statusOrgCondition);

    const [integration] = await db
      .select({
        id: huntressIntegrations.id,
        orgId: huntressIntegrations.orgId,
        name: huntressIntegrations.name,
        isActive: huntressIntegrations.isActive,
        lastSyncAt: huntressIntegrations.lastSyncAt,
        lastSyncStatus: huntressIntegrations.lastSyncStatus,
        lastSyncError: huntressIntegrations.lastSyncError,
      })
      .from(huntressIntegrations)
      .where(and(...statusConditions))
      .limit(1);

    if (!integration) {
      return c.json({
        integration: null,
        coverage: {
          totalAgents: 0,
          mappedAgents: 0,
          unmappedAgents: 0,
          offlineAgents: 0,
        },
        incidents: {
          open: 0,
          bySeverity: [],
          byStatus: [],
        }
      });
    }

    try {
      const [
        [totalAgents],
        [mappedAgents],
        [offlineAgents],
        [openIncidents],
        bySeverity,
        byStatus,
      ] = await Promise.all([
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(huntressAgents)
          .where(eq(huntressAgents.integrationId, integration.id)),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(huntressAgents)
          .where(and(eq(huntressAgents.integrationId, integration.id), isNotNull(huntressAgents.deviceId))),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(huntressAgents)
          .where(
            and(
              eq(huntressAgents.integrationId, integration.id),
              sql`coalesce(lower(${huntressAgents.status}), '') in (${sql.raw(offlineStatusSqlList())})`
            )
          ),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(huntressIncidents)
          .where(
            and(
              eq(huntressIncidents.integrationId, integration.id),
              sql`coalesce(lower(${huntressIncidents.status}), '') not in (${sql.raw(resolvedStatusSqlList())})`
            )
          ),
        db
          .select({
            severity: huntressIncidents.severity,
            count: sql<number>`count(*)::int`
          })
          .from(huntressIncidents)
          .where(eq(huntressIncidents.integrationId, integration.id))
          .groupBy(huntressIncidents.severity)
          .orderBy(desc(sql`count(*)`)),
        db
          .select({
            status: huntressIncidents.status,
            count: sql<number>`count(*)::int`
          })
          .from(huntressIncidents)
          .where(eq(huntressIncidents.integrationId, integration.id))
          .groupBy(huntressIncidents.status)
          .orderBy(desc(sql`count(*)`)),
      ]);

      const totalAgentsCount = Number(totalAgents?.count ?? 0);
      const mappedAgentsCount = Number(mappedAgents?.count ?? 0);

      return c.json({
        integration,
        coverage: {
          totalAgents: totalAgentsCount,
          mappedAgents: mappedAgentsCount,
          unmappedAgents: Math.max(totalAgentsCount - mappedAgentsCount, 0),
          offlineAgents: Number(offlineAgents?.count ?? 0),
        },
        incidents: {
          open: Number(openIncidents?.count ?? 0),
          bySeverity,
          byStatus,
        }
      });
    } catch (error) {
      console.error('[huntress] Failed to fetch status:', error);
      captureException(error instanceof Error ? error : new Error(String(error)));
      return c.json({ error: 'Failed to fetch integration status' }, 500);
    }
  }
);

huntressRoutes.get(
  '/incidents',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listIncidentsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth, query.orgId ?? requestedOrgId(c));
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    const conditions: SQL[] = [eq(huntressIncidents.orgId, orgResult.orgId)];
    if (query.integrationId) conditions.push(eq(huntressIncidents.integrationId, query.integrationId));
    if (query.status) conditions.push(eq(huntressIncidents.status, query.status));
    if (query.severity) conditions.push(eq(huntressIncidents.severity, query.severity));
    if (query.deviceId) conditions.push(eq(huntressIncidents.deviceId, query.deviceId));
    if (query.search) {
      const pattern = `%${escapeLike(query.search)}%`;
      conditions.push(ilike(huntressIncidents.title, pattern));
    }
    const orgCondition = auth.orgCondition(huntressIncidents.orgId);
    if (orgCondition) conditions.push(orgCondition);

    const where = and(...conditions);

    try {
      const [rows, [countRow]] = await Promise.all([
        db
          .select({
            id: huntressIncidents.id,
            orgId: huntressIncidents.orgId,
            integrationId: huntressIncidents.integrationId,
            deviceId: huntressIncidents.deviceId,
            deviceHostname: devices.hostname,
            huntressIncidentId: huntressIncidents.huntressIncidentId,
            severity: huntressIncidents.severity,
            category: huntressIncidents.category,
            title: huntressIncidents.title,
            description: huntressIncidents.description,
            recommendation: huntressIncidents.recommendation,
            status: huntressIncidents.status,
            reportedAt: huntressIncidents.reportedAt,
            resolvedAt: huntressIncidents.resolvedAt,
            details: huntressIncidents.details,
            createdAt: huntressIncidents.createdAt,
            updatedAt: huntressIncidents.updatedAt,
          })
          .from(huntressIncidents)
          .leftJoin(devices, eq(huntressIncidents.deviceId, devices.id))
          .where(where)
          .orderBy(desc(huntressIncidents.reportedAt), desc(huntressIncidents.createdAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(huntressIncidents)
          .where(where),
      ]);

      return c.json({
        data: rows,
        total: Number(countRow?.count ?? 0),
        limit,
        offset,
      });
    } catch (error) {
      console.error('[huntress] Failed to fetch incidents:', error);
      captureException(error instanceof Error ? error : new Error(String(error)));
      return c.json({ error: 'Failed to fetch incidents' }, 500);
    }
  }
);
