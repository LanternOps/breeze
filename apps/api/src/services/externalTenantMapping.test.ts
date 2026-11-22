import { describe, expect, it } from 'vitest';
import {
  matchExternalRecordsToOrgs,
  resolveAutoMapNameSuggestions,
  resolveAutoMappings,
  type ExternalNameRecord,
  type OrgNameMatch,
} from './externalTenantMapping';
import type { AutoMapOrgRow } from './externalTenantMapping';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const ORG_C = '33333333-3333-4333-8333-333333333333';

describe('resolveAutoMappings', () => {
  it('maps by external code when it parses as the id of an org under the partner', () => {
    const out = resolveAutoMappings(
      [{ id: 'c1', vendorName: 'Nothing Like This', vendorExternalCode: ORG_A }],
      [{ id: ORG_A, name: 'Acme Ltd' }],
    );
    expect(out).toEqual([{ tenantId: 'c1', orgId: ORG_A, mappingSource: 'auto_external_code' }]);
  });

  it('ignores an external code that is a UUID but not an org under this partner', () => {
    const out = resolveAutoMappings(
      [{ id: 'c1', vendorName: 'Acme Ltd', vendorExternalCode: ORG_B }],
      [{ id: ORG_A, name: 'Acme Ltd' }],
    );
    // A name match is never auto-committed -- it is a suggestion only,
    // see resolveAutoMapNameSuggestions.
    expect(out).toEqual([]);
  });

  it('ignores a non-UUID external code and does not fall through to a name-based commit', () => {
    const out = resolveAutoMappings(
      [{ id: 'c1', vendorName: 'acme ltd', vendorExternalCode: 'CUST-0042' }],
      [{ id: ORG_A, name: 'Acme Ltd' }],
    );
    expect(out).toEqual([]);
  });

  it('never maps two customers onto the same org; only the code rule commits', () => {
    const out = resolveAutoMappings(
      [
        { id: 'c2', vendorName: 'Acme Ltd', vendorExternalCode: null },
        { id: 'c1', vendorName: 'Acme Ltd', vendorExternalCode: ORG_A },
      ],
      [{ id: ORG_A, name: 'Acme Ltd' }],
    );
    expect(out).toEqual([{ tenantId: 'c1', orgId: ORG_A, mappingSource: 'auto_external_code' }]);
  });

  it('never maps the same org to two different external codes', () => {
    const out = resolveAutoMappings(
      [
        { id: 'c1', vendorName: 'x', vendorExternalCode: ORG_A },
        { id: 'c2', vendorName: 'y', vendorExternalCode: ORG_A },
      ],
      [{ id: ORG_A, name: 'Acme Ltd' }],
    );
    expect(out).toEqual([{ tenantId: 'c1', orgId: ORG_A, mappingSource: 'auto_external_code' }]);
  });
});

// Renaming an org to match an unmapped
// vendor customer's name used to auto-capture that customer's backup
// inventory on the next sync, with no confirmation step. A name match is
// now surfaced as a suggestion only -- it is never written by
// autoMapCustomers, and requires a human with full partner access to
// confirm it through the existing manual remap path.
describe('resolveAutoMapNameSuggestions', () => {
  it('suggests an org matched purely by name', () => {
    const out = resolveAutoMapNameSuggestions(
      [{ id: 'c1', vendorName: '  ACME LTD ', vendorExternalCode: null }],
      [{ id: ORG_A, name: 'Acme Ltd' }],
    );
    expect(out).toEqual([{ tenantId: 'c1', orgId: ORG_A }]);
  });

  it('leaves a customer unsuggested when two orgs share the name (ambiguous)', () => {
    const out = resolveAutoMapNameSuggestions(
      [{ id: 'c1', vendorName: 'Acme Ltd', vendorExternalCode: null }],
      [{ id: ORG_A, name: 'Acme Ltd' }, { id: ORG_B, name: 'ACME LTD' }],
    );
    expect(out).toEqual([]);
  });

  it('leaves a customer unsuggested when nothing matches', () => {
    const out = resolveAutoMapNameSuggestions(
      [{ id: 'c1', vendorName: 'Beta Inc', vendorExternalCode: null }],
      [{ id: ORG_A, name: 'Acme Ltd' }],
    );
    expect(out).toEqual([]);
  });

  it('ignores an empty or whitespace-only vendor customer name', () => {
    const out = resolveAutoMapNameSuggestions(
      [{ id: 'c1', vendorName: '   ', vendorExternalCode: null }],
      [{ id: ORG_A, name: '   ' }],
    );
    expect(out).toEqual([]);
  });

  it('does not suggest an org already claimed by an external-code commit', () => {
    const out = resolveAutoMapNameSuggestions(
      [{ id: 'c1', vendorName: 'Acme Ltd', vendorExternalCode: null }],
      [{ id: ORG_A, name: 'Acme Ltd' }],
      new Set([ORG_A]),
    );
    expect(out).toEqual([]);
  });

  it('never suggests the same org for two different customers', () => {
    const out = resolveAutoMapNameSuggestions(
      [
        { id: 'c1', vendorName: 'Acme Ltd', vendorExternalCode: null },
        { id: 'c2', vendorName: 'acme ltd', vendorExternalCode: null },
      ],
      [{ id: ORG_A, name: 'Acme Ltd' }],
    );
    // Both customers reach ORG_A, so the org is contested and neither is
    // suggested. The old first-come claim depended on input order.
    expect(out).toEqual([]);
  });

  it('strips corporate suffixes', () => {
    const out = resolveAutoMapNameSuggestions(
      [{ id: 'c1', vendorName: 'Acme Corp', vendorExternalCode: null }],
      [{ id: ORG_A, name: 'Acme Corporation' }],
    );
    expect(out).toEqual([{ tenantId: 'c1', orgId: ORG_A }]);
  });

  it('returns suggestions in input order', () => {
    const out = resolveAutoMapNameSuggestions(
      [
        { id: 'c2', vendorName: 'Beta LLC', vendorExternalCode: null },
        { id: 'c1', vendorName: 'Acme Ltd', vendorExternalCode: null },
      ],
      [{ id: ORG_A, name: 'Acme Ltd' }, { id: ORG_B, name: 'Beta' }],
    );
    expect(out).toEqual([{ tenantId: 'c2', orgId: ORG_B }, { tenantId: 'c1', orgId: ORG_A }]);
  });
});

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

function sortedEntries(result: Map<string, OrgNameMatch>): Array<[string, OrgNameMatch]> {
  return [...result.entries()].sort(([a], [b]) => a.localeCompare(b));
}

describe('matchExternalRecordsToOrgs', () => {
  it('exact beats a normalized tie', () => {
    const out = matchExternalRecordsToOrgs(
      [{ id: 'r1', name: 'Acme Inc' }],
      [{ id: ORG_A, name: 'Acme Inc' }, { id: ORG_B, name: 'Acme LLC' }],
      { cardinality: 'one_to_one' },
    );
    expect(out.get('r1')).toEqual({ status: 'match', orgId: ORG_A, tier: 'exact', matchKey: 'acme inc' });
  });

  it('normalized tie is ambiguous', () => {
    const out = matchExternalRecordsToOrgs(
      [{ id: 'r1', name: 'Acme' }],
      [{ id: ORG_B, name: 'Acme Inc' }, { id: ORG_A, name: 'Acme LLC' }],
      { cardinality: 'one_to_one' },
    );
    expect(out.get('r1')).toEqual({
      status: 'ambiguous',
      candidateOrgIds: [ORG_A, ORG_B],
      tier: 'normalized',
      matchKey: 'acme',
    });
  });

  it('exact tie is ambiguous and does not fall through to the normalized tier', () => {
    const out = matchExternalRecordsToOrgs(
      [{ id: 'r1', name: 'Acme Ltd' }],
      [{ id: ORG_B, name: 'ACME LTD' }, { id: ORG_A, name: 'Acme Ltd' }, { id: ORG_C, name: 'Acme' }],
      { cardinality: 'one_to_one' },
    );
    expect(out.get('r1')).toEqual({
      status: 'ambiguous',
      candidateOrgIds: [ORG_A, ORG_B],
      tier: 'exact',
      matchKey: 'acme ltd',
    });
  });

  it('one_to_one contest', () => {
    const out = matchExternalRecordsToOrgs(
      [{ id: 'r1', name: 'Acme Ltd' }, { id: 'r2', name: 'ACME LTD.' }],
      [{ id: ORG_A, name: 'Acme Ltd' }],
      { cardinality: 'one_to_one' },
    );
    expect(out.get('r1')).toEqual({
      status: 'contested', orgId: ORG_A, tier: 'exact', matchKey: 'acme ltd', contestedWith: ['r2'],
    });
    expect(out.get('r2')).toEqual({
      status: 'contested', orgId: ORG_A, tier: 'normalized', matchKey: 'acme', contestedWith: ['r1'],
    });
  });

  it('many_to_one has no contest', () => {
    const out = matchExternalRecordsToOrgs(
      [{ id: 'r1', name: 'Acme Ltd' }, { id: 'r2', name: 'ACME LTD.' }],
      [{ id: ORG_A, name: 'Acme Ltd' }],
      { cardinality: 'many_to_one' },
    );
    expect(out.get('r1')).toEqual({ status: 'match', orgId: ORG_A, tier: 'exact', matchKey: 'acme ltd' });
    expect(out.get('r2')).toEqual({ status: 'match', orgId: ORG_A, tier: 'normalized', matchKey: 'acme' });
  });

  it('excluded org is not a candidate', () => {
    const out = matchExternalRecordsToOrgs(
      [{ id: 'r1', name: 'Acme Ltd' }],
      [{ id: ORG_A, name: 'Acme Ltd' }],
      { cardinality: 'one_to_one', excludedOrgIds: new Set([ORG_A]) },
    );
    expect(out.get('r1')).toEqual({ status: 'none' });
  });

  it('excluding one of two tied orgs leaves a match on the other', () => {
    const out = matchExternalRecordsToOrgs(
      [{ id: 'r1', name: 'Acme' }],
      [{ id: ORG_A, name: 'Acme Inc' }, { id: ORG_B, name: 'Acme LLC' }],
      { cardinality: 'one_to_one', excludedOrgIds: new Set([ORG_A]) },
    );
    expect(out.get('r1')).toEqual({ status: 'match', orgId: ORG_B, tier: 'normalized', matchKey: 'acme' });
  });

  it('returns one entry per record, none for an unmatched or blank name', () => {
    const out = matchExternalRecordsToOrgs(
      [{ id: 'r1', name: 'Beta' }, { id: 'r2', name: null }, { id: 'r3', name: '  ' }],
      [{ id: ORG_A, name: 'Acme' }, { id: ORG_B, name: '   ' }],
      { cardinality: 'one_to_one' },
    );
    expect(sortedEntries(out)).toEqual([
      ['r1', { status: 'none' }],
      ['r2', { status: 'none' }],
      ['r3', { status: 'none' }],
    ]);
  });

  it('does not contest a record with an ambiguous result', () => {
    const out = matchExternalRecordsToOrgs(
      [{ id: 'r1', name: 'Acme Ltd' }, { id: 'r2', name: 'Acme' }],
      [{ id: ORG_A, name: 'Acme Ltd' }, { id: ORG_B, name: 'Acme Inc' }],
      { cardinality: 'one_to_one' },
    );
    expect(out.get('r1')).toEqual({ status: 'match', orgId: ORG_A, tier: 'exact', matchKey: 'acme ltd' });
    expect(out.get('r2')).toMatchObject({ status: 'ambiguous', candidateOrgIds: [ORG_A, ORG_B] });
  });

  it('refuses duplicate record ids instead of silently keeping one', () => {
    expect(() => matchExternalRecordsToOrgs(
      [{ id: 'r1', name: 'Acme' }, { id: 'r1', name: 'Beta' }],
      [{ id: ORG_A, name: 'Acme' }],
      { cardinality: 'many_to_one' },
    )).toThrow(/duplicate record id/i);
  });

  it('contests three records on one org, each listing the other two', () => {
    const out = matchExternalRecordsToOrgs(
      [{ id: 'r3', name: 'Acme' }, { id: 'r1', name: 'Acme Ltd' }, { id: 'r2', name: 'ACME LTD' }],
      [{ id: ORG_A, name: 'Acme Ltd' }],
      { cardinality: 'one_to_one' },
    );
    expect(out.get('r1')).toMatchObject({ status: 'contested', contestedWith: ['r2', 'r3'] });
    expect(out.get('r2')).toMatchObject({ status: 'contested', contestedWith: ['r1', 'r3'] });
    expect(out.get('r3')).toMatchObject({ status: 'contested', tier: 'normalized', contestedWith: ['r1', 'r2'] });
  });

  it('order independent', () => {
    const records: ExternalNameRecord[] = [
      { id: 'r1', name: 'Acme Ltd' },
      { id: 'r2', name: 'ACME LTD.' },
      { id: 'r3', name: 'Beta' },
      { id: 'r4', name: 'Gamma Inc' },
    ];
    const orgs: AutoMapOrgRow[] = [
      { id: ORG_A, name: 'Acme Ltd' },
      { id: ORG_B, name: 'Beta LLC' },
      { id: ORG_C, name: 'Beta GmbH' },
    ];
    for (const cardinality of ['one_to_one', 'many_to_one'] as const) {
      const baseline = sortedEntries(matchExternalRecordsToOrgs(records, orgs, { cardinality }));
      expect(baseline.find(([id]) => id === 'r3')?.[1]).toMatchObject({ status: 'ambiguous' });
      for (const recordOrder of permutations(records)) {
        for (const orgOrder of permutations(orgs)) {
          expect(sortedEntries(matchExternalRecordsToOrgs(recordOrder, orgOrder, { cardinality }))).toEqual(baseline);
        }
      }
    }
  });
});

describe('spec 4.5 guards', () => {
  it('never emits an auto_name decision (spec 4.5)', () => {
    const d = resolveAutoMappings([{ id: 't1', vendorName: 'Acme', vendorExternalCode: null }], [{ id: ORG_A, name: 'Acme' }]);
    expect(d).toEqual([]);
  });
  it('a value that merely CONTAINS a uuid is not an external code', () => {
    expect(resolveAutoMappings([{ id: 't1', vendorName: 'x', vendorExternalCode: `ref ${ORG_A}` }], [{ id: ORG_A, name: 'y' }])).toEqual([]);
  });
});
