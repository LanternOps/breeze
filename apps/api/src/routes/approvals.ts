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
import { actionIntents, intentOutbox, type ActionIntent, type ActionIntentStatus } from '../db/schema/actionIntents';
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

approvalRoutes.get('/pending', async (c) => {
  const userId = c.get('auth').user.id;
  const rows = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.userId, userId),
        eq(approvalRequests.status, 'pending'),
        gt(approvalRequests.expiresAt, new Date()),
      )
    )
    .orderBy(desc(approvalRequests.createdAt));

  // Batched lookup: one query resolves the customer tenant for ALL M365
  // mutation rows in this list (no N+1).
  const tenants = await lookupCustomerTenants(rows);
  return c.json({
    approvals: rows.map((r) =>
      serialize(r, (r.executionId && tenants.get(r.executionId)) || null),
    ),
  });
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
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Bad request' }, 400);
  const [row] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.id, id), eq(approvalRequests.userId, userId)));

  if (!row) return c.json({ error: 'Not found' }, 404);
  const tenants = await lookupCustomerTenants([row]);
  const customerTenant = (row.executionId && tenants.get(row.executionId)) || null;
  return c.json({ approval: serialize(row, customerTenant) });
});

// Phase 2: issue a short-lived (120s) WebAuthn assertion challenge bound to
// {approvalId,userId} so the technician can satisfy a Windows-Hello / Touch-ID
// step-up before approving. allowCredentials is the caller's active platform
// approver devices; with none registered the options carry no allowCredentials
// and the console falls back to an L1 (session-tap) approval — P2 is opt-in.
approvalRoutes.post('/:id/assertion-challenge', async (c) => {
  const userId = c.get('auth').user.id;
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
// revokes the requesting OAuth client's grant + refresh tokens, and writes
// a security audit row. Behaves identically to /deny from the SDK's
// perspective — the linked ai_tool_executions row flips to 'rejected' so
// waitForApproval resolves with denial.
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
      try {
        const rejected = await runOutsideDbContext(() =>
          withSystemDbAccessContext(() =>
            db.transaction(async (tx) => {
              await tx
                .select({ id: actionIntents.id })
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
                .where(and(eq(approvalRequests.id, id), eq(approvalRequests.userId, userId)));

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
              if (cas.length === 0) return null;

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

              return cas[0] ?? null;
            }),
          ),
        );
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

  return c.body(null, 204);
});

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
  // ReauthRequiredError ceremony — UNLESS the partner's authenticator policy
  // is actively ENFORCING (fix round 1, finding 5 — adjudicated requirement).
  // An enforcing partner's step-up floor must not be silently bypassed just
  // because an intent classified as supervised: the requester can still
  // satisfy it with a WebAuthn L3 proof, exactly like the four_eyes
  // sole-operator self-approve does. The ladder's own self-approve step-up
  // gate below already keys off `requestedByUserId === userId` (never off
  // approvalScope), which is unconditionally true for a supervised row, so no
  // extra gate is needed there — routing an enforcing supervised approve
  // through the shared ladder is sufficient. Only checked for an approve
  // (deny is never blocked by assurance, so there's no reason to spend a
  // partner-policy read on it) — `resolveApprovalAssurance` is the same
  // synchronous "no proof presented" L1/session_tap default `proof===undefined`
  // resolves to today; reusing it (rather than hand-rolling the literal) keeps
  // the recorded factor byte-for-byte identical to that existing no-proof shape
  // and impossible to drift from `assertDecisionConsistent`'s invariants.
  const isPartnerEnforcingForSupervised =
    isSupervisedSelfDecide && status === 'approved'
      ? isEnforcing(await loadPartnerPolicy(c.get('auth').partnerId ?? null), new Date())
      : false;
  const skipAssuranceLadder = isSupervisedSelfDecide && !isPartnerEnforcingForSupervised;

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
    // unaffected — only an approve of one's own intent is gated. Never
    // reached for a supervised self-decide under a NON-enforcing policy
    // (handled by `skipAssuranceLadder` above, which always records L1 by
    // design — this gate would otherwise refuse every plain-click supervised
    // approve outright).
    if (
      linkedIntent &&
      status === 'approved' &&
      linkedIntent.requestedByUserId === userId
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
                // Fixed release lease (design §4.2), stamped only on an
                // approval win — a rejected intent never executes, so it has
                // no release window to bound.
                ...(status === 'approved'
                  ? { releaseBy: new Date(Date.now() + RELEASE_LEASE_MS) }
                  : {}),
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
    const soleOperatorApproval = status === 'approved' && linkedIntent.requestedByUserId === userId;
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
      },
    });
  }

  return c.json({ approval: serialize(updated) });
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
    isRecursive: r.isRecursive,
    createdAt: r.createdAt.toISOString(),
  };
}
