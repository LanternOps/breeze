import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../lib/validation';
import { and, eq, gt, desc, inArray, isNull, ne } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { authMiddleware, isInteractiveUserSession } from '../middleware/auth';
import { approvalRequests } from '../db/schema/approvals';
import { aiToolExecutions, aiSessions } from '../db/schema/ai';
import { delegantM365Connections } from '../db/schema/delegant';
import { writeAuditEventAsync } from '../services/auditEvents';
import { captureException } from '../services/sentry';
import {
  actionIntents,
  type ActionIntent,
  type ActionIntentApprovalScope,
  type ActionIntentStatus,
} from '../db/schema/actionIntents';
import { dispatchApprovalPush } from '../services/expoPush';
import { revokeUserOauthClient } from './lifecycle';
import { recordActionIntentEvent } from '../services/actionIntents/metrics';
import { isAgentIntentDecideAuthorized } from '../services/actionIntents/intentApprovers';
import { getUserPermissions, userCanDecideApprovals, canAccessOrg } from '../services/permissions';
import { generateApprovalAssertionOptions } from '../services/approverWebAuthn';
import { issueMobileAssertionNonce } from '../services/mobileHwKey';
import { requireCurrentPasswordStepUp, requireFreshMfaStepUp } from './auth/helpers';
import { authenticatorDevices } from '../db/schema/authenticatorDevices';
// P2-2 (#4189): the decide core plus the row DTO it shares with the read
// surfaces. `decideApprovalRequest` IS the former `decideHandler` body — this
// file keeps only the thin HTTP adapters over it (see
// services/approvals/decideApprovalRequest.ts).
import {
  decideApprovalRequest,
  resolveTargetDevices,
  serialize,
  toIntentAttribution,
  toIntentTargetRef,
  type DecideApprovalResult,
  type IntentAttribution,
  type IntentTargetRef,
} from '../services/approvals/decideApprovalRequest';
import {
  batchAssertionKey,
  decideApprovalBatch,
  loadHomogeneousBatch,
} from '../services/approvals/batchDecide';
import {
  assertionProofSchema,
  mobileHwKeyProofSchema,
  type ApprovalProof,
} from '@breeze/shared';

/** Re-emit a `DecideApprovalResult` as this route's HTTP response. The decide
 *  core returns `{ httpStatus, body }` precisely so the batch path can collect
 *  the same per-row outcomes the single-card routes hand straight back. */
function respond(c: import('hono').Context, r: DecideApprovalResult) {
  return c.json(r.body, r.httpStatus as 200);
}

// Phase 3: accept EITHER the back-compat WebAuthn proof (no `type` on the wire →
// defaulted by assertionProofSchema) OR the mobile_hw_key proof. z.union tries
// the strict mobile literal first, then falls back to the webauthn shape.
const approveProofSchema = z.union([mobileHwKeyProofSchema, assertionProofSchema]);

export const approvalRoutes = new Hono();

approvalRoutes.use('*', authMiddleware);

// Keyset page size (spec §4.2 / task-8 brief): capped at 50 regardless of what
// the caller asks for, defaulting to 50 when omitted.
const PENDING_PAGE_MAX = 50;

/**
 * Opaque `(createdAt, id)` keyset cursor. Base64 of `<isoTimestamp>|<uuid>` —
 * deliberately simple (no signing) since it only encodes a position in an
 * already-authorized, per-caller result set; a forged cursor can at most
 * reorder/replay pages of rows the caller could already see.
 */
function encodePendingCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64');
}

function decodePendingCursor(raw: string): { createdAt: Date; id: string } | null {
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    const sep = decoded.indexOf('|');
    if (sep === -1) return null;
    const iso = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    if (!id) return null;
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

// Matches the `ORDER BY created_at DESC, id DESC` the join below is fetched
// in: a row is "after" the cursor (i.e. belongs on the next page) if it sorts
// strictly later in that same DESC sequence. Compared by value, not array
// index, so a since-decided/filtered-out cursor row never stalls the walk.
function isAfterPendingCursor(
  row: { createdAt: Date; id: string },
  cursor: { createdAt: Date; id: string },
): boolean {
  const rowMs = row.createdAt.getTime();
  const cursorMs = cursor.createdAt.getTime();
  if (rowMs !== cursorMs) return rowMs < cursorMs;
  return row.id < cursor.id;
}

/** The only fields of a linked intent the live-authorization rule reads.
 * Wave 3b: agent-originated intents (`requestingAgentRunId` set) are
 * authorized per-user via `isAgentIntentDecideAuthorized`, which needs the
 * intent's id (memoization key + run lookup), actionName and arguments. */
type LiveAuthzIntent = Pick<
  ActionIntent,
  | 'id'
  | 'status'
  | 'approvalScope'
  | 'orgId'
  | 'requestedByUserId'
  | 'requestingAgentRunId'
  | 'actionName'
  | 'arguments'
  // P2-2 (#4189): `isAgentIntentDecideAuthorized` resolves the intent's
  // target through these two before it looks at the run at all — a
  // tombstoned scope means nobody is decide-authorized.
  | 'scopeKind'
  | 'scopeDeviceId'
  | 'scopeTicketId'
>;

/** An approval row paired with its linked intent's scope (null when the row
 * has no intent). The scope is what lets a client tell a supervised row —
 * decided with a plain click — from a four_eyes one that may demand a
 * step-up, so it must not be dropped on the way out of the projection.
 * `attribution` (wave 3b) rides along for the same reason: without it the
 * serializer cannot mark a row as agent-originated. */
interface AuthorizedApproval {
  approval: typeof approvalRequests.$inferSelect;
  approvalScope: ActionIntentApprovalScope | null;
  attribution: IntentAttribution;
  /** P2-2: the scope columns + org the batched `resolveTargetDevices` pass
   *  needs. Carried on the projection rather than re-fetched per row. */
  targetRef: IntentTargetRef | null;
}

/**
 * "Does `userId` STILL hold `approvals:decide` + access for `orgId`?", memoised
 * per org for the lifetime of one request. A caller can have several pending
 * rows against the same org, and `getUserPermissions` is cached internally, but
 * there's no reason to redo the canAccessOrg/userCanDecideApprovals pairing per
 * row.
 *
 * System-scoped: the org membership/role reads must resolve regardless of the
 * caller's ambient request scope (partner approvers have no
 * `organization_users` row), and a bare (non-exited) `withSystemDbAccessContext`
 * from inside a request context is a no-op passthrough (db/index.ts), hence
 * `runOutsideDbContext`.
 */
function makeOrgDecideAuthorizer(
  userId: string,
  partnerId: string | null,
): (orgId: string) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>();
  return (orgId: string) => {
    let resolved = cache.get(orgId);
    if (!resolved) {
      resolved = runOutsideDbContext(() =>
        withSystemDbAccessContext(() =>
          getUserPermissions(userId, { partnerId: partnerId ?? undefined, orgId }),
        ),
      ).then((perms) => !!perms && canAccessOrg(perms, orgId) && userCanDecideApprovals(perms));
      cache.set(orgId, resolved);
    }
    return resolved;
  };
}

/**
 * Per-user live authority over a SUPERVISED AGENT-originated intent (wave 3b
 * Task 6), memoised per intent id for the lifetime of one request — the
 * pending list is already per-user rows, so this runs once per visible agent
 * intent. Delegates to `isAgentIntentDecideAuthorized` (action-and-target
 * authority: the tool's full RBAC mapping AND reach over the intent's
 * concrete target — never `approvals:decide`, never requester identity, which
 * is NULL for a requester-less intent).
 */
function makeAgentDecideAuthorizer(
  userId: string,
): (intent: LiveAuthzIntent) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>();
  return (intent: LiveAuthzIntent) => {
    let resolved = cache.get(intent.id);
    if (!resolved) {
      resolved = isAgentIntentDecideAuthorized(userId, intent);
      cache.set(intent.id, resolved);
    }
    return resolved;
  };
}

/**
 * THE live-authorization rule for an intent-linked approval row (spec
 * docs/superpowers/specs/ai-mcp/2026-08-05-tier3-supervised-four-eyes-split-design.md
 * §4.2). Deliberately one function shared by every read surface that can hand
 * back a row's contents — `GET /pending`, `GET /pending/count`, `GET /:id` and
 * `POST /:id/assertion-challenge` — so a demoted approver can never be filtered
 * out of the list yet still fetch the same row's `actionArguments` (script
 * bodies, target user emails, device identifiers) from the detail endpoint, or
 * burn a WebAuthn challenge against it.
 *
 * A row is authorized only when its intent is still 'pending_approval' AND
 * either:
 *   - supervised: the caller is still the intent's requester (the row is
 *     always fanned out to the requester for a supervised intent, but this
 *     re-derives identity rather than trusting row ownership alone); or
 *   - four_eyes: the caller currently still holds `approvals:decide` + org
 *     access for the intent's org — an approver demoted after fan-out must
 *     stop seeing (and being able to act on) the row, exactly like the
 *     decide handler's own stale-approver re-check.
 */
async function isIntentRowLiveAuthorized(
  intent: LiveAuthzIntent | null,
  userId: string,
  orgDecideAuthorizer: (orgId: string) => Promise<boolean>,
  agentDecideAuthorizer: (intent: LiveAuthzIntent) => Promise<boolean>,
): Promise<boolean> {
  if (!intent || intent.status !== 'pending_approval') return false;
  // Wave 3b: an AGENT-originated intent has no requester, so the supervised
  // identity rule below can never authorize anyone for it. Supervised agent
  // rows are fanned out to action-and-target-eligible humans and re-checked
  // per user here; four_eyes agent rows keep the unchanged org
  // approvals:decide rule. (`!= null` on purpose: never routes a legacy row
  // whose projection lacks the column into the agent branch.)
  if (intent.requestingAgentRunId != null) {
    if (intent.approvalScope !== 'supervised') return orgDecideAuthorizer(intent.orgId);
    return agentDecideAuthorizer(intent);
  }
  if (intent.approvalScope === 'supervised') return intent.requestedByUserId === userId;
  return orgDecideAuthorizer(intent.orgId);
}

/**
 * Single-row form of the rule above, for the surfaces that read ONE
 * already-owned approval row rather than the caller's whole queue. Loads the
 * linked intent under system scope (same reason the pending join does) and
 * returns both the verdict and the intent's scope so the caller can serialize
 * it without a second read.
 *
 * A row with NO intent — executionId-linked (legacy AI SDK flow),
 * elevationRequestId-linked (PAM), or a plain dev-seed row with none of the
 * three; the `approval_requests_one_source_chk` constraint permits at most one
 * of execution_id / elevation_request_id / intent_id to be set, and permits
 * all three to be NULL — has no scope/live-authz story to re-check and is
 * authorized unchanged.
 */
async function resolveRowLiveAuthorization(
  row: typeof approvalRequests.$inferSelect,
  userId: string,
  partnerId: string | null,
): Promise<{
  authorized: boolean;
  approvalScope: ActionIntentApprovalScope | null;
  attribution: IntentAttribution;
  targetRef: IntentTargetRef | null;
}> {
  if (!row.intentId) return { authorized: true, approvalScope: null, attribution: null, targetRef: null };
  const intentId = row.intentId;
  const intent = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [found] = await db
        .select()
        .from(actionIntents)
        .where(eq(actionIntents.id, intentId));
      return found ?? null;
    }),
  );
  const authorized = await isIntentRowLiveAuthorized(
    intent,
    userId,
    makeOrgDecideAuthorizer(userId, partnerId),
    makeAgentDecideAuthorizer(userId),
  );
  return {
    authorized,
    approvalScope: intent?.approvalScope ?? null,
    attribution: toIntentAttribution(intent),
    targetRef: toIntentTargetRef(intent),
  };
}

/**
 * The full, already-live-authorized set of this caller's pending approval
 * rows (spec §4.2 / task-8 brief). Shared by `GET /pending` and
 * `GET /pending/count` so the two can never drift on what "pending and visible
 * to me" means.
 *
 * approval_requests is Shape-6 (user-id-scoped) — `eq(approvalRequests.userId,
 * userId)` alone already limits this to the caller's own rows under normal
 * RLS. The join onto action_intents (Shape 1, org-scoped) is read under
 * system scope, mirroring the decide handler's own linked-intent read:
 * regardless of the caller's ambient scope, we need to see the intent's
 * current state to decide whether the row is still live — that's an
 * app-layer authorization decision made explicitly by
 * `isIntentRowLiveAuthorized`, not something RLS visibility should gate.
 */
async function fetchAuthorizedPendingApprovals(
  userId: string,
  partnerId: string | null,
): Promise<AuthorizedApproval[]> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ approval: approvalRequests, intent: actionIntents })
        .from(approvalRequests)
        .leftJoin(actionIntents, eq(approvalRequests.intentId, actionIntents.id))
        .where(
          and(
            eq(approvalRequests.userId, userId),
            eq(approvalRequests.status, 'pending'),
            gt(approvalRequests.expiresAt, new Date()),
          ),
        )
        .orderBy(desc(approvalRequests.createdAt), desc(approvalRequests.id)),
    ),
  );

  const orgDecideAuthorizer = makeOrgDecideAuthorizer(userId, partnerId);
  const agentDecideAuthorizer = makeAgentDecideAuthorizer(userId);
  const authorized: AuthorizedApproval[] = [];
  for (const { approval, intent } of rows) {
    if (!approval.intentId) {
      authorized.push({ approval, approvalScope: null, attribution: null, targetRef: null });
      continue;
    }
    if (await isIntentRowLiveAuthorized(intent, userId, orgDecideAuthorizer, agentDecideAuthorizer)) {
      authorized.push({
        approval,
        approvalScope: intent?.approvalScope ?? null,
        attribution: toIntentAttribution(intent),
        targetRef: toIntentTargetRef(intent),
      });
    }
  }
  return authorized;
}

approvalRoutes.get('/pending', async (c) => {
  const userId = c.get('auth').user.id;
  const partnerId = c.get('auth').partnerId ?? null;

  const requestedLimit = Number(c.req.query('limit'));
  const limit =
    Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(Math.floor(requestedLimit), PENDING_PAGE_MAX)
      : PENDING_PAGE_MAX;

  const cursorParam = c.req.query('cursor');
  const cursor = cursorParam ? decodePendingCursor(cursorParam) : null;

  const authorized = await fetchAuthorizedPendingApprovals(userId, partnerId);
  const afterCursor = cursor
    ? authorized.filter((r) => isAfterPendingCursor(r.approval, cursor))
    : authorized;
  const page = afterCursor.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    afterCursor.length > limit && last
      ? encodePendingCursor(last.approval.createdAt, last.approval.id)
      : null;

  // Batched lookup: one query resolves the customer tenant for ALL M365
  // mutation rows in this page (no N+1).
  const tenants = await lookupCustomerTenants(page.map((r) => r.approval));
  // P2-2: ONE batched pass for the whole page (at most two queries total —
  // runs, then devices), never a lookup per row.
  const targetDevices = await resolveTargetDevices(
    page.map(({ approval, targetRef }) => ({ key: approval.id, intent: targetRef })),
  );
  return c.json({
    approvals: page.map(({ approval, approvalScope, attribution, targetRef }) =>
      serialize(
        approval,
        (approval.executionId && tenants.get(approval.executionId)) || null,
        approvalScope,
        attribution,
        targetDevices.get(approval.id) ?? null,
        targetRef?.orgId ?? null,
      ),
    ),
    nextCursor,
  });
});

// Registered BEFORE the `/:id` param route below so Hono never captures
// 'count' as an :id. Same filters as `/pending`, unpaginated — the whole
// live-authorized set's length, not a raw table count(*) (which couldn't
// account for the app-layer four_eyes/supervised live-authz filter above).
approvalRoutes.get('/pending/count', async (c) => {
  const userId = c.get('auth').user.id;
  const partnerId = c.get('auth').partnerId ?? null;
  const authorized = await fetchAuthorizedPendingApprovals(userId, partnerId);
  return c.json({ count: authorized.length });
});

const denySchema = z.object({
  reason: z.string().max(500).optional(),
});

const seedSchema = z.object({
  actionLabel: z.string().min(1).max(500),
  actionToolName: z.string().min(1).max(255),
  actionArguments: z.record(z.string(), z.unknown()).optional(),
  riskTier: z.enum(['low', 'medium', 'high', 'critical']),
  riskSummary: z.string().min(1).max(500),
  requestingClientLabel: z.string().min(1).max(255).optional(),
  requestingMachineLabel: z.string().max(255).optional(),
  expiresInSeconds: z.number().int().min(10).max(3600).optional(),
});

// DEV ONLY: 404 outside development/test environments.
approvalRoutes.post('/dev/seed', zValidator('json', seedSchema), async (c) => {
  const env = process.env.NODE_ENV;
  if (env !== 'development' && env !== 'test') {
    return c.json({ error: 'Not found' }, 404);
  }

  const userId = c.get('auth').user.id;
  const body = c.req.valid('json');
  const expiresAt = new Date(Date.now() + (body.expiresInSeconds ?? 60) * 1000);

  const [row] = await db
    .insert(approvalRequests)
    .values({
      userId,
      requestingClientLabel: body.requestingClientLabel ?? 'Dev Seed',
      requestingMachineLabel: body.requestingMachineLabel ?? null,
      actionLabel: body.actionLabel,
      actionToolName: body.actionToolName,
      actionArguments: body.actionArguments ?? {},
      riskTier: body.riskTier,
      riskSummary: body.riskSummary,
      status: 'pending',
      // Dev/seed never simulates the self-approval loop — that path is
      // exercised by deliberately picking a real Breeze Mobile OAuth grant.
      isRecursive: false,
      expiresAt,
    })
    .returning();

  if (!row) {
    return c.json({ error: 'Failed to create approval' }, 500);
  }

  // Push is best-effort — seed must succeed even with no registered token.
  // dispatchApprovalPush fans out across every provider (Expo relay + native
  // APNs) and never throws.
  const push = await dispatchApprovalPush(userId, {
    approvalId: row.id,
    actionLabel: row.actionLabel,
    requestingClientLabel: row.requestingClientLabel,
  });

  return c.json(
    {
      approval: serialize(row),
      push,
    },
    201
  );
});

// ---------------------------------------------------------------- batch ---
//
// P2-2 (#4189). MUST stay registered ABOVE the `/:id/...` routes below:
// `/batch/assertion-challenge` has the same shape as `/:id/assertion-challenge`
// and Hono matches in registration order, so a later registration would be
// swallowed as `id === 'batch'`. Mounted on `approvalRoutes` (not a sub-router)
// so both `/approvals` and `/mobile/approvals` get them.
//
// The array cap here is a parse bound only; `BATCH_MAX` is enforced in
// `loadHomogeneousBatch` so a direct service caller cannot slip past it and the
// over-cap answer is the semantic `batch_too_large`, not a schema error.
const BATCH_ID_CAP = 200;
const batchTargetSchema = z.object({
  approvalRequestIds: z.array(z.string().min(1)).min(1).max(BATCH_ID_CAP),
  decision: z.enum(['approved', 'denied']),
});
const batchDecideSchema = batchTargetSchema.extend({
  reason: z.string().max(500).optional(),
  proof: approveProofSchema.optional(),
});

/**
 * One assertion challenge for a whole homogeneous set of supervised
 * agent-originated cards.
 *
 * `loadHomogeneousBatch` runs the FULL set of rules before anything is minted:
 * ownership, `pending` status, the supervised + agent-originated shape, LIVE
 * AUTHORIZATION per row (the intent still `pending_approval` and
 * `isAgentIntentDecideAuthorized` still true — the same rule `GET /pending`,
 * `GET /:id` and the single-card challenge route apply), and finally the
 * one-`(orgId, actionToolName, action)`-group check. Any failure is a 422 for
 * the whole set with the offending ids, and NO challenge is minted — a caller
 * who can no longer act on even one of these rows must never consume a
 * challenge/nonce, exactly as the single-card route orders its own check ahead
 * of minting.
 */
approvalRoutes.post(
  '/batch/assertion-challenge',
  zValidator('json', batchTargetSchema),
  async (c) => {
    const auth = c.get('auth');
    if (!isInteractiveUserSession(auth)) {
      return c.json({ error: 'human_decision_required' }, 403);
    }
    const userId = auth.user.id;
    const { approvalRequestIds, decision } = c.req.valid('json');

    const loaded = await loadHomogeneousBatch(userId, approvalRequestIds);
    if (!loaded.ok) return c.json(loaded.body, loaded.httpStatus as 422);

    const challengeKey = batchAssertionKey(loaded.ids, decision);

    // Identical device query to the single-card challenge route: the caller's
    // active platform approver devices (the userId predicate is
    // defense-in-depth on top of RLS).
    const approverDevices = await db
      .select()
      .from(authenticatorDevices)
      .where(
        and(
          eq(authenticatorDevices.userId, userId),
          eq(authenticatorDevices.kind, 'webauthn_platform'),
          isNull(authenticatorDevices.disabledAt),
        ),
      );

    const options = await generateApprovalAssertionOptions({
      approvalId: challengeKey,
      userId,
      devices: approverDevices
        .filter((d) => d.credentialId)
        .map((d) => ({ credentialId: d.credentialId!, transports: d.transports })),
    });

    // Phase 3 parity: a registered mobile approver device also gets a nonce,
    // bound to the same batch key, so a phone can sign the batch decision.
    const [mobileDevice] = await db
      .select({ id: authenticatorDevices.id })
      .from(authenticatorDevices)
      .where(
        and(
          eq(authenticatorDevices.userId, userId),
          eq(authenticatorDevices.kind, 'mobile_hw_key'),
          isNull(authenticatorDevices.disabledAt),
        ),
      );

    let mobileNonce: string | undefined;
    if (mobileDevice) {
      mobileNonce = await issueMobileAssertionNonce(challengeKey, userId);
    }

    return c.json(mobileNonce ? { options, mobileNonce } : { options });
  },
);

/**
 * Decide the whole set. 200 carries a per-row `results` array — a row that lost
 * its own race (409) or expired (410) does not stop the others; a batch-level
 * refusal (422 heterogeneous, 403 step-up, 400 too large) decides NOTHING.
 */
approvalRoutes.post('/batch/decide', zValidator('json', batchDecideSchema), async (c) => {
  const auth = c.get('auth');
  if (!isInteractiveUserSession(auth)) {
    return c.json({ error: 'human_decision_required' }, 403);
  }
  const body = c.req.valid('json');
  const outcome = await decideApprovalBatch(auth, {
    approvalRequestIds: body.approvalRequestIds,
    decision: body.decision,
    reason: body.reason,
    proof: body.proof,
  });
  if (!outcome.ok) return c.json(outcome.body, outcome.httpStatus as 422);
  return c.json({ results: outcome.results });
});

approvalRoutes.get('/:id', async (c) => {
  const userId = c.get('auth').user.id;
  const partnerId = c.get('auth').partnerId ?? null;
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Bad request' }, 400);
  const [row] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.id, id), eq(approvalRequests.userId, userId)));

  if (!row) return c.json({ error: 'Not found' }, 404);

  // Same live-authorization filter `/pending` applies (see
  // isIntentRowLiveAuthorized). Row ownership alone is NOT sufficient here:
  // this response carries actionArguments / actionLabel / riskSummary — script
  // bodies, target user emails, device identifiers — so a four_eyes approver
  // demoted after fan-out (or a supervised row whose intent already settled)
  // must not be able to read them just because the row is still theirs.
  // Indistinguishable-from-missing 404, matching the not-found branch above.
  const live = await resolveRowLiveAuthorization(row, userId, partnerId);
  if (!live.authorized) return c.json({ error: 'Not found' }, 404);

  const tenants = await lookupCustomerTenants([row]);
  const customerTenant = (row.executionId && tenants.get(row.executionId)) || null;
  const targetDevices = await resolveTargetDevices([{ key: row.id, intent: live.targetRef }]);
  return c.json({
    approval: serialize(
      row,
      customerTenant,
      live.approvalScope,
      live.attribution,
      targetDevices.get(row.id) ?? null,
      live.targetRef?.orgId ?? null,
    ),
  });
});

// Phase 2: issue a short-lived (120s) WebAuthn assertion challenge bound to
// {approvalId,userId} so the technician can satisfy a Windows-Hello / Touch-ID
// step-up before approving. allowCredentials is the caller's active platform
// approver devices; with none registered the options carry no allowCredentials
// and the console falls back to an L1 (session-tap) approval — P2 is opt-in.
approvalRoutes.post('/:id/assertion-challenge', async (c) => {
  const userId = c.get('auth').user.id;
  const partnerId = c.get('auth').partnerId ?? null;
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Bad request' }, 400);

  const [existing] = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.id, id),
        eq(approvalRequests.userId, userId),
        eq(approvalRequests.status, 'pending'),
      ),
    );
  if (!existing) return c.json({ error: 'Not found' }, 404);

  // Same live-authorization filter `/pending` and `GET /:id` apply. Ordered
  // BEFORE the challenge is minted for the same reason the decide handler
  // orders its stale-approver re-check ahead of the assurance proof: a caller
  // who can no longer act on this row must never consume a challenge/nonce.
  const live = await resolveRowLiveAuthorization(existing, userId, partnerId);
  if (!live.authorized) return c.json({ error: 'Not found' }, 404);

  // Caller's active platform approver devices (RLS scopes to the user; the
  // userId predicate is defense-in-depth — see reference memory: admin-list IDOR).
  const devices = await db
    .select()
    .from(authenticatorDevices)
    .where(
      and(
        eq(authenticatorDevices.userId, userId),
        eq(authenticatorDevices.kind, 'webauthn_platform'),
        isNull(authenticatorDevices.disabledAt),
      ),
    );

  const options = await generateApprovalAssertionOptions({
    approvalId: id,
    userId,
    devices: devices
      .filter((d) => d.credentialId)
      .map((d) => ({ credentialId: d.credentialId!, transports: d.transports })),
  });

  // Phase 3: if the caller has an active mobile_hw_key approver device, also
  // issue a short-lived (120s) raw nonce bound to {approvalId,userId} that the
  // mobile app signs in its Secure Enclave / Keystore. This is NOT WebAuthn —
  // it rides alongside the webauthn options so a console-or-phone approver gets
  // whichever factor their registered devices support (mobileNonce omitted when
  // no mobile device is registered).
  const [mobileDevice] = await db
    .select({ id: authenticatorDevices.id })
    .from(authenticatorDevices)
    .where(
      and(
        eq(authenticatorDevices.userId, userId),
        eq(authenticatorDevices.kind, 'mobile_hw_key'),
        isNull(authenticatorDevices.disabledAt),
      ),
    );

  let mobileNonce: string | undefined;
  if (mobileDevice) {
    mobileNonce = await issueMobileAssertionNonce(id, userId);
  }

  return c.json(mobileNonce ? { options, mobileNonce } : { options });
});

approvalRoutes.post('/:id/approve', async (c) => {
  // Optional assertion proof (Phase 2 webauthn / Phase 3 mobile_hw_key). A
  // malformed proof is a 400 at validation; an absent proof keeps today's L1
  // session-tap behavior.
  let proof: ApprovalProof | undefined;
  const raw = await c.req.json().catch(() => null);
  if (raw && raw.proof !== undefined) {
    const parsed = approveProofSchema.safeParse(raw.proof);
    if (!parsed.success) return c.json({ error: 'Invalid proof' }, 400);
    proof = parsed.data;
  }

  // L4 (critical) re-auth: the client may include a fresh `reauthPassword` to
  // satisfy the critical-tier re-authentication factor (spec §5). Verified
  // server-side here — a bad/rate-limited password short-circuits with the
  // helper's own 401/429/503; a valid one flips reauthVerified. Absent → false,
  // which only matters for a critical approval (it then 401s 'reauth_required'
  // so the client knows to collect the password and retry).
  let reauthVerified = false;
  if (raw && typeof raw.reauthPassword === 'string' && raw.reauthPassword.length > 0) {
    const reauthError = await requireCurrentPasswordStepUp(
      c,
      c.get('auth').user.id,
      raw.reauthPassword,
      'approval:reauth'
    );
    if (reauthError) return reauthError;
    reauthVerified = true;
  } else if (raw && typeof raw.reauthMfaCode === 'string' && raw.reauthMfaCode.length > 0) {
    // Login-MFA (TOTP) fallback for SSO-only / passwordless accounts that have
    // no password to satisfy the password step-up above.
    const reauthError = await requireFreshMfaStepUp(
      c,
      c.get('auth').user.id,
      raw.reauthMfaCode,
      'approval:reauth-mfa'
    );
    if (reauthError) return reauthError;
    reauthVerified = true;
  }

  return respond(
    c,
    await decideApprovalRequest({
      auth: c.get('auth'),
      id: c.req.param('id'),
      status: 'approved',
      proof,
      reauthVerified,
    }),
  );
});

approvalRoutes.post('/:id/deny', zValidator('json', denySchema), async (c) => {
  const reason = c.req.valid('json').reason;
  return respond(
    c,
    await decideApprovalRequest({
      auth: c.get('auth'),
      id: c.req.param('id'),
      status: 'denied',
      reason,
    }),
  );
});

/**
 * Which org the `security.suspicious_report` audit row belongs to (#3234).
 *
 * The row must be tenanted to the APPROVAL BEING REPORTED, not to whoever
 * reported it. `approval_requests` has no `org_id` column of its own, so the
 * linked `action_intents` row is the only authoritative source; the reporter's
 * own org is a fallback, and for a partner-scoped caller it is `null`.
 *
 * Resolution order (per #3234): linked intent's org → reporter's org → NULL.
 * NULL is therefore only reached when there is honestly no org to name — an
 * unlinked row (dev seed / PAM) reported by a partner-scoped user — rather than
 * being the accidental outcome of reading tenancy off the caller's token, which
 * is what made the endpoint 500 for every partner-scoped caller.
 *
 * Runs in a system-scope context of its own: `action_intents` is org-scoped
 * (Shape 1) and a partner user with `orgAccess: 'selected'` can legitimately
 * own an approval for an org outside its curated list, so the request context
 * is not guaranteed to see the intent. Same reasoning as the flip transaction
 * above. `runOutsideDbContext` is required, not stylistic — a nested
 * `withDbAccessContext` short-circuits and RETAINS the ambient scope rather
 * than elevating (see `db/index.ts`).
 *
 * Only called when the flip transaction did NOT run — an already-decided row,
 * or a row with no linked intent at all (which short-circuits to the caller's
 * org). When that transaction did run it already read the intent's org under
 * `FOR UPDATE`, on both CAS outcomes, so there is nothing to look up.
 *
 * Never throws. A transient failure here degrades the audit row's tenancy to
 * the caller's org, which is exactly the old (wrong) behaviour — but losing
 * attribution on one row beats propagating out of a security action and 500ing
 * the report, which is the very failure mode #3234 is about.
 */
async function resolveReportAuditOrgId(
  intentId: string | null,
  callerOrgId: string | null,
): Promise<string | null> {
  if (!intentId) return callerOrgId;
  try {
    const [intent] = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db
          .select({ orgId: actionIntents.orgId })
          .from(actionIntents)
          .where(eq(actionIntents.id, intentId))
          .limit(1),
      ),
    );
    return intent?.orgId ?? callerOrgId;
  } catch (err) {
    console.error(
      '[approvals] report-suspicious: failed to resolve the reported approval\'s org; falling back to the caller org:',
      err,
    );
    captureException(err);
    return callerOrgId;
  }
}

// "This wasn't me." Reports the in-flight approval as malicious, denies it,
// revokes the requesting OAuth client's grant + refresh tokens, and writes a
// security audit row. Revocation and the audit row are unconditional — the
// report is authoritative for those regardless of how the decision race below
// resolves.
//
// The denial itself takes one of two shapes, depending on how the row was
// created:
//   - INTENT-linked (durable supervised / four_eyes path): the report is a
//     strong DENY of the whole intent. A single transaction CASes THIS row
//     'pending' -> 'reported', CASes the intent 'pending_approval' ->
//     'rejected', and expires every sibling approval row. `ai_tool_executions`
//     is never touched — an intent-backed row has no execution link (the
//     `approval_requests_one_source_chk` constraint permits at most one of
//     execution_id / elevation_request_id / intent_id).
//   - EXECUTION-linked (legacy AI mobile-push flow) or unlinked (dev seed /
//     PAM): a single flip of this row plus a best-effort
//     `ai_tool_executions` mirror to 'rejected', so the SDK's waitForApproval
//     resolves with denial. Behaves identically to /deny from the SDK's
//     perspective.
//
// Responses: 204 when the report actually stopped the action, 404 when the row
// isn't the caller's, 409 `already_decided` when a concurrent decide won the
// intent first (the flagged action IS going to run — the caller must never
// read that as "your report stopped it"), 500 `report_suspicious_failed` when
// the intent transaction rolled back.
approvalRoutes.post('/:id/report-suspicious', async (c) => {
  const userId = c.get('auth').user.id;
  // The REPORTER's own org, which is only the last-resort tenant for the audit
  // row below — a partner-scoped caller carries `orgId: null` (#3234). See
  // `resolveReportAuditOrgId` for the resolution order and why it matters.
  const callerOrgId = c.get('auth').orgId ?? null;
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Bad request' }, 400);

  // Look up the row first so we can capture client_id even if it's already decided.
  const [existing] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.id, id), eq(approvalRequests.userId, userId)));

  if (!existing) return c.json({ error: 'Not found' }, 404);

  // Set when the intent CAS below matched ZERO rows — i.e. a concurrent decide
  // (or the reaper) already moved the intent out of 'pending_approval'. On an
  // 'approved' terminal state the outbox event is queued and the durable
  // release worker WILL run the very action the user just flagged, so the
  // response must be distinguishable from "your report stopped it": the
  // handler answers 409 `already_decided` at the end instead of 204.
  // Deliberately NOT an early return — the OAuth-client revocation and the
  // security audit row below are exactly what a user reporting a compromised
  // client needs most when the action already slipped through.
  let intentRaceLost: { finalStatus: ActionIntentStatus | null } | null = null;

  // Set IFF the flip transaction below actually ran and read the linked intent
  // under `FOR UPDATE`. The object's presence is the signal "we already have an
  // authoritative read, don't look it up again"; its `orgId` is null only in the
  // narrow case where the intent row vanished from under the lock. Stays null
  // when there is no linked intent, or when the flip block was skipped because
  // the row was already decided — those are the cases that need a lookup.
  let lockedIntent: { orgId: string | null } | null = null;

  // Flip status to 'reported' if still pending, else leave as-is. Either way
  // we treat the report as authoritative for revocation + audit.
  if (existing.status === 'pending') {
    // Intent-backed rows (durable four-eyes / supervised path) carry
    // `intentId`, not `executionId`. A suspicious report is a strong DENY, so
    // it must reject the whole intent and expire every SIBLING approval row —
    // otherwise the intent stays pending_approval and another approver's
    // still-live row could approve the action the reporter just flagged as
    // malicious. Mirrors the decide handler's fan-in (first-wins CAS +
    // system-scope sibling expiry). Runs in system scope: action_intents is
    // org-scoped and sibling approval_requests rows belong to OTHER
    // approvers, invisible to this user's request context.
    if (existing.intentId) {
      const intentId = existing.intentId;
      // Fix round 1, finding 1: the 'reported' flip for THIS row is now
      // folded into the SAME transaction as the intent CAS + sibling expiry
      // (it used to be a separate, unconditional statement committed BEFORE
      // this transaction even opened). Previously, a throw here rolled back
      // only the intent CAS/sibling-expiry — the flip had already committed —
      // so a retry's pre-fetch saw status='reported' (not 'pending'), the
      // outer `if` above never re-entered, and the intent was permanently
      // stranded `pending_approval` with live sibling rows that could still
      // approve the flagged action. Folding the flip in here means a
      // rollback restores 'pending' too, so a retry genuinely replays
      // everything (flip + intent CAS + sibling expiry) as one unit, same as
      // the main decide handler's atomic write.
      //
      // Fix round 1, finding 2 (lock-order inversion): lock the intent row
      // FIRST, before touching approval_requests — the SAME order the decide
      // handler's transaction now takes (see its own comment for the
      // deadlock this prevents between concurrent decide / report-suspicious
      // / intentExpiryReaper transactions).
      //
      // A genuine throw is NOT swallowed — it rolls this whole transaction
      // back (flip + intent CAS + sibling expiry all undone) and the request
      // fails with a retryable 500 BEFORE revocation/audit run, rather than
      // silently leaving a half-applied state while still reporting success.
      //
      // Fix round 2, finding 2: BOTH writes in here are now compare-and-swap.
      //  - The 'reported' flip predicates on `status = 'pending'`. Without it,
      //    a decide transaction that committed between this handler's
      //    unlocked pre-fetch above and this statement had its
      //    just-written 'approved' (plus decided_by / assurance columns)
      //    silently OVERWRITTEN by 'reported' — destroying the record of who
      //    approved the action while the approval itself remained in force.
      //    A zero-row flip is deliberately NOT fatal: the intent CAS below
      //    still runs, and if IT wins the report has genuinely stopped the
      //    action even though this row already records the racing decision.
      //    That asymmetry is the safe direction — a deny always wins.
      //  - A zero-row intent CAS is now reported to the caller (see
      //    `intentRaceLost`) instead of falling through to a 204 that
      //    is indistinguishable from a report that actually stopped the
      //    action.
      // The intent's terminal status comes from the FOR UPDATE lock row read
      // at the top of the transaction: the lock serialises this transaction
      // behind any in-flight decide, so what it reads is the committed state
      // the CAS is about to be judged against.
      try {
        const outcome = await runOutsideDbContext(() =>
          withSystemDbAccessContext(() =>
            db.transaction(async (tx) => {
              // `orgId` is selected here — not just taken from the CAS
              // `.returning()` below — because the audit row needs the
              // intent's org whether or not the CAS wins. On a lost race
              // `cas` is empty but the report still writes revocation + an
              // audit row, and that row must still be tenanted to the
              // approval's org rather than falling back to the reporter's
              // (which is NULL for a partner-scoped caller, #3234).
              const [locked] = await tx
                .select({
                  id: actionIntents.id,
                  status: actionIntents.status,
                  orgId: actionIntents.orgId,
                })
                .from(actionIntents)
                .where(eq(actionIntents.id, intentId))
                .for('update');

              await tx
                .update(approvalRequests)
                .set({
                  status: 'reported',
                  decidedAt: new Date(),
                  decisionReason: 'Reported as suspicious by user',
                })
                .where(
                  and(
                    eq(approvalRequests.id, id),
                    eq(approvalRequests.userId, userId),
                    eq(approvalRequests.status, 'pending'),
                  ),
                );

              const cas = await tx
                .update(actionIntents)
                .set({ status: 'rejected', decidedAt: new Date(), decidedByUserId: userId })
                .where(
                  and(
                    eq(actionIntents.id, intentId),
                    eq(actionIntents.status, 'pending_approval'),
                  ),
                )
                .returning({
                  orgId: actionIntents.orgId,
                  actionName: actionIntents.actionName,
                  argumentDigest: actionIntents.argumentDigest,
                  source: actionIntents.source,
                });
              if (cas.length === 0) {
                return {
                  rejected: null,
                  finalIntentStatus: locked?.status ?? null,
                  intentOrgId: locked?.orgId ?? null,
                };
              }

              await tx
                .update(approvalRequests)
                .set({ status: 'expired', decidedAt: new Date() })
                .where(
                  and(
                    eq(approvalRequests.intentId, intentId),
                    eq(approvalRequests.status, 'pending'),
                    ne(approvalRequests.id, existing.id),
                  ),
                );

              return {
                rejected: cas[0] ?? null,
                finalIntentStatus: null,
                intentOrgId: locked?.orgId ?? null,
              };
            }),
          ),
        );
        // Carry the linked intent's org out to the audit write below. Recorded
        // on BOTH CAS outcomes, so the only report-suspicious path that still
        // needs a lookup is the one where this whole block never ran (an
        // already-decided row).
        lockedIntent = { orgId: outcome.intentOrgId ?? null };
        const rejected = outcome.rejected;
        if (rejected) {
          recordActionIntentEvent({
            orgId: rejected.orgId,
            intentId,
            actionName: rejected.actionName,
            argumentDigest: rejected.argumentDigest,
            source: rejected.source,
            outcome: 'rejected',
            actorId: userId,
            details: { reportedSuspicious: true, approvalRequestId: existing.id },
          });
        } else {
          // Lost the race. `finalStatus` can still be null if the intent row
          // vanished from under the lock (FK cascade); surface the conflict
          // either way rather than a misleading 204.
          intentRaceLost = { finalStatus: outcome.finalIntentStatus };
        }
      } catch (err) {
        console.error('[approvals] report-suspicious: failed to reject linked action intent (rolled back):', err);
        return c.json({ error: 'report_suspicious_failed', retryable: true }, 500);
      }
    } else {
      // Non-intent-linked rows (executionId-linked legacy AI mobile-push
      // flow, or plain dev-seed/PAM rows with neither): unchanged from
      // before this fix round — a single flip statement, plus a best-effort
      // ai_tool_executions mirror. There is no intent/sibling fan-in for
      // these rows, so there is nothing else to make atomic with the flip.
      await db
        .update(approvalRequests)
        .set({
          status: 'reported',
          decidedAt: new Date(),
          decisionReason: 'Reported as suspicious by user',
        })
        .where(and(eq(approvalRequests.id, id), eq(approvalRequests.userId, userId)));

      // Mirror to ai_tool_executions so the SDK waiter unblocks with denial.
      //
      // Runs in its OWN system-scope transaction, for the same two reasons the
      // audit write below does (#3234) — this try/catch used to be unable to
      // deliver on either of its apparent promises:
      //   1. It could not actually contain a failure. A SQL error here aborts
      //      the ambient REQUEST transaction, so catching the JS error left the
      //      transaction poisoned and the commit threw — a 500 that also rolled
      //      back the 'reported' flip immediately above. Catching an error does
      //      not heal a Postgres transaction.
      //   2. `ai_tool_executions` is org-scoped through an EXISTS join on
      //      `ai_sessions.org_id`, so whenever the caller's accessible-org list
      //      does not cover the execution's org the UPDATE silently matched
      //      ZERO rows — no error (an UPDATE filtered out by a USING clause is
      //      not a violation, just an empty match), no mirror, and the SDK's
      //      waitForApproval never unblocks with the denial. Note the trigger
      //      is the ORG LIST, not the scope: a partner-scoped caller with
      //      `orgAccess: 'all'` does reach the row, while one with
      //      `orgAccess: 'selected'` that excludes the org does not — as does
      //      any org-scoped caller in a different org. Same reasoning as the
      //      intent CAS above, which is already system-scoped for exactly this.
      // Still best-effort: the approval flip and the audit row are the
      // authoritative record, and a missed mirror only delays the SDK waiter to
      // its own timeout rather than letting the flagged action through.
      if (existing.executionId) {
        const executionId = existing.executionId;
        try {
          await runOutsideDbContext(() =>
            withSystemDbAccessContext(() =>
              db
                .update(aiToolExecutions)
                .set({ status: 'rejected', approvedBy: userId, approvedAt: new Date() })
                .where(eq(aiToolExecutions.id, executionId)),
            ),
          );
        } catch (err) {
          console.error('[approvals] report-suspicious: failed to mirror to ai_tool_executions:', err);
          captureException(err);
        }
      }
    }
  }

  // Revoke the requesting OAuth client (grant + refresh tokens) for this user.
  // Delegates to the canonical lifecycle.ts soft-revoke flow, which:
  //   1. UPDATEs oauth_grants.revoked_at + revoked_by_user_id + revoked_reason
  //      (was: DELETE — left audit-history empty AND skipped #2 below).
  //   2. Stamps every active refresh token's revoked_at AND revokes the JTI
  //      in the Redis access-token blocklist so any in-flight access JWT is
  //      rejected by bearerTokenAuthMiddleware before its natural ~15-min
  //      TTL expiry. The old delete-only path left a ~15-min window where
  //      access tokens minted from the (now-revoked) grant would continue
  //      working — a real gap for a user-initiated suspicious-report flow.
  //   3. Writes belt-and-suspenders grant-revocation cache markers for
  //      direct-authorize grants that don't have a refresh token row.
  const requestingClientId = existing.requestingClientId;
  let grantsRevoked = 0;
  let refreshTokensRevoked = 0;
  if (requestingClientId) {
    try {
      ({ grantsRevoked, refreshTokensRevoked } = await revokeUserOauthClient(
        userId,
        requestingClientId,
        userId,
        'self-reported suspicious approval',
      ));
    } catch (err) {
      console.error('[approvals] report-suspicious: revocation failed:', err);
      // Escalated to Sentry, not just stdout: a swallowed failure here means the
      // client the user just called compromised still holds a live grant and
      // refresh tokens, while they get a 204. `revokeUserOauthClient` fails
      // closed on Redis-marker problems, so this catch fires on real infra
      // faults — exactly the case nobody would notice from a stdout line.
      captureException(err);
      // Still non-fatal: the approval row + audit log are authoritative, and the
      // user can revoke from the connected-apps UI as a fallback.
    }
  }

  // Audit row — security.suspicious_report, tenanted to the reported approval.
  //
  // Deliberately NOT a raw `db.insert(auditLogs)` inside the request
  // transaction, and NOT atomic with the approval flip above (#3234). Both
  // properties are load-bearing; please don't "tidy" this back into the
  // request transaction, which is precisely how this endpoint 500'd for every
  // partner-scoped caller:
  //
  //   - `writeAuditEventAsync` persists via `createAuditLogAsync` →
  //     `auditService.persistAuditLog`, which runs
  //     `runOutsideDbContext(() => withSystemDbAccessContext(...))`.
  //     That is what lets a NULL org_id land at all: the `audit_logs` INSERT
  //     policy is `WITH CHECK breeze_has_org_access(org_id)`, and that helper
  //     returns FALSE for a NULL org under any non-system scope but TRUE under
  //     `system`. An org-less report is genuinely unattributable, so writing
  //     the row NULL-org under system scope beats inventing a tenant.
  //   - Because it commits independently, a failing audit write can no longer
  //     abort the caller's transaction. The old inline insert could not be
  //     rescued by its own try/catch: Postgres aborts the whole TRANSACTION on
  //     an RLS violation, so the swallowed error resurfaced when the request
  //     transaction committed — a 500 that ALSO rolled back the 'reported'
  //     flip, leaving the flagged approval pending. A security action that
  //     fails open.
  //   - The lost atomicity is the intended trade, not a side effect: a
  //     `security.suspicious_report` records that someone reported something,
  //     which stays true whether or not the flip that followed committed.
  //     Losing the audit trail when surrounding work rolls back is the worse
  //     failure for a security action.
  //
  // `writeAuditEventAsync`'s returned promise never rejects — a genuine write
  // failure is queued for retry with backoff and escalated to Sentry on
  // exhaustion, so the security action still takes effect instead of 500ing.
  // Be precise about how strong that is: `auditService`'s retry queue is
  // in-memory and bounded (3 attempts, drained every 30s), so it covers a
  // transient DB blip but NOT an outage that outlives the attempts, and a
  // process restart landing mid-retry drops the entry with no signal at all.
  // That is the repo-wide audit durability story rather than anything specific
  // to this handler; it is still strictly better than the raw insert this
  // replaced, which had no retry AND poisoned the request transaction.
  // The try/catch is still not redundant: the function is not
  // `async`, so its synchronous prologue (details sanitizing, trusted-client-IP
  // resolution, header reads) can throw BEFORE the retry-backed promise exists.
  // "The audit machinery must never turn this security action into a 500" is
  // the requirement, so it is enforced here rather than assumed.
  const auditOrgId = lockedIntent
    ? (lockedIntent.orgId ?? callerOrgId)
    : await resolveReportAuditOrgId(existing.intentId, callerOrgId);
  try {
    await writeAuditEventAsync(c, {
      orgId: auditOrgId,
      actorType: 'user',
      actorId: userId,
      actorEmail: c.get('auth').user.email,
      action: 'security.suspicious_report',
      resourceType: 'approval_request',
      resourceId: existing.id,
      resourceName: existing.actionLabel.slice(0, 255),
      details: {
        approvalId: existing.id,
        requestingClientId,
        requestingClientLabel: existing.requestingClientLabel,
        actionToolName: existing.actionToolName,
        priorStatus: existing.status,
        grantsRevoked,
        // Named `refreshRevocationCount`, NOT `refreshTokensRevoked`, and please
        // don't rename it back. `writeAuditEventAsync` runs details through
        // `sanitizeAuditPayload` → `redactLogFields`, whose `SECRET_KEY_PATTERN`
        // matches the bare substring `token` anywhere in a key. Any key
        // containing "token" is replaced wholesale with '[REDACTED]', so
        // `refreshTokensRevoked` would persist as a string sentinel instead of
        // the integer count — losing real forensic detail about how much access
        // the report actually tore down. It is a count, never a credential.
        refreshRevocationCount: refreshTokensRevoked,
      },
      result: 'success',
    });
  } catch (err) {
    console.error('[approvals] report-suspicious: audit write failed:', err);
    captureException(err);
  }

  // The report did NOT stop the action — a concurrent decide already carried
  // the intent to a terminal state (and, when that state is 'approved', the
  // durable release worker is going to run it). Revocation + audit above have
  // still happened; only the "did my report land?" answer differs.
  if (intentRaceLost) {
    return c.json({ error: 'already_decided', finalStatus: intentRaceLost.finalStatus }, 409);
  }

  return c.body(null, 204);
});


// The two M365 mutation tools (tier 3) that create an approval card. Read-only
// M365 tools are tier 1 and never reach this surface. Only these get a customer
// tenant lookup so a technician sees the blast radius at a glance.
const M365_MUTATION_TOOLS = new Set(['m365_reset_password', 'm365_disable_user']);

/**
 * Resolve the customer tenant display name for a set of approval rows whose
 * action is an M365 mutation. Walks executionId -> ai_tool_executions.sessionId
 * -> ai_sessions.delegantM365ConnectionId -> delegant_m365_connections, joined
 * in ONE query for ALL given execution ids (no per-row / N+1 lookups).
 *
 * Returns a Map keyed by executionId. Rows with no execution, a non-M365 tool,
 * or a session without a Delegant M365 connection are simply absent from the
 * map and serialize as customerTenant: null.
 */
async function lookupCustomerTenants(
  rows: (typeof approvalRequests.$inferSelect)[],
): Promise<Map<string, string>> {
  const executionIds = rows
    .filter((r) => r.executionId && M365_MUTATION_TOOLS.has(r.actionToolName))
    .map((r) => r.executionId as string);

  if (executionIds.length === 0) return new Map();

  const joined = await db
    .select({
      executionId: aiToolExecutions.id,
      customerDisplayName: delegantM365Connections.customerDisplayName,
    })
    .from(aiToolExecutions)
    .innerJoin(aiSessions, eq(aiSessions.id, aiToolExecutions.sessionId))
    .innerJoin(
      delegantM365Connections,
      eq(delegantM365Connections.id, aiSessions.delegantM365ConnectionId),
    )
    .where(inArray(aiToolExecutions.id, executionIds));

  const map = new Map<string, string>();
  for (const row of joined) {
    if (row.executionId && row.customerDisplayName) {
      map.set(row.executionId, row.customerDisplayName);
    }
  }
  return map;
}
