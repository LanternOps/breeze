import { describe, expect, it } from 'vitest';
import { resolveCustomerAutoMapNameSuggestions, resolveCustomerAutoMappings } from './mapping';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

describe('resolveCustomerAutoMappings', () => {
  it('maps by external code when it parses as the id of an org under the partner', () => {
    const out = resolveCustomerAutoMappings(
      [{ id: 'c1', vendorCustomerName: 'Nothing Like This', vendorExternalCode: ORG_A }],
      [{ id: ORG_A, name: 'Acme Ltd' }],
    );
    expect(out).toEqual([{ customerId: 'c1', orgId: ORG_A, mappingSource: 'auto_external_code' }]);
  });

  it('ignores an external code that is a UUID but not an org under this partner', () => {
    const out = resolveCustomerAutoMappings(
      [{ id: 'c1', vendorCustomerName: 'Acme Ltd', vendorExternalCode: ORG_B }],
      [{ id: ORG_A, name: 'Acme Ltd' }],
    );
    // A name match is never auto-committed -- it is a suggestion only,
    // see resolveCustomerAutoMapNameSuggestions.
    expect(out).toEqual([]);
  });

  it('ignores a non-UUID external code and does not fall through to a name-based commit', () => {
    const out = resolveCustomerAutoMappings(
      [{ id: 'c1', vendorCustomerName: 'acme ltd', vendorExternalCode: 'CUST-0042' }],
      [{ id: ORG_A, name: 'Acme Ltd' }],
    );
    expect(out).toEqual([]);
  });

  it('never maps two customers onto the same org; only the code rule commits', () => {
    const out = resolveCustomerAutoMappings(
      [
        { id: 'c2', vendorCustomerName: 'Acme Ltd', vendorExternalCode: null },
        { id: 'c1', vendorCustomerName: 'Acme Ltd', vendorExternalCode: ORG_A },
      ],
      [{ id: ORG_A, name: 'Acme Ltd' }],
    );
    expect(out).toEqual([{ customerId: 'c1', orgId: ORG_A, mappingSource: 'auto_external_code' }]);
  });

  it('never maps the same org to two different external codes', () => {
    const out = resolveCustomerAutoMappings(
      [
        { id: 'c1', vendorCustomerName: 'x', vendorExternalCode: ORG_A },
        { id: 'c2', vendorCustomerName: 'y', vendorExternalCode: ORG_A },
      ],
      [{ id: ORG_A, name: 'Acme Ltd' }],
    );
    expect(out).toEqual([{ customerId: 'c1', orgId: ORG_A, mappingSource: 'auto_external_code' }]);
  });
});

// Renaming an org to match an unmapped
// vendor customer's name used to auto-capture that customer's backup
// inventory on the next sync, with no confirmation step. A name match is
// now surfaced as a suggestion only -- it is never written by
// autoMapCustomers, and requires a human with full partner access to
// confirm it through the existing manual remap path.
describe('resolveCustomerAutoMapNameSuggestions', () => {
  it('suggests an org matched purely by name', () => {
    const out = resolveCustomerAutoMapNameSuggestions(
      [{ id: 'c1', vendorCustomerName: '  ACME LTD ', vendorExternalCode: null }],
      [{ id: ORG_A, name: 'Acme Ltd' }],
    );
    expect(out).toEqual([{ customerId: 'c1', orgId: ORG_A }]);
  });

  it('leaves a customer unsuggested when two orgs share the name (ambiguous)', () => {
    const out = resolveCustomerAutoMapNameSuggestions(
      [{ id: 'c1', vendorCustomerName: 'Acme Ltd', vendorExternalCode: null }],
      [{ id: ORG_A, name: 'Acme Ltd' }, { id: ORG_B, name: 'ACME LTD' }],
    );
    expect(out).toEqual([]);
  });

  it('leaves a customer unsuggested when nothing matches', () => {
    const out = resolveCustomerAutoMapNameSuggestions(
      [{ id: 'c1', vendorCustomerName: 'Beta Inc', vendorExternalCode: null }],
      [{ id: ORG_A, name: 'Acme Ltd' }],
    );
    expect(out).toEqual([]);
  });

  it('ignores an empty or whitespace-only vendor customer name', () => {
    const out = resolveCustomerAutoMapNameSuggestions(
      [{ id: 'c1', vendorCustomerName: '   ', vendorExternalCode: null }],
      [{ id: ORG_A, name: '   ' }],
    );
    expect(out).toEqual([]);
  });

  it('does not suggest an org already claimed by an external-code commit', () => {
    const out = resolveCustomerAutoMapNameSuggestions(
      [{ id: 'c1', vendorCustomerName: 'Acme Ltd', vendorExternalCode: null }],
      [{ id: ORG_A, name: 'Acme Ltd' }],
      new Set([ORG_A]),
    );
    expect(out).toEqual([]);
  });

  it('never suggests the same org for two different customers', () => {
    const out = resolveCustomerAutoMapNameSuggestions(
      [
        { id: 'c1', vendorCustomerName: 'Acme Ltd', vendorExternalCode: null },
        { id: 'c2', vendorCustomerName: 'acme ltd', vendorExternalCode: null },
      ],
      [{ id: ORG_A, name: 'Acme Ltd' }],
    );
    expect(out).toEqual([{ customerId: 'c1', orgId: ORG_A }]);
  });
});
