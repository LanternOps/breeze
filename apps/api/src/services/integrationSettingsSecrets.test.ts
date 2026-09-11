import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptSecret } from './secretCrypto';
import {
  INTEGRATION_MASKED_SECRET,
  IntegrationSecretsUnavailableError,
  InvalidIntegrationSecretError,
  integrationSettingsSecretAad,
  isSecretFieldName,
  maskIntegrationSettings,
  sealIntegrationSettings,
} from './integrationSettingsSecrets';

// The shared test setup configures neither APP_ENCRYPTION_KEY nor
// APP_ENCRYPTION_KEY_ID, which is exactly the deployment shape this module now
// refuses to seal in (encryptSecret would drop the AAD and write enc:v1). Give
// the suite a real active key id so it exercises the v3 path that production
// is required to run, and restore the ambient env afterwards so no other file
// in this worker inherits it.
const priorEncryptionKey = process.env.APP_ENCRYPTION_KEY;
const priorEncryptionKeyId = process.env.APP_ENCRYPTION_KEY_ID;

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = 'integration-settings-secrets-test-key-material';
  process.env.APP_ENCRYPTION_KEY_ID = 'integration-settings-test';
});

afterAll(() => {
  if (priorEncryptionKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
  else process.env.APP_ENCRYPTION_KEY = priorEncryptionKey;
  if (priorEncryptionKeyId === undefined) delete process.env.APP_ENCRYPTION_KEY_ID;
  else process.env.APP_ENCRYPTION_KEY_ID = priorEncryptionKeyId;
});

describe('integration settings secret storage', () => {
  it('encrypts secret-shaped fields and masks response projections', () => {
    const input = {
      provider: 'example',
      credentials: { username: 'agent', password: 'private-password' },
      apiKey: 'private-api-key',
      url: 'https://public.example.test',
    };
    const sealed = sealIntegrationSettings(input, undefined, 'ticketing', 'org-a');

    expect(sealed.credentials).not.toEqual(input.credentials);
    const password = (sealed.credentials as Record<string, unknown>).password as string;
    expect(password).toMatch(/^enc:v3:integration-settings-test:/);
    expect(decryptSecret(password, {
      aad: integrationSettingsSecretAad('ticketing', 'org-a', ['credentials', 'password']),
    })).toBe('private-password');

    expect(maskIntegrationSettings(sealed)).toEqual({
      provider: 'example',
      credentials: { username: 'agent', password: INTEGRATION_MASKED_SECRET },
      apiKey: INTEGRATION_MASKED_SECRET,
      url: 'https://public.example.test',
    });
  });

  it('preserves an existing ciphertext when a client resaves a masked marker', () => {
    const first = sealIntegrationSettings({ apiSecret: 'private-secret' }, undefined, 'psa', 'org-a');
    const second = sealIntegrationSettings(
      { apiSecret: INTEGRATION_MASKED_SECRET, enabled: false },
      first,
      'psa',
      'org-a',
    );
    expect(second.apiSecret).toBe(first.apiSecret);
    expect(second.enabled).toBe(false);
  });

  it('rejects a masked marker when no secret is configured at that exact path', () => {
    expect(() => sealIntegrationSettings(
      { apiKey: INTEGRATION_MASKED_SECRET },
      undefined,
      'monitoring',
      'org-a',
    )).toThrow(InvalidIntegrationSecretError);
  });

  it('rejects client-supplied ciphertext instead of accepting an opaque envelope', () => {
    expect(() => sealIntegrationSettings(
      { apiKey: 'enc:v3:forged-envelope' },
      undefined,
      'monitoring',
      'org-a',
    )).toThrow(InvalidIntegrationSecretError);
  });

  it('treats monitoring webhook endpoint URLs as secrets without masking ordinary URLs', () => {
    const sealed = sealIntegrationSettings({
      grafana: { url: 'https://grafana.example.test' },
      webhooks: { endpoints: [{ url: 'https://hooks.example.test/private' }] },
    }, undefined, 'monitoring', 'org-a');
    const masked = maskIntegrationSettings(sealed);

    expect((masked.grafana as Record<string, unknown>).url).toBe('https://grafana.example.test');
    const endpoints = (masked.webhooks as { endpoints: Array<Record<string, unknown>> }).endpoints;
    expect(endpoints[0]?.url).toBe(INTEGRATION_MASKED_SECRET);
  });

  it('preserves webhook ciphertext by endpoint id when endpoints are reordered', () => {
    const first = sealIntegrationSettings({
      webhooks: {
        endpoints: [
          { id: 'primary', url: 'https://hooks.example.test/primary' },
          { id: 'secondary', url: 'https://hooks.example.test/secondary' },
        ],
      },
    }, undefined, 'monitoring', 'org-a');
    const firstEndpoints = (first.webhooks as { endpoints: Array<Record<string, unknown>> }).endpoints;

    const reordered = sealIntegrationSettings({
      webhooks: {
        endpoints: [
          { id: 'secondary', url: INTEGRATION_MASKED_SECRET },
          { id: 'primary', url: INTEGRATION_MASKED_SECRET },
        ],
      },
    }, first, 'monitoring', 'org-a');
    const reorderedEndpoints = (
      reordered.webhooks as { endpoints: Array<Record<string, unknown>> }
    ).endpoints;

    expect(reorderedEndpoints[0]?.url).toBe(firstEndpoints[1]?.url);
    expect(reorderedEndpoints[1]?.url).toBe(firstEndpoints[0]?.url);
  });

  it('rejects duplicate webhook endpoint ids before preserving masked secrets', () => {
    const existing = sealIntegrationSettings({
      webhooks: { endpoints: [{ id: 'duplicate', url: 'https://hooks.example.test/original' }] },
    }, undefined, 'monitoring', 'org-a');

    expect(() => sealIntegrationSettings({
      webhooks: {
        endpoints: [
          { id: 'duplicate', url: INTEGRATION_MASKED_SECRET },
          { id: 'duplicate', url: INTEGRATION_MASKED_SECRET },
        ],
      },
    }, existing, 'monitoring', 'org-a')).toThrow(InvalidIntegrationSecretError);
  });

  it('assigns a durable id to an id-less webhook before its masked round trip', () => {
    const first = sealIntegrationSettings({
      webhooks: { endpoints: [{ url: 'https://hooks.example.test/legacy' }] },
    }, undefined, 'monitoring', 'org-a');
    const firstEndpoint = (
      first.webhooks as { endpoints: Array<Record<string, unknown>> }
    ).endpoints[0];

    expect(firstEndpoint?.id).toEqual(expect.any(String));
    const second = sealIntegrationSettings({
      webhooks: {
        endpoints: [{ id: firstEndpoint?.id, url: INTEGRATION_MASKED_SECRET }],
      },
    }, first, 'monitoring', 'org-a');
    const secondEndpoint = (
      second.webhooks as { endpoints: Array<Record<string, unknown>> }
    ).endpoints[0];
    expect(secondEndpoint).toEqual(firstEndpoint);
  });

  it('seals with AAD-bound v3 ciphertext, never the non-AAD v1 fallback', () => {
    const sealed = sealIntegrationSettings(
      { apiKey: 'private-api-key' },
      undefined,
      'monitoring',
      'org-a',
    );

    // enc:v1 is the shape encryptSecret falls back to when no key id is
    // configured. It encrypts, but it silently ignores the `aad` option, so a
    // v1 value here would mean the family/org/path binding does not exist.
    expect(sealed.apiKey).toMatch(/^enc:v3:integration-settings-test:/);
    expect(sealed.apiKey).not.toMatch(/^enc:v1:/);
    expect(
      decryptSecret(sealed.apiKey as string, {
        aad: integrationSettingsSecretAad('monitoring', 'org-a', ['apiKey']),
      }),
    ).toBe('private-api-key');
  });

  it('refuses to seal a credential when no active encryption key id is configured', () => {
    const restore = process.env.APP_ENCRYPTION_KEY_ID;
    delete process.env.APP_ENCRYPTION_KEY_ID;
    try {
      expect(() =>
        sealIntegrationSettings({ apiKey: 'private-api-key' }, undefined, 'monitoring', 'org-a'),
      ).toThrow(IntegrationSecretsUnavailableError);
      expect(() =>
        sealIntegrationSettings({ apiKey: 'private-api-key' }, undefined, 'monitoring', 'org-a'),
      ).toThrow(/APP_ENCRYPTION_KEY_ID/);

      // A payload with no credential in it is unaffected: the assertion is made
      // at the point of encryption, so non-secret settings still save.
      expect(
        sealIntegrationSettings(
          { enabled: true, defaultChannel: '#ops' },
          undefined,
          'monitoring',
          'org-a',
        ),
      ).toEqual({ enabled: true, defaultChannel: '#ops' });
    } finally {
      if (restore === undefined) delete process.env.APP_ENCRYPTION_KEY_ID;
      else process.env.APP_ENCRYPTION_KEY_ID = restore;
    }
  });

  describe('credential-shaped field-name matching', () => {
    // The six names that the previous exact-name denylist missed entirely.
    it.each([
      'apiToken',
      'signingSecret',
      'sharedSecret',
      'bearerToken',
      'dsn',
      'passphrase',
    ])('treats %s as a credential', (field) => {
      expect(isSecretFieldName(field)).toBe(true);

      const sealed = sealIntegrationSettings({ [field]: 'private-value' }, undefined, 'psa', 'org-a');
      expect(sealed[field]).toMatch(/^enc:v3:/);
      expect(maskIntegrationSettings(sealed)[field]).toBe(INTEGRATION_MASKED_SECRET);
    });

    // Everything the previous exact-name set already covered must stay covered.
    it.each([
      'accessToken',
      'apiKey',
      'apiSecret',
      'authToken',
      'clientSecret',
      'connectionString',
      'integrationKey',
      'password',
      'privateKey',
      'refreshToken',
      'secret',
      'secretKey',
      'token',
      'webhookSecret',
      'webhookUrl',
    ])('still treats %s as a credential', (field) => {
      expect(isSecretFieldName(field)).toBe(true);
    });

    // Shipped non-credential fields of the four compatibility stores, plus the
    // explicit allowlist entries, must keep round-tripping in clear.
    it.each([
      'enabled',
      'provider',
      'baseUrl',
      'workspaceId',
      'workspaceName',
      'defaultChannel',
      'clientId',
      'tenantId',
      'severity',
      'username',
      'keyId',
      'keyName',
      'tokenCount',
    ])('does not treat %s as a credential', (field) => {
      expect(isSecretFieldName(field)).toBe(false);
    });

    it('seals a credential-named STRING but walks a credential-named CONTAINER', () => {
      // 'credentials' contains the 'credential' part. As a string it is a leaf
      // secret and must be sealed; as an object it is a container whose leaves
      // are judged by their own names, so the password seals and the username
      // keeps round-tripping in clear.
      const asString = sealIntegrationSettings(
        { credentials: 'user:private-password' },
        undefined,
        'ticketing',
        'org-a',
      );
      expect(asString.credentials).toMatch(/^enc:v3:/);
      expect(maskIntegrationSettings(asString)).toEqual({
        credentials: INTEGRATION_MASKED_SECRET,
      });

      const asContainer = sealIntegrationSettings(
        { credentials: { username: 'agent', password: 'private-password' } },
        undefined,
        'ticketing',
        'org-a',
      );
      const sealedContainer = asContainer.credentials as Record<string, unknown>;
      expect(sealedContainer.username).toBe('agent');
      expect(sealedContainer.password).toMatch(/^enc:v3:/);

      // The masked projection must WALK the container. Returning it untouched
      // would hand the reader the raw ciphertext of everything inside it.
      expect(maskIntegrationSettings(asContainer)).toEqual({
        credentials: { username: 'agent', password: INTEGRATION_MASKED_SECRET },
      });
    });

    it('rejects a non-string, non-container value at a credential-shaped name', () => {
      expect(() =>
        sealIntegrationSettings({ apiKey: 12345 }, undefined, 'psa', 'org-a'),
      ).toThrow(InvalidIntegrationSecretError);
    });

    it('leaves allowlisted names unsealed and unmasked end to end', () => {
      const sealed = sealIntegrationSettings(
        { keyName: 'primary', tokenCount: '3', apiToken: 'private-token' },
        undefined,
        'ticketing',
        'org-a',
      );

      expect(sealed.keyName).toBe('primary');
      expect(sealed.tokenCount).toBe('3');
      expect(sealed.apiToken).toMatch(/^enc:v3:/);
      expect(maskIntegrationSettings(sealed)).toEqual({
        keyName: 'primary',
        tokenCount: '3',
        apiToken: INTEGRATION_MASKED_SECRET,
      });
    });
  });
});
