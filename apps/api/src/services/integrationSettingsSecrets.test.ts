import { describe, expect, it } from 'vitest';
import { decryptSecret } from './secretCrypto';
import {
  INTEGRATION_MASKED_SECRET,
  InvalidIntegrationSecretError,
  integrationSettingsSecretAad,
  maskIntegrationSettings,
  sealIntegrationSettings,
} from './integrationSettingsSecrets';

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
    expect(password).toMatch(/^enc:v[123]:/);
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
});
