import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  evaluateCapability: vi.fn(),
  partnerIdForDevice: vi.fn(),
  partnerTrustMode: vi.fn(),
  insert: vi.fn(),
  runOutsideDbContext: vi.fn(<T>(fn: () => T): T => fn()),
  withSystemDbAccessContext: vi.fn(async <T>(fn: () => Promise<T>): Promise<T> => fn()),
}));

vi.mock('./partnerTrust', () => ({
  evaluateCapability: mocks.evaluateCapability,
  partnerIdForDevice: mocks.partnerIdForDevice,
}));
vi.mock('../config/partnerTrustMode', () => ({ partnerTrustMode: mocks.partnerTrustMode }));
vi.mock('../db', () => ({
  db: { insert: mocks.insert },
  runOutsideDbContext: mocks.runOutsideDbContext,
  withSystemDbAccessContext: mocks.withSystemDbAccessContext,
}));
vi.mock('../db/schema', () => ({
  remoteSessions: { table: 'remote' },
  supportSessions: { table: 'support' },
  tunnelSessions: { table: 'tunnel' },
}));

import { createRemoteSession, RemoteSessionDeniedError } from './remoteSessionCreate';

const remoteInput = {
  deviceId: 'device-1',
  orgId: 'org-1',
  userId: 'user-1',
  type: 'desktop' as const,
};
const supportInput = {
  partnerId: 'partner-1',
  orgId: 'org-1',
  createdByUserId: 'user-1',
  codeHash: 'hash',
  codeExpiresAt: new Date('2026-09-02T12:00:00Z'),
  hardExpiresAt: new Date('2026-09-02T18:00:00Z'),
};
const tunnelInput = {
  deviceId: 'device-1',
  orgId: 'org-1',
  userId: 'user-1',
  type: 'vnc' as const,
  status: 'pending' as const,
  targetHost: '127.0.0.1',
  targetPort: 5900,
};

function insertReturning(row: unknown) {
  const returning = vi.fn().mockResolvedValue([row]);
  const values = vi.fn().mockReturnValue({ returning });
  mocks.insert.mockReturnValue({ values });
  return { values, returning };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.partnerTrustMode.mockReturnValue('enforce');
  mocks.partnerIdForDevice.mockResolvedValue('partner-1');
  mocks.evaluateCapability.mockResolvedValue({ allow: true });
});

describe.each([
  ['remote', remoteInput],
  ['support', supportInput],
  ['tunnel', tunnelInput],
] as const)('createRemoteSession(%s)', (kind, input) => {
  it('throws on deny and does not insert', async () => {
    mocks.evaluateCapability.mockResolvedValue({
      allow: false,
      code: 'TRUST_PROBATION',
      capability: 'remote_control',
      reason: 'probation_default_deny',
    });

    await expect(createRemoteSession(kind as never, input as never)).rejects.toMatchObject({
      code: 'TRUST_PROBATION',
      reason: 'probation_default_deny',
      capability: 'remote_control',
    } satisfies Partial<RemoteSessionDeniedError>);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('returns the inserted row when allowed', async () => {
    const row = { id: `${kind}-1`, status: 'pending' };
    insertReturning(row);
    await expect(createRemoteSession(kind as never, input as never)).resolves.toBe(row);
    expect(mocks.evaluateCapability).toHaveBeenCalledWith('remote_control', {
      partnerId: 'partner-1',
      deviceId: kind === 'support' ? undefined : 'device-1',
      userId: 'user-1',
      detail: { kind },
    });
    if (kind === 'support') {
      expect(mocks.partnerIdForDevice).not.toHaveBeenCalled();
    } else {
      expect(mocks.partnerIdForDevice).toHaveBeenCalledWith('device-1');
    }
  });

  it('inserts and returns in shadow mode', async () => {
    mocks.partnerTrustMode.mockReturnValue('shadow');
    mocks.evaluateCapability.mockResolvedValue({
      allow: true,
      shadowDenied: { code: 'TRUST_PROBATION', reason: 'probation_default_deny' },
    });
    const row = { id: `${kind}-shadow`, status: 'pending' };
    insertReturning(row);
    await expect(createRemoteSession(kind as never, input as never)).resolves.toBe(row);
    expect(mocks.insert).toHaveBeenCalledOnce();
  });

  it('skips partner lookup and evaluation when mode is off', async () => {
    mocks.partnerTrustMode.mockReturnValue('off');
    const row = { id: `${kind}-off`, status: 'pending' };
    insertReturning(row);
    await expect(createRemoteSession(kind as never, input as never)).resolves.toBe(row);
    expect(mocks.partnerIdForDevice).not.toHaveBeenCalled();
    expect(mocks.evaluateCapability).not.toHaveBeenCalled();
  });
});

it('uses a caller-supplied id for a remote session when provided', async () => {
  const { values } = insertReturning({ id: 'caller-supplied-id', status: 'pending' });
  await createRemoteSession('remote', { ...remoteInput, id: 'caller-supplied-id' });
  expect(values).toHaveBeenCalledWith(expect.objectContaining({ id: 'caller-supplied-id' }));
});

it('passes tunnel values through verbatim', async () => {
  const { values } = insertReturning({ id: 'tunnel-1', status: 'pending' });
  await createRemoteSession('tunnel', tunnelInput);
  expect(values).toHaveBeenCalledWith(tunnelInput);
});

it('keeps support inserts in the escaped system DB context and strips partnerId', async () => {
  const { values } = insertReturning({ id: 'support-1', status: 'pending' });
  await createRemoteSession('support', supportInput);
  expect(mocks.runOutsideDbContext).toHaveBeenCalledOnce();
  expect(mocks.withSystemDbAccessContext).toHaveBeenCalledOnce();
  expect(values).toHaveBeenCalledWith(expect.not.objectContaining({ partnerId: expect.anything() }));
});
