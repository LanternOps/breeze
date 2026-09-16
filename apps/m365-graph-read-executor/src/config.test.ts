import { ManagedIdentityCredential, WorkloadIdentityCredential } from '@azure/identity';
import { describe, expect, it } from 'vitest';
import { createAzureCredential, loadExecutorConfig } from './config';

const CLIENT_ID = 'c3333333-3333-4333-8333-333333333333';
const CREDENTIAL_VERSION = '0123456789abcdef0123456789abcdef';
const PUBLIC_JWK = {
  kty: 'OKP',
  crv: 'Ed25519',
  alg: 'EdDSA',
  use: 'sig',
  key_ops: ['verify'],
  kid: 'graph-read-api-1',
  x: Buffer.alloc(32, 1).toString('base64url'),
};

function validEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'production',
    M365_CUSTOMER_GRAPH_READ_CLIENT_ID: CLIENT_ID,
    M365_CUSTOMER_GRAPH_READ_CALLBACK_URL:
      'https://console.example.test/api/v1/m365/consent/callback',
    M365_CUSTOMER_GRAPH_READ_VAULT_URL: 'https://customer-vault.vault.azure.net',
    M365_CUSTOMER_GRAPH_READ_VAULT_REF:
      `akv://customer-vault.vault.azure.net/m365-customer-graph-read/${CREDENTIAL_VERSION}`,
    M365_CUSTOMER_GRAPH_READ_CREDENTIAL_VERSION: CREDENTIAL_VERSION,
    M365_GRAPH_READ_EXECUTOR_SIGNING_PUBLIC_JWK: JSON.stringify(PUBLIC_JWK),
    M365_GRAPH_READ_EXECUTOR_SIGNING_KID: 'graph-read-api-1',
    M365_GRAPH_READ_EXECUTOR_ISSUER: 'breeze-api',
    M365_GRAPH_READ_EXECUTOR_AUDIENCE: 'm365-graph-read-executor',
    M365_GRAPH_READ_EXECUTOR_AZURE_CREDENTIAL_MODE: 'managed-identity',
    M365_GRAPH_READ_EXECUTOR_BIND_HOST: '10.20.30.40',
    M365_GRAPH_READ_EXECUTOR_PORT: '8788',
    ...overrides,
  };
}

describe('M365 Graph-read executor config', () => {
  it('loads the fixed Graph-read profile and public internal-auth key', () => {
    expect(loadExecutorConfig(validEnv())).toEqual({
      clientId: CLIENT_ID,
      callbackUrl: 'https://console.example.test/api/v1/m365/consent/callback',
      vaultUrl: 'https://customer-vault.vault.azure.net',
      vaultRef: `akv://customer-vault.vault.azure.net/m365-customer-graph-read/${CREDENTIAL_VERSION}`,
      credentialVersion: CREDENTIAL_VERSION,
      internalAuthPublicJwk: PUBLIC_JWK,
      internalAuthKid: 'graph-read-api-1',
      internalAuthIssuer: 'breeze-api',
      internalAuthAudience: 'm365-graph-read-executor',
      azureCredentialMode: 'managed-identity',
      bindHost: '10.20.30.40',
      port: 8788,
      sync: {
        syncMaxInFlight: 4,
        maxInFlight: 32,
        signinActivityRpm: 4,
        signinPagesPerCall: 5,
        maxItemsUsers: 25_000,
        maxItemsDevices: 25_000,
        maxItemsCaPolicies: 500,
        maxItemsSkus: 200,
        maxItemsSigninEvents: 25_000,
        signinEventsRpm: 6,
        continuationKey: null,
      },
    });
  });

  it.each([
    'M365_CUSTOMER_GRAPH_READ_CLIENT_ID',
    'M365_CUSTOMER_GRAPH_READ_CALLBACK_URL',
    'M365_CUSTOMER_GRAPH_READ_VAULT_URL',
    'M365_CUSTOMER_GRAPH_READ_VAULT_REF',
    'M365_CUSTOMER_GRAPH_READ_CREDENTIAL_VERSION',
    'M365_GRAPH_READ_EXECUTOR_SIGNING_PUBLIC_JWK',
    'M365_GRAPH_READ_EXECUTOR_SIGNING_KID',
    'M365_GRAPH_READ_EXECUTOR_ISSUER',
    'M365_GRAPH_READ_EXECUTOR_AUDIENCE',
    'M365_GRAPH_READ_EXECUTOR_AZURE_CREDENTIAL_MODE',
    'M365_GRAPH_READ_EXECUTOR_BIND_HOST',
    'M365_GRAPH_READ_EXECUTOR_PORT',
  ])('requires %s', (name) => {
    expect(() => loadExecutorConfig(validEnv({ [name]: undefined }))).toThrow(name);
  });

  it.each([
    ['an uppercase client UUID', { M365_CUSTOMER_GRAPH_READ_CLIENT_ID: CLIENT_ID.toUpperCase() }, /CLIENT_ID/],
    ['a callback on the wrong path', { M365_CUSTOMER_GRAPH_READ_CALLBACK_URL: 'https://console.example.test/other' }, /CALLBACK_URL/],
    ['a callback query', { M365_CUSTOMER_GRAPH_READ_CALLBACK_URL: 'https://console.example.test/api/v1/m365/consent/callback?next=1' }, /CALLBACK_URL/],
    ['a non-HTTPS callback', { M365_CUSTOMER_GRAPH_READ_CALLBACK_URL: 'http://console.example.test/api/v1/m365/consent/callback' }, /CALLBACK_URL/],
    ['a non-HTTPS vault URL', { M365_CUSTOMER_GRAPH_READ_VAULT_URL: 'http://customer-vault.vault.azure.net' }, /VAULT_URL/],
    ['a vault URL with a path', { M365_CUSTOMER_GRAPH_READ_VAULT_URL: 'https://customer-vault.vault.azure.net/secrets' }, /VAULT_URL/],
    ['a per-customer secret name', { M365_CUSTOMER_GRAPH_READ_VAULT_REF: `akv://customer-vault.vault.azure.net/m365-customer-graph-read-${CLIENT_ID}/${CREDENTIAL_VERSION}` }, /VAULT_REF/],
    ['a different vault host', { M365_CUSTOMER_GRAPH_READ_VAULT_REF: `akv://another-vault.vault.azure.net/m365-customer-graph-read/${CREDENTIAL_VERSION}` }, /VAULT_REF.*VAULT_URL|VAULT_URL.*VAULT_REF/],
    ['a mismatched secret version', { M365_CUSTOMER_GRAPH_READ_CREDENTIAL_VERSION: 'f'.repeat(32) }, /VAULT_REF.*CREDENTIAL_VERSION|CREDENTIAL_VERSION.*VAULT_REF/],
    ['an arbitrary internal issuer', { M365_GRAPH_READ_EXECUTOR_ISSUER: 'another-api' }, /ISSUER/],
    ['an arbitrary internal audience', { M365_GRAPH_READ_EXECUTOR_AUDIENCE: 'another-executor' }, /AUDIENCE/],
    ['Azure CLI fallback mode', { M365_GRAPH_READ_EXECUTOR_AZURE_CREDENTIAL_MODE: 'azure-cli' }, /AZURE_CREDENTIAL_MODE/],
    ['default Azure fallback mode', { M365_GRAPH_READ_EXECUTOR_AZURE_CREDENTIAL_MODE: 'default' }, /AZURE_CREDENTIAL_MODE/],
  ])('rejects %s', (_label, overrides, error) => {
    expect(() => loadExecutorConfig(validEnv(overrides))).toThrow(error);
  });

  it.each([
    ['the wildcard IPv4 interface', { M365_GRAPH_READ_EXECUTOR_BIND_HOST: '0.0.0.0' }],
    ['the wildcard IPv6 interface', { M365_GRAPH_READ_EXECUTOR_BIND_HOST: '::' }],
    ['IPv4 loopback', { M365_GRAPH_READ_EXECUTOR_BIND_HOST: '127.0.0.1' }],
    ['another IPv4 loopback address', { M365_GRAPH_READ_EXECUTOR_BIND_HOST: '127.42.0.9' }],
    ['IPv6 loopback', { M365_GRAPH_READ_EXECUTOR_BIND_HOST: '::1' }],
    ['IPv6 link-local', { M365_GRAPH_READ_EXECUTOR_BIND_HOST: 'fe80::1' }],
    ['zone-scoped IPv6 link-local', { M365_GRAPH_READ_EXECUTOR_BIND_HOST: 'fe80::1%eth0' }],
    ['IPv4 multicast', { M365_GRAPH_READ_EXECUTOR_BIND_HOST: '239.1.2.3' }],
    ['IPv6 multicast', { M365_GRAPH_READ_EXECUTOR_BIND_HOST: 'ff02::1' }],
    ['a public interface', { M365_GRAPH_READ_EXECUTOR_BIND_HOST: '203.0.113.10' }],
    ['a hostname requiring resolution', { M365_GRAPH_READ_EXECUTOR_BIND_HOST: 'executor.internal' }],
    ['port zero', { M365_GRAPH_READ_EXECUTOR_PORT: '0' }],
    ['an out-of-range port', { M365_GRAPH_READ_EXECUTOR_PORT: '65536' }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => loadExecutorConfig(validEnv(overrides))).toThrow(/BIND_HOST|PORT/);
  });

  it.each([
    '10.0.0.0',
    '10.255.255.255',
    '172.16.0.0',
    '172.31.255.255',
    '192.168.0.0',
    '192.168.255.255',
    'fc00::',
    'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
  ])('accepts the RFC1918/ULA private boundary address %s', (bindHost) => {
    expect(loadExecutorConfig(validEnv({
      M365_GRAPH_READ_EXECUTOR_BIND_HOST: bindHost,
    })).bindHost).toBe(bindHost);
  });

  it.each([
    ['malformed JSON', '{not-json'],
    ['a private JWK', JSON.stringify({ ...PUBLIC_JWK, d: Buffer.alloc(32, 2).toString('base64url') })],
    ['the wrong curve', JSON.stringify({ ...PUBLIC_JWK, crv: 'X25519' })],
    ['signing-only operations', JSON.stringify({ ...PUBLIC_JWK, key_ops: ['sign'] })],
    ['a mismatched key id', JSON.stringify({ ...PUBLIC_JWK, kid: 'other-key' })],
  ])('rejects %s as the public internal-auth JWK', (_label, value) => {
    expect(() => loadExecutorConfig(validEnv({
      M365_GRAPH_READ_EXECUTOR_SIGNING_PUBLIC_JWK: value,
    }))).toThrow(/SIGNING_PUBLIC_JWK|SIGNING_KID/);
  });

  it('supports only explicit managed identity and workload identity credentials', () => {
    expect(createAzureCredential('managed-identity')).toBeInstanceOf(ManagedIdentityCredential);
    expect(createAzureCredential('workload-identity', {
      AZURE_TENANT_ID: 'a1111111-1111-4111-8111-111111111111',
      AZURE_CLIENT_ID: 'b2222222-2222-4222-8222-222222222222',
      AZURE_FEDERATED_TOKEN_FILE: '/var/run/secrets/azure/tokens/identity-token',
    })).toBeInstanceOf(WorkloadIdentityCredential);
  });

  it.each([
    'AZURE_TENANT_ID',
    'AZURE_CLIENT_ID',
    'AZURE_FEDERATED_TOKEN_FILE',
  ])('requires %s for explicit workload identity', (name) => {
    expect(() => createAzureCredential('workload-identity', {
      AZURE_TENANT_ID: 'a1111111-1111-4111-8111-111111111111',
      AZURE_CLIENT_ID: 'b2222222-2222-4222-8222-222222222222',
      AZURE_FEDERATED_TOKEN_FILE: '/var/run/secrets/azure/tokens/identity-token',
      [name]: undefined,
    })).toThrow(name);
  });

  it('loads workload identity mode without falling back to another credential source', () => {
    expect(loadExecutorConfig(validEnv({
      M365_GRAPH_READ_EXECUTOR_AZURE_CREDENTIAL_MODE: 'workload-identity',
    })).azureCredentialMode).toBe('workload-identity');
  });
});

describe('M365 Graph-read executor sync limits', () => {
  it('defaults every sync limit and leaves the continuation key ephemeral', () => {
    expect(loadExecutorConfig(validEnv()).sync).toEqual({
      syncMaxInFlight: 4,
      maxInFlight: 32,
      signinActivityRpm: 4,
      signinPagesPerCall: 5,
      maxItemsUsers: 25_000,
      maxItemsDevices: 25_000,
      maxItemsCaPolicies: 500,
      maxItemsSkus: 200,
      maxItemsSigninEvents: 25_000,
      signinEventsRpm: 6,
      continuationKey: null,
    });
  });

  it('parses explicit overrides and a 32-byte base64 continuation key', () => {
    const key = Buffer.alloc(32, 7);
    expect(loadExecutorConfig(validEnv({
      M365_SYNC_MAX_IN_FLIGHT: '2',
      M365_MAX_IN_FLIGHT: '8',
      M365_SIGNIN_ACTIVITY_RPM: '1',
      M365_SIGNIN_PAGES_PER_CALL: '20',
      M365_SYNC_MAX_ITEMS_USERS: '1000',
      M365_SYNC_MAX_ITEMS_DEVICES: '2000',
      M365_SYNC_MAX_ITEMS_CA: '50',
      M365_SYNC_MAX_ITEMS_SKUS: '10',
      M365_SYNC_MAX_ITEMS_SIGNIN_EVENTS: '3000',
      M365_SIGNIN_EVENTS_RPM: '2',
      M365_SYNC_CONTINUATION_KEY: key.toString('base64'),
    })).sync).toEqual({
      syncMaxInFlight: 2,
      maxInFlight: 8,
      signinActivityRpm: 1,
      signinPagesPerCall: 20,
      maxItemsUsers: 1000,
      maxItemsDevices: 2000,
      maxItemsCaPolicies: 50,
      maxItemsSkus: 10,
      maxItemsSigninEvents: 3000,
      signinEventsRpm: 2,
      continuationKey: key,
    });
  });

  it.each([
    ['M365_SYNC_MAX_IN_FLIGHT', '0'],
    ['M365_SYNC_MAX_IN_FLIGHT', '65'],
    ['M365_SYNC_MAX_IN_FLIGHT', '2.5'],
    ['M365_SYNC_MAX_IN_FLIGHT', 'four'],
    ['M365_MAX_IN_FLIGHT', '0'],
    ['M365_MAX_IN_FLIGHT', '1025'],
    ['M365_SIGNIN_ACTIVITY_RPM', '0'],
    ['M365_SIGNIN_ACTIVITY_RPM', '61'],
    ['M365_SIGNIN_PAGES_PER_CALL', '0'],
    ['M365_SIGNIN_PAGES_PER_CALL', '61'],
    ['M365_SYNC_MAX_ITEMS_USERS', '0'],
    ['M365_SYNC_MAX_ITEMS_USERS', '200001'],
    ['M365_SYNC_MAX_ITEMS_SKUS', '0'],
  ])('refuses %s=%s', (name, value) => {
    expect(() => loadExecutorConfig(validEnv({ [name]: value }))).toThrow(name);
  });

  it('refuses a total cap below the sync cap — interactive headroom must exist', () => {
    expect(() => loadExecutorConfig(validEnv({
      M365_SYNC_MAX_IN_FLIGHT: '8', M365_MAX_IN_FLIGHT: '4',
    }))).toThrow('M365_MAX_IN_FLIGHT');
  });

  it.each([
    Buffer.alloc(31, 1).toString('base64'),
    Buffer.alloc(33, 1).toString('base64'),
    'not base64 at all!!',
  ])('refuses a continuation key that is not exactly 32 bytes of base64', (value) => {
    expect(() => loadExecutorConfig(validEnv({ M365_SYNC_CONTINUATION_KEY: value })))
      .toThrow('M365_SYNC_CONTINUATION_KEY');
  });
});
