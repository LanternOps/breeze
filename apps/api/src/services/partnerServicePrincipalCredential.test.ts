import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {}, withSystemDbAccessContext: vi.fn() }));

import { isPartnerServicePrincipalKeyFormat } from './partnerServicePrincipalCredential';

describe('isPartnerServicePrincipalKeyFormat', () => {
  it('matches only the exact brz_sp_ + 43 base64url shape', () => {
    expect(isPartnerServicePrincipalKeyFormat(`brz_sp_${'A'.repeat(43)}`)).toBe(true);
    expect(isPartnerServicePrincipalKeyFormat(`brz_sp_${'a-_Z9'.repeat(8)}abc`)).toBe(true);
    expect(isPartnerServicePrincipalKeyFormat(`brz_sp_${'A'.repeat(42)}`)).toBe(false);
    expect(isPartnerServicePrincipalKeyFormat(`brz_sp_${'A'.repeat(44)}`)).toBe(false);
    expect(isPartnerServicePrincipalKeyFormat(`brz_sp_${'A'.repeat(42)}=`)).toBe(false);
    expect(isPartnerServicePrincipalKeyFormat(` brz_sp_${'A'.repeat(43)}`)).toBe(false);
  });

  it('never matches an organization key, even one whose random part starts with sp_', () => {
    // routes/apiKeys.ts mints `brz_` + 32 base64url chars, which can begin `sp_`;
    // those must keep reaching the org API-key middleware on /mcp.
    expect(isPartnerServicePrincipalKeyFormat(`brz_sp_${'A'.repeat(29)}`)).toBe(false);
    expect(isPartnerServicePrincipalKeyFormat(`brz_${'f'.repeat(48)}`)).toBe(false);
  });
});
