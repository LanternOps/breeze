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
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const { selectResult, wheres } = vi.hoisted(() => ({ selectResult: vi.fn(), wheres: [] as unknown[] }));

vi.mock('../db', () => {
  const chain: any = {
    from: () => chain,
    where: (w: unknown) => {
      wheres.push(w);
      return chain;
    },
    limit: () => selectResult(),
  };
  return { db: { select: () => chain } };
});

import { resolveLinkableEntraAddress } from './clientAiEntraAddress';
import type { ClientAiEntraClaims } from './clientAiEntraJwt';

// Real drizzle columns reach the predicate, so the WHERE can be COMPILED. The
// mock returns its queued rows regardless of the predicate, so only a
// compiled-SQL assertion can tell an `=` on the domain from a LIKE/suffix
// match — the difference between "the org owns this domain" and "the org owns
// something this domain ends with".
const compile = (statement: SQL) => new PgDialect().sqlToQuery(statement as never);

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

beforeEach(() => {
  vi.clearAllMocks();
  wheres.length = 0;
});

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
    // subdomains the MSP never vetted into the org. Asserted on the COMPILED
    // predicate, because the mock would return the queued row for a LIKE too.
    domainNotOwned();
    const got = await resolveLinkableEntraAddress(ORG, PARTNER, claims({ upn: 'jane@mail.acme.example' }));
    expect(got).toEqual({ kind: 'refused', outcome: 'unverified-address' });

    const { sql, params } = compile(wheres[0] as SQL);
    expect(sql).toMatch(/"domain"\s*=\s*\$\d/i);
    expect(sql).not.toMatch(/like/i);
    // The domain is queried whole — no stripping to a parent before the lookup.
    expect(params).toContain('mail.acme.example');
  });

  it('bounds the lookup by partner AND is_active, with the exact params', async () => {
    // The partner bound is the tenant boundary (the unique index is
    // (partner_id, domain)); `is_active` is the MSP's revocation switch — a
    // retired domain must stop verifying anyone.
    domainOwned();
    await resolveLinkableEntraAddress(ORG, PARTNER, claims({ upn: 'jane@acme.example' }));

    expect(wheres).toHaveLength(1);
    const { sql, params } = compile(wheres[0] as SQL);
    expect(sql).toMatch(/"partner_id"\s*=\s*\$\d/i);
    expect(sql).toMatch(/"is_active"\s*=\s*\$\d/i);
    expect(params).toEqual([PARTNER, 'acme.example', true]);
  });

  it('requires the mapping to name THIS org, not merely the partner', async () => {
    // customer_email_domains is unique on (partner_id, domain) and carries the
    // org — a domain belonging to a SIBLING org of the same MSP must not verify.
    selectResult.mockResolvedValueOnce([{ orgId: 'some-other-org' }]);
    const got = await resolveLinkableEntraAddress(ORG, PARTNER, claims({ upn: 'jane@sibling.example' }));
    expect(got).toEqual({ kind: 'refused', outcome: 'unverified-address' });
  });
});
