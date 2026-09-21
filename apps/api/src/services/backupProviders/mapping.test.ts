import { describe, expect, it } from 'vitest';
import { resolveCustomerAutoMappings } from './mapping';

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
    // Falls through to the name rule rather than mapping to a foreign org.
    expect(out).toEqual([{ customerId: 'c1', orgId: ORG_A, mappingSource: 'auto_name' }]);
  });

  it('ignores a non-UUID external code and falls through to the name rule', () => {
    const out = resolveCustomerAutoMappings(
      [{ id: 'c1', vendorCustomerName: 'acme ltd', vendorExternalCode: 'CUST-0042' }],
      [{ id: ORG_A, name: 'Acme Ltd' }],
    );
    expect(out).toEqual([{ customerId: 'c1', orgId: ORG_A, mappingSource: 'auto_name' }]);
  });

  it('matches names case- and whitespace-insensitively', () => {
    const out = resolveCustomerAutoMappings(
      [{ id: 'c1', vendorCustomerName: '  ACME LTD ', vendorExternalCode: null }],
      [{ id: ORG_A, name: 'Acme Ltd' }],
    );
    expect(out).toEqual([{ customerId: 'c1', orgId: ORG_A, mappingSource: 'auto_name' }]);
  });

  it('leaves a customer unmapped when two orgs share the name (ambiguous)', () => {
    const out = resolveCustomerAutoMappings(
      [{ id: 'c1', vendorCustomerName: 'Acme Ltd', vendorExternalCode: null }],
      [{ id: ORG_A, name: 'Acme Ltd' }, { id: ORG_B, name: 'ACME LTD' }],
    );
    expect(out).toEqual([]);
  });

  it('leaves a customer unmapped when nothing matches', () => {
    const out = resolveCustomerAutoMappings(
      [{ id: 'c1', vendorCustomerName: 'Beta Inc', vendorExternalCode: null }],
      [{ id: ORG_A, name: 'Acme Ltd' }],
    );
    expect(out).toEqual([]);
  });

  it('ignores an empty or whitespace-only vendor customer name', () => {
    const out = resolveCustomerAutoMappings(
      [{ id: 'c1', vendorCustomerName: '   ', vendorExternalCode: null }],
      [{ id: ORG_A, name: '   ' }],
    );
    expect(out).toEqual([]);
  });

  it('never maps two customers onto the same org; the stronger rule wins', () => {
    const out = resolveCustomerAutoMappings(
      [
        { id: 'c2', vendorCustomerName: 'Acme Ltd', vendorExternalCode: null },
        { id: 'c1', vendorCustomerName: 'Acme Ltd', vendorExternalCode: ORG_A },
      ],
      [{ id: ORG_A, name: 'Acme Ltd' }],
    );
    expect(out).toEqual([{ customerId: 'c1', orgId: ORG_A, mappingSource: 'auto_external_code' }]);
  });
});
