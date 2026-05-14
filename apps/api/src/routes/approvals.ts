import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq, gt, desc } from 'drizzle-orm';

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { mobileDeviceBlockedMiddleware } from '../middleware/mobileDeviceBlocked';
import { approvalRequests } from '../db/schema/approvals';
import { aiToolExecutions } from '../db/schema/ai';
import { auditLogs } from '../db/schema/audit';
import { buildApprovalPush, getUserPushTokens, sendExpoPush } from '../services/expoPush';
import { revokeUserOauthClient } from '../services/oauthRevocation';
import { captureException } from '../services/sentry';

export const approvalRoutes = new Hono();

approvalRoutes.use('*', authMiddleware);
approvalRoutes.use('*', mobileDeviceBlockedMiddleware);

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

  return c.json({ approvals: rows.map(serialize) });
});

const denySchema = z.object({
  reason: z.string().max(500).optional(),
});

const seedSchema = z.object({
  actionLabel: z.string().min(1).max(500),
  actionToolName: z.string().min(1).max(255),
  actionArguments: z.record(z.unknown()).optional(),
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
  return c.json({ approval: serialize(row) });
});

approvalRoutes.post('/:id/approve', async (c) => {
  return decideHandler(c, 'approved');
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
        captureException(err);
        console.error('[approvals] report-suspicious: failed to mirror to ai_tool_executions:', err);
      }
    }
  }

  // Revoke the requesting OAuth client (grant + refresh tokens) for this
  // user via the shared revokeUserOauthClient helper — same code path the
  // self-revoke and admin-block routes use. Soft-revokes via
  // oauth_grants.revoked_at + jti/grant Redis cache writes.
  const requestingClientId = existing.requestingClientId;
  let grantsRevoked = 0;
  let refreshTokensRevoked = 0;
  let cacheFailures = 0;
  let revocationFailed = false;
  if (requestingClientId) {
    try {
      const r = await revokeUserOauthClient(
        userId,
        requestingClientId,
        userId,
        'reported as suspicious by user',
      );
      grantsRevoked = r.grantsRevoked;
      refreshTokensRevoked = r.refreshTokensRevoked;
      cacheFailures = r.cacheFailures;
    } catch (err) {
      revocationFailed = true;
      captureException(err);
      console.error('[approvals] report-suspicious: revocation failed:', err);
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
        cacheFailures,
        revocationFailed,
      },
      result: revocationFailed ? 'failure' : 'success',
    });
  } catch (err) {
    captureException(err);
    console.error('[approvals] report-suspicious: audit insert failed:', err);
  }

  // Tell the mobile UI whether revocation actually succeeded so it can
  // render "session revoked" vs "report recorded — revoke manually from
  // connected-apps" accurately.
  if (revocationFailed || cacheFailures > 0) {
    return c.json(
      {
        reported: true,
        revoked: !revocationFailed,
        cacheFailures,
        warning: revocationFailed
          ? 'session revocation failed; revoke this app manually from connected-apps'
          : 'session-cache invalidation partially failed; active tokens may survive up to access-token TTL',
      },
      200
    );
  }

  return c.body(null, 204);
});

async function decideHandler(
  c: import('hono').Context,
  status: 'approved' | 'denied',
  reason?: string
) {
  const userId = c.get('auth').user.id;
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'Bad request' }, 400);

  const result = await db
    .update(approvalRequests)
    .set({ status, decidedAt: new Date(), decisionReason: reason ?? null })
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
    return c.json({ error: 'Expired', finalStatus: 'expired' }, 410);
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

  return c.json({ approval: serialize(updated!) });
}

function serialize(r: typeof approvalRequests.$inferSelect) {
  return {
    id: r.id,
    requestingClientLabel: r.requestingClientLabel,
    requestingMachineLabel: r.requestingMachineLabel ?? null,
    actionLabel: r.actionLabel,
    actionToolName: r.actionToolName,
    actionArguments: r.actionArguments,
    riskTier: r.riskTier,
    riskSummary: r.riskSummary,
    status: r.status,
    expiresAt: r.expiresAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionReason: r.decisionReason ?? null,
    executionId: r.executionId ?? null,
    isRecursive: r.isRecursive,
    createdAt: r.createdAt.toISOString(),
  };
}
