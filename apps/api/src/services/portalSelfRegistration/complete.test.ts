import { beforeEach, describe, expect, it, vi } from 'vitest';

// Portal registration W6, plan Task 4 (D8 re-validation, D10 outcomes).
// Every collaborator is mocked at its boundary; the real-DB proofs are in
// __tests__/integration/portalSelfRegistration.integration.test.ts.

const mocks = vi.hoisted(() => ({
  getActiveOrgTenant: vi.fn(),
  isDomainVerifiedForOrg: vi.fn(),
  resolvePortalAccessPolicy: vi.fn(),
  createPortalAccessRequest: vi.fn(),
  lockPortalInviteAddresses: vi.fn(),
  linkLoginToContact: vi.fn(),
  issuePortalCapabilityToken: vi.fn(),
  accountRows: { current: [] as Array<{ id: string }> },
  inserted: [] as Array<Record<string, unknown>>,
  updates: { count: 0 },
  systemContexts: { count: 0, open: 0 },
  order: [] as string[],
}));

vi.mock('../tenantStatus', () => ({ getActiveOrgTenant: (...a: unknown[]) => { mocks.order.push('org'); return mocks.getActiveOrgTenant(...a); } }));
vi.mock('../portalDomainVerification', () => ({
  isDomainVerifiedForOrg: (...a: unknown[]) => {
    mocks.order.push('domain');
    // The W5 read API throws inside a request transaction.
    if (mocks.systemContexts.open > 0) throw new Error('must not run inside a request transaction');
    return mocks.isDomainVerifiedForOrg(...a);
  },
}));
vi.mock('../portalAccessPolicy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../portalAccessPolicy')>()),
  resolvePortalAccessPolicy: (...a: unknown[]) => { mocks.order.push('policy'); return mocks.resolvePortalAccessPolicy(...a); },
}));
vi.mock('../portalAccessRequests', () => ({ createPortalAccessRequest: mocks.createPortalAccessRequest }));
vi.mock('../contacts/portalInvite', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../contacts/portalInvite')>()),
  lockPortalInviteAddresses: mocks.lockPortalInviteAddresses,
}));
vi.mock('../contacts/loginLink', () => ({ linkLoginToContact: mocks.linkLoginToContact }));
vi.mock('../../routes/portal/capabilityTokens', () => ({ issuePortalCapabilityToken: mocks.issuePortalCapabilityToken }));
vi.mock('../../db', () => ({
  db: {
    select: () => {
      const chain: any = {
        from: () => chain,
        where: () => chain,
        limit: () => { mocks.order.push('existing'); return Promise.resolve(mocks.accountRows.current); },
      };
      return chain;
    },
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        mocks.inserted.push(v);
        return { returning: () => Promise.resolve([{ id: 'new-user', authEpoch: 1 }]) };
      },
    }),
    update: () => { mocks.updates.count += 1; throw new Error('self-registration must never update'); },
  },
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => {
    mocks.systemContexts.count += 1;
    mocks.systemContexts.open += 1;
    try { return await fn(); } finally { mocks.systemContexts.open -= 1; }
  },
}));

import { completePortalSelfRegistration } from './complete';
import { PortalAccessPolicyOrgNotFoundError } from '../portalAccessPolicy';
import type { PortalSelfRegistrationPayload } from '../../routes/portal/capabilityTokens';

const ORG = '7c0a1f7e-1111-4222-8333-444455556666';
const OTHER_ORG = '7c0a1f7e-2222-4222-8333-444455556666';
const FP = 'f'.repeat(64);
const NOW = new Date('2027-01-25T10:00:00.000Z');
const payload = (over: Partial<PortalSelfRegistrationPayload> = {}): PortalSelfRegistrationPayload => ({
  v: 2, purpose: 'self_register', orgId: ORG, email: 'pat@contoso.example.com', name: 'Pat Doe',
  domain: 'contoso.example.com', policyFingerprint: FP, ...over,
});
const policy = (mode: 'off' | 'approval' | 'instant', fingerprint = FP) => ({
  orgId: ORG, partnerId: 'p-1', entraTenant: null, passwordModeFallback: false, fingerprint,
  effective: { selfRegistrationMode: { value: mode, source: 'org' } },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.accountRows.current = [];
  mocks.inserted.length = 0;
  mocks.updates.count = 0;
  mocks.systemContexts.count = 0;
  mocks.systemContexts.open = 0;
  mocks.order.length = 0;
  mocks.getActiveOrgTenant.mockResolvedValue({ orgId: ORG, partnerId: 'p-1' });
  mocks.isDomainVerifiedForOrg.mockResolvedValue(true);
  mocks.resolvePortalAccessPolicy.mockResolvedValue(policy('approval'));
  mocks.createPortalAccessRequest.mockResolvedValue({ kind: 'created', requestId: 'req-1' });
  mocks.lockPortalInviteAddresses.mockResolvedValue(undefined);
  mocks.linkLoginToContact.mockResolvedValue({ contactId: 'contact-1', outcome: 'linked' });
  mocks.issuePortalCapabilityToken.mockResolvedValue('invite-raw');
});

describe('completePortalSelfRegistration — approval (D10)', () => {
  it('approval mode creates a self request and returns request_sent', async () => {
    expect(await completePortalSelfRegistration(payload(), NOW)).toEqual({ outcome: 'request_sent', orgId: ORG, requestId: 'req-1', created: true });
    expect(mocks.createPortalAccessRequest).toHaveBeenCalledWith({ source: 'self', orgId: ORG, email: 'pat@contoso.example.com', name: 'Pat Doe' }, NOW);
    expect(mocks.inserted).toHaveLength(0);
  });

  it('a repeat within 14 days bumps the pending request (created: false)', async () => {
    mocks.createPortalAccessRequest.mockResolvedValue({ kind: 'already_pending', requestId: 'req-1' });
    expect(await completePortalSelfRegistration(payload(), NOW)).toEqual({ outcome: 'request_sent', orgId: ORG, requestId: 'req-1', created: false });
  });

  it('a capped org returns request_unavailable', async () => {
    mocks.createPortalAccessRequest.mockResolvedValue({ kind: 'capped' });
    expect(await completePortalSelfRegistration(payload(), NOW)).toEqual({ outcome: 'request_unavailable', orgId: ORG });
  });
});

describe('completePortalSelfRegistration — instant (D10)', () => {
  beforeEach(() => mocks.resolvePortalAccessPolicy.mockResolvedValue(policy('instant')));

  it('instant mode creates an invited, browser-granted password account linked to its contact and returns an invite token', async () => {
    const out = await completePortalSelfRegistration(payload(), NOW);
    expect(out).toEqual({ outcome: 'account_created', orgId: ORG, portalUserId: 'new-user', inviteToken: 'invite-raw' });
    expect(mocks.lockPortalInviteAddresses).toHaveBeenCalledWith(expect.anything(), ORG, ['pat@contoso.example.com']);
    expect(mocks.linkLoginToContact).toHaveBeenCalledWith(expect.anything(), {
      orgId: ORG, email: 'pat@contoso.example.com', name: 'Pat Doe', actor: { userId: null }, roles: ['portal'], unionRoles: ['portal'],
    });
    expect(mocks.inserted).toEqual([{
      orgId: ORG, email: 'pat@contoso.example.com', name: 'Pat Doe', passwordHash: null, authMethod: 'password',
      status: 'invited', browserAccess: 'granted', invitedAt: NOW, invitedBy: null, contactId: 'contact-1',
    }]);
    // Minted after the write transaction closed.
    expect(mocks.issuePortalCapabilityToken).toHaveBeenCalledWith({ purpose: 'invite', portalUserId: 'new-user', orgId: ORG, email: 'pat@contoso.example.com', authEpoch: 1 });
    expect(mocks.createPortalAccessRequest).not.toHaveBeenCalled();
  });

  it('a token store outage leaves the account and returns a null invite token', async () => {
    mocks.issuePortalCapabilityToken.mockResolvedValue(null);
    expect(await completePortalSelfRegistration(payload(), NOW)).toEqual({ outcome: 'account_created', orgId: ORG, portalUserId: 'new-user', inviteToken: null });
  });

  it('instant mode never modifies an existing account at the address', async () => {
    mocks.accountRows.current = [{ id: 'existing-user' }];
    expect(await completePortalSelfRegistration(payload(), NOW)).toEqual({ outcome: 'existing_account', orgId: ORG });
    expect(mocks.inserted).toHaveLength(0);
    expect(mocks.updates.count).toBe(0);
    expect(mocks.linkLoginToContact).not.toHaveBeenCalled();
    expect(mocks.issuePortalCapabilityToken).not.toHaveBeenCalled();
  });

  it('an ambiguous contact match creates the account with contactId null, as an invite does', async () => {
    mocks.linkLoginToContact.mockResolvedValue({ contactId: null, outcome: 'ambiguous' });
    await completePortalSelfRegistration(payload(), NOW);
    expect(mocks.inserted[0]).toMatchObject({ contactId: null });
  });
});

describe('completePortalSelfRegistration — existing accounts and re-validation (D8)', () => {
  it('an account created between email and click returns existing_account in both modes', async () => {
    mocks.accountRows.current = [{ id: 'raced-invite' }];
    expect(await completePortalSelfRegistration(payload(), NOW)).toEqual({ outcome: 'existing_account', orgId: ORG });
    expect(mocks.createPortalAccessRequest).not.toHaveBeenCalled();
    mocks.resolvePortalAccessPolicy.mockResolvedValue(policy('instant'));
    expect(await completePortalSelfRegistration(payload(), NOW)).toEqual({ outcome: 'existing_account', orgId: ORG });
    expect(mocks.inserted).toHaveLength(0);
  });

  it('consume refuses when the domain was cleared after issue', async () => {
    mocks.isDomainVerifiedForOrg.mockResolvedValue(false);
    expect(await completePortalSelfRegistration(payload(), NOW)).toEqual({ outcome: 'refused', reason: 'domain_not_verified' });
    expect(mocks.createPortalAccessRequest).not.toHaveBeenCalled();
    expect(mocks.inserted).toHaveLength(0);
  });

  it('consume refuses when the domain moved to another org', async () => {
    // W5 now maps the domain to OTHER_ORG: verified for that org, not for ORG.
    mocks.isDomainVerifiedForOrg.mockImplementation(async (_d: string, orgId: string) => orgId === OTHER_ORG);
    expect(await completePortalSelfRegistration(payload(), NOW)).toEqual({ outcome: 'refused', reason: 'domain_not_verified' });
    expect(mocks.isDomainVerifiedForOrg).toHaveBeenCalledWith('contoso.example.com', ORG);
    expect(mocks.createPortalAccessRequest).not.toHaveBeenCalled();
  });

  it('consume re-derives the domain from the address, not only the payload field', async () => {
    // A payload whose domain field disagrees with its address is refused.
    expect(await completePortalSelfRegistration(payload({ domain: 'other.example.com' }), NOW)).toEqual({ outcome: 'refused', reason: 'domain_not_verified' });
    expect(mocks.isDomainVerifiedForOrg).not.toHaveBeenCalled();
  });

  it('consume refuses after a policy change (fingerprint)', async () => {
    mocks.resolvePortalAccessPolicy.mockResolvedValue(policy('approval', 'e'.repeat(64)));
    expect(await completePortalSelfRegistration(payload(), NOW)).toEqual({ outcome: 'refused', reason: 'policy_changed' });
    expect(mocks.createPortalAccessRequest).not.toHaveBeenCalled();
  });

  it('consume succeeds when an unrelated org\'s policy changes', async () => {
    // The resolver is asked for THIS org only; its fingerprint is unchanged.
    mocks.resolvePortalAccessPolicy.mockImplementation(async (orgId: string) => (orgId === ORG ? policy('approval') : policy('approval', 'd'.repeat(64))));
    expect(await completePortalSelfRegistration(payload(), NOW)).toMatchObject({ outcome: 'request_sent' });
    expect(mocks.resolvePortalAccessPolicy).toHaveBeenCalledWith(ORG);
  });

  it('consume refuses for an inactive org, and for mode off (as a generic refusal)', async () => {
    mocks.getActiveOrgTenant.mockResolvedValue(null);
    expect(await completePortalSelfRegistration(payload(), NOW)).toMatchObject({ outcome: 'refused' });
    expect(mocks.isDomainVerifiedForOrg).not.toHaveBeenCalled();

    mocks.getActiveOrgTenant.mockResolvedValue({ orgId: ORG, partnerId: 'p-1' });
    mocks.resolvePortalAccessPolicy.mockResolvedValue(policy('off'));
    expect(await completePortalSelfRegistration(payload(), NOW)).toMatchObject({ outcome: 'refused' });

    mocks.resolvePortalAccessPolicy.mockRejectedValue(new PortalAccessPolicyOrgNotFoundError(ORG));
    expect(await completePortalSelfRegistration(payload(), NOW)).toMatchObject({ outcome: 'refused' });
    expect(mocks.createPortalAccessRequest).not.toHaveBeenCalled();
    expect(mocks.inserted).toHaveLength(0);
  });

  it('checks in order: active org, domain, policy, existing account', async () => {
    await completePortalSelfRegistration(payload(), NOW);
    expect(mocks.order).toEqual(['org', 'domain', 'policy', 'existing']);
  });

  it('the W5 read runs with no DB context held', async () => {
    mocks.resolvePortalAccessPolicy.mockResolvedValue(policy('instant'));
    // The isDomainVerifiedForOrg mock throws if called inside a context.
    await expect(completePortalSelfRegistration(payload(), NOW)).resolves.toMatchObject({ outcome: 'account_created' });
  });
});
