import { describe, expect, it } from 'vitest';
import {
  buildPax8CompanySuggestions,
  mapPax8CompaniesBulk,
  Pax8BulkMapError,
  summarizePax8Companies,
  verifyPax8SuggestionSource,
  type Pax8CompanyRowForMatch,
} from './pax8CompanyMapping';

const NOW = new Date('2026-11-08T12:00:00Z');
const OLD = new Date('2026-01-01T00:00:00Z');
const ORG_ACME = '00000000-0000-0000-0000-0000000000a1';
const ORG_BETA = '00000000-0000-0000-0000-0000000000b2';
const orgs = [{ id: ORG_ACME, name: 'Acme Inc' }, { id: ORG_BETA, name: 'Beta LLC' }];

function row(over: Partial<Pax8CompanyRowForMatch> & { pax8CompanyId: string }): Pax8CompanyRowForMatch {
  return { pax8CompanyName: null, mappedOrgId: null, ignored: false, createdAt: OLD, ...over };
}

describe('buildPax8CompanySuggestions', () => {
  it('ignored and mapped rows get no suggestion', () => {
    const s = buildPax8CompanySuggestions([
      row({ pax8CompanyId: 'c1', pax8CompanyName: 'Acme Inc', ignored: true }),
      row({ pax8CompanyId: 'c2', pax8CompanyName: 'Beta LLC', mappedOrgId: ORG_BETA }),
    ], orgs);
    expect(s.size).toBe(0);
  });

  it('an org already mapped by another company is not suggested', () => {
    const s = buildPax8CompanySuggestions([
      row({ pax8CompanyId: 'c1', pax8CompanyName: 'Acme', mappedOrgId: ORG_ACME }),
      row({ pax8CompanyId: 'c2', pax8CompanyName: 'Acme Inc' }),
    ], orgs);
    expect(s.has('c2')).toBe(false);
  });

  it('two unmapped companies matching one org are both contested and not counted as suggested', () => {
    const rows = [
      row({ pax8CompanyId: 'c1', pax8CompanyName: 'Acme Inc' }),
      row({ pax8CompanyId: 'c2', pax8CompanyName: 'Acme Inc.' }),
    ];
    const s = buildPax8CompanySuggestions(rows, orgs);
    expect(s.get('c1')).toMatchObject({
      status: 'contested', orgId: ORG_ACME, orgName: 'Acme Inc',
      contestedWith: [{ pax8CompanyId: 'c2', pax8CompanyName: 'Acme Inc.' }],
    });
    expect(s.get('c2')?.status).toBe('contested');
    expect(summarizePax8Companies(rows, s, NOW).suggested).toBe(0);
  });

  it('returns a match with org name and tier', () => {
    const s = buildPax8CompanySuggestions([row({ pax8CompanyId: 'c1', pax8CompanyName: 'Beta LLC' })], orgs);
    expect(s.get('c1')).toMatchObject({ status: 'match', orgId: ORG_BETA, orgName: 'Beta LLC', tier: 'exact' });
  });
});

describe('summarizePax8Companies', () => {
  it('newUnmapped counts only unmapped non-ignored rows first seen within 7 days', () => {
    const rows = [
      row({ pax8CompanyId: 'a', createdAt: new Date('2026-11-05T00:00:00Z') }),
      row({ pax8CompanyId: 'b', createdAt: new Date('2026-10-01T00:00:00Z') }),
      row({ pax8CompanyId: 'c', createdAt: new Date('2026-11-07T00:00:00Z'), ignored: true }),
      row({ pax8CompanyId: 'd', createdAt: new Date('2026-11-07T00:00:00Z'), mappedOrgId: ORG_ACME }),
    ];
    expect(summarizePax8Companies(rows, new Map(), NOW)).toEqual({ unmapped: 2, suggested: 0, newUnmapped: 1 });
  });
});

describe('verifyPax8SuggestionSource', () => {
  const s = buildPax8CompanySuggestions([row({ pax8CompanyId: 'c1', pax8CompanyName: 'Acme Inc' })], orgs);
  it('keeps suggestion when the recompute still matches the chosen org', () => {
    const v = verifyPax8SuggestionSource('suggestion', 'c1', ORG_ACME, s);
    expect(v.source).toBe('suggestion');
    expect(v.matchTier).toBe('exact');
    expect(v.matchKey).toEqual(expect.any(String));
  });
  it('downgrades to manual for a different org, no claim or an unmap', () => {
    const manual = { source: 'manual', matchTier: null, matchKey: null };
    expect(verifyPax8SuggestionSource('suggestion', 'c1', ORG_BETA, s)).toEqual(manual);
    expect(verifyPax8SuggestionSource(undefined, 'c1', ORG_ACME, s)).toEqual(manual);
    expect(verifyPax8SuggestionSource('suggestion', 'c1', null, s)).toEqual(manual);
  });
});

describe('mapPax8CompaniesBulk', () => {
  it('refuses a batch that names one company twice before opening a transaction', async () => {
    const err = await mapPax8CompaniesBulk({
      integrationId: '00000000-0000-0000-0000-000000000001',
      partnerId: '00000000-0000-0000-0000-000000000002',
      items: [
        { pax8CompanyId: 'co-1', orgId: ORG_ACME, expectedOrgId: null },
        { pax8CompanyId: 'co-2', orgId: ORG_BETA, expectedOrgId: null },
        { pax8CompanyId: 'co-1', orgId: ORG_BETA, expectedOrgId: null },
      ],
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Pax8BulkMapError);
    expect(err).toMatchObject({ status: 400, code: 'DUPLICATE_COMPANY', pax8CompanyIds: ['co-1'] });
  });
});

describe('Pax8BulkMapError', () => {
  it.each([
    ['STALE_REVIEW', 409],
    ['NOT_FOUND', 404],
    ['INVALID_TARGET', 400],
    ['DUPLICATE_COMPANY', 400],
  ] as const)('%s carries HTTP %i', (code, status) => {
    expect(new Pax8BulkMapError(code, 'x', []).status).toBe(status);
  });
});
