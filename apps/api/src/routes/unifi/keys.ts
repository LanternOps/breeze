import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { requireMfa, requirePermission, requireScope, withAuthDbAccessContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { db, runOutsideDbContext } from '../../db';
import { createUnifiClient, UnifiApiError } from '../../services/unifi/unifiClient';
import { getConnection, type UnifiConnection } from '../../services/unifi/unifiConnectionService';
import {
  addKey,
  deleteKey,
  getKeyForTest,
  listKeys,
  UnifiKeyError,
  updateKey,
  type UnifiKeySummary,
} from '../../services/unifi/unifiKeyService';
import { readKey } from '../../services/unifi/unifiKeyMerge';
import { enqueueUnifiSync } from '../../jobs/unifiWorker';
import { writeRouteAudit } from '../../services/auditEvents';
import { requestedPartnerId, resolvePartnerId } from './routeAuth';

// /unifi/keys: the Site Manager API keys of a cloud connection (#11808 W3).
// Mounted from routes/unifi/index.ts after its use('*') guards (authMiddleware
// and the partner-wide capability check). POST, PATCH and the per-key test are
// self-managed DB-context routes (middleware/selfManagedDbContextRoutes.ts):
// they validate or read with a key against UniFi with no transaction held, and
// read and write in short contexts of their own.
//
// No response, log line or audit row carries a key, its ciphertext, or (in the
// audit) its last four. Key summaries never select the ciphertext.

export const unifiKeyRoutes = new Hono();

// The same gates as the rest of /unifi (routes/unifi/index.ts).
const readPerm = requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action);
const writePerm = requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action);
const partnerScopes = requireScope('partner', 'system');

const MAX_MESSAGE = 500;
const INVALID_KEY_MESSAGE = 'Could not validate the UniFi API key.';
const UNREACHABLE_MESSAGE = 'Could not reach UniFi to validate the key. Please try again shortly.';

/** Removes the submitted key from any text (an upstream error could echo it) and caps the length. */
function scrub(text: string, apiKey: string | null): string {
  const clean = apiKey ? text.split(apiKey).join('[redacted]') : text;
  return clean.length > MAX_MESSAGE ? `${clean.slice(0, MAX_MESSAGE - 1)}…` : clean;
}

const keyIdParam = z.object({ keyId: z.string().guid() });

const addSchema = z.object({
  label: z.string().trim().min(1).max(100),
  apiKey: z.string().min(1).max(500),
});

const updateSchema = z.object({
  label: z.string().trim().min(1).max(100).optional(),
  isEnabled: z.boolean().optional(),
  apiKey: z.string().min(1).max(500).optional(),
}).refine((b) => b.label !== undefined || b.isEnabled !== undefined || b.apiKey !== undefined, {
  message: 'Send at least one of label, isEnabled or apiKey',
});

type KeyAuditAction = 'unifi.key.add' | 'unifi.key.update' | 'unifi.key.remove';
type KeyChange = 'label' | 'enabled' | 'secret';

// Built field by field: never spread a key summary into the audit (it carries keyLast4).
function auditKey(
  c: Context,
  partnerId: string,
  action: KeyAuditAction,
  integrationId: string,
  key: { id: string; label: string },
  extra: { previousLabel?: string; changed?: KeyChange[] } = {},
): void {
  writeRouteAudit(c as any, {
    orgId: null,
    partnerId,
    action,
    resourceType: 'unifi_integration_key',
    resourceId: key.id,
    resourceName: key.label,
    details: {
      integrationId,
      keyId: key.id,
      label: key.label,
      ...(extra.previousLabel !== undefined ? { previousLabel: extra.previousLabel } : {}),
      ...(extra.changed !== undefined ? { changed: extra.changed } : {}),
    },
  });
}

function keyErrorResponse(err: unknown): { status: 400 | 404 | 409; body: { success: false; code: string; message: string } } | null {
  if (!(err instanceof UnifiKeyError)) return null;
  const status = err.code === 'UNIFI_KEY_NOT_FOUND'
    ? 404
    : err.code === 'UNIFI_NOT_CLOUD' || err.code === 'UNIFI_NOT_CONNECTED' || err.code === 'UNIFI_KEY_LABEL_INVALID'
      ? 400
      : 409;
  return { status, body: { success: false, code: err.code, message: err.message } };
}

type ConnectionResult =
  | { ok: true; conn: UnifiConnection; partnerId: string }
  | { ok: false; status: 400 | 403; body: Record<string, unknown> };

/** The partner's active cloud connection, read in a short caller-scoped context. */
async function cloudConnection(c: Context): Promise<ConnectionResult> {
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, requestedPartnerId(c));
  if ('error' in partner) return { ok: false, status: partner.status, body: { error: partner.error } };
  const conn = await withAuthDbAccessContext(auth, () => getConnection(db, partner.partnerId));
  if (!conn) return { ok: false, status: 400, body: { success: false, message: 'Not connected' } };
  if (conn.connectionType !== 'cloud') {
    const err = new UnifiKeyError('UNIFI_NOT_CLOUD');
    return { ok: false, status: 400, body: { success: false, code: err.code, message: err.message } };
  }
  return { ok: true, conn, partnerId: partner.partnerId };
}

/**
 * Validates a key with /v1/hosts against the connection's stored base URL, with
 * no DB context held. A 401/403 means the key is bad (400); anything else is an
 * outage or a bug (502), as `/connect` answers. Returns the hosts the key sees.
 */
async function validateKey(baseUrl: string, apiKey: string):
  Promise<{ ok: true; hostIds: string[] } | { ok: false; status: 400 | 502; body: { success: false; message: string } }> {
  try {
    const hosts = await runOutsideDbContext(() => createUnifiClient({ baseUrl, apiKey }).listHosts());
    return { ok: true, hostIds: hosts.map((h) => h.id) };
  } catch (err) {
    if (err instanceof UnifiApiError && (err.status === 401 || err.status === 403)) {
      return { ok: false, status: 400, body: { success: false, message: INVALID_KEY_MESSAGE } };
    }
    // Logged without the error object, whose fields could carry request details.
    const text = err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error';
    console.error('[unifi] key validation: non-auth failure:', scrub(text, apiKey));
    return { ok: false, status: 502, body: { success: false, message: UNREACHABLE_MESSAGE } };
  }
}

/** Queue the first sync with the changed key. A queue outage must not fail a stored change: the scheduler syncs within 30 minutes. */
async function queueSync(integrationId: string, partnerId: string, keyId: string): Promise<void> {
  try {
    await enqueueUnifiSync(integrationId, partnerId, 'manual');
  } catch (err) {
    console.error('[unifi] could not queue a sync after a key change', {
      integrationId,
      partnerId,
      keyId,
      error: err instanceof Error ? err.message : 'unknown error',
    });
  }
}

// GET /unifi/keys — the connection's keys (summaries only)
unifiKeyRoutes.get('/', partnerScopes, readPerm, async (c) => {
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, requestedPartnerId(c));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const conn = await getConnection(db, partner.partnerId);
  if (!conn || conn.connectionType !== 'cloud') return c.json({ keys: [] as UnifiKeySummary[] });
  return c.json({ keys: await listKeys(db, conn.id, conn.partnerId) });
});

// POST /unifi/keys — validate a new key against UniFi, then store it
unifiKeyRoutes.post('/', partnerScopes, writePerm, requireMfa(), zValidator('json', addSchema), async (c) => {
  const auth = c.get('auth');
  const target = await cloudConnection(c);
  if (!target.ok) return c.json(target.body, target.status);
  const { conn, partnerId } = target;
  const { label, apiKey } = c.req.valid('json');

  const validated = await validateKey(conn.baseUrl, apiKey);
  if (!validated.ok) return c.json(validated.body, validated.status);

  let key: UnifiKeySummary;
  try {
    key = await withAuthDbAccessContext(auth, () => addKey(db, {
      integrationId: conn.id,
      partnerId,
      label,
      apiKey,
      seenHostIds: validated.hostIds,
      createdBy: auth.user.id,
    }));
  } catch (err) {
    const mapped = keyErrorResponse(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
  auditKey(c, partnerId, 'unifi.key.add', conn.id, key);
  await queueSync(conn.id, partnerId, key.id);
  return c.json({ key }, 201);
});

// PATCH /unifi/keys/:keyId — rename, enable or disable, or replace the secret
unifiKeyRoutes.patch('/:keyId', partnerScopes, writePerm, requireMfa(), zValidator('param', keyIdParam), zValidator('json', updateSchema), async (c) => {
  const auth = c.get('auth');
  const { keyId } = c.req.valid('param');
  const body = c.req.valid('json');
  const target = await cloudConnection(c);
  if (!target.ok) return c.json(target.body, target.status);
  const { conn, partnerId } = target;

  let seenHostIds: string[] | undefined;
  if (body.apiKey !== undefined) {
    const validated = await validateKey(conn.baseUrl, body.apiKey);
    if (!validated.ok) return c.json(validated.body, validated.status);
    seenHostIds = validated.hostIds;
  }

  let result: { key: UnifiKeySummary; before: UnifiKeySummary | undefined };
  try {
    result = await withAuthDbAccessContext(auth, async () => {
      const before = (await listKeys(db, conn.id, partnerId)).find((k) => k.id === keyId);
      const key = await updateKey(db, {
        integrationId: conn.id,
        partnerId,
        keyId,
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.isEnabled !== undefined ? { isEnabled: body.isEnabled } : {}),
        ...(body.apiKey !== undefined ? { apiKey: body.apiKey, seenHostIds } : {}),
      });
      return { key, before };
    });
  } catch (err) {
    const mapped = keyErrorResponse(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
  const { key, before } = result;
  const changed: KeyChange[] = [];
  if (body.label !== undefined && before?.label !== key.label) changed.push('label');
  if (body.isEnabled !== undefined && before?.isEnabled !== key.isEnabled) changed.push('enabled');
  if (body.apiKey !== undefined) changed.push('secret');
  auditKey(c, partnerId, 'unifi.key.update', conn.id, key, {
    ...(before && before.label !== key.label ? { previousLabel: before.label } : {}),
    changed,
  });
  // A new secret, or a key that starts syncing again, gets a sync now.
  const enabledNow = body.isEnabled === true && before?.isEnabled === false;
  if (body.apiKey !== undefined || enabledNow) await queueSync(conn.id, partnerId, key.id);
  return c.json({ key });
});

// DELETE /unifi/keys/:keyId — remove a key (idempotent)
unifiKeyRoutes.delete('/:keyId', partnerScopes, writePerm, requireMfa(), zValidator('param', keyIdParam), async (c) => {
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, requestedPartnerId(c));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const { keyId } = c.req.valid('param');
  const conn = await getConnection(db, partner.partnerId);
  // After a Disconnect every key is gone: the end state a delete asks for.
  if (!conn) return c.json({ success: true });
  const before = conn.connectionType === 'cloud'
    ? (await listKeys(db, conn.id, conn.partnerId)).find((k) => k.id === keyId)
    : undefined;
  let deleted: boolean;
  try {
    // deleteKey runs in its own savepoint; a refusal rolls only that back.
    deleted = await deleteKey(db, { integrationId: conn.id, partnerId: conn.partnerId, keyId });
  } catch (err) {
    const mapped = keyErrorResponse(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
  // Already gone is the desired end state (see /disconnect): success, no audit row.
  if (deleted && before) auditKey(c, conn.partnerId, 'unifi.key.remove', conn.id, before);
  return c.json({ success: true });
});

// POST /unifi/keys/:keyId/test — read hosts and sites with one key, enabled or not
unifiKeyRoutes.post('/:keyId/test', partnerScopes, writePerm, requireMfa(), zValidator('param', keyIdParam), async (c) => {
  const auth = c.get('auth');
  const { keyId } = c.req.valid('param');
  const target = await cloudConnection(c);
  if (!target.ok) return c.json(target.body, target.status);
  const { conn, partnerId } = target;
  const found = await withAuthDbAccessContext(auth, () => getKeyForTest(db, conn.id, partnerId, keyId));
  if (!found) {
    const err = new UnifiKeyError('UNIFI_KEY_NOT_FOUND');
    return c.json({ success: false, code: err.code, message: err.message }, 404);
  }
  const { key, baseUrl } = found;
  if (key.apiKey === null) {
    return c.json({ success: false, hostsFound: 0, sitesFound: 0, message: 'The stored UniFi API key could not be decrypted. Replace the key.' }, 400);
  }
  const apiKey = key.apiKey;
  const read = await runOutsideDbContext(() => readKey(key.id, key.label, createUnifiClient({ baseUrl, apiKey }), { mode: 'mapping' }));
  if (!read.ok) {
    return c.json(
      { success: false, hostsFound: 0, sitesFound: 0, message: scrub(read.error, apiKey) },
      read.authFailure ? 400 : 502,
    );
  }
  return c.json({ success: true, hostsFound: read.hosts.length, sitesFound: read.siteRead?.sites.length ?? 0 });
});
