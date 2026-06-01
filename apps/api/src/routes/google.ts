/**
 * Google Workspace connection management for the Breeze identity tools.
 *
 * One connection per org. The service-account key is a domain god-key: it is
 * encrypted at rest (secretCrypto), validated by a live Directory call before
 * it is stored (fail-closed), and NEVER returned by any read endpoint.
 *
 * Gated by GOOGLE_WORKSPACE_ENABLED (whole group 404s when off) and by
 * ORGS_WRITE + MFA on mutations, mirroring the c2c connection routes.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { googleWorkspaceConnections } from '../db/schema/google';
import { authMiddleware, requireMfa, requirePermission } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { captureException } from '../services/sentry';
import { encryptSecret } from '../services/secretCrypto';
import { resolveScopedOrgId } from './c2c/helpers';
import { PERMISSIONS } from '../services/permissions';
import { GOOGLE_WORKSPACE_ENABLED } from '../config/env';
import { getDirectoryClient, parseServiceAccountKey, normalizeGoogleError } from '../services/googleClient';

export const googleRoutes = new Hono();

const requireOrgsRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
const requireOrgsWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);

// Every endpoint requires an authenticated session (populates c.get('auth') for
// the requirePermission / requireMfa guards below). Without this the guards see
// no auth context and reject every request with 401.
googleRoutes.use('*', authMiddleware);

// Whole group is dark unless the feature flag is on.
googleRoutes.use('*', async (c, next) => {
  if (!GOOGLE_WORKSPACE_ENABLED) return c.json({ error: 'Google Workspace integration is not enabled' }, 404);
  await next();
});

const connectSchema = z.object({
  customerDomain: z.string().min(1).max(253),
  adminEmail: z.string().email().max(320),
  // Full service-account JSON (the file Google gives you). Validated + a live
  // Directory call is made before it is stored.
  serviceAccountKey: z.string().min(1).max(16384),
});

function toConnectionResponse(row: typeof googleWorkspaceConnections.$inferSelect) {
  // Never include service_account_key.
  return {
    customerDomain: row.customerDomain,
    adminEmail: row.adminEmail,
    serviceAccountEmail: row.serviceAccountEmail,
    status: row.status,
    lastVerifiedAt: row.lastVerifiedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── Get connection status ─────────────────────────────────────────────────────
googleRoutes.get('/connection', requireOrgsRead, async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
  if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

  const [row] = await db
    .select()
    .from(googleWorkspaceConnections)
    .where(eq(googleWorkspaceConnections.orgId, orgId))
    .limit(1);

  if (!row) return c.json({ connected: false });
  return c.json({ connected: true, ...toConnectionResponse(row) });
});

// ── Create / replace connection ───────────────────────────────────────────────
googleRoutes.post(
  '/connection',
  requireOrgsWrite,
  requireMfa(),
  zValidator('json', connectSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const payload = c.req.valid('json');

    // Validate the key JSON + extract the service-account email.
    let serviceAccountEmail: string;
    try {
      serviceAccountEmail = parseServiceAccountKey(payload.serviceAccountKey).client_email;
    } catch (err) {
      const norm = normalizeGoogleError(err);
      return c.json({ error: norm.message }, 400);
    }

    // Fail-closed: prove the key + domain-wide delegation actually work before
    // storing, by reading the admin user via the Directory API. This also
    // surfaces a misconfigured DWD grant immediately with a clear message.
    try {
      const dir = getDirectoryClient(payload.serviceAccountKey, payload.adminEmail);
      await dir.users.get({ userKey: payload.adminEmail });
    } catch (err) {
      const norm = normalizeGoogleError(err);
      return c.json(
        {
          error: `Could not verify the Google connection: ${norm.message}`,
          hint: 'Confirm domain-wide delegation is authorized for this service account and that the admin email is a super-admin in the domain.',
        },
        400,
      );
    }

    const encryptedKey = encryptSecret(payload.serviceAccountKey);
    if (!encryptedKey) return c.json({ error: 'Failed to encrypt the service-account key' }, 500);

    const now = new Date();
    const [row] = await db
      .insert(googleWorkspaceConnections)
      .values({
        orgId,
        customerDomain: payload.customerDomain,
        adminEmail: payload.adminEmail,
        serviceAccountEmail,
        serviceAccountKey: encryptedKey,
        status: 'active',
        createdBy: auth.user?.id ?? null,
        lastVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: googleWorkspaceConnections.orgId,
        set: {
          customerDomain: payload.customerDomain,
          adminEmail: payload.adminEmail,
          serviceAccountEmail,
          serviceAccountKey: encryptedKey,
          status: 'active',
          lastVerifiedAt: now,
          updatedAt: now,
        },
      })
      .returning();

    if (!row) {
      captureException(new Error('google_workspace_connection upsert returned no row'), c);
      return c.json({ error: 'Failed to save connection' }, 500);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'google.connection.upsert',
      resourceType: 'google_workspace_connection',
      resourceId: row.id,
      resourceName: row.customerDomain,
      details: { serviceAccountEmail, adminEmail: row.adminEmail },
    });

    return c.json({ connected: true, ...toConnectionResponse(row) }, 201);
  },
);

// ── Delete connection ─────────────────────────────────────────────────────────
googleRoutes.delete('/connection', requireOrgsWrite, requireMfa(), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
  if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

  const [row] = await db
    .delete(googleWorkspaceConnections)
    .where(eq(googleWorkspaceConnections.orgId, orgId))
    .returning();

  if (!row) return c.json({ error: 'No Google connection to delete' }, 404);

  writeRouteAudit(c, {
    orgId,
    action: 'google.connection.delete',
    resourceType: 'google_workspace_connection',
    resourceId: row.id,
    resourceName: row.customerDomain,
  });

  return c.json({ connected: false });
});
