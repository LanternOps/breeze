import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq, gt, desc, inArray, isNull, ne } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { authMiddleware } from '../middleware/auth';
import { approvalRequests } from '../db/schema/approvals';
import { elevationRequests, elevationAudit } from '../db/schema/elevations';
import { aiToolExecutions, aiSessions } from '../db/schema/ai';
import { delegantM365Connections } from '../db/schema/delegant';
import { auditLogs } from '../db/schema/audit';
import { buildApprovalPush, getUserPushTokens, sendExpoPush } from '../services/expoPush';
import { revokeUserOauthClient } from './lifecycle';
import { assertApprovalAssurance, StepUpRequiredError, ReauthRequiredError } from '../services/authenticatorAssurance';
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
  let tokensFound = 0;
  let dispatched = 0;
  const errors: string[] = [];
  try {
    const tokens = await getUserPushTokens(userId);
    tokensFound = tokens.length;
    if (tokens.length > 0) {
      const tickets = await sendExpoPush(
        tokens.map((to) => ({
          to,
          ...buildApprovalPush({
            approvalId: row.id,
            actionLabel: row.actionLabel,
            requestingClientLabel: row.requestingClientLabel,
          }),
        }))
      );
      dispatched = tickets.filter((t) => t.status === 'ok').length;
      for (const t of tickets) {
        if (t.status === 'error') {
          errors.push(t.message ?? 'unknown');
        }
      }
    }
  } catch (err) {
    console.error('[approvals] dev/seed push dispatch failed:', err);
    errors.push(err instanceof Error ? err.message : String(err));
  }

  return c.json(
    {
      approval: serialize(row),
      push: { tokensFound, dispatched, errors },
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

  // Phase 2/3: verify an optional assertion proof. No proof → L1 session tap. A
  // presented-but-invalid proof throws → 401 (never silently L1). The L3 recency
  // clock is derived server-side from the consumed challenge (no param here);
  // `reauthVerified` is the only decide-surface factor, supplied by the approve
  // handler after a fresh password re-auth (required only for critical/L4).
  // Phase 4: an ENFORCING partner policy may reject an under-assured APPROVE
  // (StepUpRequiredError → 403). A deny is passed through with decision:'denied'
  // so it is never blocked.
  let assurance;
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

  const result = await db
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

  if (result.length === 0) {
    // Lost a concurrent decide/expiry race between the pre-fetch and the CAS.
    return c.json({ error: 'Already decided', finalStatus: 'expired' }, 409);
  }

  const [updated] = result;

  // If this approval row was created by the AI agent SDK (Breeze AI / chat),
  // it carries an `executionId` linking back to the ai_tool_executions row
  // that the SDK is blocked on via waitForApproval(). Flip that row's status
  // so the SDK's poll unblocks and the tool either executes or returns
  // "rejected or timed out". For non-AI sources (helper, dev seed) execution_id
  // is null and this is a no-op.
  if (updated?.executionId) {
    const aiStatus = status === 'approved' ? 'approved' : 'rejected';
    try {
      await db
        .update(aiToolExecutions)
        .set({ status: aiStatus, approvedBy: userId, approvedAt: new Date() })
        .where(eq(aiToolExecutions.id, updated.executionId));
    } catch (err) {
      console.error('[approvals] Failed to mirror status to ai_tool_executions:', err);
      // Non-fatal: the approval_request row is the source of truth for the
      // mobile UI. The SDK poll will time out at the 5-min ceiling if the
      // mirror fails — better than failing the user-facing decide call.
    }
  }

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

  return c.json({ approval: serialize(updated!) });
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
    isRecursive: r.isRecursive,
    createdAt: r.createdAt.toISOString(),
  };
}
