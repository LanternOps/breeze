import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../lib/validation';
import { and, eq, exists, gt, desc, inArray, isNull, ne, sql } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { authMiddleware } from '../middleware/auth';
import { approvalRequests } from '../db/schema/approvals';
import { elevationRequests, elevationAudit } from '../db/schema/elevations';
import { aiToolExecutions, aiSessions } from '../db/schema/ai';
import { delegantM365Connections } from '../db/schema/delegant';
import { auditLogs } from '../db/schema/audit';
import {
  actionIntents,
  intentOutbox,
  type ActionIntent,
  type ActionIntentApprovalScope,
  type ActionIntentStatus,
} from '../db/schema/actionIntents';
import { dispatchApprovalPush } from '../services/expoPush';
import { revokeUserOauthClient } from './lifecycle';
import {
  assertApprovalAssurance,
  resolveApprovalAssurance,
  StepUpRequiredError,
  ReauthRequiredError,
  type AssuranceDecision,
} from '../services/authenticatorAssurance';
import { recordActionIntentEvent } from '../services/actionIntents/metrics';
import { RELEASE_LEASE_MS } from '../services/actionIntents/intentService';
import { resolveIntentApprovers } from '../services/actionIntents/intentApprovers';
import { buildAuthContextForIntent } from '../services/actionIntents/actorContext';
import { checkToolPermission } from '../services/aiGuardrails';
import { loadPartnerPolicy, isEnforcing } from '../services/authenticatorPolicy';
import { getUserPermissions, userCanDecideApprovals, canAccessOrg } from '../services/permissions';
import { generateApprovalAssertionOptions } from '../services/approverWebAuthn';
import { issueMobileAssertionNonce } from '../services/mobileHwKey';
import { requireCurrentPasswordStepUp, requireFreshMfaStepUp } from './auth/helpers';
import { authenticatorDevices } from '../db/schema/authenticatorDevices';
import {
  assertionProofSchema,
  mobileHwKeyProofSchema,
  type RiskTier,
  type ApprovalProof,
} from '@breeze/shared';

// Phase 3: accept EITHER the back-compat WebAuthn proof (no `type` on the wire →
// defaulted by assertionProofSchema) OR the mobile_hw_key proof. z.union tries
// the strict mobile literal first, then falls back to the webauthn shape.
const approveProofSchema = z.union([mobileHwKeyProofSchema, assertionProofSchema]);

// #1254: how long a mobile-approved elevation grant stays valid. Matches the
// web respond path's DEFAULT_APPROVAL_DURATION_MINUTES in pam.ts (15) so an
// approve here is bounded identically — an unbounded grant would leave the
// elevation valid indefinitely.
const PAM_ELEVATION_GRANT_MINUTES = 15;

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

/** The only fields of a linked intent the live-authorization rule reads. */
type LiveAuthzIntent = Pick<
  ActionIntent,
  'status' | 'approvalScope' | 'orgId' | 'requestedByUserId'
>;

/** An approval row paired with its linked intent's scope (null when the row
 * has no intent). The scope is what lets a client tell a supervised row —
 * decided with a plain click — from a four_eyes one that may demand a
 * step-up, so it must not be dropped on the way out of the projection. */
interface AuthorizedApproval {
  approval: typeof approvalRequests.$inferSelect;
  approvalScope: ActionIntentApprovalScope | null;
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
): Promise<boolean> {
  if (!intent || intent.status !== 'pending_approval') return false;
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
): Promise<{ authorized: boolean; approvalScope: ActionIntentApprovalScope | null }> {
  if (!row.intentId) return { authorized: true, approvalScope: null };
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
  );
  return { authorized, approvalScope: intent?.approvalScope ?? null };
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
  const authorized: AuthorizedApproval[] = [];
  for (const { approval, intent } of rows) {
    if (!approval.intentId) {
      authorized.push({ approval, approvalScope: null });
      continue;
    }
    if (await isIntentRowLiveAuthorized(intent, userId, orgDecideAuthorizer)) {
      authorized.push({ approval, approvalScope: intent?.approvalScope ?? null });
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
  return c.json({
    approvals: page.map(({ approval, approvalScope }) =>
      serialize(
        approval,
        (approval.executionId && tenants.get(approval.executionId)) || null,
        approvalScope,
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
  return c.json({ approval: serialize(row, customerTenant, live.approvalScope) });
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

  return decideHandler(c, 'approved', undefined, proof, reauthVerified);
});

approvalRoutes.post('/:id/deny', zValidator('json', denySchema), async (c) => {
  const reason = c.req.valid('json').reason;
  return decideHandler(c, 'denied', reason);
});

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
  const orgId = c.get('auth').orgId ?? null;
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
              const [locked] = await tx
                .select({ id: actionIntents.id, status: actionIntents.status })
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
                return { rejected: null, finalIntentStatus: locked?.status ?? null };
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

              return { rejected: cas[0] ?? null, finalIntentStatus: null };
            }),
          ),
        );
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
      if (existing.executionId) {
        try {
          await db
            .update(aiToolExecutions)
            .set({ status: 'rejected', approvedBy: userId, approvedAt: new Date() })
            .where(eq(aiToolExecutions.id, existing.executionId));
        } catch (err) {
          console.error('[approvals] report-suspicious: failed to mirror to ai_tool_executions:', err);
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
      // Non-fatal: the approval row + audit log are still authoritative; the
      // user can revoke from the connected-apps UI as a fallback.
    }
  }

  // Audit row — security.suspicious_report, scoped to the user.
  try {
    await db.insert(auditLogs).values({
      orgId,
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
        refreshTokensRevoked,
      },
      result: 'success',
    });
  } catch (err) {
    console.error('[approvals] report-suspicious: audit insert failed:', err);
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

/**
 * The `release_by` patch for an intent decision (design §4.2), in ONE place so
 * the rule can't drift between call sites.
 *
 * EVERY transition to `approved` gets a fresh, fixed `RELEASE_LEASE_MS` lease —
 * unconditionally, never "only when it isn't already set". The downstream
 * readers (jobs/intentExpiryReaper.ts, jobs/intentReleaseWorker.ts,
 * services/actionIntents/intentService.ts) all evaluate
 * `COALESCE(release_by, expires_at)`; that fallback is the ROLLING-UPGRADE
 * mechanism for rows approved by an older instance that never stamped the
 * column, and must stay — but a row approved by THIS code path should never
 * be relying on it, because `expires_at` is the approval deadline, not an
 * execution lease, and is typically already in the past by then.
 *
 * A rejected intent never executes, so it has no release window to bound.
 */
function stampReleaseLease(intentTargetStatus: ActionIntentStatus): { releaseBy?: Date } {
  if (intentTargetStatus !== 'approved') return {};
  return { releaseBy: new Date(Date.now() + RELEASE_LEASE_MS) };
}

async function decideHandler(
  c: import('hono').Context,
  status: 'approved' | 'denied',
  reason?: string,
  proof?: ApprovalProof,
  reauthVerified = false
) {
  const userId = c.get('auth').user.id;
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Bad request' }, 400);

  // Pre-fetch so we can resolve the required assurance from the row's risk tier
  // before deciding (see the assertApprovalAssurance call below for the full
  // verify + enforcement behavior).
  const [existing] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.id, id), eq(approvalRequests.userId, userId)));

  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (existing.status !== 'pending') {
    return c.json(
      { error: `Already ${existing.status}`, finalStatus: existing.status },
      409
    );
  }
  if (existing.expiresAt <= new Date()) {
    return c.json({ error: 'Expired', finalStatus: 'expired' }, 410);
  }

  // Action intents (spec docs/superpowers/specs/ai-mcp/2026-07-18-action-intents-approval-layer-design.md
  // §4, §3.4): load the linked intent early so the digest-binding and
  // sole-operator checks below can run BEFORE the approval CAS. System
  // context, mirroring the elevation mirror's cross-row visibility need —
  // action_intents is org-scoped (Shape 1) and we want this read to succeed
  // regardless of the ambient request scope.
  let linkedIntent: ActionIntent | null = null;
  // Set true only for a supervised intent's requester-owned decide (Task 6).
  // Read below to skip the whole assertion/assurance ladder — supervised
  // decides no WebAuthn/step-up ceremony, only the live-RBAC re-check above.
  let isSupervisedSelfDecide = false;
  if (existing.intentId) {
    linkedIntent = await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        const [row] = await db
          .select()
          .from(actionIntents)
          .where(eq(actionIntents.id, existing.intentId as string));
        return row ?? null;
      }),
    );

    if (!linkedIntent) {
      // Should be unreachable (ON DELETE CASCADE removes this approval row
      // along with its intent), but fail closed rather than proceed blind.
      return c.json({ error: 'intent_not_found' }, 404);
    }

    // Digest binding (defense-in-depth, spec §3.3): refuse the decision if
    // the intent's content changed since this row was fanned out.
    if (
      existing.boundArgumentDigest &&
      existing.boundArgumentDigest !== linkedIntent.argumentDigest
    ) {
      // Tamper-detection tripwire: content changed after fan-out. Audit
      // this refusal — the release worker audits the same condition
      // (jobs/intentReleaseWorker.ts's `digest_mismatch` errorCode), and
      // this decide-time refusal is equally security-relevant. Ids/digests
      // only, never raw arguments (spec §3.2/§7).
      recordActionIntentEvent({
        orgId: linkedIntent.orgId,
        intentId: linkedIntent.id,
        actionName: linkedIntent.actionName,
        argumentDigest: linkedIntent.argumentDigest,
        source: linkedIntent.source,
        outcome: 'digest_mismatch',
        actorId: userId,
        details: {
          approvalId: existing.id,
          boundArgumentDigest: existing.boundArgumentDigest,
        },
      });
      return c.json({ error: 'digest_mismatch' }, 409);
    }

    // Tier-3 supervised/four_eyes split (spec
    // docs/superpowers/specs/ai-mcp/2026-08-05-tier3-supervised-four-eyes-split-design.md
    // §4.2). Supervised intents fan out exactly ONE approval row, always owned
    // by the requester (services/actionIntents/intentService.ts) — no other
    // approvals:decide holder is ever eligible, and none of the four_eyes
    // machinery below (live approvals:decide re-check, sole-operator
    // re-derivation, the WebAuthn/step-up ladder) applies to it. Branching
    // here, BEFORE any of that runs, is what lets a supervised requester who
    // holds no approvals:decide permission at all still decide their own row.
    if (linkedIntent.approvalScope === 'supervised') {
      isSupervisedSelfDecide = true;

      // Identity gate: even if a non-requester somehow reached this row (a
      // future bug, manual DB tampering, or an admin-decide-any-row surface
      // added later), a supervised row's whole trust model rests on "the
      // requester is deciding their own action" — holding approvals:decide
      // must NEVER substitute for that identity check, since supervised
      // decides skip the assertion ladder entirely below. Unconditional
      // (both approve and deny): nobody but the requester is ever a
      // legitimate decider for this row.
      if (linkedIntent.requestedByUserId !== userId) {
        recordActionIntentEvent({
          orgId: linkedIntent.orgId,
          intentId: linkedIntent.id,
          actionName: linkedIntent.actionName,
          argumentDigest: linkedIntent.argumentDigest,
          source: linkedIntent.source,
          outcome: 'approver_unauthorized',
          actorId: userId,
          details: { approvalId: existing.id, errorCode: 'not_requester' },
        });
        return c.json({ error: 'not_requester' }, 403);
      }

      // Live RBAC re-check for the underlying TOOL action (spec §4.2) — NOT
      // approvals:decide, which supervised intents never require. Mirrors the
      // release worker's revalidation (services/actionIntents/revalidateRelease.ts)
      // so the decide-time and release-time gates can never diverge: same
      // `buildAuthContextForIntent` + `checkToolPermission(actionName,
      // arguments, auth)` pair. Gated to `approved` only — a deny only cancels
      // the action and must stay available even to a requester who lost the
      // underlying permission. System-scoped: buildAuthContextForIntent reads
      // the requester's role from organization_users/partner_users, which the
      // caller's own ambient request context may not make visible (partner
      // approvers have no organization_users row) — and a bare (non-exited)
      // withSystemDbAccessContext call from inside the ambient request context
      // is a no-op passthrough (db/index.ts), so this must go through
      // runOutsideDbContext to actually elevate.
      if (status === 'approved') {
        const revalidation = await runOutsideDbContext(() =>
          withSystemDbAccessContext(async () => {
            const auth = await buildAuthContextForIntent(linkedIntent!);
            if (!auth) return { ok: false as const, errorCode: 'actor_invalid' };
            const denial = await checkToolPermission(
              linkedIntent!.actionName,
              linkedIntent!.arguments,
              auth,
            );
            if (denial) return { ok: false as const, errorCode: 'rbac_denied', reason: denial };
            return { ok: true as const };
          }),
        );
        if (!revalidation.ok) {
          recordActionIntentEvent({
            orgId: linkedIntent.orgId,
            intentId: linkedIntent.id,
            actionName: linkedIntent.actionName,
            argumentDigest: linkedIntent.argumentDigest,
            source: linkedIntent.source,
            outcome: 'approver_unauthorized',
            actorId: userId,
            details: { approvalId: existing.id, errorCode: revalidation.errorCode },
          });
          return c.json({ error: 'forbidden' }, 403);
        }
      }
    } else {
      // four_eyes (unchanged): re-check the DECIDER's live authorization before
      // an intent-backed APPROVE (spec §4). The fanned-out approval_requests row
      // (Shape-6, user-id-scoped) is otherwise a durable bearer capability: it
      // was created for a user who held approvals:decide over the intent's org
      // at fan-out time (services/actionIntents/intentApprovers.ts), but nothing
      // re-checks that they STILL hold it. An Org Admin demoted to a role
      // without approvals:decide (while keeping org membership, so the row
      // stays visible) could otherwise still approve and drive a release.
      // Resolve current perms for the intent's org and fail closed. Gated to
      // `approved` only: a deny is harmless (it cancels the action) and must
      // stay available even to a demoted approver. Checked BEFORE the
      // assurance proof below so a stale approver never even consumes a
      // WebAuthn challenge. Uses system context so the org membership/role
      // reads resolve regardless of ambient request scope (partner approvers
      // have no organization_users row).
      if (status === 'approved') {
        const deciderPerms = await runOutsideDbContext(() =>
          withSystemDbAccessContext(() =>
            getUserPermissions(userId, {
              partnerId: c.get('auth').partnerId ?? undefined,
              orgId: linkedIntent!.orgId,
            }),
          ),
        );
        if (
          !deciderPerms ||
          !canAccessOrg(deciderPerms, linkedIntent.orgId) ||
          !userCanDecideApprovals(deciderPerms)
        ) {
          recordActionIntentEvent({
            orgId: linkedIntent.orgId,
            intentId: linkedIntent.id,
            actionName: linkedIntent.actionName,
            argumentDigest: linkedIntent.argumentDigest,
            source: linkedIntent.source,
            outcome: 'approver_unauthorized',
            actorId: userId,
            details: { approvalId: existing.id },
          });
          return c.json({ error: 'forbidden' }, 403);
        }

        // Sole-operator RE-DERIVATION (#2685). Four-eyes for a Tier-3 intent is
        // otherwise decided exactly once, at fan-out
        // (services/actionIntents/intentService.ts), by branch mutual exclusion:
        // the multi-approver branch fans rows out to OTHER users, and only the
        // sole-operator branch ever creates a requester-owned row. Nothing
        // downstream re-establishes that — this handler used to infer "you were
        // the only eligible approver" purely from "a row exists that you own".
        // Since release is first-wins CAS, any future fan-out regression that
        // leaked a requester-owned row into a multi-approver intent would let the
        // requester unilaterally release it with no server-side check catching
        // it. So re-derive the eligible set here and require the self-approver to
        // STILL be the only eligible approver for the intent's org.
        //
        // This is deliberately a re-derivation, not a persisted `sole_operator`
        // flag (issue #2685 option 2 over option 1): it fails closed, and "you
        // are no longer the only approver, so you no longer get to self-approve"
        // is what the four-eyes model implies. An intent created while solo and
        // decided after the org gained a second approver is REFUSED — intended.
        // A persisted flag would still let that self-approve through.
        //
        // Only runs on a self-approve (requester === decider), so the common
        // cross-user approve pays nothing. `resolveIntentApprovers` opens its own
        // system context internally (partner_users is Shape-3 partner-axis RLS,
        // invisible from an org-scoped request context), so it must be called
        // with runOutsideDbContext — a nested withDbAccessContext RETAINS the
        // ambient context rather than elevating (db/index.ts) — and calling it
        // outside any context also avoids holding a pooled connection across the
        // round-trip (the #1105 connection-hold class).
        //
        // Ordered with the stale-approver check ABOVE the assurance proof for the
        // same reason that one is: a refused decision must never consume a
        // WebAuthn challenge. Gated to `approved` only — a deny stays available
        // in every case, since denying only cancels the action.
        if (linkedIntent.requestedByUserId === userId) {
          const eligibleNow = await runOutsideDbContext(() =>
            resolveIntentApprovers(linkedIntent!.orgId),
          );
          const othersEligible = eligibleNow.filter((candidate) => candidate !== userId);
          // "ONLY eligible approver" is both halves: nobody else is eligible AND
          // the self-approver still is. The second half is belt-and-braces over
          // the live-authorization re-check above (which asks the permissions
          // service rather than this resolver) — if the two ever disagree, refuse.
          if (othersEligible.length > 0 || !eligibleNow.includes(userId)) {
            recordActionIntentEvent({
              orgId: linkedIntent.orgId,
              intentId: linkedIntent.id,
              actionName: linkedIntent.actionName,
              argumentDigest: linkedIntent.argumentDigest,
              source: linkedIntent.source,
              outcome: 'approver_unauthorized',
              actorId: userId,
              details: {
                approvalId: existing.id,
                errorCode: 'not_sole_approver',
                // Count only — never the approver ids (spec §7: ids of the
                // event's own subjects, not a roster of other users).
                eligibleApproverCount: eligibleNow.length,
              },
            });
            return c.json({ error: 'not_sole_approver' }, 403);
          }
        }
      }
    }
  }

  // Phase 2/3: verify an optional assertion proof. No proof → L1 session tap. A
  // presented-but-invalid proof throws → 401 (never silently L1). The L3 recency
  // clock is derived server-side from the consumed challenge (no param here);
  // `reauthVerified` is the only decide-surface factor, supplied by the approve
  // handler after a fresh password re-auth (required only for critical/L4).
  // Phase 4: an ENFORCING partner policy may reject an under-assured APPROVE
  // (StepUpRequiredError → 403). A deny is passed through with decision:'denied'
  // so it is never blocked.
  //
  // Supervised self-decide (Task 6): skip the WHOLE assertion/assurance ladder
  // — no WebAuthn challenge, no partner-policy step-up floor, no
  // ReauthRequiredError ceremony — but ONLY when both of the following hold.
  //
  //  1. The partner's authenticator policy is not actively ENFORCING (fix
  //     round 1, finding 5 — adjudicated requirement). An enforcing partner's
  //     step-up floor must not be silently bypassed just because an intent
  //     classified as supervised: the requester can still satisfy it with a
  //     WebAuthn L3 proof, exactly like the four_eyes sole-operator
  //     self-approve does.
  //  2. NO proof was presented (fix round 2, finding 1). `skipAssuranceLadder`
  //     used to ignore `proof` entirely, so a mobile approver device that
  //     signed the decision in its Secure Enclave had that signature silently
  //     DISCARDED: never verified, anti-clone signature counter never bumped,
  //     challenge left unconsumed, and the audit row recorded L1 /
  //     'session_tap' / device_id NULL. Worse, a FORGED or REPLAYED proof was
  //     ignored rather than rejected, so the approve succeeded at L1 instead
  //     of 401ing — contradicting this handler's own "a presented-but-invalid
  //     proof throws → 401 (never silently L1)" invariant and the mobile
  //     client's contract. An optional proof therefore always goes through the
  //     real ladder; the sole-operator gate below is what keeps it from
  //     turning into a NEW blocking requirement.
  //
  // Only checked for an approve (deny is never blocked by assurance, so
  // there's no reason to spend a partner-policy read on it) —
  // `resolveApprovalAssurance` is the same synchronous "no proof presented"
  // L1/session_tap default `proof===undefined` resolves to today; reusing it
  // (rather than hand-rolling the literal) keeps the recorded factor
  // byte-for-byte identical to that existing no-proof shape and impossible to
  // drift from `assertDecisionConsistent`'s invariants.
  const isPartnerEnforcingForSupervised =
    isSupervisedSelfDecide && status === 'approved'
      ? isEnforcing(await loadPartnerPolicy(c.get('auth').partnerId ?? null), new Date())
      : false;
  const skipAssuranceLadder =
    isSupervisedSelfDecide && !isPartnerEnforcingForSupervised && proof === undefined;

  let assurance: AssuranceDecision;
  if (skipAssuranceLadder) {
    assurance = resolveApprovalAssurance(existing.riskTier as RiskTier);
  } else {
    try {
      assurance = await assertApprovalAssurance({
        approvalId: id,
        userId,
        riskTier: existing.riskTier as RiskTier,
        proof,
        partnerId: c.get('auth').partnerId ?? null,
        decision: status,
        reauthVerified,
      });
    } catch (err) {
      if (err instanceof StepUpRequiredError) {
        return c.json({ error: 'step_up_required', requiredLevel: err.requiredLevel }, 403);
      }
      if (err instanceof ReauthRequiredError) {
        // Critical (L4) approve with a valid signature but no fresh re-auth — tell
        // the client to re-collect the password and retry, not a generic failure.
        return c.json({ error: 'reauth_required' }, 401);
      }
      console.error('[approvals] assertion verification failed:', err);
      return c.json({ error: 'assertion_failed' }, 401);
    }

    // Sole-operator step-up (spec §1 / §4): a requester approving their OWN
    // intent (the four_eyes sole-operator single-row fan-out case, OR a
    // supervised row under an enforcing partner policy) must present >= L3
    // assurance (webauthn_platform or mobile_hw_key). Checked BEFORE the CAS
    // so an under-assured self-approval never flips the row. Deny is
    // unaffected — only an approve of one's own intent is gated.
    //
    // `requestedByUserId === userId` is UNCONDITIONALLY true for a supervised
    // row (its sole approval row is always the requester's), so the gate must
    // additionally exclude the non-enforcing supervised case — otherwise
    // routing an OPTIONAL proof through the ladder (fix round 2, finding 1)
    // would turn a proof that only reaches L2 (say, a stale challenge) into a
    // 403 on a decide that a plain click passes. Under a non-enforcing partner
    // policy an optional proof on a supervised decide can therefore only ever
    // RAISE the recorded assurance, never block it. Under an ENFORCING policy
    // the gate applies exactly as before, and four_eyes is untouched.
    if (
      linkedIntent &&
      status === 'approved' &&
      linkedIntent.requestedByUserId === userId &&
      (!isSupervisedSelfDecide || isPartnerEnforcingForSupervised)
    ) {
      const level = assurance.decidedAssuranceLevel ?? 0;
      if (level < 3) {
        return c.json({ error: 'step_up_required', requiredLevel: 3 }, 403);
      }
    }
  }

  // Task 6: the ENTIRE decision write — approval-row CAS, the ai_tool_executions
  // mirror, and the action-intents fan-in (intent CAS + release_by stamp +
  // sibling expiry + intent_approved outbox insert) — commits as ONE
  // transaction. Before this, the intent fan-in ran in its own,
  // independently-committing transaction: a fault there left the approval row
  // decided with NO intent/outbox follow-through (or vice versa on other
  // fault points), a state no retry could repair. Now any throw here rolls
  // EVERYTHING back and the caller gets a retryable 500 instead of a
  // half-applied decision.
  //
  // System-scoped (runOutsideDbContext + withSystemDbAccessContext, exactly
  // like the fan-in already was): the sibling approval_requests rows belong to
  // OTHER approvers and are invisible under the caller's own Shape-6
  // user-id-scoped ambient context, and action_intents/ai_tool_executions need
  // org-scoped visibility the caller's ambient scope doesn't guarantee either.
  // System scope is safe here because authorization was already fully decided
  // by the checks above — this is purely a write, not a fresh access decision.
  // Push dispatch and any other network I/O stay OUTSIDE this transaction
  // (#1105 — never hold a txn across network I/O); there is none in this path.
  type DecideWriteResult =
    | { lostRace: true }
    | { lostRace: false; updated: typeof approvalRequests.$inferSelect; wonIntent: boolean };

  let writeResult: DecideWriteResult;
  try {
    writeResult = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db.transaction(async (tx): Promise<DecideWriteResult> => {
          // Fix round 1, finding 2 (lock-order inversion): report-suspicious
          // and intentExpiryReaper both lock action_intents BEFORE touching
          // approval_requests. This transaction used to lock its OWN
          // approval_requests row first and the intent second — the opposite
          // order — so a concurrent report-suspicious/reaper transaction
          // (intent held, waiting on a sibling approval_requests row this
          // transaction already holds) and this transaction (approval_requests
          // row held, waiting on the intent report-suspicious/reaper already
          // holds) could deadlock (Postgres 40P01 → a user-visible 500).
          // Taking the SAME intent-first lock here makes every writer agree on
          // one global order, so concurrent transactions serialize instead of
          // cycling. `existing.intentId` is read from the pre-fetch outside
          // this transaction, before any lock is held.
          if (existing.intentId) {
            await tx
              .select({ id: actionIntents.id })
              .from(actionIntents)
              .where(eq(actionIntents.id, existing.intentId))
              .for('update');
          }

          const casRows = await tx
            .update(approvalRequests)
            .set({
              status,
              decidedAt: new Date(),
              decisionReason: reason ?? null,
              decidedAssuranceLevel: assurance.decidedAssuranceLevel,
              decidedVia: assurance.decidedVia,
              authenticatorDeviceId: assurance.authenticatorDeviceId,
            })
            .where(
              and(
                eq(approvalRequests.id, id),
                eq(approvalRequests.userId, userId),
                eq(approvalRequests.status, 'pending'),
                gt(approvalRequests.expiresAt, new Date()),
              )
            )
            .returning();

          if (casRows.length === 0) {
            // Lost a concurrent decide/expiry race between the pre-fetch and
            // the CAS. Not a failure — the transaction still commits (nothing
            // was written), and the caller gets a plain 409 below.
            return { lostRace: true };
          }
          const updated = casRows[0]!;

          // If this approval row was created by the AI agent SDK (Breeze AI /
          // chat), it carries an `executionId` linking back to the
          // ai_tool_executions row that the SDK is blocked on via
          // waitForApproval(). Flip that row's status so the SDK's poll
          // unblocks and the tool either executes or returns "rejected or
          // timed out". For non-AI sources (helper, dev seed) execution_id is
          // null and this is a no-op.
          if (updated.executionId) {
            const aiStatus = status === 'approved' ? 'approved' : 'rejected';
            const mirrored = await tx
              .update(aiToolExecutions)
              .set({ status: aiStatus, approvedBy: userId, approvedAt: new Date() })
              // Guarded on 'pending' (#3089): a settled approval wait marks the
              // execution row 'rejected' without touching this approval_requests
              // row first in every failure mode, so a decide that squeaked past
              // the approval_requests CAS must not resurrect a closed execution
              // row as a stranded 'approved' that the legacy bridge (no durable
              // worker) would never run.
              //
              // Fix round 1, finding 3 (tenant/linkage guard): this UPDATE runs
              // under system scope (no RLS), and `ai_tool_executions` has no
              // org_id column of its own — it's scoped via its `ai_sessions`
              // row. Matching on `updated.executionId` alone relies entirely on
              // that FK having been populated correctly at insert time (an
              // app-layer guarantee, not a DB-enforced one), which the repo's
              // tenancy contract treats as insufficient for a system-scoped
              // write. This executionId-linked flow (services/aiAgentSdk.ts's
              // mobile waitForApproval path) is ALWAYS a self-approval — the
              // approval_requests row's own userId (== `userId` here, already
              // proven equal by the CAS's WHERE clause above) must own the
              // session the execution belongs to. Carrying that check inside
              // the UPDATE's WHERE (not as a separate app-layer assertion)
              // means a wrong/stale executionId fails closed (0 rows) instead
              // of silently mutating another tenant's execution row.
              .where(and(
                eq(aiToolExecutions.id, updated.executionId),
                eq(aiToolExecutions.status, 'pending'),
                exists(
                  tx
                    .select({ one: sql`1` })
                    .from(aiSessions)
                    .where(and(
                      eq(aiSessions.id, aiToolExecutions.sessionId),
                      eq(aiSessions.userId, userId),
                    )),
                ),
              ))
              .returning({ id: aiToolExecutions.id });
            if (mirrored.length === 0) {
              // Lost the race, not a query failure: the execution row was
              // already closed out (settled/timed out) between the
              // approval_requests CAS above and this mirror — same
              // first-wins posture as the elevation and intent mirrors below.
              // approval_requests is still the source of truth for the
              // mobile UI and correctly records this approver's decision,
              // but the underlying tool call is already gone and will NOT
              // run despite the 'approved' response below — worth a distinct
              // log line so this isn't mistaken for the mirror failing.
              console.warn('[approvals] ai_tool_executions mirror lost the race (execution already settled):', updated.executionId);
            }
          }

          // Action intents (spec §4 / §3.4): mirror the decision onto the
          // linked action_intents row. First-wins inline CAS — a lost race
          // (another approver, the reaper, or a retry already decided the
          // intent) is a clean no-op: this row's own decision still commits
          // (with the rest of this transaction), so the user's decide call
          // still succeeds either way.
          let wonIntent = false;
          if (updated.intentId && linkedIntent) {
            const intentId = updated.intentId;
            const intentTargetStatus: ActionIntentStatus = status === 'approved' ? 'approved' : 'rejected';

            const intentCas = await tx
              .update(actionIntents)
              .set({
                status: intentTargetStatus,
                decidedAt: new Date(),
                decidedByUserId: userId,
                decidedAssuranceLevel: assurance.decidedAssuranceLevel,
                decidedVia: assurance.decidedVia,
                ...stampReleaseLease(intentTargetStatus),
              })
              .where(
                and(
                  eq(actionIntents.id, intentId),
                  eq(actionIntents.status, 'pending_approval'),
                ),
              )
              .returning({ id: actionIntents.id });

            if (intentCas.length > 0) {
              wonIntent = true;

              // MUST run in the same system-scoped transaction: approval_requests
              // is Shape-6 (user-id-scoped), so the sibling rows belong to OTHER
              // approvers and are invisible to this approver's own ambient
              // context — a context-scoped UPDATE would silently match zero rows.
              await tx
                .update(approvalRequests)
                .set({ status: 'expired', decidedAt: new Date() })
                .where(
                  and(
                    eq(approvalRequests.intentId, intentId),
                    eq(approvalRequests.status, 'pending'),
                    ne(approvalRequests.id, updated.id),
                  ),
                );

              if (status === 'approved') {
                await tx.insert(intentOutbox).values({
                  intentId,
                  eventType: 'intent_approved',
                  // Ids only, no argument content (spec §3.2).
                  payload: { intentId, orgId: linkedIntent.orgId },
                });
              }
            }
          }

          return { lostRace: false, updated, wonIntent };
        }),
      ),
    );
  } catch (err) {
    console.error('[approvals] decide transaction failed (rolled back):', err);
    return c.json({ error: 'decide_failed', retryable: true }, 500);
  }

  if (writeResult.lostRace) {
    return c.json({ error: 'Already decided', finalStatus: 'expired' }, 409);
  }

  const { updated, wonIntent } = writeResult;

  // #1254: PAM mobile bridge. If this approval was fanned out from a pending
  // uac_intercept elevation, mirror the decision back onto the elevation and
  // expire the sibling approval rows. First-wins: the CAS only fires while the
  // elevation is still 'pending', so a second approver (or the web respond
  // path) that already decided it is a clean no-op. No actuate command is
  // enqueued on approve — parity with pam.ts respond, deferred to #1150.
  // Best-effort (same posture as the executionId mirror): the approval_requests
  // row is the source of truth for the mobile UI, so a mirror failure must not
  // fail the user's decide call.
  if (updated?.elevationRequestId) {
    const elevationId = updated.elevationRequestId;
    let wonElevation = false;
    try {
      await db.transaction(async (tx) => {
        const now = new Date();
        const elevationUpdate = await tx
          .update(elevationRequests)
          .set(
            status === 'approved'
              ? {
                  status: 'approved',
                  approvedByUserId: userId,
                  approvedAt: now,
                  expiresAt: new Date(now.getTime() + PAM_ELEVATION_GRANT_MINUTES * 60_000),
                  updatedAt: now,
                  decidedAssuranceLevel: assurance.decidedAssuranceLevel,
                  decidedVia: assurance.decidedVia,
                  authenticatorDeviceId: assurance.authenticatorDeviceId,
                }
              : {
                  status: 'denied',
                  deniedByUserId: userId,
                  denialReason: reason ?? null,
                  updatedAt: now,
                  decidedAssuranceLevel: assurance.decidedAssuranceLevel,
                  decidedVia: assurance.decidedVia,
                  authenticatorDeviceId: assurance.authenticatorDeviceId,
                },
          )
          .where(
            and(
              eq(elevationRequests.id, elevationId),
              eq(elevationRequests.status, 'pending'),
            ),
          )
          .returning({ id: elevationRequests.id, orgId: elevationRequests.orgId });

        // Lost the race (already decided/expired by a sibling or the web path):
        // leave everything as-is. Our approval_requests row is still decided.
        if (elevationUpdate.length === 0) return;
        wonElevation = true;
        const elevation = elevationUpdate[0]!;

        await tx.insert(elevationAudit).values({
          orgId: elevation.orgId,
          elevationRequestId: elevationId,
          eventType: status === 'approved' ? 'approved' : 'denied',
          actor: 'technician',
          actorUserId: userId,
          details: {
            source: 'mobile_approval',
            approval_request_id: updated.id,
            ...(status === 'denied' && reason ? { reason } : {}),
          },
          occurredAt: now,
        });
      });
    } catch (err) {
      console.error('[approvals] Failed to mirror decision to elevation_requests:', err);
      // Non-fatal: the approval_request row is the source of truth for the
      // mobile decision; the elevation mirror can be reconciled out of band.
    }

    // Expire the sibling approval rows so they vanish from other approvers'
    // queues — first-wins fan-in. MUST run in system scope: approval_requests is
    // Shape-6 (user-id-scoped), so the sibling rows belong to OTHER approvers and
    // are invisible to this approver's request context — a bare context-scoped
    // UPDATE would silently match zero rows. Best-effort, post-commit, and only
    // when this decide won the elevation CAS (the winner owns the fan-in cleanup).
    if (wonElevation) {
      try {
        await runOutsideDbContext(() =>
          withSystemDbAccessContext(async () => {
            await db
              .update(approvalRequests)
              .set({ status: 'expired' })
              .where(
                and(
                  eq(approvalRequests.elevationRequestId, elevationId),
                  ne(approvalRequests.id, updated.id),
                  eq(approvalRequests.status, 'pending'),
                ),
              );
          }),
        );
      } catch (err) {
        console.error('[approvals] Failed to expire sibling approvals:', err);
      }
    }
  }

  // Action intents (spec §4 / §3.4): post-commit audit/metrics projection for
  // the intent fan-in that already committed (or rolled back) as part of the
  // ONE decide transaction above. `wonIntent` reflects whether THIS decide's
  // CAS actually transitioned the intent (a lost race — another approver, the
  // reaper, or a retry already decided it — is a clean no-op: no event here,
  // but this row's own decision still committed above either way).
  if (wonIntent && updated.intentId && linkedIntent) {
    // Gated on four_eyes: a supervised intent's sole approval row is ALWAYS
    // owned by the requester (the supervised short-circuit above, enforced
    // by the identity gate at the top of this handler), so "requester ===
    // decider" is true for EVERY supervised approve, not just the four_eyes
    // "only eligible approver happened to be the requester" case. Letting
    // that through here would mean `self_approved_sole_operator` — and the
    // audit signal built on it — fires on ordinary supervised approves,
    // burying the four_eyes L3 self-approval signal it exists to isolate.
    const isSelfApprove = status === 'approved' && linkedIntent.requestedByUserId === userId;
    const soleOperatorApproval = isSelfApprove && linkedIntent.approvalScope === 'four_eyes';
    const supervisedSelfApproval = isSelfApprove && linkedIntent.approvalScope === 'supervised';
    recordActionIntentEvent({
      orgId: linkedIntent.orgId,
      intentId: updated.intentId,
      actionName: linkedIntent.actionName,
      argumentDigest: linkedIntent.argumentDigest,
      source: linkedIntent.source,
      outcome: soleOperatorApproval
        ? 'self_approved_sole_operator'
        : status === 'approved'
          ? 'approved'
          : 'rejected',
      actorId: userId,
      details: {
        approvalRequestId: updated.id,
        decidedAssuranceLevel: assurance.decidedAssuranceLevel,
        decidedVia: assurance.decidedVia,
        ...(supervisedSelfApproval ? { approvalMethod: 'supervised_self' as const } : {}),
      },
    });
  }

  return c.json({ approval: serialize(updated, null, linkedIntent?.approvalScope ?? null) });
}

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

function serialize(
  r: typeof approvalRequests.$inferSelect,
  customerTenant: string | null = null,
  /**
   * The linked intent's approval scope, or null when the row has no intent.
   * Additive (task-8 review finding): without it a client cannot tell a
   * `supervised` row — decided with a plain click — from a `four_eyes` one
   * that may demand a WebAuthn/mobile step-up, so it can't shape the decide
   * affordance ahead of the request.
   */
  approvalScope: ActionIntentApprovalScope | null = null,
) {
  return {
    id: r.id,
    requestingClientLabel: r.requestingClientLabel,
    requestingMachineLabel: r.requestingMachineLabel ?? null,
    actionLabel: r.actionLabel,
    actionToolName: r.actionToolName,
    actionArguments: r.actionArguments,
    riskTier: r.riskTier,
    riskSummary: r.riskSummary,
    customerTenant,
    status: r.status,
    expiresAt: r.expiresAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionReason: r.decisionReason ?? null,
    executionId: r.executionId ?? null,
    intentId: r.intentId ?? null,
    approvalScope,
    isRecursive: r.isRecursive,
    createdAt: r.createdAt.toISOString(),
  };
}
