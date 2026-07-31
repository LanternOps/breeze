import { ManagedIdentityCredential, WorkloadIdentityCredential } from '@azure/identity';
import { describe, expect, it } from 'vitest';
import { createAzureCredential, loadExecutorConfig } from './config';

const CLIENT_ID = 'c3333333-3333-4333-8333-333333333333';
const CERT_VERSION = '0123456789abcdef0123456789abcdef';
const KEK_VERSION = 'abcdef0123456789abcdef0123456789';
const KEK_READER_OLD = '11112222333344445555666677778888';
const PUBLIC_JWK = {
  kty: 'OKP',
  crv: 'Ed25519',
  alg: 'EdDSA',
  use: 'sig',
  key_ops: ['verify'],
  kid: 'comms-api-1',
  x: Buffer.alloc(32, 1).toString('base64url'),
};

function validEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'production',
    M365_COMMS_CLIENT_ID: CLIENT_ID,
    M365_COMMS_CALLBACK_URL:
      'https://console.example.test/api/v1/m365/comms-consent/callback',
    M365_COMMS_VAULT_URL: 'https://customer-vault.vault.azure.net',
    M365_COMMS_CLIENT_CERT_VAULT_REF:
      `akv://customer-vault.vault.azure.net/m365-comms-client-cert/${CERT_VERSION}`,
    M365_COMMS_CLIENT_CERT_VERSION: CERT_VERSION,
    M365_COMMS_TOKEN_CACHE_KEK_VERSION: KEK_VERSION,
    M365_COMMS_TOKEN_CACHE_KEK_VAULT_REF:
      `akv://customer-vault.vault.azure.net/m365-comms-token-cache-kek/${KEK_VERSION}`,
    M365_COMMS_TOKEN_CACHE_KEK_READER_VERSIONS: `${KEK_READER_OLD},${KEK_VERSION}`,
    M365_COMMS_TOKEN_CACHE_DSN: 'postgresql://comms:comms@cache-db.internal:5432/comms_token_cache',
    M365_COMMS_EXECUTOR_SIGNING_PUBLIC_JWK: JSON.stringify(PUBLIC_JWK),
    M365_COMMS_EXECUTOR_SIGNING_KID: 'comms-api-1',
    M365_COMMS_EXECUTOR_ISSUER: 'breeze-api',
    M365_COMMS_EXECUTOR_AUDIENCE: 'm365-communications-executor',
    M365_COMMS_EXECUTOR_AZURE_CREDENTIAL_MODE: 'managed-identity',
    M365_COMMS_EXECUTOR_BIND_HOST: '10.20.30.40',
    M365_COMMS_EXECUTOR_PORT: '3005',
    ...overrides,
  };
}

describe('M365 communications executor config', () => {
  it('loads the fixed comms profile, KEK keyring, and public internal-auth key', () => {
    expect(loadExecutorConfig(validEnv())).toEqual({
      clientId: CLIENT_ID,
      callbackUrl: 'https://console.example.test/api/v1/m365/comms-consent/callback',
      vaultUrl: 'https://customer-vault.vault.azure.net',
      clientCertVaultRef: `akv://customer-vault.vault.azure.net/m365-comms-client-cert/${CERT_VERSION}`,
      clientCertVersion: CERT_VERSION,
      tokenCacheKekWriterVersion: KEK_VERSION,
      tokenCacheKekVaultRef: `akv://customer-vault.vault.azure.net/m365-comms-token-cache-kek/${KEK_VERSION}`,
      tokenCacheKekReaderVersions: [KEK_READER_OLD, KEK_VERSION],
      tokenCacheDsn: 'postgresql://comms:comms@cache-db.internal:5432/comms_token_cache',
      internalAuthPublicJwk: PUBLIC_JWK,
      internalAuthKid: 'comms-api-1',
      azureCredentialMode: 'managed-identity',
      bindHost: '10.20.30.40',
      port: 3005,
    });
  });

  it.each([
    'M365_COMMS_CLIENT_ID',
    'M365_COMMS_CALLBACK_URL',
    'M365_COMMS_VAULT_URL',
    'M365_COMMS_CLIENT_CERT_VAULT_REF',
    'M365_COMMS_CLIENT_CERT_VERSION',
    'M365_COMMS_TOKEN_CACHE_KEK_VERSION',
    'M365_COMMS_TOKEN_CACHE_KEK_VAULT_REF',
    'M365_COMMS_TOKEN_CACHE_KEK_READER_VERSIONS',
    'M365_COMMS_TOKEN_CACHE_DSN',
    'M365_COMMS_EXECUTOR_SIGNING_PUBLIC_JWK',
    'M365_COMMS_EXECUTOR_SIGNING_KID',
    'M365_COMMS_EXECUTOR_ISSUER',
    'M365_COMMS_EXECUTOR_AUDIENCE',
    'M365_COMMS_EXECUTOR_AZURE_CREDENTIAL_MODE',
    'M365_COMMS_EXECUTOR_BIND_HOST',
    'M365_COMMS_EXECUTOR_PORT',
  ])('requires %s', (name) => {
    expect(() => loadExecutorConfig(validEnv({ [name]: undefined }))).toThrow(name);
  });

  it.each([
    ['an uppercase client UUID', { M365_COMMS_CLIENT_ID: CLIENT_ID.toUpperCase() }, /CLIENT_ID/],
    ['a callback on the wrong path', { M365_COMMS_CALLBACK_URL: 'https://console.example.test/other' }, /CALLBACK_URL/],
    ['a callback on the sibling actions path', { M365_COMMS_CALLBACK_URL: 'https://console.example.test/api/v1/m365/actions-consent/callback' }, /CALLBACK_URL/],
    ['a callback query', { M365_COMMS_CALLBACK_URL: 'https://console.example.test/api/v1/m365/comms-consent/callback?next=1' }, /CALLBACK_URL/],
    ['a non-HTTPS callback', { M365_COMMS_CALLBACK_URL: 'http://console.example.test/api/v1/m365/comms-consent/callback' }, /CALLBACK_URL/],
    ['a non-HTTPS vault URL', { M365_COMMS_VAULT_URL: 'http://customer-vault.vault.azure.net' }, /VAULT_URL/],
    ['a vault URL with a path', { M365_COMMS_VAULT_URL: 'https://customer-vault.vault.azure.net/secrets' }, /VAULT_URL/],
    ['a per-customer cert secret', { M365_COMMS_CLIENT_CERT_VAULT_REF: `akv://customer-vault.vault.azure.net/m365-comms-client-cert-${CLIENT_ID}/${CERT_VERSION}` }, /CLIENT_CERT_VAULT_REF/],
    ['a different cert vault host', { M365_COMMS_CLIENT_CERT_VAULT_REF: `akv://another-vault.vault.azure.net/m365-comms-client-cert/${CERT_VERSION}` }, /CLIENT_CERT_VAULT_REF.*VAULT_URL|VAULT_URL.*CLIENT_CERT_VAULT_REF/],
    ['a mismatched cert secret version', { M365_COMMS_CLIENT_CERT_VERSION: 'f'.repeat(32) }, /CLIENT_CERT_VAULT_REF.*CLIENT_CERT_VERSION|CLIENT_CERT_VERSION.*CLIENT_CERT_VAULT_REF/],
    ['a different KEK vault host', { M365_COMMS_TOKEN_CACHE_KEK_VAULT_REF: `akv://another-vault.vault.azure.net/m365-comms-token-cache-kek/${KEK_VERSION}` }, /TOKEN_CACHE_KEK_VAULT_REF/],
    ['a mismatched KEK version in the ref', { M365_COMMS_TOKEN_CACHE_KEK_VAULT_REF: `akv://customer-vault.vault.azure.net/m365-comms-token-cache-kek/${'f'.repeat(32)}` }, /TOKEN_CACHE_KEK_VAULT_REF/],
    ['an arbitrary internal issuer', { M365_COMMS_EXECUTOR_ISSUER: 'another-api' }, /ISSUER/],
    ['an arbitrary internal audience', { M365_COMMS_EXECUTOR_AUDIENCE: 'm365-graph-actions-executor' }, /AUDIENCE/],
    ['Azure CLI fallback mode', { M365_COMMS_EXECUTOR_AZURE_CREDENTIAL_MODE: 'azure-cli' }, /AZURE_CREDENTIAL_MODE/],
    ['default Azure fallback mode', { M365_COMMS_EXECUTOR_AZURE_CREDENTIAL_MODE: 'default' }, /AZURE_CREDENTIAL_MODE/],
  ])('rejects %s', (_label, overrides, error) => {
    expect(() => loadExecutorConfig(validEnv(overrides))).toThrow(error);
  });

  it('rejects a keyring reader set that omits the writer version', () => {
    // A reader set without the writer is a config that cannot decrypt its own
    // writes — refuse at boot rather than fail on the first row read-back.
    expect(() => loadExecutorConfig(validEnv({
      M365_COMMS_TOKEN_CACHE_KEK_READER_VERSIONS: KEK_READER_OLD,
    }))).toThrow(/READER_VERSIONS/);
  });

  it('rejects a malformed keyring reader entry', () => {
    expect(() => loadExecutorConfig(validEnv({
      M365_COMMS_TOKEN_CACHE_KEK_READER_VERSIONS: `${KEK_VERSION},not-hex`,
    }))).toThrow(/READER_VERSIONS/);
  });

  it('rejects duplicate keyring reader entries', () => {
    expect(() => loadExecutorConfig(validEnv({
      M365_COMMS_TOKEN_CACHE_KEK_READER_VERSIONS: `${KEK_VERSION},${KEK_VERSION}`,
    }))).toThrow(/READER_VERSIONS/);
  });

  it('rejects a non-postgres token cache DSN', () => {
    expect(() => loadExecutorConfig(validEnv({
      M365_COMMS_TOKEN_CACHE_DSN: 'mysql://comms:comms@cache-db.internal:3306/cache',
    }))).toThrow(/TOKEN_CACHE_DSN/);
    expect(() => loadExecutorConfig(validEnv({
      M365_COMMS_TOKEN_CACHE_DSN: 'not a url',
    }))).toThrow(/TOKEN_CACHE_DSN/);
  });

  it.each([
    ['the wildcard IPv4 interface', { M365_COMMS_EXECUTOR_BIND_HOST: '0.0.0.0' }],
    ['the wildcard IPv6 interface', { M365_COMMS_EXECUTOR_BIND_HOST: '::' }],
    ['IPv4 loopback', { M365_COMMS_EXECUTOR_BIND_HOST: '127.0.0.1' }],
    ['another IPv4 loopback address', { M365_COMMS_EXECUTOR_BIND_HOST: '127.42.0.9' }],
    ['IPv6 loopback', { M365_COMMS_EXECUTOR_BIND_HOST: '::1' }],
    ['IPv6 link-local', { M365_COMMS_EXECUTOR_BIND_HOST: 'fe80::1' }],
    ['zone-scoped IPv6 link-local', { M365_COMMS_EXECUTOR_BIND_HOST: 'fe80::1%eth0' }],
    ['IPv4 multicast', { M365_COMMS_EXECUTOR_BIND_HOST: '239.1.2.3' }],
    ['IPv6 multicast', { M365_COMMS_EXECUTOR_BIND_HOST: 'ff02::1' }],
    ['a public interface', { M365_COMMS_EXECUTOR_BIND_HOST: '203.0.113.10' }],
    ['a hostname requiring resolution', { M365_COMMS_EXECUTOR_BIND_HOST: 'executor.internal' }],
    ['port zero', { M365_COMMS_EXECUTOR_PORT: '0' }],
    ['an out-of-range port', { M365_COMMS_EXECUTOR_PORT: '65536' }],
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
      M365_COMMS_EXECUTOR_BIND_HOST: bindHost,
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
      M365_COMMS_EXECUTOR_SIGNING_PUBLIC_JWK: value,
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
      M365_COMMS_EXECUTOR_AZURE_CREDENTIAL_MODE: 'workload-identity',
    })).azureCredentialMode).toBe('workload-identity');
  });
});
