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
import { approvalRequests } from '../db/schema/approvals';
import { auditLogs } from '../db/schema/audit';
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
  orgId: string;
  user: { id: string; email: string };
  /** Org-scoped role, used only to CREATE the intent being reported. */
  orgRoleId: string;
  /** Partner-scoped role, used for the report-suspicious token under test. */
  partnerRoleId: string;
}

/**
 * One user holding BOTH an org membership and a partner membership. The intent
 * is created with the org-scoped context (so the intent has a real `org_id`
 * and the approval row is owned by this user), and then reported with a
 * PARTNER-scoped token for the same user — which is what makes `auth.orgId`
 * null at the audit write. That combination is the whole point of the suite.
 */
async function seedPartnerScopedReporter(): Promise<Scenario> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });

  const orgRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(orgRole.id, [PERMISSIONS.DEVICES_EXECUTE]);

  const partnerRole = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(partnerRole.id, [PERMISSIONS.DEVICES_EXECUTE]);

  const user = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `partner-reporter-${randomUUID()}@reportsuspicious.test`,
  });
  await assignUserToOrganization(user.id, org.id, orgRole.id);
  // orgAccess 'all' so authMiddleware's computeAccessibleOrgIds resolves the
  // partner's orgs. Note the fix must NOT depend on this: the audit org comes
  // from the intent, not from the caller's reachable-org list.
  await assignUserToPartner(user.id, partner.id, partnerRole.id, 'all');

  return {
    partnerId: partner.id,
    orgId: org.id,
    user: { id: user.id, email: user.email },
    orgRoleId: orgRole.id,
    partnerRoleId: partnerRole.id,
  };
}

/** Org-scoped AuthContext, used ONLY to create the intent under test. */
function orgScopedAuth(s: Scenario): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([s.orgId]);
  return {
    principal: { kind: 'user_session' },
    user: { id: s.user.id, email: s.user.email, name: 'Reporter', isPlatformAdmin: false },
    token: {
      sub: s.user.id,
      email: s.user.email,
      roleId: s.orgRoleId,
      orgId: s.orgId,
      partnerId: s.partnerId,
      scope: 'organization',
      type: 'access',
      mfa: true,
    },
    partnerId: s.partnerId,
    orgId: s.orgId,
    scope: 'organization',
    accessibleOrgIds: [s.orgId],
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
      expect(audits[0]?.orgId).toBe(s.orgId);
      expect(audits[0]?.orgId).not.toBeNull();
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
      expect(audits[0]?.orgId).toBe(s.orgId);
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
      expect(audits[0]?.orgId).toBe(s.orgId);
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
});
