import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #4067 — direct unit coverage of finalizeSsoPendingLink's live-revalidation
 * guards. These guards ARE the security value of the ceremony's terminal step
 * (the pending record is minutes old; everything it asserts must be re-proven
 * against live state after the atomic consume). Each guard gets its own test
 * that asserts the exact audit reason, so deleting or reordering any single
 * guard goes red here — route-level suites mock this module wholesale and
 * cannot see a regression inside it.
 */

const { tableRows, auditSpy } = vi.hoisted(() => ({
  // Keyed per-table row queues — dispatch happens on the actual schema table
  // object passed to .from(), so an under-supplied queue can never let a later
  // read silently satisfy an earlier guard (the positional-mock trap).
  tableRows: new Map<unknown, unknown[][]>(),
  auditSpy: vi.fn(),
}));

vi.mock('../../db', () => {
  const chainFor = (table: unknown) => {
    const queue = tableRows.get(table);
    const rows = queue && queue.length > 0 ? queue.shift()! : [];
    const chain: any = {
      innerJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      limit: vi.fn(() => Promise.resolve(rows)),
    };
    return chain;
  };
  return {
    db: {
      select: vi.fn(() => ({ from: vi.fn((table: unknown) => chainFor(table)) })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve([{ id: 'new-identity' }])),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve(undefined)) })),
      })),
    },
    withSystemDbAccessContext: vi.fn(async (cb: () => unknown) => cb()),
  };
});

vi.mock('../../services', () => ({
  createSession: vi.fn(),
  getUserEpochs: vi.fn().mockResolvedValue({ authEpoch: 1, mfaEpoch: 1 }),
}));

vi.mock('../../services/userSession', () => ({
  issueUserSession: vi.fn().mockResolvedValue({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    refreshJti: 'jti-1',
    expiresInSeconds: 900,
    familyId: 'family-1',
    transitionId: '00000000-0000-4000-8000-0000000000b1',
    generation: 7,
  }),
  bindIssuedUserSession: vi.fn(),
}));

vi.mock('../../services/authBrowserTransition', () => ({
  beginAuthIssuanceForStoredTransition: vi.fn(),
  finishAuthIssuance: vi.fn(),
  cancelAuthIssuance: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/ssoBrowserTransition', () => ({
  lockSsoProviderAuthority: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../../services/recoveryCodeAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/recoveryCodeAuth')>()),
  consumeRecoveryCode: vi.fn(),
}));

vi.mock('../../services/mfaPolicy', () => ({
  getEffectiveMfaPolicy: vi.fn().mockResolvedValue({
    required: false,
    allowedMethods: { totp: true, sms: true, passkey: true },
  }),
}));

vi.mock('../../services/clientIp', () => ({
  getTrustedClientIp: vi.fn(() => '203.0.113.10'),
}));

vi.mock('../../services/ssoDomainVerification', () => ({
  isDomainVerifiedForOrg: vi.fn().mockResolvedValue(true),
  isSsoProvisioningBlocked: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: auditSpy,
}));

vi.mock('../../services/ssoPendingLink', () => ({
  consumeSsoPendingLink: vi.fn(),
  restoreConsumedSsoPendingLink: vi.fn().mockResolvedValue(true),
}));

vi.mock('./helpers', () => ({
  auditLogin: vi.fn(),
}));

import { finalizeSsoPendingLink } from './ssoLinkCompletion';
import { db } from '../../db';
import { users, ssoProviders, organizationUsers, userSsoIdentities } from '../../db/schema';
import { consumeSsoPendingLink, restoreConsumedSsoPendingLink } from '../../services/ssoPendingLink';
import { getUserEpochs } from '../../services';
import { issueUserSession } from '../../services/userSession';
import { beginAuthIssuanceForStoredTransition, cancelAuthIssuance, finishAuthIssuance } from '../../services/authBrowserTransition';
import { consumeRecoveryCode, RecoveryCodeInvalidError } from '../../services/recoveryCodeAuth';
import { isDomainVerifiedForOrg, isSsoProvisioningBlocked } from '../../services/ssoDomainVerification';

const USER_ID = '00000000-0000-4000-8000-0000000000aa';
const PROVIDER_ID = '00000000-0000-4000-8000-0000000000bb';
const ORG_ID = '00000000-0000-4000-8000-0000000000cc';

const RECORD = {
  userId: USER_ID,
  userEmail: 'v@example.com',
  authEpoch: 1,
  mfaEpoch: 1,
  browserTransitionId: '00000000-0000-4000-8000-0000000000b1',
  browserGeneration: 7,
  providerId: PROVIDER_ID,
  providerOrgId: ORG_ID,
  providerPartnerId: null,
  providerConfigVersion: 3,
  externalSub: 'external-sub-1',
  email: 'v@example.com',
  name: 'V',
  profile: { sub: 'external-sub-1' },
  encryptedAccessToken: 'enc:a',
  encryptedRefreshToken: 'enc:r',
  tokenExpiresAt: null,
  idpMfaAsserted: false,
  emailVerifiedClaim: 'true',
  redirectUrl: '/dashboard',
  createdAt: Date.now(),
};

const USER_ROW = {
  id: USER_ID,
  email: 'v@example.com',
  name: 'V',
  orgId: null,
  status: 'active',
  passwordHash: '$argon2id$hash',
  mfaEnabled: false,
  authEpoch: 1,
  mfaEpoch: 1,
};

const PROVIDER_ROW = {
  id: PROVIDER_ID,
  orgId: ORG_ID,
  partnerId: null,
  name: 'Org IdP',
  status: 'active',
  configVersion: 3,
  trustsIdpMfa: false,
};

const MEMBERSHIP_ROW = { orgId: ORG_ID, roleId: 'role-1', roleName: 'Member', roleScope: 'organization' };

const c = { req: { header: () => 'vitest-ua' } } as never;

function wire(opts: {
  record?: Record<string, unknown> | null;
  user?: Record<string, unknown> | null;
  provider?: Record<string, unknown> | null;
  membership?: Record<string, unknown> | null;
  identity?: Record<string, unknown> | null;
} = {}) {
  const record = opts.record === undefined ? RECORD : opts.record;
  vi.mocked(consumeSsoPendingLink).mockResolvedValue(record as never);
  tableRows.set(users, [opts.user === undefined ? [USER_ROW] : opts.user ? [opts.user] : []]);
  tableRows.set(ssoProviders, [opts.provider === undefined ? [PROVIDER_ROW] : opts.provider ? [opts.provider] : []]);
  tableRows.set(organizationUsers, [opts.membership === undefined ? [MEMBERSHIP_ROW] : opts.membership ? [opts.membership] : []]);
  tableRows.set(userSsoIdentities, [opts.identity === undefined ? [] : opts.identity ? [opts.identity] : []]);
}

function lastRejectionReason(): unknown {
  const rejections = auditSpy.mock.calls.filter(
    (call: unknown[]) => (call[1] as { action?: string }).action === 'sso.link.ceremony_rejected',
  );
  const call = rejections[rejections.length - 1];
  return call ? (call[1] as { details?: { reason?: unknown } }).details?.reason : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  tableRows.clear();
  vi.mocked(getUserEpochs).mockResolvedValue({ authEpoch: 1, mfaEpoch: 1 } as never);
  vi.mocked(isDomainVerifiedForOrg).mockResolvedValue(true);
  vi.mocked(isSsoProvisioningBlocked).mockResolvedValue(false);
  const capability = {
    transitionId: RECORD.browserTransitionId,
    generation: RECORD.browserGeneration,
    operationId: '00000000-0000-4000-8000-0000000000b2',
    expiresAt: new Date(Date.now() + 60_000),
  } as never;
  vi.mocked(beginAuthIssuanceForStoredTransition).mockResolvedValue({ capability, claimed: undefined } as never);
  vi.mocked(finishAuthIssuance).mockImplementation(async (_capability, callback) => callback(db as never) as never);
});

describe('finalizeSsoPendingLink — live revalidation guards (#4067)', () => {
  it('completes on a fully valid record: links, mints, audits sso.identity.linked, normalizes the relay path', async () => {
    wire();
    const outcome = await finalizeSsoPendingLink(c, 'hash-1', { breezeMfaVerified: false });
    expect(outcome).toMatchObject({
      ok: true,
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresInSeconds: 900,
      redirectPath: '/dashboard',
    });
    expect(issueUserSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, scope: 'organization', orgId: ORG_ID }),
      expect.any(Object),
    );
    const linked = auditSpy.mock.calls.find(([, p]) => (p as { action?: string }).action === 'sso.identity.linked');
    expect(linked).toBeTruthy();
  });

  it('reuses an already-admitted MFA capability instead of reserving a second operation', async () => {
    wire();
    const capability = {
      transitionId: RECORD.browserTransitionId,
      generation: RECORD.browserGeneration,
      operationId: '00000000-0000-4000-8000-0000000000c1',
      expiresAt: new Date(Date.now() + 60_000),
    } as never;

    const outcome = await finalizeSsoPendingLink(c, 'hash-1', {
      breezeMfaVerified: true,
      expectedUserId: USER_ID,
      capability,
    });

    expect(outcome.ok).toBe(true);
    expect(beginAuthIssuanceForStoredTransition).not.toHaveBeenCalled();
    expect(finishAuthIssuance).toHaveBeenCalledWith(capability, expect.any(Function));
  });

  it('consumes a recovery code inside guarded finalization and rejects an invalid code', async () => {
    wire();
    vi.mocked(consumeRecoveryCode).mockRejectedValueOnce(new RecoveryCodeInvalidError());

    const outcome = await finalizeSsoPendingLink(c, 'hash-1', {
      breezeMfaVerified: true,
      expectedUserId: USER_ID,
      recoveryCode: 'ABCD-2345',
    });

    expect(outcome).toEqual({ ok: false, error: 'invalid_mfa_code' });
    expect(restoreConsumedSsoPendingLink).toHaveBeenCalledWith('hash-1', RECORD);
    expect(consumeRecoveryCode).toHaveBeenCalledWith(expect.anything(), USER_ID, 'ABCD-2345');
    expect(issueUserSession).not.toHaveBeenCalled();
    expect(cancelAuthIssuance).toHaveBeenCalledOnce();

    wire();
    const retry = await finalizeSsoPendingLink(c, 'hash-1', {
      breezeMfaVerified: true,
      expectedUserId: USER_ID,
      recoveryCode: 'CORRECT-1',
    });
    expect(retry.ok).toBe(true);
  });

  it('returns link_expired when the record is gone (expired / already consumed / store down)', async () => {
    wire({ record: null });
    const outcome = await finalizeSsoPendingLink(c, 'hash-1', { breezeMfaVerified: false });
    expect(outcome).toEqual({ ok: false, error: 'link_expired' });
    expect(issueUserSession).not.toHaveBeenCalled();
  });

  it('refuses a pending-MFA record stitched to a DIFFERENT account (user_binding_mismatch)', async () => {
    wire();
    const outcome = await finalizeSsoPendingLink(c, 'hash-1', {
      breezeMfaVerified: true,
      expectedUserId: 'someone-else',
    });
    expect(outcome).toEqual({ ok: false, error: 'link_expired' });
    expect(lastRejectionReason()).toBe('user_binding_mismatch');
    expect(issueUserSession).not.toHaveBeenCalled();
  });

  it.each([
    ['user_missing', { user: null }],
    ['status_changed', { user: { ...USER_ROW, status: 'suspended' } }],
    ['email_changed', { user: { ...USER_ROW, email: 'renamed@example.com' } }],
    ['password_removed', { user: { ...USER_ROW, passwordHash: null } }],
  ] as const)('voids the ceremony when the live account drifted: %s', async (reason, overrides) => {
    wire(overrides as never);
    const outcome = await finalizeSsoPendingLink(c, 'hash-1', { breezeMfaVerified: false });
    expect(outcome).toEqual({ ok: false, error: 'link_expired' });
    expect(lastRejectionReason()).toBe(reason);
    expect(issueUserSession).not.toHaveBeenCalled();
  });

  it('voids the ceremony on an auth/mfa epoch advance (password reset or factor change mid-window)', async () => {
    wire();
    vi.mocked(getUserEpochs).mockResolvedValue({ authEpoch: 2, mfaEpoch: 1 } as never);
    const outcome = await finalizeSsoPendingLink(c, 'hash-1', { breezeMfaVerified: false });
    expect(outcome).toEqual({ ok: false, error: 'link_expired' });
    expect(lastRejectionReason()).toBe('epoch_mismatch');
    expect(issueUserSession).not.toHaveBeenCalled();
  });

  it.each([
    ['provider_missing', { provider: null }],
    ['provider_inactive', { provider: { ...PROVIDER_ROW, status: 'inactive' } }],
    ['provider_config_changed', { provider: { ...PROVIDER_ROW, configVersion: 4 } }],
  ] as const)('voids the ceremony when the provider drifted: %s', async (reason, overrides) => {
    wire(overrides as never);
    const outcome = await finalizeSsoPendingLink(c, 'hash-1', { breezeMfaVerified: false });
    expect(outcome).toEqual({ ok: false, error: 'link_expired' });
    expect(lastRejectionReason()).toBe(reason);
    expect(issueUserSession).not.toHaveBeenCalled();
  });

  it('re-runs the domain-ownership proof when the callback accepted an ABSENT email_verified claim', async () => {
    wire({ record: { ...RECORD, emailVerifiedClaim: 'absent' } });
    vi.mocked(isDomainVerifiedForOrg).mockResolvedValue(false);
    const outcome = await finalizeSsoPendingLink(c, 'hash-1', { breezeMfaVerified: false });
    expect(outcome).toEqual({ ok: false, error: 'link_expired' });
    expect(lastRejectionReason()).toBe('domain_proof_revoked');
    expect(issueUserSession).not.toHaveBeenCalled();
    expect(isDomainVerifiedForOrg).toHaveBeenCalledWith(ORG_ID, 'example.com');
  });

  it('does NOT consult the domain proof when email_verified was affirmatively true', async () => {
    wire();
    vi.mocked(isDomainVerifiedForOrg).mockResolvedValue(false); // would reject if consulted
    const outcome = await finalizeSsoPendingLink(c, 'hash-1', { breezeMfaVerified: false });
    expect(outcome.ok).toBe(true);
    expect(isDomainVerifiedForOrg).not.toHaveBeenCalled();
  });

  it('re-runs the domain block-list at completion', async () => {
    wire();
    vi.mocked(isSsoProvisioningBlocked).mockResolvedValue(true);
    const outcome = await finalizeSsoPendingLink(c, 'hash-1', { breezeMfaVerified: false });
    expect(outcome).toEqual({ ok: false, error: 'link_expired' });
    expect(lastRejectionReason()).toBe('domain_blocked');
    expect(issueUserSession).not.toHaveBeenCalled();
  });

  it('collapses membership/mint failures to the public completion_failed code (never raw codes on the wire)', async () => {
    wire({ membership: null });
    const outcome = await finalizeSsoPendingLink(c, 'hash-1', { breezeMfaVerified: false });
    expect(outcome).toEqual({ ok: false, error: 'completion_failed' });
    // The precise reason still lands in the audit trail.
    expect(lastRejectionReason()).toBe('no_org_access');
    expect(issueUserSession).not.toHaveBeenCalled();
  });

  it('surfaces identity_in_use when the exact (provider, sub) row belongs to another account', async () => {
    wire({ identity: { id: 'identity-x', userId: 'someone-else' } });
    const outcome = await finalizeSsoPendingLink(c, 'hash-1', { breezeMfaVerified: false });
    expect(outcome).toEqual({ ok: false, error: 'identity_in_use' });
    expect(issueUserSession).toHaveBeenCalledOnce();
  });

  it('mints mfa:true when the ceremony verified a Breeze-held factor, regardless of IdP amr', async () => {
    wire();
    const outcome = await finalizeSsoPendingLink(c, 'hash-1', { breezeMfaVerified: true, expectedUserId: USER_ID });
    expect(outcome.ok).toBe(true);
    expect(issueUserSession).toHaveBeenCalledWith(
      expect.objectContaining({ mfa: true }),
      expect.any(Object),
    );
  });
});
