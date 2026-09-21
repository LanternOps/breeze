import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { db, runOutsideDbContext } from '../../db';
import { backupProviderConnections, backupProviderDevices } from '../../db/schema';
import {
  requireMfa,
  requirePermission,
  requireScope,
  withAuthDbAccessContext,
} from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { captureException } from '../../services/sentry';
import { BACKUP_PROVIDER_KEYS, getBackupProvider } from '../../services/backupProviders/registry';
import { encryptProviderCredentials, decryptProviderCredentials } from '../../services/backupProviders/credentials';
import { resolveProviderAlertsForConnection } from '../../services/backupProviders/alertsResolve';
import { enqueueBackupProviderSync } from '../../jobs/backupProviderSync';
import {
  assertHttpsBaseUrl,
  CONNECTION_PUBLIC_SELECT,
  isGateFailure,
  pgErrorCode,
  requireProviderPartnerAdmin,
  resolveProviderPartnerId,
} from './providerAccess';
import { backupProviderCustomerRoutes } from './providerCustomers';
import { backupProviderDeviceRoutes } from './providerDevices';

const connectionRoutes = new Hono();

const idParamSchema = z.object({ id: z.string().guid() });

const createConnectionSchema = z.object({
  provider: z.string().min(1).max(30),
  name: z.string().trim().min(1).max(200),
  baseUrl: z.string().url().max(300).optional(),
  /** Shape is owned by the adapter's own schema, validated after the registry lookup. */
  credentials: z.record(z.string(), z.unknown()),
  showProviderNameInPortal: z.boolean().optional(),
  syncIntervalMinutes: z.number().int().min(5).max(1440).optional(),
});

const patchConnectionSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  isActive: z.boolean().optional(),
  syncIntervalMinutes: z.number().int().min(5).max(1440).optional(),
  showProviderNameInPortal: z.boolean().optional(),
  credentials: z.record(z.string(), z.unknown()).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be supplied' });

/** One connection the caller's partner owns, without the ciphertext. */
async function loadConnection(id: string, partnerId: string) {
  const [row] = await db
    .select(CONNECTION_PUBLIC_SELECT)
    .from(backupProviderConnections)
    .where(and(eq(backupProviderConnections.id, id), eq(backupProviderConnections.partnerId, partnerId)))
    .limit(1);
  return row ?? null;
}

/** The ciphertext, loaded ONLY where a vendor call needs it. */
async function loadCredentials(id: string, partnerId: string) {
  const [row] = await db
    .select({
      id: backupProviderConnections.id,
      provider: backupProviderConnections.provider,
      baseUrl: backupProviderConnections.baseUrl,
      credentialsEncrypted: backupProviderConnections.credentialsEncrypted,
    })
    .from(backupProviderConnections)
    .where(and(eq(backupProviderConnections.id, id), eq(backupProviderConnections.partnerId, partnerId)))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// GET /backup/providers/connections
// ---------------------------------------------------------------------------
connectionRoutes.get(
  '/connections',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  async (c) => {
    const gate = resolveProviderPartnerId(c.get('auth'));
    if (isGateFailure(gate)) return c.json({ error: gate.error }, gate.status);

    const rows = await db
      .select(CONNECTION_PUBLIC_SELECT)
      .from(backupProviderConnections)
      .where(eq(backupProviderConnections.partnerId, gate.partnerId))
      .orderBy(backupProviderConnections.name);

    return c.json({ data: rows, providers: [...BACKUP_PROVIDER_KEYS] });
  },
);

// ---------------------------------------------------------------------------
// POST /backup/providers/connections
//
// Registered in SELF_MANAGED_DB_CONTEXT_ROUTES: `testConnection` is a real
// Cove round-trip against an operator-supplied host, and holding the request
// transaction across it pins a pooled connection idle-in-transaction (#1105).
// Every DB touch below therefore opens its own short context.
// ---------------------------------------------------------------------------
connectionRoutes.post(
  '/connections',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('json', createConnectionSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    const gate = requireProviderPartnerAdmin(auth);
    if (isGateFailure(gate)) return c.json({ error: gate.error }, gate.status);

    let adapter;
    try {
      adapter = getBackupProvider(body.provider);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Unknown backup provider' }, 400);
    }

    const creds = adapter.credentialsSchema.safeParse(body.credentials);
    if (!creds.success) {
      return c.json({ error: `Invalid ${adapter.label} credentials` }, 400);
    }

    const baseUrl = body.baseUrl ?? 'https://api.backup.management/jsonapi';
    const urlError = assertHttpsBaseUrl(baseUrl);
    if (urlError) return c.json({ error: urlError }, 400);

    // The row id is generated HERE, not defaulted by the database: the
    // credential blob is sealed with an AAD bound to it (aadBinding: 'row'), so
    // the id has to exist before the encryption.
    const connectionId = randomUUID();

    // Outside any DB context — this route holds none.
    const test = await adapter.testConnection(creds.data, baseUrl);
    if (!test.ok) {
      // 422, not a 200 `{success:false}`: nothing was created, so a 2xx would
      // be a lie. runAction surfaces a non-2xx as a failure already.
      return c.json({ success: false, error: test.error, reauth: test.reauth }, 422);
    }

    let created;
    try {
      created = await withAuthDbAccessContext(auth, async () => {
        const [row] = await db
          .insert(backupProviderConnections)
          .values({
            id: connectionId,
            partnerId: gate.partnerId,
            provider: adapter.key,
            name: body.name,
            baseUrl,
            credentialsEncrypted: encryptProviderCredentials(connectionId, creds.data),
            vendorRootId: test.rootId,
            vendorRootName: test.rootName,
            isActive: true,
            status: 'connected',
            syncIntervalMinutes: body.syncIntervalMinutes ?? 30,
            showProviderNameInPortal: body.showProviderNameInPortal ?? false,
            createdBy: auth.user?.id ?? null,
          })
          .returning({ id: backupProviderConnections.id });
        if (!row) return null;
        return loadConnection(row.id, gate.partnerId);
      });
    } catch (error) {
      // The live Cove login above already succeeded by the time this insert
      // races the `(partner_id, provider, name)` unique index — a friendly
      // 409 naming the conflict, not an unhandled 500 after a real vendor
      // round-trip. This `withAuthDbAccessContext` call opens its OWN short
      // top-level transaction (SELF_MANAGED_DB_CONTEXT_ROUTES), so catching
      // outside it rolls back cleanly with no ambient transaction to poison.
      if (pgErrorCode(error) === '23505') {
        return c.json({
          error: `A connection named "${body.name}" already exists for this provider.`,
          code: 'DUPLICATE_CONNECTION_NAME',
        }, 409);
      }
      throw error;
    }

    if (!created) {
      return c.json({ error: 'Failed to store the backup provider connection' }, 500);
    }

    // After the write, outside every DB context: the queue is instrumented with
    // assertOutsideHeldDbContext, which throws in CI otherwise.
    let syncJobId: string | null = null;
    let syncWarning: string | null = null;
    try {
      syncJobId = await runOutsideDbContext(() => enqueueBackupProviderSync(connectionId));
    } catch (error) {
      console.error('[backupProvider] failed to queue the first sync:', error);
      captureException(error instanceof Error ? error : new Error(String(error)));
      syncWarning = 'Initial sync could not be queued. Data will sync on the next scheduled cycle.';
    }

    writeRouteAudit(c, {
      orgId: null,
      action: 'backup_provider.connection.create',
      resourceType: 'backup_provider_connection',
      resourceId: connectionId,
      resourceName: body.name,
      details: { provider: adapter.key, partnerId: gate.partnerId, customerCount: test.customerCount },
    });

    return c.json({
      data: created,
      customerCount: test.customerCount,
      syncJobId,
      ...(syncWarning ? { syncWarning } : {}),
    }, 201);
  },
);

// ---------------------------------------------------------------------------
// PATCH /backup/providers/connections/:id  (also self-managed — may re-test)
// ---------------------------------------------------------------------------
connectionRoutes.patch(
  '/connections/:id',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', idParamSchema),
  zValidator('json', patchConnectionSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const gate = requireProviderPartnerAdmin(auth);
    if (isGateFailure(gate)) return c.json({ error: gate.error }, gate.status);

    const existing = await withAuthDbAccessContext(auth, () => loadCredentials(id, gate.partnerId));
    if (!existing) return c.json({ error: 'Backup provider connection not found' }, 404);

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) updates.name = body.name;
    if (body.isActive !== undefined) updates.isActive = body.isActive;
    if (body.syncIntervalMinutes !== undefined) updates.syncIntervalMinutes = body.syncIntervalMinutes;
    if (body.showProviderNameInPortal !== undefined) {
      updates.showProviderNameInPortal = body.showProviderNameInPortal;
    }

    if (body.credentials !== undefined) {
      let adapter;
      try {
        adapter = getBackupProvider(existing.provider);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Unknown backup provider' }, 400);
      }
      const creds = adapter.credentialsSchema.safeParse(body.credentials);
      if (!creds.success) return c.json({ error: `Invalid ${adapter.label} credentials` }, 400);

      const test = await adapter.testConnection(creds.data, existing.baseUrl);
      if (!test.ok) {
        // The stored credential is untouched — a failed rotation must never
        // leave the connection with no working credential at all.
        return c.json({ success: false, error: test.error, reauth: test.reauth }, 422);
      }
      // Re-sealed under the EXISTING row id: the AAD is bound to it.
      updates.credentialsEncrypted = encryptProviderCredentials(existing.id, creds.data);
      updates.vendorRootId = test.rootId;
      updates.vendorRootName = test.rootName;
      // A successful credential rotation is the ONLY thing that clears
      // reauth_required — the sync worker will not retry such a connection
      // until it does.
      updates.status = 'connected';
      updates.lastSyncError = null;
    }

    let updated;
    try {
      // The inner `db.transaction` is a SAVEPOINT inside the outer
      // `withAuthDbAccessContext` transaction (same convention as
      // `providerDevices.ts`): a 23505 raised inside it rolls back only to the
      // savepoint, leaving the ambient context usable so the mapped 409
      // actually reaches the client instead of poisoning the whole request.
      updated = await withAuthDbAccessContext(auth, () => db.transaction(async (tx) => {
        const [row] = await tx
          .update(backupProviderConnections)
          .set(updates)
          .where(and(
            eq(backupProviderConnections.id, id),
            eq(backupProviderConnections.partnerId, gate.partnerId),
          ))
          .returning({ id: backupProviderConnections.id });
        if (!row) return null;

        // The portal reads its label off the DENORMALIZED column on the device
        // rows (an org token cannot read the partner-axis connection table at
        // all), so the flag has to be mirrored in the SAME transaction — a
        // half-applied toggle would keep showing the vendor name to a customer
        // after the MSP turned it off.
        if (body.showProviderNameInPortal !== undefined) {
          await tx.execute(sql`
            UPDATE backup_provider_devices
            SET portal_show_provider_name = ${body.showProviderNameInPortal}, updated_at = now()
            WHERE connection_id = ${id}::uuid
          `);
        }
        return loadConnection(id, gate.partnerId);
      }));
    } catch (error) {
      if (pgErrorCode(error) === '23505') {
        return c.json({
          error: `A connection named "${body.name}" already exists for this provider.`,
          code: 'DUPLICATE_CONNECTION_NAME',
        }, 409);
      }
      throw error;
    }

    if (!updated) return c.json({ error: 'Backup provider connection not found' }, 404);

    writeRouteAudit(c, {
      orgId: null,
      action: 'backup_provider.connection.update',
      resourceType: 'backup_provider_connection',
      resourceId: id,
      details: {
        partnerId: gate.partnerId,
        fields: Object.keys(body),
        credentialsRotated: body.credentials !== undefined,
      },
    });

    return c.json({ data: updated });
  },
);

// ---------------------------------------------------------------------------
// DELETE /backup/providers/connections/:id  (no outbound call — ambient tx)
// ---------------------------------------------------------------------------
connectionRoutes.delete(
  '/connections/:id',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const gate = requireProviderPartnerAdmin(auth);
    if (isGateFailure(gate)) return c.json({ error: gate.error }, gate.status);

    const existing = await loadConnection(id, gate.partnerId);
    if (!existing) return c.json({ error: 'Backup provider connection not found' }, 404);

    // BEFORE the delete: the customers, devices and ledger rows cascade away,
    // and an alert pointing at a deleted provider device can never auto-resolve
    // — it would sit in the alert center forever naming a device nobody can
    // find.
    const resolvedAlerts = await resolveProviderAlertsForConnection(id);

    await db
      .delete(backupProviderConnections)
      .where(and(
        eq(backupProviderConnections.id, id),
        eq(backupProviderConnections.partnerId, gate.partnerId),
      ));

    writeRouteAudit(c, {
      orgId: null,
      action: 'backup_provider.connection.delete',
      resourceType: 'backup_provider_connection',
      resourceId: id,
      resourceName: String(existing.name ?? ''),
      details: { partnerId: gate.partnerId, resolvedAlerts },
    });

    return c.json({ success: true, resolvedAlerts });
  },
);

// ---------------------------------------------------------------------------
// POST /backup/providers/connections/:id/test  (self-managed)
// ---------------------------------------------------------------------------
connectionRoutes.post(
  '/connections/:id/test',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const gate = requireProviderPartnerAdmin(auth);
    if (isGateFailure(gate)) return c.json({ error: gate.error }, gate.status);

    const existing = await withAuthDbAccessContext(auth, () => loadCredentials(id, gate.partnerId));
    if (!existing) return c.json({ error: 'Backup provider connection not found' }, 404);

    let adapter;
    try {
      adapter = getBackupProvider(existing.provider);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Unknown backup provider' }, 400);
    }

    let creds: unknown;
    try {
      creds = decryptProviderCredentials(existing.id, existing.credentialsEncrypted);
    } catch {
      // Never echo the decryption failure detail — it can describe key state.
      return c.json({ success: false, error: 'Stored credentials could not be read' }, 200);
    }

    const result = await adapter.testConnection(creds, existing.baseUrl);

    // Persist the outcome best-effort in a second short context. Only a REAUTH
    // failure changes `status`: a 503 must not disable a healthy connection.
    await withAuthDbAccessContext(auth, async () => {
      await db
        .update(backupProviderConnections)
        .set(result.ok
          ? { status: 'connected', vendorRootId: result.rootId, vendorRootName: result.rootName, lastSyncError: null, updatedAt: new Date() }
          : result.reauth
            ? { status: 'reauth_required', lastSyncError: result.error.slice(0, 2000), updatedAt: new Date() }
            : { lastSyncError: result.error.slice(0, 2000), updatedAt: new Date() })
        .where(and(
          eq(backupProviderConnections.id, id),
          eq(backupProviderConnections.partnerId, gate.partnerId),
        ));
    }).catch((error) => {
      console.error('[backupProvider] failed to persist a connection test outcome:', error);
    });

    writeRouteAudit(c, {
      orgId: null,
      action: 'backup_provider.connection.test',
      resourceType: 'backup_provider_connection',
      resourceId: id,
      details: { partnerId: gate.partnerId, success: result.ok },
      result: result.ok ? 'success' : 'failure',
    });

    // PSA `testResult` shape: HTTP 200 either way, `success:false` in the body.
    // runAction treats an HTTP-200 {success:false} as a failure.
    if (!result.ok) {
      return c.json({ success: false, error: result.error, reauth: result.reauth });
    }
    return c.json({
      success: true,
      message: `Connected to ${result.rootName}`,
      rootName: result.rootName,
      customerCount: result.customerCount,
    });
  },
);

// ---------------------------------------------------------------------------
// POST /backup/providers/connections/:id/sync  (no outbound call — ambient tx)
// ---------------------------------------------------------------------------
connectionRoutes.post(
  '/connections/:id/sync',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', idParamSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const gate = requireProviderPartnerAdmin(c.get('auth'));
    if (isGateFailure(gate)) return c.json({ error: gate.error }, gate.status);

    const existing = await loadConnection(id, gate.partnerId);
    if (!existing) return c.json({ error: 'Backup provider connection not found' }, 404);
    if (existing.isActive === false) {
      return c.json({ error: 'This connection is disabled. Re-enable it before syncing.' }, 409);
    }
    // A `reauth_required` connection is DELIBERATELY allowed here: "Sync now"
    // is the only way such a connection is retried, after a credential PATCH
    // reset its status.

    let syncJobId: string;
    try {
      // Outside the ambient request transaction — see the instrumented queue.
      syncJobId = await runOutsideDbContext(() => enqueueBackupProviderSync(id));
    } catch (error) {
      console.error('[backupProvider] failed to queue a manual sync:', error);
      captureException(error instanceof Error ? error : new Error(String(error)));
      return c.json({ success: false, error: 'Could not queue the sync. Try again shortly.' }, 503);
    }

    writeRouteAudit(c, {
      orgId: null,
      action: 'backup_provider.connection.sync',
      resourceType: 'backup_provider_connection',
      resourceId: id,
      details: { partnerId: gate.partnerId, syncJobId },
    });

    return c.json({ success: true, syncJobId }, 202);
  },
);

/**
 * The `/backup/providers/*` hub. Mounted once by `routes/backup/index.ts`;
 * `authMiddleware` and the outer `requireScope` are already applied there.
 */
export const backupProviderRoutes = new Hono();
backupProviderRoutes.route('/providers', connectionRoutes);
backupProviderRoutes.route('/providers', backupProviderCustomerRoutes);
backupProviderRoutes.route('/providers', backupProviderDeviceRoutes);
