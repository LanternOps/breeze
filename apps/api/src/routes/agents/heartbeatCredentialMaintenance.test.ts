import { beforeEach, describe, expect, it, vi } from 'vitest';

const { promoteMock, rotationDueMock } = vi.hoisted(() => ({
  promoteMock: vi.fn(async (_input: unknown): Promise<boolean> => true),
  rotationDueMock: vi.fn((_issuedAt: Date | null | undefined): boolean => false),
}));

vi.mock('../../services/agentTokenPromotion', () => ({
  promotePendingAgentCredentials: (input: unknown) => promoteMock(input),
}));
vi.mock('../../middleware/agentAuth', () => ({
  isAgentTokenRotationDue: (issuedAt: Date | null | undefined) => rotationDueMock(issuedAt),
}));

import {
  computeCredentialMaintenance,
  shouldRenewCert,
  type CredentialMaintenanceDevice,
} from './heartbeatCredentialMaintenance';

const NOW = new Date('2026-09-26T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const hoursAhead = (h: number) => new Date(NOW.getTime() + h * 3_600_000);

function device(overrides: Partial<CredentialMaintenanceDevice> = {}): CredentialMaintenanceDevice {
  return {
    id: 'device-1',
    mtlsCertIssuedAt: null,
    mtlsCertExpiresAt: null,
    agentTokenHash: 'current-hash',
    pendingTokenHash: null,
    pendingTokenExpiresAt: null,
    pendingWatchdogTokenHash: null,
    pendingHelperTokenHash: null,
    watchdogTokenHash: 'watchdog-hash',
    helperTokenHash: 'helper-hash',
    tokenIssuedAt: hoursAgo(1),
    ...overrides,
  };
}

const base = {
  now: NOW,
  tenantDraining: false,
  authenticatedWithPreviousToken: false,
  pendingTokenPresented: false,
  // The hash of the token the caller authenticated with (agentAuth).
  presentedTokenHash: 'pending-hash' as string | undefined,
};

describe('shouldRenewCert', () => {
  it.each([
    ['no certificate', null, null, false],
    ['issued, before two thirds of lifetime', hoursAgo(10), hoursAhead(80), false],
    ['exactly at two thirds', hoursAgo(60), hoursAhead(30), true],
    ['past two thirds', hoursAgo(80), hoursAhead(10), true],
    ['expired', hoursAgo(100), hoursAgo(1), true],
    ['expiry without issue time', null, hoursAhead(1), false],
  ] as const)('%s', (_label, issuedAt, expiresAt, expected) => {
    expect(shouldRenewCert(device({ mtlsCertIssuedAt: issuedAt, mtlsCertExpiresAt: expiresAt }), NOW)).toBe(expected);
  });
});

describe('computeCredentialMaintenance', () => {
  beforeEach(() => {
    promoteMock.mockReset();
    promoteMock.mockResolvedValue(true);
    rotationDueMock.mockReset();
    rotationDueMock.mockReturnValue(false);
  });

  it('returns nothing for a healthy, current credential set', async () => {
    expect(await computeCredentialMaintenance({ ...base, device: device() })).toEqual({});
    expect(promoteMock).not.toHaveBeenCalled();
  });

  it('asks for a certificate renewal past two thirds of the lifetime', async () => {
    const result = await computeCredentialMaintenance({
      ...base,
      device: device({ mtlsCertIssuedAt: hoursAgo(80), mtlsCertExpiresAt: hoursAhead(10) }),
    });
    expect(result).toEqual({ renewCert: true });
  });

  it('asks for a token rotation when rotation is due', async () => {
    rotationDueMock.mockReturnValue(true);
    expect(await computeCredentialMaintenance({ ...base, device: device() })).toEqual({ rotateToken: true });
  });

  it('asks for a token rotation when no watchdog credential exists yet', async () => {
    expect(
      await computeCredentialMaintenance({ ...base, device: device({ watchdogTokenHash: null }) }),
    ).toEqual({ rotateToken: true });
  });

  it.each([
    ['tenant draining', { tenantDraining: true }],
    ['authenticated with the previous token', { authenticatedWithPreviousToken: true }],
  ])('never asks for a rotation when %s', async (_label, flags) => {
    rotationDueMock.mockReturnValue(true);
    expect(await computeCredentialMaintenance({ ...base, ...flags, device: device() })).toEqual({});
  });

  it('suppresses a new rotation while a staged one is live and not presented', async () => {
    rotationDueMock.mockReturnValue(true);
    const result = await computeCredentialMaintenance({
      ...base,
      device: device({ pendingTokenHash: 'pending-hash', pendingTokenExpiresAt: hoursAhead(1) }),
    });
    expect(result).toEqual({});
    expect(promoteMock).not.toHaveBeenCalled();
  });

  it('ignores an expired staged rotation', async () => {
    rotationDueMock.mockReturnValue(true);
    const result = await computeCredentialMaintenance({
      ...base,
      pendingTokenPresented: true,
      device: device({ pendingTokenHash: 'pending-hash', pendingTokenExpiresAt: hoursAgo(1) }),
    });
    expect(result).toEqual({ rotateToken: true });
    expect(promoteMock).not.toHaveBeenCalled();
  });

  it('implicitly promotes a presented staged credential and asks for nothing more', async () => {
    const d = device({
      pendingTokenHash: 'pending-hash',
      pendingTokenExpiresAt: hoursAhead(1),
      pendingWatchdogTokenHash: 'pending-watchdog',
      pendingHelperTokenHash: 'pending-helper',
    });
    const result = await computeCredentialMaintenance({ ...base, pendingTokenPresented: true, device: d });
    expect(result).toEqual({});
    expect(promoteMock).toHaveBeenCalledWith({
      deviceId: 'device-1',
      pendingTokenHash: 'pending-hash',
      expectedAgentTokenHash: 'current-hash',
      pendingWatchdogTokenHash: 'pending-watchdog',
      pendingHelperTokenHash: 'pending-helper',
      watchdogTokenHash: 'watchdog-hash',
      helperTokenHash: 'helper-hash',
    });
  });

  it('asks the agent to confirm when the implicit promotion did not land', async () => {
    promoteMock.mockResolvedValue(false);
    const result = await computeCredentialMaintenance({
      ...base,
      pendingTokenPresented: true,
      device: device({ pendingTokenHash: 'pending-hash', pendingTokenExpiresAt: hoursAhead(1) }),
    });
    expect(result).toEqual({ confirmTokenRotation: true });
  });

  it('asks the agent to confirm when the implicit promotion throws', async () => {
    promoteMock.mockRejectedValue(new Error('db down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await computeCredentialMaintenance({
      ...base,
      pendingTokenPresented: true,
      device: device({ pendingTokenHash: 'pending-hash', pendingTokenExpiresAt: hoursAhead(1) }),
    });
    expect(result).toEqual({ confirmTokenRotation: true });
    errorSpy.mockRestore();
  });

  it('never promotes a staged hash other than the one the caller authenticated with', async () => {
    // A re-stage landed between agentAuth's read and this one: the caller
    // presented the OLD staged token, so the new staged hash is not promoted.
    const result = await computeCredentialMaintenance({
      ...base,
      pendingTokenPresented: true,
      presentedTokenHash: 'older-staged-hash',
      device: device({ pendingTokenHash: 'pending-hash', pendingTokenExpiresAt: hoursAhead(1) }),
    });
    expect(promoteMock).not.toHaveBeenCalled();
    expect(result).toEqual({ confirmTokenRotation: true });
  });

  it('does not promote without a current agent token hash', async () => {
    const result = await computeCredentialMaintenance({
      ...base,
      pendingTokenPresented: true,
      device: device({ agentTokenHash: null, pendingTokenHash: 'pending-hash', pendingTokenExpiresAt: hoursAhead(1) }),
    });
    expect(promoteMock).not.toHaveBeenCalled();
    expect(result).toEqual({ confirmTokenRotation: true });
  });
});
