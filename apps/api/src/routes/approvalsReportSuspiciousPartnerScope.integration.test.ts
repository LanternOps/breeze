/**
 * Real-Postgres proof that `POST /approvals/:id/report-suspicious` works for a
 * PARTNER-SCOPED caller, and that the security audit row it writes is tenanted
 * to the approval being reported rather than to whoever reported it (#3234).
 *
 * Why this suite has to exist at all — the coverage split that let #3234 ship:
 *   - `approvals.test.ts` has exactly the right auth shape (its file-wide auth
 *     mock is `scope: 'partner', orgId: null`) but mocks `../db` wholesale, so
 *     RLS never runs and the audit insert is stubbed to always succeed.
 *   - `approvalsDecideSupervised.integration.test.ts` runs against real
 *     Postgres as `breeze_app` with RLS enforced, but its `requesterAuth()`
 *     hardcodes `scope: 'organization'`, so `auth.orgId` is never null.
 * Neither half can catch the bug: a unit test cannot catch this class at all,
 * because the failure is a Postgres RLS abort. Only "partner-scoped caller +
 * real RLS" reproduces it, and that combination existed nowhere.
 *
 * The bug: the handler bound the audit row's org from `auth.orgId`, which is
 * NULL for a partner-scoped token. `audit_logs`' INSERT policy is
 * `WITH CHECK breeze_has_org_access(org_id)` and `breeze_has_org_access(NULL)`
 * is FALSE under any non-system scope, so the insert was rejected — and because
 * the whole request runs in ONE transaction (`withDbAccessContext`), that
 * aborted the TRANSACTION, not just the statement. The handler's local
 * try/catch swallowed the JS error, the handler returned 204, and then the
 * commit threw: a 500 whose rollback ALSO undid the row's flip to 'reported'.
 * A security action that fails open.
 *
 * `approval_requests` is Shape 6 (user-id scoped — see
 * `2026-05-16-approval-shape6-system-bypass.sql`), so a partner-scoped caller
 * can always read and flip its OWN approval row. `audit_logs` was the only
 * table that rejected the write, which is why the fix is about org resolution
 * and write context, not about the caller's permissions.
 *
 * Each case below pins one arm of the accepted resolution chain
 * (linked intent's org → caller's org → NULL):
 *   1. CAS wins            → org read from the intent row under FOR UPDATE
 *   2. CAS loses the race  → same locked read, still correct on the 409 path
 *   3. row already decided → the flip block never runs; `resolveReportAuditOrgId`
 *                            looks the intent's org up in a system context
 *   4. standalone row      → no intent and no caller org: NULL, written under
 *                            system scope, 204 rather than 500
 *
 * Co-located with the route it exercises (per the repo's test-placement
 * convention) rather than under `src/__tests__/integration/`, so it must be
 * named explicitly in BOTH `vitest.integration.config.ts` (`include`) and
 * `vitest.config.ts` (`exclude`) — the same dual hand-list the two sibling
 * `approvalsDecide*.integration.test.ts` suites use. Miss either edit and it
 * silently never runs in CI, or reds the no-DB unit job on ECONNREFUSED.
 */
import '../__tests__/integration/setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db, withSystemDbAccessContext } from '../db';
import { actionIntents } from '../db/schema/actionIntents';
import { aiSessions, aiToolExecutions } from '../db/schema/ai';
import { approvalRequests } from '../db/schema/approvals';
import { auditLogs } from '../db/schema/audit';
import { partnerUsers } from '../db/schema/users';
import { createActionIntent } from '../services/actionIntents/intentService';
import { PERMISSIONS } from '../services/permissions';
import { buildOrgAccessClosures, type AuthContext } from '../middleware/auth';
import { createAccessToken, type TokenPayload } from '../services/jwt';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from '../__tests__/integration/db-utils';
import { approvalRoutes } from './approvals';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const SUSPICIOUS_ACTION = 'security.suspicious_report';

interface Scenario {
  partnerId: string;
  /**
   * The org the REPORTED intent belongs to — the org every audit assertion
   * expects. Deliberately NOT the org on the reporting user's own row.
   */
  intentOrgId: string;
  /**
   * The reporting user's own `users.org_id` / org membership. Distinct from
   * `intentOrgId` on purpose: if the two were the same value (the obvious way
   * to seed this), an assertion of "the audit row carries the intent's org"
   * would pass just as happily against a wrong implementation that read the
   * REPORTER's org instead. Keeping them different is what makes the assertion
   * actually discriminate between the two sources.
   */
  reporterOwnOrgId: string;
  user: { id: string; email: string };
  /** Org-scoped role in `intentOrgId`, used only to CREATE the intent. */
  orgRoleId: string;
  /** Partner-scoped role, used for the report-suspicious token under test. */
  partnerRoleId: string;
}

/**
 * One user holding BOTH an org membership and a partner membership, under a
 * partner with TWO orgs. The intent is created with an org-scoped context for
 * org A (so the intent has a real `org_id` and the approval row is owned by
 * this user), and then reported with a PARTNER-scoped token for the same user —
 * which is what makes `auth.orgId` null at the audit write. That combination is
 * the whole point of the suite.
 *
 * The user's OWN org is org B, so "audit org == org A" can only hold if the
 * handler really resolved the org from the linked intent.
 */
async function seedPartnerScopedReporter(): Promise<Scenario> {
  const partner = await createPartner();
  const intentOrg = await createOrganization({ partnerId: partner.id });
  const reporterOwnOrg = await createOrganization({ partnerId: partner.id });

  const orgRole = await createRole({ scope: 'organization', orgId: intentOrg.id });
  await grantRolePermissions(orgRole.id, [PERMISSIONS.DEVICES_EXECUTE]);

  const partnerRole = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(partnerRole.id, [PERMISSIONS.DEVICES_EXECUTE]);

  const user = await createUser({
    partnerId: partner.id,
    orgId: reporterOwnOrg.id,
    email: `partner-reporter-${randomUUID()}@reportsuspicious.test`,
  });
  // Membership in the INTENT's org, so createActionIntent's org-scoped context
  // is legitimate; the user's own `users.org_id` stays org B.
  await assignUserToOrganization(user.id, intentOrg.id, orgRole.id);
  // orgAccess 'all' so authMiddleware's computeAccessibleOrgIds resolves the
  // partner's orgs. Note the fix must NOT depend on this: the audit org comes
  // from the intent, not from the caller's reachable-org list.
  await assignUserToPartner(user.id, partner.id, partnerRole.id, 'all');

  return {
    partnerId: partner.id,
    intentOrgId: intentOrg.id,
    reporterOwnOrgId: reporterOwnOrg.id,
    user: { id: user.id, email: user.email },
    orgRoleId: orgRole.id,
    partnerRoleId: partnerRole.id,
  };
}

/** Org-scoped AuthContext for the INTENT's org, used ONLY to create the intent. */
function orgScopedAuth(s: Scenario): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([s.intentOrgId]);
  return {
    principal: { kind: 'user_session' },
    user: { id: s.user.id, email: s.user.email, name: 'Reporter', isPlatformAdmin: false },
    token: {
      sub: s.user.id,
      email: s.user.email,
      roleId: s.orgRoleId,
      orgId: s.intentOrgId,
      partnerId: s.partnerId,
      scope: 'organization',
      type: 'access',
      mfa: true,
    },
    partnerId: s.partnerId,
    orgId: s.intentOrgId,
    scope: 'organization',
    accessibleOrgIds: [s.intentOrgId],
    orgCondition,
    canAccessOrg,
  };
}

/**
 * A real PARTNER-scoped access token — `orgId: null` is the defining feature,
 * and the direct cause of #3234. Driven through the genuine `authMiddleware`
 * (mounted inside `approvals.ts` itself), so the request really does run in a
 * partner-scope `withDbAccessContext` transaction as `breeze_app`.
 */
async function partnerScopedToken(s: Scenario): Promise<string> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: s.user.id,
    email: s.user.email,
    roleId: s.partnerRoleId,
    orgId: null,
    partnerId: s.partnerId,
    scope: 'partner',
    mfa: false,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  return createAccessToken(payload);
}

async function reportSuspiciousAsPartner(s: Scenario, approvalRowId: string): Promise<Response> {
  const token = await partnerScopedToken(s);
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  return app.request(`/approvals/${approvalRowId}/report-suspicious`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

/** Seeds a supervised intent + its single requester-owned approval row. */
async function seedIntent(s: Scenario): Promise<{ intentId: string; approvalRowId: string }> {
  const snapshot = await createActionIntent(orgScopedAuth(s), {
    toolName: 'execute_command',
    input: { deviceId: randomUUID(), commandType: 'kill_process' },
    source: 'chat',
  });
  expect(snapshot.status).toBe('pending_approval');
  expect(snapshot.requesterApprovalRequestId).toBeTruthy();
  return { intentId: snapshot.id, approvalRowId: snapshot.requesterApprovalRequestId! };
}

/**
 * A standalone approval row: no intent, no execution, no elevation — the
 * dev-seed / PAM-less shape that `approval_requests_one_source_chk` permits
 * (it caps the linkage columns at one, and zero is allowed). Inserted under a
 * system context because the suite itself runs outside any request scope.
 * `requestingClientId` is left NULL so the handler skips OAuth revocation and
 * the case stays focused on the audit write.
 */
async function seedStandaloneApproval(s: Scenario): Promise<string> {
  const [row] = await withSystemDbAccessContext(() =>
    db
      .insert(approvalRequests)
      .values({
        userId: s.user.id,
        requestingClientLabel: 'Standalone Reporter Test',
        actionLabel: 'Standalone suspicious action',
        actionToolName: 'execute_command',
        riskTier: 'high',
        riskSummary: 'seeded standalone row for #3234 coverage',
        status: 'pending',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .returning({ id: approvalRequests.id }),
  );
  if (!row) throw new Error('seed: standalone approval row insert returned nothing');
  return row.id;
}

/**
 * Narrows the reporter's partner membership so its accessible-org list EXCLUDES
 * the execution's org (org A), leaving only org B selected.
 *
 * This is the precondition for the silent-zero-row mirror bug, and it is worth
 * being exact about it: the trigger is the accessible-ORG-LIST, not the scope.
 * A partner-scoped caller with `orgAccess: 'all'` still reaches the execution's
 * row through `ai_tool_executions`' EXISTS-join policy on `ai_sessions.org_id`,
 * so the pre-fix mirror would have succeeded and the test would pass for the
 * wrong reason. Only a caller that genuinely cannot see the org reproduces it.
 */
async function narrowReporterToOwnOrgOnly(s: Scenario): Promise<void> {
  await withSystemDbAccessContext(() =>
    db
      .update(partnerUsers)
      .set({ orgAccess: 'selected', orgIds: [s.reporterOwnOrgId] })
      .where(and(eq(partnerUsers.userId, s.user.id), eq(partnerUsers.partnerId, s.partnerId))),
  );
}

/**
 * An EXECUTION-linked approval: the legacy AI mobile-push shape, where the row
 * carries `executionId` instead of `intentId` and the handler must mirror the
 * denial onto `ai_tool_executions` so the SDK's `waitForApproval` unblocks.
 *
 * The execution's session belongs to org A. Combined with
 * `narrowReporterToOwnOrgOnly`, the reporting caller cannot see that org — the
 * exact shape that made the mirror UPDATE silently match zero rows before the
 * fix, because `ai_tool_executions` is org-scoped through `ai_sessions.org_id`
 * via an EXISTS join policy.
 */
async function seedExecutionLinkedApproval(
  s: Scenario,
): Promise<{ approvalRowId: string; executionId: string }> {
  return withSystemDbAccessContext(async () => {
    const [session] = await db
      .insert(aiSessions)
      .values({ orgId: s.intentOrgId, userId: s.user.id, status: 'active', type: 'general' })
      .returning({ id: aiSessions.id });
    if (!session) throw new Error('seed: ai_sessions insert returned nothing');

    const [execution] = await db
      .insert(aiToolExecutions)
      .values({
        sessionId: session.id,
        toolName: 'execute_command',
        toolInput: { deviceId: randomUUID(), commandType: 'kill_process' },
        status: 'pending',
      })
      .returning({ id: aiToolExecutions.id });
    if (!execution) throw new Error('seed: ai_tool_executions insert returned nothing');

    const [row] = await db
      .insert(approvalRequests)
      .values({
        userId: s.user.id,
        executionId: execution.id,
        requestingClientLabel: 'Execution-Linked Reporter Test',
        actionLabel: 'Execution-linked suspicious action',
        actionToolName: 'execute_command',
        riskTier: 'high',
        riskSummary: 'seeded execution-linked row for #3234 coverage',
        status: 'pending',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .returning({ id: approvalRequests.id });
    if (!row) throw new Error('seed: execution-linked approval insert returned nothing');

    return { approvalRowId: row.id, executionId: execution.id };
  });
}

/** The security audit row for a given approval, read in a system context. */
async function readSuspiciousAudit(approvalRowId: string) {
  return withSystemDbAccessContext(async () => {
    const rows = await db
      .select({
        orgId: auditLogs.orgId,
        actorId: auditLogs.actorId,
        actorType: auditLogs.actorType,
        details: auditLogs.details,
        result: auditLogs.result,
      })
      .from(auditLogs)
      .where(
        and(eq(auditLogs.action, SUSPICIOUS_ACTION), eq(auditLogs.resourceId, approvalRowId)),
      );
    return rows;
  });
}

let seeded: Scenario | null = null;

beforeEach(async () => {
  seeded = await seedPartnerScopedReporter();
});

describe('report-suspicious as a partner-scoped caller (real Postgres, breeze_app)', () => {
  runDb(
    'intent-linked, CAS wins: 204 (not 500), row reported, and the audit row carries the INTENT org — not the caller null org',
    async () => {
      const s = seeded!;
      const { intentId, approvalRowId } = await seedIntent(s);

      const res = await reportSuspiciousAsPartner(s, approvalRowId);

      // Before the fix this was 500 with
      // `new row violates row-level security policy for table "audit_logs"`.
      expect(res.status).toBe(204);

      await withSystemDbAccessContext(async () => {
        const [row] = await db
          .select({ status: approvalRequests.status })
          .from(approvalRequests)
          .where(eq(approvalRequests.id, approvalRowId));
        // The flip survived: the audit write can no longer roll it back.
        expect(row?.status).toBe('reported');

        const [intent] = await db
          .select({ status: actionIntents.status })
          .from(actionIntents)
          .where(eq(actionIntents.id, intentId));
        expect(intent?.status).toBe('rejected');
      });

      const audits = await readSuspiciousAudit(approvalRowId);
      expect(audits).toHaveLength(1);
      // The whole point of #3234: the audit row is tenanted to the approval's
      // org, taken from the linked intent — NOT to the reporter's null org.
      expect(audits[0]?.orgId).toBe(s.intentOrgId);
      // Not the reporter's own org either — the assertion above would pass for
      // the wrong reason if the seed let those two orgs coincide.
      expect(audits[0]?.orgId).not.toBe(s.reporterOwnOrgId);
      expect(audits[0]?.actorId).toBe(s.user.id);
      expect(audits[0]?.actorType).toBe('user');
      expect(audits[0]?.result).toBe('success');
      const details = audits[0]?.details as Record<string, unknown>;
      expect(details.approvalId).toBe(approvalRowId);
      // Key is `refreshRevocationCount`, not `refreshTokensRevoked`: the audit
      // sanitizer redacts any key containing the substring "token", which would
      // turn this integer into the string '[REDACTED]'.
      expect(details.refreshRevocationCount).toBe(0);
      expect(details).not.toHaveProperty('refreshTokensRevoked');
    },
  );

  runDb(
    'intent-linked, CAS loses the decide race: 409 already_decided, and the audit row STILL carries the intent org',
    async () => {
      const s = seeded!;
      const { intentId, approvalRowId } = await seedIntent(s);

      // Simulate a concurrent decide committing first, exactly as the sibling
      // atomicity suite does: the handler's unlocked pre-fetch still enters the
      // intent branch, then its CAS loses under the FOR UPDATE lock.
      await withSystemDbAccessContext(() =>
        db
          .update(actionIntents)
          .set({ status: 'approved', decidedAt: new Date(), decidedByUserId: s.user.id })
          .where(eq(actionIntents.id, intentId)),
      );

      const res = await reportSuspiciousAsPartner(s, approvalRowId);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'already_decided', finalStatus: 'approved' });

      // Revocation + audit are deliberately unconditional on this path, so the
      // org must be resolved from the LOCKED intent row rather than from the
      // CAS `.returning()` (which is empty when the race is lost).
      const audits = await readSuspiciousAudit(approvalRowId);
      expect(audits).toHaveLength(1);
      expect(audits[0]?.orgId).toBe(s.intentOrgId);
      expect(audits[0]?.orgId).not.toBe(s.reporterOwnOrgId);
    },
  );

  runDb(
    'intent-linked but already decided: the flip block never runs, so the org comes from the system-context intent lookup',
    async () => {
      const s = seeded!;
      const { intentId, approvalRowId } = await seedIntent(s);

      // Take the approval row itself out of 'pending', so the handler skips the
      // entire flip/CAS block — the one path with no locked intent read, and
      // the reason `resolveReportAuditOrgId` exists.
      await withSystemDbAccessContext(() =>
        db
          .update(approvalRequests)
          .set({ status: 'approved', decidedAt: new Date() })
          .where(eq(approvalRequests.id, approvalRowId)),
      );

      const res = await reportSuspiciousAsPartner(s, approvalRowId);
      expect(res.status).toBe(204);

      const audits = await readSuspiciousAudit(approvalRowId);
      expect(audits).toHaveLength(1);
      expect(audits[0]?.orgId).toBe(s.intentOrgId);
      expect(audits[0]?.orgId).not.toBe(s.reporterOwnOrgId);
      const details = audits[0]?.details as Record<string, unknown>;
      // The prior status is preserved for forensics rather than overwritten.
      expect(details.priorStatus).toBe('approved');

      await withSystemDbAccessContext(async () => {
        // A re-report must not clobber the recorded decision.
        const [intent] = await db
          .select({ status: actionIntents.status })
          .from(actionIntents)
          .where(eq(actionIntents.id, intentId));
        expect(intent?.status).toBe('pending_approval');
      });
    },
  );

  runDb(
    'standalone approval with no intent and a partner-scoped caller: 204 with a NULL-org audit row, rather than a 500',
    async () => {
      const s = seeded!;
      const approvalRowId = await seedStandaloneApproval(s);

      const res = await reportSuspiciousAsPartner(s, approvalRowId);
      expect(res.status).toBe(204);

      await withSystemDbAccessContext(async () => {
        const [row] = await db
          .select({ status: approvalRequests.status })
          .from(approvalRequests)
          .where(eq(approvalRequests.id, approvalRowId));
        expect(row?.status).toBe('reported');
      });

      const audits = await readSuspiciousAudit(approvalRowId);
      expect(audits).toHaveLength(1);
      // There is genuinely no org to name here: no linked intent, and the
      // reporter is partner-scoped. NULL is insertable only because the write
      // runs in a system-scope context — `breeze_has_org_access(NULL)` is FALSE
      // under every other scope. Writing NULL beats inventing a tenant.
      expect(audits[0]?.orgId).toBeNull();
      expect(audits[0]?.actorId).toBe(s.user.id);
    },
  );

  runDb(
    'execution-linked: the ai_tool_executions mirror lands even when the caller cannot see the execution org, unblocking the SDK waiter',
    async () => {
      const s = seeded!;
      const { approvalRowId, executionId } = await seedExecutionLinkedApproval(s);
      // Without this the caller CAN see org A and the pre-fix mirror would have
      // worked, making the assertion below pass for the wrong reason.
      await narrowReporterToOwnOrgOnly(s);

      const res = await reportSuspiciousAsPartner(s, approvalRowId);
      expect(res.status).toBe(204);

      await withSystemDbAccessContext(async () => {
        const [row] = await db
          .select({ status: approvalRequests.status })
          .from(approvalRequests)
          .where(eq(approvalRequests.id, approvalRowId));
        expect(row?.status).toBe('reported');

        const [execution] = await db
          .select({
            status: aiToolExecutions.status,
            approvedBy: aiToolExecutions.approvedBy,
          })
          .from(aiToolExecutions)
          .where(eq(aiToolExecutions.id, executionId));
        // The mirror is the load-bearing assertion. `ai_tool_executions` is
        // org-scoped through `ai_sessions.org_id` (EXISTS join policy), so
        // before the fix this UPDATE silently matched ZERO rows for a caller
        // that cannot reach the execution's org: no error, no mirror, and the
        // SDK's waitForApproval never learned the action was denied. It now
        // runs in its own system-scope transaction. Verified non-vacuous —
        // reverting just the mirror to the ambient request transaction leaves
        // this row 'pending' and reds this expectation.
        expect(execution?.status).toBe('rejected');
        expect(execution?.approvedBy).toBe(s.user.id);
      });

      // No linked intent on this shape, so the audit row has no intent org to
      // inherit and the partner-scoped reporter supplies none — NULL, written
      // under system scope rather than 500ing. Attribution through
      // `ai_sessions.org_id` is possible but deliberately out of scope (#3234
      // settled on intent → caller → NULL); see the PR's follow-ups.
      const audits = await readSuspiciousAudit(approvalRowId);
      expect(audits).toHaveLength(1);
      expect(audits[0]?.orgId).toBeNull();
    },
  );
});
