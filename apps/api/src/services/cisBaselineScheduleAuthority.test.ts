import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveStampedMock, resolveLegacyMock } = vi.hoisted(() => ({
  resolveStampedMock: vi.fn(),
  resolveLegacyMock: vi.fn(),
}));

vi.mock('../db', () => ({ db: {}, runOutsideDbContext: vi.fn(), withSystemDbAccessContext: vi.fn() }));
const { captureExceptionMock } = vi.hoisted(() => ({ captureExceptionMock: vi.fn() }));
vi.mock('./sentry', () => ({ captureException: captureExceptionMock }));
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
  executionAuthorityStatus: null as null | 'ok' | 'approver_invalid' | 'lookup_failed',
  executionAuthorityStatusAt: null as Date | null,
});
const stampedRow = (extra: Record<string, unknown> = {}) => ({
  ...legacyRow(null),
  ...captureSystemSensitiveDataAuthority({ orgId: ORG, partnerId: null }),
  ...extra,
});

describe('resolveCisScheduleDispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('grandfathers a legacy row while its creator holds devices:execute', async () => {
    resolveLegacyMock.mockResolvedValue(LIVE);
    const decision = await resolveCisScheduleDispatch(legacyRow('grandfathered'));
    expect(decision).toEqual({ ok: true, mode: 'legacy', authority: LIVE, checkStatus: 'ok' });
    expect(resolveLegacyMock).toHaveBeenCalledWith({ orgId: ORG, partnerId: null }, 'creator-1');
  });

  it('downgrades a legacy row whose creator is inactive or lost devices:execute, and asks to revoke', async () => {
    resolveLegacyMock.mockResolvedValue(null);
    expect(await resolveCisScheduleDispatch(legacyRow('grandfathered')))
      .toEqual({ ok: false, reason: 'reapproval_required', revokeLegacy: true, checkStatus: 'approver_invalid' });
  });

  it('a lookup failure skips the tick without revoking', async () => {
    resolveLegacyMock.mockRejectedValue(new Error('db down'));
    expect(await resolveCisScheduleDispatch(legacyRow('grandfathered')))
      .toEqual({ ok: false, reason: 'authority_unavailable', checkStatus: 'lookup_failed' });
    expect(captureExceptionMock).toHaveBeenCalled();
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
    expect(await resolveCisScheduleDispatch(stampedRow()))
      .toEqual({ ok: false, reason: 'reapproval_required', checkStatus: 'approver_invalid' });
    expect(resolveLegacyMock).not.toHaveBeenCalled();
  });

  it('a stamped row whose live lookup errors is a transient lookup_failed, reported to Sentry', async () => {
    resolveStampedMock.mockRejectedValue(new Error('db down'));
    expect(await resolveCisScheduleDispatch(stampedRow()))
      .toEqual({ ok: false, reason: 'authority_unavailable', checkStatus: 'lookup_failed' });
    expect(captureExceptionMock).toHaveBeenCalled();
  });

  it('a stamped row that resolves reports ok', async () => {
    resolveStampedMock.mockResolvedValue(LIVE);
    expect(await resolveCisScheduleDispatch(stampedRow()))
      .toEqual({ ok: true, mode: 'stamped', authority: LIVE, checkStatus: 'ok' });
  });

  it('reports legacy_grandfathered vs reapproval_required', () => {
    expect(describeCisScheduleApproval(legacyRow('grandfathered')).status).toBe('legacy_grandfathered');
    expect(describeCisScheduleApproval(legacyRow('revoked'))).toMatchObject({
      status: 'reapproval_required', reason: 'approver_invalid', approvedBy: 'creator-1',
    });
    expect(describeCisScheduleApproval(legacyRow(null))).toMatchObject({
      status: 'reapproval_required', reason: 'not_approved',
    });
  });

  it('a stamped row whose approver failed the last dispatch check is reported as needing re-approval', () => {
    const at = new Date('2026-12-12T00:00:00.000Z');
    expect(describeCisScheduleApproval(stampedRow({ executionAuthorityStatus: 'ok' })).status).toBe('approved');
    expect(describeCisScheduleApproval(stampedRow({
      executionAuthorityStatus: 'approver_invalid', executionAuthorityStatusAt: at,
    }))).toMatchObject({ status: 'reapproval_required', reason: 'approver_invalid', checkStatusSince: at.toISOString() });
    // A transient lookup failure does not claim the approval is gone.
    expect(describeCisScheduleApproval(stampedRow({ executionAuthorityStatus: 'lookup_failed' })))
      .toMatchObject({ status: 'approved', checkStatus: 'lookup_failed' });
  });
});
