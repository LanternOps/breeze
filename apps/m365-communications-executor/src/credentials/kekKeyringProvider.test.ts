import { describe, expect, it, vi } from 'vitest';
import type { SecretClientPort } from './azureKeyVaultProvider';
import { loadKekKeyring } from './kekKeyringProvider';

const VAULT_URL = 'https://customer-vault.vault.azure.net';
const V1 = '11112222333344445555666677778888';
const V2 = 'abcdef0123456789abcdef0123456789';

function envelope(keyBytes: Buffer, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    domain: 'communications-delegated',
    material: { kind: 'symmetric-key', keyBase64: keyBytes.toString('base64') },
    ...overrides,
  });
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    vaultUrl: VAULT_URL,
    tokenCacheKekVaultRef: `akv://customer-vault.vault.azure.net/m365-comms-token-cache-kek/${V2}`,
    tokenCacheKekWriterVersion: V2,
    tokenCacheKekReaderVersions: [V1, V2] as readonly string[],
    ...overrides,
  };
}

describe('loadKekKeyring', () => {
  it('loads every reader version and stamps the writer', async () => {
    const values: Record<string, string> = {
      [V1]: envelope(Buffer.alloc(32, 1)),
      [V2]: envelope(Buffer.alloc(32, 2)),
    };
    const getSecret = vi.fn(async (name: string, options: { version: string }) => ({
      value: values[options.version],
    }));
    const client: SecretClientPort = { getSecret };

    const keyring = await loadKekKeyring(config(), client);

    expect(keyring.writerVersion).toBe(V2);
    expect([...keyring.keys.keys()].sort()).toEqual([V1, V2].sort());
    expect(keyring.keys.get(V1)).toEqual(new Uint8Array(Buffer.alloc(32, 1)));
    expect(keyring.keys.get(V2)).toEqual(new Uint8Array(Buffer.alloc(32, 2)));
    expect(getSecret).toHaveBeenCalledTimes(2);
    expect(getSecret).toHaveBeenCalledWith('m365-comms-token-cache-kek', { version: V1 });
    expect(getSecret).toHaveBeenCalledWith('m365-comms-token-cache-kek', { version: V2 });
  });

  it('fails boot when a reader version is missing', async () => {
    const client: SecretClientPort = {
      getSecret: vi.fn(async (_name, options: { version: string }) => {
        if (options.version === V1) throw new Error('404 secret not found');
        return { value: envelope(Buffer.alloc(32, 2)) };
      }),
    };
    await expect(loadKekKeyring(config(), client)).rejects.toThrow(/unavailable at boot/);
  });

  it('fails boot on a key that is not 32 bytes', async () => {
    const client: SecretClientPort = {
      getSecret: vi.fn(async () => ({ value: envelope(Buffer.alloc(31, 1)) })),
    };
    await expect(loadKekKeyring(config(), client)).rejects.toThrow(/32 base64-encoded bytes/);
  });

  it('fails boot on a wrong material kind literal', async () => {
    const client: SecretClientPort = {
      getSecret: vi.fn(async () => ({
        value: JSON.stringify({
          schemaVersion: 1,
          domain: 'communications-delegated',
          material: { kind: 'certificate', keyBase64: Buffer.alloc(32, 1).toString('base64') },
        }),
      })),
    };
    await expect(loadKekKeyring(config(), client)).rejects.toThrow(/malformed/);
  });

  it('fails boot when the reader set omits the writer', async () => {
    const client: SecretClientPort = {
      getSecret: vi.fn(async () => ({ value: envelope(Buffer.alloc(32, 1)) })),
    };
    await expect(loadKekKeyring(config({
      tokenCacheKekReaderVersions: [V1] as readonly string[],
    }), client)).rejects.toThrow(/inconsistent/);
  });
});
