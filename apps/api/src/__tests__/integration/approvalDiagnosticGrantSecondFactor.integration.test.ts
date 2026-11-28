/**
 * Real Postgres + Redis: approving a diagnostic read grant needs a second
 * factor, the same rule as approving a high- or critical-risk action intent or
 * a PAM elevation. The session's MFA claim satisfies it, as does a fresh
 * authenticator code sent with the approve. A deny needs neither.
 *
 * Driven through the real route (real JWT, authMiddleware, breeze_app RLS, the
 * real code check) on requests raised by the real fan-out
 * (`createDiagnosticAccessRequest`), so the rows carry the tier the service
 * assigns: high when someone else approves, critical for a sole operator.
 *
 * A sole operator approving their own request also needs a fresh
 * hardware-backed assertion; here a P-256 key registered as an attested
 * platform-bound approver device signs the real challenge nonce. One code then
 * serves as both the second factor and the critical tier's re-authentication.
 */
import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { generate, generateSecret } from 'otplib';
import { db, withSystemDbAccessContext } from '../../db';
import { approvalRequests } from '../../db/schema/approvals';
import { diagnosticAccessGrants } from '../../db/schema/diagnosticAccess';
import { authenticatorDevices, authenticatorPolicies, devices, organizationUsers, users } from '../../db/schema';
import { PERMISSIONS } from '../../services/permissions';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { encryptMfaSecret } from '../../routes/auth/helpers';
import { createDiagnosticAccessRequest } from '../../services/diagnosticAccess/grants';
import { sha256CanonicalSpki } from '../../services/mobileHwKey';
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

const SCOPE_ROOT = 'C:\\Users\\Alice\\AppData\\Local\\Battle.net';
const PASSWORD = 'TestPass123!';

interface Member {
  id: string;
  email: string;
  secret: string;
}

interface Fixture {
  partnerId: string;
  orgId: string;
  roleId: string;
  device: typeof devices.$inferSelect;
  requester: Member;
  approver: Member;
}

/** A user with an authenticator app (TOTP) enrolled. */
async function seedMember(partnerId: string, orgId: string, label: string): Promise<Member> {
  const user = await createUser({
    partnerId,
    orgId,
    email: `${label}-${randomUUID()}@diag-second-factor.test`,
    password: PASSWORD,
    mfaEnabled: true,
  });
  const secret = generateSecret();
  await withSystemDbAccessContext(() =>
    db
      .update(users)
      .set({ mfaEnabled: true, mfaMethod: 'totp', mfaSecret: encryptMfaSecret(secret) })
      .where(eq(users.id, user.id)),
  );
  return { id: user.id, email: user.email, secret };
}

async function seed(): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const approverRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(approverRole.id, [PERMISSIONS.APPROVALS_DECIDE, PERMISSIONS.DEVICES_EXECUTE]);
  const requesterRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(requesterRole.id, [PERMISSIONS.DEVICES_READ]);

  const [device] = await withSystemDbAccessContext(() =>
    db
      .insert(devices)
      .values({
        orgId: org.id,
        siteId: site.id,
        agentId: `agent-diag2f-${randomUUID()}`,
        hostname: `host-diag2f-${randomUUID().slice(0, 8)}`,
        osType: 'windows',
        osVersion: '11',
        architecture: 'amd64',
        agentVersion: '1.0.0',
        status: 'online',
      })
      .returning(),
  );

  const requester = await seedMember(partner.id, org.id, 'requester');
  await assignUserToOrganization(requester.id, org.id, requesterRole.id);
  const approver = await seedMember(partner.id, org.id, 'approver');
  await assignUserToOrganization(approver.id, org.id, approverRole.id);

  // Explicit "Not required": the policy never enforces, so the assurance
  // ladder admits an approve without an approver-device proof and only the
  // second-factor rule is under test.
  await withSystemDbAccessContext(() =>
    db.insert(authenticatorPolicies).values({
      partnerId: partner.id,
      requireEnrollment: false,
      floorOverrides: {},
      enforceFrom: null,
    }),
  );

  return { partnerId: partner.id, orgId: org.id, roleId: approverRole.id, device: device!, requester, approver };
}

/** The AuthContext an org-scoped session of `user` carries, for the service-level request. */
function sessionAuth(f: Fixture, user: Member): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([f.orgId]);
  return {
    principal: { kind: 'user_session' },
    user: { id: user.id, email: user.email, name: 'Tech', isPlatformAdmin: false },
    token: {
      sub: user.id,
      email: user.email,
      roleId: f.roleId,
      orgId: f.orgId,
      partnerId: f.partnerId,
      scope: 'organization',
      type: 'access',
      mfa: true,
    },
    partnerId: f.partnerId,
    orgId: f.orgId,
    scope: 'organization',
    accessibleOrgIds: [f.orgId],
    orgCondition,
    canAccessOrg,
  } as AuthContext;
}

async function requestAccess(f: Fixture): Promise<{ grantId: string; approvals: Array<{ id: string; userId: string }> }> {
  const created = await createDiagnosticAccessRequest(sessionAuth(f, f.requester), f.device, {
    deviceId: f.device.id,
    paths: [{ path: SCOPE_ROOT, recursive: true }],
    operations: ['list', 'read'],
    purpose: 'Launcher crash logs',
    durationMinutes: 60,
  });
  return { grantId: created.grant.id, approvals: created.approvals };
}

async function post(
  f: Fixture,
  user: Member,
  path: string,
  body: Record<string, unknown>,
  opts: { mfa: boolean },
): Promise<Response> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: user.id,
    email: user.email,
    roleId: f.roleId,
    orgId: f.orgId,
    partnerId: f.partnerId,
    scope: 'organization',
    mfa: opts.mfa,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  return app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await createAccessToken(payload)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function state(approvalId: string, grantId: string): Promise<{ approval?: string; grant?: string; decidedAt: Date | null }> {
  return withSystemDbAccessContext(async () => {
    const [a] = await db
      .select({ status: approvalRequests.status, decidedAt: approvalRequests.decidedAt })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalId));
    const [g] = await db
      .select({ status: diagnosticAccessGrants.status })
      .from(diagnosticAccessGrants)
      .where(eq(diagnosticAccessGrants.id, grantId));
    return { approval: a?.status, grant: g?.status, decidedAt: a?.decidedAt ?? null };
  });
}

let f: Fixture;

beforeEach(async () => {
  f = await seed();
});

describe('approving a diagnostic read grant at high risk', () => {
  async function approverRow(): Promise<{ grantId: string; approvalId: string; riskTier: string }> {
    const { grantId, approvals } = await requestAccess(f);
    expect(approvals.map((a) => a.userId)).toEqual([f.approver.id]);
    const approvalId = approvals[0]!.id;
    const [row] = await withSystemDbAccessContext(() =>
      db.select({ riskTier: approvalRequests.riskTier }).from(approvalRequests).where(eq(approvalRequests.id, approvalId)),
    );
    return { grantId, approvalId, riskTier: row!.riskTier };
  }

  runDb('from a session without MFA and without a code: 403 MFA_REQUIRED, nothing written, grant still pending', async () => {
    const { grantId, approvalId, riskTier } = await approverRow();
    expect(riskTier).toBe('high');

    const res = await post(f, f.approver, `/approvals/${approvalId}/approve`, {}, { mfa: false });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'MFA required', code: 'MFA_REQUIRED' });
    expect(await state(approvalId, grantId)).toEqual({ approval: 'pending', grant: 'pending_approval', decidedAt: null });
  });

  runDb('a password alone does not count as the second factor', async () => {
    const { grantId, approvalId } = await approverRow();

    const res = await post(f, f.approver, `/approvals/${approvalId}/approve`, { reauthPassword: PASSWORD }, { mfa: false });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'MFA required', code: 'MFA_REQUIRED' });
    expect(await state(approvalId, grantId)).toMatchObject({ approval: 'pending', grant: 'pending_approval' });
  });

  runDb('from a session without MFA with a verified code: approved, grant active', async () => {
    const { grantId, approvalId } = await approverRow();
    const code = await generate({ secret: f.approver.secret });

    const res = await post(f, f.approver, `/approvals/${approvalId}/approve`, { reauthMfaCode: code }, { mfa: false });

    expect(res.status).toBe(200);
    expect(await state(approvalId, grantId)).toMatchObject({ approval: 'approved', grant: 'active' });
  });

  runDb('from a session with MFA: approved, grant active', async () => {
    const { grantId, approvalId } = await approverRow();

    const res = await post(f, f.approver, `/approvals/${approvalId}/approve`, {}, { mfa: true });

    expect(res.status).toBe(200);
    expect(await state(approvalId, grantId)).toMatchObject({ approval: 'approved', grant: 'active' });
  });

  runDb('deny from a session without MFA lands: denied, grant denied', async () => {
    const { grantId, approvalId } = await approverRow();

    const res = await post(f, f.approver, `/approvals/${approvalId}/deny`, { reason: 'not needed' }, { mfa: false });

    expect(res.status).toBe(200);
    expect(await state(approvalId, grantId)).toMatchObject({ approval: 'denied', grant: 'denied' });
  });
});

describe('a sole operator approving their own diagnostic read grant', () => {
  /** Makes the requester the only eligible approver; registers an attested P-256 approver device. */
  async function soleOperatorRow(): Promise<{ grantId: string; approvalId: string; deviceId: string; key: KeyObject }> {
    await withSystemDbAccessContext(async () => {
      await db.update(organizationUsers).set({ roleId: f.roleId }).where(eq(organizationUsers.userId, f.requester.id));
      await db.delete(organizationUsers).where(eq(organizationUsers.userId, f.approver.id));
    });
    const { grantId, approvals } = await requestAccess(f);
    expect(approvals.map((a) => a.userId)).toEqual([f.requester.id]);
    const approvalId = approvals[0]!.id;
    const [row] = await withSystemDbAccessContext(() =>
      db.select({ riskTier: approvalRequests.riskTier }).from(approvalRequests).where(eq(approvalRequests.id, approvalId)),
    );
    expect(row!.riskTier).toBe('critical');

    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const [deviceRow] = await withSystemDbAccessContext(() =>
      db
        .insert(authenticatorDevices)
        .values({
          userId: f.requester.id,
          kind: 'mobile_hw_key',
          label: 'Test phone',
          publicKey: spki,
          publicKeyAlg: 'ES256',
          isPlatformBound: true,
          platformBoundBasis: 'android_strongbox_key_attestation',
          attestationVerifiedAt: new Date(),
          attestedPublicKeySha256: sha256CanonicalSpki(spki)!,
        })
        .returning({ id: authenticatorDevices.id }),
    );
    return { grantId, approvalId, deviceId: deviceRow!.id, key: privateKey };
  }

  /** A fresh challenge nonce for this row, signed by the approver device. */
  async function proofFor(approvalId: string, deviceId: string, key: KeyObject, mfa: boolean) {
    const res = await post(f, f.requester, `/approvals/${approvalId}/assertion-challenge`, {}, { mfa });
    expect(res.status).toBe(200);
    const { mobileNonce } = (await res.json()) as { mobileNonce?: string };
    expect(typeof mobileNonce).toBe('string');
    const signature = sign('SHA256', Buffer.from(mobileNonce!, 'utf8'), key).toString('base64');
    return { type: 'mobile_hw_key', credentialId: deviceId, nonce: mobileNonce, signature };
  }

  runDb('one code satisfies both the second factor and the re-authentication: approved', async () => {
    const { grantId, approvalId, deviceId, key } = await soleOperatorRow();
    const proof = await proofFor(approvalId, deviceId, key, false);
    const code = await generate({ secret: f.requester.secret });

    const res = await post(f, f.requester, `/approvals/${approvalId}/approve`, { proof, reauthMfaCode: code }, { mfa: false });

    expect(res.status).toBe(200);
    expect(await state(approvalId, grantId)).toMatchObject({ approval: 'approved', grant: 'active' });
  });

  runDb('the assertion and a password, without MFA or a code: 403 MFA_REQUIRED, nothing written', async () => {
    const { grantId, approvalId, deviceId, key } = await soleOperatorRow();
    const proof = await proofFor(approvalId, deviceId, key, false);

    const res = await post(f, f.requester, `/approvals/${approvalId}/approve`, { proof, reauthPassword: PASSWORD }, { mfa: false });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'MFA required', code: 'MFA_REQUIRED' });
    expect(await state(approvalId, grantId)).toEqual({ approval: 'pending', grant: 'pending_approval', decidedAt: null });

    // The refusal used no challenge: the same signed proof, sent again with a
    // code, is accepted.
    const code = await generate({ secret: f.requester.secret });
    const retry = await post(f, f.requester, `/approvals/${approvalId}/approve`, { proof, reauthMfaCode: code }, { mfa: false });
    expect(retry.status).toBe(200);
    expect(await state(approvalId, grantId)).toMatchObject({ approval: 'approved', grant: 'active' });
  });

  runDb('a code without the hardware-backed assertion is still refused for the assertion', async () => {
    const { grantId, approvalId } = await soleOperatorRow();
    const code = await generate({ secret: f.requester.secret });

    const res = await post(f, f.requester, `/approvals/${approvalId}/approve`, { reauthMfaCode: code }, { mfa: false });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'step_up_required', requiredLevel: 3 });
    expect(await state(approvalId, grantId)).toMatchObject({ approval: 'pending', grant: 'pending_approval' });
  });

  runDb('a session with MFA, the assertion and a password: approved', async () => {
    const { grantId, approvalId, deviceId, key } = await soleOperatorRow();
    const proof = await proofFor(approvalId, deviceId, key, true);

    const res = await post(f, f.requester, `/approvals/${approvalId}/approve`, { proof, reauthPassword: PASSWORD }, { mfa: true });

    expect(res.status).toBe(200);
    expect(await state(approvalId, grantId)).toMatchObject({ approval: 'approved', grant: 'active' });
  });

  runDb('the requester can deny their own request from a session without MFA', async () => {
    const { grantId, approvalId } = await soleOperatorRow();

    const res = await post(f, f.requester, `/approvals/${approvalId}/deny`, {}, { mfa: false });

    expect(res.status).toBe(200);
    expect(await state(approvalId, grantId)).toMatchObject({ approval: 'denied', grant: 'denied' });
  });
});
