import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db';
import { c2cConnections } from '../../db/schema';
import { writeRouteAudit } from '../../services/auditEvents';
import { createConnectionSchema, idParamSchema } from './schemas';
import { resolveScopedOrgId, maskSecret } from './helpers';

export const connectionsRoutes = new Hono();

// ── List connections ────────────────────────────────────────────────────────

connectionsRoutes.get('/connections', async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
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
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
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
  zValidator('json', createConnectionSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const payload = c.req.valid('json');
    const now = new Date();

    const [row] = await db
      .insert(c2cConnections)
      .values({
        orgId,
        provider: payload.provider,
        displayName: payload.displayName,
        tenantId: payload.tenantId ?? null,
        clientId: payload.clientId,
        clientSecret: payload.clientSecret,
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
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
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
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const { id } = c.req.valid('param');
    const [row] = await db
      .select()
      .from(c2cConnections)
      .where(and(eq(c2cConnections.id, id), eq(c2cConnections.orgId, orgId)))
      .limit(1);

    if (!row) return c.json({ error: 'Connection not found' }, 404);

    // Scaffold: in production, this would validate OAuth tokens against the provider
    const checkedAt = new Date().toISOString();

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
      status: row.status === 'active' ? 'success' : 'failed',
      message:
        row.status === 'active'
          ? 'Connection is active and credentials are configured'
          : `Connection status is ${row.status}`,
      checkedAt,
    });
  }
);

// ── Response mapper (masks secrets) ─────────────────────────────────────────

function toConnectionResponse(row: typeof c2cConnections.$inferSelect) {
  return {
    id: row.id,
    provider: row.provider,
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
