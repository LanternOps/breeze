/**
 * Real-PostgreSQL passkey assertion finalization regressions.
 *
 * WebAuthn cryptographic verification is stubbed so the tests can force exact
 * counter snapshots. Pending MFA, transition leases, counter CAS, family
 * issuance, transaction rollback, RLS, and response cookies are all real.
 */
import './setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getTestDb } from './setup';
import { refreshTokenFamilies, userPasskeys, users } from '../../db/schema';
import {
  assignUserToPartner,
  createPartner,
  createRole,
  createUser,
} from './db-utils';
import { createMfaBrowserTransitionFixture } from './mfa-browser-transition-fixture';
import { createPendingMfa } from '../../services/mfaAssurance';

vi.mock('../../services/passkeys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/passkeys')>();
  return {
    ...actual,
    verifyPasskeyAuthentication: vi.fn(),
  };
});

import { verifyPasskeyAuthentication } from '../../services/passkeys';
import { passkeyRoutes } from '../../routes/auth/passkeys';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('POST /auth/mfa/passkey/verify counter finalization', () => {
  let app: Hono;

  beforeEach(() => {
    app = new Hono();
    app.route('/auth', passkeyRoutes);
    vi.mocked(verifyPasskeyAuthentication).mockReset();
  });

  async function seedPasskeyMfaUser(counter: number) {
    const tdb = getTestDb();
    const partner = await createPartner();
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    const created = await createUser({ partnerId: partner.id, mfaEnabled: true });
    await assignUserToPartner(created.id, partner.id, role.id, 'all');
    const [user] = await tdb
      .update(users)
      .set({ mfaMethod: 'passkey' })
      .where(eq(users.id, created.id))
      .returning();
    if (!user) throw new Error('failed to seed passkey MFA user');

    const credentialId = `cred-${user.id}`;
    const [passkey] = await tdb
      .insert(userPasskeys)
      .values({
        userId: user.id,
        credentialId,
        publicKey: 'dGVzdC1wdWJsaWMta2V5',
        counter,
        deviceType: 'singleDevice',
        backedUp: false,
        lastUsedAt: null,
      })
      .returning();
    if (!passkey) throw new Error('failed to seed passkey');
    return { partner, role, user, passkey, credentialId };
  }

  async function createPendingPasskeyLogin(input: Awaited<ReturnType<typeof seedPasskeyMfaUser>>) {
    const transition = await createMfaBrowserTransitionFixture();
    const tempToken = await createPendingMfa({
      userId: input.user.id,
      authEpoch: input.user.authEpoch,
      mfaEpoch: input.user.mfaEpoch,
      expectedStatus: 'active',
      roleId: input.role.id,
      orgId: null,
      partnerId: input.partner.id,
      scope: 'partner',
      policyRequired: false,
      policySources: [],
      allowedMethods: new Set(['totp', 'sms', 'passkey', 'recovery_code']),
      enrolledMethods: new Set(['passkey']),
      primaryAuthenticationMethod: 'password',
      configuredMfaMethod: 'passkey',
      primaryMfaMethod: 'passkey',
      browserTransitionId: transition.browserTransitionId,
      browserGeneration: transition.browserGeneration,
    });
    return { tempToken, transition };
  }

  function submit(input: {
    tempToken: string;
    cookieHeader: string;
    credentialId: string;
  }) {
    return app.request('/auth/mfa/passkey/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: input.cookieHeader,
      },
      body: JSON.stringify({
        tempToken: input.tempToken,
        credential: { id: input.credentialId, response: {} },
      }),
    });
  }

  it('persists metadata and issues one family from the verified counter snapshot', async () => {
    const tdb = getTestDb();
    const seeded = await seedPasskeyMfaUser(0);
    const pending = await createPendingPasskeyLogin(seeded);
    vi.mocked(verifyPasskeyAuthentication).mockResolvedValue({
      verified: true,
      authenticationInfo: {
        newCounter: 42,
        credentialDeviceType: 'multiDevice',
        credentialBackedUp: true,
      },
    } as Awaited<ReturnType<typeof verifyPasskeyAuthentication>>);

    const response = await submit({
      tempToken: pending.tempToken,
      cookieHeader: pending.transition.cookieHeader,
      credentialId: seeded.credentialId,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('breeze_refresh_token=');
    const [after] = await tdb.select().from(userPasskeys)
      .where(eq(userPasskeys.id, seeded.passkey.id));
    expect(after).toMatchObject({
      counter: 42,
      deviceType: 'multiDevice',
      backedUp: true,
    });
    expect(after?.lastUsedAt).not.toBeNull();
  });

  it('rolls back a stale reverse-commit finalizer without a family or cookie', async () => {
    const tdb = getTestDb();
    const seeded = await seedPasskeyMfaUser(3);
    const stalePending = await createPendingPasskeyLogin(seeded);
    const newerPending = await createPendingPasskeyLogin(seeded);
    const staleVerifierEntered = deferred<void>();
    const releaseStaleVerifier = deferred<Awaited<ReturnType<typeof verifyPasskeyAuthentication>>>();
    vi.mocked(verifyPasskeyAuthentication)
      .mockImplementationOnce(async () => {
        staleVerifierEntered.resolve();
        return releaseStaleVerifier.promise;
      })
      .mockResolvedValueOnce({
        verified: true,
        authenticationInfo: {
          newCounter: 7,
          credentialDeviceType: 'singleDevice',
          credentialBackedUp: false,
        },
      } as Awaited<ReturnType<typeof verifyPasskeyAuthentication>>);

    const staleResponsePromise = submit({
      tempToken: stalePending.tempToken,
      cookieHeader: stalePending.transition.cookieHeader,
      credentialId: seeded.credentialId,
    });
    await staleVerifierEntered.promise;

    const newerResponse = await submit({
      tempToken: newerPending.tempToken,
      cookieHeader: newerPending.transition.cookieHeader,
      credentialId: seeded.credentialId,
    });
    expect(newerResponse.status).toBe(200);

    releaseStaleVerifier.resolve({
      verified: true,
      authenticationInfo: {
        newCounter: 5,
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
      },
    } as Awaited<ReturnType<typeof verifyPasskeyAuthentication>>);
    const staleResponse = await staleResponsePromise;

    expect(staleResponse.status).toBe(401);
    expect(staleResponse.headers.get('set-cookie')).toBeNull();
    const [after] = await tdb.select().from(userPasskeys)
      .where(eq(userPasskeys.id, seeded.passkey.id));
    expect(after?.counter).toBe(7);
    const families = await tdb.select().from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.userId, seeded.user.id));
    expect(families).toHaveLength(1);
  });
});
