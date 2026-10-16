import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db, runOutsideDbContext } from '../../db';
import { edrConnections, edrTenants } from '../../db/schema';
import { requireMfa, requirePermission, requireScope, withAuthDbAccessContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { decryptEdrSecret, encryptEdrSecret } from '../../services/edrProviders/credentials';
import { getEdrProvider } from '../../services/edrProviders/registry';
import { buildEdrAdapterContext } from '../../services/edrProviders/context';
import { EdrProviderRequestError, type EdrProviderAdapter } from '../../services/edrProviders/types';
import { EDR_CONNECTION_PUBLIC_SELECT, isGateFailure, requireEdrPartnerAdmin } from './access';

/**
 * Vendor push opt-in / opt-out (EDR W03 PR-B, #8167; plan B5).
 *
 *   POST   /edr/connections/:id/push       register Breeze's webhook with the vendor
 *   DELETE /edr/connections/:id/push       stop accepting pushes, then unregister
 *   POST   /edr/connections/:id/push/test  ask the vendor to send one test event
 *
 * Gates: partner admin (`requireEdrPartnerAdmin`: no org tokens, no
 * selected-org users) + ORGS_WRITE + MFA — the same as every other connection
 * write. All three are in SELF_MANAGED_DB_CONTEXT_ROUTES: each makes a vendor
 * call, which runs under `runOutsideDbContext` between short
 * `withAuthDbAccessContext` phases (#1105).
 *
 * The shared secret is generated here, stored sealed with the row-bound AAD,
 * handed to the vendor once, and never returned by any route. `push_enabled`
 * flips true only after the vendor accepted the registration.
 */
export const edrConnectionPushRoutes = new Hono();

const idParamSchema = z.object({ id: z.string().guid() });

type BaseResult = { ok: true; base: string } | { ok: false; code: 'public_url_unset' | 'public_url_not_https'; error: string };

/** The externally reachable API origin the vendor must call (PUBLIC_API_URL, then BREEZE_SERVER). HTTPS only. */
export function publicApiBase(): BaseResult {
  const raw = process.env.PUBLIC_API_URL?.trim() || process.env.BREEZE_SERVER?.trim() || '';
  if (!raw) {
    return { ok: false, code: 'public_url_unset', error: 'Set PUBLIC_API_URL to the public https address of this server before enabling push events.' };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: 'public_url_not_https', error: 'PUBLIC_API_URL must be a valid https URL to enable push events.' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, code: 'public_url_not_https', error: 'PUBLIC_API_URL must use https to enable push events.' };
  }
  return { ok: true, base: url.origin };
}

async function loadPushRow(id: string, partnerId: string) {
  const [row] = await db
    .select({
      id: edrConnections.id,
      provider: edrConnections.provider,
      baseUrl: edrConnections.baseUrl,
      region: edrConnections.region,
      vendorRootId: edrConnections.vendorRootId,
      credentialsEncrypted: edrConnections.credentialsEncrypted,
      isActive: edrConnections.isActive,
      pushEnabled: edrConnections.pushEnabled,
    })
    .from(edrConnections)
    .where(and(eq(edrConnections.id, id), eq(edrConnections.partnerId, partnerId)))
    .limit(1);
  return row ?? null;
}

async function loadPublic(id: string, partnerId: string) {
  const [row] = await db
    .select(EDR_CONNECTION_PUBLIC_SELECT)
    .from(edrConnections)
    .where(and(eq(edrConnections.id, id), eq(edrConnections.partnerId, partnerId)))
    .limit(1);
  return row ?? null;
}

function adapterOrNull(provider: string): EdrProviderAdapter | null {
  try {
    return getEdrProvider(provider);
  } catch {
    return null;
  }
}

type PushRow = NonNullable<Awaited<ReturnType<typeof loadPushRow>>>;

function contextFor(adapter: EdrProviderAdapter, row: PushRow) {
  const creds = decryptEdrSecret('connection_credentials', row.id, row.credentialsEncrypted);
  return buildEdrAdapterContext(adapter, { creds, baseUrl: row.baseUrl, region: row.region, vendorRootId: row.vendorRootId });
}

/** Vendor errors are already key-scrubbed by the client; anything else gets a generic line. */
function vendorMessage(error: unknown, label: string): string {
  return error instanceof EdrProviderRequestError ? error.message : `${label} did not accept the request`;
}

// POST /edr/connections/:id/push  (self-managed)
edrConnectionPushRoutes.post(
  '/connections/:id/push',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const gate = requireEdrPartnerAdmin(auth);
    if (isGateFailure(gate)) return c.json({ error: gate.error }, gate.status);

    const row = await withAuthDbAccessContext(auth, () => loadPushRow(id, gate.partnerId));
    if (!row) return c.json({ error: 'EDR connection not found' }, 404);
    if (!row.isActive) {
      return c.json({ error: 'This connection is disabled. Re-enable it before turning on push events.', code: 'connection_inactive' }, 409);
    }
    const adapter = adapterOrNull(row.provider);
    if (!adapter?.registerPush || !adapter.verifyWebhook) {
      return c.json({ error: 'This provider does not support push events', code: 'push_unsupported' }, 400);
    }
    const base = publicApiBase();
    if (!base.ok) return c.json({ error: base.error, code: base.code }, 409);

    const secret = randomBytes(32).toString('base64url');
    const sealed = encryptEdrSecret('connection_webhook_secret', row.id, secret);
    // 1. Store the new secret with push OFF: the webhook keeps refusing until the vendor accepted.
    const vendorTenantIds = await withAuthDbAccessContext(auth, async () => {
      await db
        .update(edrConnections)
        .set({ webhookSecretEncrypted: sealed, pushEnabled: false, pushRegisteredAt: null, updatedAt: new Date() })
        .where(and(eq(edrConnections.id, row.id), eq(edrConnections.partnerId, gate.partnerId)));
      const tenants = await db
        .select({ vendorTenantId: edrTenants.vendorTenantId })
        .from(edrTenants)
        .where(and(eq(edrTenants.connectionId, row.id), isNotNull(edrTenants.orgId), isNull(edrTenants.vendorMissingSince)));
      return tenants.map((t) => t.vendorTenantId);
    });

    // 2. Vendor registration, outside any DB context.
    try {
      await runOutsideDbContext(() => adapter.registerPush!(contextFor(adapter, row), {
        url: `${base.base}/api/v1/webhooks/edr/${row.id}`,
        secret,
        vendorTenantIds,
      }));
    } catch (error) {
      const message = vendorMessage(error, adapter.label);
      writeRouteAudit(c, {
        orgId: null,
        action: 'edr.connection.push_enabled',
        resourceType: 'edr_connection',
        resourceId: row.id,
        details: { partnerId: gate.partnerId, error: message },
        result: 'failure',
      });
      return c.json({ error: message, code: 'vendor_error' }, 502);
    }

    // 3. Enabled only now, and only if nobody rotated the secret in between.
    const updated = await withAuthDbAccessContext(auth, async () => {
      await db
        .update(edrConnections)
        .set({ pushEnabled: true, pushRegisteredAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(edrConnections.id, row.id),
          eq(edrConnections.partnerId, gate.partnerId),
          eq(edrConnections.webhookSecretEncrypted, sealed),
        ));
      return loadPublic(row.id, gate.partnerId);
    });

    writeRouteAudit(c, {
      orgId: null,
      action: 'edr.connection.push_enabled',
      resourceType: 'edr_connection',
      resourceId: row.id,
      details: { partnerId: gate.partnerId, subscribedTenants: vendorTenantIds.length },
    });
    return c.json({ data: updated });
  },
);

// DELETE /edr/connections/:id/push  (self-managed)
edrConnectionPushRoutes.delete(
  '/connections/:id/push',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const gate = requireEdrPartnerAdmin(auth);
    if (isGateFailure(gate)) return c.json({ error: gate.error }, gate.status);

    const row = await withAuthDbAccessContext(auth, () => loadPushRow(id, gate.partnerId));
    if (!row) return c.json({ error: 'EDR connection not found' }, 404);

    // 1. Stop accepting pushes FIRST: the secret is gone whatever the vendor says.
    await withAuthDbAccessContext(auth, () => db
      .update(edrConnections)
      .set({ pushEnabled: false, pushRegisteredAt: null, webhookSecretEncrypted: null, updatedAt: new Date() })
      .where(and(eq(edrConnections.id, row.id), eq(edrConnections.partnerId, gate.partnerId))));

    // 2. Best effort at the vendor (outside any DB context).
    const warnings: string[] = [];
    const adapter = adapterOrNull(row.provider);
    if (adapter?.unregisterPush) {
      try {
        await runOutsideDbContext(() => adapter.unregisterPush!(contextFor(adapter, row)));
      } catch (error) {
        warnings.push(`${vendorMessage(error, adapter.label)}. Breeze no longer accepts its push events; turn push off in the vendor console too.`);
      }
    }

    writeRouteAudit(c, {
      orgId: null,
      action: 'edr.connection.push_disabled',
      resourceType: 'edr_connection',
      resourceId: row.id,
      details: { partnerId: gate.partnerId, vendorUnregistered: warnings.length === 0 },
    });
    const updated = await withAuthDbAccessContext(auth, () => loadPublic(row.id, gate.partnerId));
    return c.json({ data: updated, warnings });
  },
);

// POST /edr/connections/:id/push/test  (self-managed)
edrConnectionPushRoutes.post(
  '/connections/:id/push/test',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const gate = requireEdrPartnerAdmin(auth);
    if (isGateFailure(gate)) return c.json({ error: gate.error }, gate.status);

    const row = await withAuthDbAccessContext(auth, () => loadPushRow(id, gate.partnerId));
    if (!row) return c.json({ error: 'EDR connection not found' }, 404);
    if (!row.pushEnabled) return c.json({ error: 'Push events are not enabled for this connection', code: 'push_not_enabled' }, 409);
    const adapter = adapterOrNull(row.provider);
    if (!adapter?.sendTestPush) return c.json({ error: 'This provider does not support push events', code: 'push_unsupported' }, 400);

    try {
      await runOutsideDbContext(() => adapter.sendTestPush!(contextFor(adapter, row)));
    } catch (error) {
      return c.json({ error: vendorMessage(error, adapter.label), code: 'vendor_error' }, 502);
    }
    writeRouteAudit(c, {
      orgId: null,
      action: 'edr.connection.push_test',
      resourceType: 'edr_connection',
      resourceId: row.id,
      details: { partnerId: gate.partnerId },
    });
    return c.json({ accepted: true }, 202);
  },
);
