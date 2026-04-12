import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectMock = vi.fn();
const updateMock = vi.fn();
const encryptSecretMock = vi.fn((value: string | null | undefined) => {
  if (!value) return null;
  return value.startsWith('enc:') ? value : `enc:${value}`;
});
const decryptSecretMock = vi.fn((value: string | null | undefined) => {
  if (!value) return null;
  return value.startsWith('enc:') ? value.slice(4) : value;
});
const isEncryptedSecretMock = vi.fn((value: string) => value.startsWith('enc:'));

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'set']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
  },

  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  c2cConnections: {
    id: 'c2c_connections.id',
    clientSecret: 'c2c_connections.client_secret',
    refreshToken: 'c2c_connections.refresh_token',
    accessToken: 'c2c_connections.access_token',
  },
}));

vi.mock('./secretCrypto', () => ({
  encryptSecret: (...args: unknown[]) => encryptSecretMock(...(args as [any])),
  decryptSecret: (...args: unknown[]) => decryptSecretMock(...(args as [any])),
  isEncryptedSecret: (...args: unknown[]) => isEncryptedSecretMock(...(args as [any])),
}));

import {
  backfillC2cConnectionSecrets,
  decryptC2cConnectionSecrets,
  encryptC2cConnectionSecrets,
  hasPlaintextC2cConnectionSecrets,
} from './c2cSecrets';

describe('c2cSecrets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('encrypts only provided secret fields', () => {
    const result = encryptC2cConnectionSecrets({
      clientSecret: 'client-secret',
      refreshToken: undefined,
      accessToken: 'access-token',
    });

    expect(result).toEqual({
      clientSecret: 'enc:client-secret',
      refreshToken: undefined,
      accessToken: 'enc:access-token',
    });
  });

  it('decrypts persisted secret fields', () => {
    const result = decryptC2cConnectionSecrets({
      clientSecret: 'enc:client-secret',
      refreshToken: null,
      accessToken: 'enc:access-token',
    });

    expect(result).toEqual({
      clientSecret: 'client-secret',
      refreshToken: null,
      accessToken: 'access-token',
    });
  });

  it('detects plaintext secrets that need backfill', () => {
    expect(
      hasPlaintextC2cConnectionSecrets({
        clientSecret: null,
        refreshToken: 'plain-refresh',
        accessToken: 'enc:already-encrypted',
      })
    ).toBe(true);
  });

  it('backfills only rows that still contain plaintext secrets', async () => {
    selectMock
      .mockReturnValueOnce(
        chainMock([
          {
            id: 'row-1',
            clientSecret: 'plain-client',
            refreshToken: null,
            accessToken: 'enc:already-encrypted',
          },
          {
            id: 'row-2',
            clientSecret: 'enc:existing-client',
            refreshToken: null,
            accessToken: null,
          },
        ])
      )
      .mockReturnValueOnce(chainMock([]));
    updateMock.mockReturnValue(chainMock([]));

    const result = await backfillC2cConnectionSecrets();

    expect(result).toEqual({ scanned: 2, updated: 1 });
    expect(updateMock).toHaveBeenCalledTimes(1);
    const updateChain = updateMock.mock.results[0]?.value as Record<string, any> | undefined;
    expect(updateChain?.set).toHaveBeenCalledWith({
      clientSecret: 'enc:plain-client',
      refreshToken: null,
      accessToken: 'enc:already-encrypted',
    });
  });
});
