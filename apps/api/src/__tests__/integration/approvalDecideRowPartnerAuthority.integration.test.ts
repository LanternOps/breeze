/**
 * Real-Postgres proof that decide authority over an approval row is resolved
 * in the partner that OWNS the row's org.
 *
 * One identity belongs to two partners. It holds a partner-wide role in
 * partner A (the signed-in session) and, in the main case, no role in partner
 * B. Two pending rows in a partner-B org are addressed to it: a four-eyes
 * action intent and a PAM elevation. Driven through the real routes (real JWT,
 * authMiddleware and breeze_app RLS) from the partner-A session:
 *   - the approve is refused (403) and nothing is written;
 *   - the pending list does not offer either row;
 *   - with a live role in partner B, the same four-eyes approve goes through.
 */
import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db, withSystemDbAccessContext } from '../../db';
import { actionIntents } from '../../db/schema/actionIntents';
import { approvalRequests } from '../../db/schema/approvals';
import { elevationRequests } from '../../db/schema/elevations';
import { devices } from '../../db/schema';
import { PERMISSIONS } from '../../services/permissions';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { currentOwnershipEpochSql } from '../../services/deviceOwnershipEpoch';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { approvalRoutes } from '../../routes/approvals';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const DECIDER_PERMS = [PERMISSIONS.APPROVALS_DECIDE, PERMISSIONS.PAM_APPROVE, PERMISSIONS.DEVICES_EXECUTE];

interface Scenario {
  user: { id: string; email: string };
  partnerA: string;
  roleA: string;
  partnerB: string;
  orgB: string;
  siteB: string;
  deviceB: string;
  requesterB: string;
}

async function seedScenario(): Promise<Scenario> {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const orgB = await createOrganization({ partnerId: partnerB.id });
  const siteB = await createSite({ orgId: orgB.id });

  const roleA = await createRole({ scope: 'partner', partnerId: partnerA.id });
  await grantRolePermissions(roleA.id, DECIDER_PERMS);
  const user = await createUser({
    partnerId: partnerA.id,
    orgId: null as unknown as string,
    email: `two-partners-${randomUUID()}@decideauthority.test`,
  });
  await assignUserToPartner(user.id, partnerA.id, roleA.id, 'all');

  const requesterRole = await createRole({ scope: 'organization', orgId: orgB.id });
  await grantRolePermissions(requesterRole.id, [PERMISSIONS.DEVICES_EXECUTE]);
  const requester = await createUser({
    partnerId: partnerB.id,
    orgId: orgB.id,
    email: `requester-${randomUUID()}@decideauthority.test`,
  });
  await assignUserToOrganization(requester.id, orgB.id, requesterRole.id);

  const [device] = await withSystemDbAccessContext(() =>
    db
      .insert(devices)
      .values({
        orgId: orgB.id,
        siteId: siteB.id,
        agentId: `agent-decide-${randomUUID()}`,
        hostname: `host-decide-${randomUUID().slice(0, 8)}`,
        osType: 'windows',
        osVersion: '10.0',
        architecture: 'amd64',
        agentVersion: '1.0.0',
        status: 'online',
      })
      .returning({ id: devices.id }),
  );

  void orgA;
  return {
    user: { id: user.id, email: user.email },
    partnerA: partnerA.id,
    roleA: roleA.id,
    partnerB: partnerB.id,
    orgB: orgB.id,
    siteB: siteB.id,
    deviceB: device!.id,
    requesterB: requester.id,
  };
}

/** A role in partner B for the same identity. */
async function grantPartnerBRole(s: Scenario): Promise<void> {
  const roleB = await createRole({ scope: 'partner', partnerId: s.partnerB });
  await grantRolePermissions(roleB.id, DECIDER_PERMS);
  await assignUserToPartner(s.user.id, s.partnerB, roleB.id, 'all');
}

/** A pending four-eyes intent in partner B's org, with an approval row addressed to the user. */
async function seedFourEyesRow(s: Scenario): Promise<{ intentId: string; approvalId: string }> {
  return withSystemDbAccessContext(async () => {
    const [intent] = await db
      .insert(actionIntents)
      .values({
        orgId: s.orgB,
        partnerId: s.partnerB,
        requestedByUserId: s.requesterB,
        requestingApiKeyId: null,
        requestingAgentRunId: null,
        source: 'chat',
        originPrincipalKind: 'user_session',
        originPrincipalId: s.requesterB,
        actionName: 'device.script.run',
        actionVersion: 1,
        arguments: { scriptId: randomUUID() },
        argumentDigest: 'c'.repeat(64),
        targetSummary: 'Run a script',
        impactSummary: 'Runs a script on one device',
        reason: 'integration coverage',
        riskTier: 2,
        approvalScope: 'four_eyes',
        connectionId: null,
        tenantId: null,
        idempotencyKey: `idem-${randomUUID()}`,
        correlationId: randomUUID(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        status: 'pending_approval',
      } as never)
      .returning({ id: actionIntents.id });
    const [row] = await db
      .insert(approvalRequests)
      .values({
        userId: s.user.id,
        requestingClientLabel: 'Breeze AI',
        actionLabel: 'Run a script',
        actionToolName: 'device.script.run',
        riskTier: 'medium',
        riskSummary: 'Runs a script on one device',
        status: 'pending',
        expiresAt: new Date(Date.now() + 30 * 60_000),
        intentId: intent!.id,
        boundArgumentDigest: 'c'.repeat(64),
      })
      .returning({ id: approvalRequests.id });
    return { intentId: intent!.id, approvalId: row!.id };
  });
}

/** A pending PAM elevation in partner B's org, with an approval row addressed to the user. */
async function seedPamRow(s: Scenario): Promise<{ elevationId: string; approvalId: string }> {
  return withSystemDbAccessContext(async () => {
    const [elev] = await db
      .insert(elevationRequests)
      .values({
        orgId: s.orgB,
        siteId: s.siteB,
        partnerId: s.partnerB,
        deviceId: s.deviceB,
        deviceEpoch: currentOwnershipEpochSql(s.deviceB),
        flowType: 'uac_intercept',
        subjectUsername: 'DESK\\enduser',
        reason: 'install setup.exe',
        targetExecutablePath: 'C:\\Temp\\setup.exe',
        targetExecutableHash: 'a'.repeat(64),
        riskTier: 1,
        status: 'pending',
      })
      .returning({ id: elevationRequests.id });
    const [row] = await db
      .insert(approvalRequests)
      .values({
        userId: s.user.id,
        requestingClientLabel: 'Breeze Agent',
        actionLabel: 'Elevate setup.exe',
        actionToolName: 'uac_intercept',
        riskTier: 'low',
        riskSummary: 'admin requested',
        status: 'pending',
        expiresAt: new Date(Date.now() + 5 * 60_000),
        elevationRequestId: elev!.id,
      })
      .returning({ id: approvalRequests.id });
    return { elevationId: elev!.id, approvalId: row!.id };
  });
}

/** A partner-wide session signed in to partner A, with the MFA claim. */
async function tokenInA(s: Scenario): Promise<string> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: s.user.id,
    email: s.user.email,
    roleId: s.roleA,
    orgId: null,
    partnerId: s.partnerA,
    scope: 'partner',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  return createAccessToken(payload);
}

async function call(s: Scenario, path: string, method: 'GET' | 'POST'): Promise<Response> {
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  return app.request(path, {
    method,
    headers: { Authorization: `Bearer ${await tokenInA(s)}`, 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify({}) } : {}),
  });
}

async function rowStatus(approvalId: string): Promise<string | undefined> {
  const [row] = await withSystemDbAccessContext(() =>
    db.select({ status: approvalRequests.status }).from(approvalRequests).where(eq(approvalRequests.id, approvalId)),
  );
  return row?.status;
}

let s: Scenario;

beforeEach(async () => {
  s = await seedScenario();
});

describe('decide authority over a row in another partner’s org, from a partner-A session', () => {
  runDb('four-eyes approve with no role in the owning partner: 403, nothing written', async () => {
    const { intentId, approvalId } = await seedFourEyesRow(s);

    const res = await call(s, `/approvals/${approvalId}/approve`, 'POST');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });

    expect(await rowStatus(approvalId)).toBe('pending');
    const [intent] = await withSystemDbAccessContext(() =>
      db.select({ status: actionIntents.status }).from(actionIntents).where(eq(actionIntents.id, intentId)),
    );
    expect(intent?.status).toBe('pending_approval');
  });

  runDb('PAM approve with no role in the owning partner: 403 pam_approve_required, nothing written', async () => {
    const { elevationId, approvalId } = await seedPamRow(s);

    const res = await call(s, `/approvals/${approvalId}/approve`, 'POST');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'pam_approve_required' });

    expect(await rowStatus(approvalId)).toBe('pending');
    const [elev] = await withSystemDbAccessContext(() =>
      db.select({ status: elevationRequests.status }).from(elevationRequests).where(eq(elevationRequests.id, elevationId)),
    );
    expect(elev?.status).toBe('pending');
  });

  runDb('neither row is offered in the pending list, the count, or by id', async () => {
    const fourEyes = await seedFourEyesRow(s);
    const pam = await seedPamRow(s);

    const list = await call(s, '/approvals/pending', 'GET');
    expect(list.status).toBe(200);
    const ids = ((await list.json()).approvals as Array<{ id: string }>).map((a) => a.id);
    expect(ids).not.toContain(fourEyes.approvalId);
    expect(ids).not.toContain(pam.approvalId);

    const count = await call(s, '/approvals/pending/count', 'GET');
    expect((await count.json()).count).toBe(0);

    expect((await call(s, `/approvals/${fourEyes.approvalId}`, 'GET')).status).toBe(404);
    expect((await call(s, `/approvals/${pam.approvalId}`, 'GET')).status).toBe(404);
  });

  runDb('with a live role in the owning partner, the same four-eyes row is listed and approved', async () => {
    await grantPartnerBRole(s);
    const { approvalId } = await seedFourEyesRow(s);

    const list = await call(s, '/approvals/pending', 'GET');
    const ids = ((await list.json()).approvals as Array<{ id: string }>).map((a) => a.id);
    expect(ids).toContain(approvalId);

    const res = await call(s, `/approvals/${approvalId}/approve`, 'POST');
    expect(res.status).toBe(200);
    expect(await rowStatus(approvalId)).toBe('approved');
  });

  runDb('with a live role in the owning partner, the PAM row is listed', async () => {
    await grantPartnerBRole(s);
    const { approvalId } = await seedPamRow(s);

    const list = await call(s, '/approvals/pending', 'GET');
    const ids = ((await list.json()).approvals as Array<{ id: string }>).map((a) => a.id);
    expect(ids).toContain(approvalId);
  });
});
