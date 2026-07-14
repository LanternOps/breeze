import { describe, expect, it, vi } from 'vitest';
import { AzureKeyVaultCredentialProvider, type SecretClientPort } from './azureKeyVaultProvider';

const CONNECTION_ID = '11111111-1111-1111-1111-111111111111';
const SECRET_NAME = `m365-customer-graph-read-${CONNECTION_ID}`;
const SECRET_VERSION = '0123456789abcdef0123456789abcdef';
const REFERENCE = `akv://vault.example/${SECRET_NAME}/${SECRET_VERSION}`;

function client(): SecretClientPort {
  return {
    setSecret: vi.fn(async () => ({ properties: { version: SECRET_VERSION } })),
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
      connectionId: CONNECTION_ID,
      domain: 'customer-graph-read',
      material: { kind: 'certificate', certificatePem: 'CERT', privateKeyPem: 'PRIVATE', thumbprint: 'THUMB' },
    });
    expect(stored).toEqual({
      reference: REFERENCE,
      version: SECRET_VERSION,
    });
    expect(JSON.stringify(stored)).not.toContain('PRIVATE');
  });

  it('returns material only when the expected credential domain matches', async () => {
    const port = client();
    const provider = new AzureKeyVaultCredentialProvider('https://vault.example', port);
    const material = await provider.get(REFERENCE, 'customer-graph-read');
    expect(material.kind).toBe('certificate');
    expect(port.getSecret).toHaveBeenCalledWith(
      SECRET_NAME,
      { version: SECRET_VERSION },
    );
    await expect(provider.get(REFERENCE, 'customer-graph-actions')).rejects.toThrow('Credential domain mismatch');
  });

  it('rejects references for a different vault host', async () => {
    const provider = new AzureKeyVaultCredentialProvider('https://vault.example', client());
    await expect(provider.get(
      `akv://other-vault.example/${SECRET_NAME}/${SECRET_VERSION}`,
      'customer-graph-read',
    )).rejects.toThrow('Credential reference vault mismatch');
  });

  it.each([
    `https://vault.example/${SECRET_NAME}/${SECRET_VERSION}`,
    `akv://vault.example/${SECRET_NAME}`,
    `akv://vault.example/${SECRET_NAME}/${SECRET_VERSION}/extra`,
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
      REFERENCE,
      'customer-graph-read',
    )).rejects.toThrow('Credential secret has an unsupported envelope');
  });

  it('rejects a refresh token in a certificate credential domain', async () => {
    const port = client();
    const provider = new AzureKeyVaultCredentialProvider('https://vault.example', port);
    await expect(provider.put({
      connectionId: CONNECTION_ID,
      domain: 'customer-graph-read',
      material: { kind: 'delegated-refresh-token', refreshToken: 'REFRESH' },
    })).rejects.toThrow('Credential material does not match credential domain');
    expect(port.setSecret).not.toHaveBeenCalled();
  });

  it('rejects mixed credential material before storing it', async () => {
    const port = client();
    const provider = new AzureKeyVaultCredentialProvider('https://vault.example', port);
    await expect(provider.put({
      connectionId: CONNECTION_ID,
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
      `akv://vault.example/m365-communications-delegated-${CONNECTION_ID}/${SECRET_VERSION}`,
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
      REFERENCE,
      'customer-graph-read',
    )).rejects.toThrow('Credential secret has an unsupported envelope');
  });

  it('waits for Key Vault deletion to complete', async () => {
    const port = client();
    const pollUntilDone = vi.fn(async () => undefined);
    port.beginDeleteSecret = vi.fn(async () => ({ pollUntilDone }));
    const provider = new AzureKeyVaultCredentialProvider('https://vault.example', port);
    await provider.delete(
      REFERENCE,
      'customer-graph-read',
    );
    expect(port.beginDeleteSecret).toHaveBeenCalledWith(SECRET_NAME);
    expect(pollUntilDone).toHaveBeenCalledOnce();
  });

  it('rejects a runtime-invalid put domain before credential material reaches the client', async () => {
    const port = client();
    const provider = new AzureKeyVaultCredentialProvider('https://vault.example', port);

    await expect(provider.put({
      connectionId: CONNECTION_ID,
      domain: 'unrecognized' as never,
      material: { kind: 'certificate', certificatePem: 'CERT', privateKeyPem: 'PRIVATE', thumbprint: 'THUMB' },
    })).rejects.toThrow('Unsupported M365 credential domain');
    expect(port.setSecret).not.toHaveBeenCalled();
  });

  it('rejects a runtime-invalid expected get domain before accessing the client', async () => {
    const port = client();
    const provider = new AzureKeyVaultCredentialProvider('https://vault.example', port);

    await expect(provider.get(REFERENCE, 'unrecognized' as never)).rejects.toThrow(
      'Unsupported M365 credential domain',
    );
    expect(port.getSecret).not.toHaveBeenCalled();
  });

  it('rejects a runtime-invalid expected delete domain before accessing the client', async () => {
    const port = client();
    const provider = new AzureKeyVaultCredentialProvider('https://vault.example', port);

    await expect(provider.delete(REFERENCE, 'unrecognized' as never)).rejects.toThrow(
      'Unsupported M365 credential domain',
    );
    expect(port.beginDeleteSecret).not.toHaveBeenCalled();
  });

  it.each([
    `akv://vault.example/m365-customer-graph-read-arbitrary/${SECRET_VERSION}`,
    `akv://vault.example/${SECRET_NAME}/anything`,
    `akv://vault.example/m365-customer-graph-read-extra-${CONNECTION_ID}/${SECRET_VERSION}`,
  ])('rejects noncanonical delete reference %s before deleting any secret versions', async (reference) => {
    const port = client();
    const provider = new AzureKeyVaultCredentialProvider('https://vault.example', port);

    await expect(provider.delete(reference, 'customer-graph-read')).rejects.toThrow(
      'Invalid Azure Key Vault credential reference',
    );
    expect(port.beginDeleteSecret).not.toHaveBeenCalled();
  });

  it('accepts an Azure-generated 32-hex-character secret version', async () => {
    const port = client();
    const provider = new AzureKeyVaultCredentialProvider('https://vault.example', port);

    await provider.get(REFERENCE, 'customer-graph-read');

    expect(port.getSecret).toHaveBeenCalledWith(SECRET_NAME, { version: SECRET_VERSION });
  });

  it('rejects the former test-only version literal before accessing Key Vault', async () => {
    const port = client();
    const provider = new AzureKeyVaultCredentialProvider('https://vault.example', port);
    await expect(provider.get(
      `akv://vault.example/${SECRET_NAME}/version-1`,
      'customer-graph-read',
    )).rejects.toThrow('Invalid Azure Key Vault credential reference');
    expect(port.getSecret).not.toHaveBeenCalled();
  });

  it('does not emit a provider reference for a noncanonical returned version', async () => {
    const port = client();
    port.setSecret = vi.fn(async () => ({ properties: { version: 'anything' } }));
    const provider = new AzureKeyVaultCredentialProvider('https://vault.example', port);

    await expect(provider.put({
      connectionId: CONNECTION_ID,
      domain: 'customer-graph-read',
      material: { kind: 'certificate', certificatePem: 'CERT', privateKeyPem: 'PRIVATE', thumbprint: 'THUMB' },
    })).rejects.toThrow('Azure Key Vault did not return a valid secret version');
  });

  it('replaces a credential write failure with a fixed secret-free error', async () => {
    const port = client();
    const sentinel = 'SENTINEL-PRIVATE-KEY-WRITE';
    port.setSecret = vi.fn(async (_name, envelope) => {
      throw Object.assign(new Error(`sdk write failure: ${envelope}`), {
        request: { body: envelope },
        response: { body: sentinel },
      });
    });
    const provider = new AzureKeyVaultCredentialProvider('https://vault.example', port);

    const failure = await provider.put({
      connectionId: CONNECTION_ID,
      domain: 'customer-graph-read',
      material: { kind: 'certificate', certificatePem: 'CERT', privateKeyPem: sentinel, thumbprint: 'THUMB' },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('Azure Key Vault credential write failed');
    expect(failure).not.toHaveProperty('cause');
    expect(failure).not.toHaveProperty('request');
    expect(failure).not.toHaveProperty('response');
    expect(failure).not.toHaveProperty('envelope');
    expect(String(failure)).not.toContain(sentinel);
    expect(String(failure)).not.toContain(REFERENCE);
  });

  it('replaces a credential read failure with a fixed secret-free error', async () => {
    const port = client();
    const sentinel = 'SENTINEL-REFRESH-TOKEN-READ';
    port.getSecret = vi.fn(async () => {
      throw Object.assign(new Error(`sdk read failure: ${sentinel} ${REFERENCE}`), {
        request: { reference: REFERENCE },
        response: { body: sentinel },
      });
    });
    const provider = new AzureKeyVaultCredentialProvider('https://vault.example', port);

    const failure = await provider.get(REFERENCE, 'customer-graph-read').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('Azure Key Vault credential read failed');
    expect(failure).not.toHaveProperty('cause');
    expect(failure).not.toHaveProperty('request');
    expect(failure).not.toHaveProperty('response');
    expect(failure).not.toHaveProperty('envelope');
    expect(String(failure)).not.toContain(sentinel);
    expect(String(failure)).not.toContain(REFERENCE);
  });

  it.each(['begin', 'poll'] as const)(
    'replaces a credential delete %s failure with a fixed secret-free error',
    async (failureStage) => {
      const port = client();
      const sentinel = `SENTINEL-DELETE-${failureStage}`;
      const sdkError = Object.assign(new Error(`sdk delete failure: ${sentinel} ${REFERENCE}`), {
        request: { reference: REFERENCE },
        response: { body: sentinel },
      });
      port.beginDeleteSecret = failureStage === 'begin'
        ? vi.fn(async () => { throw sdkError; })
        : vi.fn(async () => ({ pollUntilDone: vi.fn(async () => { throw sdkError; }) }));
      const provider = new AzureKeyVaultCredentialProvider('https://vault.example', port);

      const failure = await provider.delete(REFERENCE, 'customer-graph-read').catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe('Azure Key Vault credential delete failed');
      expect(failure).not.toHaveProperty('cause');
      expect(failure).not.toHaveProperty('request');
      expect(failure).not.toHaveProperty('response');
      expect(failure).not.toHaveProperty('envelope');
      expect(String(failure)).not.toContain(sentinel);
      expect(String(failure)).not.toContain(REFERENCE);
    },
  );

  it('deletes the whole named secret only after validating a canonical pinned reference', async () => {
    const port = client();
    const provider = new AzureKeyVaultCredentialProvider('https://vault.example', port);

    await provider.delete(REFERENCE, 'customer-graph-read');

    // Azure beginDeleteSecret is name-scoped: deleting the name deletes all versions.
    expect(port.beginDeleteSecret).toHaveBeenCalledWith(SECRET_NAME);
  });
});
