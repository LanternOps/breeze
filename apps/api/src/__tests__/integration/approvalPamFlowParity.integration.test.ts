/**
 * Real-Postgres proof that a PAM elevation decided through the general
 * approvals route meets the same rules as the dedicated PAM respond route,
 * for every elevation flow type:
 *   - an approve needs a second factor (the session's MFA claim);
 *   - the decider needs access to the request's site, to approve or deny;
 *   - the technician a request was raised for cannot approve it.
 *
 * Driven through the real routes (real JWT, authMiddleware and breeze_app RLS)
 * with rows seeded directly, so each flow type is covered whatever creates it.
 */
import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db, withSystemDbAccessContext } from '../../db';
import { approvalRequests } from '../../db/schema/approvals';
import { elevationRequests } from '../../db/schema/elevations';
import { devices, organizationUsers } from '../../db/schema';
import { PERMISSIONS } from '../../services/permissions';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { currentOwnershipEpochSql } from '../../services/deviceOwnershipEpoch';
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

const DECIDER_PERMS = [PERMISSIONS.APPROVALS_DECIDE, PERMISSIONS.PAM_APPROVE, PERMISSIONS.DEVICES_EXECUTE];

type FlowType = 'uac_intercept' | 'tech_jit_admin' | 'ai_tool_action';

interface Scenario {
  partnerId: string;
  orgId: string;
  siteA: string;
  siteB: string;
  deviceB: string;
  roleId: string;
  technician: { id: string; email: string };
}

interface Approver {
  id: string;
  email: string;
}

async function seedScenario(): Promise<Scenario> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: org.id });
  const siteB = await createSite({ orgId: org.id });
  const role = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(role.id, DECIDER_PERMS);

  const technician = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `tech-${randomUUID()}@pamflowparity.test`,
    mfaEnabled: true,
  });
  await assignUserToOrganization(technician.id, org.id, role.id);

  const [device] = await withSystemDbAccessContext(() =>
    db
      .insert(devices)
      .values({
        orgId: org.id,
        siteId: siteB.id,
        agentId: `agent-parity-${randomUUID()}`,
        hostname: `host-parity-${randomUUID().slice(0, 8)}`,
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
    siteA: siteA.id,
    siteB: siteB.id,
    deviceB: device!.id,
    roleId: role.id,
    technician: { id: technician.id, email: technician.email },
  };
}

/** An approver in the org with the decide permissions, optionally limited to some sites. */
async function seedApprover(s: Scenario, siteIds?: string[]): Promise<Approver> {
  const user = await createUser({
    partnerId: s.partnerId,
    orgId: s.orgId,
    email: `approver-${randomUUID()}@pamflowparity.test`,
    mfaEnabled: true,
  });
  await assignUserToOrganization(user.id, s.orgId, s.roleId);
  if (siteIds) {
    await withSystemDbAccessContext(() =>
      db
        .update(organizationUsers)
        .set({ siteIds })
        .where(eq(organizationUsers.userId, user.id)),
    );
  }
  return { id: user.id, email: user.email };
}

/** A pending elevation of the given flow on the site-B device, with an approval row for `approverId`. */
async function seedPamRow(
  s: Scenario,
  flowType: FlowType,
  approverId: string,
): Promise<{ elevationId: string; approvalId: string }> {
  return withSystemDbAccessContext(async () => {
    const [elev] = await db
      .insert(elevationRequests)
      .values({
        orgId: s.orgId,
        siteId: s.siteB,
        partnerId: s.partnerId,
        deviceId: s.deviceB,
        deviceEpoch: currentOwnershipEpochSql(s.deviceB),
        flowType,
        subjectUserId: flowType === 'tech_jit_admin' ? s.technician.id : null,
        subjectUsername: flowType === 'tech_jit_admin' ? 'DESK\\technician' : 'DESK\\enduser',
        reason: 'parity coverage',
        targetExecutablePath: 'C:\\Temp\\setup.exe',
        targetExecutableHash: 'a'.repeat(64),
        toolName: flowType === 'ai_tool_action' ? 'run_script' : null,
        riskTier: 1,
        status: 'pending',
      })
      .returning({ id: elevationRequests.id });
    const [row] = await db
      .insert(approvalRequests)
      .values({
        userId: approverId,
        requestingClientLabel: 'Breeze Agent',
        actionLabel: 'Elevate setup.exe',
        actionToolName: flowType,
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

async function token(s: Scenario, user: Approver, mfa: boolean): Promise<string> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: user.id,
    email: user.email,
    roleId: s.roleId,
    orgId: s.orgId,
    partnerId: s.partnerId,
    scope: 'organization',
    mfa,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  return createAccessToken(payload);
}

async function decide(
  s: Scenario,
  user: Approver,
  approvalId: string,
  action: 'approve' | 'deny',
  mfa: boolean,
): Promise<Response> {
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  return app.request(`/approvals/${approvalId}/${action}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await token(s, user, mfa)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

async function call(s: Scenario, user: Approver, path: string): Promise<Response> {
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  return app.request(path, { headers: { Authorization: `Bearer ${await token(s, user, true)}` } });
}

async function statuses(approvalId: string, elevationId: string): Promise<[string | undefined, string | undefined]> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalId));
    const [elev] = await db
      .select({ status: elevationRequests.status })
      .from(elevationRequests)
      .where(eq(elevationRequests.id, elevationId));
    return [row?.status, elev?.status];
  });
}

let s: Scenario;

beforeEach(async () => {
  s = await seedScenario();
});

const FLOWS: FlowType[] = ['uac_intercept', 'tech_jit_admin', 'ai_tool_action'];

describe('a PAM elevation decided through /approvals meets the dedicated route’s rules', () => {
  for (const flow of FLOWS) {
    runDb(`${flow}: an approve from a session without a second factor is refused, nothing written`, async () => {
      const approver = await seedApprover(s);
      const { elevationId, approvalId } = await seedPamRow(s, flow, approver.id);

      const res = await decide(s, approver, approvalId, 'approve', false);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
      expect(await statuses(approvalId, elevationId)).toEqual(['pending', 'pending']);
    });

    runDb(`${flow}: an approve by a decider without access to the request's site is refused, nothing written`, async () => {
      const approver = await seedApprover(s, [s.siteA]);
      const { elevationId, approvalId } = await seedPamRow(s, flow, approver.id);

      const res = await decide(s, approver, approvalId, 'approve', true);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'site_access_denied' });
      expect(await statuses(approvalId, elevationId)).toEqual(['pending', 'pending']);
    });

    runDb(`${flow}: a deny by a decider without access to the request's site is refused, nothing written`, async () => {
      const approver = await seedApprover(s, [s.siteA]);
      const { elevationId, approvalId } = await seedPamRow(s, flow, approver.id);

      const res = await decide(s, approver, approvalId, 'deny', true);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'site_access_denied' });
      expect(await statuses(approvalId, elevationId)).toEqual(['pending', 'pending']);
    });
  }

  runDb('tech_jit_admin: the technician the request was raised for cannot approve it', async () => {
    const technician: Approver = s.technician;
    const { elevationId, approvalId } = await seedPamRow(s, 'tech_jit_admin', technician.id);

    const res = await decide(s, technician, approvalId, 'approve', true);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'self_approval_forbidden' });
    expect(await statuses(approvalId, elevationId)).toEqual(['pending', 'pending']);
  });

  for (const flow of FLOWS) {
    runDb(`${flow}: a deny needs no second factor, and a decider with site access may deny`, async () => {
      const approver = await seedApprover(s, [s.siteB]);
      const { elevationId, approvalId } = await seedPamRow(s, flow, approver.id);

      const res = await decide(s, approver, approvalId, 'deny', false);
      expect(res.status).toBe(200);
      expect(await statuses(approvalId, elevationId)).toEqual(['denied', 'denied']);
    });
  }

  runDb('uac_intercept: an approve needs access to both the request\'s site and the device\'s current site', async () => {
    // The device moved from site B (the request's site) to site A after the request.
    await withSystemDbAccessContext(() =>
      db.update(devices).set({ siteId: s.siteA }).where(eq(devices.id, s.deviceB)),
    );
    const onlyNewSite = await seedApprover(s, [s.siteA]);
    const first = await seedPamRow(s, 'uac_intercept', onlyNewSite.id);
    const res = await decide(s, onlyNewSite, first.approvalId, 'approve', true);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'site_access_denied' });
    expect(await statuses(first.approvalId, first.elevationId)).toEqual(['pending', 'pending']);

    const onlyRequestSite = await seedApprover(s, [s.siteB]);
    const second = await seedPamRow(s, 'uac_intercept', onlyRequestSite.id);
    const res2 = await decide(s, onlyRequestSite, second.approvalId, 'approve', true);
    expect(res2.status).toBe(403);
    expect(await res2.json()).toEqual({ error: 'site_access_denied' });
    expect(await statuses(second.approvalId, second.elevationId)).toEqual(['pending', 'pending']);
  });

  runDb('a PAM row outside the decider\'s sites is not offered in the list, the count, or by id', async () => {
    const outside = await seedApprover(s, [s.siteA]);
    const { approvalId } = await seedPamRow(s, 'uac_intercept', outside.id);
    const inside = await seedApprover(s, [s.siteB]);
    const visible = await seedPamRow(s, 'uac_intercept', inside.id);

    const list = await call(s, outside, '/approvals/pending');
    const ids = ((await list.json()).approvals as Array<{ id: string }>).map((a) => a.id);
    expect(ids).not.toContain(approvalId);
    expect((await (await call(s, outside, '/approvals/pending/count')).json()).count).toBe(0);
    expect((await call(s, outside, `/approvals/${approvalId}`)).status).toBe(404);

    const insideIds = ((await (await call(s, inside, '/approvals/pending')).json()).approvals as Array<{ id: string }>)
      .map((a) => a.id);
    expect(insideIds).toContain(visible.approvalId);
  });

  runDb('tech_jit_admin: a second-factor session with access to the site approves', async () => {
    const approver = await seedApprover(s, [s.siteB]);
    const { elevationId, approvalId } = await seedPamRow(s, 'tech_jit_admin', approver.id);

    const res = await decide(s, approver, approvalId, 'approve', true);
    expect(res.status).toBe(200);
    expect(await statuses(approvalId, elevationId)).toEqual(['approved', 'approved']);
  });

  runDb('uac_intercept: a second-factor session with access to the site approves', async () => {
    const approver = await seedApprover(s);
    const { elevationId, approvalId } = await seedPamRow(s, 'uac_intercept', approver.id);

    const res = await decide(s, approver, approvalId, 'approve', true);
    expect(res.status).toBe(200);
    expect(await statuses(approvalId, elevationId)).toEqual(['approved', 'approved']);
  });
});
