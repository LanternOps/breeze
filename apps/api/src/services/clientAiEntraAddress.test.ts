/**
 * #3258 security round S1 — which Entra address may identify a PERSON.
 *
 * The exchange links a login to a `contacts` row by email. That link is an
 * authorization fact once the Entra persona can read tickets: matching an
 * existing contact hands over that contact's emailed ticket history
 * (`routes/portal/ticketOwnership.ts`). So the address has to be one the
 * customer demonstrably owns, not merely one the token asserts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { selectResult, whereSpy } = vi.hoisted(() => ({ selectResult: vi.fn(), whereSpy: vi.fn() }));

vi.mock('../db', () => {
  const chain: any = {
    from: () => chain,
    where: (w: unknown) => {
      whereSpy(w);
      return chain;
    },
    limit: () => selectResult(),
  };
  return { db: { select: () => chain } };
});

import { resolveLinkableEntraAddress } from './clientAiEntraAddress';
import type { ClientAiEntraClaims } from './clientAiEntraJwt';

const ORG = 'org-1';
const PARTNER = 'partner-1';

const claims = (over: Partial<ClientAiEntraClaims>): ClientAiEntraClaims =>
  ({
    tid: 't',
    oid: 'o',
    name: null,
    aud: 'a',
    iss: 'i',
    exp: 0,
    iat: 0,
    scp: null,
    email: null,
    upn: null,
    emailClaim: null,
    emailDomainOwnerVerified: false,
    ...over,
  }) as ClientAiEntraClaims;

/** The org owns the queried domain. */
const domainOwned = () => selectResult.mockResolvedValueOnce([{ orgId: ORG }]);
const domainNotOwned = () => selectResult.mockResolvedValueOnce([]);

beforeEach(() => vi.clearAllMocks());

describe('resolveLinkableEntraAddress', () => {
  it('links a UPN whose domain the org owns', async () => {
    domainOwned();
    const got = await resolveLinkableEntraAddress(ORG, PARTNER, claims({ upn: 'jane@acme.example' }));
    expect(got).toEqual({ kind: 'linkable', email: 'jane@acme.example' });
  });

  it('refuses a UPN whose domain the org does NOT own', async () => {
    // The UPN is tenant-owned, but this Breeze org may not be that tenant's
    // customer — a mapped tenant can hold addresses on many domains, and only
    // the partner-declared ones are "addresses this org owns".
    domainNotOwned();
    const got = await resolveLinkableEntraAddress(ORG, PARTNER, claims({ upn: 'jane@evil.example' }));
    expect(got).toEqual({ kind: 'refused', outcome: 'unverified-address' });
  });

  it('refuses an email claim with NO xms_edov, even on an owned domain', async () => {
    // The nOAuth shape: a tenant admin can type any address into the email
    // claim. Without the ownership proof it identifies nobody.
    const got = await resolveLinkableEntraAddress(
      ORG,
      PARTNER,
      claims({ emailClaim: 'ceo@acme.example', emailDomainOwnerVerified: false }),
    );
    expect(got).toEqual({ kind: 'refused', outcome: 'unverified-address' });
    // Refused before the domain lookup — no read at all.
    expect(selectResult).not.toHaveBeenCalled();
  });

  it('links an email claim WITH xms_edov on an owned domain', async () => {
    domainOwned();
    const got = await resolveLinkableEntraAddress(
      ORG,
      PARTNER,
      claims({ emailClaim: 'ceo@acme.example', emailDomainOwnerVerified: true }),
    );
    expect(got).toEqual({ kind: 'linkable', email: 'ceo@acme.example' });
  });

  it('refuses an xms_edov email claim on a domain the org does not own', async () => {
    domainNotOwned();
    const got = await resolveLinkableEntraAddress(
      ORG,
      PARTNER,
      claims({ emailClaim: 'ceo@other.example', emailDomainOwnerVerified: true }),
    );
    expect(got).toEqual({ kind: 'refused', outcome: 'unverified-address' });
  });

  it('prefers the UPN when both claims are present', async () => {
    domainOwned();
    const got = await resolveLinkableEntraAddress(
      ORG,
      PARTNER,
      claims({ upn: 'jane@acme.example', emailClaim: 'ceo@acme.example', emailDomainOwnerVerified: true }),
    );
    expect(got).toEqual({ kind: 'linkable', email: 'jane@acme.example' });
  });

  it('reports no address at all as unusable, not unverified', async () => {
    // Two different operator stories: "the token had nothing" vs "the token had
    // something we would not trust".
    const got = await resolveLinkableEntraAddress(ORG, PARTNER, claims({}));
    expect(got).toEqual({ kind: 'refused', outcome: 'unusable-address' });
    expect(selectResult).not.toHaveBeenCalled();
  });

  it('refuses a malformed address without querying', async () => {
    const got = await resolveLinkableEntraAddress(ORG, PARTNER, claims({ upn: 'no-at-sign' }));
    expect(got).toEqual({ kind: 'refused', outcome: 'unusable-address' });
    expect(selectResult).not.toHaveBeenCalled();
  });

  it('matches the EXACT domain, never a parent (no subdomain widening)', async () => {
    // Same rule inbound email applies: a suffix match would route arbitrary
    // subdomains the MSP never vetted into the org.
    domainNotOwned();
    const got = await resolveLinkableEntraAddress(ORG, PARTNER, claims({ upn: 'jane@mail.acme.example' }));
    expect(got).toEqual({ kind: 'refused', outcome: 'unverified-address' });
  });

  it('requires the mapping to name THIS org, not merely the partner', async () => {
    // customer_email_domains is unique on (partner_id, domain) and carries the
    // org — a domain belonging to a SIBLING org of the same MSP must not verify.
    selectResult.mockResolvedValueOnce([{ orgId: 'some-other-org' }]);
    const got = await resolveLinkableEntraAddress(ORG, PARTNER, claims({ upn: 'jane@sibling.example' }));
    expect(got).toEqual({ kind: 'refused', outcome: 'unverified-address' });
  });
});
