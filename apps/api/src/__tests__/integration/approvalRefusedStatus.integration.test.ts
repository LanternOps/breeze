/**
 * Real-Postgres proof that an approve the server refuses is stored on the
 * approval row as not approved.
 *
 * A PAM elevation approve from the approvals inbox is refused inside the
 * decide transaction when the target's identity cannot be verified (no file
 * hash, createPamDecisionIntent): the elevation request is denied. The
 * approval row the approver decided must say so too, because the mobile app
 * and the inbox's Recent panel read the row's `status`:
 *
 *   - the row is `denied` with `refusal_reason`, and still records the
 *     approver's approve (decided_at, decided_via, decided_assurance_level);
 *   - the decide response's `approval` and the Recent listing report it;
 *   - a normal approve (hash present) stays `approved`;
 *   - `approval_requests_refusal_reason_status_chk` refuses a refusal reason
 *     on any row that is not denied;
 *   - the migration's backfill corrects a row refused before this change
 *     (running as breeze_app, so only through its own system-scope
 *     election), and leaves every other row alone.
 *
 * Drives the real route (real JWT + authMiddleware + breeze_app RLS), whose
 * decide write runs in one system-scoped transaction.
 */
import './setup';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'crypto';
import postgres from 'postgres';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db, withSystemDbAccessContext } from '../../db';
import { approvalRequests } from '../../db/schema/approvals';
import { elevationAudit, elevationRequests } from '../../db/schema/elevations';
import { devices } from '../../db/schema';
import { PERMISSIONS } from '../../services/permissions';
import { PAM_TARGET_HASH_UNVERIFIED_REASON } from '../../services/pamActuationLifecycle';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { approvalRoutes } from '../../routes/approvals';

const RUN = !!process.env.DATABASE_URL;
const MIGRATION = '2026-11-10-130000-approval-requests-refusal-reason.sql';
const migrationSql = readFileSync(join(__dirname, '../../../migrations', MIGRATION), 'utf8');
const adminSql = postgres(process.env.DATABASE_URL ?? '', { max: 1 });
afterAll(async () => { await adminSql.end({ timeout: 5 }); });

const VALID_HASH = 'a'.repeat(64);

interface Scenario {
  partnerId: string;
  orgId: string;
  siteId: string;
  deviceId: string;
  approver: { id: string; email: string };
  roleId: string;
}

async function seedScenario(): Promise<Scenario> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const role = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(role.id, [PERMISSIONS.PAM_APPROVE]);
  const approver = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `approver-${randomUUID()}@approvalrefused.test`,
  });
  await assignUserToOrganization(approver.id, org.id, role.id);
  const [device] = await withSystemDbAccessContext(() =>
    db
      .insert(devices)
      .values({
        orgId: org.id,
        siteId: site.id,
        agentId: `agent-refused-${randomUUID()}`,
        hostname: `ws-refused-${randomUUID().slice(0, 8)}`,
        osType: 'windows',
        osVersion: '10.0',
        architecture: 'amd64',
        agentVersion: '1.0.0',
        status: 'online',
      })
      .returning({ id: devices.id }),
  );
  return {
    partnerId: partner.id,
    orgId: org.id,
    siteId: site.id,
    deviceId: device!.id,
    approver: { id: approver.id, email: approver.email },
    roleId: role.id,
  };
}

/** A pending uac_intercept elevation fanned out to the approver as one pending approval row. */
async function seedPendingElevationApproval(
  s: Scenario,
  targetExecutableHash: string | null,
): Promise<{ elevationId: string; approvalId: string }> {
  return withSystemDbAccessContext(async () => {
    const [elev] = await db
      .insert(elevationRequests)
      .values({
        orgId: s.orgId,
        siteId: s.siteId,
        partnerId: s.partnerId,
        deviceId: s.deviceId,
        flowType: 'uac_intercept',
        subjectUsername: 'REFUSED\\enduser',
        reason: 'install setup.exe',
        targetExecutablePath: 'C:\\Temp\\setup.exe',
        targetExecutableHash,
        status: 'pending',
      })
      .returning({ id: elevationRequests.id });
    const [approval] = await db
      .insert(approvalRequests)
      .values({
        userId: s.approver.id,
        requestingClientLabel: 'Breeze Agent',
        actionLabel: 'Elevate setup.exe',
        actionToolName: 'uac_intercept',
        // Low tier: a session tap (L1) meets the floor, so the approve needs
        // no ceremony and reaches the decide write.
        riskTier: 'low',
        riskSummary: 'admin requested',
        status: 'pending',
        expiresAt: new Date(Date.now() + 5 * 60_000),
        elevationRequestId: elev!.id,
      })
      .returning({ id: approvalRequests.id });
    return { elevationId: elev!.id, approvalId: approval!.id };
  });
}

async function approverApp(s: Scenario): Promise<{ app: Hono; token: string }> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: s.approver.id,
    email: s.approver.email,
    roleId: s.roleId,
    orgId: s.orgId,
    partnerId: s.partnerId,
    scope: 'organization',
    mfa: false,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  const token = await createAccessToken(payload);
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  return { app, token };
}

async function approve(s: Scenario, approvalId: string): Promise<Response> {
  const { app, token } = await approverApp(s);
  return app.request(`/approvals/${approvalId}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

async function readApprovalRow(approvalId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(approvalRequests).where(eq(approvalRequests.id, approvalId)),
  );
  return row!;
}

let s: Scenario;

beforeEach(async () => {
  s = await seedScenario();
});

describe.skipIf(!RUN)('a refused elevation approve is stored as not approved', () => {
  it('stores the row as denied with the refusal reason, keeping the approver\'s approve on it', async () => {
    const { elevationId, approvalId } = await seedPendingElevationApproval(s, null);

    const res = await approve(s, approvalId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enforcementStatus).toBe('refused');
    expect(body.approval).toMatchObject({
      id: approvalId,
      status: 'denied',
      refusalReason: PAM_TARGET_HASH_UNVERIFIED_REASON,
      decisionReason: null,
    });

    const row = await readApprovalRow(approvalId);
    expect(row).toMatchObject({
      status: 'denied',
      refusalReason: PAM_TARGET_HASH_UNVERIFIED_REASON,
      // The approver's approve: who (the row's own user), when, and how.
      userId: s.approver.id,
      decidedVia: 'session_tap',
      decidedAssuranceLevel: 1,
      decisionReason: null,
    });
    expect(row.decidedAt).toBeInstanceOf(Date);

    const [elevation] = await withSystemDbAccessContext(() =>
      db.select().from(elevationRequests).where(eq(elevationRequests.id, elevationId)),
    );
    expect(elevation).toMatchObject({
      status: 'denied',
      denialReason: PAM_TARGET_HASH_UNVERIFIED_REASON,
      approvedByUserId: s.approver.id,
    });
    const audit = await withSystemDbAccessContext(() =>
      db
        .select({ eventType: elevationAudit.eventType, actor: elevationAudit.actor, actorUserId: elevationAudit.actorUserId })
        .from(elevationAudit)
        .where(eq(elevationAudit.elevationRequestId, elevationId)),
    );
    expect(audit).toEqual(expect.arrayContaining([
      { eventType: 'approved', actor: 'technician', actorUserId: s.approver.id },
      { eventType: 'denied', actor: 'system', actorUserId: null },
    ]));
  });

  it('shows the refused approve in Recent as denied, with the refusal reason', async () => {
    const { approvalId } = await seedPendingElevationApproval(s, null);
    expect((await approve(s, approvalId)).status).toBe(200);

    const { app, token } = await approverApp(s);
    const res = await app.request('/approvals/pending?view=recent', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const recent = (body.approvals as Array<Record<string, unknown>>).find((a) => a.id === approvalId);
    expect(recent).toMatchObject({
      status: 'denied',
      refusalReason: PAM_TARGET_HASH_UNVERIFIED_REASON,
      intentOutcome: { status: 'denied', reason: PAM_TARGET_HASH_UNVERIFIED_REASON },
    });
  });

  it('control: an approve with a verifiable target stays approved with no refusal reason', async () => {
    const { approvalId } = await seedPendingElevationApproval(s, VALID_HASH);

    const res = await approve(s, approvalId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enforcementStatus).toBe('pending_dispatch');
    expect(body.approval).toMatchObject({ status: 'approved', refusalReason: null });

    const row = await readApprovalRow(approvalId);
    expect(row).toMatchObject({ status: 'approved', refusalReason: null });
  });

  it('refuses a refusal reason on a row that is not denied', async () => {
    const { approvalId } = await seedPendingElevationApproval(s, VALID_HASH);
    expect((await approve(s, approvalId)).status).toBe(200);

    await expect(
      withSystemDbAccessContext(() =>
        db
          .update(approvalRequests)
          .set({ refusalReason: 'x' })
          .where(and(eq(approvalRequests.id, approvalId), eq(approvalRequests.status, 'approved'))),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });
});

describe.skipIf(!RUN)('refusal_reason migration backfill', () => {
  it('stores a row refused before the change as denied, and leaves other rows alone', async () => {
    // Every row is decided through the real route, so the elevation side is
    // exactly what each path writes.
    const refused = await seedPendingElevationApproval(s, null);
    expect((await approve(s, refused.approvalId)).status).toBe(200);
    // Put the refused row back the way the decide path left it before this
    // change: still approved, with no refusal reason.
    await withSystemDbAccessContext(() =>
      db
        .update(approvalRequests)
        .set({ status: 'approved', refusalReason: null })
        .where(eq(approvalRequests.id, refused.approvalId)),
    );
    expect(await readApprovalRow(refused.approvalId)).toMatchObject({ status: 'approved', refusalReason: null });

    // A normal approve that took effect.
    const approved = await seedPendingElevationApproval(s, VALID_HASH);
    expect((await approve(s, approved.approvalId)).status).toBe(200);
    // The approver's own denial.
    const denied = await seedPendingElevationApproval(s, VALID_HASH);
    const { app, token } = await approverApp(s);
    const denyRes = await app.request(`/approvals/${denied.approvalId}/deny`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'not today' }),
    });
    expect(denyRes.status).toBe(200);

    // The backfill block runs as `breeze_app` (not a superuser, subject to
    // FORCE RLS) under the migration runner's default scope, so it can only
    // see the rows because it elects system scope itself.
    const backfillBlock = migrationSql.slice(
      migrationSql.indexOf('DO $$'),
      migrationSql.indexOf('END $$;') + 'END $$;'.length,
    );
    expect(backfillBlock).toContain('UPDATE approval_requests');
    await adminSql.begin(async (tx) => {
      await tx.unsafe('SET LOCAL ROLE breeze_app');
      await tx.unsafe(`SELECT set_config('breeze.scope', 'none', true)`);
      await tx.unsafe(backfillBlock);
    });

    expect(await readApprovalRow(refused.approvalId)).toMatchObject({
      status: 'denied',
      refusalReason: PAM_TARGET_HASH_UNVERIFIED_REASON,
    });
    expect(await readApprovalRow(approved.approvalId)).toMatchObject({ status: 'approved', refusalReason: null });
    expect(await readApprovalRow(denied.approvalId)).toMatchObject({
      status: 'denied',
      refusalReason: null,
      decisionReason: 'not today',
    });

    // Re-running the whole file is a no-op.
    await adminSql.unsafe(migrationSql);
    expect(await readApprovalRow(refused.approvalId)).toMatchObject({
      status: 'denied',
      refusalReason: PAM_TARGET_HASH_UNVERIFIED_REASON,
    });
    expect(await readApprovalRow(approved.approvalId)).toMatchObject({ status: 'approved', refusalReason: null });
  });
});
