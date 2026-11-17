import { describe, expect, it } from 'vitest';
import { entraChainKey, googleChainKey, parseChainKey } from './chain';

const ORG = '0b9d6a52-8f43-4c5e-9a1d-2f6c7b8e9d01';
const CONN = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
const TID = '11111111-2222-4333-8444-555555555555';

describe('directory chain keys (D5)', () => {
  it('entra: entra:<tenantId>:<connectionId>:<consentGeneration>:<orgId>, tenant lower-cased; parses back', () => {
    const key = entraChainKey({ tenantId: TID.toUpperCase(), connectionId: CONN, consentGeneration: 3, orgId: ORG });
    expect(key).toBe(`entra:${TID}:${CONN}:3:${ORG}`);
    expect(parseChainKey(key)).toEqual({ source: 'entra', tenantId: TID, connectionId: CONN, consentGeneration: 3, orgId: ORG });
  });

  it('google: google:<customerId>:<connectionId>:<binding>:<orgId>; parses back', () => {
    const binding = 'a'.repeat(64);
    const key = googleChainKey({ customerId: 'C01abc234', connectionId: CONN, binding, orgId: ORG });
    expect(key).toBe(`google:C01abc234:${CONN}:${binding}:${ORG}`);
    expect(parseChainKey(key)).toEqual({ source: 'google', customerId: 'C01abc234', connectionId: CONN, binding, orgId: ORG });
  });

  it('every part changes the key (re-consent, re-bind, another workspace, an org merge)', () => {
    const base = { tenantId: TID, connectionId: CONN, consentGeneration: 1, orgId: ORG };
    const key = entraChainKey(base);
    expect(entraChainKey({ ...base, consentGeneration: 2 })).not.toBe(key);
    expect(entraChainKey({ ...base, orgId: CONN })).not.toBe(key);
    const g = { customerId: 'C1', connectionId: CONN, binding: 'b'.repeat(64), orgId: ORG };
    expect(googleChainKey({ ...g, binding: 'c'.repeat(64) })).not.toBe(googleChainKey(g));
  });

  it('refuses a malformed key or a part that would make it ambiguous', () => {
    for (const bad of ['', 'entra', `entra:${TID}:${CONN}:x:${ORG}`, `scim:a:b:c:${ORG}`, `entra:${TID}:${CONN}:1:not-an-org`, `entra:${TID}:${CONN}:1:${ORG}:extra`]) {
      expect(parseChainKey(bad)).toBeNull();
    }
    expect(() => googleChainKey({ customerId: 'C:1', connectionId: CONN, binding: 'b', orgId: ORG })).toThrow();
    expect(() => entraChainKey({ tenantId: TID, connectionId: CONN, consentGeneration: -1, orgId: ORG })).toThrow();
  });
});
