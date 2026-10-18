import { describe, expect, it } from 'vitest';
import { publicApiPath } from './api';
import { trustAttestationJwksPath, trustAttestationPath } from './trustAttestation';

describe('trustAttestationPath', () => {
  it('is the same-origin API path for an org page', () => {
    expect(trustAttestationPath('nw', 'acme')).toBe(publicApiPath('/trust/attestation/nw/acme'));
    expect(trustAttestationPath('nw', 'acme')).toBe('/api/v1/trust/attestation/nw/acme');
  });

  it('omits the org segment for the partner home page', () => {
    expect(trustAttestationPath('nw', null)).toBe(publicApiPath('/trust/attestation/nw'));
  });

  it('URL-encodes the slugs', () => {
    expect(trustAttestationPath('n w', 'a/b')).toBe('/api/v1/trust/attestation/n%20w/a%2Fb');
  });
});

describe('trustAttestationJwksPath', () => {
  it('is the same-origin JWKS path', () => {
    expect(trustAttestationJwksPath()).toBe(publicApiPath('/trust/attestation/jwks.json'));
  });
});
