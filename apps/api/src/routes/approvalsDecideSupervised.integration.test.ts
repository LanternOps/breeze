/**
 * Real-Postgres proof that the Tier-3 SUPERVISED plain-decide branch (Task 6)
 * enforces its live-RBAC re-check against genuine role/permission state.
 *
 * `approvals.test.ts` mocks BOTH of the supervised branch's authz
 * dependencies wholesale — `buildAuthContextForIntent`
 * (services/actionIntents/actorContext.ts) and `checkToolPermission`
 * (services/aiGuardrails.ts) — because the real modules pull in
 * `../aiTools`'s whole dependency graph, which that file's narrow
 * `../services/permissions` mock can't support. That leaves the actual
 * plumbing between "requester's role holds devices:execute" and "the decide
 * route returns 200/403" completely unexercised against a real database: a
 * bug in `buildAuthContextForIntent`'s role resolution, `getUserPermissions`
 * caching, or the wiring between them would pass the mocked unit suite
 * unnoticed (fix round 1, finding 4).
 *
 * This suite drives the REAL approve route (real JWT + `authMiddleware` +
 * `breeze_app` RLS) against the test Postgres, seeding an `execute_command`
 * intent (TIER3_SUPERVISED_TOOLS, aiGuardrails.ts — resolves whole-tool
 * `supervised`) and deciding it as the requester.
 *
 * Co-located with the route it exercises (per the repo's test-placement
 * convention) rather than under `src/__tests__/integration/`, so it is named
 * explicitly in BOTH `vitest.integration.config.ts` (`include`) and
 * `vitest.config.ts` (`exclude`) — the same dual hand-list
 * `approvalsDecideAtomicity.integration.test.ts` uses. Miss either edit and
 * it silently never runs in CI, or reds the no-DB unit job on ECONNREFUSED.
 */
import '../__tests__/integration/setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db, withSystemDbAccessContext } from '../db';
import { actionIntents, intentOutbox } from '../db/schema/actionIntents';
import { approvalRequests } from '../db/schema/approvals';
import { permissions, rolePermissions } from '../db/schema';
import { createActionIntent } from '../services/actionIntents/intentService';
import { PERMISSIONS, clearPermissionCache } from '../services/permissions';
import { buildOrgAccessClosures, type AuthContext } from '../middleware/auth';
import { createAccessToken, type TokenPayload } from '../services/jwt';
import { getTestDb } from '../__tests__/integration/setup';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from '../__tests__/integration/db-utils';
import { approvalRoutes } from './approvals';

const runDb = it.runIf(!!process.env.DATABASE_URL);

/** Real AuthContext for the requester acting on `orgId` — same shape
 * authMiddleware produces (reuses buildOrgAccessClosures so org-access
 * semantics can't drift from the live path). Mirrors the atomicity suite's
 * helper of the same name. */
function requesterAuth(
  user: { id: string; email: string },
  orgId: string,
  partnerId: string,
  roleId: string,
): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([orgId]);
  return {
    principal: { kind: 'user_session' },
    user: { id: user.id, email: user.email, name: 'Requester', isPlatformAdmin: false },
    token: {
      sub: user.id,
      email: user.email,
      roleId,
      orgId,
      partnerId,
      scope: 'organization',
      type: 'access',
      mfa: true,
    },
    partnerId,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition,
    canAccessOrg,
  };
}

/** A real access token for the requester deciding their own supervised row,
 * minted the same way the atomicity suite's approverAccessToken is. */
async function requesterAccessToken(
  user: { id: string; email: string },
  orgId: string,
  partnerId: string,
  roleId: string,
): Promise<string> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: user.id,
    email: user.email,
    roleId,
    orgId,
    partnerId,
    scope: 'organization',
    mfa: false,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  return createAccessToken(payload);
}

interface Scenario {
  partnerId: string;
  orgId: string;
  requester: { id: string; email: string };
  requesterRoleId: string;
}

/** Seeds one org under one partner + a requester whose role holds
 * devices:execute (the RBAC entry TOOL_PERMISSIONS maps execute_command to)
 * but deliberately NOT approvals:decide — supervised never requires it. */
async function seedSupervisedScenario(): Promise<Scenario> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });

  const role = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(role.id, [PERMISSIONS.DEVICES_EXECUTE]);

  const requester = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `requester-${randomUUID()}@decidesupervised.test`,
  });
  await assignUserToOrganization(requester.id, org.id, role.id);

  return {
    partnerId: partner.id,
    orgId: org.id,
    requester: { id: requester.id, email: requester.email },
    requesterRoleId: role.id,
  };
}

/** Revokes devices:execute from a role by deleting its role_permissions row
 * directly (no db-utils helper exists for revocation — grantRolePermissions
 * only adds). Also busts the permission cache so the live re-check actually
 * observes it (services/permissions.ts caches resolved role permissions). */
async function revokeDevicesExecute(roleId: string, userId: string): Promise<void> {
  const sdb = getTestDb();
  const [permRow] = await sdb
    .select({ id: permissions.id })
    .from(permissions)
    .where(and(eq(permissions.resource, 'devices'), eq(permissions.action, 'execute')))
    .limit(1);
  if (!permRow) throw new Error('seed: devices:execute permission row not found');
  await sdb
    .delete(rolePermissions)
    .where(and(eq(rolePermissions.roleId, roleId), eq(rolePermissions.permissionId, permRow.id)));
  await clearPermissionCache(userId);
}

async function seedSupervisedIntent(s: Scenario): Promise<{ intentId: string; approvalRowId: string }> {
  const auth = requesterAuth(s.requester, s.orgId, s.partnerId, s.requesterRoleId);
  // execute_command is in TIER3_SUPERVISED_TOOLS (aiGuardrails.ts) — a base
  // Tier-3 tool needing no `action` field. createActionIntent never verifies
  // the device exists (that happens at release time), so a bare random UUID
  // is fine.
  const snapshot = await createActionIntent(auth, {
    toolName: 'execute_command',
    input: { deviceId: randomUUID(), commandType: 'kill_process' },
    source: 'chat',
  });
  expect(snapshot.status).toBe('pending_approval');
  // Supervised: exactly ONE approval row, always owned by the requester.
  expect(snapshot.approvalRequestIds).toHaveLength(1);
  expect(snapshot.requesterApprovalRequestId).toBeTruthy();

  const [intent] = await withSystemDbAccessContext(() =>
    db.select({ approvalScope: actionIntents.approvalScope }).from(actionIntents).where(eq(actionIntents.id, snapshot.id)),
  );
  expect(intent?.approvalScope).toBe('supervised');

  return { intentId: snapshot.id, approvalRowId: snapshot.requesterApprovalRequestId! };
}

async function decideViaRoute(
  s: Scenario,
  approvalRowId: string,
  action: 'approve' | 'deny' = 'approve',
): Promise<Response> {
  return postViaRoute(s, approvalRowId, action);
}

async function postViaRoute(s: Scenario, approvalRowId: string, action: string): Promise<Response> {
  const token = await requesterAccessToken(s.requester, s.orgId, s.partnerId, s.requesterRoleId);
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  return app.request(`/approvals/${approvalRowId}/${action}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

async function getViaRoute(s: Scenario, approvalRowId: string): Promise<Response> {
  const token = await requesterAccessToken(s.requester, s.orgId, s.partnerId, s.requesterRoleId);
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  return app.request(`/approvals/${approvalRowId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

let seeded: Scenario | null = null;

beforeEach(async () => {
  seeded = await seedSupervisedScenario();
});

describe('supervised intent plain-decide branch (real Postgres, breeze_app)', () => {
  runDb('happy path: requester self-decides a supervised intent — 200, intent approved, outbox row written', async () => {
    const s = seeded!;
    const { intentId, approvalRowId } = await seedSupervisedIntent(s);

    const res = await decideViaRoute(s, approvalRowId, 'approve');
    expect(res.status).toBe(200);

    await withSystemDbAccessContext(async () => {
      const [intent] = await db.select().from(actionIntents).where(eq(actionIntents.id, intentId));
      expect(intent?.status).toBe('approved');
      expect(intent?.releaseBy).toBeInstanceOf(Date);

      const outbox = await db
        .select()
        .from(intentOutbox)
        .where(and(eq(intentOutbox.intentId, intentId), eq(intentOutbox.eventType, 'intent_approved')));
      expect(outbox).toHaveLength(1);

      const [row] = await db
        .select({ status: approvalRequests.status })
        .from(approvalRequests)
        .where(eq(approvalRequests.id, approvalRowId));
      expect(row?.status).toBe('approved');
    });
  });

  runDb('revoked-permission path: requester loses devices:execute between create and decide — 403, nothing written', async () => {
    const s = seeded!;
    const { intentId, approvalRowId } = await seedSupervisedIntent(s);

    await revokeDevicesExecute(s.requesterRoleId, s.requester.id);

    const res = await decideViaRoute(s, approvalRowId, 'approve');
    expect(res.status).toBe(403);

    await withSystemDbAccessContext(async () => {
      const [intent] = await db.select().from(actionIntents).where(eq(actionIntents.id, intentId));
      expect(intent?.status).toBe('pending_approval');
      expect(intent?.releaseBy).toBeNull();

      const outbox = await db
        .select()
        .from(intentOutbox)
        .where(and(eq(intentOutbox.intentId, intentId), eq(intentOutbox.eventType, 'intent_approved')));
      expect(outbox).toHaveLength(0);

      const [row] = await db
        .select({ status: approvalRequests.status })
        .from(approvalRequests)
        .where(eq(approvalRequests.id, approvalRowId));
      expect(row?.status).toBe('pending');
    });
  });

  runDb('a requester who lost devices:execute can still DENY their own supervised row (deny is harmless)', async () => {
    const s = seeded!;
    const { intentId, approvalRowId } = await seedSupervisedIntent(s);

    await revokeDevicesExecute(s.requesterRoleId, s.requester.id);

    const res = await decideViaRoute(s, approvalRowId, 'deny');
    expect(res.status).toBe(200);

    await withSystemDbAccessContext(async () => {
      const [intent] = await db.select().from(actionIntents).where(eq(actionIntents.id, intentId));
      expect(intent?.status).toBe('rejected');
    });
  });
});

describe('GET /approvals/:id live-authorization filter (real Postgres, breeze_app)', () => {
  runDb('the requester can read their own live supervised row, and it carries approvalScope', async () => {
    const s = seeded!;
    const { approvalRowId } = await seedSupervisedIntent(s);

    const res = await getViaRoute(s, approvalRowId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approval: { approvalScope: string; actionToolName: string } };
    expect(body.approval.approvalScope).toBe('supervised');
    expect(body.approval.actionToolName).toBe('execute_command');
  });

  runDb('404s once the linked intent has left pending_approval — the detail endpoint stops disclosing arguments', async () => {
    const s = seeded!;
    const { approvalRowId } = await seedSupervisedIntent(s);

    expect((await decideViaRoute(s, approvalRowId, 'approve')).status).toBe(200);

    // Same rule /pending applies: the row is no longer live, so the detail
    // endpoint no longer hands back actionArguments/actionLabel/riskSummary.
    const res = await getViaRoute(s, approvalRowId);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('execute_command');
  });
});

describe('POST /approvals/:id/report-suspicious losing the decide race (real Postgres, breeze_app)', () => {
  /**
   * Fix round 2, finding 2. The handler used to answer 204 — indistinguishable
   * from "your report stopped it" — when its intent CAS matched zero rows,
   * even though the intent was already `approved`, the `intent_approved`
   * outbox event queued, and the durable release worker about to run the very
   * action the user just flagged as malicious.
   *
   * The race is simulated by committing the intent transition out of band
   * (exactly what a concurrent decide's transaction leaves behind) while this
   * caller's own approval row is still `pending`, so the handler's unlocked
   * pre-fetch enters the intent branch and the CAS then loses under the
   * FOR UPDATE lock — the real, unmockable half of this path.
   */
  runDb('answers 409 already_decided with the terminal intent status, and leaves the approved intent intact', async () => {
    const s = seeded!;
    const { intentId, approvalRowId } = await seedSupervisedIntent(s);

    await withSystemDbAccessContext(() =>
      db
        .update(actionIntents)
        .set({ status: 'approved', decidedAt: new Date(), decidedByUserId: s.requester.id })
        .where(eq(actionIntents.id, intentId)),
    );

    const res = await postViaRoute(s, approvalRowId, 'report-suspicious');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'already_decided', finalStatus: 'approved' });

    await withSystemDbAccessContext(async () => {
      // The report never rolls back somebody else's win.
      const [intent] = await db.select().from(actionIntents).where(eq(actionIntents.id, intentId));
      expect(intent?.status).toBe('approved');
    });
  });

  runDb('happy path still 204s and rejects the intent when the CAS wins', async () => {
    const s = seeded!;
    const { intentId, approvalRowId } = await seedSupervisedIntent(s);

    const res = await postViaRoute(s, approvalRowId, 'report-suspicious');
    expect(res.status).toBe(204);

    await withSystemDbAccessContext(async () => {
      const [intent] = await db.select().from(actionIntents).where(eq(actionIntents.id, intentId));
      expect(intent?.status).toBe('rejected');

      const [row] = await db
        .select({ status: approvalRequests.status })
        .from(approvalRequests)
        .where(eq(approvalRequests.id, approvalRowId));
      expect(row?.status).toBe('reported');
    });
  });
});
