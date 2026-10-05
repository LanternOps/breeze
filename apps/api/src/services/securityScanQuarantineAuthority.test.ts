import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {}, runOutsideDbContext: vi.fn(), withSystemDbAccessContext: vi.fn() }));

import {
  describeQuarantineApproval,
  securityLinkAuthorityColumns,
} from './securityScanQuarantineAuthority';
import { captureSystemSensitiveDataAuthority, EMPTY_SENSITIVE_DATA_AUTHORITY } from './sensitiveDataPolicyAuthority';

const ORG = { orgId: '11111111-1111-1111-1111-111111111111', partnerId: null } as const;
const AUTHORITY = captureSystemSensitiveDataAuthority(ORG);

describe('securityLinkAuthorityColumns', () => {
  it('leaves non-security links untouched', () => {
    expect(securityLinkAuthorityColumns('patch', { autoQuarantine: true }, AUTHORITY)).toBeUndefined();
  });

  it('persists a captured authority while auto-quarantine is effectively on', () => {
    expect(securityLinkAuthorityColumns('security', { autoQuarantine: true }, AUTHORITY)).toBe(AUTHORITY);
    // Omitted key = shared default (on).
    expect(securityLinkAuthorityColumns('security', {}, AUTHORITY)).toBe(AUTHORITY);
  });

  it('clears the stamp on a security write without a fresh authority (e.g. AI tool path)', () => {
    expect(securityLinkAuthorityColumns('security', { autoQuarantine: true }, undefined))
      .toEqual(EMPTY_SENSITIVE_DATA_AUTHORITY);
  });

  it('clears the stamp when auto-quarantine is turned off, even with an authority supplied', () => {
    expect(securityLinkAuthorityColumns('security', { autoQuarantine: false }, AUTHORITY))
      .toEqual(EMPTY_SENSITIVE_DATA_AUTHORITY);
  });
});

describe('describeQuarantineApproval', () => {
  it('reports approved / reapproval_required / not_enabled for security links only', () => {
    expect(describeQuarantineApproval(
      { featureType: 'security', inlineSettings: { autoQuarantine: true }, ...AUTHORITY }, ORG,
    )).toBe('approved');
    expect(describeQuarantineApproval(
      { featureType: 'security', inlineSettings: { autoQuarantine: true }, ...EMPTY_SENSITIVE_DATA_AUTHORITY }, ORG,
    )).toBe('reapproval_required');
    expect(describeQuarantineApproval(
      { featureType: 'security', inlineSettings: { autoQuarantine: false }, ...EMPTY_SENSITIVE_DATA_AUTHORITY }, ORG,
    )).toBe('not_enabled');
    expect(describeQuarantineApproval(
      { featureType: 'patch', inlineSettings: {}, ...EMPTY_SENSITIVE_DATA_AUTHORITY }, ORG,
    )).toBeUndefined();
  });

  it('does not accept a stamp minted for a different owner', () => {
    expect(describeQuarantineApproval(
      { featureType: 'security', inlineSettings: {}, ...AUTHORITY },
      { orgId: '22222222-2222-2222-2222-222222222222', partnerId: null },
    )).toBe('reapproval_required');
  });
});
