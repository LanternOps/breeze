/**
 * Wisp W04 — thread routes (Wisp design §6; w00 "Routes (final names)", A24).
 * Mounted by W02's hub as `wispRoutes.route('/thread', wispThreadRoutes)`,
 * i.e. /api/v1/wisp/thread.
 *
 *   GET   /?orgId=                → { data: { thread, focusOrgName, grant, wideningAvailable } } | 404 no_active_grant
 *                                    (grant carries the W05 spend meter: spentTodayCents, budgetResetsAt — w00 A32)
 *   GET   /:id/sessions?limit=&cursor= → { data: [{ sessionId, orgId, attachedAt, title, status }], nextCursor }
 *   PATCH /:id/focus              { orgId: uuid | null } → { data: { focusOrgId, focusOrgName } }
 *   GET   /:id/attachments        → { data: ThreadAttachmentDto[] }   (live only, newest first)
 *   POST  /:id/attachments        multipart { file, label? } | json { text, label } → 201 { data: ThreadAttachmentDto }
 *
 * GATES are inherited from the hub's `use('*')` chain, which runs before any
 * sub-route: authMiddleware → 404 while !wispEnabled() → requireScope('partner')
 * → ai_sessions:use → requireEntitlement('wisp'). They are not re-declared
 * here (each would cost a second permission / entitlement resolution); this
 * router must therefore never be mounted anywhere but under `wispRoutes` —
 * routes/wisp.entitlement.contract.test.ts enumerates every /wisp route
 * through the hub and fails if one answers without the entitlement gate.
 *
 * OWNERSHIP. Every `/:id` route loads the thread joined to its grant and
 * requires grant.grantor_user_id = the caller AND thread.partner_id = the
 * caller's partner. Anything else — another user's thread, another partner's,
 * a missing row, a non-uuid id — is the same existence-neutral 404.
 *
 * READS. Thread / session / org-name reads run through
 * `readOwnPartnerAxisRows(auth.partnerId)`: for a partner-scope request (the
 * only scope that reaches here) the ambient context already lists the
 * caller's partner in `accessiblePartnerIds`, so they run IN PLACE under the
 * caller's own RLS — `wisp_threads` / `wisp_thread_sessions` via
 * `breeze_has_partner_access`, `ai_sessions` / `organizations` via
 * `breeze_has_org_access` (a session or focus org the caller can no longer
 * reach simply drops out). Every query is still pinned to `auth.partnerId`.
 * The thread services (`getOrCreateThread`, `setThreadFocus`,
 * `listThreadAttachments`, `addThreadAttachment`) run in system context by
 * design and are only called AFTER the ownership check; attachment rows are
 * then filtered by `auth.canAccessOrg` before they leave.
 */
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { and, desc, eq, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import { aiArtifactCaptureEnabled } from '../config/env';
import { db } from '../db';
import { readOwnPartnerAxisRows } from '../db/partnerAxisRead';
import { aiSessions } from '../db/schema/ai';
import { organizations } from '../db/schema/orgs';
import { wispGrants } from '../db/schema/wisp';
import { wispThreadSessions, wispThreads } from '../db/schema/wispThreads';
import { zValidator } from '../lib/validation';
import type { AuthContext } from '../middleware/auth';
import { bodyLimitOnError } from '../middleware/bodyLimitGate';
import { userRateLimit } from '../middleware/userRateLimit';
import { writeRouteAudit } from '../services/auditEvents';
import { captureException } from '../services/sentry';
import { spendSummary } from '../services/wisp/budget';
import { CeilingViolationError, GrantInactiveError, resolveGrantCeiling, type GrantCeiling } from '../services/wisp/grantAuthority';
import { getActiveGrantForUser, wideningAvailable, type WispGrantStatus } from '../services/wisp/grants';
import {
  THREAD_ATTACHMENT_MAX_BYTES,
  THREAD_ATTACHMENT_MESSAGES,
  ThreadAttachmentError,
  addThreadAttachment,
  classifyAttachmentBytes,
  listThreadAttachments,
  type ThreadAttachment,
  type ThreadAttachmentContentType,
} from '../services/wisp/threadAttachments';
import { getOrCreateThread, setThreadFocus, WispThreadError, type WispThread } from '../services/wisp/threads';

/**
 * Body ceiling for POST /:id/attachments, enforced while streaming (before the
 * body is buffered): the 5 MiB attachment cap plus 1 MiB for the multipart
 * envelope or the JSON escaping of a pasted `text`. The decoded-byte cap
 * (`classifyAttachmentBytes`, 413 too_large) is the one that binds. The global
 * gate grants the same size (bodyLimit.ts rule 'wisp-thread-attachment').
 */
export const WISP_THREAD_ATTACHMENT_BODY_LIMIT = THREAD_ATTACHMENT_MAX_BYTES + 1024 * 1024;

const SESSIONS_DEFAULT_LIMIT = 20;
const SESSIONS_MAX_LIMIT = 100;
const FOCUS_NAME_MAX_CHARS = 200;

const uuid = z.string().uuid();
const threadQuery = z.object({ orgId: uuid.optional() });
const sessionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(SESSIONS_MAX_LIMIT).optional(),
  cursor: z.string().min(1).max(200).optional(),
});
const focusBody = z.object({ orgId: z.string().guid().nullable() }).strict();
const textAttachmentBody = z
  .object({ text: z.string(), label: z.string().trim().min(1).max(200) })
  .strict();

const NOT_FOUND = { error: 'Wisp thread not found', code: 'not_found' } as const;

type ErrorStatus = 400 | 403 | 404 | 409 | 413 | 415 | 500 | 503;
const fail = (c: Context, status: ErrorStatus, code: string, error: string, extra: Record<string, unknown> = {}) =>
  c.json({ error, code, ...extra }, status);

const authOf = (c: Context): AuthContext => c.get('auth') as AuthContext;

/** The hub's requireScope('partner') guarantees it; re-asserted for the type and as a belt. */
function partnerIdOf(auth: AuthContext): string {
  if (!auth.partnerId) throw new Error('wisp thread routes reached without a partner (hub gates bypassed?)');
  return auth.partnerId;
}

// ---------------------------------------------------------------------------
// DTOs (field by field; never `{...row}`)
// ---------------------------------------------------------------------------

function threadDto(t: WispThread) {
  return {
    id: t.id,
    grantId: t.grantId,
    summary: t.summary,
    summaryUpdatedAt: t.summaryUpdatedAt?.toISOString() ?? null,
    lastSessionId: t.lastSessionId,
    focusOrgId: t.focusOrgId,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

function attachmentDto(a: ThreadAttachment) {
  return {
    id: a.id,
    threadId: a.threadId,
    orgId: a.orgId,
    artifactId: a.artifactId,
    label: a.label,
    addedByUserId: a.addedByUserId,
    contentType: a.contentType,
    bytes: a.bytes,
    expiresAt: a.expiresAt.toISOString(),
    createdAt: a.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Ownership + reads
// ---------------------------------------------------------------------------

type OwnThread = {
  thread: WispThread;
  grant: { id: string; orgId: string | null; status: WispGrantStatus; currentRevisionId: string | null };
};

/** The caller's own thread (see OWNERSHIP above), or null for every other case. */
async function loadOwnThread(c: Context): Promise<OwnThread | null> {
  const parsed = uuid.safeParse(c.req.param('id'));
  if (!parsed.success) return null;
  const auth = authOf(c);
  const partnerId = partnerIdOf(auth);
  const [row] = await readOwnPartnerAxisRows(partnerId, () =>
    db
      .select({
        id: wispThreads.id,
        grantId: wispThreads.grantId,
        partnerId: wispThreads.partnerId,
        summary: wispThreads.summary,
        summaryUpdatedAt: wispThreads.summaryUpdatedAt,
        lastSessionId: wispThreads.lastSessionId,
        focusOrgId: wispThreads.focusOrgId,
        createdAt: wispThreads.createdAt,
        updatedAt: wispThreads.updatedAt,
        grantOrgId: wispGrants.orgId,
        grantStatus: wispGrants.status,
        grantRevisionId: wispGrants.currentRevisionId,
      })
      .from(wispThreads)
      .innerJoin(wispGrants, and(eq(wispGrants.id, wispThreads.grantId), eq(wispGrants.partnerId, wispThreads.partnerId)))
      .where(and(
        eq(wispThreads.id, parsed.data),
        eq(wispThreads.partnerId, partnerId),
        eq(wispGrants.grantorUserId, auth.user.id),
      ))
      .limit(1),
  );
  if (!row) return null;
  return {
    thread: {
      id: row.id,
      grantId: row.grantId,
      partnerId: row.partnerId,
      summary: row.summary,
      summaryUpdatedAt: row.summaryUpdatedAt ?? null,
      lastSessionId: row.lastSessionId ?? null,
      focusOrgId: row.focusOrgId ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    grant: { id: row.grantId, orgId: row.grantOrgId ?? null, status: row.grantStatus, currentRevisionId: row.grantRevisionId ?? null },
  };
}

/** The focus org's display name, pinned to the caller's partner; null when unfocused or not visible. */
async function focusOrgNameOf(partnerId: string, orgId: string | null): Promise<string | null> {
  if (orgId === null) return null;
  const [org] = await readOwnPartnerAxisRows(partnerId, () =>
    db
      .select({ name: organizations.name })
      .from(organizations)
      .where(and(eq(organizations.id, orgId), eq(organizations.partnerId, partnerId)))
      .limit(1),
  );
  return org ? org.name.slice(0, FOCUS_NAME_MAX_CHARS) : null;
}

type CeilingOutcome =
  | { ok: true; ceiling: GrantCeiling }
  | { ok: false; reason: 'inactive' | 'corrupt' };

/**
 * The live ceiling of the thread's grant. `inactive` (→ 409 grant_inactive)
 * when the grant has no pinned revision or `resolveGrantCeiling` reports it
 * paused / revoked / expired / Wisp switched off; `corrupt` (→ 500
 * grant_corrupt, already logged and captured) when the pin itself is broken.
 */
async function ceilingOf(own: OwnThread): Promise<CeilingOutcome> {
  if (!own.grant.currentRevisionId) return { ok: false, reason: 'inactive' };
  try {
    return { ok: true, ceiling: await resolveGrantCeiling(own.grant.id, own.grant.currentRevisionId) };
  } catch (err) {
    if (err instanceof GrantInactiveError) {
      if (err.kind !== 'corrupt') return { ok: false, reason: 'inactive' };
      reportCorruptGrant(err, 'ceiling read');
      return { ok: false, reason: 'corrupt' };
    }
    throw err;
  }
}

/** grantAuthority's contract: a `corrupt` pin is data damage — log and capture it, never a quiet refusal. */
function reportCorruptGrant(err: GrantInactiveError, where: string): void {
  console.error(`[WispThreads] grant ${err.grantId} has a corrupt ceiling pin (${where}): ${err.message}`);
  captureException(err, undefined, { grantId: err.grantId });
}

const grantInactive = (c: Context) => fail(c, 409, 'grant_inactive', 'This Wisp delegation is not active');
const grantCorrupt = (c: Context) =>
  fail(c, 500, 'grant_corrupt', "This Wisp grant can't be used. Turn Wisp off and on again.");
const ceilingRefusal = (c: Context, reason: 'inactive' | 'corrupt') =>
  reason === 'corrupt' ? grantCorrupt(c) : grantInactive(c);

// Keyset cursor over (attached_at DESC, session_id DESC): base64url("<iso>|<uuid>").
function encodeCursor(attachedAt: Date, sessionId: string): string {
  return Buffer.from(`${attachedAt.toISOString()}|${sessionId}`, 'utf8').toString('base64url');
}
function decodeCursor(raw: string): { attachedAt: Date; sessionId: string } | null {
  const [iso, sessionId, ...rest] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  if (rest.length > 0 || !iso || !sessionId || !uuid.safeParse(sessionId).success) return null;
  const attachedAt = new Date(iso);
  return Number.isNaN(attachedAt.getTime()) ? null : { attachedAt, sessionId };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const wispThreadRoutes = new Hono();

wispThreadRoutes.get('/', zValidator('query', threadQuery), async (c) => {
  const auth = authOf(c);
  const partnerId = partnerIdOf(auth);
  const { orgId } = c.req.valid('query');
  const grant = await getActiveGrantForUser(auth.user.id, { partnerId, orgId: orgId ?? null });
  if (!grant) return fail(c, 404, 'no_active_grant', 'No active Wisp delegation for this scope');

  const thread = await getOrCreateThread(grant.id);
  const [focusOrgName, widening, spend] = await Promise.all([
    focusOrgNameOf(partnerId, thread.focusOrgId),
    wideningAvailable(grant.id),
    spendSummary(grant.id),
  ]);
  return c.json({
    data: {
      thread: threadDto(thread),
      focusOrgName,
      grant: {
        id: grant.id,
        status: grant.status,
        orgId: grant.orgId,
        expiresAt: grant.expiresAt.toISOString(),
        currentRevisionId: grant.currentRevisionId,
        budgetCentsPerDay: grant.budgetCentsPerDay,
        floorTickMinutes: grant.floorTickMinutes,
        // w00 A32 spend meter (UTC day, runs charged to the day they were queued).
        spentTodayCents: spend.spentTodayCents,
        budgetResetsAt: spend.budgetResetsAt.toISOString(),
      },
      wideningAvailable: widening,
    },
  });
});

wispThreadRoutes.get('/:id/sessions', zValidator('query', sessionsQuery), async (c) => {
  const { limit = SESSIONS_DEFAULT_LIMIT, cursor: rawCursor } = c.req.valid('query');
  const cursor = rawCursor === undefined ? null : decodeCursor(rawCursor);
  if (rawCursor !== undefined && !cursor) return fail(c, 400, 'invalid_cursor', 'Invalid cursor');

  const own = await loadOwnThread(c);
  if (!own) return c.json(NOT_FOUND, 404);
  const partnerId = partnerIdOf(authOf(c));

  const rows = await readOwnPartnerAxisRows(partnerId, () =>
    db
      .select({
        sessionId: wispThreadSessions.sessionId,
        orgId: wispThreadSessions.orgId,
        attachedAt: wispThreadSessions.attachedAt,
        title: aiSessions.title,
        status: aiSessions.status,
      })
      .from(wispThreadSessions)
      .innerJoin(aiSessions, and(eq(aiSessions.id, wispThreadSessions.sessionId), eq(aiSessions.orgId, wispThreadSessions.orgId)))
      .where(and(
        eq(wispThreadSessions.threadId, own.thread.id),
        eq(wispThreadSessions.partnerId, partnerId),
        cursor
          ? or(
            lt(wispThreadSessions.attachedAt, cursor.attachedAt),
            and(eq(wispThreadSessions.attachedAt, cursor.attachedAt), lt(wispThreadSessions.sessionId, cursor.sessionId)),
          )
          : undefined,
      ))
      .orderBy(desc(wispThreadSessions.attachedAt), desc(wispThreadSessions.sessionId))
      .limit(limit + 1),
  );

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return c.json({
    data: page.map((r) => ({
      sessionId: r.sessionId,
      orgId: r.orgId,
      attachedAt: r.attachedAt.toISOString(),
      title: r.title ?? null,
      status: r.status,
    })),
    nextCursor: rows.length > limit && last ? encodeCursor(last.attachedAt, last.sessionId) : null,
  });
});

wispThreadRoutes.patch('/:id/focus', zValidator('json', focusBody), async (c) => {
  const own = await loadOwnThread(c);
  if (!own) return c.json(NOT_FOUND, 404);
  const { orgId } = c.req.valid('json');

  const resolved = await ceilingOf(own);
  if (!resolved.ok) return ceilingRefusal(c, resolved.reason);

  let updated: WispThread;
  try {
    updated = await setThreadFocus(own.thread.id, orgId, resolved.ceiling);
  } catch (err) {
    if (err instanceof CeilingViolationError) {
      if (err.code === 'inactive') return grantInactive(c);
      return fail(c, 403, 'wisp_outside_ceiling', 'That organization is outside this Wisp delegation', { detail: 'org' });
    }
    if (err instanceof GrantInactiveError) {
      if (err.kind !== 'corrupt') return grantInactive(c);
      reportCorruptGrant(err, 'focus change');
      return grantCorrupt(c);
    }
    if (err instanceof WispThreadError && err.code === 'thread_not_found') return c.json(NOT_FOUND, 404);
    throw err;
  }

  writeRouteAudit(c, {
    orgId: null,
    partnerId: own.thread.partnerId,
    action: 'wisp.thread.focus_changed',
    resourceType: 'wisp_thread',
    resourceId: own.thread.id,
    details: { from: own.thread.focusOrgId, to: updated.focusOrgId },
  });
  return c.json({
    data: {
      focusOrgId: updated.focusOrgId,
      focusOrgName: await focusOrgNameOf(own.thread.partnerId, updated.focusOrgId),
    },
  });
});

wispThreadRoutes.get('/:id/attachments', async (c) => {
  const own = await loadOwnThread(c);
  if (!own) return c.json(NOT_FOUND, 404);
  const auth = authOf(c);
  const items = await listThreadAttachments(own.thread.id);
  return c.json({ data: items.filter((a) => auth.canAccessOrg(a.orgId)).map(attachmentDto) });
});

const ATTACHMENT_STATUS: Record<ThreadAttachmentError['code'], ErrorStatus> = {
  too_large: 413,
  unsupported_type: 415,
  empty: 400,
  too_many: 409,
  org_outside_ceiling: 403,
  outside_ceiling: 403,
  store_unavailable: 503,
};

/** The upload, as decoded text — or the refusal to answer with. */
type ParsedUpload =
  | { ok: true; text: string; label: string; contentType: ThreadAttachmentContentType }
  | { ok: false; response: Response };

async function parseUpload(c: Context): Promise<ParsedUpload> {
  const contentType = (c.req.header('content-type') ?? '').toLowerCase();
  let bytes: Uint8Array;
  let label: string;
  let filename: string | undefined;

  if (contentType.startsWith('multipart/form-data')) {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
    } catch {
      return { ok: false, response: fail(c, 400, 'invalid_body', 'Expected a multipart body with one file part named "file"') };
    }
    const file = body.file;
    if (!(file instanceof File)) {
      return { ok: false, response: fail(c, 400, 'invalid_body', 'Expected exactly one file part named "file"') };
    }
    const rawLabel = typeof body.label === 'string' ? body.label.trim() : '';
    filename = file.name || undefined;
    label = rawLabel || file.name || 'attachment';
    // The client's Content-Type for the part is never consulted: bytes only.
    bytes = new Uint8Array(await file.arrayBuffer());
  } else if (contentType.startsWith('application/json')) {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return { ok: false, response: fail(c, 400, 'invalid_body', 'Malformed JSON body') };
    }
    const parsed = textAttachmentBody.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, response: fail(c, 400, 'invalid_body', 'Expected { text, label }') };
    }
    label = parsed.data.label;
    filename = label;
    bytes = Buffer.from(parsed.data.text, 'utf8');
  } else {
    return { ok: false, response: fail(c, 400, 'invalid_body', 'Expected multipart/form-data or application/json') };
  }

  const classified = classifyAttachmentBytes(bytes, filename);
  if (!classified.ok) {
    return {
      ok: false,
      response: fail(c, ATTACHMENT_STATUS[classified.code], classified.code, THREAD_ATTACHMENT_MESSAGES[classified.code]),
    };
  }
  return { ok: true, text: classified.text, label, contentType: classified.contentType };
}

wispThreadRoutes.post(
  '/:id/attachments',
  userRateLimit('wisp-thread-attachment', 30, 60),
  bodyLimit({
    maxSize: WISP_THREAD_ATTACHMENT_BODY_LIMIT,
    onError: bodyLimitOnError('wisp-thread-attachment', WISP_THREAD_ATTACHMENT_BODY_LIMIT, 'Attachment too large (max 5 MiB)'),
  }),
  async (c) => {
    const own = await loadOwnThread(c);
    if (!own) return c.json(NOT_FOUND, 404);
    if (!aiArtifactCaptureEnabled()) {
      return fail(c, 503, 'store_unavailable', 'The attachment store is not enabled on this deployment');
    }
    // An artifact row needs exactly one org: an unfocused partner-wide thread has none (spec §6).
    const orgId = own.thread.focusOrgId ?? own.grant.orgId;
    if (!orgId) {
      return fail(c, 409, 'focus_required', 'Focus the thread on an organization before attaching files');
    }

    const resolved = await ceilingOf(own);
    if (!resolved.ok) return ceilingRefusal(c, resolved.reason);

    const upload = await parseUpload(c);
    if (!upload.ok) return upload.response;

    let added: ThreadAttachment;
    try {
      added = await addThreadAttachment({
        thread: own.thread,
        ceiling: resolved.ceiling,
        orgId,
        label: upload.label,
        text: upload.text,
        addedByUserId: authOf(c).user.id,
        contentType: upload.contentType,
      });
    } catch (err) {
      if (err instanceof ThreadAttachmentError) {
        // `err.message` is internal (ids, limits): it goes to the log, the client gets fixed copy.
        if (err.code === 'store_unavailable') {
          console.error(`[WispThreads] attachment store unavailable for thread ${own.thread.id}: ${err.message}`, err.cause ?? err);
          captureException(err.cause ?? err);
        } else {
          console.warn(`[WispThreads] attachment refused for thread ${own.thread.id} (${err.code}): ${err.message}`);
        }
        return fail(c, ATTACHMENT_STATUS[err.code], err.code, THREAD_ATTACHMENT_MESSAGES[err.code]);
      }
      if (err instanceof GrantInactiveError && err.kind === 'corrupt') {
        reportCorruptGrant(err, 'attachment');
        return grantCorrupt(c);
      }
      if (err instanceof GrantInactiveError || (err instanceof CeilingViolationError && err.code === 'inactive')) {
        return grantInactive(c);
      }
      throw err;
    }

    writeRouteAudit(c, {
      orgId: added.orgId,
      partnerId: own.thread.partnerId,
      action: 'wisp.thread.attachment_added',
      resourceType: 'wisp_thread_attachment',
      resourceId: added.id,
      // No label: it is user text and may carry customer PII (same as ticket attachments).
      details: { artifactId: added.artifactId, bytes: added.bytes, contentType: added.contentType },
    });
    return c.json({ data: attachmentDto(added) }, 201);
  },
);
