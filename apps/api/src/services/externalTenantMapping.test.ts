import { describe, expect, it } from 'vitest';
import { resolveAutoMapNameSuggestions, resolveAutoMappings } from './externalTenantMapping';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

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
    expect(out).toEqual([{ tenantId: 'c1', orgId: ORG_A }]);
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
