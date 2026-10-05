import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectMock, updateMock, setMock, resolveStampedMock, resolveLegacyMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  updateMock: vi.fn(),
  setMock: vi.fn(),
  resolveStampedMock: vi.fn(),
  resolveLegacyMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { select: selectMock, update: updateMock },
  runOutsideDbContext: vi.fn(),
  withSystemDbAccessContext: vi.fn(),
}));
vi.mock('./sensitiveDataPolicyAuthority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sensitiveDataPolicyAuthority')>()),
  resolveSensitiveDataAuthorityInCurrentSystemContext: resolveStampedMock,
  resolveLegacyPrincipalExecuteAuthorityInCurrentSystemContext: resolveLegacyMock,
}));

import {
  describeQuarantineApproval,
  resolveSecurityScanQuarantineAuthority,
  securityLinkAuthorityColumns,
} from './securityScanQuarantineAuthority';
import { captureSystemSensitiveDataAuthority, EMPTY_SENSITIVE_DATA_AUTHORITY } from './sensitiveDataPolicyAuthority';

const ORG = { orgId: '11111111-1111-1111-1111-111111111111', partnerId: null } as const;
const AUTHORITY = captureSystemSensitiveDataAuthority(ORG);
const CLEARED = { ...EMPTY_SENSITIVE_DATA_AUTHORITY, executionAuthorityLegacy: null };
const LIVE = { kind: 'organization_unrestricted', siteIds: null, userId: 'creator-1', principalKind: 'user', fingerprint: 'f', generation: 'g' };

function chain(rows: unknown): any {
  const result: any = Promise.resolve(rows);
  for (const method of ['from', 'innerJoin', 'where', 'limit', 'set']) result[method] = () => result;
  return result;
}

describe('securityLinkAuthorityColumns', () => {
  it('leaves non-security links untouched', () => {
    expect(securityLinkAuthorityColumns('patch', { autoQuarantine: true }, AUTHORITY)).toBeUndefined();
  });

  it('persists a captured authority while auto-quarantine is effectively on, leaving the legacy path', () => {
    expect(securityLinkAuthorityColumns('security', { autoQuarantine: true }, AUTHORITY))
      .toEqual({ ...AUTHORITY, executionAuthorityLegacy: null });
    // Omitted key = shared default (on).
    expect(securityLinkAuthorityColumns('security', {}, AUTHORITY))
      .toEqual({ ...AUTHORITY, executionAuthorityLegacy: null });
  });

  it('clears the stamp AND the legacy marker on a security write without a fresh authority', () => {
    expect(securityLinkAuthorityColumns('security', { autoQuarantine: true }, undefined)).toEqual(CLEARED);
  });

  it('clears the stamp when auto-quarantine is turned off, even with an authority supplied', () => {
    expect(securityLinkAuthorityColumns('security', { autoQuarantine: false }, AUTHORITY)).toEqual(CLEARED);
  });
});

describe('describeQuarantineApproval', () => {
  const link = (extra: Record<string, unknown>) => ({
    featureType: 'security', inlineSettings: { autoQuarantine: true }, ...EMPTY_SENSITIVE_DATA_AUTHORITY, ...extra,
  });

  it('reports approved / legacy_grandfathered / reapproval_required / not_enabled', () => {
    expect(describeQuarantineApproval(link({ ...AUTHORITY }), ORG)).toBe('approved');
    expect(describeQuarantineApproval(link({ executionAuthorityLegacy: 'grandfathered' }), ORG)).toBe('legacy_grandfathered');
    expect(describeQuarantineApproval(link({ executionAuthorityLegacy: 'revoked' }), ORG)).toBe('reapproval_required');
    expect(describeQuarantineApproval(link({}), ORG)).toBe('reapproval_required');
    expect(describeQuarantineApproval(link({ inlineSettings: { autoQuarantine: false } }), ORG)).toBe('not_enabled');
    expect(describeQuarantineApproval({ ...link({}), featureType: 'patch' }, ORG)).toBeUndefined();
  });

  it('does not accept a stamp minted for a different owner', () => {
    expect(describeQuarantineApproval(
      link({ ...AUTHORITY }),
      { orgId: '22222222-2222-2222-2222-222222222222', partnerId: null },
    )).toBe('reapproval_required');
  });
});

describe('resolveSecurityScanQuarantineAuthority', () => {
  const DEVICE = { orgId: ORG.orgId, siteId: 'site-1', partnerId: 'partner-1' };
  const linkRow = (extra: Record<string, unknown>) => ({
    orgId: ORG.orgId, partnerId: null, createdBy: 'creator-1',
    ...EMPTY_SENSITIVE_DATA_AUTHORITY, executionAuthorityLegacy: null, ...extra,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    setMock.mockImplementation(() => chain(undefined));
    updateMock.mockReturnValue({ set: setMock });
  });

  it('keeps quarantining a grandfathered legacy link while the policy creator holds devices:execute', async () => {
    selectMock
      .mockReturnValueOnce(chain([linkRow({ executionAuthorityLegacy: 'grandfathered' })]))
      .mockReturnValueOnce(chain([DEVICE]));
    resolveLegacyMock.mockResolvedValue(LIVE);

    expect(await resolveSecurityScanQuarantineAuthority('link-1', 'device-1')).toEqual({ allowed: true });
    expect(resolveLegacyMock).toHaveBeenCalledWith({ orgId: ORG.orgId, partnerId: null }, 'creator-1');
  });

  it('downgrades and flags a legacy link whose creator no longer qualifies', async () => {
    selectMock.mockReturnValueOnce(chain([linkRow({ executionAuthorityLegacy: 'grandfathered' })]));
    resolveLegacyMock.mockResolvedValue(null);

    expect(await resolveSecurityScanQuarantineAuthority('link-1', 'device-1'))
      .toEqual({ allowed: false, reason: 'reapproval_required' });
    expect(setMock).toHaveBeenCalledWith({ executionAuthorityLegacy: 'revoked' });
  });

  it('a stamped link ignores the legacy path even when its stamp fails', async () => {
    selectMock.mockReturnValueOnce(chain([linkRow({ ...AUTHORITY })]));
    resolveStampedMock.mockResolvedValue(null);
    resolveLegacyMock.mockResolvedValue(LIVE);

    expect(await resolveSecurityScanQuarantineAuthority('link-1', 'device-1'))
      .toEqual({ allowed: false, reason: 'authority_revoked' });
    expect(resolveLegacyMock).not.toHaveBeenCalled();
  });

  it('a revoked unstamped link stays detect-only without consulting the creator', async () => {
    selectMock.mockReturnValueOnce(chain([linkRow({ executionAuthorityLegacy: 'revoked' })]));

    expect(await resolveSecurityScanQuarantineAuthority('link-1', 'device-1'))
      .toEqual({ allowed: false, reason: 'reapproval_required' });
    expect(resolveLegacyMock).not.toHaveBeenCalled();
  });
});
