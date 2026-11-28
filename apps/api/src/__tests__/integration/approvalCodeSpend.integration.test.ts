/**
 * Real Postgres + Redis: an authenticator code sent with an approve is checked
 * only when the approve could go ahead. A request the decide core would refuse
 * on the row alone (not found, already decided, expired) answers exactly as it
 * does without a code, leaves the code usable and adds nothing to the
 * per-user code-check limit. A valid approve uses exactly one code.
 *
 * Driven through the real route (real JWT, authMiddleware, breeze_app RLS, the
 * real code check) with a PAM elevation row, where an approve needs a second
 * factor and the session here has none, so the code is what satisfies it.
 */
import './setup';
import { getTestRedis } from './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { generate, generateSecret } from 'otplib';
import { db, withSystemDbAccessContext } from '../../db';
import { approvalRequests } from '../../db/schema/approvals';
import { elevationRequests } from '../../db/schema/elevations';
import { devices, users } from '../../db/schema';
import { PERMISSIONS } from '../../services/permissions';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { currentOwnershipEpochSql } from '../../services/deviceOwnershipEpoch';
import { encryptMfaSecret } from '../../routes/auth/helpers';
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

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Fixture {
  partnerId: string;
  orgId: string;
  siteId: string;
  deviceId: string;
  roleId: string;
  technicianId: string;
  approver: { id: string; email: string };
  secret: string;
}

async function seed(): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const role = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(role.id, [
    PERMISSIONS.APPROVALS_DECIDE,
    PERMISSIONS.PAM_APPROVE,
    PERMISSIONS.DEVICES_EXECUTE,
  ]);

  const technician = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `tech-${randomUUID()}@codespend.test`,
  });
  await assignUserToOrganization(technician.id, org.id, role.id);

  const approver = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `approver-${randomUUID()}@codespend.test`,
    mfaEnabled: true,
  });
  await assignUserToOrganization(approver.id, org.id, role.id);
  const secret = generateSecret();
  await withSystemDbAccessContext(() =>
    db
      .update(users)
      .set({ mfaEnabled: true, mfaMethod: 'totp', mfaSecret: encryptMfaSecret(secret) })
      .where(eq(users.id, approver.id)),
  );

  const [device] = await withSystemDbAccessContext(() =>
    db
      .insert(devices)
      .values({
        orgId: org.id,
        siteId: site.id,
        agentId: `agent-codespend-${randomUUID()}`,
        hostname: `host-codespend-${randomUUID().slice(0, 8)}`,
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
    roleId: role.id,
    technicianId: technician.id,
    approver: { id: approver.id, email: approver.email },
    secret,
  };
}

/** A just-in-time elevation raised for the technician, with an approval row for the approver. */
async function seedRow(
  f: Fixture,
  row: { status?: 'pending' | 'approved' | 'denied'; expiresAt?: Date } = {},
): Promise<{ approvalId: string; elevationId: string }> {
  return withSystemDbAccessContext(async () => {
    const [elev] = await db
      .insert(elevationRequests)
      .values({
        orgId: f.orgId,
        siteId: f.siteId,
        partnerId: f.partnerId,
        deviceId: f.deviceId,
        deviceEpoch: currentOwnershipEpochSql(f.deviceId),
        flowType: 'tech_jit_admin',
        subjectUserId: f.technicianId,
        subjectUsername: 'DESK\\technician',
        reason: 'code spend coverage',
        targetExecutablePath: 'C:\\Temp\\setup.exe',
        targetExecutableHash: 'a'.repeat(64),
        riskTier: 1,
        status: 'pending',
      })
      .returning({ id: elevationRequests.id });
    const [appr] = await db
      .insert(approvalRequests)
      .values({
        userId: f.approver.id,
        requestingClientLabel: 'Breeze Agent',
        actionLabel: 'Elevate setup.exe',
        actionToolName: 'tech_jit_admin',
        riskTier: 'low',
        riskSummary: 'admin requested',
        status: row.status ?? 'pending',
        expiresAt: row.expiresAt ?? new Date(Date.now() + 5 * 60_000),
        elevationRequestId: elev!.id,
      })
      .returning({ id: approvalRequests.id });
    return { approvalId: appr!.id, elevationId: elev!.id };
  });
}

async function approve(f: Fixture, approvalId: string, body: Record<string, unknown>): Promise<Response> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: f.approver.id,
    email: f.approver.email,
    roleId: f.roleId,
    orgId: f.orgId,
    partnerId: f.partnerId,
    scope: 'organization',
    // No second factor on the session: the code is what satisfies the rule.
    mfa: false,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  return app.request(`/approvals/${approvalId}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await createAccessToken(payload)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Every Redis key the code check writes for this user: its attempt limit and its used-code record. */
async function codeCheckKeys(userId: string): Promise<string[]> {
  const keys = await getTestRedis().keys(`*${userId}*`);
  return keys.filter((k) => k.includes('reauth-mfa') || k.includes('mfa:usedstep'));
}

async function approvalStatus(approvalId: string): Promise<string | undefined> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalId));
    return row?.status;
  });
}

let f: Fixture;

beforeEach(async () => {
  f = await seed();
});

describe('an approve that would be refused on its row spends no authenticator code', () => {
  const refusals: Array<{
    name: string;
    target: (f: Fixture) => Promise<string>;
    status: number;
    body: (f: Fixture) => Record<string, unknown>;
  }> = [
    {
      name: 'a request that does not exist',
      target: async () => randomUUID(),
      status: 404,
      body: () => ({ error: 'Not found' }),
    },
    {
      name: 'a request already decided',
      target: async (fx) => (await seedRow(fx, { status: 'approved' })).approvalId,
      status: 409,
      body: () => ({ error: 'Already approved', finalStatus: 'approved' }),
    },
    {
      name: 'a request that has expired',
      target: async (fx) => (await seedRow(fx, { expiresAt: new Date(Date.now() - 60_000) })).approvalId,
      status: 410,
      body: () => ({ error: 'Expired', finalStatus: 'expired' }),
    },
  ];

  for (const r of refusals) {
    runDb(`${r.name}: same answer as without a code, code still usable, limit untouched`, async () => {
      const target = await r.target(f);
      const code = await generate({ secret: f.secret });

      const without = await approve(f, target, {});
      expect(without.status).toBe(r.status);
      expect(await without.json()).toEqual(r.body(f));

      const withCode = await approve(f, target, { reauthMfaCode: code });
      expect(withCode.status).toBe(r.status);
      expect(await withCode.json()).toEqual(r.body(f));
      expect(await codeCheckKeys(f.approver.id)).toEqual([]);

      // The same code still approves a request it can be used for.
      const { approvalId } = await seedRow(f);
      const res = await approve(f, approvalId, { reauthMfaCode: code });
      expect(res.status).toBe(200);
      expect(await approvalStatus(approvalId)).toBe('approved');
    });
  }

  runDb('a wrong code on a request that does not exist answers 404 and counts no attempt', async () => {
    const res = await approve(f, randomUUID(), { reauthMfaCode: '000000' });
    expect(res.status).toBe(404);
    expect(await codeCheckKeys(f.approver.id)).toEqual([]);
  });

  runDb('a valid approve uses exactly one code: the same code cannot approve a second request', async () => {
    const code = await generate({ secret: f.secret });
    const first = await seedRow(f);
    const second = await seedRow(f);

    const ok = await approve(f, first.approvalId, { reauthMfaCode: code });
    expect(ok.status).toBe(200);
    expect(await approvalStatus(first.approvalId)).toBe('approved');

    const replay = await approve(f, second.approvalId, { reauthMfaCode: code });
    expect(replay.status).toBe(401);
    expect(await approvalStatus(second.approvalId)).toBe('pending');
  });

  runDb('without a code or a second-factor session the approve is still refused', async () => {
    const { approvalId } = await seedRow(f);
    const res = await approve(f, approvalId, {});
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
    expect(await approvalStatus(approvalId)).toBe('pending');
  });
});
