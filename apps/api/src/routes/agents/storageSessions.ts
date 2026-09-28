import { Hono, type Context } from 'hono';
import { withDbAccessContext } from '../../db';
import { requireAgentRole } from '../../middleware/requireAgentRole';
import {
  recordStorageSessionCall,
  recordStorageSessionObjects,
  type StorageSessionObjectMethod,
  type StorageSessionOp,
  type StorageSessionScope,
} from '../../services/backupMetrics';
import {
  STORAGE_SESSION_HEADER,
  STORAGE_SESSION_MAX_BATCH,
  authenticateStorageSession,
  renewStorageSession,
  resolveStorageSessionObjects,
  type StorageSessionRow,
} from '../../services/backupStorageSessions';
import type { SnapshotIdReservation } from '../../services/backupSnapshotIdReservations';
import {
  STORAGE_WRITE_DELETE_MAX_KEYS,
  abortWriteSessionMultipart,
  completeWriteSessionMultipart,
  createWriteSessionMultipart,
  deleteWriteSessionKeys,
  ensureWriteSessionLive,
  listWriteSessionPrefix,
  resolveWriteSessionObjects,
  resumeWriteSession,
  validateCompletedParts,
  type OrgRunner,
  type WriteFailure,
  type WriteResolveRequest,
} from '../../services/backupStorageWriteSessions';

/**
 * Brokered storage access for backup commands: read sessions for
 * restore-shaped commands (services/backupStorageSessions.ts) and write
 * sessions for backups (services/backupStorageWriteSessions.ts). Every call
 * needs BOTH the agent's own credential (agentAuthMiddleware, mounted on
 * `/:id/*`; main-agent role only) and the session token in the
 * X-Breeze-Storage-Session header — never in the URL. The authenticated
 * device must be the session's executing device.
 *
 *   POST /:id/storage-sessions/:sessionId/objects:resolve   read {"keys": [...]} | write {"requests": [...]}
 *   POST /:id/storage-sessions/:sessionId/renew             {}
 *   GET  /:id/storage-sessions/:sessionId/object?key=<key>  302 (read compatibility)
 *   write scope only:
 *   POST …/snapshot:resume      {"snapshotId"}  → {"snapshotId", "mode": "write"|"read_only_completion", "takeover"}
 *                               (snapshotId: the id the helper's journal names; the server decides whether
 *                               this session may continue it, including an earlier job's unfinished id —
 *                               see resumeWriteSession; 409 not_resumable | previous_writer_active + Retry-After)
 *   POST …/multipart:create     {"key"}  → {"uploadId", "appliedEncryption": {"algorithm", "kmsKeyId"?} | null}
 *   POST …/multipart:complete   {"key", "uploadId", "parts": [{"partNumber", "etag"}]}
 *   POST …/multipart:abort      {"key", "uploadId"}
 *   POST …/objects:list         {"prefix", "continuationToken"?}
 *   POST …/objects:delete       {"keys": [...]}
 * An operation of the other scope is refused with 403 scope_mismatch.
 */
export const agentStorageSessionRoutes = new Hono();

type AgentIdentity = { deviceId: string; orgId: string; partnerId?: string | null };

/**
 * These routes self-manage their DB context (middleware/agentAuth.ts): each
 * database phase runs in its own short organization-scoped context for the
 * authenticated device, and storage calls run with none held.
 */
function orgRunner(c: Context): OrgRunner {
  const agent = c.get('agent' as never) as AgentIdentity;
  return <T,>(fn: () => Promise<T>) => withDbAccessContext(
    {
      scope: 'organization',
      orgId: agent.orgId,
      accessibleOrgIds: [agent.orgId],
      accessiblePartnerIds: [],
      currentPartnerId: agent.partnerId ?? null,
    },
    fn,
  );
}

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

/**
 * Per-call telemetry: every answered call is counted once, by the session's
 * scope (the read scope until a session has been authenticated), operation
 * and HTTP status — including a thrown error, counted as 500. Never labelled
 * by session, device or key.
 */
type CallMeter = { scope: StorageSessionScope; objects: Map<StorageSessionObjectMethod, number> };

async function metered(op: StorageSessionOp, handler: (meter: CallMeter) => Promise<Response>): Promise<Response> {
  const meter: CallMeter = { scope: 'snapshot_read', objects: new Map() };
  let status = 500;
  try {
    const res = await handler(meter);
    status = res.status;
    return res;
  } finally {
    recordStorageSessionCall(meter.scope, op, status);
    if (status < 400) {
      for (const [method, count] of meter.objects) recordStorageSessionObjects(meter.scope, method, count);
    }
  }
}

function countObjects(meter: CallMeter, objects: ReadonlyArray<{ method: string }>): void {
  for (const object of objects) {
    const method = object.method as StorageSessionObjectMethod;
    meter.objects.set(method, (meter.objects.get(method) ?? 0) + 1);
  }
}

/** Write-scope operations and the metric label each is counted under. */
const WRITE_OPS: Record<string, StorageSessionOp> = {
  'snapshot:resume': 'resume',
  'multipart:create': 'multipart_create',
  'multipart:complete': 'multipart_complete',
  'multipart:abort': 'multipart_abort',
  'objects:list': 'list',
  'objects:delete': 'delete',
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Write resolve requests from a body, or null when the body is malformed. */
function parseWriteRequests(body: unknown): WriteResolveRequest[] | null {
  if (!isRecord(body)) return null;
  const requests = body.requests;
  if (!Array.isArray(requests) || requests.length < 1 || requests.length > STORAGE_SESSION_MAX_BATCH) return null;
  const out: WriteResolveRequest[] = [];
  for (const r of requests) {
    if (!isRecord(r) || typeof r.key !== 'string') return null;
    if (r.method === 'GET') out.push({ method: 'GET', key: r.key });
    else if (r.method === 'PUT' && typeof r.size === 'number') out.push({ method: 'PUT', key: r.key, size: r.size });
    else if (
      r.method === 'UPLOAD_PART'
      && typeof r.size === 'number'
      && typeof r.partNumber === 'number'
      && typeof r.uploadId === 'string'
      && r.uploadId.length > 0
      && r.uploadId.length <= 1024
    ) {
      out.push({ method: 'UPLOAD_PART', key: r.key, uploadId: r.uploadId, partNumber: r.partNumber, size: r.size });
    } else return null;
  }
  return out;
}

function failure(c: Context, result: WriteFailure): Response {
  if (result.retryAfterSeconds) c.header('Retry-After', String(result.retryAfterSeconds));
  return c.json({ error: result.code, code: result.code }, result.status);
}

agentStorageSessionRoutes.post('/:id/storage-sessions/:sessionId/:op', requireAgentRole, async (c) => {
  noStore(c);
  const op = c.req.param('op') ?? '';
  const writeOp = Object.prototype.hasOwnProperty.call(WRITE_OPS, op) ? WRITE_OPS[op] : undefined;
  if (op !== 'objects:resolve' && op !== 'renew' && !writeOp) {
    return c.json({ error: 'Not found' }, 404);
  }

  return metered(writeOp ?? (op === 'renew' ? 'renew' : 'resolve'), async (meter) => {
    let body: unknown = {};
    const raw = await c.req.text();
    if (raw.trim().length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        return c.json({ error: 'Request body must be JSON' }, 400);
      }
    }

    // A read resolve is validated before authentication (as it always was);
    // a write resolve names `requests` instead of `keys`.
    const writeResolve = op === 'objects:resolve' && isRecord(body) && 'requests' in body;
    let keys: string[] | null = null;
    if (op === 'objects:resolve' && !writeResolve) {
      keys = parseKeys(body);
      if (!keys) {
        return c.json({ error: `Body must be {"keys": [1..${STORAGE_SESSION_MAX_BATCH} strings]}` }, 400);
      }
    }

    const run = orgRunner(c);
    const isNetworkWriteOp = !!writeOp;

    // Phase 1 (one short context): authenticate the session and, for a write
    // session, re-check its job and reservation. Resolve and renew make no
    // storage call, so they finish inside this same phase.
    type Pre =
      | { done: Response }
      | { session: StorageSessionRow; reservation: SnapshotIdReservation };
    const pre: Pre = await run(async (): Promise<Pre> => {
      const auth = await authenticate(c);
      if (!auth.ok) return { done: c.json({ error: auth.error }, auth.status) };
      const session = auth.session;
      meter.scope = session.scope;

      const isWriteSession = session.scope === 'snapshot_write';
      if ((writeOp || writeResolve) && !isWriteSession) {
        return { done: c.json({ error: 'scope_mismatch', code: 'scope_mismatch' }, 403) };
      }
      if (op === 'objects:resolve' && !writeResolve && isWriteSession) {
        return { done: c.json({ error: 'scope_mismatch', code: 'scope_mismatch' }, 403) };
      }

      if (!isWriteSession) {
        if (op === 'renew') {
          const renewed = await renewStorageSession(session);
          if (renewed.status !== 200) return { done: c.json({ error: renewed.error }, renewed.status) };
          return { done: c.json(renewed.body, 200) };
        }
        const result = await resolveStorageSessionObjects(session, keys!);
        if (result.status === 429) {
          c.header('Retry-After', String(result.retryAfterSeconds));
          return { done: c.json({ error: 'Storage session budget exceeded' }, 429) };
        }
        if (result.status !== 200) return { done: c.json({ error: result.error }, result.status) };
        countObjects(meter, result.body.objects);
        return { done: c.json(result.body, 200) };
      }

      const live = await ensureWriteSessionLive(session);
      if (!live.ok) return { done: c.json({ error: live.error }, live.status) };
      if (op === 'renew') {
        const renewed = await renewStorageSession(session);
        if (renewed.status !== 200) return { done: c.json({ error: renewed.error }, renewed.status) };
        return { done: c.json(renewed.body, 200) };
      }
      if (op === 'objects:resolve') {
        const requests = parseWriteRequests(body);
        if (!requests) {
          return { done: c.json({ error: `Body must be {"requests": [1..${STORAGE_SESSION_MAX_BATCH} write requests]}` }, 400) };
        }
        const result = await resolveWriteSessionObjects(session, live.reservation, requests);
        if (result.status !== 200) return { done: failure(c, result) };
        countObjects(meter, result.body.objects);
        return { done: c.json(result.body, 200) };
      }
      return { session, reservation: live.reservation };
    });
    if ('done' in pre) return pre.done;
    if (!isNetworkWriteOp) return c.json({ error: 'Not found' }, 404);

    // Write operations that reach storage: each manages its own short phases.
    const { session } = pre;
    const b = isRecord(body) ? body : {};
    if (op === 'snapshot:resume') {
      const result = await resumeWriteSession(session, b.snapshotId, run);
      if (result.status !== 200) return failure(c, result as WriteFailure);
      return c.json(result.body, 200);
    }
    if (op === 'objects:list') {
      const token = b.continuationToken;
      if (typeof b.prefix !== 'string' || (token !== undefined && token !== null && typeof token !== 'string')) {
        return c.json({ error: 'Body must be {"prefix": string, "continuationToken"?: string}' }, 400);
      }
      const result = await listWriteSessionPrefix(session, b.prefix, (token as string | null | undefined) ?? null, run);
      if (result.status !== 200) return failure(c, result);
      return c.json(result.body, 200);
    }
    if (op === 'objects:delete') {
      const list = b.keys;
      if (!Array.isArray(list) || list.length < 1 || list.length > STORAGE_WRITE_DELETE_MAX_KEYS
        || !list.every((k) => typeof k === 'string')) {
        return c.json({ error: `Body must be {"keys": [1..${STORAGE_WRITE_DELETE_MAX_KEYS} strings]}` }, 400);
      }
      const result = await deleteWriteSessionKeys(session, list as string[], run);
      if (result.status !== 200) return failure(c, result);
      return c.json(result.body, 200);
    }

    // Multipart lifecycle.
    if (typeof b.key !== 'string') return c.json({ error: 'key is required' }, 400);
    if (op === 'multipart:create') {
      const result = await createWriteSessionMultipart(session, b.key, run);
      if (result.status !== 200) return failure(c, result);
      return c.json(result.body, 200);
    }
    if (typeof b.uploadId !== 'string' || b.uploadId.length === 0 || b.uploadId.length > 1024) {
      return c.json({ error: 'uploadId is required' }, 400);
    }
    if (op === 'multipart:abort') {
      const result = await abortWriteSessionMultipart(session, b.key, b.uploadId, run);
      if (result.status !== 200) return failure(c, result);
      return c.json(result.body, 200);
    }
    const parts = validateCompletedParts(b.parts);
    if (!parts) return c.json({ error: 'parts must be 1..10000 distinct {partNumber, etag}' }, 400);
    const result = await completeWriteSessionMultipart(session, b.key, b.uploadId, parts, run);
    if (result.status !== 200) return failure(c, result);
    return c.json(result.body, 200);
  });
});

agentStorageSessionRoutes.get('/:id/storage-sessions/:sessionId/object', requireAgentRole, async (c) => {
  noStore(c);
  return metered('object', async (meter) => {
    const key = c.req.query('key');
    if (typeof key !== 'string' || key.length === 0) {
      return c.json({ error: 'key is required' }, 400);
    }
    return orgRunner(c)(async () => {
      const auth = await authenticate(c);
      if (!auth.ok) return c.json({ error: auth.error }, auth.status);
      meter.scope = auth.session.scope;
      if (auth.session.scope !== 'snapshot_read') return c.json({ error: 'scope_mismatch', code: 'scope_mismatch' }, 403);

      const result = await resolveStorageSessionObjects(auth.session, [key]);
      if (result.status === 429) {
        c.header('Retry-After', String(result.retryAfterSeconds));
        return c.json({ error: 'Storage session budget exceeded' }, 429);
      }
      if (result.status !== 200) return c.json({ error: result.error }, result.status);
      const object = result.body.objects.find((o) => o.key === key);
      if (!object) return c.json({ error: 'Object is not part of this storage session' }, 403);
      countObjects(meter, [object]);
      return c.redirect(object.url, 302);
    });
  });
});
