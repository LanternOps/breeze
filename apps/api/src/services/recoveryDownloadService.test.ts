import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(async () => ({ size: 2 })),
}));

vi.mock('node:fs', () => ({
  createReadStream: vi.fn(() => ({ on: vi.fn(), destroy: vi.fn() })),
}));

const resolveSnapshotProviderConfigMock = vi.fn();

vi.mock('./recoveryBootstrap', () => ({
  asRecord: (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
  computeRecoveryDownloadExpiry: (authenticatedAt: Date | null, expiresAt: Date) =>
    authenticatedAt ? new Date(Math.min(authenticatedAt.getTime() + 60 * 60 * 1000, expiresAt.getTime())) : null,
  getStringValue: (record: Record<string, unknown> | null, key: string) =>
    record && typeof record[key] === 'string' ? String(record[key]) : null,
  resolveSnapshotProviderConfig: (...args: unknown[]) => resolveSnapshotProviderConfigMock(...args),
}));

import { getAuthenticatedRecoveryDownloadTarget } from './recoveryDownloadService';

describe('getAuthenticatedRecoveryDownloadTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows authenticated tokens to resolve in-scope local snapshot downloads', async () => {
    resolveSnapshotProviderConfigMock.mockResolvedValue({
      snapshot: {
        snapshotId: 'snap-ext-001',
        metadata: {},
      },
      providerType: 'local',
      providerConfig: {
        path: '/var/backups',
      },
    });

    const result = await getAuthenticatedRecoveryDownloadTarget(
      {
        id: 'token-1',
        snapshotId: 'snapshot-db-1',
        status: 'authenticated',
        authenticatedAt: new Date('2099-04-01T00:00:00.000Z'),
        expiresAt: new Date('2099-04-02T00:00:00.000Z'),
      } as any,
      'snapshots/snap-ext-001/manifest.json'
    );

    expect(result.unavailable).toBe(false);
  });

  it('rejects used tokens even if they still have authenticatedAt set', async () => {
    const result = await getAuthenticatedRecoveryDownloadTarget(
      {
        id: 'token-2',
        snapshotId: 'snapshot-db-2',
        status: 'used',
        authenticatedAt: new Date('2099-04-01T00:00:00.000Z'),
        expiresAt: new Date('2099-04-02T00:00:00.000Z'),
      } as any,
      'snapshots/snap-ext-001/manifest.json'
    );

    expect(result).toEqual({
      unavailable: true,
      reason: 'Token is used',
    });
  });

  it('rejects download paths outside the token snapshot scope', async () => {
    resolveSnapshotProviderConfigMock.mockResolvedValue({
      snapshot: {
        snapshotId: 'snap-ext-001',
        metadata: {},
      },
      providerType: 'local',
      providerConfig: {
        path: '/var/backups',
      },
    });

    const result = await getAuthenticatedRecoveryDownloadTarget(
      {
        id: 'token-3',
        snapshotId: 'snapshot-db-3',
        status: 'authenticated',
        authenticatedAt: new Date('2099-04-01T00:00:00.000Z'),
        expiresAt: new Date('2099-04-02T00:00:00.000Z'),
      } as any,
      'snapshots/other-snapshot/manifest.json'
    );

    expect(result).toEqual({
      unavailable: true,
      reason: 'Requested path is outside the allowed snapshot scope.',
    });
  });
});
