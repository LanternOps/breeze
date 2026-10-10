/**
 * A partner service principal key is bound to its owner's credential state:
 * once the owner's credential epoch (password change/reset, invite acceptance,
 * admin status change) or MFA epoch (factor change) moves past the value
 * stamped at issue, the key no longer authenticates on either lane.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rowRef = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock('../db', () => {
  const chain: any = {};
  for (const method of ['select', 'from', 'innerJoin', 'where']) chain[method] = vi.fn(() => chain);
  chain.limit = vi.fn(async () => (rowRef.current ? [rowRef.current] : []));
  return {
    db: chain,
    withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
  };
});

import { loadPartnerServicePrincipalCredential } from './partnerServicePrincipalCredential';

const OWNER = '66666666-6666-4666-8666-666666666666';

function liveRow(overrides: Record<string, unknown> = {}) {
  return {
    keyId: 'key-1',
    keyStatus: 'active',
    keyExpiresAt: null,
    keyCreatedBy: OWNER,
    keyOwnerCredentialEpoch: 3,
    keyOwnerMfaEpoch: 5,
    rateLimit: 600,
    partnerServicePrincipalId: 'sp-1',
    partnerId: 'p-1',
    name: 'Automation',
    principalCreatedBy: OWNER,
    principalStatus: 'active',
    principalExpiresAt: null,
    scopes: ['devices:read'],
    sourceCidrs: [],
    partnerStatus: 'active',
    partnerDeletedAt: null,
    ownerStatus: 'active',
    ownerCredentialEpoch: 3,
    ownerMfaEpoch: 5,
    ...overrides,
  };
}

describe('partner service principal key: owner credential binding', () => {
  beforeEach(() => {
    rowRef.current = liveRow();
  });

  it('authenticates while the owner\'s credential and MFA epochs match the key', async () => {
    const loaded = await loadPartnerServicePrincipalCredential('hash', undefined);
    expect(loaded.ownerUserId).toBe(OWNER);
    expect(loaded.keyIssuedBy).toBe(OWNER);
  });

  it('stops authenticating after the owner\'s password is changed or reset', async () => {
    rowRef.current = liveRow({ ownerCredentialEpoch: 4 });
    await expect(loadPartnerServicePrincipalCredential('hash', undefined)).rejects.toMatchObject({ status: 401 });
  });

  it('stops authenticating after the owner\'s MFA factors change', async () => {
    rowRef.current = liveRow({ ownerMfaEpoch: 6 });
    await expect(loadPartnerServicePrincipalCredential('hash', undefined)).rejects.toMatchObject({ status: 401 });
  });

  it('stops authenticating while the owner\'s account is not active', async () => {
    rowRef.current = liveRow({ ownerStatus: 'disabled' });
    await expect(loadPartnerServicePrincipalCredential('hash', undefined)).rejects.toMatchObject({ status: 401 });
  });

  it('refuses a key that carries no owner credential snapshot', async () => {
    rowRef.current = liveRow({ keyOwnerCredentialEpoch: null });
    await expect(loadPartnerServicePrincipalCredential('hash', undefined)).rejects.toMatchObject({ status: 401 });
  });
});
