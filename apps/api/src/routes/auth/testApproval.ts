import { Hono } from 'hono';
import { db } from '../../db';
import { approvalRequests } from '../../db/schema/approvals';
import { authMiddleware } from '../../middleware/auth';
import { rateLimiter, getRedis } from '../../services';
import { dispatchApprovalPush } from '../../services/expoPush';
import {
  getClientRateLimitKey,
  resolveUserAuditOrgId,
  writeAuthAudit,
} from './helpers';

export const testApprovalRoutes = new Hono();

const TEST_APPROVAL_TTL_SECONDS = 60;
const TEST_APPROVAL_RATE_LIMIT = 2;
const TEST_APPROVAL_RATE_WINDOW_SECONDS = 60;

const TEST_TOOL_NAME = 'breeze.test.approval';
const TEST_ACTION_LABEL = 'Approve a test request from Breeze.';
const TEST_REQUESTING_CLIENT_LABEL = 'Breeze (test trigger)';
const TEST_RISK_SUMMARY =
  'Sandbox test. Approving or denying has no effect on your fleet.';
const TEST_NOTE =
  'This is a sandbox approval triggered by you. No real action will run.';

/**
 * POST /auth/me/test-approval
 *
 * Self-addressed approval push so a signed-in user (including the App Store
 * reviewer test account) can verify the mobile approval takeover flow without
 * a real fleet. Always self-addressed — never accepts a target user id. Push
 * fan-out is best-effort: a 0-device account still creates the approval row
 * but reports `pushSentToDeviceCount: 0` so the web UI can tell the user.
 */
testApprovalRoutes.post('/me/test-approval', authMiddleware, async (c) => {
  const auth = c.get('auth');
  const userId = auth.user.id;

  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  const rateKey = `test-approval:${getClientRateLimitKey(c)}:${userId}`;
  const rateCheck = await rateLimiter(
    redis,
    rateKey,
    TEST_APPROVAL_RATE_LIMIT,
    TEST_APPROVAL_RATE_WINDOW_SECONDS,
  );
  if (!rateCheck.allowed) {
    return c.json(
      {
        error: 'Too many test approvals. Please wait a moment and try again.',
        retryAfter: Math.ceil(
          (rateCheck.resetAt.getTime() - Date.now()) / 1000,
        ),
      },
      429,
    );
  }

  const expiresAt = new Date(Date.now() + TEST_APPROVAL_TTL_SECONDS * 1000);

  const [row] = await db
    .insert(approvalRequests)
    .values({
      userId,
      requestingClientLabel: TEST_REQUESTING_CLIENT_LABEL,
      requestingMachineLabel: null,
      actionLabel: TEST_ACTION_LABEL,
      actionToolName: TEST_TOOL_NAME,
      actionArguments: { note: TEST_NOTE },
      riskTier: 'low',
      riskSummary: TEST_RISK_SUMMARY,
      status: 'pending',
      expiresAt,
      executionId: null,
      // Sandbox test push — never the recursive self-approval loop, even
      // though it's also self-addressed. The 5s hold UX is reserved for
      // genuine OAuth-driven mobile-MCP self-loops, not the App Store
      // reviewer test trigger.
      isRecursive: false,
    })
    .returning();

  if (!row) {
    return c.json({ error: 'Failed to create test approval' }, 500);
  }

  // Push fan-out is best-effort. The approval row itself is what matters —
  // the mobile app polls + foregrounds anyway. We surface the device count
  // so the web UI can tell users that haven't signed into mobile yet.
  // dispatchApprovalPush fans out across every provider (Expo + native APNs)
  // and never throws.
  const { tokensFound, dispatched, errors } = await dispatchApprovalPush(userId, {
    approvalId: row.id,
    actionLabel: row.actionLabel,
    requestingClientLabel: row.requestingClientLabel,
  });

  const auditOrgId = await resolveUserAuditOrgId(userId);
  writeAuthAudit(c, {
    orgId: auditOrgId ?? undefined,
    action: 'user.test_approval.triggered',
    result: 'success',
    userId,
    email: auth.user.email,
    details: {
      approvalId: row.id,
      tokensFound,
      dispatched,
      expiresAt: expiresAt.toISOString(),
    },
  });

  return c.json(
    {
      approvalId: row.id,
      expiresAt: expiresAt.toISOString(),
      pushSentToDeviceCount: dispatched,
      registeredDeviceCount: tokensFound,
      errors,
    },
    201,
  );
});
