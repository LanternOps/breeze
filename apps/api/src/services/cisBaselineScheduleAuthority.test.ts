import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveStampedMock, resolveLegacyMock } = vi.hoisted(() => ({
  resolveStampedMock: vi.fn(),
  resolveLegacyMock: vi.fn(),
}));

vi.mock('../db', () => ({ db: {}, runOutsideDbContext: vi.fn(), withSystemDbAccessContext: vi.fn() }));
vi.mock('./sensitiveDataPolicyAuthority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sensitiveDataPolicyAuthority')>()),
  resolveSensitiveDataAuthorityInCurrentSystemContext: resolveStampedMock,
  resolveLegacyPrincipalExecuteAuthorityInCurrentSystemContext: resolveLegacyMock,
}));

import { describeCisScheduleApproval, resolveCisScheduleDispatch } from './cisBaselineScheduleAuthority';
import { captureSystemSensitiveDataAuthority, EMPTY_SENSITIVE_DATA_AUTHORITY } from './sensitiveDataPolicyAuthority';

const ORG = '11111111-1111-1111-1111-111111111111';
const LIVE = { kind: 'organization_unrestricted', siteIds: null, userId: 'creator-1', principalKind: 'user', fingerprint: 'f', generation: 'g' };

const legacyRow = (legacy: 'grandfathered' | 'revoked' | null) => ({
  id: 'baseline-1',
  orgId: ORG,
  partnerId: null,
  createdBy: 'creator-1',
  isActive: true,
  scanSchedule: { enabled: true },
  ...EMPTY_SENSITIVE_DATA_AUTHORITY,
  executionAuthorityLegacy: legacy,
});

describe('resolveCisScheduleDispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('grandfathers a legacy row while its creator holds devices:execute', async () => {
    resolveLegacyMock.mockResolvedValue(LIVE);
    const decision = await resolveCisScheduleDispatch(legacyRow('grandfathered'));
    expect(decision).toEqual({ ok: true, mode: 'legacy', authority: LIVE });
    expect(resolveLegacyMock).toHaveBeenCalledWith({ orgId: ORG, partnerId: null }, 'creator-1');
  });

  it('downgrades a legacy row whose creator is inactive or lost devices:execute, and asks to revoke', async () => {
    resolveLegacyMock.mockResolvedValue(null);
    expect(await resolveCisScheduleDispatch(legacyRow('grandfathered')))
      .toEqual({ ok: false, reason: 'reapproval_required', revokeLegacy: true });
  });

  it('a lookup failure skips the tick without revoking', async () => {
    resolveLegacyMock.mockRejectedValue(new Error('db down'));
    expect(await resolveCisScheduleDispatch(legacyRow('grandfathered')))
      .toEqual({ ok: false, reason: 'authority_unavailable' });
  });

  it('a revoked legacy row never re-enters the legacy path', async () => {
    resolveLegacyMock.mockResolvedValue(LIVE);
    expect(await resolveCisScheduleDispatch(legacyRow('revoked')))
      .toEqual({ ok: false, reason: 'reapproval_required' });
    expect(resolveLegacyMock).not.toHaveBeenCalled();
  });

  it('a stamped row ignores the legacy path even when its stamp fails', async () => {
    resolveStampedMock.mockResolvedValue(null);
    resolveLegacyMock.mockResolvedValue(LIVE);
    const stamped = {
      ...legacyRow(null),
      ...captureSystemSensitiveDataAuthority({ orgId: ORG, partnerId: null }),
    };
    expect(await resolveCisScheduleDispatch(stamped)).toEqual({ ok: false, reason: 'reapproval_required' });
    expect(resolveLegacyMock).not.toHaveBeenCalled();
  });

  it('reports legacy_grandfathered vs reapproval_required', () => {
    expect(describeCisScheduleApproval(legacyRow('grandfathered')).status).toBe('legacy_grandfathered');
    expect(describeCisScheduleApproval(legacyRow('revoked')).status).toBe('reapproval_required');
    expect(describeCisScheduleApproval(legacyRow(null)).status).toBe('reapproval_required');
  });
});
