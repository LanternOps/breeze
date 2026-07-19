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
  kid: 'graph-actions-api-1',
  x: Buffer.alloc(32, 1).toString('base64url'),
};

function validEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'production',
    M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID: CLIENT_ID,
    M365_CUSTOMER_GRAPH_ACTIONS_VAULT_URL: 'https://customer-vault.vault.azure.net',
    M365_CUSTOMER_GRAPH_ACTIONS_VAULT_REF:
      `akv://customer-vault.vault.azure.net/m365-customer-graph-actions/${CREDENTIAL_VERSION}`,
    M365_CUSTOMER_GRAPH_ACTIONS_CREDENTIAL_VERSION: CREDENTIAL_VERSION,
    M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_PUBLIC_JWK: JSON.stringify(PUBLIC_JWK),
    M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_KID: 'graph-actions-api-1',
    M365_GRAPH_ACTIONS_EXECUTOR_ISSUER: 'breeze-api',
    M365_GRAPH_ACTIONS_EXECUTOR_AUDIENCE: 'm365-graph-actions-executor',
    M365_GRAPH_ACTIONS_EXECUTOR_AZURE_CREDENTIAL_MODE: 'managed-identity',
    M365_GRAPH_ACTIONS_EXECUTOR_BIND_HOST: '10.20.30.40',
    M365_GRAPH_ACTIONS_EXECUTOR_PORT: '8788',
    ...overrides,
  };
}

describe('M365 Graph-actions executor config', () => {
  it('loads the fixed Graph-actions profile and public internal-auth key', () => {
    expect(loadExecutorConfig(validEnv())).toEqual({
      clientId: CLIENT_ID,
      vaultUrl: 'https://customer-vault.vault.azure.net',
      vaultRef: `akv://customer-vault.vault.azure.net/m365-customer-graph-actions/${CREDENTIAL_VERSION}`,
      credentialVersion: CREDENTIAL_VERSION,
      internalAuthPublicJwk: PUBLIC_JWK,
      internalAuthKid: 'graph-actions-api-1',
      internalAuthIssuer: 'breeze-api',
      internalAuthAudience: 'm365-graph-actions-executor',
      azureCredentialMode: 'managed-identity',
      bindHost: '10.20.30.40',
      port: 8788,
    });
  });

  it.each([
    'M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID',
    'M365_CUSTOMER_GRAPH_ACTIONS_VAULT_URL',
    'M365_CUSTOMER_GRAPH_ACTIONS_VAULT_REF',
    'M365_CUSTOMER_GRAPH_ACTIONS_CREDENTIAL_VERSION',
    'M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_PUBLIC_JWK',
    'M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_KID',
    'M365_GRAPH_ACTIONS_EXECUTOR_ISSUER',
    'M365_GRAPH_ACTIONS_EXECUTOR_AUDIENCE',
    'M365_GRAPH_ACTIONS_EXECUTOR_AZURE_CREDENTIAL_MODE',
    'M365_GRAPH_ACTIONS_EXECUTOR_BIND_HOST',
    'M365_GRAPH_ACTIONS_EXECUTOR_PORT',
  ])('requires %s', (name) => {
    expect(() => loadExecutorConfig(validEnv({ [name]: undefined }))).toThrow(name);
  });

  it.each([
    ['an uppercase client UUID', { M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID: CLIENT_ID.toUpperCase() }, /CLIENT_ID/],
    ['a non-HTTPS vault URL', { M365_CUSTOMER_GRAPH_ACTIONS_VAULT_URL: 'http://customer-vault.vault.azure.net' }, /VAULT_URL/],
    ['a vault URL with a path', { M365_CUSTOMER_GRAPH_ACTIONS_VAULT_URL: 'https://customer-vault.vault.azure.net/secrets' }, /VAULT_URL/],
    ['a per-customer secret', { M365_CUSTOMER_GRAPH_ACTIONS_VAULT_REF: `akv://customer-vault.vault.azure.net/m365-customer-graph-actions-${CLIENT_ID}/${CREDENTIAL_VERSION}` }, /VAULT_REF/],
    ['a different vault host', { M365_CUSTOMER_GRAPH_ACTIONS_VAULT_REF: `akv://another-vault.vault.azure.net/m365-customer-graph-actions/${CREDENTIAL_VERSION}` }, /VAULT_REF.*VAULT_URL|VAULT_URL.*VAULT_REF/],
    ['a mismatched secret version', { M365_CUSTOMER_GRAPH_ACTIONS_CREDENTIAL_VERSION: 'f'.repeat(32) }, /VAULT_REF.*CREDENTIAL_VERSION|CREDENTIAL_VERSION.*VAULT_REF/],
    ['an arbitrary internal issuer', { M365_GRAPH_ACTIONS_EXECUTOR_ISSUER: 'another-api' }, /ISSUER/],
    ['an arbitrary internal audience', { M365_GRAPH_ACTIONS_EXECUTOR_AUDIENCE: 'another-executor' }, /AUDIENCE/],
    ['Azure CLI fallback mode', { M365_GRAPH_ACTIONS_EXECUTOR_AZURE_CREDENTIAL_MODE: 'azure-cli' }, /AZURE_CREDENTIAL_MODE/],
    ['default Azure fallback mode', { M365_GRAPH_ACTIONS_EXECUTOR_AZURE_CREDENTIAL_MODE: 'default' }, /AZURE_CREDENTIAL_MODE/],
  ])('rejects %s', (_label, overrides, error) => {
    expect(() => loadExecutorConfig(validEnv(overrides))).toThrow(error);
  });

  it.each([
    ['the wildcard IPv4 interface', { M365_GRAPH_ACTIONS_EXECUTOR_BIND_HOST: '0.0.0.0' }],
    ['the wildcard IPv6 interface', { M365_GRAPH_ACTIONS_EXECUTOR_BIND_HOST: '::' }],
    ['IPv4 loopback', { M365_GRAPH_ACTIONS_EXECUTOR_BIND_HOST: '127.0.0.1' }],
    ['another IPv4 loopback address', { M365_GRAPH_ACTIONS_EXECUTOR_BIND_HOST: '127.42.0.9' }],
    ['IPv6 loopback', { M365_GRAPH_ACTIONS_EXECUTOR_BIND_HOST: '::1' }],
    ['IPv6 link-local', { M365_GRAPH_ACTIONS_EXECUTOR_BIND_HOST: 'fe80::1' }],
    ['zone-scoped IPv6 link-local', { M365_GRAPH_ACTIONS_EXECUTOR_BIND_HOST: 'fe80::1%eth0' }],
    ['IPv4 multicast', { M365_GRAPH_ACTIONS_EXECUTOR_BIND_HOST: '239.1.2.3' }],
    ['IPv6 multicast', { M365_GRAPH_ACTIONS_EXECUTOR_BIND_HOST: 'ff02::1' }],
    ['a public interface', { M365_GRAPH_ACTIONS_EXECUTOR_BIND_HOST: '203.0.113.10' }],
    ['a hostname requiring resolution', { M365_GRAPH_ACTIONS_EXECUTOR_BIND_HOST: 'executor.internal' }],
    ['port zero', { M365_GRAPH_ACTIONS_EXECUTOR_PORT: '0' }],
    ['an out-of-range port', { M365_GRAPH_ACTIONS_EXECUTOR_PORT: '65536' }],
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
      M365_GRAPH_ACTIONS_EXECUTOR_BIND_HOST: bindHost,
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
      M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_PUBLIC_JWK: value,
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
      M365_GRAPH_ACTIONS_EXECUTOR_AZURE_CREDENTIAL_MODE: 'workload-identity',
    })).azureCredentialMode).toBe('workload-identity');
  });
});
