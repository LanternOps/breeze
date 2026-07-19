import { describe, expect, it, vi } from 'vitest';
import {
  AzureKeyVaultCertificateProvider,
  type SecretClientPort,
} from './azureKeyVaultProvider';

const SECRET_NAME = 'm365-customer-graph-actions';
const SECRET_VERSION = '0123456789abcdef0123456789abcdef';
const VAULT_URL = 'https://customer-vault.vault.azure.net';
const REFERENCE = `akv://customer-vault.vault.azure.net/${SECRET_NAME}/${SECRET_VERSION}`;

function client(value: unknown = {
  schemaVersion: 1,
  domain: 'customer-graph-actions',
  material: {
    kind: 'certificate',
    certificatePem: 'CERTIFICATE',
    privateKeyPem: 'PRIVATE-KEY',
  },
}): SecretClientPort {
  return {
    getSecret: vi.fn(async () => ({ value: JSON.stringify(value) })),
  };
}

function provider(port: SecretClientPort = client()) {
  return new AzureKeyVaultCertificateProvider({
    vaultUrl: VAULT_URL,
    vaultRef: REFERENCE,
    credentialVersion: SECRET_VERSION,
  }, port);
}

describe('AzureKeyVaultCertificateProvider', () => {
  it('reads only the configured profile secret at the pinned version', async () => {
    const port = client();

    await expect(provider(port).getConfiguredCertificate()).resolves.toEqual({
      certificatePem: 'CERTIFICATE',
      privateKeyPem: 'PRIVATE-KEY',
    });
    expect(port.getSecret).toHaveBeenCalledOnce();
    expect(port.getSecret).toHaveBeenCalledWith(SECRET_NAME, { version: SECRET_VERSION });
  });

  it('exposes only the read-only configured-certificate capability', () => {
    const instance = provider();

    expect(instance).toHaveProperty('getConfiguredCertificate');
    expect(instance).not.toHaveProperty('put');
    expect(instance).not.toHaveProperty('get');
    expect(instance).not.toHaveProperty('setSecret');
    expect(instance).not.toHaveProperty('delete');
  });

  it.each([
    ['a per-customer secret', `akv://customer-vault.vault.azure.net/${SECRET_NAME}-11111111-1111-1111-1111-111111111111/${SECRET_VERSION}`],
    ['a different profile', `akv://customer-vault.vault.azure.net/m365-customer-graph-read/${SECRET_VERSION}`],
    ['a different vault', `akv://other-vault.vault.azure.net/${SECRET_NAME}/${SECRET_VERSION}`],
    ['a different version', `akv://customer-vault.vault.azure.net/${SECRET_NAME}/${'f'.repeat(32)}`],
    ['an unversioned reference', `akv://customer-vault.vault.azure.net/${SECRET_NAME}`],
  ])('rejects %s before reading Key Vault', async (_label, vaultRef) => {
    const port = client();
    const instance = new AzureKeyVaultCertificateProvider({
      vaultUrl: VAULT_URL,
      vaultRef,
      credentialVersion: SECRET_VERSION,
    }, port);

    await expect(instance.getConfiguredCertificate()).rejects.toMatchObject({
      code: 'credential_unavailable',
      message: 'credential_unavailable',
    });
    expect(port.getSecret).not.toHaveBeenCalled();
  });

  it.each([
    ['an absent value', undefined],
    ['malformed JSON', '{not-json'],
    ['an extra envelope field', JSON.stringify({ schemaVersion: 1, domain: 'customer-graph-actions', material: { kind: 'certificate', certificatePem: 'CERT', privateKeyPem: 'KEY' }, extra: true })],
    ['the wrong schema version', JSON.stringify({ schemaVersion: 2, domain: 'customer-graph-actions', material: { kind: 'certificate', certificatePem: 'CERT', privateKeyPem: 'KEY' } })],
    ['the wrong domain', JSON.stringify({ schemaVersion: 1, domain: 'customer-graph-read', material: { kind: 'certificate', certificatePem: 'CERT', privateKeyPem: 'KEY' } })],
    ['a stored thumbprint', JSON.stringify({ schemaVersion: 1, domain: 'customer-graph-actions', material: { kind: 'certificate', certificatePem: 'CERT', privateKeyPem: 'KEY', thumbprint: 'THUMB' } })],
    ['an empty certificate', JSON.stringify({ schemaVersion: 1, domain: 'customer-graph-actions', material: { kind: 'certificate', certificatePem: '', privateKeyPem: 'KEY' } })],
    ['an extra material field', JSON.stringify({ schemaVersion: 1, domain: 'customer-graph-actions', material: { kind: 'certificate', certificatePem: 'CERT', privateKeyPem: 'KEY', refreshToken: 'SECRET' } })],
  ])('rejects %s with a fixed secret-free code', async (_label, value) => {
    const port: SecretClientPort = {
      getSecret: vi.fn(async () => ({
        value: typeof value === 'string' || value === undefined ? value : JSON.stringify(value),
      })),
    };

    const failure = await provider(port).getConfiguredCertificate().catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: 'credential_unavailable',
      message: 'credential_unavailable',
    });
    expect(failure).not.toHaveProperty('cause');
    expect(String(failure)).not.toContain('PRIVATE-KEY');
    expect(String(failure)).not.toContain(REFERENCE);
  });

  it('replaces an Azure SDK failure with a fixed secret-free code', async () => {
    const sentinel = 'SENTINEL-AZURE-PROVIDER-DETAIL';
    const port: SecretClientPort = {
      getSecret: vi.fn(async () => {
        throw Object.assign(new Error(`${sentinel} ${REFERENCE}`), {
          request: { reference: REFERENCE },
          response: { body: sentinel },
        });
      }),
    };

    const failure = await provider(port).getConfiguredCertificate().catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: 'credential_unavailable',
      message: 'credential_unavailable',
    });
    expect(failure).not.toHaveProperty('cause');
    expect(failure).not.toHaveProperty('request');
    expect(failure).not.toHaveProperty('response');
    expect(String(failure)).not.toContain(sentinel);
    expect(String(failure)).not.toContain(REFERENCE);
  });
});
