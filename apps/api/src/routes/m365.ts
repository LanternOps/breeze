/**
 * Microsoft 365 connection management for the Breeze identity tools.
 *
 * One connection per org. The app client secret is an admin god-key: it is
 * encrypted at rest (secretCrypto), validated by a live Graph call before it is
 * stored (fail-closed), and NEVER returned by any read endpoint.
 *
 * Gated by M365_ENABLED (whole group 404s when off) and by ORGS_WRITE + MFA on
 * mutations, mirroring the Google Workspace connection routes.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { m365Connections } from '../db/schema/m365';
import { requireMfa, requirePermission } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { captureException } from '../services/sentry';
import { encryptSecret } from '../services/secretCrypto';
import { resolveScopedOrgId } from './c2c/helpers';
import { PERMISSIONS } from '../services/permissions';
import { M365_ENABLED } from '../config/env';
import { acquireClientCredentialsToken, testGraphAccess } from '../services/c2cM365';

export const m365Routes = new Hono();

const requireOrgsRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
const requireOrgsWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);

// Whole group is dark unless the feature flag is on.
m365Routes.use('*', async (c, next) => {
  if (!M365_ENABLED) return c.json({ error: 'Microsoft 365 integration is not enabled' }, 404);
  await next();
});

const connectSchema = z.object({
  tenantId: z.string().min(1).max(64),
  clientId: z.string().min(1).max(64),
  // Azure AD app client secret. Validated by a live Graph call, then encrypted.
  clientSecret: z.string().min(1).max(2048),
});

function toConnectionResponse(row: typeof m365Connections.$inferSelect) {
  // Never include client_secret.
  return {
    tenantId: row.tenantId,
    clientId: row.clientId,
    displayName: row.displayName,
    status: row.status,
    lastVerifiedAt: row.lastVerifiedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── Get connection status ─────────────────────────────────────────────────────
m365Routes.get('/connection', requireOrgsRead, async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
  if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

  const [row] = await db
    .select()
    .from(m365Connections)
    .where(eq(m365Connections.orgId, orgId))
    .limit(1);

  if (!row) return c.json({ connected: false });
  return c.json({ connected: true, ...toConnectionResponse(row) });
});

// ── Create / replace connection ───────────────────────────────────────────────
m365Routes.post(
  '/connection',
  requireOrgsWrite,
  requireMfa(),
  zValidator('json', connectSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const payload = c.req.valid('json');

    // Fail-closed: prove the app credentials work before storing, by acquiring a
    // client-credentials token and making a live Graph call. Surfaces a bad
    // secret or missing admin consent immediately with a clear message.
    let displayName: string | null = null;
    try {
      const token = await acquireClientCredentialsToken({
        tenantId: payload.tenantId,
        clientId: payload.clientId,
        clientSecret: payload.clientSecret,
      });
      const graphTest = await testGraphAccess(token.accessToken);
      if (!graphTest.ok) {
        return c.json(
          {
            error: `Could not verify the Microsoft 365 connection: ${graphTest.error ?? 'Graph access failed'}`,
            hint: 'Confirm the app registration has admin consent for the required Graph application permissions and that the tenant/client id and secret are correct.',
          },
          400,
        );
      }
      displayName = graphTest.orgDisplayName ?? null;
    } catch (err) {
      return c.json(
        {
          error: `Could not verify the Microsoft 365 connection: ${err instanceof Error ? err.message : 'token acquisition failed'}`,
          hint: 'Confirm the tenant id, client id, and client secret are correct and the app has admin consent.',
        },
        400,
      );
    }

    const encryptedSecret = encryptSecret(payload.clientSecret);
    if (!encryptedSecret) return c.json({ error: 'Failed to encrypt the client secret' }, 500);

    const now = new Date();
    const [row] = await db
      .insert(m365Connections)
      .values({
        orgId,
        tenantId: payload.tenantId,
        clientId: payload.clientId,
        clientSecret: encryptedSecret,
        displayName,
        status: 'active',
        createdBy: auth.user?.id ?? null,
        lastVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: m365Connections.orgId,
        set: {
          tenantId: payload.tenantId,
          clientId: payload.clientId,
          clientSecret: encryptedSecret,
          displayName,
          status: 'active',
          lastVerifiedAt: now,
          updatedAt: now,
        },
      })
      .returning();

    if (!row) {
      captureException(new Error('m365_connection upsert returned no row'), c);
      return c.json({ error: 'Failed to save connection' }, 500);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'm365.connection.upsert',
      resourceType: 'm365_connection',
      resourceId: row.id,
      resourceName: row.tenantId,
      details: { tenantId: row.tenantId, clientId: row.clientId },
    });

    return c.json({ connected: true, ...toConnectionResponse(row) }, 201);
  },
);

// ── Delete connection ─────────────────────────────────────────────────────────
m365Routes.delete('/connection', requireOrgsWrite, requireMfa(), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
  if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

  const [row] = await db
    .delete(m365Connections)
    .where(eq(m365Connections.orgId, orgId))
    .returning();

  if (row) {
    writeRouteAudit(c, {
      orgId,
      action: 'm365.connection.delete',
      resourceType: 'm365_connection',
      resourceId: row.id,
      resourceName: row.tenantId,
    });
  }

  return c.json({ connected: false });
});
