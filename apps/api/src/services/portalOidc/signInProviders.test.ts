/**
 * Unit tests for the portal OIDC sign-in provider adapters (portal
 * registration W7 #11384, plan D2–D4, D15), over mocked collaborators. The
 * resolver that drives them is pinned in ./accountResolution.test.ts; the
 * real-Postgres proofs live in
 * __tests__/integration/portalGoogleSignIn.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const h = vi.hoisted(() => ({
  state: { systemDepth: 0 },
  selects: [] as Array<{ where?: unknown }>,
  results: [] as unknown[],
  db: {} as Record<string, unknown>,
}));

vi.mock('../../db', () => {
  const db = {
    select: () => {
      const call: { where?: unknown } = {};
      h.selects.push(call);
      const chain: Record<string, unknown> = {
        from: () => chain,
        where: (w: unknown) => { call.where = w; return chain; },
        limit: () => Promise.resolve(h.results.shift() ?? []),
      };
      return chain;
    },
  };
  h.db = db;
  return {
    db,
    hasDbAccessContext: () => h.state.systemDepth > 0,
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
      h.state.systemDepth += 1;
      try { return await fn(); } finally { h.state.systemDepth -= 1; }
    }),
  };
});

const m = vi.hoisted(() => ({
  findOrgByProvenEntraTenant: vi.fn(),
  resolveLinkableEntraAddress: vi.fn(),
  findOrgByVerifiedDomain: vi.fn(),
  isDomainVerifiedForOrg: vi.fn(),
  lockVerifiedDomainRow: vi.fn(),
}));

vi.mock('../portalEntraTenantProof', () => ({ findOrgByProvenEntraTenant: m.findOrgByProvenEntraTenant }));
vi.mock('../clientAiEntraAddress', () => ({ resolveLinkableEntraAddress: m.resolveLinkableEntraAddress }));
vi.mock('../portalDomainVerification', () => ({
  findOrgByVerifiedDomain: m.findOrgByVerifiedDomain,
  isDomainVerifiedForOrg: m.isDomainVerifiedForOrg,
  lockVerifiedDomainRow: m.lockVerifiedDomainRow,
}));

import { entraIssuer } from '../portalUserIdentities';
import { entraSignInProvider, googleSignInProvider, signInProviderFor } from './signInProviders';
import { PORTAL_GOOGLE_ISSUER } from './validators';
import type { PortalEntraVerifiedIdentity, PortalGoogleVerifiedIdentity } from './types';

const TID = '11111111-2222-4333-8444-555555555555';
const OID = '66666666-7777-4888-9999-000000000000';
const SUB = '109876543210987654321';
const ORG = '0b9d6a52-8f43-4c5e-9a1d-2f6c7b8e9d01';
const PARTNER = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
const HD = 'acme.example.com';
const VERIFIED_AT = new Date('2027-01-31T08:00:00.000Z');

const entra: PortalEntraVerifiedIdentity = {
  provider: 'entra',
  issuer: entraIssuer(TID),
  subject: OID,
  entraTenantId: TID,
  upn: 'Jane@Acme.Example.com',
  emailClaim: null,
  emailDomainOwnerVerified: false,
  name: 'Jane',
};

function google(over: Partial<PortalGoogleVerifiedIdentity> = {}): PortalGoogleVerifiedIdentity {
  return {
    provider: 'google',
    issuer: PORTAL_GOOGLE_ISSUER,
    subject: SUB,
    entraTenantId: null,
    upn: null,
    emailClaim: `pat@${HD}`,
    emailDomainOwnerVerified: true,
    name: 'Pat',
    googleHostedDomain: HD,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.systemDepth = 0;
  h.selects.length = 0;
  h.results.length = 0;
  m.findOrgByVerifiedDomain.mockResolvedValue({ domain: HD, orgId: ORG, partnerId: PARTNER, method: 'dns_txt', verifiedAt: VERIFIED_AT });
  m.isDomainVerifiedForOrg.mockResolvedValue(false);
  m.lockVerifiedDomainRow.mockResolvedValue(true);
  m.findOrgByProvenEntraTenant.mockResolvedValue({ orgId: ORG, partnerId: PARTNER });
  m.resolveLinkableEntraAddress.mockResolvedValue({ kind: 'linkable', email: 'Jane.Doe@acme.example.com' });
});

describe('signInProviderFor', () => {
  it('selects the adapter by provider', () => {
    expect(signInProviderFor('entra')).toBe(entraSignInProvider);
    expect(signInProviderFor('google')).toBe(googleSignInProvider);
    expect(() => signInProviderFor('github' as never)).toThrow(/no adapter/);
  });

  it('each adapter refuses an identity of the other provider (a programming error, never a fallback)', () => {
    expect(() => entraSignInProvider.identityKey(google())).toThrow(/not an Entra identity/);
    expect(() => googleSignInProvider.identityKey(entra)).toThrow(/not a Google identity/);
  });
});

describe('google adapter', () => {
  it('google resolveOrg reads findOrgByVerifiedDomain(hd) only; the email domain is never consulted', async () => {
    // inv. 2: the email sits on another domain; only the hd chooses the org.
    const identity = google({ emailClaim: 'pat@elsewhere.example.com' });
    expect(await googleSignInProvider.resolveOrg(identity)).toEqual({ orgId: ORG, proofVerifiedAt: VERIFIED_AT });
    expect(m.findOrgByVerifiedDomain).toHaveBeenCalledTimes(1);
    expect(m.findOrgByVerifiedDomain).toHaveBeenCalledWith(HD);
    expect(m.isDomainVerifiedForOrg).not.toHaveBeenCalled();
    expect(m.findOrgByProvenEntraTenant).not.toHaveBeenCalled();
    expect(h.state.systemDepth).toBe(0);
  });

  it('google resolveOrg: no current verification for the hd → null', async () => {
    m.findOrgByVerifiedDomain.mockResolvedValue(null);
    expect(await googleSignInProvider.resolveOrg(google())).toBeNull();
  });

  it.each([
    ['an Entra identity', entra],
    ['a non-Google issuer', google({ issuer: 'accounts.google.com' as typeof PORTAL_GOOGLE_ISSUER })],
    ['an empty hd', google({ googleHostedDomain: '' })],
    ['a non-lowercase hd', google({ googleHostedDomain: 'Acme.Example.com' })],
  ])('google resolveOrg refuses %s before any read', async (_name, identity) => {
    expect(await googleSignInProvider.resolveOrg(identity)).toBeNull();
    expect(m.findOrgByVerifiedDomain).not.toHaveBeenCalled();
  });

  it('google newPersonAddress links a contact only when the email domain is hd or verified for the org', async () => {
    // Email on the hd: a contact, no extra read.
    expect(await googleSignInProvider.newPersonAddress(google({ emailClaim: `Pat@${HD}` }), { orgId: ORG, partnerId: PARTNER }))
      .toEqual({ email: `pat@${HD}`, contactAddress: `pat@${HD}`, refuseIfAnyAccountAt: [`pat@${HD}`] });
    expect(m.isDomainVerifiedForOrg).not.toHaveBeenCalled();

    // A secondary domain verified for THIS org: a contact. Read with no DB context held.
    m.isDomainVerifiedForOrg.mockImplementationOnce(async () => {
      expect(h.state.systemDepth).toBe(0);
      return true;
    });
    const secondary = google({ emailClaim: 'pat@second.example.com' });
    expect(await googleSignInProvider.newPersonAddress(secondary, { orgId: ORG, partnerId: PARTNER }))
      .toEqual({ email: 'pat@second.example.com', contactAddress: 'pat@second.example.com', refuseIfAnyAccountAt: ['pat@second.example.com'] });
    expect(m.isDomainVerifiedForOrg).toHaveBeenLastCalledWith('second.example.com', ORG);

    // Not verified for the org (unverified, declared-only, or another org's): the account, no contact (D3).
    m.isDomainVerifiedForOrg.mockResolvedValue(false);
    expect(await googleSignInProvider.newPersonAddress(secondary, { orgId: ORG, partnerId: PARTNER }))
      .toEqual({ email: 'pat@second.example.com', contactAddress: null, refuseIfAnyAccountAt: ['pat@second.example.com'] });
    // W4's declared-domain rule is never consulted for Google.
    expect(m.resolveLinkableEntraAddress).not.toHaveBeenCalled();
  });

  it.each([[null], [''], ['not-an-address'], ['pat@']])('google newPersonAddress: email claim %j → null (no_address)', async (emailClaim) => {
    expect(await googleSignInProvider.newPersonAddress(google({ emailClaim }), { orgId: ORG, partnerId: PARTNER })).toBeNull();
    expect(m.isDomainVerifiedForOrg).not.toHaveBeenCalled();
  });

  it('google legacyKeyHeld is always false; sessionPin carries hd and no tenant', async () => {
    expect(await googleSignInProvider.legacyKeyHeld(google())).toBe(false);
    expect(h.selects).toHaveLength(0);
    expect(googleSignInProvider.sessionPin(google())).toEqual({ entraTenantId: null, googleHostedDomain: HD });
  });

  it('google identityKey is the sub, exactly as issued; accessRequest is a google request with sub and hostedDomain', () => {
    const identity = google({ subject: 'AbC-123' });
    expect(googleSignInProvider.identityKey(identity)).toEqual({ provider: 'google', sub: 'AbC-123' });
    expect(googleSignInProvider.accessRequest(identity, { orgId: ORG, email: `pat@${HD}`, name: 'Pat' })).toEqual({
      source: 'google', orgId: ORG, email: `pat@${HD}`, name: 'Pat', sub: 'AbC-123', hostedDomain: HD,
    });
  });

  it('google fenceProof locks the org\'s row for the hd at the observed verified_at (D15)', async () => {
    const org = { orgId: ORG, proofVerifiedAt: VERIFIED_AT };
    expect(await googleSignInProvider.fenceProof(org, google())).toBe(true);
    expect(m.lockVerifiedDomainRow).toHaveBeenCalledWith(h.db, { orgId: ORG, domain: HD, verifiedAt: VERIFIED_AT });

    m.lockVerifiedDomainRow.mockResolvedValue(false);
    expect(await googleSignInProvider.fenceProof(org, google())).toBe(false);
  });

  it('google fenceProof without an observed verified_at fails closed, with no read', async () => {
    expect(await googleSignInProvider.fenceProof({ orgId: ORG, proofVerifiedAt: null }, google())).toBe(false);
    expect(m.lockVerifiedDomainRow).not.toHaveBeenCalled();
  });
});

describe('entra adapter (W4, moved)', () => {
  it('entra adapter reproduces W4 D10 (linkable address, else UPN)', async () => {
    m.resolveLinkableEntraAddress.mockImplementationOnce(async () => {
      expect(h.state.systemDepth).toBe(1);
      return { kind: 'linkable', email: ' Jane.Doe@acme.example.com ' };
    });
    expect(await entraSignInProvider.newPersonAddress(entra, { orgId: ORG, partnerId: PARTNER })).toEqual({
      email: 'jane.doe@acme.example.com',
      contactAddress: 'jane.doe@acme.example.com',
      refuseIfAnyAccountAt: ['jane.doe@acme.example.com', 'jane@acme.example.com'],
    });
    expect(m.resolveLinkableEntraAddress).toHaveBeenCalledWith(ORG, PARTNER, entra);

    m.resolveLinkableEntraAddress.mockResolvedValue({ kind: 'refused', outcome: 'unverified-address' });
    expect(await entraSignInProvider.newPersonAddress(entra, { orgId: ORG, partnerId: PARTNER })).toEqual({
      email: 'jane@acme.example.com', contactAddress: null, refuseIfAnyAccountAt: ['jane@acme.example.com'],
    });
    expect(await entraSignInProvider.newPersonAddress({ ...entra, upn: null }, { orgId: ORG, partnerId: PARTNER })).toBeNull();
  });

  it('entra resolveOrg: the proven tenant only, and never for a mismatched issuer', async () => {
    expect(await entraSignInProvider.resolveOrg(entra)).toEqual({ orgId: ORG, proofVerifiedAt: null });
    expect(m.findOrgByProvenEntraTenant).toHaveBeenCalledWith(TID);
    expect(m.findOrgByVerifiedDomain).not.toHaveBeenCalled();

    m.findOrgByProvenEntraTenant.mockClear();
    expect(await entraSignInProvider.resolveOrg({ ...entra, issuer: entraIssuer('common') })).toBeNull();
    expect(await entraSignInProvider.resolveOrg(google())).toBeNull();
    expect(m.findOrgByProvenEntraTenant).not.toHaveBeenCalled();
  });

  it('entra fenceProof is a no-op (W4 serializes tenant transfers itself)', async () => {
    expect(await entraSignInProvider.fenceProof({ orgId: ORG, proofVerifiedAt: null }, entra)).toBe(true);
    expect(m.lockVerifiedDomainRow).not.toHaveBeenCalled();
    expect(h.selects).toHaveLength(0);
  });

  it('entra legacyKeyHeld reads portal_users (entra_tenant_id, entra_oid) under a system context', async () => {
    h.results.push([{ id: 'holder' }]);
    expect(await entraSignInProvider.legacyKeyHeld(entra)).toBe(true);
    expect(new PgDialect().sqlToQuery(h.selects[0]!.where as SQL).params).toEqual([TID, OID]);
    expect(await entraSignInProvider.legacyKeyHeld(entra)).toBe(false);
  });

  it('entra key, pin and request input', () => {
    expect(entraSignInProvider.identityKey(entra)).toEqual({ provider: 'entra', tid: TID, oid: OID });
    expect(entraSignInProvider.sessionPin(entra)).toEqual({ entraTenantId: TID, googleHostedDomain: null });
    expect(entraSignInProvider.accessRequest(entra, { orgId: ORG, email: 'jane@acme.example.com', name: 'Jane' })).toEqual({
      source: 'entra', orgId: ORG, email: 'jane@acme.example.com', name: 'Jane', tid: TID, oid: OID,
    });
  });
});
