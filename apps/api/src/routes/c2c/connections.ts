import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db';
import { c2cConnections } from '../../db/schema';
import { requireMfa, requirePermission } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { captureException } from '../../services/sentry';
import { ensureFreshToken } from '../../services/c2cM365';
import { decryptSecret, encryptSecret } from '../../services/secretCrypto';
import { createConnectionSchema, idParamSchema } from './schemas';
import { resolveScopedOrgId, maskSecret } from './helpers';
import { PERMISSIONS } from '../../services/permissions';

export const connectionsRoutes = new Hono();
const requireC2cRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
const requireC2cWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);

// ── List connections ────────────────────────────────────────────────────────

connectionsRoutes.get('/connections', requireC2cRead, async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
  if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

  const rows = await db
    .select()
    .from(c2cConnections)
    .where(eq(c2cConnections.orgId, orgId));

  return c.json({ data: rows.map(toConnectionResponse) });
});

// ── Get single connection ───────────────────────────────────────────────────

connectionsRoutes.get(
  '/connections/:id',
  requireC2cRead,
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const { id } = c.req.valid('param');
    const [row] = await db
      .select()
      .from(c2cConnections)
      .where(and(eq(c2cConnections.id, id), eq(c2cConnections.orgId, orgId)))
      .limit(1);

    if (!row) return c.json({ error: 'Connection not found' }, 404);
    return c.json(toConnectionResponse(row));
  }
);

// ── Create connection ───────────────────────────────────────────────────────

connectionsRoutes.post(
  '/connections',
  requireC2cWrite,
  requireMfa(),
  zValidator('json', createConnectionSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const payload = c.req.valid('json');

    // platform_app connections are only created via the consent callback flow
    if (payload.authMethod === 'platform_app') {
      return c.json({ error: 'platform_app connections must be created via the consent flow' }, 400);
    }

    const now = new Date();

    const [row] = await db
      .insert(c2cConnections)
      .values({
        orgId,
        provider: payload.provider,
        authMethod: 'manual',
        displayName: payload.displayName,
        tenantId: payload.tenantId ?? null,
        clientId: payload.clientId ?? null,
        clientSecret: encryptSecret(payload.clientSecret),
        scopes: payload.scopes ?? null,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!row) return c.json({ error: 'Failed to create connection' }, 500);

    writeRouteAudit(c, {
      orgId,
      action: 'c2c.connection.create',
      resourceType: 'c2c_connection',
      resourceId: row.id,
      resourceName: row.displayName,
      details: { provider: row.provider },
    });

    return c.json(toConnectionResponse(row), 201);
  }
);

// ── Delete (revoke) connection ──────────────────────────────────────────────

connectionsRoutes.delete(
  '/connections/:id',
  requireC2cWrite,
  requireMfa(),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const { id } = c.req.valid('param');
    const [row] = await db
      .update(c2cConnections)
      .set({ status: 'revoked', updatedAt: new Date() })
      .where(and(eq(c2cConnections.id, id), eq(c2cConnections.orgId, orgId)))
      .returning();

    if (!row) return c.json({ error: 'Connection not found' }, 404);

    writeRouteAudit(c, {
      orgId,
      action: 'c2c.connection.revoke',
      resourceType: 'c2c_connection',
      resourceId: row.id,
      resourceName: row.displayName,
    });

    return c.json({ deleted: true });
  }
);

// ── Test connection ─────────────────────────────────────────────────────────

connectionsRoutes.post(
  '/connections/:id/test',
  requireC2cWrite,
  requireMfa(),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const { id } = c.req.valid('param');
    const [row] = await db
      .select()
      .from(c2cConnections)
      .where(and(eq(c2cConnections.id, id), eq(c2cConnections.orgId, orgId)))
      .limit(1);

    if (!row) return c.json({ error: 'Connection not found' }, 404);

    const checkedAt = new Date().toISOString();
    let testStatus: 'success' | 'failed' = row.status === 'active' ? 'success' : 'failed';
    let message = row.status === 'active'
      ? 'Connection is active and credentials are configured'
      : `Connection status is ${row.status}`;

    // For platform_app connections, try to refresh token and validate via Graph API
    if (row.authMethod === 'platform_app' && row.tenantId) {
      try {
        const tokenResult = await ensureFreshToken({
          tenantId: row.tenantId,
          currentToken: decryptSecret(row.accessToken),
          tokenExpiresAt: row.tokenExpiresAt,
        });

        if (tokenResult) {
          // Update stored token if refreshed (scoped to orgId for defense-in-depth)
          const tokenExpiresAt = new Date(Date.now() + tokenResult.expiresIn * 1000);
          await db
            .update(c2cConnections)
            .set({ accessToken: encryptSecret(tokenResult.accessToken), tokenExpiresAt, updatedAt: new Date() })
            .where(and(eq(c2cConnections.id, row.id), eq(c2cConnections.orgId, orgId)));

          testStatus = 'success';
          message = 'Platform app token is valid and Graph API is accessible';
        } else {
          testStatus = 'failed';
          message = 'Multi-tenant app is no longer configured on this instance';
        }
      } catch (err) {
        console.error('[c2c/connections/test] Token refresh failed', {
          connectionId: row.id, orgId, tenantId: row.tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
        captureException(err);
        testStatus = 'failed';
        message = err instanceof Error ? err.message : 'Token refresh failed';
      }
    }

    writeRouteAudit(c, {
      orgId,
      action: 'c2c.connection.test',
      resourceType: 'c2c_connection',
      resourceId: row.id,
      resourceName: row.displayName,
    });

    return c.json({
      id: row.id,
      provider: row.provider,
      authMethod: row.authMethod,
      status: testStatus,
      message,
      checkedAt,
    });
  }
);

// ── Response mapper (masks secrets) ─────────────────────────────────────────

function toConnectionResponse(row: typeof c2cConnections.$inferSelect) {
  return {
    id: row.id,
    provider: row.provider,
    authMethod: row.authMethod,
    displayName: row.displayName,
    tenantId: row.tenantId,
    clientId: row.clientId ? maskSecret(row.clientId) : null,
    scopes: row.scopes,
    status: row.status,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
