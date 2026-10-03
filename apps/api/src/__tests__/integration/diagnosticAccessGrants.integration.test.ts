/**
 * Real-PostgreSQL proof for administrator-approved diagnostic access grants
 * (migration 2026-12-07-120000-diagnostic-access-grants.sql,
 * services/diagnosticAccess/*).
 *
 * Covers, against the live schema as the non-bypass `breeze_app` role:
 *   1. Shape-1 org RLS on diagnostic_access_grants (hidden cross-org reads,
 *      forged cross-org INSERT -> 42501).
 *   2. The table's CHECK constraints and approval_requests_one_source_chk.
 *   3. Grant state transitions through the service functions
 *      (createDiagnosticAccessRequest, decideDiagnosticGrantInTx,
 *      findCoveringGrant coverage checks, revokeDiagnosticGrant), request
 *      reuse rules, and lapse of an active grant past expires_at. It does NOT
 *      go through the HTTP approval route, the command queue/delivery signer
 *      or an agent: those are covered by the unit suites (delivery.test.ts,
 *      decideApprovalRequest.diagnosticAccess.test.ts, the Go diagaccess
 *      tests) and the TS<->Go wire vector (interop.test.ts), separately.
 *   4. The device org-move hook and the org_id-change fence trigger.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { approvalRequests, devices, diagnosticAccessGrants, organizationUsers } from '../../db/schema';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import {
  createDiagnosticAccessRequest,
  decideDiagnosticGrantInTx,
  findCoveringGrant,
  listDiagnosticGrants,
  resolveEligibleApprovers,
  revokeDiagnosticGrant,
} from '../../services/diagnosticAccess/grants';
import { expireDiagnosticApprovalsForMovedDevice, revokeDiagnosticGrantsForMove } from '../../services/diagnosticAccess/deviceMove';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const IN_SCOPE = 'C:\\Users\\Alice\\AppData\\Local\\Battle.net\\Logs\\Agent.log';
const OUT_OF_SCOPE = 'C:\\Users\\Alice\\Documents\\x.txt';
const SCOPE_ROOT = 'C:\\Users\\Alice\\AppData\\Local\\Battle.net';

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

async function causeOf(
  work: () => Promise<unknown>,
): Promise<{ code?: string; message?: string; constraint_name?: string } | undefined> {
  try {
    await work();
    return undefined;
  } catch (error) {
    return (error as { cause?: { code?: string; message?: string; constraint_name?: string } }).cause
      ?? (error as { code?: string; message?: string; constraint_name?: string });
  }
}

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

async function seedFixture() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: orgA.id });
  const sfx = randomUUID().slice(0, 8);
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: orgA.id,
      siteId: siteA.id,
      agentId: `diag-${randomUUID()}`,
      hostname: `diag-win-${sfx}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'amd64',
      agentVersion: '0.99.0',
      status: 'online',
    })
    .returning();

  const requester = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `diag-req-${sfx}@test.local` });
  const approverRole = await createRole({ scope: 'organization', orgId: orgA.id, partnerId: partner.id });
  await grantRolePermissions(approverRole.id, [
    { resource: 'devices', action: 'execute' },
    { resource: 'approvals', action: 'decide' },
  ]);
  const approver1 = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `diag-appr1-${sfx}@test.local` });
  const approver2 = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `diag-appr2-${sfx}@test.local` });
  await assignUserToOrganization(approver1.id, orgA.id, approverRole.id);
  await assignUserToOrganization(approver2.id, orgA.id, approverRole.id);

  return { partner, orgA, orgB, siteA, device: device!, requester, approver1, approver2, approverRole };
}

/** Same AuthContext shape authMiddleware produces for an org-scoped user session. */
function userAuth(f: Fixture, user: { id: string; email: string }): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([f.orgA.id]);
  return {
    principal: { kind: 'user_session' },
    user: { id: user.id, email: user.email, name: 'Tech', isPlatformAdmin: false },
    token: {
      sub: user.id,
      email: user.email,
      roleId: randomUUID(),
      orgId: f.orgA.id,
      partnerId: f.partner.id,
      scope: 'organization',
      type: 'access',
      mfa: true,
    },
    partnerId: f.partner.id,
    orgId: f.orgA.id,
    scope: 'organization',
    accessibleOrgIds: [f.orgA.id],
    orgCondition,
    canAccessOrg,
  } as AuthContext;
}

/** Valid pending grant values; tests override single fields to hit one CHECK. */
function grantValues(f: Fixture, overrides: Partial<typeof diagnosticAccessGrants.$inferInsert> = {}) {
  return {
    orgId: f.orgA.id,
    deviceId: f.device.id,
    status: 'pending_approval' as const,
    requestedByUserId: f.requester.id,
    beneficiaryKind: 'user' as const,
    beneficiaryId: f.requester.id,
    source: 'chat',
    requestExpiresAt: new Date(Date.now() + 60 * 60_000),
    purpose: 'Battle.net launcher crash logs',
    operations: ['list', 'read'],
    scopes: [{ path: SCOPE_ROOT, recursive: true }],
    sensitiveClasses: [] as string[],
    durationMinutes: 60,
    ...overrides,
  };
}

async function insertGrant(f: Fixture, overrides: Partial<typeof diagnosticAccessGrants.$inferInsert> = {}) {
  const [row] = await getTestDb().insert(diagnosticAccessGrants).values(grantValues(f, overrides)).returning();
  return row!;
}

async function insertApproval(userId: string, grantId: string) {
  const [row] = await getTestDb()
    .insert(approvalRequests)
    .values({
      userId,
      diagnosticAccessGrantId: grantId,
      requestingClientLabel: 'Breeze AI',
      actionLabel: 'Read-only diagnostic access',
      actionToolName: 'request_diagnostic_access',
      riskTier: 'high',
      riskSummary: 'diagnostic access',
      status: 'pending',
      expiresAt: new Date(Date.now() + 60 * 60_000),
    })
    .returning();
  return row!;
}

async function readGrant(id: string) {
  const [row] = await getTestDb().select().from(diagnosticAccessGrants).where(eq(diagnosticAccessGrants.id, id));
  return row!;
}

async function readApproval(id: string) {
  const [row] = await getTestDb().select().from(approvalRequests).where(eq(approvalRequests.id, id));
  return row!;
}

describe('diagnostic access grants: RLS', () => {
  runDb('app pool is non-bypass breeze_app and the table forces RLS', async () => {
    const role = (await withSystemDbAccessContext(() =>
      db.execute(sql`SELECT current_user AS who, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`),
    )) as unknown as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }>;
    expect(role[0]).toMatchObject({ who: 'breeze_app', rolsuper: false, rolbypassrls: false });

    const rel = (await getTestDb().execute(sql`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'diagnostic_access_grants'
    `)) as unknown as Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    expect(rel[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  runDb('an org-A grant is invisible to org B and a forged org-A insert from org B fails with 42501', async () => {
    const f = await seedFixture();
    const grant = await insertGrant(f);

    // Positive control: the owning org sees it.
    const own = await withDbAccessContext(orgContext(f.orgA.id), () =>
      db.select({ id: diagnosticAccessGrants.id }).from(diagnosticAccessGrants).where(eq(diagnosticAccessGrants.id, grant.id)),
    );
    expect(own).toHaveLength(1);

    const hidden = await withDbAccessContext(orgContext(f.orgB.id), () =>
      db.select({ id: diagnosticAccessGrants.id }).from(diagnosticAccessGrants).where(eq(diagnosticAccessGrants.id, grant.id)),
    );
    expect(hidden).toHaveLength(0);

    const forged = await causeOf(() =>
      withDbAccessContext(orgContext(f.orgB.id), () => db.insert(diagnosticAccessGrants).values(grantValues(f))),
    );
    expect(forged?.code).toBe('42501');
    expect(forged?.message).toMatch(/row-level security/);
  });
});

describe('diagnostic access grants: CHECK constraints', () => {
  const expectCheck = async (work: () => Promise<unknown>, constraint: string) => {
    const err = await causeOf(work);
    expect(err?.code).toBe('23514');
    expect(err?.constraint_name).toBe(constraint);
  };

  runDb('active without approved_at/approved_by is rejected', async () => {
    const f = await seedFixture();
    await expectCheck(() => insertGrant(f, { status: 'active' }), 'diagnostic_access_grants_approval_chk');
  });

  runDb('expires_at beyond approved_at + duration_minutes is rejected', async () => {
    const f = await seedFixture();
    const approvedAt = new Date();
    await expectCheck(
      () =>
        insertGrant(f, {
          status: 'active',
          approvedAt,
          approvedByUserId: f.approver1.id,
          durationMinutes: 60,
          expiresAt: new Date(approvedAt.getTime() + 61 * 60_000),
        }),
      'diagnostic_access_grants_approval_chk',
    );
  });

  runDb('operations containing write is rejected', async () => {
    const f = await seedFixture();
    await expectCheck(() => insertGrant(f, { operations: ['read', 'write'] }), 'diagnostic_access_grants_operations_chk');
  });

  runDb('an unknown sensitive class is rejected', async () => {
    const f = await seedFixture();
    await expectCheck(
      () => insertGrant(f, { sensitiveClasses: ['everything'] }),
      'diagnostic_access_grants_classes_chk',
    );
  });

  runDb("beneficiary_kind 'user' must equal requested_by_user_id", async () => {
    const f = await seedFixture();
    await expectCheck(
      () => insertGrant(f, { beneficiaryKind: 'user', beneficiaryId: f.approver1.id }),
      'diagnostic_access_grants_beneficiary_chk',
    );
  });

  runDb('a grant whose device belongs to a different organization is rejected', async () => {
    const f = await seedFixture();
    // The device lives in org A; the row claims org B. The composite
    // (device_id, org_id) FK refuses the pair at commit.
    const err = await causeOf(() =>
      withSystemDbAccessContext(() =>
        db.transaction(async (tx) => {
          await tx.insert(diagnosticAccessGrants).values(grantValues(f, { orgId: f.orgB.id }));
        }),
      ),
    );
    expect(err?.code).toBe('23503');
    expect(err?.constraint_name).toBe('diagnostic_access_grants_device_org_fk');
  });

  runDb('approval_requests linked to a grant AND another source is rejected by one_source', async () => {
    const f = await seedFixture();
    const grant = await insertGrant(f);
    // CHECK constraints run before the FK triggers, so an unreferenced
    // execution_id still reaches the one_source check first.
    await expectCheck(
      () =>
        getTestDb().insert(approvalRequests).values({
          userId: f.approver1.id,
          diagnosticAccessGrantId: grant.id,
          executionId: randomUUID(),
          requestingClientLabel: 'Breeze AI',
          actionLabel: 'two sources',
          actionToolName: 'request_diagnostic_access',
          riskTier: 'high',
          riskSummary: 'two sources',
          expiresAt: new Date(Date.now() + 60 * 60_000),
        }),
      'approval_requests_one_source_chk',
    );
  });
});

describe('diagnostic access grants: lifecycle through the service functions', () => {
  runDb('request -> approve -> covered / out_of_scope -> revoke -> grant_revoked', async () => {
    const f = await seedFixture();
    const auth = userAuth(f, f.requester);

    const created = await createDiagnosticAccessRequest(auth, f.device, {
      deviceId: f.device.id,
      paths: [{ path: SCOPE_ROOT, recursive: true }],
      operations: ['list', 'read'],
      purpose: 'Battle.net launcher crash logs',
      durationMinutes: 60,
    });
    expect(created.reused).toBe(false);
    expect(created.grant.status).toBe('pending_approval');
    expect(created.grant.beneficiaryKind).toBe('user');
    expect(created.grant.beneficiaryId).toBe(f.requester.id);
    expect(new Set(created.approvals.map((a) => a.userId))).toEqual(new Set([f.approver1.id, f.approver2.id]));

    // Pending grants authorize nothing.
    const pending = await findCoveringGrant(auth, f.device, IN_SCOPE, 'read');
    expect(pending).toMatchObject({ ok: false, reason: 'grant_pending' });

    // Approver 1 wins the approval row CAS and activates the grant in the same tx.
    const winner = created.approvals.find((a) => a.userId === f.approver1.id)!;
    const loser = created.approvals.find((a) => a.userId === f.approver2.id)!;
    const now = new Date();
    const decided = await withSystemDbAccessContext(() =>
      db.transaction(async (tx) => {
        await tx
          .update(approvalRequests)
          .set({ status: 'approved', decidedAt: now })
          .where(eq(approvalRequests.id, winner.id));
        return decideDiagnosticGrantInTx(tx as unknown as typeof db, {
          grantId: created.grant.id,
          approvalRequestId: winner.id,
          deciderUserId: f.approver1.id,
          status: 'approved',
          reason: null,
          decidedAssuranceLevel: 2,
          decidedVia: 'web',
          now,
        });
      }),
    );
    expect(decided?.status).toBe('active');
    expect(decided?.approvedByUserId).toBe(f.approver1.id);
    expect(decided?.expiresAt?.getTime()).toBe(now.getTime() + 60 * 60_000);
    expect((await readApproval(winner.id)).status).toBe('approved');
    expect((await readApproval(loser.id)).status).toBe('expired');

    // A second decision on the same grant activates nothing.
    const again = await withSystemDbAccessContext(() =>
      db.transaction((tx) =>
        decideDiagnosticGrantInTx(tx as unknown as typeof db, {
          grantId: created.grant.id,
          approvalRequestId: loser.id,
          deciderUserId: f.approver2.id,
          status: 'denied',
          reason: 'late',
          decidedAssuranceLevel: null,
          decidedVia: null,
          now: new Date(),
        }),
      ),
    );
    expect(again).toBeNull();

    const covered = await findCoveringGrant(auth, f.device, IN_SCOPE, 'read');
    expect(covered.ok).toBe(true);
    const outside = await findCoveringGrant(auth, f.device, OUT_OF_SCOPE, 'read');
    expect(outside).toMatchObject({ ok: false, reason: 'out_of_scope' });

    // Another principal (approver 2, who holds no grant) is never covered.
    const other = await findCoveringGrant(userAuth(f, f.approver2), f.device, IN_SCOPE, 'read');
    expect(other).toMatchObject({ ok: false, reason: 'no_grant' });

    const revoked = await revokeDiagnosticGrant(auth, created.grant.id, 'done');
    expect(revoked.ok).toBe(true);
    const row = await readGrant(created.grant.id);
    expect(row.status).toBe('revoked');
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokedByUserId).toBe(f.requester.id);
    expect(row.revokeReason).toBe('done');

    const afterRevoke = await findCoveringGrant(auth, f.device, IN_SCOPE, 'read');
    expect(afterRevoke).toMatchObject({ ok: false, reason: 'grant_revoked' });
  });

  runDb('an active grant past expires_at reports grant_expired and is flipped to expired', async () => {
    const f = await seedFixture();
    const approvedAt = new Date(Date.now() - 60 * 60_000);
    const grant = await insertGrant(f, {
      status: 'active',
      approvedAt,
      approvedByUserId: f.approver1.id,
      durationMinutes: 30,
      expiresAt: new Date(approvedAt.getTime() + 30 * 60_000),
    });

    const res = await findCoveringGrant(userAuth(f, f.requester), f.device, IN_SCOPE, 'read');
    expect(res).toMatchObject({ ok: false, reason: 'grant_expired' });
    expect((await readGrant(grant.id)).status).toBe('expired');
  });

  runDb('listing lapses a pending request past its TTL and retires its approval cards', async () => {
    const f = await seedFixture();
    const pending = await insertGrant(f, { requestExpiresAt: new Date(Date.now() - 60_000) });
    const card = await insertApproval(f.approver1.id, pending.id);

    const listed = await listDiagnosticGrants(userAuth(f, f.requester), { limit: 50 });
    expect(listed.map((g) => g.id)).not.toContain(pending.id);
    expect((await readGrant(pending.id)).status).toBe('expired');
    expect((await readApproval(card.id)).status).toBe('expired');
  });
});

describe('diagnostic access grants: request reuse', () => {
  runDb('reuses only an identical pending ask or an active grant that covers the requested duration', async () => {
    const f = await seedFixture();
    const auth = userAuth(f, f.requester);
    const ask = (purpose: string, durationMinutes: number) =>
      createDiagnosticAccessRequest(auth, f.device, {
        deviceId: f.device.id,
        paths: [{ path: SCOPE_ROOT, recursive: true }],
        operations: ['list', 'read'],
        purpose,
        durationMinutes,
      });

    const first = await ask('launcher crash logs', 30);
    expect((await ask('launcher crash logs', 30)).reused).toBe(true);
    // Different purpose or duration is a different decision.
    const otherPurpose = await ask('suspected compromise', 30);
    expect(otherPurpose.reused).toBe(false);
    expect(otherPurpose.grant.id).not.toBe(first.grant.id);
    expect((await ask('launcher crash logs', 240)).reused).toBe(false);

    // An active grant with 20 minutes left covers a 15-minute ask, not a 60-minute one.
    const approvedAt = new Date();
    const active = await insertGrant(f, {
      status: 'active',
      approvedAt,
      approvedByUserId: f.approver1.id,
      durationMinutes: 20,
      expiresAt: new Date(approvedAt.getTime() + 20 * 60_000),
    });
    // The active grant's purpose is what was approved (grantValues default).
    const short = await ask(active.purpose, 15);
    expect(short.reused).toBe(true);
    expect(short.grant.id).toBe(active.id);
    expect((await ask(active.purpose, 60)).reused).toBe(false);
    // Same scope and time, different purpose: a new review.
    expect((await ask('collect employee activity', 15)).reused).toBe(false);
  });
});

/** Make `userId` an eligible diagnostic approver in orgA. */
async function makeApprover(f: Fixture, userId: string) {
  await assignUserToOrganization(userId, f.orgA.id, f.approverRole.id);
}

describe('diagnostic access grants: requester never approves their own request', () => {
  const ask = (f: Fixture) =>
    createDiagnosticAccessRequest(userAuth(f, f.requester), f.device, {
      deviceId: f.device.id,
      paths: [{ path: SCOPE_ROOT, recursive: true }],
      operations: ['list', 'read'],
      purpose: 'Battle.net launcher crash logs',
      durationMinutes: 60,
    });

  runDb('an eligible requester is left out of the fan-out while other approvers exist', async () => {
    const f = await seedFixture();
    await makeApprover(f, f.requester.id);

    // The requester really is an eligible approver; only the exclusion keeps them out.
    expect(await resolveEligibleApprovers(f.device, f.partner.id)).toContain(f.requester.id);

    const created = await ask(f);

    expect(new Set(created.approvals.map((a) => a.userId))).toEqual(new Set([f.approver1.id, f.approver2.id]));
    const rows = await getTestDb()
      .select({ riskTier: approvalRequests.riskTier })
      .from(approvalRequests)
      .where(eq(approvalRequests.diagnosticAccessGrantId, created.grant.id));
    expect(rows.map((r) => r.riskTier)).toEqual(['high', 'high']);
  });

  runDb('a sole operator gets the single approval row, at critical', async () => {
    const f = await seedFixture();
    await makeApprover(f, f.requester.id);
    await getTestDb().delete(organizationUsers).where(eq(organizationUsers.userId, f.approver1.id));
    await getTestDb().delete(organizationUsers).where(eq(organizationUsers.userId, f.approver2.id));

    const created = await ask(f);

    expect(created.approvals.map((a) => a.userId)).toEqual([f.requester.id]);
    const [row] = await getTestDb()
      .select({ riskTier: approvalRequests.riskTier })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, created.approvals[0]!.id));
    expect(row?.riskTier).toBe('critical');
  });
});

describe('diagnostic access grants: deletion', () => {
  runDb('deleting a grant expires its pending approvals and keeps decided ones, unlinked', async () => {
    const f = await seedFixture();
    const grant = await insertGrant(f);
    const pending = await insertApproval(f.approver1.id, grant.id);
    const decided = await insertApproval(f.approver2.id, grant.id);
    await getTestDb().update(approvalRequests).set({ status: 'denied', decidedAt: new Date() }).where(eq(approvalRequests.id, decided.id));

    // As the application role in an org-scoped context (RLS applies), the way
    // the device-delete cascade runs: the trigger must still reach approval
    // rows owned by other users.
    await withDbAccessContext(orgContext(f.orgA.id), () =>
      db.delete(diagnosticAccessGrants).where(eq(diagnosticAccessGrants.id, grant.id)),
    );

    const p = await readApproval(pending.id);
    expect(p?.status).toBe('expired');
    expect(p?.diagnosticAccessGrantId).toBeNull();
    const d = await readApproval(decided.id);
    expect(d?.status).toBe('denied');
    expect(d?.diagnosticAccessGrantId).toBeNull();
  });
});

describe('diagnostic access grants: device org move', () => {
  runDb('revokeDiagnosticGrantsForMove expires pending (and its approvals) and revokes active', async () => {
    const f = await seedFixture();
    const pending = await insertGrant(f);
    const pendingApproval = await insertApproval(f.approver1.id, pending.id);
    const approvedAt = new Date();
    const active = await insertGrant(f, {
      status: 'active',
      approvedAt,
      approvedByUserId: f.approver1.id,
      durationMinutes: 60,
      expiresAt: new Date(approvedAt.getTime() + 60 * 60_000),
    });
    const mover = f.approver2;

    await withSystemDbAccessContext(() =>
      db.transaction((tx) => revokeDiagnosticGrantsForMove(tx, f.orgA.id, f.device.id, mover.id)),
    );

    const p = await readGrant(pending.id);
    expect(p.status).toBe('expired');
    const a = await readGrant(active.id);
    expect(a.status).toBe('revoked');
    expect(a.revokedAt).not.toBeNull();
    expect(a.revokedByUserId).toBe(mover.id);
    expect(a.revokeReason).toBe('device moved to another organization');
    // Approval rows are per-approver under RLS, so they expire post-commit in
    // system scope (moveOrg.ts calls this after the move transaction).
    expect((await readApproval(pendingApproval.id)).status).toBe('pending');
    await expireDiagnosticApprovalsForMovedDevice(f.device.id);
    const ap = await readApproval(pendingApproval.id);
    expect(ap.status).toBe('expired');
    expect(ap.decidedAt).not.toBeNull();
  });

  runDb('any org_id change kills a live grant in the same statement (restamp backstop)', async () => {
    const f = await seedFixture();
    const approvedAt = new Date();
    const active = await insertGrant(f, {
      status: 'active',
      approvedAt,
      approvedByUserId: f.approver1.id,
      expiresAt: new Date(approvedAt.getTime() + 30 * 60_000),
      durationMinutes: 30,
    });
    const pending = await insertGrant(f);
    const card = await insertApproval(f.approver1.id, pending.id);
    // A raw devices.org_id change that never went through the move route:
    // breeze_cascade_device_org_id() restamps the grants, and the fence
    // trigger fires on that restamp.
    const siteB = await createSite({ orgId: f.orgB.id });
    await getTestDb().execute(
      sql`UPDATE devices SET org_id = ${f.orgB.id}::uuid, site_id = ${siteB.id}::uuid WHERE id = ${f.device.id}::uuid`,
    );
    const a = await readGrant(active.id);
    expect(a.orgId).toBe(f.orgB.id);
    expect(a.status).toBe('revoked');
    expect(a.revokedAt).not.toBeNull();
    expect((await readGrant(pending.id)).status).toBe('expired');
    // Its approval card no longer offers a decision.
    expect((await readApproval(card.id)).status).toBe('expired');
  });
});
