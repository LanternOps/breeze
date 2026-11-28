/**
 * Real-Postgres proof of the rules for approval rows that carry no action
 * intent, through the real routes (real JWT, authMiddleware and breeze_app
 * RLS):
 *   - a PAM row is listed in Recent only to a caller who still holds
 *     `pam:approve` in the elevation's org and access to its site, the same
 *     rule the pending list, the count and the by-id read apply;
 *   - a diagnostic read grant row is offered (pending list, count, by id,
 *     assertion challenge) and listed in Recent only to a caller the decide
 *     core would accept as its approver;
 *   - approving a row linked to an AI tool execution meets the approval
 *     security policy of the partner that owns the AI session's org as well as
 *     the session partner's (stricter wins). Denying reads no policy.
 */
import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db, withSystemDbAccessContext } from '../../db';
import { approvalRequests } from '../../db/schema/approvals';
import { elevationRequests } from '../../db/schema/elevations';
import { diagnosticAccessGrants } from '../../db/schema/diagnosticAccess';
import { aiSessions, aiToolExecutions, authenticatorPolicies, devices, organizationUsers } from '../../db/schema';
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

interface User {
  id: string;
  email: string;
}

interface Session {
  user: User;
  partnerId: string;
  orgId: string;
  roleId: string;
}

async function token(session: Session, mfa = true): Promise<string> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: session.user.id,
    email: session.user.email,
    roleId: session.roleId,
    orgId: session.orgId,
    partnerId: session.partnerId,
    scope: 'organization',
    mfa,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  return createAccessToken(payload);
}

function app(): Hono {
  const a = new Hono();
  a.route('/approvals', approvalRoutes);
  return a;
}

async function get(session: Session, path: string): Promise<Response> {
  return app().request(path, { headers: { Authorization: `Bearer ${await token(session)}` } });
}

async function post(session: Session, path: string): Promise<Response> {
  return app().request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await token(session)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

async function listedIds(session: Session, path: string): Promise<string[]> {
  const res = await get(session, path);
  expect(res.status).toBe(200);
  return ((await res.json()).approvals as Array<{ id: string }>).map((a) => a.id);
}

async function rowStatus(approvalId: string): Promise<string | undefined> {
  const [row] = await withSystemDbAccessContext(() =>
    db.select({ status: approvalRequests.status }).from(approvalRequests).where(eq(approvalRequests.id, approvalId)),
  );
  return row?.status;
}

/** One org with two sites, a device on site B, and a role holding `perms`. */
interface SiteScenario {
  partnerId: string;
  orgId: string;
  siteA: string;
  siteB: string;
  deviceB: string;
  roleId: string;
}

async function seedSiteScenario(perms: Array<{ resource: string; action: string }>): Promise<SiteScenario> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: org.id });
  const siteB = await createSite({ orgId: org.id });
  const role = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(role.id, perms);
  const [device] = await withSystemDbAccessContext(() =>
    db
      .insert(devices)
      .values({
        orgId: org.id,
        siteId: siteB.id,
        agentId: `agent-intentless-${randomUUID()}`,
        hostname: `host-intentless-${randomUUID().slice(0, 8)}`,
        osType: 'windows',
        osVersion: '10.0',
        architecture: 'amd64',
        agentVersion: '1.0.0',
        status: 'online',
      })
      .returning({ id: devices.id }),
  );
  return { partnerId: partner.id, orgId: org.id, siteA: siteA.id, siteB: siteB.id, deviceB: device!.id, roleId: role.id };
}

/** A member of the scenario's org with `roleId`, optionally limited to some sites. */
async function seedMember(s: SiteScenario, opts: { siteIds?: string[]; roleId?: string } = {}): Promise<Session> {
  const user = await createUser({
    partnerId: s.partnerId,
    orgId: s.orgId,
    email: `member-${randomUUID()}@intentless.test`,
    mfaEnabled: true,
  });
  const roleId = opts.roleId ?? s.roleId;
  await assignUserToOrganization(user.id, s.orgId, roleId);
  if (opts.siteIds) {
    await withSystemDbAccessContext(() =>
      db.update(organizationUsers).set({ siteIds: opts.siteIds }).where(eq(organizationUsers.userId, user.id)),
    );
  }
  return { user: { id: user.id, email: user.email }, partnerId: s.partnerId, orgId: s.orgId, roleId };
}

describe('PAM rows in the Recent listing', () => {
  let s: SiteScenario;
  beforeEach(async () => {
    s = await seedSiteScenario([PERMISSIONS.APPROVALS_DECIDE, PERMISSIONS.PAM_APPROVE, PERMISSIONS.DEVICES_EXECUTE]);
  });

  /** A site-B elevation with an expired approval row for `approverId` (Recent lists a row with no intent by its own status). */
  async function seedTerminalPamRow(approverId: string): Promise<string> {
    return withSystemDbAccessContext(async () => {
      const [elev] = await db
        .insert(elevationRequests)
        .values({
          orgId: s.orgId,
          siteId: s.siteB,
          partnerId: s.partnerId,
          deviceId: s.deviceB,
          deviceEpoch: currentOwnershipEpochSql(s.deviceB),
          flowType: 'uac_intercept',
          subjectUserId: null,
          subjectUsername: 'DESK\\enduser',
          reason: 'recent listing coverage',
          targetExecutablePath: 'C:\\Temp\\setup.exe',
          targetExecutableHash: 'b'.repeat(64),
          toolName: null,
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
          actionToolName: 'uac_intercept',
          actionArguments: { deviceHostname: 'host', commandLine: 'setup.exe /quiet' },
          riskTier: 'low',
          riskSummary: 'admin requested',
          status: 'expired',
          expiresAt: new Date(Date.now() - 60_000),
          elevationRequestId: elev!.id,
        })
        .returning({ id: approvalRequests.id });
      return row!.id;
    });
  }

  runDb('a settled PAM row outside the caller\'s sites is not listed; one inside them is', async () => {
    const outside = await seedMember(s, { siteIds: [s.siteA] });
    const inside = await seedMember(s, { siteIds: [s.siteB] });
    const hidden = await seedTerminalPamRow(outside.user.id);
    const shown = await seedTerminalPamRow(inside.user.id);

    expect(await listedIds(outside, '/approvals/pending?view=recent')).not.toContain(hidden);
    expect(await listedIds(inside, '/approvals/pending?view=recent')).toContain(shown);
  });

  runDb('a settled PAM row is not listed to a caller without pam:approve', async () => {
    const noPam = await createRole({ scope: 'organization', orgId: s.orgId });
    await grantRolePermissions(noPam.id, [PERMISSIONS.APPROVALS_DECIDE, PERMISSIONS.DEVICES_EXECUTE]);
    const demoted = await seedMember(s, { roleId: noPam.id });
    const hidden = await seedTerminalPamRow(demoted.user.id);

    expect(await listedIds(demoted, '/approvals/pending?view=recent')).not.toContain(hidden);
  });
});

describe('diagnostic read grant rows on the read routes', () => {
  let s: SiteScenario;
  let requester: Session;
  beforeEach(async () => {
    s = await seedSiteScenario([PERMISSIONS.APPROVALS_DECIDE, PERMISSIONS.DEVICES_EXECUTE]);
    requester = await seedMember(s);
  });

  /** A grant on the site-B device and one approval row for `approverId`. */
  async function seedGrantRow(
    approverId: string,
    state: 'pending' | 'settled' = 'pending',
  ): Promise<string> {
    return withSystemDbAccessContext(async () => {
      const [grant] = await db
        .insert(diagnosticAccessGrants)
        .values({
          orgId: s.orgId,
          deviceId: s.deviceB,
          status: state === 'pending' ? 'pending_approval' : 'denied',
          requestedByUserId: requester.user.id,
          beneficiaryKind: 'user',
          beneficiaryId: requester.user.id,
          source: 'chat',
          requestExpiresAt: new Date(Date.now() + 60 * 60_000),
          purpose: 'launcher crash logs',
          operations: ['list', 'read'],
          scopes: [{ path: 'C:\\ProgramData\\Launcher', recursive: true }],
          sensitiveClasses: [],
          durationMinutes: 60,
          ...(state === 'settled' ? { deniedByUserId: requester.user.id, deniedAt: new Date() } : {}),
        })
        .returning({ id: diagnosticAccessGrants.id });
      const [row] = await db
        .insert(approvalRequests)
        .values({
          userId: approverId,
          diagnosticAccessGrantId: grant!.id,
          requestingClientLabel: 'Breeze AI',
          actionLabel: 'Read-only diagnostic access',
          actionToolName: 'request_diagnostic_access',
          actionArguments: { hostname: 'host', paths: [{ path: 'C:\\ProgramData\\Launcher', recursive: true }] },
          riskTier: 'high',
          riskSummary: 'diagnostic access',
          status: state === 'pending' ? 'pending' : 'expired',
          expiresAt: state === 'pending' ? new Date(Date.now() + 60 * 60_000) : new Date(Date.now() - 60_000),
        })
        .returning({ id: approvalRequests.id });
      return row!.id;
    });
  }

  runDb('a pending row outside the caller\'s sites is not offered in the list, the count, by id or the challenge', async () => {
    const outside = await seedMember(s, { siteIds: [s.siteA] });
    const hidden = await seedGrantRow(outside.user.id);

    expect(await listedIds(outside, '/approvals/pending')).not.toContain(hidden);
    expect((await (await get(outside, '/approvals/pending/count')).json()).count).toBe(0);
    expect((await get(outside, `/approvals/${hidden}`)).status).toBe(404);
    expect((await post(outside, `/approvals/${hidden}/assertion-challenge`)).status).toBe(404);
    // The decide core refuses the same caller.
    expect((await post(outside, `/approvals/${hidden}/deny`)).status).toBe(403);
    expect(await rowStatus(hidden)).toBe('pending');
  });

  runDb('a pending row is not offered to a caller who no longer holds approvals:decide', async () => {
    const noDecide = await createRole({ scope: 'organization', orgId: s.orgId });
    await grantRolePermissions(noDecide.id, [PERMISSIONS.DEVICES_EXECUTE]);
    const demoted = await seedMember(s, { roleId: noDecide.id });
    const hidden = await seedGrantRow(demoted.user.id);

    expect(await listedIds(demoted, '/approvals/pending')).not.toContain(hidden);
    expect((await (await get(demoted, '/approvals/pending/count')).json()).count).toBe(0);
    expect((await get(demoted, `/approvals/${hidden}`)).status).toBe(404);
  });

  runDb('a pending row inside the caller\'s sites is offered in the list, the count and by id', async () => {
    const inside = await seedMember(s, { siteIds: [s.siteB] });
    const shown = await seedGrantRow(inside.user.id);

    expect(await listedIds(inside, '/approvals/pending')).toContain(shown);
    expect((await (await get(inside, '/approvals/pending/count')).json()).count).toBe(1);
    expect((await get(inside, `/approvals/${shown}`)).status).toBe(200);
  });

  runDb('a caller outside the request\'s sites cannot report it as suspicious: 404, the grant stays pending', async () => {
    const outside = await seedMember(s, { siteIds: [s.siteA] });
    const hidden = await seedGrantRow(outside.user.id);

    expect((await post(outside, `/approvals/${hidden}/report-suspicious`)).status).toBe(404);
    expect(await rowStatus(hidden)).toBe('pending');
    expect(await grantStatusOf(hidden)).toBe('pending_approval');
  });

  runDb('a caller who could decide it can report it as suspicious, which denies the grant', async () => {
    const inside = await seedMember(s, { siteIds: [s.siteB] });
    const shown = await seedGrantRow(inside.user.id);

    expect((await post(inside, `/approvals/${shown}/report-suspicious`)).status).toBe(204);
    expect(await rowStatus(shown)).toBe('reported');
    expect(await grantStatusOf(shown)).toBe('denied');
  });

  async function grantStatusOf(approvalId: string): Promise<string | undefined> {
    return withSystemDbAccessContext(async () => {
      const [row] = await db
        .select({ status: diagnosticAccessGrants.status })
        .from(approvalRequests)
        .innerJoin(diagnosticAccessGrants, eq(diagnosticAccessGrants.id, approvalRequests.diagnosticAccessGrantId))
        .where(eq(approvalRequests.id, approvalId));
      return row?.status;
    });
  }

  runDb('a settled row is listed in Recent only to a caller who could decide it', async () => {
    const outside = await seedMember(s, { siteIds: [s.siteA] });
    const inside = await seedMember(s, { siteIds: [s.siteB] });
    const hidden = await seedGrantRow(outside.user.id, 'settled');
    const shown = await seedGrantRow(inside.user.id, 'settled');

    expect(await listedIds(outside, '/approvals/pending?view=recent')).not.toContain(hidden);
    expect(await listedIds(inside, '/approvals/pending?view=recent')).toContain(shown);
  });
});

describe('approving a row linked to an AI tool execution', () => {
  /** One person in an org of partner A (the session's) and an org of partner B (the AI session's). */
  let a: Session;
  let b: Session;

  beforeEach(async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const orgB = await createOrganization({ partnerId: partnerB.id });
    const roleA = await createRole({ scope: 'organization', orgId: orgA.id });
    const roleB = await createRole({ scope: 'organization', orgId: orgB.id });
    const user = await createUser({
      partnerId: partnerA.id,
      orgId: orgA.id,
      email: `two-partners-${randomUUID()}@intentless.test`,
      mfaEnabled: true,
    });
    await assignUserToOrganization(user.id, orgA.id, roleA.id);
    await assignUserToOrganization(user.id, orgB.id, roleB.id);
    const u = { id: user.id, email: user.email };
    a = { user: u, partnerId: partnerA.id, orgId: orgA.id, roleId: roleA.id };
    b = { user: u, partnerId: partnerB.id, orgId: orgB.id, roleId: roleB.id };
  });

  async function setPolicy(partnerId: string, enforcing: boolean): Promise<void> {
    await withSystemDbAccessContext(() =>
      db.insert(authenticatorPolicies).values({
        partnerId,
        requireEnrollment: enforcing,
        floorOverrides: {},
        enforceFrom: enforcing ? new Date('2000-01-01T00:00:00Z') : null,
      }),
    );
  }

  /** A pending medium-risk execution in an AI session of partner B's org, with its approval row. */
  async function seedExecutionRow(): Promise<{ approvalId: string; executionId: string }> {
    return withSystemDbAccessContext(async () => {
      const [session] = await db
        .insert(aiSessions)
        .values({ orgId: b.orgId, userId: b.user.id, model: 'test-model' })
        .returning({ id: aiSessions.id });
      const [execution] = await db
        .insert(aiToolExecutions)
        .values({ sessionId: session!.id, toolName: 'restart_service', toolInput: { service: 'spooler' }, status: 'pending' })
        .returning({ id: aiToolExecutions.id });
      const [row] = await db
        .insert(approvalRequests)
        .values({
          userId: b.user.id,
          executionId: execution!.id,
          requestingClientLabel: 'Breeze AI',
          actionLabel: 'Restart the print spooler',
          actionToolName: 'restart_service',
          actionArguments: { service: 'spooler' },
          riskTier: 'medium',
          riskSummary: 'restarts a service',
          status: 'pending',
          expiresAt: new Date(Date.now() + 5 * 60_000),
        })
        .returning({ id: approvalRequests.id });
      return { approvalId: row!.id, executionId: execution!.id };
    });
  }

  runDb('the session partner opted out, the AI session\'s partner enforcing: 403 step_up_required, nothing written', async () => {
    await setPolicy(a.partnerId, false);
    await setPolicy(b.partnerId, true);
    const { approvalId } = await seedExecutionRow();

    const res = await post(a, `/approvals/${approvalId}/approve`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'step_up_required', requiredLevel: 2 });
    expect(await rowStatus(approvalId)).toBe('pending');
  });

  runDb('the same row can still be denied from that session', async () => {
    await setPolicy(a.partnerId, false);
    await setPolicy(b.partnerId, true);
    const { approvalId } = await seedExecutionRow();

    expect((await post(a, `/approvals/${approvalId}/deny`)).status).toBe(200);
    expect(await rowStatus(approvalId)).toBe('denied');
  });

  runDb('neither partner enforcing: a session tap approves', async () => {
    await setPolicy(a.partnerId, false);
    await setPolicy(b.partnerId, false);
    const { approvalId } = await seedExecutionRow();

    expect((await post(a, `/approvals/${approvalId}/approve`)).status).toBe(200);
    expect(await rowStatus(approvalId)).toBe('approved');
  });
});
