import { describe, expect, it, vi } from 'vitest';
import { AzureKeyVaultCredentialProvider, type SecretClientPort } from './azureKeyVaultProvider';

function client(): SecretClientPort {
  return {
    setSecret: vi.fn(async () => ({ properties: { version: 'version-1' } })),
    getSecret: vi.fn(async () => ({
      value: JSON.stringify({
        schemaVersion: 1,
        domain: 'customer-graph-read',
        material: {
          kind: 'certificate',
          certificatePem: 'CERT',
          privateKeyPem: 'PRIVATE',
          thumbprint: 'THUMB',
        },
      }),
    })),
    beginDeleteSecret: vi.fn(async () => ({ pollUntilDone: vi.fn(async () => undefined) })),
  };
}

describe('AzureKeyVaultCredentialProvider', () => {
  it('returns a versioned reference without returning the stored material', async () => {
    const port = client();
    const provider = new AzureKeyVaultCredentialProvider('https://vault.example', port);
    const stored = await provider.put({
      connectionId: '11111111-1111-1111-1111-111111111111',
      domain: 'customer-graph-read',
      material: { kind: 'certificate', certificatePem: 'CERT', privateKeyPem: 'PRIVATE', thumbprint: 'THUMB' },
    });
    expect(stored).toEqual({
      reference: 'akv://vault.example/m365-customer-graph-read-11111111-1111-1111-1111-111111111111/version-1',
      version: 'version-1',
    });
    expect(JSON.stringify(stored)).not.toContain('PRIVATE');
  });

  it('returns material only when the expected credential domain matches', async () => {
    const port = client();
    const provider = new AzureKeyVaultCredentialProvider('https://vault.example', port);
    const reference = 'akv://vault.example/m365-customer-graph-read-11111111-1111-1111-1111-111111111111/version-1';
    const material = await provider.get(reference, 'customer-graph-read');
    expect(material.kind).toBe('certificate');
    expect(port.getSecret).toHaveBeenCalledWith(
      'm365-customer-graph-read-11111111-1111-1111-1111-111111111111',
      { version: 'version-1' },
    );
    await expect(provider.get(reference, 'customer-graph-actions')).rejects.toThrow('Credential domain mismatch');
  });

  it('rejects references for a different vault host', async () => {
    const provider = new AzureKeyVaultCredentialProvider('https://vault.example', client());
    await expect(provider.get(
      'akv://other-vault.example/m365-customer-graph-read-id/version-1',
      'customer-graph-read',
    )).rejects.toThrow('Credential reference vault mismatch');
  });

  it.each([
    'https://vault.example/m365-customer-graph-read-id/version-1',
    'akv://vault.example/m365-customer-graph-read-id',
    'akv://vault.example/m365-customer-graph-read-id/version-1/extra',
  ])('rejects malformed credential reference %s', async (reference) => {
    const provider = new AzureKeyVaultCredentialProvider('https://vault.example', client());
    await expect(provider.get(reference, 'customer-graph-read')).rejects.toThrow(
      'Invalid Azure Key Vault credential reference',
    );
  });

  it('rejects a malformed credential envelope', async () => {
    const port = client();
    port.getSecret = vi.fn(async () => ({
      value: JSON.stringify({
        schemaVersion: 1,
        domain: 'customer-graph-read',
        material: { kind: 'unknown-secret-kind', value: 'SECRET' },
      }),
    }));
    const provider = new AzureKeyVaultCredentialProvider('https://vault.example', port);
    await expect(provider.get(
      'akv://vault.example/m365-customer-graph-read-id/version-1',
      'customer-graph-read',
    )).rejects.toThrow('Credential secret has an unsupported envelope');
  });

  it('rejects a refresh token in a certificate credential domain', async () => {
    const port = client();
    const provider = new AzureKeyVaultCredentialProvider('https://vault.example', port);
    await expect(provider.put({
      connectionId: '11111111-1111-1111-1111-111111111111',
      domain: 'customer-graph-read',
      material: { kind: 'delegated-refresh-token', refreshToken: 'REFRESH' },
    })).rejects.toThrow('Credential material does not match credential domain');
    expect(port.setSecret).not.toHaveBeenCalled();
  });

  it('rejects mixed credential material before storing it', async () => {
    const port = client();
    const provider = new AzureKeyVaultCredentialProvider('https://vault.example', port);
    await expect(provider.put({
      connectionId: '11111111-1111-1111-1111-111111111111',
      domain: 'customer-graph-read',
      material: {
        kind: 'certificate',
        certificatePem: 'CERT',
        privateKeyPem: 'PRIVATE',
        thumbprint: 'THUMB',
        refreshToken: 'REFRESH',
      } as never,
    })).rejects.toThrow('Credential material does not match credential domain');
    expect(port.setSecret).not.toHaveBeenCalled();
  });

  it('rejects a certificate returned for the delegated credential domain', async () => {
    const port = client();
    port.getSecret = vi.fn(async () => ({
      value: JSON.stringify({
        schemaVersion: 1,
        domain: 'communications-delegated',
        material: {
          kind: 'certificate',
          certificatePem: 'CERT',
          privateKeyPem: 'PRIVATE',
          thumbprint: 'THUMB',
        },
      }),
    }));
    const provider = new AzureKeyVaultCredentialProvider('https://vault.example', port);
    await expect(provider.get(
      'akv://vault.example/m365-communications-delegated-id/version-1',
      'communications-delegated',
    )).rejects.toThrow('Credential material does not match credential domain');
  });

  it('rejects an envelope that mixes material from separate credential domains', async () => {
    const port = client();
    port.getSecret = vi.fn(async () => ({
      value: JSON.stringify({
        schemaVersion: 1,
        domain: 'customer-graph-read',
        material: {
          kind: 'certificate',
          certificatePem: 'CERT',
          privateKeyPem: 'PRIVATE',
          thumbprint: 'THUMB',
          refreshToken: 'REFRESH',
        },
      }),
    }));
    const provider = new AzureKeyVaultCredentialProvider('https://vault.example', port);
    await expect(provider.get(
      'akv://vault.example/m365-customer-graph-read-id/version-1',
      'customer-graph-read',
    )).rejects.toThrow('Credential secret has an unsupported envelope');
  });

  it('waits for Key Vault deletion to complete', async () => {
    const port = client();
    const pollUntilDone = vi.fn(async () => undefined);
    port.beginDeleteSecret = vi.fn(async () => ({ pollUntilDone }));
    const provider = new AzureKeyVaultCredentialProvider('https://vault.example', port);
    await provider.delete(
      'akv://vault.example/m365-customer-graph-read-id/version-1',
      'customer-graph-read',
    );
    expect(port.beginDeleteSecret).toHaveBeenCalledWith('m365-customer-graph-read-id');
    expect(pollUntilDone).toHaveBeenCalledOnce();
  });
});
