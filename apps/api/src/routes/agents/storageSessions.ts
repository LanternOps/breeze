import { Hono, type Context } from 'hono';
import { requireAgentRole } from '../../middleware/requireAgentRole';
import {
  STORAGE_SESSION_HEADER,
  STORAGE_SESSION_MAX_BATCH,
  authenticateStorageSession,
  renewStorageSession,
  resolveStorageSessionObjects,
} from '../../services/backupStorageSessions';

/**
 * Brokered, read-only storage access for restore-shaped backup commands
 * (services/backupStorageSessions.ts). Every call needs BOTH the agent's own
 * credential (agentAuthMiddleware, mounted on `/:id/*`; main-agent role only)
 * and the session token in the X-Breeze-Storage-Session header — never in the
 * URL. The authenticated device must be the session's executing device.
 *
 *   POST /:id/storage-sessions/:sessionId/objects:resolve   {"keys": [...]}
 *   POST /:id/storage-sessions/:sessionId/renew             {}
 *   GET  /:id/storage-sessions/:sessionId/object?key=<key>  302 (compatibility)
 */
export const agentStorageSessionRoutes = new Hono();

type AgentIdentity = { deviceId: string; orgId: string };

function noStore(c: Context): void {
  c.header('Cache-Control', 'no-store');
}

async function authenticate(c: Context) {
  const agent = c.get('agent' as never) as AgentIdentity;
  return authenticateStorageSession({
    sessionId: c.req.param('sessionId') ?? '',
    token: c.req.header(STORAGE_SESSION_HEADER),
    agent: { deviceId: agent.deviceId, orgId: agent.orgId },
  });
}

/** Keys from a resolve body, or null when the body is malformed. */
function parseKeys(body: unknown): string[] | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = (body as { keys?: unknown }).keys;
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > STORAGE_SESSION_MAX_BATCH) return null;
  // Empty or otherwise unusable STRINGS are answered as denied by the
  // service; only a non-string entry makes the whole body malformed.
  if (!keys.every((k) => typeof k === 'string')) return null;
  return keys as string[];
}

agentStorageSessionRoutes.post('/:id/storage-sessions/:sessionId/:op', requireAgentRole, async (c) => {
  noStore(c);
  const op = c.req.param('op');
  if (op !== 'objects:resolve' && op !== 'renew') {
    return c.json({ error: 'Not found' }, 404);
  }

  let body: unknown = {};
  const raw = await c.req.text();
  if (raw.trim().length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: 'Request body must be JSON' }, 400);
    }
  }

  let keys: string[] | null = null;
  if (op === 'objects:resolve') {
    keys = parseKeys(body);
    if (!keys) {
      return c.json({ error: `Body must be {"keys": [1..${STORAGE_SESSION_MAX_BATCH} strings]}` }, 400);
    }
  }

  const auth = await authenticate(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  if (op === 'renew') {
    const renewed = await renewStorageSession(auth.session);
    if (renewed.status !== 200) return c.json({ error: renewed.error }, renewed.status);
    return c.json(renewed.body, 200);
  }

  const result = await resolveStorageSessionObjects(auth.session, keys!);
  if (result.status === 429) {
    c.header('Retry-After', String(result.retryAfterSeconds));
    return c.json({ error: 'Storage session budget exceeded' }, 429);
  }
  if (result.status !== 200) return c.json({ error: result.error }, result.status);
  return c.json(result.body, 200);
});

agentStorageSessionRoutes.get('/:id/storage-sessions/:sessionId/object', requireAgentRole, async (c) => {
  noStore(c);
  const key = c.req.query('key');
  if (typeof key !== 'string' || key.length === 0) {
    return c.json({ error: 'key is required' }, 400);
  }
  const auth = await authenticate(c);
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const result = await resolveStorageSessionObjects(auth.session, [key]);
  if (result.status === 429) {
    c.header('Retry-After', String(result.retryAfterSeconds));
    return c.json({ error: 'Storage session budget exceeded' }, 429);
  }
  if (result.status !== 200) return c.json({ error: result.error }, result.status);
  const object = result.body.objects.find((o) => o.key === key);
  if (!object) return c.json({ error: 'Object is not part of this storage session' }, 403);
  return c.redirect(object.url, 302);
});
